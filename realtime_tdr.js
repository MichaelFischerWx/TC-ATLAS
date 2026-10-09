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

    // Theme-aware Plotly gridline color. The old hardcoded faint-white
    // values sat on white plot backgrounds — invisible in every theme.
    function _tdrGrid() {
        try {
            var v = window.TCATheme && window.TCATheme.readVar('--plot-grid');
            if (v) return v;
        } catch (e) {}
        return 'rgba(15,22,35,0.08)';
    }

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
    var API_BASE = 'https://api.tcatlas.org';
    var RT_PREFIX = '/realtime';

    // ── State ────────────────────────────────────────────────────
    var _currentFileUrl = null;
    var _rtDataCache = {};
    var _rtPlanInflight = null;   // {fileUrl, promise} of the latest plan-view /data fetch (rtFetchMeta joins it)
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
    var _rtIROpacity = 0.80;            // IR underlay opacity (slider-driven)
    var _rtIRUserToggledOff = false;    // user explicitly turned the default-on IR off
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
    window.rtSavePlotPNG = function (chartDivId, defaultName, caption) {
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
        // Render at a generous LOGICAL size, not the on-screen one: these panels
        // can be narrow (the TDR sidebar squeezes them), and exporting at that
        // width just scaled up gives a cramped figure with oversized fonts. A
        // 1280-wide floor lets the layout breathe; the on-screen aspect is kept.
        var w0 = gd.offsetWidth || 900, h0 = gd.offsetHeight || 400;
        var outW = Math.max(1280, w0);
        var outH = Math.max(360, Math.round(h0 * (outW / w0)));
        var scale = 3;                       // 1280 × 3 = 3840 px wide
        var kit = window._ReconKit;
        var full = fname + '_' + ts + '.png';

        // The export is rendered at outW (≥1280) but the fonts are sized for the
        // narrower on-screen panel, so at export width they come out small and
        // hard to read (title, axis labels, the Max readout). Scale those fonts up
        // by the widen factor for the render, then restore — toImage uses the live
        // layout, so this is a brief, deliberate change during a save click.
        var fb = Math.max(1, Math.min(2.2, outW / w0));
        var L = gd.layout || {};
        var upd = {}, rst = {};
        function bump(path, cur) { if (typeof cur === 'number') { rst[path] = cur; upd[path] = Math.round(cur * fb); } }
        bump('title.font.size', L.title && L.title.font && L.title.font.size);
        ['xaxis', 'yaxis'].forEach(function (ax) {
            var a = L[ax] || {};
            bump(ax + '.title.font.size', a.title && a.title.font && a.title.font.size);
            bump(ax + '.tickfont.size', a.tickfont && a.tickfont.size);
        });
        (L.annotations || []).forEach(function (a, i) {
            if (a && a.font && typeof a.font.size === 'number') {
                rst['annotations[' + i + '].font.size'] = a.font.size;
                upd['annotations[' + i + '].font.size'] = Math.round(a.font.size * fb);
            }
        });

        // Bumping the fonts without bumping the LAYOUT is what made saved figures
        // collide: the on-screen margins/standoffs are tuned for small fonts, so
        // at fb× the (often 2-line) title overlapped the plot, the axis titles ran
        // into the tick labels, and the bottom-left "Max" readout (y=-0.01, in the
        // bottom margin) sat on top of the x-axis title. Grow the margins + add
        // axis-title standoffs for the export only (restored right after, like the
        // fonts). A path absent on-screen restores to null (Plotly default).
        var _mar = L.margin || {};
        function setExp(path, cur, val) { rst[path] = (cur === undefined ? null : cur); upd[path] = val; }
        setExp('margin.t', _mar.t, Math.round((_mar.t != null ? _mar.t : 46) * fb) + 24); // 2-line title
        setExp('margin.l', _mar.l, Math.round((_mar.l != null ? _mar.l : 52) * fb) + 8);  // y-title + ticks
        setExp('margin.b', _mar.b, Math.round((_mar.b != null ? _mar.b : 44) * fb) + 34); // x-title below Max box
        setExp('margin.r', _mar.r, Math.round((_mar.r != null ? _mar.r : 16) * Math.max(1, fb * 0.7)));
        var _xt = L.xaxis && L.xaxis.title, _yt = L.yaxis && L.yaxis.title;
        setExp('xaxis.title.standoff', _xt && _xt.standoff, Math.round(26 * fb)); // clear ticks + Max box
        setExp('yaxis.title.standoff', _yt && _yt.standoff, Math.round(14 * fb));

        var hasBump = Object.keys(upd).length > 0;

        // Colorbar fonts are TRACE attributes (not layout), so the relayout bump
        // above misses them — the colorbar label + ticks stayed small on export.
        // Bump them with a parallel restyle across every colorbar-bearing trace.
        var data = gd.data || [];
        var cbIdx = [], cbTickUp = [], cbTickRs = [], cbTitleUp = [], cbTitleRs = [];
        for (var ti = 0; ti < data.length; ti++) {
            var tr = data[ti];
            if (!tr || tr.showscale === false) continue;
            var cb = tr.colorbar || {};
            // Only bump traces that actually carry a colorbar spec (heatmaps,
            // contours, coloured-marker scatters) — skip plain line traces.
            var hasColorbar = !!tr.colorbar ||
                (tr.marker && (tr.marker.showscale || (tr.marker.colorbar))) ||
                tr.type === 'heatmap' || tr.type === 'contour' || tr.type === 'heatmapgl';
            if (!hasColorbar) continue;
            var curTick = (cb.tickfont && cb.tickfont.size) || 12;
            var curTitle = (cb.title && cb.title.font && cb.title.font.size) ||
                           (cb.titlefont && cb.titlefont.size) || 13;
            cbIdx.push(ti);
            cbTickRs.push(curTick);  cbTickUp.push(Math.round(curTick * fb));
            cbTitleRs.push(curTitle); cbTitleUp.push(Math.round(curTitle * fb));
        }
        var hasCb = cbIdx.length > 0;

        var applyBump = function () {
            var ps = [];
            if (hasBump) ps.push(Plotly.relayout(gd, upd));
            if (hasCb) ps.push(Plotly.restyle(gd,
                { 'colorbar.tickfont.size': cbTickUp, 'colorbar.title.font.size': cbTitleUp }, cbIdx));
            return Promise.all(ps);
        };
        var restore = function () {
            if (hasBump) { try { Plotly.relayout(gd, rst); } catch (e) {} }
            if (hasCb) { try { Plotly.restyle(gd,
                { 'colorbar.tickfont.size': cbTickRs, 'colorbar.title.font.size': cbTitleRs }, cbIdx); } catch (e) {} }
        };

        Promise.resolve((hasBump || hasCb) ? applyBump() : null)
            .then(function () { return Plotly.toImage(gd, { format: 'png', width: outW, height: outH, scale: scale }); })
            .then(function (dataUrl) {
                restore();
                if (!kit || !kit.stampExport) { TCExport.save(dataUrl, full); return; }
                kit.stampExport(dataUrl, outW * scale, outH * scale, function (blob) {
                    TCExport.save(blob || dataUrl, full);   // fall back to the raw PNG
                }, caption || null);
            })
            .catch(function (e) {
                restore();
                console.error('[rtSavePlotPNG]', e);
                if (typeof rtToast === 'function') rtToast('Could not save image', 'warn');
            });
    };

    // Download the plan-view (the main TDR product) as a branded PNG. Wraps
    // rtSavePlotPNG with a caption built from the current analysis + variable, so
    // the saved figure is self-describing (storm/mission, analysis time, field).
    window.rtSaveTDRView = function () {
        var gd = document.getElementById('rt-plotly-chart');
        if (!gd || !gd.data || !gd.data.length) {
            if (typeof rtToast === 'function') rtToast('Generate a plot first', 'warn');
            return;
        }
        // The descriptive title (storm · time · field) is already rendered at
        // the top of the figure, so the footer caption carries PROVENANCE — the
        // source analysis/mission id — rather than restating the title. Fall
        // back to the (flattened) title only when there's no file id, so the
        // footer is never blank. stampExport flattens any residual markup.
        var caption = '';
        try {
            var title = (gd.layout && gd.layout.title &&
                         (gd.layout.title.text || gd.layout.title)) || '';
            var fn = (_currentFileUrl || '').split('/').pop()
                        .replace(/_xy\.nc(\.gz)?$/i, '');
            caption = fn || title;
        } catch (e) {}
        rtSavePlotPNG('rt-plotly-chart', 'TDR_PlanView', caption);
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

    // ── Recon tab integration (Real-Time Monitor) ────────────────
    // The TDR viewer now lives as the "TDR" sub-tab of the Real-Time
    // Monitor's Recon tab. switchIRView('recon') calls activateReconView();
    // the inner sub-tab strip buttons call switchReconSub(name).
    var _reconMissionsLoaded = false;

    function _reconEnsureMissions() {
        var sel = document.getElementById('rt-mission-select');
        if (!sel) return;
        if (_reconMissionsLoaded && sel.options.length && sel.options[0].value !== '') return;
        _reconMissionsLoaded = true;
        loadMissions();
    }

    // Switch the inner Recon sub-tab (missions / tdr / fl / vdm).
    window.switchReconSub = function (name) {
        var panels = document.querySelectorAll('#recon-main .recon-sub-panel');
        for (var i = 0; i < panels.length; i++) {
            panels[i].style.display = (panels[i].getAttribute('data-sub') === name) ? '' : 'none';
        }
        var tabs = document.querySelectorAll('#recon-main .recon-sub-tab');
        for (var j = 0; j < tabs.length; j++) {
            tabs[j].classList.toggle('active', tabs[j].getAttribute('data-sub') === name);
        }
        if (name === 'missions') {
            _reconRenderMissionsDashboard();
        } else if (name === 'tdr') {
            _reconEnsureMissions();
            // If the mission list is already loaded (revisiting the tab), the
            // loadMissions callback won't fire — try the auto-load here too.
            _rtAutoLoadRecent();
            // Leaflet needs a nudge after being shown from display:none.
            setTimeout(function () { if (_rtMap) _rtMap.invalidateSize(); }, 80);
        } else if (name === 'fl') {
            _reconEnsureFLMissions();
            // Plotly needs a resize after being shown from display:none.
            setTimeout(function () {
                var c = document.getElementById('recon-fl-charts');
                if (c && c.style.display !== 'none' && window.Plotly) {
                    try { window.Plotly.Plots.resize(c); } catch (e) {}
                }
            }, 80);
        } else if (name === 'vdm') {
            _reconEnsureVdmStorms();
        } else if (name === 'archive') {
            _reconEnsureArchive();
        } else if (name === 'hdob') {
            _reconEnsureHdob();
            setTimeout(function () {
                if (_hdobMap) _hdobMap.invalidateSize();
                var c = document.getElementById('recon-hdob-chart');
                if (c && window.Plotly) { try { window.Plotly.Plots.resize(c); } catch (e) {} }
            }, 90);
        }
        try { if (typeof gtag === 'function') gtag('event', 'recon_sub_switch', { sub: name }); } catch (e) {}
        // Reflect the sub-tab in the URL hash so it's shareable/bookmarkable
        // (e.g. .../realtime_ir.html#recon-tdr). _syncHash('recon') preserves
        // any "recon-*" suffix, so the main-view sync won't clobber this.
        try {
            if (_RECON_SUBS[name]) {
                var newHash = '#recon-' + name;
                if ('#' + (window.location.hash || '').replace(/^#/, '') !== newHash) {
                    history.replaceState(null, '',
                        window.location.pathname + window.location.search + newHash);
                }
            }
        } catch (e) { /* old browsers — skip */ }
    };

    // Valid Recon sub-tab ids (shared by switchReconSub + activateReconView).
    var _RECON_SUBS = { missions: 1, hdob: 1, tdr: 1, fl: 1, vdm: 1, archive: 1 };

    // Parse the recon sub-tab from a "#recon-<sub>" hash, or null.
    function _reconSubFromHash() {
        try {
            var h = (window.location.hash || '').replace(/^#/, '');
            var m = h.match(/^recon-([a-z]+)/);
            if (m && _RECON_SUBS[m[1]]) return m[1];
        } catch (e) { /* ignore */ }
        return null;
    }

    // Entry point fired by switchIRView('recon'): pick the sub-tab to show and
    // lazy-load its data. A "#recon-<sub>" deep-link wins; otherwise honor the
    // active sub-tab (defaults to Live Flight in the markup, so landing on
    // Recon during a mission shows the live data — not the NOAA-only TDR
    // Missions archive).
    window.activateReconView = function () {
        var name = _reconSubFromHash();
        if (!name) {
            var active = document.querySelector('#recon-main .recon-sub-tab.active');
            name = active ? active.getAttribute('data-sub') : 'hdob';
        }
        window.switchReconSub(name || 'hdob');
    };

    // Deep-link from a storm's detail view (the header "✈ RECON" badge) straight
    // to its Live-Flight recon. switchIRView('recon') activates the tab and
    // populates the storm picker ASYNCHRONOUSLY (active-storm list may still be in
    // flight), so poll briefly for this storm's option, then select it.
    window._reconOpenForStorm = function (atcf) {
        if (!atcf) return;
        atcf = String(atcf).toUpperCase();
        try { window.switchIRView('recon'); } catch (e) {}
        try { window.switchReconSub('hdob'); } catch (e) {}
        _ga('recon_open_from_storm', { id: atcf });
        var tries = 0;
        (function pick() {
            var sel = document.getElementById('recon-hdob-storm');
            var match = sel && Array.prototype.filter.call(sel.options, function (o) {
                return (o.value || '').toUpperCase() === atcf;
            })[0];
            if (match) {
                sel.value = match.value;                       // reflect it in the picker UI
                if (window._reconHdobSelectStorm) window._reconHdobSelectStorm(match.value);
                return;
            }
            if (tries++ < 30) setTimeout(pick, 150);           // storm list still loading
        })();
    };

    // ── Recon · Live HDOB side-by-side (time series + recon map) ──
    // Reuses window._ReconKit (exposed by realtime_ir.js) for the barb canvas
    // layer + dropsonde/VDM markers, and the shared /recon/realtime endpoint.
    // Adds a Plotly flight-level time series synced to the map by click.
    var _hdobMap = null, _hdobBarbLayer = null, _hdobMarkers = [], _hdobData = null;
    var _hdobAtcf = null, _hdobName = '', _hdobReplay = null, _hdobPollTimer = null;
    var _hdobLat = null, _hdobLon = null;  // storm position (HDOB proximity gate, live only)
    var _hdobMosaic = null, _hdobSatProduct = 'ir';  // global mosaic satellite (same data as Global Map)
    // Finished sortie: the backdrop is pinned to the mission's center-pass time
    // (mosaic frame if still retained, else the NASA GIBS archive) instead of
    // rolling forward with the live feed under a track that is hours old.
    var _hdobFrozenAt = null, _hdobGibsFrozen = null, _hdobSatNote = '', _hdobSatTarget = null;
    var _hdobSearMarkers = [];   // SEAR pass-peak markers + radials from the center
    // recon-sat/<ATCF>/index.json: per-pass mosaic frames the SEAR publisher
    // copies off the rolling mosaic (full resolution, durable). Stepper state:
    // _hdobPassSel = index into _hdobPassList(), null = automatic backdrop.
    var _hdobRecsat = null, _hdobRecsatKey = null, _hdobRecsatTs = 0, _hdobPassSel = null;
    var _RECSAT_CDN = 'https://cdn.tcatlas.org/recon-sat/';
    // Per-symbol visibility on the map (toolbar pills).
    var _hdobLayerVis = { barbs: true, sondes: true, vdm: true, sear: true, tdr: true, aircraft: true, old: false };
    var _HDOB_LAYERS = [
        { key: 'barbs',    name: 'Barbs',      color: '#2563eb', tip: 'Flight-level wind barbs + track dots' },
        { key: 'sondes',   name: 'Sondes',     color: '#d97706', tip: 'Dropsonde launch points (◇)' },
        { key: 'vdm',      name: 'VDM fixes',  color: '#ef4444', tip: 'Vortex Data Message center fixes (⊕)' },
        { key: 'sear',     name: 'SEAR',       color: '#ec4899', tip: 'SEAR pass centers, peaks and radials (experimental)' },
        { key: 'tdr',      name: 'TDR 10-m',   color: '#0891b2', tip: 'SEAR 10-m wind estimated from each P-3 tail-Doppler analysis (experimental)' },
        { key: 'aircraft', name: 'Aircraft',   color: '#ca8a04', tip: 'Latest aircraft position (✈)' },
        { key: 'old',      name: 'Older than 12 h', color: '#64748b', tip: 'Sondes, VDMs, SEAR passes and TDR analyses more than 12 h before the latest ob (hidden by default)' }
    ];
    // The live blob spans 24 h, so yesterday's sondes, fixes and TDR swath sat
    // under today's enroute plane as if they were current (Michael, 2026-09-27).
    // Point symbols older than this before the displayed flight's newest ob are
    // hidden unless the 'Older than 12 h' pill is on. Archive replays are
    // already cut at the replay clock and are not filtered.
    var _HDOB_STALE_MS = 12 * 3600000;
    var _hdobMissions = [], _hdobMissionInfo = {}, _hdobMissionTail = null;  // mission-centric fallback
    var _hdobLoggedLoad = false;  // fire recon_hdob_loaded once per selection, not per poll
    var _hdobAircraftMarkers = [];  // ✈ glyph at each aircraft's latest ob, rotated to heading
    // _hdobFlatObs is built lazily on first chart click (null = not yet built);
    // _hdobFlatSrc holds the aircraft set the last render was drawn from.
    var _hdobFitDone = false, _hdobHighlight = null, _hdobFlatObs = null,
        _hdobFlatSrc = null, _hdobChartBound = false;
    var _hdobStormOpts = [], _hdobBuiltToggles = false;
    var _hdobAutoSel = null;   // last value the picker defaulted to on its own
                               // (null once the user picks) — see _hdobPopulateStorms
    var _hdobReqSeq = 0;       // /recon/realtime request token; a response whose token
                               // is stale belongs to a superseded selection
    var _hdobFlightSel = '';   // '' = all flights; else a single aircraft tail (filters chart + map)
    var _hdobGrid = null;      // lat/lon graticule controller for the recon map (lazy)
    var _hdobFl1s = false;     // NOAA flight-level wind: false = 10-s mean (ops), true = full 1-s
    // Last payload per FL-wind resolution for the CURRENT selection, so flipping
    // 10-s ↔ 1-s repaints from memory instead of re-fetching (the 1-s payload is
    // ~10× larger, and the round-trip was the bulk of the toggle lag). Cleared on
    // storm/mission switch; the background refresh still keeps both current.
    var _hdobResCache = { '10': null, '1': null };
    var _hdobVarVis = { peak_fl_kt: true, wspd_kt: false, sfmr_kt: true, sear_kt: true,
                        fl_pres_mb: true, extrap_sfc_p_mb: true, geo_alt_m: true,
                        temp_c: false, dewpt_c: false, vdm: true };
    var _HDOB_VARS = [
        // Peak (10-s) FL wind is the operationally-preferred value → solid, default on.
        { key: 'peak_fl_kt', name: 'Peak Wind (10s)', unit: 'kt', color: '#0ea5e9', axis: 'y',
          tip: 'Peak 10-second flight-level wind within the 30s window (operationally preferred)' },
        { key: 'wspd_kt',    name: 'FL Wind (30s)', unit: 'kt', color: '#38bdf8', axis: 'y', dash: 'dash',
          tip: '30-second average flight-level wind' },
        { key: 'sfmr_kt',    name: 'SFMR Sfc', unit: 'kt', color: '#fb923c', axis: 'y',
          tip: 'SFMR-retrieved surface wind' },
        // Experimental 10-m estimate from the flight-level wind (MLBT / SEAR),
        // joined onto the track by (tail, time) via _ReconKit.attachSear.
        { key: 'sear_kt',    name: 'SEAR 10-m (exp)', unit: 'kt', color: '#ec4899', axis: 'y', dash: 'dot',
          tip: 'Experimental SEAR 10-m wind estimate from the peak flight-level wind (TC-RADAR + dropsonde trained; MLBT). Not an official product.' },
        // Extrap SLP shares the WIND panel on a twin (right, inverted) axis — wind
        // peaks flank the pressure minimum at the eye, the classic recon view.
        { key: 'extrap_sfc_p_mb', name: 'Extrap SLP', unit: 'mb', color: '#e879f9', axis: 'y5',
          tip: 'Extrapolated surface pressure (HDOB) — the surface-pressure estimate, lowest at the eye' },
        { key: 'fl_pres_mb', name: 'FL Pres',  unit: 'mb', color: '#a855f7', axis: 'y2',
          tip: 'Flight-level (static) pressure' },
        { key: 'geo_alt_m',  name: 'FL Alt',   unit: 'km', color: '#94a3b8', axis: 'y4', scale: 0.001,
          tip: 'Geopotential height of the flight-level pressure surface (km)' },
        { key: 'temp_c',     name: 'Temp',     unit: '°C', color: '#ef4444', axis: 'y3',
          tip: 'Air temperature' },
        { key: 'dewpt_c',    name: 'Dewpt',    unit: '°C', color: '#22c55e', axis: 'y3',
          tip: 'Dewpoint temperature' }
    ];

    function _hdobX(t) {
        if (!t) return null;
        return (t.indexOf('Z') >= 0 || t.indexOf('+') >= 0) ? t : t + 'Z';
    }

    /** Epoch ms before which map symbols count as stale: 12 h before the newest
     *  ob of the flights on display (the picked flight, else all), so a sortie
     *  that landed hours ago still shows its own sondes. No cut in archive
     *  replay. */
    function _hdobStaleCut() {
        if (_hdobArchive || !_hdobData) return -Infinity;
        var ac = _hdobData.aircraft || [];
        if (_hdobFlightSel) {
            var sel = ac.filter(function (a) { return _hdobAcId(a) === _hdobFlightSel; });
            if (sel.length) ac = sel;
        }
        var newest = -Infinity;
        ac.forEach(function (a) {
            var tr = a.track || [];
            if (tr.length) { var ms = Date.parse(_hdobX(tr[tr.length - 1].t)); if (ms > newest) newest = ms; }
        });
        if (!isFinite(newest)) newest = Date.now();
        return newest - _HDOB_STALE_MS;
    }
    /** True when this timestamp is stale and the 'Older' pill is off (unparseable = keep). */
    function _hdobHideOld(t, cut) {
        if (_hdobLayerVis.old) return false;
        var ms = Date.parse(_hdobX(t));
        return !isNaN(ms) && ms < cut;
    }
    /** How many sondes / VDMs / SEAR passes / TDR analyses the age cut hides. */
    function _hdobStaleCount() {
        var cut = _hdobStaleCut();
        if (!isFinite(cut) || !_hdobData) return 0;
        function old(t) { var ms = Date.parse(_hdobX(t)); return !isNaN(ms) && ms < cut; }
        var n = 0;
        (_hdobData.dropsondes || []).forEach(function (d) { if (old(d.t)) n++; });
        (_hdobData.vdms || []).forEach(function (v) { if (old(v.t)) n++; });
        ((_hdobData.sear && _hdobData.sear.passes) || []).forEach(function (p) { if (old(p.fix_t || p.t)) n++; });
        ((_hdobTdrMeta && _hdobTdrMeta.analyses) || []).forEach(function (a) { if (old(a.t)) n++; });
        return n;
    }

    /** Stable per-entry id. The backend splits a tail's window into sorties
     *  (a plane that flew twice = two entries sharing a tail), so we key the
     *  flight selection on tail+sortie, not tail alone. */
    function _hdobAcId(a) {
        return (a && a.sortie) ? (a.tail + '#' + a.sortie) : ((a && a.tail) || '');
    }

    /** NHC's HDOB/IWG1 feed tokenizes the NOAA hurricane-hunter fleet by recon
     *  callsign — "NOAA3" for N43RF, "NOAA2" for N42RF, "NOAA9" for the G-IV.
     *  Crews, NHC's own public products, and users know these planes by tail
     *  number ("NOAA 43"), so a sortie shown as "NOAA3" reads as missing even
     *  when it's right there. Display the recognizable name; keep the raw tail
     *  as the id/dedup key (which is what filtering and the backend match on).
     *  USAF tails (AF3xx) are already the familiar form and pass through. */
    var _HDOB_TAIL_NAMES = { NOAA2: 'NOAA 42', NOAA3: 'NOAA 43', NOAA9: 'NOAA 49' };
    function _hdobTailDisplay(tail) {
        return (tail && _HDOB_TAIL_NAMES[String(tail).toUpperCase()]) || tail || '';
    }

    /** ISO → "DD/HHZ" (e.g. 20/06Z), used to disambiguate a tail's sorties. */
    function _hdobSortieTag(iso) {
        var m = iso && /\d{4}-(\d{2})-(\d{2})T(\d{2})/.exec(iso);
        return m ? (m[2] + '/' + m[3] + 'Z') : '';
    }

    /** Flight-selector label: bare tail normally; tail + sortie time only when
     *  a tail has more than one sortie in the window (so single flights stay clean). */
    function _hdobAcLabel(a) {
        if (a && a.n_sorties > 1 && a.sortie_start) {
            return _hdobTailDisplay(a.tail) + ' · ' + _hdobSortieTag(a.sortie_start);
        }
        return (a && _hdobTailDisplay(a.tail)) || '';
    }

    function _reconEnsureHdob() {
        _hdobPopulateStorms();
        if (!_hdobBuiltToggles) { _hdobBuildToggles(); _hdobBuildBarbVarUI(); _hdobBuiltToggles = true; }
        var sel = document.getElementById('recon-hdob-storm');
        if (sel && !_hdobAtcf && sel.value) window._reconHdobSelectStorm(sel.value, true);
        _hdobFetchMissions();  // discover standalone flights (mission-centric fallback)
    }

    // The active-storms list loads asynchronously, so Live Flight (now the
    // default Recon tab) often opens BEFORE it arrives — leaving the picker stuck
    // on "No active storms". Re-populate whenever the list loads/updates, and
    // auto-select + load if the tab is open and nothing is chosen yet, so the
    // user never has to click anything to see data.
    window.addEventListener('ir-storms-loaded', function () {
        if (!document.getElementById('recon-hdob-storm')) return;
        var hadStorm = !!_hdobAtcf;
        _hdobPopulateStorms();
        var panel = document.querySelector('#recon-main .recon-sub-panel[data-sub="hdob"]');
        var hdobActive = panel && panel.style.display !== 'none';
        if (hdobActive && !hadStorm) {
            var sel = document.getElementById('recon-hdob-storm');
            if (sel && sel.value) window._reconHdobSelectStorm(sel.value, true);
        }
    });

    // Barb base-dot color: variable picker + legend (shared via _ReconKit).
    function _hdobBuildBarbVarUI() {
        var kit = window._ReconKit;
        var sel = document.getElementById('recon-hdob-barbvar');
        if (!kit || !sel) return;
        if (!sel.options.length) {
            kit.colorVars.forEach(function (cv) {
                var o = document.createElement('option');
                o.value = cv.key; o.textContent = cv.label;
                sel.appendChild(o);
            });
        }
        sel.value = kit.getColorVar();
        _hdobBuildBarbLegend();
        _hdobBuildSondeVarUI();
    }
    // Dropsonde ◇ colour: variable picker + legend (shared via _ReconKit).
    function _hdobBuildSondeVarUI() {
        var kit = window._ReconKit, sel = document.getElementById('recon-hdob-sondevar');
        if (!kit || !sel || !kit.sondeVars) return;
        if (!sel.options.length) kit.sondeVars.forEach(function (v) {
            var o = document.createElement('option'); o.value = v.key; o.textContent = v.label; sel.appendChild(o);
        });
        sel.value = kit.getSondeVar();
        var box = document.getElementById('recon-hdob-sondelegend');
        if (!box) return;
        box.innerHTML = '';
        kit.sondeLegend().forEach(function (s) {
            var sw = document.createElement('span');
            sw.className = 'sw'; sw.textContent = s[0]; sw.style.background = s[1];
            if (s[2]) sw.style.color = s[2];
            box.appendChild(sw);
        });
    }
    window._reconHdobSetSondeVar = function (key) {
        var kit = window._ReconKit;
        if (!kit || !kit.setSondeVar) return;
        kit.setSondeVar(key);   // restyles every drawn ◇ in place
        _hdobBuildSondeVarUI();
        _ga('recon_hdob_sondevar', { var: key });
    };
    function _hdobBuildBarbLegend() {
        var kit = window._ReconKit;
        var box = document.getElementById('recon-hdob-barblegend');
        if (!kit || !box) return;
        box.innerHTML = '';
        kit.legendStops().forEach(function (s) {
            var sw = document.createElement('span');
            sw.className = 'sw'; sw.textContent = s[0]; sw.style.background = s[1];
            if (s[2]) sw.style.color = s[2];   // white label on the dark bins
            box.appendChild(sw);
        });
    }
    window._reconHdobSetBarbVar = function (key) {
        var kit = window._ReconKit;
        if (!kit) return;
        kit.setColorVar(key);   // updates shared state + redraws active barb layers
        _hdobBuildBarbLegend();
        _ga('recon_hdob_barbvar', { var: key });
    };

    function _hdobPopulateStorms() {
        var sel = document.getElementById('recon-hdob-storm');
        if (!sel) return;
        if (_hdobArchive) return;   // archive replay owns the picker until the user exits
        var kit = window._ReconKit;
        var opts = [];
        var replay = (kit && kit.replayInfo) ? kit.replayInfo() : null;
        if (replay && replay.atcf) {
            opts.push({ atcf: replay.atcf, name: replay.name || replay.atcf, replay: replay });
        }
        // List ALL active storms (not just recon-flagged ones), so tonight's
        // target is selectable even before the first VDM fix flips has_recon.
        // Recon-active storms sort first and are marked with ✈; the picker
        // defaults to one of them when present.
        var storms = (typeof window._irGetActiveStorms === 'function') ? (window._irGetActiveStorms() || []) : [];
        var reconOpts = [], otherOpts = [];
        for (var i = 0; i < storms.length; i++) {
            var s = storms[i];
            if (!s || !s.atcf_id) continue;
            var o = { atcf: s.atcf_id.toUpperCase(), name: s.name || s.atcf_id,
                      lat: s.lat, lon: s.lon, recon: !!s.has_recon,
                      vmax: (s.vmax_kt != null && isFinite(s.vmax_kt)) ? +s.vmax_kt : -1 };
            (s.has_recon ? reconOpts : otherOpts).push(o);
        }
        opts = opts.concat(reconOpts).concat(otherOpts);
        var seen = {}, uniq = [], byAtcf = {};
        for (var k = 0; k < opts.length; k++) {
            if (opts[k].atcf && !seen[opts[k].atcf]) {
                seen[opts[k].atcf] = 1; uniq.push(opts[k]); byAtcf[opts[k].atcf] = opts[k];
            }
        }
        // Mission-centric fallback: standalone active flights NOT attributable to
        // any tracked storm (a flight into an undesignated disturbance that storm
        // attribution would miss). Ones flying a tracked storm are already covered
        // by it — and they also FLAG it ✈ here, because a mission is airborne long
        // before has_recon (a 15-min server cache) catches up.
        _hdobMissionInfo = {};
        var missionOpts = [];
        for (var mi = 0; mi < _hdobMissions.length; mi++) {
            var mm = _hdobMissions[mi];
            if (!mm.tail || mm.lat == null || mm.lon == null) continue;
            // The mission id decodes to the storm the sortie was FILED for, so it
            // beats proximity: a ferry leg is still hours from its target.
            var owner = mm.atcf ? byAtcf[String(mm.atcf).toUpperCase()] : null;
            // ...then the bulletin label ("RACHEL"), then position.
            if (!owner && mm.label) {
                var ml = String(mm.label).toUpperCase().replace(/[^A-Z0-9]/g, '');
                for (var li = 0; li < uniq.length && !owner; li++) {
                    if (String(uniq[li].name || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === ml) owner = uniq[li];
                }
            }
            if (!owner) {
                for (var si = 0; si < uniq.length; si++) {
                    if (uniq[si].lat == null || uniq[si].lon == null) continue;
                    if (Math.abs(uniq[si].lat - mm.lat) <= 5 && Math.abs(uniq[si].lon - mm.lon) <= 5) { owner = uniq[si]; break; }
                }
            }
            // A plane flying it NOW outranks earlier recon (Polo's finished
            // flight vs NOAA 42 airborne into Rachel, 2026-09-29).
            if (owner) { owner.recon = true; owner.airborne = true; continue; }
            _hdobMissionInfo[mm.tail] = mm;
            missionOpts.push(mm);
        }
        // Re-sort now that missions have flagged their storms: replay pinned first,
        // then recon-active, and within each group STRONGEST first (Vmax) — with
        // two EPac missions up, a 75-kt Karina listed (and defaulted) ahead of a
        // 130-kt Lowell purely by ATCF number read as the site not knowing which
        // storm mattered. (The initial has_recon split above can't see missions.)
        uniq.sort(function (a, b) {
            if (!!a.replay !== !!b.replay) return a.replay ? -1 : 1;
            if (!!a.airborne !== !!b.airborne) return a.airborne ? -1 : 1;
            if (!!a.recon !== !!b.recon) return a.recon ? -1 : 1;
            var va = (a.vmax != null) ? a.vmax : -1, vb = (b.vmax != null) ? b.vmax : -1;
            if (va !== vb) return vb - va;
            return String(a.atcf).localeCompare(String(b.atcf));
        });
        _hdobStormOpts = uniq;
        var cur = sel.value;
        sel.innerHTML = '';
        if (!uniq.length && !missionOpts.length) {
            var o0 = document.createElement('option');
            o0.value = ''; o0.textContent = 'No active storms or flights';
            sel.appendChild(o0);
            _hdobShowEmpty(true);
            return;
        }
        for (var u = 0; u < uniq.length; u++) {
            var op = document.createElement('option');
            op.value = uniq[u].atcf;
            op.textContent = (uniq[u].recon ? '✈ ' : '') + uniq[u].name + ' (' + uniq[u].atcf + ')';
            sel.appendChild(op);
        }
        for (var mo = 0; mo < missionOpts.length; mo++) {
            var mop = document.createElement('option');
            mop.value = 'mission:' + missionOpts[mo].tail;
            mop.textContent = '✈ ' + _hdobTailDisplay(missionOpts[mo].tail) +
                (missionOpts[mo].label ? ' · ' + missionOpts[mo].label : '') + ' (flight)';
            sel.appendChild(mop);
        }
        // Default to where the planes actually are: a recon-active storm, else a
        // standalone flight, and only then the first storm on the list. Landing on
        // an arbitrary quiet storm ("0 obs · 0 sondes · 0 VDM") while a mission is
        // airborne elsewhere reads as a broken page.
        var def = '';
        for (var d = 0; d < uniq.length; d++) {
            if (uniq[d].recon) { def = uniq[d].atcf; break; }
        }
        if (!def && missionOpts.length) def = 'mission:' + missionOpts[0].tail;
        if (!def && uniq.length) def = uniq[0].atcf;
        // Keep the user's own choice. An earlier AUTO pick is not a choice, though:
        // this runs again as the storm list and the mission list land, and the
        // first pass has neither, so a sticky auto-default would freeze the picker
        // on whatever was listed first.
        var keep = cur && cur !== _hdobAutoSel &&
                   (seen[cur] || (cur.indexOf('mission:') === 0 && _hdobMissionInfo[cur.slice(8)]));
        sel.value = keep ? cur : def;
        if (!keep) {
            var wasAuto = _hdobAutoSel;
            _hdobAutoSel = def;
            // Auto-load the better default when it supersedes an earlier auto pick
            // that has already been loaded (otherwise the caller does the loading).
            if (def && wasAuto && def !== wasAuto && _hdobAtcf) {
                window._reconHdobSelectStorm(def, true);
            }
        }
    }

    function _hdobFetchMissions() {
        var kit = window._ReconKit;
        if (!kit) return;
        fetch(kit.apiBase() + '/recon/active-missions?hours=6', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                _hdobMissions = (j && j.missions) || [];
                _hdobPopulateStorms();   // re-merge missions into the picker
                // If nothing was selected yet and the Live Flight tab is open,
                // auto-load the (new) default so a standalone flight shows itself.
                var panel = document.querySelector('#recon-main .recon-sub-panel[data-sub="hdob"]');
                var sel = document.getElementById('recon-hdob-storm');
                if (panel && panel.style.display !== 'none' && !_hdobAtcf && sel && sel.value) {
                    window._reconHdobSelectStorm(sel.value, true);
                }
            })
            .catch(function () {});
    }

    /** `auto` = chosen by the picker's own defaulting, not by the user. Only a
     *  user (or an explicit deep-link) pins the selection against re-defaulting. */
    window._reconHdobSelectStorm = function (value, auto) {
        if (!value) return;
        if (value.indexOf('archive:') === 0) { _reconArchiveOpen(value.slice(8)); return; }
        if (_hdobArchive) _reconArchiveExit(true);
        if (!auto) _hdobAutoSel = null;
        _hdobData = null; _hdobFitDone = false; _hdobReplay = null; _hdobLoggedLoad = false;
        _hdobResCache = { '10': null, '1': null };   // payloads belong to the old selection
        _hdobFlightSel = '';   // back to all flights when switching storm/mission
        _hdobFl1s = false;     // back to the 10-s operational wind on switch
        _hdobFrozenAt = null; _hdobSatNote = ''; _hdobSatTarget = null; _hdobDropGibsFrozen();
        _hdobPassSel = null; _hdobRecsat = null; _hdobRecsatKey = null; _hdobRecsatTs = 0;
        for (var sm = 0; sm < _hdobSearMarkers.length; sm++) { try { _hdobMap.removeLayer(_hdobSearMarkers[sm]); } catch (e) {} }
        _hdobSearMarkers = [];
        _hdobTdrReset();
        if (value.indexOf('mission:') === 0) {
            // Mission mode: a standalone flight, attributed by aircraft tail.
            var tail = value.slice(8);
            var mm = _hdobMissionInfo[tail] || { tail: tail };
            _hdobMissionTail = tail;
            _hdobName = mm.label || tail;
            // Only the BASIN of this id is used (it picks the archive directory),
            // but CP lives in the Pacific dirs and 'AL99' would send the fetch to
            // the Atlantic. Prefer the mission's own decoded id when it has one.
            _hdobAtcf = mm.atcf ||
                ((mm.basin === 'EP' || mm.basin === 'CP') ? 'EP992026' : 'AL992026');
            _hdobLat = (mm.lat != null) ? mm.lat : null;
            _hdobLon = (mm.lon != null) ? mm.lon : null;
        } else {
            _hdobMissionTail = null;
            var opt = null;
            for (var i = 0; i < _hdobStormOpts.length; i++) {
                if (_hdobStormOpts[i].atcf === value) opt = _hdobStormOpts[i];
            }
            if (!opt) return;
            _hdobAtcf = opt.atcf; _hdobName = opt.name; _hdobReplay = opt.replay || null;
            _hdobLat = (opt.lat != null) ? opt.lat : null;
            _hdobLon = (opt.lon != null) ? opt.lon : null;
        }
        if (_hdobBarbLayer && _hdobMap) { try { _hdobMap.removeLayer(_hdobBarbLayer); } catch (e) {} _hdobBarbLayer = null; }
        if (_hdobMarkers.length && _hdobMap) {
            for (var m = 0; m < _hdobMarkers.length; m++) { try { _hdobMap.removeLayer(_hdobMarkers[m]); } catch (e) {} }
            _hdobMarkers = [];
        }
        if (_hdobAircraftMarkers.length && _hdobMap) {
            for (var am = 0; am < _hdobAircraftMarkers.length; am++) { try { _hdobMap.removeLayer(_hdobAircraftMarkers[am]); } catch (e) {} }
            _hdobAircraftMarkers = [];
        }
        _hdobShowEmpty(false);
        _ga('recon_hdob_select', {
            mode: _hdobMissionTail ? 'mission' : 'storm',
            id: _hdobMissionTail || _hdobAtcf, name: _hdobName
        });
        _hdobFetch();
        if (_hdobPollTimer) clearInterval(_hdobPollTimer);
        _hdobPollTimer = setInterval(_hdobFetch, 60000);
    };

    // ── Recon · Archive (season replay of past flights + SEAR) ─────────────
    // sear-rt/archive/index.json lists every 2026 storm the SEAR publisher has
    // re-scored with the CURRENT model set; each carries a 10-s playback blob
    // (<ATCF>.recon.json.gz) and its SEAR product. Replay = the Live Flight
    // renderer fed a copy of that blob truncated at a replay clock; the satellite
    // backdrop is pinned to the same clock (archived per-pass frames when they
    // exist, else GIBS), so a flight can be stepped or played back in time.
    var _ARCHIVE_INDEX_URL = 'https://cdn.tcatlas.org/sear-rt/archive/index.json';
    var _reconArchiveIdx = null, _reconArchiveIdxTs = 0;
    var _hdobArchive = null;   // { entry, blob, sear, t0, t1, cur, playing, timer, speed }

    function _reconArchiveFetchIndex() {
        if (_reconArchiveIdx && (Date.now() - _reconArchiveIdxTs) < 5 * 60000) return Promise.resolve(_reconArchiveIdx);
        return fetch(_ARCHIVE_INDEX_URL + '?nc=' + Math.floor(Date.now() / 60000), { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { _reconArchiveIdx = j; _reconArchiveIdxTs = Date.now(); return j; })
            .catch(function () { return null; });
    }

    function _reconArchiveFmtSpan(a, b) {
        if (!a) return '';
        var d1 = new Date(a), d2 = b ? new Date(b) : d1;
        var mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        var s1 = mo[d1.getUTCMonth()] + ' ' + d1.getUTCDate();
        var s2 = mo[d2.getUTCMonth()] + ' ' + d2.getUTCDate();
        return s1 === s2 ? s1 : s1 + ' – ' + s2;
    }

    function _reconEnsureArchive() {
        var grid = document.getElementById('recon-archive-grid');
        if (!grid) return;
        _reconArchiveFetchIndex().then(function (j) {
            var storms = (j && j.storms) || [];
            if (!storms.length) {
                grid.innerHTML = '<div class="recon-missions-loading">No archived flights yet.</div>';
                return;
            }
            storms = storms.slice().sort(function (a, b) { return (b.first_t || '') < (a.first_t || '') ? -1 : 1; });
            var cnt = document.getElementById('recon-archive-count');
            if (cnt) cnt.textContent = storms.length + ' storm' + (storms.length === 1 ? '' : 's') + ' · ' +
                storms.reduce(function (n, e) { return n + (e.n_flights || 0); }, 0) + ' flights';
            grid.innerHTML = storms.map(function (e) {
                var id = e.atcf || '';
                var short = id.slice(0, 2) + id.slice(2, 4);
                var mx = (e.max_y_kt != null) ? Math.round(e.max_y_kt) + ' kt' : '—';
                return '<button class="recon-mission-card recon-archive-card" onclick="window._reconArchiveOpen(\'' + id + '\')" ' +
                    'title="Replay this storm’s recon flights with SEAR">' +
                    '<div class="recon-mission-card-top"><span class="recon-mission-date">' + (e.name || id) +
                    ' <span class="recon-archive-id">' + short + '</span></span>' +
                    '<span class="recon-mission-rel">' + _reconArchiveFmtSpan(e.first_t, e.last_t) + '</span></div>' +
                    '<div class="recon-archive-stats">' +
                    '<span><b>' + (e.n_flights || 0) + '</b> flight' + (e.n_flights === 1 ? '' : 's') + '</span>' +
                    '<span><b>' + (e.n_passes || 0) + '</b> center pass' + (e.n_passes === 1 ? '' : 'es') + '</span>' +
                    '<span>max SEAR <b style="color:#ec4899;">' + mx + '</b></span>' +
                    '</div>' +
                    '<div class="recon-archive-foot"><span>' + (e.tails || []).map(_hdobTailDisplay).join(' · ') + '</span>' +
                    '<span class="recon-archive-links">' +
                    (e.txt ? '<a href="' + e.txt + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">.txt</a>' : '') +
                    (e.nc ? ' <a href="' + e.nc + '" onclick="event.stopPropagation()">.nc</a>' : '') +
                    '</span></div>' +
                    '<div class="recon-archive-cta">▶ Replay flights</div>' +
                    '</button>';
            }).join('');
        });
    }

    /** Fetch the playback blob; the CDN normally decodes the gzip, but read the
     *  bytes and inflate ourselves if a proxy passes them through raw. */
    function _reconArchiveFetchBlob(url) {
        return fetch(url + '?nc=' + Math.floor(Date.now() / 300000), { cache: 'force-cache' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
            .then(function (buf) {
                var u8 = new Uint8Array(buf);
                if (u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b && typeof DecompressionStream === 'function') {
                    var ds = new DecompressionStream('gzip');
                    return new Response(new Blob([buf]).stream().pipeThrough(ds)).text().then(JSON.parse);
                }
                return JSON.parse(new TextDecoder().decode(u8));
            });
    }

    window._reconArchiveOpen = function (atcf) {
        atcf = String(atcf || '').toUpperCase();
        if (!atcf) return;
        var statusEl = document.getElementById('recon-hdob-status');
        _reconArchiveFetchIndex().then(function (j) {
            var entry = ((j && j.storms) || []).filter(function (e) { return (e.atcf || '').toUpperCase() === atcf; })[0];
            if (!entry) { rtToast('No archived flights for ' + atcf + '.', 'warn'); return; }
            try { window.switchReconSub('hdob'); } catch (e) {}
            if (statusEl) statusEl.textContent = 'loading archive…';
            _ga('recon_archive_open', { id: atcf });
            var kit = window._ReconKit;
            return Promise.all([
                _reconArchiveFetchBlob(entry.recon),
                (kit && kit.attachSear) ? null : null
            ]).then(function (res) {
                var blob = res[0];
                if (!blob || !(blob.aircraft || []).length) throw new Error('empty blob');
                // Reset the live selection exactly like a picker change, then take over.
                if (_hdobPollTimer) { clearInterval(_hdobPollTimer); _hdobPollTimer = null; }
                _hdobArchive = null;
                _hdobData = null; _hdobFitDone = false; _hdobReplay = null; _hdobLoggedLoad = false;
                _hdobResCache = { '10': null, '1': null }; _hdobFlightSel = ''; _hdobFl1s = false;
                _hdobFrozenAt = null; _hdobSatNote = ''; _hdobSatTarget = null; _hdobDropGibsFrozen();
                _hdobPassSel = null; _hdobRecsat = null; _hdobRecsatKey = null; _hdobRecsatTs = 0;
                _hdobMissionTail = null; _hdobAtcf = atcf; _hdobName = entry.name || atcf; _hdobLat = null; _hdobLon = null;
                _hdobClearMapLayers();
                var t0 = Infinity, t1 = -Infinity;
                (blob.aircraft || []).forEach(function (ac) {
                    (ac.track || []).forEach(function (o) {
                        var ms = Date.parse(_hdobX(o.t)); if (isNaN(ms)) return;
                        if (ms < t0) t0 = ms; if (ms > t1) t1 = ms;
                    });
                });
                if (!isFinite(t0)) throw new Error('no obs');
                _hdobArchive = { entry: entry, blob: blob, sear: null, t0: t0, t1: t1, cur: t1, playing: false, timer: null, speed: 15 };
                // picker shows the archived storm
                var sel = document.getElementById('recon-hdob-storm');
                if (sel) {
                    var opt = document.createElement('option');
                    opt.value = 'archive:' + atcf; opt.textContent = (entry.name || atcf) + ' (' + atcf.slice(0, 4) + ') — archive';
                    sel.appendChild(opt); sel.value = opt.value;
                }
                _hdobShowEmpty(false);
                _hdobArchiveBar(true);
                // SEAR product for the archive (re-scored with the current model): join once onto the full blob
                var searP = (kit && kit.attachSear) ? kit.attachSear(blob, atcf, entry.json) : Promise.resolve(null);
                _hdobArchiveApply();
                _hdobFetchRecsat(atcf).then(function () { if (_hdobArchive && _hdobArchive.blob === blob) _hdobRender(); });
                return searP.then(function (sp) {
                    if (!_hdobArchive || _hdobArchive.blob !== blob) return;
                    _hdobArchive.sear = sp || null;
                    _hdobFitDone = false;
                    _hdobArchiveApply();
                });
            });
        }).catch(function (e) {
            if (statusEl) statusEl.textContent = 'archive unavailable';
            rtToast('Could not load the archived flights (' + (e && e.message || 'error') + ').', 'warn');
        });
    };

    function _hdobClearMapLayers() {
        if (!_hdobMap) return;
        for (var sm = 0; sm < _hdobSearMarkers.length; sm++) { try { _hdobMap.removeLayer(_hdobSearMarkers[sm]); } catch (e) {} }
        _hdobSearMarkers = [];
        if (_hdobBarbLayer) { try { _hdobMap.removeLayer(_hdobBarbLayer); } catch (e) {} _hdobBarbLayer = null; }
        for (var m = 0; m < _hdobMarkers.length; m++) { try { _hdobMap.removeLayer(_hdobMarkers[m]); } catch (e) {} }
        _hdobMarkers = [];
        for (var am = 0; am < _hdobAircraftMarkers.length; am++) { try { _hdobMap.removeLayer(_hdobAircraftMarkers[am]); } catch (e) {} }
        _hdobAircraftMarkers = [];
        _hdobTdrRemove();
    }

    /** Copy of the archived blob truncated at the replay clock (obs, sondes, VDMs,
     *  SEAR passes with t <= cur). Per-ob SEAR fields were joined onto the full
     *  blob once, so sliced tracks keep them. */
    function _hdobArchiveSlice(cur) {
        var A = _hdobArchive, src = A.blob, out = {};
        Object.keys(src).forEach(function (k) { if (k !== 'aircraft' && k !== 'dropsondes' && k !== 'vdms' && k !== 'sear') out[k] = src[k]; });
        var curIso = new Date(cur).toISOString().slice(0, 19) + 'Z';
        var nobs = 0;
        out.aircraft = [];
        (src.aircraft || []).forEach(function (ac) {
            var tr = ac.track || [], n = tr.length;
            // tracks are time-ordered: binary search the cut
            var lo = 0, hi = n;
            while (lo < hi) { var mid = (lo + hi) >> 1; if (Date.parse(_hdobX(tr[mid].t)) <= cur) lo = mid + 1; else hi = mid; }
            if (!lo) return;
            var a = Object.assign({}, ac, { track: tr.slice(0, lo), sortie_end: tr[lo - 1].t });
            nobs += lo;
            out.aircraft.push(a);
        });
        out.dropsondes = (src.dropsondes || []).filter(function (d) { return (d.t || '') <= curIso; });
        out.vdms = (src.vdms || []).filter(function (v) { return _hdobX(v.t) <= curIso; });
        out.counts = { obs: nobs, dropsondes: out.dropsondes.length, vdms: out.vdms.length };
        if (A.sear) {
            var ps = (A.sear.passes || []).filter(function (p) { return (p.t || '') <= curIso; });
            // Same headline rule as the live product: the strongest crossing within
            // 3 h of the latest one in the window, so the tile matches the map label.
            var hd = null;
            if (ps.length) {
                var lastMs = Date.parse(ps[ps.length - 1].t);
                var win = ps.filter(function (p) { return lastMs - Date.parse(p.t) <= 3 * 3600000; });
                var top = null;
                win.forEach(function (p) {
                    var y = (p.y_corr_kt != null) ? p.y_corr_kt : p.y_kt;
                    if (y == null) return;
                    if (!top || y > ((top.y_corr_kt != null) ? top.y_corr_kt : top.y_kt)) top = p;
                });
                if (top) {
                    var others = win.filter(function (p) { return p !== top; }).map(function (p) { return (p.y_corr_kt != null) ? p.y_corr_kt : p.y_kt; }).filter(function (v) { return v != null; });
                    hd = { kt: (top.y_corr_kt != null) ? top.y_corr_kt : top.y_kt, t: top.t, tail: top.tail, fix_source: top.fix_source,
                           range_kt: top.y_range_kt || null, n_window: win.length, others_kt: others,
                           others_min_kt: others.length ? Math.min.apply(null, others) : null,
                           others_max_kt: others.length ? Math.max.apply(null, others) : null };
                }
            }
            out.sear = Object.assign({}, A.sear, { passes: ps, headline: hd });
        }
        return out;
    }

    function _hdobArchiveApply() {
        var A = _hdobArchive;
        if (!A) return;
        _hdobData = _hdobArchiveSlice(A.cur);
        var c = _hdobData.counts;
        var statusEl = document.getElementById('recon-hdob-status');
        if (statusEl) statusEl.textContent = c.obs + ' obs · ' + c.dropsondes + ' sondes · ' + c.vdms + ' VDM · archive';
        _hdobArchiveBarSync();
        if (c.obs) { _hdobShowEmpty(false); _hdobRender(); } else { _hdobShowEmpty(true); }
    }

    // ── replay bar ──
    function _hdobArchiveBar(show) {
        var bar = document.getElementById('recon-hdob-replay');
        if (!bar) return;
        bar.style.display = show ? '' : 'none';
        if (!show) return;
        var A = _hdobArchive, e = A.entry;
        var ttl = document.getElementById('recon-hdob-replay-title');
        if (ttl) ttl.innerHTML = 'Archive replay: <b>' + (e.name || e.atcf) + '</b> ' + (e.atcf || '').slice(0, 4) + ' · ' +
            _reconArchiveFmtSpan(e.first_t, e.last_t) + ' · ' + (e.n_flights || 0) + ' flight' + (e.n_flights === 1 ? '' : 's') +
            ' · SEAR re-scored with the current model';
        var sl = document.getElementById('recon-hdob-replay-slider');
        if (sl) { sl.min = Math.floor(A.t0 / 60000); sl.max = Math.ceil(A.t1 / 60000); sl.value = Math.round(A.cur / 60000); }
        var sp = document.getElementById('recon-hdob-replay-speed');
        if (sp) sp.value = String(A.speed);
        _hdobArchiveBarSync();
    }
    function _hdobArchiveBarSync() {
        var A = _hdobArchive; if (!A) return;
        var lbl = document.getElementById('recon-hdob-replay-time');
        if (lbl) {
            var d = new Date(A.cur);
            lbl.textContent = d.toISOString().slice(5, 10).replace('-', '/') + ' ' + d.toISOString().slice(11, 16) + 'Z' +
                (A.cur >= A.t1 ? ' (end of data)' : '');
        }
        var sl = document.getElementById('recon-hdob-replay-slider');
        if (sl && Math.abs(Number(sl.value) - A.cur / 60000) > 0.6) sl.value = Math.round(A.cur / 60000);
        var pb = document.getElementById('recon-hdob-replay-play');
        if (pb) pb.textContent = A.playing ? '⏸' : '▶';
        var pk = document.getElementById('recon-hdob-replay-peak'), top = _hdobArchivePeakPass();
        if (pk) {
            pk.style.display = top ? '' : 'none';
            if (top) pk.title = 'Jump to the strongest SEAR estimate: ' + Math.round(top.y_corr_kt != null ? top.y_corr_kt : top.y_kt) +
                ' kt, ' + String(top.t).slice(5, 16).replace('T', ' ') + 'Z ' + _hdobTailDisplay(top.tail);
        }
    }
    /** The pass maximum with the highest RMW-corrected estimate, or null. */
    function _hdobArchivePeakPass() {
        var A = _hdobArchive;
        if (!A || !A.sear || !(A.sear.passes || []).length) return null;
        var top = null;
        A.sear.passes.forEach(function (p) {
            var y = (p.y_corr_kt != null) ? p.y_corr_kt : p.y_kt;
            if (y == null) return;
            if (!top) { top = p; return; }
            var ty = (top.y_corr_kt != null) ? top.y_corr_kt : top.y_kt;
            if (y > ty) top = p;
        });
        return top;
    }
    /** Replay clock -> one minute past the strongest pass maximum, so that pass
     *  (center, radials, tile) is on screen; the pass stepper is pointed at it
     *  so the backdrop is that crossing's archived frame. */
    window._reconArchivePeak = function () {
        var A = _hdobArchive, top = _hdobArchivePeakPass();
        if (!A || !top) return;
        if (A.playing) { clearInterval(A.timer); A.timer = null; A.playing = false; }
        A.cur = Math.min(A.t1, Date.parse(top.t) + 60000);
        _hdobPassSel = null;
        _ga('recon_archive_peak', { id: A.entry.atcf });
        _hdobArchiveApply();
        var pl = _hdobPassList();
        for (var i = 0; i < pl.length; i++) {
            if (pl[i].pass === top || (pl[i].t || '') === (top.fix_t || top.t)) { _hdobPassSel = i; break; }
        }
        if (_hdobPassSel != null) _hdobRender();
        // Bring the map to the observation itself: fly to it at a core-scale zoom
        // (never zooming OUT past what the user had) and ring it like a chart click.
        if (_hdobMap && top.lat != null && top.lon != null) {
            try {
                var z = Math.max(_hdobMap.getZoom() || 0, 8);
                _hdobMap.flyTo([top.lat, top.lon], z, { duration: 1.2 });
                if (_hdobHighlight) { try { _hdobMap.removeLayer(_hdobHighlight); } catch (e) {} }
                _hdobHighlight = L.circleMarker([top.lat, top.lon],
                    { radius: 9, color: '#ec4899', weight: 3, fillColor: '#fff', fillOpacity: 0.9 }).addTo(_hdobMap);
            } catch (e) {}
        }
    };
    var _hdobArchiveSlideT = 0;
    window._reconArchiveSeek = function (minutes, final) {
        var A = _hdobArchive; if (!A) return;
        A.cur = Math.max(A.t0, Math.min(A.t1, Number(minutes) * 60000));
        var now = Date.now();
        if (!final && now - _hdobArchiveSlideT < 150) { _hdobArchiveBarSync(); return; }   // throttle while dragging
        _hdobArchiveSlideT = now;
        _hdobArchiveApply();
    };
    window._reconArchiveStep = function (dir) {
        var A = _hdobArchive; if (!A) return;
        if (dir === 'start') A.cur = A.t0 + 60000;
        else if (dir === 'end') A.cur = A.t1;
        else A.cur = Math.max(A.t0, Math.min(A.t1, A.cur + dir * 10 * 60000));
        _hdobArchiveApply();
    };
    window._reconArchivePlay = function () {
        var A = _hdobArchive; if (!A) return;
        if (A.playing) { clearInterval(A.timer); A.timer = null; A.playing = false; _hdobArchiveBarSync(); return; }
        if (A.cur >= A.t1) A.cur = A.t0 + 60000;
        A.playing = true;
        _ga('recon_archive_play', { id: A.entry.atcf, speed: A.speed });
        A.timer = setInterval(function () {
            if (!_hdobArchive) return;
            A.cur += A.speed * 60000 / 4;          // speed = simulated minutes per second, 4 ticks/s
            if (A.cur >= A.t1) { A.cur = A.t1; clearInterval(A.timer); A.timer = null; A.playing = false; }
            _hdobArchiveApply();
        }, 250);
        _hdobArchiveBarSync();
    };
    window._reconHdobState = function () { return { data: _hdobData, archive: _hdobArchive, passSel: _hdobPassSel, flightSel: _hdobFlightSel }; };   // debugging aid
    window._reconArchiveSpeed = function (v) { if (_hdobArchive) _hdobArchive.speed = Number(v) || 15; };
    window._reconArchiveExit = function (silent) {
        var A = _hdobArchive;
        if (A && A.timer) clearInterval(A.timer);
        _hdobArchive = null;
        _hdobArchiveBar(false);
        var sel = document.getElementById('recon-hdob-storm');
        if (sel) {
            Array.prototype.slice.call(sel.options).forEach(function (o) { if ((o.value || '').indexOf('archive:') === 0) sel.removeChild(o); });
        }
        if (silent) return;
        _hdobData = null; _hdobClearMapLayers(); _hdobFrozenAt = null; _hdobDropGibsFrozen();
        _hdobAutoSel = null;
        _hdobPopulateStorms();
        var v = sel && sel.value;
        if (v) window._reconHdobSelectStorm(v, true);
        else { _hdobShowEmpty(true); var st = document.getElementById('recon-hdob-status'); if (st) st.textContent = ''; }
    };
    _reconArchiveExit.__isArchive = true;

    // Pause the 60 s HDOB poll while the tab is hidden — a backgrounded tab
    // otherwise re-fetches recon data every minute for no viewer. Mirrors the
    // visibility gating realtime_ir.js applies to its own polls.
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            if (_hdobPollTimer) { clearInterval(_hdobPollTimer); _hdobPollTimer = null; }
        } else if ((_hdobAtcf || _hdobMissionTail) && !_hdobPollTimer) {
            _hdobFetch();
            _hdobPollTimer = setInterval(_hdobFetch, 60000);
        }
    });

    function _hdobInitMap() {
        if (_hdobMap) return _hdobMap;
        var el = document.getElementById('recon-hdob-map');
        if (!el || !window.L) return null;
        _hdobMap = L.map(el, { center: [25, -80], zoom: 5, zoomControl: true, preferCanvas: true });
        // Layer stacking is PANE-based on the MapLibre GL facade (setZIndex is a
        // no-op there). Mirror the global/detail map: base + GIBS satellite live on
        // tilePane; place labels on overlayPane so names always read OVER the IR.
        // (Before this, labels defaulted to tilePane and the later-added GIBS layer
        // buried them — invisible on a weak TD, total occlusion under a major.)
        var base = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
            { subdomains: 'abcd', maxZoom: 12, attribution: '&copy; CARTO', pane: 'tilePane' });
        base.addTo(_hdobMap);
        var labels = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png',
            { subdomains: 'abcd', maxZoom: 12, pane: 'overlayPane' });
        labels.addTo(_hdobMap);  // overlayPane(400) > coastline(350) > satellite/base tilePane(200)
        // Crisp coastline over the satellite (esp. the grayscale Visible product,
        // where the light basemap's coast washes out): reuse the shared
        // Natural-Earth cased-line overlay on a pane above the imagery (350) and
        // below the place labels (overlayPane 400).
        _hdobMap.createPane('coastlinePane');
        try { _hdobMap.getPane('coastlinePane').style.zIndex = 350; } catch (e) {}
        try { var _kit = window._ReconKit; if (_kit && _kit.coastlines) _kit.coastlines(_hdobMap); } catch (e) {}
        _hdobAddLegend(el);
        try {
            if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
                window._hdobMap = _hdobMap;  // localhost debug handle
            }
        } catch (e) {}
        return _hdobMap;
    }

    /** Key for the non-barb map symbols. Barb COLOUR already has its own legend
     *  in the toolbar; this explains the point markers (previously unlabelled —
     *  there was no way to know the amber diamond meant a dropsonde). Appended
     *  into the map element so the Save-PNG export picks it up too. */
    function _hdobAddLegend(mapEl) {
        if (!mapEl || mapEl.querySelector('.recon-hdob-mapkey')) return;
        var rows = [
            { sym: '<span class="recon-hdob-legend-diamond"></span>', label: 'Dropsonde' },
            { sym: '<span style="color:#f87171;font-size:14px;line-height:13px;">⊕</span>', label: 'Center fix (VDM)' },
            { sym: '<span style="color:#eab308;font-size:12px;line-height:13px;">✈</span>', label: 'Aircraft (latest)' },
            { sym: '<span style="color:#ec4899;font-size:14px;line-height:13px;font-weight:700;">×</span>', label: 'SEAR pass center (prelim) · dotted = center track' },
            { sym: '<span style="color:#ec4899;font-size:13px;line-height:13px;">○</span>', label: 'SEAR peak 10-m est (exp) · kt + sector, radial to center' }
        ];
        var html = rows.map(function (r) {
            return '<div class="recon-hdob-legend-row">' +
                   '<span class="recon-hdob-legend-sym">' + r.sym + '</span>' +
                   '<span>' + r.label + '</span></div>';
        }).join('');
        var box = document.createElement('div');
        box.className = 'recon-hdob-mapkey';
        box.innerHTML = html;
        mapEl.appendChild(box);
    }

    /** Add/replace the GIBS satellite layer (z2) for the current product +
     *  the flight's longitude. Rebuilds only when product or satellite changes. */
    /** Load recon-sat/<ATCF>/index.json (CDN only; a 404 = nothing archived).
     *  Resolves true when the manifest changed since the last render. */
    function _hdobFetchRecsat(atcf) {
        if (!atcf) return Promise.resolve(false);
        var key = String(atcf).toUpperCase();
        if (key === _hdobRecsatKey && (Date.now() - _hdobRecsatTs) < 60 * 1000) return Promise.resolve(false);
        return fetch(_RECSAT_CDN + key + '/index.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; })
            .then(function (m) {
                var before = _hdobRecsat ? _hdobRecsat.generated : null;
                _hdobRecsat = m; _hdobRecsatKey = key; _hdobRecsatTs = Date.now();
                return (m ? m.generated : null) !== before;
            });
    }

    /** Archived mosaic frame for `product` nearest `iso` (≤ 40 min), or null. */
    function _hdobArchivedFrame(product, iso) {
        var m = _hdobRecsat, fr = m && m.frames && m.frames[product];
        if (!fr) return null;
        var want = Date.parse(iso), best = null, bd = Infinity;
        Object.keys(fr).forEach(function (ts) {
            var ms = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12));
            var d = Math.abs(ms - want);
            if (d < bd) { bd = d; best = ts; }
        });
        if (!best || bd > 40 * 60 * 1000) return null;
        var e = fr[best] || {};
        return { root: m.root || (_RECSAT_CDN + _hdobRecsatKey), ts: best, zmax: e.zmax || 6 };
    }

    /** SEAR passes that belong to the flights on display (2026-09-22). The SEAR
     *  product merges three days of recon, so a pass scored for yesterday's
     *  sortie stays in the JSON while a new mission is enroute; shown as-is it
     *  read as today's estimate. Scope = the sorties _hdobFilterAircraft shows
     *  for the map (a picked flight, else the freshest sortie per tail), each
     *  matched by tail AND by time inside that sortie's window (+-45 min). With
     *  no flight picked and at least one sortie still reporting, sorties that
     *  landed more than 90 min before the newest ob are dropped too, so an
     *  enroute plane isn't decorated with the previous flight's passes. Entries
     *  without sortie times (older payloads) fall back to tail-only matching. */
    /** Is SEAR's current flight (payload headline.current_flight) among the flights on display? */
    function _hdobCfInScope(cf) {
        var shown = _hdobFilterAircraft((_hdobData && _hdobData.aircraft) || [], 'map');
        if (!shown.length) return true;
        var s0 = Date.parse(cf.start), s1 = Date.parse(cf.last_ob), PAD = 45 * 60000;
        return shown.some(function (a) {
            if (!_hdobTailEq(cf.tail, a.tail)) return false;
            var s = Date.parse(_hdobX(a.sortie_start || '')), e = Date.parse(_hdobX(a.sortie_end || ''));
            return isNaN(s) || isNaN(e) || isNaN(s0) || isNaN(s1) || (s1 >= s - PAD && s0 <= e + PAD);
        });
    }

    /** Headline of the flights on display, mirroring sear_rt.build_payload: the strongest FINAL crossing within 3 h
     *  of the newest final crossing, with the window's others and the RMW range. null when none is final. */
    function _hdobSearScopedHeadline(scoped) {
        var ps = (scoped || []).filter(function (p) { return p.final && p.y_corr_kt != null && !isNaN(Date.parse(p.t)); })
            .sort(function (a, b) { return Date.parse(a.t) - Date.parse(b.t); });
        if (!ps.length) return null;
        var tLast = Date.parse(ps[ps.length - 1].t);
        var win = ps.filter(function (p) { return tLast - Date.parse(p.t) <= 3 * 3600000; });
        var top = win.reduce(function (m, p) { return +p.y_corr_kt > +m.y_corr_kt ? p : m; }, win[0]);
        var others = win.filter(function (p) { return p !== top; }).map(function (p) { return +p.y_corr_kt; });
        return { kt: top.y_corr_kt, t: top.t, tail: top.tail, fix_source: top.fix_source, range_kt: top.y_range_kt,
                 others_kt: others, others_min_kt: others.length ? Math.min.apply(null, others) : null,
                 others_max_kt: others.length ? Math.max.apply(null, others) : null };
    }

    function _hdobSearPassesInScope(passes) {
        passes = passes || [];
        if (!passes.length) return [];
        var all = (_hdobData && _hdobData.aircraft) || [];
        var shown = _hdobFilterAircraft(all, 'map');
        if (!shown.length) return passes.slice();
        if (!_hdobFlightSel) {
            var newest = 0;
            shown.forEach(function (a) { var e = Date.parse(_hdobX(a.sortie_end || '')); if (e > newest) newest = e; });
            var live = shown.filter(function (a) { return newest - Date.parse(_hdobX(a.sortie_end || '')) <= 90 * 60000; });
            if (live.length && live.length < shown.length) shown = live;
        }
        var PAD = 45 * 60000;
        return passes.filter(function (p) {
            var t = Date.parse(p.fix_t || p.t);
            for (var i = 0; i < shown.length; i++) {
                var a = shown[i];
                if (!_hdobTailEq(p.tail, a.tail)) continue;
                var s = Date.parse(_hdobX(a.sortie_start || '')), e = Date.parse(_hdobX(a.sortie_end || ''));
                if (isNaN(s) || isNaN(e) || isNaN(t)) return true;
                if (t >= s - PAD && t <= e + PAD) return true;
            }
            return false;
        });
    }

    /** Center passes to step between: SEAR passes (VDM + preliminary fixes),
     *  else the VDMs. Honors the flight selection. Time-ordered. */
    function _hdobPassList() {
        var out = [], sp = _hdobData && _hdobData.sear;
        var selTail = _hdobFlightSel ? _hdobFlightSel.split('#')[0] : null;
        var scoped = sp ? _hdobSearPassesInScope(sp.passes) : [];
        if (scoped.length) {
            scoped.forEach(function (p) {
                out.push({ t: p.fix_t || p.t, tail: p.tail, src: p.fix_source, pass: p });
            });
        } else {
            ((_hdobData && _hdobData.vdms) || []).forEach(function (v) {
                if (!v.t || (selTail && !_hdobTailEq(v.aircraft, selTail))) return;
                out.push({ t: _hdobX(v.t), tail: v.aircraft, src: 'vdm', pass: null });
            });
        }
        out.sort(function (a, b) { return a.t < b.t ? -1 : 1; });
        return out;
    }

    /** ◀ Pass 3/5 · 00:42Z NOAA 43 ▶ · Auto — shown once there is more than one
     *  center pass and either archived frames exist or the sortie has ended. */
    function _hdobBuildPassStep() {
        var box = document.getElementById('recon-hdob-passstep');
        if (!box) return;
        var pl = _hdobPassList();
        var hasArch = !!(_hdobRecsat && _hdobRecsat.frames && Object.keys(_hdobRecsat.frames).some(function (b) {
            return Object.keys(_hdobRecsat.frames[b] || {}).length; }));
        if (!pl.length || !(hasArch || _hdobFrozenAt) || _hdobSatProduct === 'off') {
            box.style.display = 'none'; box.innerHTML = ''; return;
        }
        if (_hdobPassSel != null && _hdobPassSel >= pl.length) _hdobPassSel = null;
        box.style.display = '';
        box.innerHTML = '';
        var lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = 'Satellite'; box.appendChild(lbl);
        var prev = document.createElement('button'); prev.textContent = '◀'; prev.title = 'Previous center pass';
        var cur = document.createElement('span'); cur.className = 'cur';
        var next = document.createElement('button'); next.textContent = '▶'; next.title = 'Next center pass';
        var auto = document.createElement('button'); auto.textContent = _hdobFrozenAt ? 'Center pass' : 'Latest';
        auto.title = _hdobFrozenAt ? 'Frame nearest the median center-pass time' : 'Live imagery (latest frame)';
        auto.className = (_hdobPassSel == null) ? 'on' : '';
        var i = _hdobPassSel;
        if (i == null) {
            cur.textContent = _hdobFrozenAt ? 'mission center pass' : 'live';
        } else {
            var p = pl[i];
            cur.textContent = 'pass ' + (i + 1) + '/' + pl.length + ' · ' + String(p.t).slice(11, 16) + 'Z ' + _hdobTailDisplay(p.tail);
        }
        prev.disabled = (i != null && i <= 0);
        next.disabled = (i != null && i >= pl.length - 1);
        prev.onclick = function () { _hdobPassSel = (i == null) ? pl.length - 1 : Math.max(0, i - 1); _ga('recon_hdob_pass_step', { dir: -1 }); _hdobRender(); };
        next.onclick = function () { _hdobPassSel = (i == null) ? 0 : Math.min(pl.length - 1, i + 1); _ga('recon_hdob_pass_step', { dir: 1 }); _hdobRender(); };
        auto.onclick = function () { _hdobPassSel = null; _hdobRender(); };
        box.appendChild(prev); box.appendChild(cur); box.appendChild(next); box.appendChild(auto);
    }

    /** Download the storm's SEAR estimates as plain text. Prefers the publisher's
     *  sear-rt/<ATCF>.txt (identical to what partners can curl); for a storm
     *  published before that file existed, formats the same tables client-side
     *  from the JSON joined onto the recon blob. */
    window._reconHdobSearTxt = function () {
        var sp = _hdobData && _hdobData.sear;
        if (!sp || !window.TCExport) { rtToast('No SEAR estimates loaded for this storm.', 'warn'); return; }
        var atcf = String(sp.atcf || _hdobSearAtcf() || 'storm').toUpperCase();
        var stamp = String(sp.generated || '').replace(/[-:]/g, '').slice(0, 13) || 'latest';
        var fname = 'TC-ATLAS_SEAR_' + atcf + '_' + stamp + '.txt';
        _ga('recon_hdob_sear_txt', { atcf: atcf });
        var url = (sp.text_url || ('https://cdn.tcatlas.org/sear-rt/' + atcf + '.txt')) + '?nc=' + Date.now();
        fetch(url, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.text() : null; })
            .catch(function () { return null; })
            .then(function (txt) {
                if (!txt) txt = _hdobSearTextClient(sp);
                TCExport.saveText(txt, fname, 'text/plain;charset=utf-8');
            });
    };

    function _hdobPad(v, w, nd, right) {
        var t;
        if (v == null || (typeof v === 'number' && !isFinite(v))) t = '----';
        else t = (typeof v === 'number') ? v.toFixed(nd || 0) : String(v);
        if (t.length > w) t = t.slice(0, w);
        return right === false ? t + ' '.repeat(w - t.length) : ' '.repeat(w - t.length) + t;
    }
    function _hdobSearTextClient(sp) {
        var kit = window._ReconKit;
        var L = [];
        L.push('TC-ATLAS / SEAR real-time 10-m wind estimates from aircraft reconnaissance');
        L.push('Storm: ' + (sp.name || _hdobName || '?') + ' (' + (sp.atcf || '') + ')   Generated: ' + sp.generated + '   Status: ' + sp.status);
        L.push('Model: ' + (sp.model || ''));
        L.push('JSON: https://cdn.tcatlas.org/sear-rt/' + sp.atcf + '.json   Viewer: https://tcatlas.org/realtime_ir.html#recon-hdob');
        L.push('');
        L.push('EXPERIMENTAL RESEARCH PRODUCT (MLBT / SEAR) -- NOT an official NHC/NOAA/USAF product.');
        L.push('10-m wind estimated from the flight-level wind, its storm-relative position and the GFS environment. Not a measurement.');
        L.push('Preliminary center fixes (FIX=hdob) come from the flight-level pressure/height minimum, not a VDM. Times UTC, winds kt, missing = ----.');
        L.push('(Formatted in the browser from the published JSON; the publisher\u2019s own .txt was not available for this storm.)');
        L.push('');
        L.push('== PASS MAXIMA ==');
        L.push(_hdobPad('FIX_TIME_UTC', 20, 0, false) + ' ' + _hdobPad('PEAK_TIME_UTC', 20, 0, false) + ' ' + _hdobPad('TAIL', 6, 0, false) + ' ' +
               _hdobPad('FIX', 5, 0, false) + ' ' + _hdobPad('SEAR_PK', 7) + ' ' + _hdobPad('SEAR_RMWC', 9) + ' ' + _hdobPad('FL_PK', 6) + ' ' +
               _hdobPad('SFMR', 5) + ' ' + _hdobPad('RMW_KM', 6) + ' ' + _hdobPad('R_KM', 5) + ' ' + _hdobPad('AZ', 4) + ' ' +
               _hdobPad('LAT', 8) + ' ' + _hdobPad('LON', 9));
        (sp.passes || []).forEach(function (p) {
            L.push(_hdobPad(p.fix_t, 20, 0, false) + ' ' + _hdobPad(p.t, 20, 0, false) + ' ' + _hdobPad(p.tail, 6, 0, false) + ' ' +
                   _hdobPad(p.fix_source, 5, 0, false) + ' ' + _hdobPad(p.y_kt, 7) + ' ' + _hdobPad(p.y_corr_kt, 9) + ' ' + _hdobPad(p.fl_peak_kt, 6) + ' ' +
                   _hdobPad(p.sfmr_kt, 5) + ' ' + _hdobPad(p.rmw_km, 6) + ' ' + _hdobPad(p.r_km, 5) + ' ' + _hdobPad(p.az_deg, 4) + ' ' +
                   _hdobPad(p.lat, 8, 3) + ' ' + _hdobPad(p.lon, 9, 3));
        });
        L.push('');
        L.push('== SCORED OBSERVATIONS ==');
        L.push(_hdobPad('TIME_UTC', 20, 0, false) + ' ' + _hdobPad('TAIL', 6, 0, false) + ' ' + _hdobPad('LAT', 8) + ' ' + _hdobPad('LON', 9) + ' ' +
               _hdobPad('FL_KT', 6) + ' ' + _hdobPad('FL_PK', 6) + ' ' + _hdobPad('SFMR', 5) + ' ' + _hdobPad('SLP_MB', 6) + ' ' +
               _hdobPad('R_KM', 6) + ' ' + _hdobPad('AZ', 4) + ' ' + _hdobPad('R/RMW', 5) + ' ' + _hdobPad('FIX', 5, 0, false) + ' ' +
               _hdobPad('SEAR_30S', 8) + ' ' + _hdobPad('SEAR_PK', 7) + ' ' + _hdobPad('SEAR_RMWC', 9));
        ((_hdobData && _hdobData.aircraft) || []).forEach(function (ac) {
            (ac.track || []).forEach(function (o) {
                if (o.sear_kt == null) return;
                L.push(_hdobPad(o.t, 20, 0, false) + ' ' + _hdobPad(ac.tail, 6, 0, false) + ' ' + _hdobPad(o.lat, 8, 3) + ' ' + _hdobPad(o.lon, 9, 3) + ' ' +
                       _hdobPad(o.wspd_kt, 6) + ' ' + _hdobPad(o.peak_fl_kt, 6) + ' ' + _hdobPad(o.sfmr_kt, 5) + ' ' + _hdobPad(o.extrap_sfc_p_mb, 6) + ' ' +
                       _hdobPad(o.sear_r_km, 6) + ' ' + _hdobPad(o.sear_az, 4) + ' ' + _hdobPad(null, 5) + ' ' + _hdobPad(o.sear_fix, 5, 0, false) + ' ' +
                       _hdobPad(o.sear_30s_kt, 8) + ' ' + _hdobPad(o.sear_kt, 7) + ' ' + _hdobPad(o.sear_corr_kt, 9));
            });
        });
        return L.join('\n') + '\n';
    }

    /** Download the publisher's 1-D netCDF (sear-rt/<ATCF>.nc): a plain anchor to the
     *  CDN object, since it is binary and already the file partners curl. */
    window._reconHdobSearNc = function () {
        var sp = _hdobData && _hdobData.sear;
        if (!sp) { rtToast('No SEAR estimates loaded for this storm.', 'warn'); return; }
        var atcf = String(sp.atcf || _hdobSearAtcf() || 'storm').toUpperCase();
        var url = sp.nc_url || ('https://cdn.tcatlas.org/sear-rt/' + atcf + '.nc');
        _ga('recon_hdob_sear_nc', { atcf: atcf });
        var a = document.createElement('a');
        a.href = url + '?nc=' + Date.now();
        a.download = 'TC-ATLAS_SEAR_' + atcf + '_' + (String(sp.generated || '').replace(/[-:]/g, '').slice(0, 13) || 'latest') + '.nc';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
    };

    /** Show/hide pills for each map symbol family. */
    function _hdobBuildLayerToggles() {
        var btnTxt = document.getElementById('recon-hdob-seartxt');
        if (btnTxt) btnTxt.style.display = (_hdobData && _hdobData.sear && _hdobData.sear.status === 'ok') ? '' : 'none';
        var btnNc = document.getElementById('recon-hdob-searnc');
        if (btnNc) btnNc.style.display = (_hdobData && _hdobData.sear && _hdobData.sear.status === 'ok' && _hdobData.sear.nc_url) ? '' : 'none';
        var box = document.getElementById('recon-hdob-layers');
        if (!box) return;
        box.innerHTML = '';
        var lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = 'Show'; box.appendChild(lbl);
        _HDOB_LAYERS.forEach(function (cfg) {
            if (cfg.key === 'sear' && !(_hdobData && _hdobData.sear && _hdobData.sear.passes && _hdobData.sear.passes.length)) return;
            if (cfg.key === 'tdr' && !(_hdobData && _hdobData.sear && _hdobData.sear.swath_url)) return;
            var nOld = 0;
            if (cfg.key === 'old' && !(nOld = _hdobStaleCount())) return;
            var b = document.createElement('button');
            b.textContent = cfg.name + (nOld ? ' (' + nOld + ')' : ''); b.title = cfg.tip;
            var on = !!_hdobLayerVis[cfg.key];
            b.className = on ? 'on' : '';
            if (on) b.style.background = cfg.color;
            b.onclick = function () {
                _hdobLayerVis[cfg.key] = !_hdobLayerVis[cfg.key];
                _ga('recon_hdob_layer', { layer: cfg.key, on: _hdobLayerVis[cfg.key] ? 1 : 0 });
                _hdobRender();
            };
            box.appendChild(b);
        });
    }

    function _hdobDropGibsFrozen() {
        if (_hdobGibsFrozen && _hdobMap) { try { _hdobMap.removeLayer(_hdobGibsFrozen); } catch (e) {} }
        _hdobGibsFrozen = null;
    }
    var _HDOB_SAT_LABEL = { ir: 'IR', wv: 'water vapor', vis: 'visible' };
    /** targetIso: pin the imagery to this time (a selected center pass, or the
     *  finished sortie's median pass); null = live. Source order for a pinned
     *  time: archived recon-sat frame (full res, durable) → live mosaic frame
     *  (still within its ~3 h) → NASA GIBS archive (coarser, months). */
    function _hdobSetSatellite(lonHint, frozenIso, passInfo) {
        var kit = window._ReconKit;
        if (!kit || !kit.reconMosaicLayer || !_hdobMap) return;
        if (!_hdobMosaic) _hdobMosaic = kit.reconMosaicLayer(_hdobMap);
        var product = _hdobSatProduct;
        _hdobSatTarget = frozenIso || null;
        if (product === 'off') {
            _hdobMosaic.remove(); _hdobDropGibsFrozen();
            if (_hdobSatNote) { _hdobSatNote = ''; _hdobBuildSourceNote(); }
            return;
        }
        var ctx = passInfo
            ? 'center pass ' + String(passInfo.t).slice(11, 16) + 'Z ' + _hdobTailDisplay(passInfo.tail) +
              (passInfo.src === 'hdob' ? ' (preliminary fix)' : '')
            : (_hdobArchive ? 'the replay clock (archive)' : 'this mission\u2019s center pass (flight ended \u2014 imagery is not updating)');
        var arch = frozenIso ? _hdobArchivedFrame(product, frozenIso) : null;
        if (arch) {
            var lblA = _HDOB_SAT_LABEL[product] || product;
            var tsA = arch.ts.slice(8, 10) + ':' + arch.ts.slice(10, 12) + 'Z';
            Promise.resolve(_hdobMosaic.setArchived(product, 0.92, arch)).then(function (ok) {
                if (frozenIso !== _hdobSatTarget || product !== _hdobSatProduct) return;
                if (!ok) { _hdobPinFallback(kit, lonHint, frozenIso, product, ctx); return; }
                _hdobDropGibsFrozen();
                var note = 'Satellite: archived full-resolution ' + lblA + ' frame ' + tsA + ' for ' + ctx + '.';
                if (note !== _hdobSatNote) { _hdobSatNote = note; _hdobBuildSourceNote(); }
            });
            return;
        }
        // Near-opaque so the imagery reads cleanly over the light basemap; the
        // flight-level barbs/dots draw on their own pane ABOVE the satellite.
        // The mosaic is our own fresh (~10-min) global product, so — unlike the
        // old GIBS path — no separate storm-sector IR overlay is needed to beat
        // NRT lag; the basemap itself is current over the storm.
        if (!frozenIso) {
            _hdobDropGibsFrozen();
            if (_hdobSatNote) { _hdobSatNote = ''; _hdobBuildSourceNote(); }
            _hdobMosaic.setProduct(product, 0.92);
            return;
        }
        _hdobPinFallback(kit, lonHint, frozenIso, product, ctx);
    }

    /** Pinned time without an archived frame: live mosaic if still retained, else GIBS. */
    function _hdobPinFallback(kit, lonHint, frozenIso, product, ctx) {
        var hhmm = String(frozenIso).slice(11, 16) + 'Z';
        var lbl = _HDOB_SAT_LABEL[product] || product;
        Promise.resolve(_hdobMosaic.setProduct(product, 0.92, frozenIso)).then(function (ok) {
            if (frozenIso !== _hdobSatTarget || product !== _hdobSatProduct) return;   // superseded
            var note;
            if (ok) {
                _hdobDropGibsFrozen();
                note = 'Satellite: ' + lbl + ' frame nearest ' + hhmm + ' for ' + ctx + '.';
            } else {
                // Older than the ~3 h the mosaic retains: NASA GIBS archive, same slot.
                _hdobMosaic.remove();
                var key = product + '|' + frozenIso + '|' + (kit.gibsSatFor ? kit.gibsSatFor(lonHint) : '');
                if (!_hdobGibsFrozen || _hdobGibsFrozen._frozenKey !== key) {
                    _hdobDropGibsFrozen();
                    if (kit.gibsProductLayer) {
                        try {
                            _hdobGibsFrozen = kit.gibsProductLayer(product, lonHint, 0.92, frozenIso);
                            _hdobGibsFrozen._frozenKey = key;
                            _hdobGibsFrozen.addTo(_hdobMap);
                        } catch (e) { _hdobGibsFrozen = null; }
                    }
                }
                note = _hdobGibsFrozen
                    ? 'Satellite: NASA GIBS ' + lbl + ' at ' + hhmm + ' (archive resolution) for ' + ctx + '.'
                    : 'Satellite: no imagery retained for ' + hhmm + ' (' + ctx + ').';
            }
            if (note !== _hdobSatNote) { _hdobSatNote = note; _hdobBuildSourceNote(); }
        });
    }

    /** Center-pass time (ISO) to pin the backdrop to, or null while the displayed
     *  sortie is (or may still be) airborne. Completed = newest ob > 90 min old
     *  (a plane in the storm posts every 10-30 s). Time = median of the sortie's
     *  center fixes (VDMs plus SEAR pass fixes, which cover the passes whose VDMs
     *  never posted), else the min-extrap-SLP ob, else the midpoint of the
     *  track. Replays are live by construction. */
    function _hdobFrozenCenterIso(aircraft) {
        if (_hdobArchive) return new Date(_hdobArchive.cur).toISOString().slice(0, 19) + 'Z';   // pin imagery to the replay clock
        if (_hdobReplay || !_hdobData) return null;
        var lo = Infinity, hi = -Infinity;
        (aircraft || []).forEach(function (ac) {
            var tr = ac.track || [];
            if (!tr.length) return;
            var a = Date.parse(_hdobX(tr[0].t)), z = Date.parse(_hdobX(tr[tr.length - 1].t));
            if (!isNaN(a) && a < lo) lo = a;
            if (!isNaN(z) && z > hi) hi = z;
        });
        if (!isFinite(hi)) return null;
        if (Date.now() - hi < 90 * 60 * 1000) return null;
        var pad = 2 * 3600 * 1000;
        function inWin(ms) { return !isNaN(ms) && ms >= lo - pad && ms <= hi + pad; }
        var times = [];
        (_hdobData.vdms || []).forEach(function (v) {
            var t = Date.parse(_hdobX(v.t)); if (inWin(t)) times.push(t);
        });
        if (_hdobData.sear && _hdobData.sear.passes) {
            _hdobSearPassesInScope(_hdobData.sear.passes).forEach(function (p) {
                var t = Date.parse(p.fix_t || p.t);
                if (!inWin(t)) return;
                // one fix per pass: skip a SEAR fix that duplicates a VDM time
                for (var k = 0; k < times.length; k++) if (Math.abs(times[k] - t) < 20 * 60 * 1000) return;
                times.push(t);
            });
        }
        if (!times.length) {
            var best = null;
            (aircraft || []).forEach(function (ac) {
                (ac.track || []).forEach(function (o) {
                    if (o.extrap_sfc_p_mb != null && (!best || o.extrap_sfc_p_mb < best.v)) {
                        best = { v: o.extrap_sfc_p_mb, t: Date.parse(_hdobX(o.t)) };
                    }
                });
            });
            if (best && !isNaN(best.t)) times.push(best.t);
        }
        if (!times.length) times.push((lo + hi) / 2);
        times.sort(function (a, b) { return a - b; });
        return new Date(times[Math.floor((times.length - 1) / 2)]).toISOString();
    }

    function _hdobLonHint() {
        var ac = (_hdobData && _hdobData.aircraft) || [];
        for (var i = 0; i < ac.length; i++) {
            var t = ac[i].track || []; if (t.length) return t[t.length - 1].lon;
        }
        return null;
    }

    window._reconHdobSetSat = function (product) {
        _hdobSatProduct = product;
        _ga('recon_hdob_sat', { product: product });
        var btns = document.querySelectorAll('.recon-hdob-satgroup .ir-product-btn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('ir-product-active', btns[i].getAttribute('data-rprod') === product);
        }
        _hdobRender();   // re-resolve the backdrop (archived / pinned / live) for the new band
    };

    function _hdobFetch() {
        if (_hdobArchive) { _hdobArchiveApply(); return; }
        var kit = window._ReconKit;
        if (!kit || !_hdobAtcf) return;
        var statusEl = document.getElementById('recon-hdob-status');
        // Selections can supersede each other faster than a cold blob builds (~10 s),
        // and the loser landing last wins the panel: the quiet storm the picker
        // opened on would repaint "0 obs" over the flight the user is now looking at.
        var req = ++_hdobReqSeq;
        var url = kit.apiBase() + '/recon/realtime?atcf_id=' + encodeURIComponent(_hdobAtcf) + '&hours=24';
        if (_hdobMissionTail) {
            url += '&tail=' + encodeURIComponent(_hdobMissionTail);  // mission mode
        } else {
            if (_hdobName) url += '&name=' + encodeURIComponent(_hdobName);
            if (_hdobReplay) {
                url += '&replay=' + _hdobReplay.anchor + '&speed=' + _hdobReplay.speed;
            } else if (_hdobLat != null && _hdobLon != null) {
                url += '&lat=' + _hdobLat + '&lon=' + _hdobLon;  // live only: gate HDOB to storm
            }
        }
        if (_hdobFl1s) url += '&fl1s=1';   // NOAA flight-level wind at full 1-s
        if (statusEl && !_hdobData) statusEl.textContent = 'loading…';
        fetch(url, { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (j) {
                if (req !== _hdobReqSeq) return;   // superseded by a newer selection
                if (!j || j.error) { if (statusEl) statusEl.textContent = 'no data'; return; }
                _hdobData = j;
                _hdobResCache[_hdobFl1s ? '1' : '10'] = j;   // keep the toggle instant
                var c = j.counts || {};
                var has = ((c.obs || 0) + (c.dropsondes || 0) + (c.vdms || 0)) > 0;
                _hdobShowEmpty(!has);
                if (has) _hdobRender();
                // Archived per-pass satellite frames (recon-sat manifest); a change
                // repaints so the stepper and the pinned backdrop pick them up.
                if (has) {
                    _hdobFetchRecsat(_hdobSearAtcf()).then(function (changed) {
                        if (req !== _hdobReqSeq || _hdobData !== j) return;
                        if (changed) _hdobRender();
                    });
                }
                // Experimental SEAR 10-m estimates join the track after the blob
                // paints; a repaint then picks up the extra chart series / popup row.
                if (has && kit.attachSear) {
                    kit.attachSear(j, _hdobSearAtcf()).then(function (sp) {
                        if (req !== _hdobReqSeq || _hdobData !== j) return;
                        // A finished sortie's first frame may have anchored on a
                        // distant VDM (or the runway) before the SEAR pass centers
                        // arrived — re-frame once on the center nearest the pinned time.
                        if (sp && _hdobFrozenAt) _hdobFitDone = false;
                        if (sp) _hdobRender();
                    });
                }
                if (has && !_hdobLoggedLoad) {
                    _hdobLoggedLoad = true;
                    _ga('recon_hdob_loaded', {
                        mode: _hdobMissionTail ? 'mission' : 'storm',
                        id: _hdobMissionTail || _hdobAtcf,
                        obs: c.obs || 0, sondes: c.dropsondes || 0, vdms: c.vdms || 0
                    });
                }
                if (statusEl) {
                    statusEl.textContent = (c.obs || 0) + ' obs · ' + (c.dropsondes || 0) +
                        ' sondes · ' + (c.vdms || 0) + ' VDM';
                }
            })
            .catch(function () {
                if (req === _hdobReqSeq && statusEl) statusEl.textContent = 'fetch error';
            });
    }

    function _hdobShowEmpty(show) {
        var e = document.getElementById('recon-hdob-empty');
        var s = document.getElementById('recon-hdob-split');
        if (e) e.style.display = show ? '' : 'none';
        if (s) s.style.display = show ? 'none' : '';
        if (!show) {
            setTimeout(function () {
                if (_hdobMap) _hdobMap.invalidateSize();
                var c = document.getElementById('recon-hdob-chart');
                if (c && window.Plotly) { try { window.Plotly.Plots.resize(c); } catch (e2) {} }
            }, 60);
        }
    }

    function _hdobRender() {
        var kit = window._ReconKit;
        if (!kit || !_hdobData) return;
        var map = _hdobInitMap();
        if (!map) return;
        var aircraft = _hdobData.aircraft || [];
        var latestMs = 0;
        for (var a = 0; a < aircraft.length; a++) {
            var tr = aircraft[a].track || [];
            if (tr.length) { var t = Date.parse(tr[tr.length - 1].t); if (t > latestMs) latestMs = t; }
        }
        // GIBS IR basemap, satellite picked by the latest ob's longitude so it
        // covers the flight wherever it is (incl. outside any storm domain).
        var lonHint = null;
        for (var ai2 = 0; ai2 < aircraft.length && lonHint == null; ai2++) {
            var trk = aircraft[ai2].track || [];
            if (trk.length) lonHint = trk[trk.length - 1].lon;
        }
        _hdobFrozenAt = _hdobFrozenCenterIso(_hdobFilterAircraft(aircraft, 'chart'));
        var satTarget = _hdobFrozenAt, passInfo = null;
        if (_hdobPassSel != null) {
            var plist = _hdobPassList();
            if (_hdobPassSel < plist.length) { passInfo = plist[_hdobPassSel]; satTarget = passInfo.t; }
            else _hdobPassSel = null;
        }
        _hdobSetSatellite(lonHint, satTarget, passInfo);
        _hdobBuildPassStep();
        _hdobBuildLayerToggles();
        _hdobBuildFlightToggle();
        _hdobBuildResToggle();
        _hdobBuildSourceNote();
        _hdobBuildSummary();
        _hdobBuildToggles();   // refresh pills so the FL-wind label tracks source/res
        // The map honors the flight selection (all flights when none picked);
        // framing/satellite above use the full set so they don't jump on filter.
        var mapAircraft = _hdobFilterAircraft(aircraft, 'map');
        if (_hdobLayerVis.barbs) {
            if (!_hdobBarbLayer) { _hdobBarbLayer = new kit.BarbLayer(); _hdobBarbLayer.addTo(map); }
            _hdobBarbLayer.setData(mapAircraft, latestMs);
        } else if (_hdobBarbLayer) {
            try { map.removeLayer(_hdobBarbLayer); } catch (e) {} _hdobBarbLayer = null;
        }
        for (var mi = 0; mi < _hdobMarkers.length; mi++) { try { map.removeLayer(_hdobMarkers[mi]); } catch (e) {} }
        // Sonde/VDM markers honour the flight selection too (was: always all).
        _hdobMarkers = kit.buildMarkers(map, _hdobFilterMarkerBlob(_hdobData));
        _hdobRenderSearPasses(map, passInfo);
        _hdobRenderTdr(map, passInfo);
        _hdobRenderAircraft(map, _hdobLayerVis.aircraft ? mapAircraft : []);
        if (!_hdobFitDone) {
            // Anchor the initial view on the LATEST aircraft position — where the
            // live action is. Fitting the WHOLE track (takeoff → storm) put its
            // centroid over land and pushed the storm/aircraft to the edge; the
            // freshest fix is in/near the storm, so centering there frames the eye
            // at a storm-scale zoom. (Re-anchors on storm switch via _hdobFitDone.)
            var latest = null;
            for (var k = 0; k < aircraft.length; k++) {
                var tk = aircraft[k].track || [];
                for (var p = tk.length - 1; p >= 0; p--) {   // newest valid fix for this aircraft
                    var o = tk[p];
                    if (o.lat == null || o.lon == null || Math.abs(o.lat) < 0.05 || Math.abs(o.lon) < 0.05) continue;
                    if (!latest || (o.t || '') > (latest.t || '')) latest = o;
                    break;
                }
            }
            // A finished sortie's last ob is the runway, not the storm: anchor on
            // the center fix nearest the pinned center-pass time instead (VDMs,
            // then SEAR pass centers).
            if (_hdobFrozenAt) {
                var want = Date.parse(_hdobFrozenAt), bestC = null, bestD = Infinity;
                (_hdobData.vdms || []).forEach(function (v) {
                    if (v.lat == null || v.lon == null) return;
                    var d = Math.abs(Date.parse(_hdobX(v.t)) - want);
                    if (d < bestD) { bestD = d; bestC = { lat: v.lat, lon: v.lon }; }
                });
                ((_hdobData.sear && _hdobData.sear.passes) || []).forEach(function (p) {
                    if (p.clat == null || p.clon == null) return;
                    var d = Math.abs(Date.parse(p.fix_t || p.t) - want);
                    if (d < bestD) { bestD = d; bestC = { lat: p.clat, lon: p.clon }; }
                });
                if (bestC) latest = bestC;
            }
            if (latest) {
                // Frame a fixed ~storm-scale box (±2.5°, ~550 km) centered on that
                // fix — deterministic every load (unlike fitting the variable-length
                // track), not too tight, and wide enough that the eye/center fix
                // stays in view even on an outbound leg.
                var dLat = 2.5, dLon = 2.5 / Math.max(0.3, Math.cos(latest.lat * Math.PI / 180));
                var box = [[latest.lat - dLat, latest.lon - dLon], [latest.lat + dLat, latest.lon + dLon]];
                try { map.fitBounds(L.latLngBounds(box), { animate: false }); } catch (e) {}
                _hdobFitDone = true;
            }
        }
        _hdobRenderChart();
    }


    // ── SEAR 10-m from each P-3 tail-Doppler analysis (experimental, 2026-09-26) ──
    // MLBT sear_rt publishes sear-rt/swath/<ATCF>.json plus one 8-bit grayscale
    // PNG per real-time TDR analysis (pixel = 10-m wind in kt, 0 = no data; rows
    // uniform in Web-Mercator y, so an image overlay with the JSON bounds lands
    // exactly on the GL map). The SEAR payload advertises it via swath_url, so a
    // storm without TDR never probes the CDN for a 404. This tab shows ONE
    // analysis at a time — the multi-analysis composite swath is deliberately
    // not drawn here (Michael, 2026-09-26). The analysis follows the pass
    // stepper / pinned sortie time, or the ◀ ▶ in the key.
    var _hdobTdrMeta = null, _hdobTdrMetaUrl = null, _hdobTdrMetaGen = null;
    var _hdobTdrSel = null;          // analysis file picked in the key; null = follow the pass / pinned time
    var _hdobTdrOverlay = null, _hdobTdrShown = null, _hdobTdrKeyEl = null, _hdobTdrHoverBound = false;
    // png url -> decoded {vals, w, h, url, peak} | {st: 'loading', n} | {st: 'error', n, at};
    // n = failed attempts so far. A failed PNG is re-tried on a later render (backoff 1.5/3/6 s),
    // _HDOB_TDR_RETRIES times automatically; after that the key's Retry button asks again.
    var _hdobTdrImg = {};
    var _HDOB_TDR_RETRIES = 3;
    var _HDOB_TDR_MAX_DT_MS = 90 * 60000;   // an analysis further than this from the pass is not "that pass"

    function _hdobTdrRemove() {
        if (_hdobTdrOverlay && _hdobMap) { try { _hdobMap.removeLayer(_hdobTdrOverlay); } catch (e) {} }
        _hdobTdrOverlay = null; _hdobTdrShown = null;
        if (_hdobTdrKeyEl) _hdobTdrKeyEl.style.display = 'none';
        _hdobTdrGraySat(false);
    }
    /** Gray the IR backdrop while a TDR field is drawn: the recon wind scale's
     *  113+ kt magenta/purple is the same family as the colored IR, so the
     *  eyewall vanished into cold cloud tops (Michael, 2026-09-26). Mosaic IR →
     *  linear grayscale (warm black, cold white); a GIBS backdrop → desaturated.
     *  Reverts when the field is hidden. */
    function _hdobTdrGraySat(on) {
        try { if (_hdobMosaic && _hdobMosaic.setIrColormap) _hdobMosaic.setIrColormap(on ? 'graylinear' : null); } catch (e) {}
        try { if (_hdobGibsFrozen && _hdobGibsFrozen.setSaturation) _hdobGibsFrozen.setSaturation(on ? -1 : 0); } catch (e) {}
    }
    function _hdobTdrReset() {
        _hdobTdrRemove();
        _hdobTdrMeta = null; _hdobTdrMetaUrl = null; _hdobTdrMetaGen = null; _hdobTdrSel = null;
        for (var u in _hdobTdrImg) if (_hdobTdrImg[u].st === 'error') delete _hdobTdrImg[u];   // coming back re-tries
    }
    function _hdobTdrLut() {
        var kit = window._ReconKit, stops = (kit && kit.windStops) || [[34, '#60a5fa'], [64, '#eab308'], [9999, '#7c3aed']];
        var lut = new Uint8Array(256 * 3);
        for (var v = 0; v < 256; v++) {
            var hex = stops[stops.length - 1][1];
            for (var i = 0; i < stops.length; i++) { if (v < stops[i][0]) { hex = stops[i][1]; break; } }
            lut[v * 3] = parseInt(hex.slice(1, 3), 16); lut[v * 3 + 1] = parseInt(hex.slice(3, 5), 16); lut[v * 3 + 2] = parseInt(hex.slice(5, 7), 16);
        }
        return lut;
    }
    function _hdobTdrRetryMs(n) { return 1500 * Math.pow(2, Math.max(0, n - 1)); }
    /** Decode one analysis PNG into kt values (for hover) + a colorized data URL.
     *  Returns the decoded record, or the {st: 'loading' | 'error'} record while there
     *  is none; an error is re-tried here on a later render (see _hdobTdrImg), or at
     *  once with force (the key's Retry button). */
    function _hdobTdrLoad(url, force) {
        if (!url) return { st: 'error', n: _HDOB_TDR_RETRIES + 1, at: 0 };
        var c = _hdobTdrImg[url];
        if (c && (c.vals || c.st === 'loading')) return c;
        if (c && !force && (c.n > _HDOB_TDR_RETRIES || Date.now() - c.at < _hdobTdrRetryMs(c.n))) return c;
        var n = c ? c.n : 0, rec = { st: 'loading', n: n };
        _hdobTdrImg[url] = rec;
        var img = new Image(); img.crossOrigin = 'anonymous';
        function fail() {
            if (_hdobTdrImg[url] !== rec) return;       // superseded (storm switch, Retry)
            var er = { st: 'error', n: n + 1, at: Date.now() };
            _hdobTdrImg[url] = er;
            if (_hdobData) _hdobRender();               // the key reports the failure now…
            if (er.n <= _HDOB_TDR_RETRIES) setTimeout(function () {
                if (_hdobTdrImg[url] === er && _hdobData) _hdobRender();   // …and the next render re-tries
            }, _hdobTdrRetryMs(er.n) + 50);
        }
        img.onload = function () {
            if (_hdobTdrImg[url] !== rec) return;
            try {
                var w = img.naturalWidth, h = img.naturalHeight, cv = document.createElement('canvas');
                if (!w || !h) throw new Error('empty PNG');
                cv.width = w; cv.height = h;
                var ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
                var im = ctx.getImageData(0, 0, w, h), px = im.data, vals = new Uint8Array(w * h), lut = _hdobTdrLut(), peak = 0;
                for (var i = 0; i < w * h; i++) {
                    var v = px[i * 4]; vals[i] = v;
                    if (!v) { px[i * 4 + 3] = 0; continue; }
                    if (v > peak) peak = v;
                    px[i * 4] = lut[v * 3]; px[i * 4 + 1] = lut[v * 3 + 1]; px[i * 4 + 2] = lut[v * 3 + 2]; px[i * 4 + 3] = 255;
                }
                ctx.putImageData(im, 0, 0);
                _hdobTdrImg[url] = { vals: vals, w: w, h: h, url: cv.toDataURL('image/png'), peak: peak };
            } catch (e) { fail(); return; }
            if (_hdobData) _hdobRender();
        };
        img.onerror = fail;
        // A re-try asks the CDN again instead of replaying a cached 404 (a JSON can land before its PNGs).
        img.src = n ? url + (url.indexOf('?') < 0 ? '?' : '&') + 'retry=' + n + '-' + (Date.now() % 1e6) : url;
        return rec;
    }
    /** Displayed maximum (kt) of an analysis (or the swath): max_px_kt is exactly the value the
     *  publisher wrote into the peak PNG pixel, so the key agrees with the hover readout at the
     *  peak. max_kt is pre-rounded to 0.1 kt, and rounding it again could read 1 kt high
     *  (raw 99.46 → max_kt 99.5 → "100" over a 99 pixel); it is only the fallback for JSONs
     *  published before max_px_kt. */
    function _hdobTdrPeakKt(o) {
        if (!o) return null;
        if (o.max_px_kt != null && isFinite(o.max_px_kt)) return Math.round(+o.max_px_kt);
        return (o.max_kt != null && isFinite(o.max_kt)) ? Math.round(+o.max_kt) : null;
    }
    /** The publisher's 80% band for the 10-m peak (max_band_kt [lo, hi], one decimal) as whole
     *  kt, rounded OUTWARD so a peak inside the published band never prints outside it; null
     *  when absent (JSONs before 2026-09-28) or malformed. */
    function _hdobTdrBand(o) {
        var b = o && o.max_band_kt;
        if (!b || b.length !== 2 || b[0] == null || b[1] == null) return null;
        var lo = +b[0], hi = +b[1];
        if (!isFinite(lo) || !isFinite(hi) || lo > hi) return null;
        return { lo: Math.floor(lo), hi: Math.ceil(hi),
                 note: String(o.band_note || (_hdobTdrMeta && _hdobTdrMeta.band_note) || '80% band for the peak 10-m wind') };
    }
    function _hdobTdrBandText(bd) { return '(80%: ' + bd.lo + '–' + bd.hi + ')'; }
    function _hdobTdrEsc(s) {
        return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    }
    /** Analyses offered on the map: the stale ones drop out unless 'Older' is on. */
    function _hdobTdrAnalyses() {
        var cut = _hdobStaleCut();
        return ((_hdobTdrMeta && _hdobTdrMeta.analyses) || []).filter(function (a) { return !_hdobHideOld(a.t, cut); });
    }
    function _hdobTdrPick(passInfo) {
        var an = _hdobTdrAnalyses();
        if (!an.length) return { a: null, why: '' };
        if (_hdobTdrSel) for (var i = 0; i < an.length; i++) if (an[i].file === _hdobTdrSel) return { a: an[i], i: i };
        var want = passInfo ? Date.parse(passInfo.t) : (_hdobFrozenAt ? Date.parse(_hdobFrozenAt) : NaN);
        if (isNaN(want)) return { a: an[an.length - 1], i: an.length - 1 };   // live sortie: newest analysis
        var bi = 0, bd = Infinity;
        // Archive replay: never show an analysis from after the replay clock — the latest one
        // centred at or before it (a pass selected with the stepper still takes the nearest).
        var causal = !!_hdobArchive && !passInfo;
        for (var k = 0; k < an.length; k++) {
            var tk = Date.parse(an[k].t);
            if (causal && tk > want) continue;
            var d = Math.abs(tk - want); if (d < bd) { bd = d; bi = k; }
        }
        if (bd > _HDOB_TDR_MAX_DT_MS) return { a: null, why: 'No TDR analysis within 90 min of ' + (passInfo ? 'this pass' : 'this sortie') + '.' };
        return { a: an[bi], i: bi };
    }
    function _hdobTdrKey(map) {
        if (_hdobTdrKeyEl) return _hdobTdrKeyEl;
        var host = map.getContainer ? map.getContainer() : document.getElementById('recon-hdob-map');
        var el = document.createElement('div'); el.className = 'recon-hdob-tdrkey'; el.style.display = 'none';
        // keep map drags/zooms from starting on the key's buttons
        ['mousedown', 'dblclick', 'wheel', 'touchstart', 'pointerdown'].forEach(function (ev) {
            el.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
        });
        host.appendChild(el); _hdobTdrKeyEl = el;
        return el;
    }
    /** Key for the picked analysis. It describes a field only once that field is on
     *  the map (img decoded); while its PNG loads or after it failed nothing is drawn,
     *  and the key says exactly that. */
    function _hdobTdrKeyHtml(pick, an, img) {
        var kit = window._ReconKit, stops = (kit && kit.windStops) || [];
        var a = pick.a, h = '<div class="tt">SEAR 10-m from TDR <span class="exp">experimental</span></div>';
        if (an.length) {
            var lbl = a ? (a.t.slice(11, 16) + 'Z · ' + a.mission + ' (' + (pick.i + 1) + '/' + an.length + ')') : '—';
            h += '<div class="nav"><button data-d="-1" title="Earlier analysis">◀</button><span>' + lbl + '</span>' +
                 '<button data-d="1" title="Later analysis">▶</button>' +
                 '<button data-d="0" class="' + (_hdobTdrSel ? '' : 'on') + '" title="Follow the selected pass / sortie time">Auto</button></div>';
        }
        if (!a) return h + '<div class="info">' + (pick.why || '') + '</div>';
        if (!img || !img.vals) {
            var tl = a.t.slice(11, 16) + 'Z';
            if (img && img.st === 'error') {
                return h + '<div class="info st err">' + tl + ' field failed to load — ' +
                    (img.n <= _HDOB_TDR_RETRIES ? 'retrying… ' : '') +
                    '<button class="retry" title="Load this analysis again">Retry</button></div>';
            }
            return h + '<div class="info st">Loading the ' + tl + ' field…</div>';
        }
        h += '<div class="bar">';
        for (var i = 0; i < stops.length; i++) {
            var lo = i ? stops[i - 1][0] : 0;
            h += '<span style="background:' + stops[i][1] + '" title="' + (i ? lo + '+' : '<' + stops[i][0]) + ' kt">' + (i ? lo : '') + '</span>';
        }
        var pk = _hdobTdrPeakKt(a), bd = _hdobTdrBand(a);
        h += '</div><div class="info">Max ' + (pk != null ? pk : '—') + ' kt' +
             (bd ? ' <span class="band" title="' + _hdobTdrEsc(bd.note) + '">' + _hdobTdrBandText(bd) + '</span>' : '') +
             ', ' + Math.round(a.max_r_nm) + ' n mi from center · ' +
             'analysis ' + a.window[0].slice(11, 16) + '–' + a.window[1].slice(11, 16) + 'Z · no color = no TDR data below 1 km</div>' +
             '<div class="hov">Hover the map for a value</div>';
        return h;
    }
    /** Hover readout. Samples only _hdobTdrShown, which is set exclusively while the
     *  picked analysis — the one the key names — is the field on the map. */
    function _hdobTdrHover(e) {
        var sh = _hdobTdrShown, el = _hdobTdrKeyEl;
        if (!sh || !el) return;
        var hv = el.querySelector('.hov');
        if (!hv) return;
        var ll = e.latlng, b = sh.a.bounds, merc = function (la) { return Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360)); };
        var x = Math.floor((ll.lng - b[0][1]) / (b[1][1] - b[0][1]) * sh.w);
        var y = Math.floor((merc(b[1][0]) - merc(ll.lat)) / (merc(b[1][0]) - merc(b[0][0])) * sh.h);
        var v = (x >= 0 && x < sh.w && y >= 0 && y < sh.h) ? sh.vals[y * sh.w + x] : 0;
        if (!v) { hv.textContent = 'Cursor: no TDR data'; return; }
        var c = sh.a.center, dy = (ll.lat - c[0]) * 111.32, dx = (ll.lng - c[1]) * 111.32 * Math.cos(c[0] * Math.PI / 180);
        var kit = window._ReconKit, az = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, r = Math.sqrt(dx * dx + dy * dy);
        // the 80% band is published for the analysis peak only (no per-pixel band)
        var bd = v === sh.peak ? _hdobTdrBand(sh.a) : null;
        hv.textContent = 'Cursor: ' + v + ' kt' + (bd ? ' (analysis peak; 80%: ' + bd.lo + '–' + bd.hi + ')' : '') + ' · ' +
            ((kit && kit.searWhere) ? kit.searWhere(az, r) : Math.round(r) + ' km from center');
    }
    /** Fetch the swath JSON (analysis list) once per SEAR payload generation.
     *  Needed by the map layer AND the summary tile, so it runs even with the
     *  TDR 10-m pill off. */
    function _hdobTdrEnsureMeta() {
        var sp = _hdobData && _hdobData.sear, url = sp && sp.swath_url;
        if (!url) return;
        if (url !== _hdobTdrMetaUrl || (sp.generated && sp.generated !== _hdobTdrMetaGen)) {
            _hdobTdrMetaUrl = url; _hdobTdrMetaGen = sp.generated || null;
            fetch(url, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
                if (!j || url !== _hdobTdrMetaUrl) return;
                _hdobTdrMeta = j;
                if (_hdobData) _hdobRender();
            }).catch(function () {});
        }
    }
    function _hdobRenderTdr(map, passInfo) {
        var sp = _hdobData && _hdobData.sear, url = sp && sp.swath_url;
        if (!url || !_hdobLayerVis.tdr) { _hdobTdrRemove(); return; }
        _hdobTdrEnsureMeta();
        var an = _hdobTdrAnalyses();
        if (!an.length) { _hdobTdrRemove(); return; }
        var pick = _hdobTdrPick(passInfo), key = _hdobTdrKey(map);
        var img = pick.a ? _hdobTdrLoad(pick.a.png) : null, ready = !!(img && img.vals);
        // The key, the drawn field and the hover readout must always name the same analysis.
        // Anything else comes off the map BEFORE the key is rewritten: the previous field used to
        // stay drawn (and hover-sampled) under the new label while the new PNG loaded or failed.
        if (!ready || !_hdobTdrShown || _hdobTdrShown.png !== pick.a.png) {
            if (_hdobTdrOverlay) { try { map.removeLayer(_hdobTdrOverlay); } catch (e) {} _hdobTdrOverlay = null; }
            _hdobTdrShown = null;
        }
        key.innerHTML = _hdobTdrKeyHtml(pick, an, img); key.style.display = '';
        Array.prototype.forEach.call(key.querySelectorAll('.nav button'), function (b) {
            b.onclick = function () {
                var d = +b.getAttribute('data-d'), cur = pick.a ? pick.i : an.length - 1;
                _hdobTdrSel = d === 0 ? null : an[Math.max(0, Math.min(an.length - 1, cur + d))].file;
                _ga('recon_hdob_tdr_step', { dir: d });
                _hdobRender();
            };
        });
        var rb = key.querySelector('button.retry');
        if (rb) rb.onclick = function () {
            _ga('recon_hdob_tdr_retry', {});
            _hdobTdrLoad(pick.a.png, true);
            _hdobRender();
        };
        // IR stays gray while a field is drawn or on its way (no color flash between analyses);
        // no pick, or a load that has given up, gives the colored IR back.
        _hdobTdrGraySat(!!pick.a && (ready || img.st === 'loading' || img.n <= _HDOB_TDR_RETRIES));
        if (!ready) return;              // a load re-renders; a failure re-tries on a later render
        if (pick.a.max_px_kt != null && +pick.a.max_px_kt !== img.peak && !img.warned) {
            img.warned = true;           // publisher contract: max_px_kt IS the peak pixel
            console.warn('[recon] TDR ' + pick.a.file + ': max_px_kt ' + pick.a.max_px_kt + ' but the PNG peaks at ' + img.peak + ' kt');
        }
        try { var pane = map.getPane('hdobTdrPane') || map.createPane('hdobTdrPane'); pane.style.zIndex = 380; pane.style.pointerEvents = 'none'; } catch (e) {}
        // A new analysis gets a NEW overlay (url + bounds in one step): setUrl + setBounds on the old
        // one moved the previous image onto the new bounds until the new image had decoded.
        if (!_hdobTdrOverlay) _hdobTdrOverlay = L.imageOverlay(img.url, L.latLngBounds(pick.a.bounds), { opacity: 0.9, interactive: false, crisp: true, pane: 'hdobTdrPane' }).addTo(map);
        _hdobTdrShown = { a: pick.a, png: pick.a.png, vals: img.vals, w: img.w, h: img.h, peak: img.peak };
        if (!_hdobTdrHoverBound) { map.on('mousemove', _hdobTdrHover); _hdobTdrHoverBound = true; }
    }

    /** SEAR pass peaks on the map: a pink ring at the aircraft position of each
     *  pass's peak 10-m estimate, joined to the pass center by a dashed radial —
     *  so the quadrant an estimate came from is read off the map, not inferred.
     *  Honors the flight selection like the sonde/VDM markers. */
    /** ' · 128–147 kt with either eyewall RMW' — the pass re-scored with the RMW
     *  measured on its inbound and outbound eyewall crossings. SEAR's largest
     *  sensitivity is r/RMW, so a single number without this spread overstates
     *  the precision (Lowell 2026-09-04 20:23Z: 147 kt at the two-leg mean RMW,
     *  128 kt at the outbound leg's own RMW). */
    function _hdobSearRange(p) {
        var r = p && p.y_range_kt;
        if (!r || r.length !== 2 || r[0] == null || r[1] == null) return '';
        var lo = Math.round(r[0]), hi = Math.round(r[1]);
        if (hi - lo < 2) return '';
        return lo + '\u2013' + hi + ' kt';
    }
    /** Headline for a pass: preliminary-center passes lead with the RMW range
     *  ('129–148 kt'), since the point value depends on a center we have not
     *  confirmed; VDM-fixed passes lead with the point value. (Michael,
     *  2026-09-04: a range beats an uncertain guess.) */
    /** RMW-corrected value is the headline (2026-09-05): it is what the MLBT record assimilates. */
    function _hdobSearVal(p) { return (p && p.y_corr_kt != null) ? p.y_corr_kt : (p ? p.y_kt : null); }
    /** Preliminary vs final (2026-09-30, Michael): a crossing is FINAL once its outbound leg is flown and its center
     *  is a VDM / TDR fix (or an hour passes without one); the publisher never changes a final value afterwards.
     *  Until then it is PRELIMINARY and shown only as a range covering the unsettled center and RMW. Payloads from
     *  before the final flag keep the old rule (preliminary = pressure-minimum center). */
    function _hdobSearIsPrelim(p) { return !!p && (p.final === false || (p.final === undefined && p.fix_source === 'hdob')); }
    function _hdobSearPrelimRange(p) {
        var r = (p && (p.y_prelim_range_kt || p.range_kt)) || (p && p.y_range_kt);
        if (!r || r.length !== 2 || r[0] == null || r[1] == null) return '';
        return Math.round(r[0]) + '–' + Math.round(r[1]) + ' kt';
    }
    function _hdobSearHeadline(p) {
        if (_hdobSearIsPrelim(p)) return 'PRELIM ' + (_hdobSearPrelimRange(p) || '—');
        return Math.round(_hdobSearVal(p)) + ' kt';
    }
    function _hdobSearIsRangeLed(p) { return _hdobSearIsPrelim(p); }
    /** 'most likely 147 kt' — the point estimate that accompanies a range-led headline. */
    function _hdobSearLikely(p) { return (p && _hdobSearVal(p) != null) ? 'most likely ' + Math.round(_hdobSearVal(p)) + ' kt' : ''; }
    /** Multiline HTML: how the estimate was built + center/fix caveats. */
    function _hdobSearDetail(p) {
        if (!p) return '';
        var L = [];
        var c = p.chain;
        if (_hdobSearIsPrelim(p)) {
            L.push('PRELIMINARY' + (p.pending_reason ? ' (' + p.pending_reason + ')' : '') + ': the range covers the unsettled center and RMW' +
                   (p.final_by ? '; final by ~' + String(p.final_by).slice(11, 16) + 'Z' : ''));
            c = null;
        }
        if (c && c.s1 != null && c.s2 != null && c.f10 != null && p.fl_peak_kt != null) {
            L.push('FL ' + Math.round(p.fl_peak_kt) + ' kt \u00d7 ' + c.s1.toFixed(2) + ' (to 500 m) \u00d7 ' + c.s2.toFixed(2) +
                   ' (to 150 m) \u00d7 ' + c.f10.toFixed(3) + ' (to 10 m) = ' + Math.round(p.y_kt) + ' kt' +
                   (c.corr != null && p.y_corr_kt != null ? ' \u00d7 ' + c.corr.toFixed(3) + ' (TDR resolution, RMW ' + Math.round(p.rmw_km) + ' km) = ' + Math.round(p.y_corr_kt) + ' kt' : ''));
        }
        var rg = _hdobSearRange(p);
        if (rg) {
            L.push('Range ' + rg + ': re-scored with the RMW of each eyewall crossing' +
                   (p.rmw_in_km != null && p.rmw_out_km != null ? ' (in ' + Math.round(p.rmw_in_km) + ' km, out ' + Math.round(p.rmw_out_km) + ' km)' : ''));
        }
        var co = p.contrib && p.contrib.s2;
        if (co && co.length) {
            L.push('Largest term: ' + co[0][0] + ' ' + co[0][1] + ' (' + (co[0][2] >= 0 ? '+' : '') + co[0][2].toFixed(2) + ' on the 500 m\u2192150 m ratio)');
        }
        if (p.fix_source === 'hdob') {
            L.push('Preliminary center: ' + (p.center_method === 'HDOB_WC82' ? 'Willoughby\u2013Chelmow wind center' : p.center_method === 'HDOB_WIND+PRES' ? 'wind + pressure centroids' :
                   p.center_method === 'HDOB_WIND_CTR' ? 'calm-wind centroid' : p.center_method === 'HDOB_PMIN_PLATEAU' ? 'pressure-plateau centroid' : 'flight-level pressure minimum') +
                   (p.ctr_spread_km != null ? (p.center_method === 'HDOB_WC82' ? ', ' + Math.round(p.ctr_spread_km) + ' km from the centroid' : ', ' + Math.round(p.ctr_spread_km) + ' km apart') : '') + ' (no VDM yet)');
        }
        if (p.fix_dt_min != null && Math.abs(p.fix_dt_min) > 30) {
            L.push('\u26a0 nearest center fix is ' + Math.round(Math.abs(p.fix_dt_min)) + ' min away \u2014 center extrapolated');
        }
        return L.join('<br>');
    }
    window._hdobSearDetail = _hdobSearDetail;

    function _hdobRenderSearPasses(map, selPass) {
        for (var i = 0; i < _hdobSearMarkers.length; i++) { try { map.removeLayer(_hdobSearMarkers[i]); } catch (e) {} }
        _hdobSearMarkers = [];
        if (!_hdobLayerVis.sear) return;
        var sp = _hdobData && _hdobData.sear;
        var passes = (sp && sp.passes) || [];
        if (!passes.length) return;
        var selT = selPass && selPass.pass ? (selPass.pass.fix_t || selPass.pass.t) : null;
        var kit = window._ReconKit;
        var PINK = '#ec4899';
        var cut = _hdobStaleCut();
        var shown = _hdobSearPassesInScope(passes).filter(function (p) {
            return p.lat != null && p.lon != null && p.y_kt != null && !_hdobHideOld(p.fix_t || p.t, cut);
        }).sort(function (a, b) { return String(a.fix_t || a.t) < String(b.fix_t || b.t) ? -1 : 1; });
        // Pass-to-pass center track first (under everything): the pseudo-fixes
        // read as a smooth motion vector, not a scatter of points.
        var ctr = shown.filter(function (p) { return p.clat != null && p.clon != null; });
        if (ctr.length > 1 && L.polyline) {
            var trk = L.polyline(ctr.map(function (p) { return [p.clat, p.clon]; }),
                { color: PINK, weight: 1.2, opacity: 0.7, dashArray: '1 5', interactive: false });
            trk.addTo(map); _hdobSearMarkers.push(trk);
        }
        shown.forEach(function (p) {
            var where = (kit && kit.searWhere) ? kit.searWhere(p.az_deg, p.r_km) : (p.quad || '');
            var when = String(p.t).slice(11, 16) + 'Z · ' + _hdobTailDisplay(p.tail);
            var prelim = p.fix_source === 'hdob';
            var isSel = selT != null && (p.fix_t || p.t) === selT;   // the stepped pass
            var hasC = p.clat != null && p.clon != null;
            if (hasC) {
                // radial center → peak, then the center itself as a small pink ×
                // (distinct from the red ⊕ of an official VDM fix)
                if (L.polyline) {
                    var line = L.polyline([[p.clat, p.clon], [p.lat, p.lon]],
                        { color: PINK, weight: 1.5, opacity: 0.85, dashArray: '3 4', interactive: false });
                    line.addTo(map); _hdobSearMarkers.push(line);
                }
                var cIcon = L.divIcon({ className: 'recon-hdob-searctr' + (isSel ? ' sel' : ''),
                    html: '<span style="color:' + PINK + ';font-size:15px;line-height:14px;font-weight:700;' +
                          'text-shadow:0 0 2px #fff,0 0 2px #fff;">×</span>',
                    iconSize: [14, 14], iconAnchor: [7, 7] });
                var cm = L.marker([p.clat, p.clon], { icon: cIcon, interactive: true, zIndexOffset: 900 });
                try {
                    cm.bindTooltip('<b>Pass center</b> ' + String(p.fix_t || p.t).slice(11, 16) + 'Z · ' + _hdobTailDisplay(p.tail) +
                        (prelim ? '<br>preliminary: flight-level pressure minimum (no VDM yet)' : '<br>Vortex Data Message fix') +
                        (p.rmw_km != null ? '<br>RMW ' + Math.round(p.rmw_km) + ' km' : ''),
                        { direction: 'top', offset: [0, -8] });
                } catch (e) {}
                cm.addTo(map); _hdobSearMarkers.push(cm);
            }
            // Peak: small ring + an always-on "123 kt N" label so the value and
            // its quadrant read off the map without hovering.
            var mk = L.circleMarker([p.lat, p.lon],
                { radius: isSel ? 6 : 4, color: PINK, weight: isSel ? 3 : 2, opacity: 0.95, fillColor: '#fff', fillOpacity: 0.9 });
            var rg = _hdobSearRange(p), det = _hdobSearDetail(p);
            var rangeLed = _hdobSearIsRangeLed(p);
            var tip = '<b>SEAR ' + _hdobSearHeadline(p) + '</b> 10-m estimate (exp)' +
                (rangeLed ? ' · single value once final' : (rg ? ' · <b>' + rg + '</b>' : '')) +
                (where ? '<br>' + where : '') + '<br>' + when +
                (p.fl_peak_kt != null ? ' · FL peak ' + Math.round(p.fl_peak_kt) + ' kt' : '') +
                (det ? '<br><span style="opacity:.8">' + det + '</span>' : '');
            try { mk.bindTooltip(tip, { direction: 'top', offset: [0, -6] }); } catch (e) {}
            mk.addTo(map); _hdobSearMarkers.push(mk);
            var q = (kit && kit.compass8) ? kit.compass8(p.az_deg) : (p.quad || '');
            var lIcon = L.divIcon({ className: 'recon-hdob-searlbl' + (isSel ? ' sel' : ''),
                html: '<span style="color:' + PINK + ';font-size:10px;font-weight:700;white-space:nowrap;' +
                      'text-shadow:0 0 2px #fff,0 0 2px #fff,0 0 3px #fff;">' +
                      _hdobSearHeadline(p) + (q ? ' ' + q : '') + '</span>',
                iconSize: [1, 1], iconAnchor: [-6, 6] });
            var lm = L.marker([p.lat, p.lon], { icon: lIcon, interactive: false, zIndexOffset: 800 });
            lm.addTo(map); _hdobSearMarkers.push(lm);
        });
    }

    /** Great-circle initial bearing (° clockwise from north) p1 → p2. */
    function _hdobBearing(la1, lo1, la2, lo2) {
        var d2r = Math.PI / 180;
        var y = Math.sin((lo2 - lo1) * d2r) * Math.cos(la2 * d2r);
        var x = Math.cos(la1 * d2r) * Math.sin(la2 * d2r) -
                Math.sin(la1 * d2r) * Math.cos(la2 * d2r) * Math.cos((lo2 - lo1) * d2r);
        return (Math.atan2(y, x) / d2r + 360) % 360;
    }

    /** ✈ marker at each aircraft's latest ob, rotated to its heading. */
    function _hdobRenderAircraft(map, aircraft) {
        for (var i = 0; i < _hdobAircraftMarkers.length; i++) {
            try { map.removeLayer(_hdobAircraftMarkers[i]); } catch (e) {}
        }
        _hdobAircraftMarkers = [];
        for (var a = 0; a < aircraft.length; a++) {
            var tr = aircraft[a].track || [];
            if (!tr.length) continue;
            var last = tr[tr.length - 1];
            if (last.lat == null || last.lon == null) continue;
            // Heading from the last meaningful segment (skip ~stationary points).
            var hdg = 0;
            for (var j = tr.length - 2; j >= 0 && j >= tr.length - 8; j--) {
                if (tr[j].lat == null) continue;
                if (Math.abs(tr[j].lat - last.lat) > 0.02 || Math.abs(tr[j].lon - last.lon) > 0.02) {
                    hdg = _hdobBearing(tr[j].lat, tr[j].lon, last.lat, last.lon);
                    break;
                }
            }
            // Plane SVG points UP (north) at rotation 0; rotate by heading. The
            // rotation must be an SVG <g transform>, not CSS on the root <svg> —
            // html2canvas rasterizes inline SVG as a standalone image, where a
            // root-level CSS transform is dropped and the saved plane points north.
            var svg = '<svg width="26" height="26" viewBox="0 0 24 24" ' +
                'style="filter:drop-shadow(0 0 1.5px rgba(0,0,0,0.8));">' +
                '<g transform="rotate(' + hdg.toFixed(0) + ' 12 12)">' +
                '<path d="M12 2 L14.2 10 L22 13.5 L22 15.5 L14.2 13.5 L13.4 19 L16 21 L16 22.3 ' +
                'L12 21.2 L8 22.3 L8 21 L10.6 19 L9.8 13.5 L2 15.5 L2 13.5 L9.8 10 Z" ' +
                'fill="#fde047" stroke="#1f2937" stroke-width="0.7" stroke-linejoin="round"/></g></svg>';
            var icon = L.divIcon({ className: 'recon-hdob-aircraft', html: svg,
                                   iconSize: [26, 26], iconAnchor: [13, 13] });
            var mk = L.marker([last.lat, last.lon], { icon: icon, interactive: true, zIndexOffset: 1000 });
            mk.bindTooltip(_hdobTailDisplay(aircraft[a].tail) + ' · ' + (last.wspd_kt != null ? last.wspd_kt + ' kt FL' : '') +
                ' · ' + (window._ReconKit ? window._ReconKit.fmtTime(last.t) : last.t),
                { direction: 'top', offset: [0, -10] });
            mk.addTo(map);
            _hdobAircraftMarkers.push(mk);
        }
    }

    /** Aircraft to show in a given panel given the current flight selection.
     *  A specific sortie filters BOTH panels to that flight. With no selection
     *  ('all'): the CHART shows just the freshest single sortie so its profile
     *  traces stay legible, while the MAP shows the LATEST sortie of each tail —
     *  multiple simultaneous planes still get spatial context, but a tail's
     *  already-landed earlier sortie doesn't clutter the default view.
     *  (aircraft[0] is freshest — the backend sorts by latest ob time.) */
    function _hdobFilterAircraft(aircraft, which) {
        if (!aircraft || !aircraft.length) return [];
        if (_hdobFlightSel) {
            var pick = aircraft.filter(function (a) { return _hdobAcId(a) === _hdobFlightSel; });
            return pick.length ? pick : aircraft;   // selection stale → fall back to all
        }
        if (which === 'chart') return [_hdobDefaultAircraft(aircraft)];
        // Map, no selection: first (freshest) sortie per tail.
        var seen = {}, out = [];
        for (var i = 0; i < aircraft.length; i++) {
            var t = aircraft[i].tail;
            if (seen[t]) continue;
            seen[t] = 1; out.push(aircraft[i]);
        }
        return out;
    }

    /** The flight to show when the user hasn't picked one. The server lists
     *  sorties freshest-first, and "freshest" alone chose a P-3 that had just
     *  started streaming IWG1 on the ramp (1000 mb, 20 kt, 24 m) over the USAF
     *  crew in the eyewall (Lowell, 2026-09-04). Among sorties still reporting
     *  (last ob within 45 min of the newest), take the one whose track carries
     *  the strongest flight-level wind — the plane that is actually in the
     *  storm; ties and no-active-flight fall back to the freshest. */
    function _hdobDefaultAircraft(aircraft) {
        var newest = 0, i;
        for (i = 0; i < aircraft.length; i++) {
            var tr = aircraft[i].track || [];
            var ms = tr.length ? Date.parse(_hdobX(tr[tr.length - 1].t)) : 0;
            if (ms > newest) newest = ms;
        }
        var best = aircraft[0], bestW = -1;
        for (i = 0; i < aircraft.length; i++) {
            var t2 = aircraft[i].track || [];
            if (!t2.length) continue;
            var last = Date.parse(_hdobX(t2[t2.length - 1].t));
            if (!(newest - last <= 45 * 60000)) continue;
            var w = 0;
            for (var j = 0; j < t2.length; j++) {
                var v = (t2[j].peak_fl_kt != null) ? t2[j].peak_fl_kt : t2[j].wspd_kt;
                if (v != null && v > w) w = v;
            }
            if (w > bestW) { bestW = w; best = aircraft[i]; }
        }
        return best;
    }

    function _hdobTailEq(a, b) {
        return String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();
    }

    /** Scope the dropsonde + VDM markers to the selected flight, the same way
     *  _hdobFilterAircraft scopes the barbs/track. Sondes carry `tail`, VDMs
     *  carry `aircraft`; both are matched against the selected aircraft's raw
     *  tail (the `#sortie` suffix is dropped — sonde/VDM records aren't tagged
     *  by sortie). No selection → the blob is returned unchanged. */
    function _hdobFilterMarkerBlob(blob) {
        if (!blob) return blob;
        var selTail = _hdobFlightSel ? _hdobFlightSel.split('#')[0] : null;
        var cut = _hdobStaleCut();
        function keep(t) { return !selTail || _hdobTailEq(t, selTail); }
        return Object.assign({}, blob, {
            dropsondes: _hdobLayerVis.sondes ? (blob.dropsondes || []).filter(function (d) { return keep(d.tail) && !_hdobHideOld(d.t, cut); }) : [],
            vdms:       _hdobLayerVis.vdm    ? (blob.vdms || []).filter(function (x) { return keep(x.aircraft) && !_hdobHideOld(x.t, cut); }) : []
        });
    }

    /** Segmented flight selector: [All] [tail · src] … Controls chart + map.
     *  Hidden when only one aircraft is present (nothing to choose). */
    function _hdobBuildFlightToggle() {
        var box = document.getElementById('recon-hdob-flighttoggle');
        if (!box) return;
        var aircraft = (_hdobData && _hdobData.aircraft) || [];
        if (aircraft.length < 2) { box.innerHTML = ''; box.style.display = 'none'; return; }
        box.style.display = '';
        box.innerHTML = '<span class="recon-hdob-flightlabel">Flight</span>';
        var opts = [{ id: '', label: 'All' }].concat(aircraft.map(function (a) {
            return { id: _hdobAcId(a), label: _hdobAcLabel(a) };
        }));
        opts.forEach(function (o) {
            var b = document.createElement('button');
            b.textContent = o.label;
            b.className = (_hdobFlightSel === o.id) ? 'on' : '';
            if (o.id === '') b.title = 'Map: current flights · chart: latest flight';
            b.onclick = function () {
                _hdobFlightSel = o.id;
                _ga('recon_hdob_flight', { sel: o.id || 'all' });
                _hdobBuildFlightToggle();
                _hdobRender();   // re-render both panels under the new filter
            };
            box.appendChild(b);
        });
    }

    /** Label for the sustained FL-wind trace, reflecting the displayed flight's
     *  source + the 1-s toggle: USAF HDOB = 30-s; NOAA IWG1 = 10-s mean or 1-s. */
    function _hdobFLWindLabel() {
        var ac = _hdobFilterAircraft((_hdobData && _hdobData.aircraft) || [], 'chart');
        if (ac.length && ac[0].src === 'iwg1') return _hdobFl1s ? 'FL Wind (1s)' : 'FL Wind (10s)';
        return 'FL Wind (30s)';
    }

    /** Honest provenance of the displayed flight's wind, so we never imply a
     *  native product we didn't get. NOAA = derived by us from the 1-Hz IWG1
     *  feed; USAF = the native NHC HDOB product. */
    function _hdobSourceText() {
        var ac = _hdobFilterAircraft((_hdobData && _hdobData.aircraft) || [], 'chart');
        var src = ac.length ? ac[0].src : null;
        if (src === 'iwg1') {
            return 'Source: NOAA 1-Hz (IWG1) flight-level feed. FL Wind = ' +
                (_hdobFl1s ? 'full 1-second wind' : '10-second vector mean') +
                '; Peak = highest 10-second mean wind (within 30 s) — both derived by TC-ATLAS from the 1-Hz data (not a native 10-s product).';
        }
        if (src === 'hdob') {
            return 'Source: USAF HDOB — NHC 30-second average wind with the reported 10-second peak.';
        }
        return '';
    }

    /** Storm id to look the SEAR object up under. Mission mode falls back to a
     *  basin placeholder (EP992026) when the HDOB mission id doesn't decode
     *  (NOAA3 "LOWELL" 2026-09-02); resolve the flight's label through the
     *  storm picker so the lookup still lands on the real storm. */
    function _hdobSearAtcf() {
        var id = _hdobAtcf || '';
        if (_hdobMissionTail && /99\d{4}$/.test(id) && _hdobName) {
            var want = String(_hdobName).toUpperCase();
            for (var i = 0; i < _hdobStormOpts.length; i++) {
                var o = _hdobStormOpts[i];
                if (o && o.atcf && String(o.name || '').toUpperCase() === want) return o.atcf;
            }
        }
        return id;
    }

    /** Experimental SEAR line: latest pass maxima + product stamp, or why none. */
    /** Strongest flagged eyewall sonde on the flights on display (never after the replay clock): the sonde's
     *  10-m wind (WL150 x the chain's wind-dependent factor) beat flight-level SEAR at its release point by
     *  >= threshold -- a surface-heavy eyewall the flight-level estimate cannot see (Rachel 2026-09-30). */
    function _hdobSondeFlag() {
        var sk = _hdobData && _hdobData.sear && _hdobData.sear.sonde_check;
        if (!sk || !(sk.sondes || []).length) return null;
        var clock = _hdobArchive ? +_hdobArchive.cur : Infinity;
        var fl = _hdobSearPassesInScope(sk.sondes).filter(function (q) { return q.flag && !(Date.parse(q.t) > clock); });
        if (!fl.length) return null;
        var top = fl.reduce(function (a, b) { return b.sonde_10m_kt > a.sonde_10m_kt ? b : a; });
        return { top: top, n: fl.length, thr: sk.threshold_kt };
    }

    function _hdobSondeFlagText(f) {
        var q = f.top;
        return 'Eyewall sonde check: ' + String(q.t).slice(11, 16) + 'Z ' + _hdobTailDisplay(q.tail) + ' WL150 ' + Math.round(q.wl150_kt) +
            ' kt, reduced to ~' + Math.round(q.sonde_10m_kt) + ' kt at 10 m with the SEAR WL150\u219210 m factor (\u00d7' + q.f10.toFixed(2) + '; not the sonde\u2019s own 10-m wind), ' + Math.round(q.diff_kt) +
            ' kt above flight-level SEAR at release' + (f.n > 1 ? ' (' + f.n + ' eyewall sondes \u2265' + Math.round(f.thr) + ' kt above)' : '') +
            ' \u2014 the surface wind is stronger than the flight-level wind implies, so flight-level SEAR is likely low here. ';
    }

    /** Open the flagged sonde's profile modal (same modal as the map's sonde popup). */
    function _hdobOpenSonde(t, tail) {
        var T = Date.parse(t), best = null;
        ((_hdobData && _hdobData.dropsondes) || []).forEach(function (d) {
            var dt = Math.abs(Date.parse(d.t) - T);
            if (!_hdobTailEq(d.tail, tail) || !(dt <= 20000)) return;
            var score = dt - ((d.profile && d.profile.mandatory && d.profile.mandatory.length) ? 5000 : 0) - (d.hires ? 5000 : 0);
            if (!best || score < best.score) best = { d: d, score: score };
        });
        if (best && typeof window._reconOpenSonde === 'function') { window._reconOpenSonde(best.d, _hdobData); _ga('recon_hdob_sonde_flag_open', {}); }
    }

    function _hdobSondeLink(q, label) {
        return '<a href="#" class="recon-sonde-link" data-t="' + _hdobTdrEsc(q.t) + '" data-tail="' + _hdobTdrEsc(q.tail) + '">' + label + '</a>';
    }

    function _hdobWireSondeLinks(el) {
        Array.prototype.forEach.call(el.querySelectorAll('.recon-sonde-link'), function (a) {
            a.onclick = function (e) { e.preventDefault(); e.stopPropagation(); _hdobOpenSonde(a.getAttribute('data-t'), a.getAttribute('data-tail')); };
        });
    }

    function _hdobVerCell(x) {
        if (!x) return '\u2014';
        return (x.bias_kt >= 0 ? '+' : '\u2212') + Math.abs(x.bias_kt).toFixed(1) + ' / ' + x.mae_kt.toFixed(1);
    }

    /** Verification summary table under Live Flight (2026-09-30, Michael: "like GHOST"), from the publisher's
     *  sear_verify.py (payload.verification): 2026 season + the models' held-out 2025 test, both products. */
    function _hdobBuildVerif() {
        var el = document.getElementById('recon-hdob-verif');
        if (!el) return;
        var v = _hdobData && _hdobData.sear && _hdobData.sear.verification;
        if (!v || !v.season_2026) { el.style.display = 'none'; el.innerHTML = ''; return; }
        var S = v.season_2026 || {}, H = v.holdout_2025 || {};
        function cell(x, strong) {
            if (!x) return '<td>\u2014</td>';
            return '<td style="white-space:nowrap">' + (strong ? '<strong>' : '') + _hdobVerCell(x) + (strong ? '</strong>' : '') +
                '<br><span class="recon-verif-n">n = ' + x.n.toLocaleString() + ' \u00b7 ' + x.storms + ' storm' + (x.storms === 1 ? '' : 's') + '</span></td>';
        }
        function rows(key) {
            var s_ = S[key] || {}, h = H[key] || {};
            var cuts = [['all (outside the eye)', 'all', 'all'], ['eyewall (r/RMW 0.75\u20131.25)', 'eyewall', 'eyewall'],
                        ['outer (r/RMW &gt; 1.5)', 'outer', 'outer'],
                        ['hurricane force\u2021', 'obs_ge_64kt', key === 'fl' ? 'fl_ge_100kt' : 'obs_ge_64kt']];
            return cuts.map(function (c, i) {
                return '<tr' + (i === 0 ? ' class="me"' : '') + '><td>' + c[0] + '</td>' + cell(s_[c[1]], i === 0) + cell(h[c[2]], false) + '</tr>';
            }).join('');
        }
        function table(cap, key) {
            return '<div class="exp-verif-t"><table><caption>' + cap + '</caption>' +
                '<tr><th>cut</th><th>2026 season<br>bias / MAE</th><th>2025 test<br>bias / MAE</th></tr>' + rows(key) + '</table></div>';
        }
        var cm = S.common_sondes;
        el.innerHTML =
            '<div class="exp-verif-h">SEAR verification against dropsondes' +
            '<span class="exp-verif-src">10-m wind, kt (bias / mean absolute error); the sonde&rsquo;s WL150 reduced to 10 m with the ' +
            'same wind-dependent factor the products use; eye excluded. 2026 = this season in real time; 2025 test = storms held out ' +
            'of training. Scores the FINAL estimates (every center and leg in hand) &mdash; preliminary values carry more error. ' +
            'Updated ' + String(v.generated || '').slice(0, 16).replace('T', ' ') + 'Z.</span></div>' +
            table('TDR SEAR &mdash; tail-Doppler analysis at the sonde&rsquo;s splash point', 'tdr') +
            table('Flight-level SEAR &mdash; at the sonde&rsquo;s release point', 'fl') +
            '<div class="exp-verif-note">' + (cm && cm.n ? 'On the ' + cm.n + ' sondes both products score: TDR SEAR ' + _hdobVerCell(cm.tdr) +
            ' kt, flight-level SEAR ' + _hdobVerCell(cm.fl) + ' kt. ' : '') +
            '\u2021 sonde 10-m wind &ge; 64 kt, except the flight-level 2025 test row: flight-level wind &ge; 100 kt. ' +
            'Eyewalls whose surface wind exceeds the flight-level wind (e.g. Rachel 30 Sep) are where flight-level SEAR runs low; the eyewall-sonde flag marks them.</div>';
        el.style.display = '';
    }

    /** SEAR lines of the Live Flight note, as bullet items (2026-09-30: one long paragraph was unreadable).
     *  Returns [{text | html, cls}] -- text is set with textContent; only the sonde link is built as a node. */
    function _hdobSearItems() {
        var sp = _hdobData && _hdobData.sear;
        if (!sp) return [];
        var out = [{ text: 'SEAR (experimental): machine-learning estimate of the 10-m wind from the flight-level wind, its position ' +
                           'in the storm and the environment. Not an official product.' + (sp.generated ? ' Updated ' + String(sp.generated).slice(11, 16) + 'Z.' : '') }];
        if (sp.status !== 'ok' || !(sp.passes || []).length) {
            out.push({ text: sp.status === 'awaiting_fix' ? 'Awaiting the first center fix.' : sp.status === 'no_env' ? 'No GFS environment yet.' : 'No scored crossings yet.' });
            return out;
        }
        var sf = _hdobSondeFlag();
        if (sf) out.push({ text: _hdobSondeFlagText(sf), sonde: sf.top, cls: 'warn' });
        var scoped = _hdobSearPassesInScope(sp.passes);
        if (!scoped.length) {
            var older = sp.passes[sp.passes.length - 1];
            out.push({ text: 'No scored crossings yet for this flight' + (older ? ' (previous flight: ' + String(older.t).slice(5, 16).replace('T', ' ') +
                             'Z ' + _hdobTailDisplay(older.tail) + ' ' + _hdobSearHeadline(older) + ')' : '') + '.' });
            return out;
        }
        var anyStale = false, anyPrelimCtr = false, anyPrelim = false;
        var sub = scoped.slice(-4).map(function (p) {
            var kit = window._ReconKit;
            var q = (kit && kit.compass8) ? kit.compass8(p.az_deg) : (p.quad || '');
            var pre = _hdobSearIsPrelim(p), rg = _hdobSearRange(p);
            if (pre) anyPrelim = true;
            if (!pre && p.fix_source === 'hdob') anyPrelimCtr = true;
            if (p.fix_dt_min != null && Math.abs(p.fix_dt_min) > 30) anyStale = true;
            return { text: String(p.t).slice(11, 16) + 'Z ' + _hdobTailDisplay(p.tail) + ': ' + (pre ? 'PRELIMINARY ' + (_hdobSearPrelimRange(p) || '') :
                        Math.round(_hdobSearVal(p)) + ' kt' + (rg ? ' (RMW range ' + rg.replace(' kt', '') + ')' : '')) +
                        (q ? ' \u00b7 ' + q + (p.r_km != null ? ' ' + Math.round(p.r_km) + ' km / ' + Math.round(p.r_km * 0.5399568) + ' n mi' : '') : '') +
                        (pre ? ' \u00b7 ' + (p.pending_reason || 'center not yet confirmed') + (p.final_by ? ', final by ~' + String(p.final_by).slice(11, 16) + 'Z' : '') :
                         (p.fix_source === 'hdob' ? ' \u00b7 preliminary center*' : '')) +
                        (p.fix_dt_min != null && Math.abs(p.fix_dt_min) > 30 ? '\u2020' : ''),
                     cls: pre ? 'prelim' : '' };
        });
        out.push({ text: 'Eyewall crossings, newest last (quadrant, radius from center):', sub: sub });
        var foot = [];
        if (anyPrelim) foot.push('PRELIMINARY = the outbound leg or a confirmed center (VDM or TDR radar) is still to come; shown as a range covering the unsettled center and RMW. ' +
                                 'A crossing becomes final after both (or an hour without a confirmed center) and its value never changes after that.');
        foot.push('RMW range = the same observation re-scored with the RMW of each eyewall leg; SEAR is most sensitive to r/RMW.');
        if (anyPrelimCtr) foot.push('* center from the pressure minimum / calm-wind centroid of the eye crossing, no VDM or TDR center arrived within an hour.');
        if (anyStale) foot.push('\u2020 nearest center fix more than 30 min away, center extrapolated.');
        out.push({ text: foot.join(' '), cls: 'foot' });
        return out;
    }

    /** Strongest TDR-SEAR analysis (by the displayed max, see _hdobTdrPeakKt) centred
     *  within one of the sorties on display (±45 min, like the SEAR passes; NOAA IWG1
     *  tails first since only the P-3s carry the TDR), and never after the replay clock. */
    function _hdobTdrSummaryBest() {
        var sp = _hdobData && _hdobData.sear;
        if (!_hdobTdrMeta || !sp || _hdobTdrMetaUrl !== sp.swath_url) return null;
        var shown = _hdobFilterAircraft(_hdobData.aircraft || [], 'chart').slice().sort(function (a, b) {
            return (b.src === 'iwg1') - (a.src === 'iwg1');
        });
        var clock = _hdobArchive ? +_hdobArchive.cur : Infinity, PAD = 45 * 60000, best = null;
        // the analysis names its own P-3: mission 20261009I1 -> I = N43RF ("NOAA3"), H = N42RF ("NOAA2").
        // Matching by sortie window alone credited AF307 for NOAA3's 04:35Z analysis (Isaias 2026-10-09): a sortie
        // still flying has no end time, so the first aircraft listed always matched.
        var MTAIL = { H: 'NOAA2', I: 'NOAA3' };
        (_hdobTdrMeta.analyses || []).forEach(function (a) {
            var t = Date.parse(a.t), v = _hdobTdrPeakKt(a);
            if (v == null || isNaN(t) || t > clock) return;
            var mt = MTAIL[(String(a.mission || '').match(/^\d{8}([A-Z])/) || [])[1]], tail = null;
            for (var i = 0; i < shown.length && !tail; i++) {
                if (mt ? !_hdobTailEq(shown[i].tail, mt) : !/^NOAA[23]$/i.test(String(shown[i].tail || '').trim())) continue;
                var s = Date.parse(_hdobX(shown[i].sortie_start || '')), e = Date.parse(_hdobX(shown[i].sortie_end || ''));
                if ((isNaN(s) || t >= s - PAD) && (isNaN(e) || t <= e + PAD)) tail = shown[i].tail;
            }
            // the tile shows v, so rank by it; the unrounded max breaks ties, then the newer analysis
            if (tail && (!best || v > best.v || (v === best.v && +a.max_kt >= +best.a.max_kt))) best = { v: v, t: a.t, tail: tail, a: a };
        });
        return best;
    }

    /** Center-fix tile (2026-10-07): the newest VDM leads the pressure slot --
     *  its central pressure is the operational value; extrapolated SLP from a
     *  700/850-mb aircraft is only the estimate between fixes, so it rides
     *  underneath ("since fix"). Scoped to the picked flight's tail when one is
     *  picked, like the map markers. Returns '' when there is no VDM yet. */
    function _hdobCenterFixTile(aircraft) {
        var selTail = _hdobFlightSel ? _hdobFlightSel.split('#')[0] : null;
        var vs = ((_hdobData && _hdobData.vdms) || []).filter(function (v) {
            return v.t && (!selTail || _hdobTailEq(v.aircraft, selTail));
        }).sort(function (a, b) { return Date.parse(_hdobX(a.t)) - Date.parse(_hdobX(b.t)); });
        if (!vs.length) return '';
        var v = vs[vs.length - 1], vms = Date.parse(_hdobX(v.t)), esc = _hdobTdrEsc;
        var lines = [];
        // pressure change vs the previous fix at least 45 min older (same storm, any aircraft)
        if (v.min_slp_hpa != null) {
            for (var i = vs.length - 2; i >= 0; i--) {
                var p = vs[i], dh = (vms - Date.parse(_hdobX(p.t))) / 3600000;
                if (p.min_slp_hpa == null || dh < 0.75) continue;
                var dp = v.min_slp_hpa - p.min_slp_hpa;
                lines.push('<span class="recon-fix-trend' + (dp < 0 ? ' is-fall' : dp > 0 ? ' is-rise' : '') + '">' +
                    (dp < 0 ? '\u25bc ' : dp > 0 ? '\u25b2 ' : '\u00b1') + Math.abs(dp) + ' mb</span> in ' +
                    (dh < 10 ? dh.toFixed(1) : Math.round(dh)) + ' h (' + String(_hdobX(p.t)).slice(11, 16) + 'Z ' + p.min_slp_hpa + ' mb)');
                break;
            }
        }
        var wind = v.max_fl_wind_kt != null ? 'Max FL ' + v.max_fl_wind_kt + ' kt' +
            (v.max_fl_wind_bearing != null && v.max_fl_wind_range_nm != null ? ' ' + v.max_fl_wind_bearing + '\u00b0/' + v.max_fl_wind_range_nm + ' n mi' : '') : '';
        var eye = ((v.eye_shape || '') + (v.eye_diam_nm != null ? ' ' + v.eye_diam_nm + ' n mi' : '')).trim();
        if (wind || eye) lines.push(esc(wind + (wind && eye ? ' \u00b7 ' : '') + (eye ? 'eye ' + eye.toLowerCase() : '')));
        // lowest extrapolated SLP flown since the fix: is it still deepening?
        var ex = null;
        (aircraft || []).forEach(function (ac) {
            (ac.track || []).forEach(function (o) {
                if (o.extrap_sfc_p_mb != null && Date.parse(_hdobX(o.t)) > vms && (!ex || o.extrap_sfc_p_mb < ex.v)) ex = { v: o.extrap_sfc_p_mb, t: o.t };
            });
        });
        if (ex) lines.push('Extrap SLP since fix: ' + Math.round(ex.v) + ' mb ' + String(_hdobX(ex.t)).slice(11, 16) + 'Z');
        var fresh = !_hdobArchive && (Date.now() - vms) < 45 * 60000;
        var sub = String(_hdobX(v.t)).slice(11, 16) + 'Z \u00b7 ' + esc(_hdobTailDisplay(v.aircraft)) +
            (v.ob_number != null ? ' OB ' + v.ob_number : '') +
            (v.flight_level_mb != null ? ' \u00b7 ' + v.flight_level_mb + ' mb fix' : '') +
            (fresh ? ' <span class="recon-fix-new">NEW</span>' : '') +
            lines.map(function (l) { return '<div class="recon-fix-line">' + l + '</div>'; }).join('');
        var tip = 'Center fix from the newest Vortex Data Message (VDM): the aircraft\'s measured center and central pressure. ' +
            'Extrapolated SLP between fixes is the aircraft\'s estimate from flight level.' +
            (v.raw_text ? '\n\n' + String(v.raw_text).trim() : '');
        return '<div class="recon-vdm-stat is-fix" title="' + esc(tip) + '">' +
            '<div class="recon-vdm-stat-val">' + (v.min_slp_hpa != null ? v.min_slp_hpa : '\u2014') +
            '<span class="recon-vdm-stat-unit">mb</span></div>' +
            '<div class="recon-vdm-stat-label">Center fix (VDM)</div>' +
            '<div class="recon-vdm-stat-sub">' + sub + '</div></div>';
    }

    /** Mission-extremes strip for the displayed sortie: max flight-level wind,
     *  min extrapolated SLP, max SEAR 10-m estimate — each with its time. */
    function _hdobBuildSummary() {
        var el = document.getElementById('recon-hdob-summary');
        if (!el) return;
        var aircraft = _hdobFilterAircraft((_hdobData && _hdobData.aircraft) || [], 'chart');
        var best = { fl: null, slp: null, sear: null, sfmr: null };
        aircraft.forEach(function (ac) {
            (ac.track || []).forEach(function (o) {
                var fl = (o.peak_fl_kt != null) ? o.peak_fl_kt : o.wspd_kt;
                if (fl != null && (!best.fl || fl > best.fl.v)) best.fl = { v: fl, t: o.t, tail: ac.tail };
                if (o.extrap_sfc_p_mb != null && (!best.slp || o.extrap_sfc_p_mb < best.slp.v)) best.slp = { v: o.extrap_sfc_p_mb, t: o.t, tail: ac.tail };
                if (o.sfmr_kt != null && (!best.sfmr || o.sfmr_kt > best.sfmr.v)) best.sfmr = { v: o.sfmr_kt, t: o.t, tail: ac.tail };
                if (o.sear_kt != null && (!best.sear || o.sear_kt > best.sear.v)) best.sear = { v: o.sear_kt, t: o.t, tail: ac.tail, prelim: o.sear_fix === 'hdob', az: o.sear_az, r: o.sear_r_km };
            });
        });
        // the pass-maximum record behind the SEAR tile carries the RMW range
        var searRange = '', searRangeLed = false;
        if (best.sear && _hdobData && _hdobData.sear && _hdobData.sear.passes) {
            var bt = String(best.sear.t).slice(0, 16);
            _hdobData.sear.passes.forEach(function (p) {
                if (_hdobTailEq(p.tail, best.sear.tail) && String(p.t).slice(0, 16) === bt) {
                    searRange = _hdobSearRange(p); searRangeLed = _hdobSearIsRangeLed(p);
                    if (searRangeLed) best.sear.valText = searRange.replace(' kt', '');
                }
            });
        }
        function tile(label, b, unit, cls, extra, tip) {
            if (!b) return '';
            var sub = String(b.t || '').slice(11, 16) + 'Z · ' + _hdobTailDisplay(b.tail) + (extra || '');
            return '<div class="recon-vdm-stat' + (cls ? ' ' + cls : '') + '"' +
                (tip ? ' title="' + tip + '"' : '') + '>' +
                '<div class="recon-vdm-stat-val"' + (b.valText ? ' style="font-size:.78em;letter-spacing:-.01em"' : '') + '>' + (b.valText || Math.round(b.v)) +
                '<span class="recon-vdm-stat-unit">' + unit + '</span>' +
                (b.bandText ? '<span class="recon-vdm-stat-band">' + b.bandText + '</span>' : '') + '</div>' +
                '<div class="recon-vdm-stat-label">' + label + '</div>' +
                '<div class="recon-vdm-stat-sub">' + sub + '</div></div>';
        }
        // 2026-09-05 (PI): Vmax is a maximum -- the tile shows the STRONGEST crossing of the last 3 h,
        // with the window's other crossings and the RMW range beside it so its credibility is explicit.
        var hd = _hdobData && _hdobData.sear && _hdobData.sear.headline;
        var hdCf = hd && hd.stale && hd.current_flight;   // newer flight, nothing scored yet (2026-09-29, Rachel)
        // The headline is the product's newest window, which may belong to a
        // previous flight (Polo 2026-09-22: yesterday's 66 kt over an enroute
        // plane). Only use it when its pass is among the flights on display.
        if (hd && hd.kt != null) {
            var scoped = _hdobSearPassesInScope(_hdobData.sear.passes);
            var hdIn = scoped.some(function (p) {
                return _hdobTailEq(p.tail, hd.tail) && String(p.t).slice(0, 16) === String(hd.t).slice(0, 16);
            });
            // The headline is another aircraft's (Isaias 2026-10-09: NOAA 43's flight picked, headline AF309's): build
            // the displayed flight's own headline from its FINAL crossings, by the product's rule (strongest within 3 h
            // of its newest final crossing), instead of dropping the tile while its crossings are listed above.
            if (!hdIn) hd = _hdobSearScopedHeadline(scoped);
        }
        // FINAL values only (2026-09-30): payloads that mark crossings final/pending never fall back to the per-ob
        // maximum (a preliminary number); older payloads keep the old fallback.
        var marksFinal = (_hdobData.sear && _hdobData.sear.passes || []).some(function (p) { return p.final !== undefined; });
        if (marksFinal) best.sear = null;
        var searTile = hd && hd.kt != null ? { v: hd.kt, t: hd.t, tail: hd.tail, prelim: hd.fix_source === 'hdob' } : best.sear;
        var searSub = '';
        if (hd && hd.kt != null) {
            if (hd.range_kt && hd.range_kt[0] != null && hd.range_kt[1] != null && Math.round(hd.range_kt[1]) - Math.round(hd.range_kt[0]) >= 2)
                searSub += ' · RMW range ' + Math.round(hd.range_kt[0]) + '–' + Math.round(hd.range_kt[1]);
            if (hd.others_kt && hd.others_kt.length)
                searSub += ' · other crossings ' + Math.round(hd.others_min_kt) + (hd.others_kt.length > 1 ? '–' + Math.round(hd.others_max_kt) : '') + ' kt';
            if (hd.fix_source === 'hdob') searSub += ' · pressure-minimum center';
        } else if (best.sear) {
            searSub = (best.sear.az != null && window._ReconKit && window._ReconKit.searWhere ? ' · ' + window._ReconKit.searWhere(best.sear.az, best.sear.r) : '') +
                      (searRangeLed ? ' · most likely ' + Math.round(best.sear.v) + ' kt' : (searRange ? ' · ' + searRange : '')) +
                      (best.sear.prelim ? ' · prelim fix' : '');
        }
        // The flight on display has no scored crossing (no center fix yet) while the headline is an earlier
        // flight's: say so instead of dropping the tile (2026-09-29, Rachel: 60-kt flight-level winds, no fix).
        var searTip = 'SEAR: experimental machine-learning estimate of the 10-m wind from the flight-level wind. Strongest crossing of the last 3 h; a single crossing carries about 7-10 kt of RMW uncertainty. Not an official product.';
        if (!searTile && hdCf && _hdobCfInScope(hdCf)) {
            searTile = { valText: 'pending', t: hdCf.last_ob, tail: hdCf.tail };
            searSub = ' · ' + (hdCf.n_fix ? 'no scored crossing yet' : 'awaiting a center fix');
            searTip = 'SEAR scores an eyewall crossing once the flight has a center fix (a VDM, a TDR radar center, or a pressure minimum with calm winds). ' +
                (hdCf.fl_max_kt != null ? 'This flight\'s 10-s flight-level maximum so far: ' + Math.round(hdCf.fl_max_kt) + ' kt. ' : '') +
                'The last SEAR estimate, ' + Math.round(_hdobData.sear.headline.kt) + ' kt, is from an earlier flight (' +
                String(_hdobData.sear.headline.t).slice(5, 16).replace('T', ' ') + 'Z). Not an official product.';
        }
        // PRELIMINARY crossings newer than the final headline: a range, clearly labeled, never the headline number
        var pend = (((_hdobData.sear || {}).headline || {}).pending || []).filter(function (q) {
            return _hdobSearPassesInScope([q]).length && !(_hdobArchive && Date.parse(q.t) > +_hdobArchive.cur);
        });
        var pq = pend.length ? pend[pend.length - 1] : null, prelimTile = false;
        if (pq) {
            var prg = _hdobSearPrelimRange(pq) || 'range pending';
            if (searTile && searTile.valText !== 'pending') {
                searSub += '<div class="recon-prelim-sub">PRELIMINARY ' + String(pq.t).slice(11, 16) + 'Z crossing: ' + prg +
                    ' \u00b7 ' + _hdobTdrEsc(pq.reason || '') + (pq.final_by ? ', final by ~' + String(pq.final_by).slice(11, 16) + 'Z' : '') + '</div>';
            } else {
                searTile = { valText: prg.replace(' kt', ''), t: pq.t, tail: pq.tail };
                searSub = ' · ' + _hdobTdrEsc(pq.reason || '') + (pq.final_by ? ', final by ~' + String(pq.final_by).slice(11, 16) + 'Z' : '');
                prelimTile = true;
            }
            searTip += ' PRELIMINARY crossings are shown as a range covering the unsettled center and RMW; a single value is published once ' +
                'the outbound leg is flown and the center is confirmed by a VDM or TDR radar fix (or an hour passes without one), and it never changes after that.';
        }
        // Sonde flag on the flight-level SEAR tile (2026-09-30): an eyewall sonde's 10-m wind beat SEAR at its
        // release by >= the threshold, i.e. a surface-heavy eyewall the flight-level estimate cannot see.
        var sflag = _hdobSondeFlag();
        if (sflag && searTile && searTile.valText !== 'pending') {
            // WL150 first, then the REDUCED 10-m value: the sonde's own 10-m wind is not what is shown (Michael, 09-30)
            searSub += '<span class="recon-sonde-flag"> \u00b7 \u26a0 ' + _hdobSondeLink(sflag.top, 'eyewall sonde ' + String(sflag.top.t).slice(11, 16) + 'Z') +
                ': WL150 ' + Math.round(sflag.top.wl150_kt) + ' kt \u2192 ~' + Math.round(sflag.top.sonde_10m_kt) + ' kt 10-m (reduced)</span>';
            searTip += ' ' + _hdobSondeFlagText(sflag).replace(/"/g, '&quot;');
        }
        // TDR leads (Michael, 2026-09-30): the analysis' own 500-m + 2-km winds instead of the flight-level wind,
        // so it sees the low-level eyewall directly and all the way around -- Polo 09-28 16:37Z read 99 kt in the NW
        // (0.5-1 km ~100 kt ring under a tilted vortex) vs 79-88 kt flight-level SEAR; Rachel 09-30 73 kt vs 65 kt,
        // eyewall sondes ~64-76 kt at 10 m.
        _hdobTdrEnsureMeta();
        var tdr = _hdobTdrSummaryBest(), tdrHtml = '';
        if (tdr) {
            var cov = tdr.a.coverage && tdr.a.coverage['r<60km'], tdrBand = _hdobTdrBand(tdr.a);
            if (tdrBand) tdr.bandText = _hdobTdrBandText(tdrBand);
            tdrHtml = tile('Max TDR SEAR 10-m (exp)', tdr, 'kt', 'is-sear is-tdrsear',
                (tdr.a.max_r_nm != null ? ' · ' + Math.round(tdr.a.max_r_nm) + ' n mi from center' : '') +
                (cov != null && cov < 0.3 ? ' · thin coverage' : ''),
                'TDR SEAR: experimental SEAR 10-m estimate from the P-3 tail-Doppler analysis (its 500-m and 2-km winds replace the flight-level wind). ' +
                'It sees the low-level eyewall directly and all around the storm, not only along the flight track, so it leads the flight-level SEAR when both exist; they differ most when the eyewall is surface-heavy or the vortex is tilted. ' +
                'Strongest analysis of the flight on display' + (cov != null ? ' (this one covers ' + Math.round(cov * 100) + '% of the area within 60 km)' : '') +
                (tdrBand ? '. Range in parentheses: ' + _hdobTdrEsc(tdrBand.note) : '') +
                '. Click to show it on the map. Verification against dropsondes: table below the map. Not an official product.');
        }
        var html = tile('Max FL wind', best.fl, 'kt') +
                   (_hdobCenterFixTile(aircraft) || tile('Min extrap SLP', best.slp, 'mb', 'is-accent', ' \u00b7 no VDM yet')) +
                   tile('Max SFMR', best.sfmr, 'kt') + tdrHtml +
                   tile(prelimTile ? 'PRELIMINARY FL SEAR 10-m (exp)' : (tdr ? 'Max FL SEAR 10-m (exp)' : 'Max SEAR 10-m (exp)'), searTile,
                        searTile && searTile.valText === 'pending' ? '' : 'kt',
                        'is-sear' + (tdr ? ' is-second' : '') + (prelimTile ? ' is-prelim' : '') + (sflag ? ' is-sondeflag' : ''), searSub,
                        searTip + ' Verification against dropsondes: table below the map.');
        el.innerHTML = html;
        el.style.display = html ? '' : 'none';
        _hdobWireSondeLinks(el);
        var tdrEl = tdr && el.querySelector('.is-tdrsear');
        if (tdrEl) tdrEl.onclick = function () {
            _hdobTdrSel = tdr.a.file; _hdobLayerVis.tdr = true;
            _ga('recon_hdob_tdr_tile', {});
            _hdobRender();
        };
    }

    function _hdobBuildSourceNote() {
        var el = document.getElementById('recon-hdob-srcnote');
        if (!el) return;
        var t = _hdobSourceText(), items = _hdobSearItems();
        el.textContent = '';
        var ul = document.createElement('ul'); ul.className = 'recon-srcnote-list';
        function li(it, parent) {
            var e = document.createElement('li'); if (it.cls) e.className = it.cls;
            e.appendChild(document.createTextNode(it.text));
            if (it.sonde) {   // the sonde the flag names opens its profile
                var a = document.createElement('a'); a.href = '#'; a.className = 'recon-sonde-link';
                a.setAttribute('data-t', it.sonde.t); a.setAttribute('data-tail', it.sonde.tail);
                a.textContent = 'Open the ' + String(it.sonde.t).slice(11, 16) + 'Z sonde \u2197';
                e.appendChild(document.createTextNode(' ')); e.appendChild(a);
            }
            if (it.sub && it.sub.length) {
                var u2 = document.createElement('ul');
                it.sub.forEach(function (x) { li(x, u2); });
                e.appendChild(u2);
            }
            parent.appendChild(e);
        }
        if (t) li({ text: t }, ul);
        items.forEach(function (it) { li(it, ul); });
        if (_hdobSatNote) li({ text: _hdobSatNote }, ul);
        el.appendChild(ul);
        _hdobWireSondeLinks(el);
        el.style.display = ul.children.length ? '' : 'none';
        _hdobBuildVerif();
    }

    /** NOAA flight-level wind resolution toggle [10-s mean | 1-s]. Shown only when
     *  a NOAA (IWG1) flight is present; switching re-fetches at the new resolution. */
    function _hdobBuildResToggle() {
        var box = document.getElementById('recon-hdob-restoggle');
        if (!box) return;
        var hasNOAA = ((_hdobData && _hdobData.aircraft) || []).some(function (a) { return a.src === 'iwg1'; });
        if (!hasNOAA) { box.innerHTML = ''; box.style.display = 'none'; return; }
        box.style.display = '';
        box.innerHTML = '<span class="recon-hdob-flightlabel">NOAA FL wind</span>';
        [{ r: 10, label: '10-s mean', on: !_hdobFl1s }, { r: 1, label: '1-s', on: _hdobFl1s }].forEach(function (o) {
            var b = document.createElement('button');
            b.textContent = o.label;
            b.className = o.on ? 'on' : '';
            b.title = o.r === 10 ? 'Operational 10-second mean flight-level wind' : 'Full 1-second flight-level wind';
            b.onclick = function () { window._reconHdobSetRes(o.r); };
            box.appendChild(b);
        });
    }

    window._reconHdobSetRes = function (res) {
        var want = (res === 1);
        if (want === _hdobFl1s) return;
        _hdobFl1s = want;
        _hdobBuildResToggle();
        _ga('recon_hdob_flres', { res: res });
        // Repaint from the cached payload for this resolution if we already have
        // one (the common back-and-forth case) so the flip is immediate, then
        // refresh in the background. Cold first flip still waits on the fetch.
        var cached = _hdobResCache[want ? '1' : '10'];
        if (cached) { _hdobData = cached; _hdobRender(); }
        _hdobFetch();   // freshen at the new resolution (repaints when it lands)
    };

    window._reconHdobToggleGrid = function () {
        var kit = window._ReconKit;
        if (!kit || !kit.graticule || !_hdobMap) return;
        if (!_hdobGrid) _hdobGrid = kit.graticule(_hdobMap);
        var btn = document.getElementById('recon-hdob-grid');
        if (_hdobGrid.isOn()) { _hdobGrid.disable(); if (btn) btn.classList.remove('active'); }
        else { _hdobGrid.enable(); if (btn) btn.classList.add('active'); }
        _ga('recon_hdob_grid', { on: _hdobGrid.isOn() });
    };

    /** Composite the time-series chart + recon map into one watermarked PNG,
     *  exactly as they're currently shown (flight selection, vars, barb color,
     *  satellite, grid all reflected since we capture the live DOM). */
    window._reconHdobExport = function () {
        var kit = window._ReconKit;
        var chartEl = document.getElementById('recon-hdob-chart');
        var mapEl = document.getElementById('recon-hdob-map');
        if (!kit || !window.Plotly || !chartEl || !mapEl || !_hdobData) return;
        var btn = document.getElementById('recon-hdob-save');
        var orig = btn ? btn.textContent : '';
        if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
        var scale = 2;
        var cr = chartEl.getBoundingClientRect();
        // Render the chart at the MAP's height (it's usually the taller panel):
        // Plotly re-lays-out at the requested size, so the subplots stretch to
        // fill and the composite has no dead paper under the chart column.
        var mr = mapEl.getBoundingClientRect();
        // A chart whose container reports no size (mid-layout, hidden pane)
        // still has Plotly's own layout size to render at.
        var fl = chartEl._fullLayout || {};
        var chartW = Math.round(cr.width || fl.width || 700);
        var chartH = Math.round(Math.max(cr.height || fl.height || 540, mr.height || 0));
        // PNG first; Safari's SVG->canvas step inside toImage can throw a
        // SecurityError ("The operation is insecure") on some charts, and a
        // base64 SVG data URL drawn to canvas is the path that survives there
        // (see the genesis composite fix, commit 541f2775).
        // Promise-wrapped: toImage throws SYNCHRONOUSLY on a chart with no
        // layout size yet ("Height and width should be pixel values").
        var chartP = Promise.resolve().then(function () {
                if (!(chartW > 0) || !(chartH > 0)) throw new Error('chart has no size yet');
                return window.Plotly.toImage(chartEl, { format: 'png', width: chartW, height: chartH, scale: scale });
            })
            .catch(function () {
                return window.Plotly.toImage(chartEl, { format: 'svg', width: chartW * scale, height: chartH * scale })
                    .then(function (u) {
                        var svg = decodeURIComponent(u.replace(/^data:image\/svg\+xml[^,]*,/, ''));
                        return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
                    });
            });
        // Map capture, storm-card pattern (see _irDownloadCurrentFrame): read the
        // GL canvas directly, then html2canvas the DOM overlays (barb canvas,
        // markers, legend) with the GL canvas SKIPPED and the container's own
        // background zeroed. Handing html2canvas the whole element, WebGL canvas
        // included, produced "The operation is insecure" on iOS Safari
        // (2026-09-02) — a tainted-canvas SecurityError at readback. Each stage
        // is labeled so the alert names the step that failed.
        function stage(name, p) {
            return Promise.resolve(p).catch(function (e) {
                var err = new Error((e && e.message ? e.message : String(e)) + ' [' + name + ']');
                err.stage = name; throw err;
            });
        }
        var glMap = _hdobMap && _hdobMap._gl;
        // Map stages degrade instead of aborting: a failed readback saves
        // without the satellite, a failed overlay saves the satellite alone.
        var dropped = [];
        function soft(name, p) {
            return stage(name, p).catch(function (e) {
                console.warn('[Recon] export stage failed, continuing without it:', e && e.message);
                dropped.push(name); return null;
            });
        }
        var snapP = soft('map readback', glMap && kit.glSnapshot ? kit.glSnapshot(glMap) : Promise.resolve(null));
        // The science content — flight path + barbs (the 2-D recon canvas) and
        // the aircraft / sonde / VDM icons — is painted DIRECTLY from the live
        // DOM with the 2-D API, never through html2canvas. A user's save
        // (2026-09-04, Lowell) came back with the satellite but none of the
        // overlay: html2canvas had failed or returned blank in that browser, and
        // everything that mattered rode on it. Now html2canvas only carries the
        // residual chrome (legend key, zoom control), and losing it costs nothing.
        var directP = soft('map layers', Promise.resolve().then(function () { return _hdobDrawMapLayersDirect(mapEl, scale); }));
        var _DIRECT_ICON_RE = /(^|\s)(recon-hdob-aircraft|rt-recon-sonde-icon|rt-recon-vdm-icon)(\s|$)/;
        var overlayP = soft('map overlay', kit.ensureHtml2canvas().then(function () {
            return window.html2canvas(mapEl, {
                useCORS: true, allowTaint: false, backgroundColor: null, logging: false, scale: scale,
                ignoreElements: function (el) {
                    var cls = (typeof el.className === 'string') ? el.className : '';
                    if (el.tagName === 'CANVAS' && /maplibregl-canvas|leaflet-recon-canvas/.test(cls)) return true;
                    return _DIRECT_ICON_RE.test(cls);   // painted by the direct pass
                },
                onclone: function (doc) {
                    var m = doc.getElementById('recon-hdob-map');
                    if (m) m.style.background = 'transparent';
                }
            });
        }));
        var mapP = Promise.all([snapP, overlayP, directP]).then(function (r) {
            var snap = r[0], overlay = r[1], direct = r[2];
            var W = (overlay && overlay.width) || (snap && snap.width) || Math.round(mr.width * scale) || 600;
            var H = (overlay && overlay.height) || (snap && snap.height) || Math.round(mr.height * scale) || 600;
            var comp = document.createElement('canvas');
            comp.width = W; comp.height = H;
            var cx = comp.getContext('2d');
            cx.fillStyle = '#0a0c12'; cx.fillRect(0, 0, W, H);
            if (snap && !snap.__glBlank) {
                try { cx.drawImage(snap, 0, 0, snap.width, snap.height, 0, 0, W, H); }
                catch (e) { console.warn('[Recon] GL composite failed:', e); }
            } else if (typeof rtToast === 'function') {
                rtToast('Saved without the satellite layer — the browser couldn’t read the map canvas.', 'warn');
            }
            if (direct && direct.width && direct.height) { try { cx.drawImage(direct, 0, 0, direct.width, direct.height, 0, 0, W, H); } catch (e) {} }
            if (overlay && overlay.width && overlay.height) { try { cx.drawImage(overlay, 0, 0); } catch (e) {} }
            // Prove the composite is still readable (a tainted overlay would
            // poison every later toBlob); if not, fall back to the raw snapshot.
            try { cx.getImageData(0, 0, 1, 1); }
            catch (e) {
                dropped.push('map overlay (tainted)');
                var c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
                var x2 = c2.getContext('2d'); x2.fillStyle = '#0a0c12'; x2.fillRect(0, 0, W, H);
                if (snap && !snap.__glBlank) { try { x2.drawImage(snap, 0, 0, snap.width, snap.height, 0, 0, W, H); } catch (e2) {} }
                return c2;
            }
            return comp;
        });
        // Wait on the brand logo too, so a cold cache can't drop it from the save.
        var logoP = kit.watermarkReady ? kit.watermarkReady() : Promise.resolve();
        Promise.all([stage('chart', chartP), mapP, logoP]).then(function (res) {
            return stage('chart decode', new Promise(function (resolve, reject) {
                var cimg = new Image();
                cimg.onload = function () { resolve({ chart: cimg, map: res[1] }); };
                cimg.onerror = reject;
                cimg.src = res[0];
            }));
        }).then(function (o) {
            try { _hdobComposite(o.chart, o.map, scale); }
            catch (e) {   // DOMException.message is read-only: wrap, don't mutate
                var ce = new Error((e && e.message ? e.message : String(e)) + ' [composite]'); ce.stage = 'composite'; throw ce;
            }
            _ga('recon_hdob_export', { ok: true, id: _hdobMissionTail || _hdobAtcf, dropped: dropped.join(',') });
            if (dropped.length && typeof rtToast === 'function') {
                rtToast('Saved without: ' + dropped.join(', ') + ' (browser blocked that layer).', 'warn');
            }
            if (btn) { btn.textContent = orig; btn.disabled = false; }
        }).catch(function (err) {
            console.error('[Recon] composite export failed', err);
            _ga('recon_hdob_export', { ok: false, msg: String(err && err.message) });
            alert('Could not save image: ' + (err && err.message ? err.message : err));
            if (btn) { btn.textContent = orig; btn.disabled = false; }
        });
    };

    /** Paint the recon map's own layers straight from the live DOM at `scale`×:
     *  the 2-D recon canvas (flight path + barbs + track dots) and the
     *  aircraft / dropsonde / VDM divIcon markers, each redrawn with the 2-D
     *  API from the same geometry the icon HTML uses. Same-origin canvases and
     *  vector paths only, so the result can never taint. Returns a canvas
     *  sized to the map element (transparent where nothing is drawn). */
    function _hdobDrawMapLayersDirect(mapEl, scale) {
        var mr = mapEl.getBoundingClientRect();
        if (!(mr.width > 0) || !(mr.height > 0)) return null;
        var W = Math.round(mr.width * scale), H = Math.round(mr.height * scale);
        var c = document.createElement('canvas'); c.width = W; c.height = H;
        var ctx = c.getContext('2d');
        ctx.scale(scale, scale);
        function rel(el) { var r = el.getBoundingClientRect(); return { x: r.left - mr.left, y: r.top - mr.top, w: r.width, h: r.height }; }
        // 1. The barb/track canvas, at its on-screen offset (it is positioned
        //    with a translate via L.DomUtil.setPosition).
        var rc = mapEl.querySelector('canvas.leaflet-recon-canvas');
        if (rc && rc.width && rc.height) {
            var rr = rel(rc);
            try { ctx.drawImage(rc, rr.x, rr.y, rr.w || rc.width, rr.h || rc.height); } catch (e) { console.warn('[Recon] direct barb draw failed:', e); }
        }
        // 2. Marker icons — selected by the divIcon classes, not
        //    .leaflet-marker-icon: the GL facade hands the icon element to a
        //    maplibregl.Marker (anchor: center) and never adds Leaflet's class.
        var icons = mapEl.querySelectorAll('.recon-hdob-aircraft, .rt-recon-sonde-icon, .rt-recon-vdm-icon');
        var PLANE = 'M12 2 L14.2 10 L22 13.5 L22 15.5 L14.2 13.5 L13.4 19 L16 21 L16 22.3 L12 21.2 L8 22.3 L8 21 L10.6 19 L9.8 13.5 L2 15.5 L2 13.5 L9.8 10 Z';
        for (var i = 0; i < icons.length; i++) {
            var el = icons[i];
            var cls = (typeof el.className === 'string') ? el.className : '';
            var cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
            var r = rel(el);
            if (!(r.w > 0) || r.x + r.w < 0 || r.y + r.h < 0 || r.x > mr.width || r.y > mr.height) continue;
            var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
            ctx.save();
            if (/recon-hdob-aircraft/.test(cls)) {
                var mrot = /rotate\((-?[\d.]+)/.exec(el.innerHTML || ''), hdg = mrot ? parseFloat(mrot[1]) : 0;
                ctx.translate(cx, cy); ctx.rotate(hdg * Math.PI / 180);
                var k = 26 / 24; ctx.scale(k, k); ctx.translate(-12, -12);
                ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 1.5;
                var path = (typeof Path2D === 'function') ? new Path2D(PLANE) : null;
                if (path) {
                    ctx.fillStyle = '#fde047'; ctx.fill(path);
                    ctx.shadowBlur = 0; ctx.lineWidth = 0.7; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1f2937'; ctx.stroke(path);
                } else { ctx.fillStyle = '#fde047'; ctx.beginPath(); ctx.arc(12, 12, 6, 0, Math.PI * 2); ctx.fill(); }
            } else if (/rt-recon-sonde-icon/.test(cls)) {
                ctx.translate(cx, cy); ctx.rotate(Math.PI / 4);
                ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 3;
                ctx.fillStyle = '#fbbf24'; ctx.fillRect(-5.5, -5.5, 11, 11);
                ctx.shadowBlur = 0; ctx.lineWidth = 1.5; ctx.strokeStyle = '#1f2937'; ctx.strokeRect(-5.5, -5.5, 11, 11);
            } else if (/rt-recon-vdm-icon/.test(cls)) {
                // mirrors the badge in _reconBuildMarkers (realtime_ir.js): white fill, red ring, crosshair, label
                var vr = r.w / 2 * 0.85, inner = el.firstElementChild;
                if (inner && inner.style.opacity) ctx.globalAlpha = parseFloat(inner.style.opacity) || 1;
                ctx.beginPath(); ctx.arc(cx, cy, vr, 0, Math.PI * 2);
                ctx.fillStyle = '#fff'; ctx.fill();
                ctx.lineWidth = r.w * 0.175; ctx.strokeStyle = '#111827'; ctx.stroke();
                ctx.lineWidth = r.w * 0.11; ctx.strokeStyle = '#ef4444'; ctx.stroke();
                ctx.beginPath(); ctx.moveTo(cx, cy - r.w * 0.325); ctx.lineTo(cx, cy + r.w * 0.325);
                ctx.moveTo(cx - r.w * 0.325, cy); ctx.lineTo(cx + r.w * 0.325, cy);
                ctx.lineWidth = r.w * 0.09; ctx.strokeStyle = '#b91c1c'; ctx.stroke();
                var vlab = inner && inner.getAttribute('data-vlab');
                if (vlab) {
                    ctx.globalAlpha = 1;
                    ctx.font = '700 11px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
                    var tw = ctx.measureText(vlab).width, lx = cx + r.w / 2 + 3;
                    ctx.fillStyle = 'rgba(185,28,28,0.92)'; ctx.fillRect(lx, cy - 7.5, tw + 10, 15);
                    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(17,24,39,0.6)'; ctx.strokeRect(lx, cy - 7.5, tw + 10, 15);
                    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                    ctx.fillText(vlab, lx + 5, cy + 0.5);
                }
            }
            ctx.restore();
        }
        return c;
    }

    /** Lay chart (left) + map (right) onto a canvas with a header + TC-ATLAS
     *  watermark, theme-matched, and trigger the download. Inputs are already
     *  at `scale`× device pixels. */
    function _hdobComposite(chartImg, mapCanvas, scale) {
        // Match the chart chrome's theme EXACTLY by reading the same CSS tokens the
        // Plotly layout uses. The chart paper renders transparent, so it adopts
        // whatever bg we paint here — and keying off the data-theme ATTRIBUTE was
        // wrong: light is the default with NO attribute, so `!== 'light'` misread
        // light mode as dark and put a light-theme chart on a dark panel.
        var _rs = getComputedStyle(document.documentElement);
        function _rv(n, f) { return (_rs.getPropertyValue(n) || '').trim() || f; }
        var bg = _rv('--plot-paper', '#ffffff');
        var fg = _rv('--plot-text', '#0f1623');
        var sub = _rv('--plot-axis', '#64748b');
        var pad = 14 * scale, gap = 12 * scale, headH = 60 * scale;
        var cw = chartImg.width, chh = chartImg.height;
        var mw = mapCanvas.width, mh = mapCanvas.height;
        var contentH = Math.max(chh, mh);
        var W = pad + cw + gap + mw + pad;
        // Footer band sized for the shared brand watermark (it lays out off canvas
        // WIDTH: ~12px pad + 28px logo at s = W/900). Giving it its own strip keeps
        // the logo + URL on clean paper instead of over the satellite imagery,
        // where the translucent brand colours would wash out.
        var _s = Math.max(1, W / 900);
        var footH = Math.round(46 * _s);
        var H = headH + contentH + footH;
        var cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        var ctx = cv.getContext('2d');
        ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
        // Header: title + subtitle (storm/flight + generated time).
        var name = _hdobMissionTail ? (_hdobName || _hdobMissionTail) : (_hdobName || _hdobAtcf || '');
        name = _hdobTailDisplay(name);   // NOAA3 -> NOAA 43 when the title is a bare tail
        var c = (_hdobData && _hdobData.counts) || {};
        var when = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
        ctx.textBaseline = 'middle';
        ctx.fillStyle = fg; ctx.font = 'bold ' + (17 * scale) + 'px sans-serif';
        ctx.fillText('Live Flight Recon — ' + name, pad, headH * 0.26);
        ctx.fillStyle = sub; ctx.font = (11 * scale) + 'px sans-serif';
        ctx.fillText((c.obs || 0) + ' obs · ' + (c.dropsondes || 0) + ' sondes · ' +
            (c.vdms || 0) + ' VDM   ·   generated ' + when, pad, headH * 0.52);
        // Provenance line so the saved figure never overstates the wind cadence.
        var srcTxt = _hdobSourceText();
        if (srcTxt) {
            ctx.font = (10 * scale) + 'px sans-serif';
            ctx.fillText(srcTxt, pad, headH * 0.80);
        }
        // Panels (top-aligned under the header).
        ctx.drawImage(chartImg, pad, headH, cw, chh);
        ctx.drawImage(mapCanvas, pad + cw + gap, headH, mw, mh);
        // Brand watermark — logo + TC-ATLAS + tcatlas.org — in the footer band,
        // via the shared helper so this save matches every other figure export.
        var _kit = window._ReconKit;
        if (_kit && _kit.watermark) _kit.watermark(ctx, W, H);
        // Source attribution, bottom-left of the same band.
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.font = (10 * scale) + 'px sans-serif';
        ctx.fillStyle = sub;
        ctx.fillText('Aircraft recon: NOAA AOC / USAF 53rd WRS · NHC', pad, H - Math.round(14 * _s));
        cv.toBlob(function (blob) {
            if (!blob) { alert('Image export produced no data (CORS taint?)'); return; }
            var ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
            var safe = String(name).replace(/[^0-9A-Za-z]+/g, '_').replace(/^_|_$/g, '') || 'recon';
            TCExport.save(blob, 'TC-ATLAS_LiveFlight_' + safe + '_' + ts + '.png');
        }, 'image/png');
    }

    function _hdobBuildToggles() {
        var box = document.getElementById('recon-hdob-vartoggles');
        if (!box) return;
        var items = _HDOB_VARS.concat([{ key: 'vdm', name: 'VDM SLP', color: '#ef4444' }]);
        box.innerHTML = '';
        items.forEach(function (cfg) {
            var b = document.createElement('button');
            b.textContent = (cfg.key === 'wspd_kt') ? _hdobFLWindLabel() : cfg.name;
            if (cfg.tip) b.title = cfg.tip;
            var on = !!_hdobVarVis[cfg.key];
            b.className = on ? 'on' : '';
            if (on) b.style.background = cfg.color;
            b.onclick = function () {
                _hdobVarVis[cfg.key] = !_hdobVarVis[cfg.key];
                _hdobBuildToggles();
                _hdobRenderChart();
            };
            box.appendChild(b);
        });
    }

    /** Flat, time-parsed ob list for chart-click hit-testing. Built on demand from
     *  the last rendered aircraft set (see _hdobRenderChart) so a 1-s repaint
     *  doesn't pay for it, and memoised until the next render. */
    function _hdobEnsureFlatObs() {
        if (_hdobFlatObs) return _hdobFlatObs;
        var flat = [];
        (_hdobFlatSrc || []).forEach(function (ac) {
            (ac.track || []).forEach(function (o) {
                flat.push({ _ms: Date.parse(_hdobX(o.t)), lat: o.lat, lon: o.lon });
            });
        });
        _hdobFlatObs = flat;
        return flat;
    }

    function _hdobOnChartClick(d) {
        if (!d || !d.points || !d.points.length || !_hdobMap) return;
        _ga('recon_hdob_chart_click', {});
        var tms = (new Date(d.points[0].x)).getTime();
        if (isNaN(tms)) return;
        var best = null, bd = Infinity;
        var _flatObs = _hdobEnsureFlatObs();
        for (var i = 0; i < _flatObs.length; i++) {
            var o = _flatObs[i];
            if (o.lat == null) continue;
            var dt = Math.abs(o._ms - tms);
            if (dt < bd) { bd = dt; best = o; }
        }
        if (best) {
            if (_hdobHighlight) { try { _hdobMap.removeLayer(_hdobHighlight); } catch (e) {} }
            _hdobHighlight = L.circleMarker([best.lat, best.lon],
                { radius: 8, color: '#60a5fa', weight: 3, fillColor: '#fff', fillOpacity: 0.9 }).addTo(_hdobMap);
            _hdobMap.panTo([best.lat, best.lon]);
        }
    }

    var _hdobChartWaiting = false;
    function _hdobRenderChart() {
        var el = document.getElementById('recon-hdob-chart');
        if (!el || !_hdobData) return;
        // Plotly is injected async (realtime_ir.html); a deep-linked #recon-hdob can get its data
        // first, and the chart then stayed blank until the next repaint (Michael, 2026-09-28).
        if (!window.Plotly) {
            if (!_hdobChartWaiting) {
                _hdobChartWaiting = true;
                window.addEventListener('plotly-ready', function () { _hdobChartWaiting = false; _hdobRenderChart(); }, { once: true });
            }
            return;
        }
        // Chart shows one flight at a time (the selected one, or the freshest
        // when none is picked) so overlapping profile traces stay legible.
        var aircraft = _hdobFilterAircraft(_hdobData.aircraft || [], 'chart');
        // The time axis is identical for every variable on a given aircraft, so
        // build it ONCE per aircraft rather than once per (aircraft × variable).
        // At 1 Hz a track is ~57k obs and there are ~5 variables on by default,
        // so this drops ~230k redundant timestamp-normalisation calls per repaint.
        var xsByAc = aircraft.map(function (ac) {
            var tr = ac.track || [], xs = new Array(tr.length);
            for (var i = 0; i < tr.length; i++) xs[i] = _hdobX(tr[i].t);
            return xs;
        });
        var traces = [];
        _HDOB_VARS.forEach(function (cfg) {
            if (!_hdobVarVis[cfg.key]) return;
            var firstForVar = true;
            aircraft.forEach(function (ac, acIdx) {
                var tr = ac.track || [];
                if (!tr.length) return;
                // x is shared by every variable on this aircraft — built once above.
                var xs = xsByAc[acIdx], ys = new Array(tr.length);
                for (var i = 0; i < tr.length; i++) {
                    var v = tr[i][cfg.key];
                    ys[i] = (v == null) ? null : (cfg.scale ? v * cfg.scale : v);
                }
                var trace = {
                    x: xs, y: ys, type: 'scatter', mode: 'lines',
                    name: (cfg.key === 'wspd_kt') ? _hdobFLWindLabel() : cfg.name,
                    legendgroup: cfg.key, showlegend: firstForVar,
                    line: { color: cfg.color, width: 1.4, dash: cfg.dash || 'solid' },
                    connectgaps: false, yaxis: cfg.axis,
                    hovertemplate: '%{x|%H:%M:%SZ} · %{y' + (cfg.scale ? ':.2f' : '') + '} ' + cfg.unit + ' · ' + _hdobTailDisplay(ac.tail) + '<extra></extra>'
                };
                // SEAR: say where in the storm each estimate was made (quadrant,
                // radius from the pass center) — the number alone is ambiguous.
                if (cfg.key === 'sear_kt' && window._ReconKit && window._ReconKit.searWhere) {
                    var cd = new Array(tr.length), anyGeo = false;
                    for (var g = 0; g < tr.length; g++) {
                        var w = (tr[g].sear_az != null) ? window._ReconKit.searWhere(tr[g].sear_az, tr[g].sear_r_km) : '';
                        if (w) anyGeo = true;
                        // A 10-s ob carries the max 1-s SEAR in its bin (_rtSearAttach);
                        // name the second it came from when that isn't the ob's own stamp.
                        var st = tr[g].sear_t;
                        cd[g] = (st && st !== tr[g].t ? ' (at ' + String(st).slice(11, 19) + 'Z)' : '') + (w ? ' · ' + w : '');
                    }
                    // Whole knots, like the Max SEAR tile, so the two read identically.
                    trace.customdata = cd;
                    trace.hovertemplate = '%{x|%H:%M:%SZ} · %{y:.0f} kt%{customdata} · ' + _hdobTailDisplay(ac.tail) + '<extra></extra>';
                }
                traces.push(trace);
                firstForVar = false;
            });
        });
        // Chart-click hit-testing needs a flat, time-parsed ob list — but building
        // it eagerly cost ~57k Date.parse calls + allocations on EVERY 1-s repaint
        // for a feature only used on click. Defer it: remember the source and let
        // _hdobOnChartClick materialise it on first use.
        _hdobFlatObs = null;
        _hdobFlatSrc = aircraft;
        // Window the auxiliary layers (VDM/sonde) to the DISPLAYED sortie so an
        // earlier flight's fixes don't drop diamonds on the current chart or
        // stretch the time axis across the on-ground gap. When the sortie has no
        // HDOB yet (sonde/VDM-only early in a mission) the window is unbounded so
        // those still frame the axis, exactly as before.
        // Tracks are time-ordered, so the first/last ob bound each one — O(1) per
        // aircraft instead of parsing every timestamp.
        var _obsLo = Infinity, _obsHi = -Infinity;
        aircraft.forEach(function (ac) {
            var tr = ac.track || [];
            if (!tr.length) return;
            var a = Date.parse(_hdobX(tr[0].t)), z = Date.parse(_hdobX(tr[tr.length - 1].t));
            if (!isNaN(a) && a < _obsLo) _obsLo = a;
            if (!isNaN(z) && z > _obsHi) _obsHi = z;
        });
        var _hasObs = isFinite(_obsLo) && isFinite(_obsHi);
        var _winPad = 2 * 3600 * 1000;   // 2 h — catches a VDM/sonde just after the last HDOB
        var _winMin = _hasObs ? _obsLo - _winPad : -Infinity;
        var _winMax = _hasObs ? _obsHi + _winPad : Infinity;
        function _inWin(ms) { return !isNaN(ms) && ms >= _winMin && ms <= _winMax; }
        var vdms = _hdobData.vdms || [];
        if (_hdobVarVis.vdm && vdms.length) {
            var vx = [], vy = [], vt = [];
            vdms.forEach(function (v) {
                if (v.min_slp_hpa != null && v.t && _inWin(Date.parse(_hdobX(v.t)))) {
                    vx.push(_hdobX(v.t)); vy.push(v.min_slp_hpa);
                    vt.push('VDM ' + (v.aircraft || '') + (v.ob_number != null ? ' OB ' + v.ob_number : '') +
                        '<br>' + v.min_slp_hpa + ' mb');
                }
            });
            if (vx.length) {
                traces.push({
                    x: vx, y: vy, type: 'scatter', mode: 'markers', name: 'VDM SLP', legendgroup: 'vdm',
                    marker: { symbol: 'diamond', size: 11, color: '#ef4444', line: { color: '#fff', width: 1.5 } },
                    // y5 = the Extrap SLP axis on the wind panel. It sat on y2 (flight-level
                    // pressure, ~400-850 mb, reversed), so every ~1000-mb fix fell off the panel.
                    yaxis: 'y5', text: vt, hovertemplate: '%{text}<extra></extra>'
                });
            }
        }
        // Explicit time range from the displayed sortie's obs + its in-window VDM/
        // sonde times, so the chart never falls back to Plotly's year-2000 default
        // when there are no flight-level traces yet (e.g. sondes-only early in a
        // mission) yet also never spans an earlier sortie's fixes.
        var _allMs = _hasObs ? [_obsLo, _obsHi] : [];   // min/max of the obs, exactly
        (_hdobData.vdms || []).forEach(function (v) { var t = Date.parse(_hdobX(v.t)); if (_inWin(t)) _allMs.push(t); });
        (_hdobData.dropsondes || []).forEach(function (d) { var t = Date.parse(_hdobX(d.t)); if (_inWin(t)) _allMs.push(t); });
        var _xrange;
        if (_allMs.length) {
            var _mn = Math.min.apply(null, _allMs), _mx = Math.max.apply(null, _allMs);
            var _pad = Math.max(15 * 60 * 1000, (_mx - _mn) * 0.04);
            _xrange = [new Date(_mn - _pad).toISOString(), new Date(_mx + _pad).toISOString()];
        }
        var dark = document.documentElement.getAttribute('data-theme') !== 'light';
        var grid = dark ? 'rgba(148,163,184,0.15)' : 'rgba(100,116,139,0.15)';
        var fg = dark ? '#8b9ec2' : '#374151';
        // Legend sits ABOVE the plot, anchored at its bottom edge, with the top
        // margin sized for however many rows it wraps to (three on a phone):
        // top-anchored at y=1.06 it grew DOWN over the wind panel on mobile.
        var legendRows = Math.max(1, Math.ceil((traces.length * 118) / Math.max(240, el.clientWidth || 600)));
        var layout = {
            autosize: true, margin: { l: 52, r: 50, t: 8 + legendRows * 18, b: 34 }, showlegend: true,
            legend: { orientation: 'h', y: 1.0, yanchor: 'bottom', x: 0, xanchor: 'left',
                      font: { size: 10, color: fg } },
            paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', hovermode: 'closest',
            xaxis: { type: 'date', range: _xrange, gridcolor: grid, tickfont: { size: 10, color: fg }, domain: [0, 1],
                     showspikes: true, spikemode: 'across', spikedash: 'dash', spikethickness: 1,
                     spikecolor: dark ? '#94a3b8' : '#64748b' },
            yaxis: { title: { text: 'Wind (kt)', font: { size: 11, color: fg } }, domain: [0.56, 1.0], gridcolor: grid, tickfont: { size: 10, color: fg }, zeroline: false },
            // Extrap SLP as a twin axis on the WIND panel (right, autoranged, NOT
            // reversed) so its ~10 mb eye signal reads against the wind peaks
            // without squishing — and the eye's low pressure dips DOWN on the axis.
            yaxis5: { title: { text: 'Extrap SLP (mb)', font: { size: 11, color: '#e879f9' } }, overlaying: 'y', side: 'right', showgrid: false, tickfont: { size: 10, color: '#e879f9' }, autorange: true, zeroline: false },
            yaxis2: { title: { text: 'FL Pres (mb)', font: { size: 11, color: fg } }, domain: [0.30, 0.52], gridcolor: grid, tickfont: { size: 10, color: fg }, autorange: 'reversed', zeroline: false },
            yaxis4: { title: { text: 'Alt (km)', font: { size: 11, color: '#94a3b8' } }, overlaying: 'y2', side: 'right', showgrid: false, tickfont: { size: 10, color: '#94a3b8' }, zeroline: false },
            yaxis3: { title: { text: 'Temp (°C)', font: { size: 11, color: fg } }, domain: [0, 0.24], gridcolor: grid, tickfont: { size: 10, color: fg }, zeroline: false }
        };
        window.Plotly.react(el, traces, layout, { responsive: true, displayModeBar: false }).then(function () {
            if (!_hdobChartBound) { try { el.on('plotly_click', _hdobOnChartClick); _hdobChartBound = true; } catch (e) {} }
        });
    }

    // ── Recon · Missions dashboard ───────────────────────────────
    // A browsable card grid built from the same /missions list that
    // feeds the TDR dropdown. Clicking a card opens it in the TDR tab.
    var _reconMissionsDashLoaded = false;
    var _reconMissionsList = null;
    var _reconPendingMission = null;
    var _RECON_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                         'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function _reconParseMission(id) {
        var m = id.match(/^(\d{8})(.+)$/) || id.match(/^(\d{6})(.+)$/);
        if (!m) return { id: id, suffix: id, dateISO: null };
        var digits = m[1], suffix = m[2], y, mo, d;
        if (digits.length === 8) {
            y = digits.slice(0, 4); mo = digits.slice(4, 6); d = digits.slice(6, 8);
        } else {
            y = '20' + digits.slice(0, 2); mo = digits.slice(2, 4); d = digits.slice(4, 6);
        }
        return { id: id, suffix: suffix, year: +y, month: +mo, day: +d, dateISO: y + '-' + mo + '-' + d };
    }

    function _reconRelDays(dateISO) {
        if (!dateISO) return '';
        var p = dateISO.split('-');
        var then = Date.UTC(+p[0], +p[1] - 1, +p[2]);
        var now = new Date();
        var today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        var diff = Math.round((today - then) / 86400000);
        if (diff <= 0) return 'Today';
        if (diff === 1) return 'Yesterday';
        if (diff < 7) return diff + ' days ago';
        if (diff < 30) return Math.floor(diff / 7) + ' wk ago';
        return Math.floor(diff / 30) + ' mo ago';
    }

    // Whole-day diff (>= 0); Infinity for unparseable dates so they only
    // surface under the "All years" filter.
    function _reconDaysAgo(dateISO) {
        if (!dateISO) return Infinity;
        var p = dateISO.split('-');
        var then = Date.UTC(+p[0], +p[1] - 1, +p[2]);
        var now = new Date();
        var today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        return Math.round((today - then) / 86400000);
    }

    var _reconMissionsParsed = null;   // _reconMissionsList mapped through _reconParseMission
    var _reconMissionsFilter = null;   // 'recent90' | 'all' | a 4-digit year string

    function _reconMissionMatchesFilter(p) {
        var f = _reconMissionsFilter;
        if (!f || f === 'all') return true;
        if (f === 'recent90') return _reconDaysAgo(p.dateISO) <= 90;
        return String(p.year) === f;   // year filter
    }

    // Build the filter dropdown from the years present in the data. Default
    // (first load only) to the most recent year so the current season shows
    // instead of the entire multi-year archive.
    function _reconPopulateMissionFilter() {
        var sel = document.getElementById('recon-missions-filter');
        if (!sel || !_reconMissionsParsed) return;
        var years = [];
        _reconMissionsParsed.forEach(function (p) {
            if (p.year && years.indexOf(p.year) === -1) years.push(p.year);
        });
        years.sort(function (a, b) { return b - a; });
        var opts = '<option value="recent90">Last 90 days</option>' +
                   '<option value="all">All years</option>';
        years.forEach(function (y) { opts += '<option value="' + y + '">' + y + '</option>'; });
        sel.innerHTML = opts;
        if (_reconMissionsFilter == null) {
            _reconMissionsFilter = years.length ? String(years[0]) : 'all';
        }
        sel.value = _reconMissionsFilter;
    }

    function _reconRenderMissionCards() {
        var grid = document.getElementById('recon-missions-grid');
        var countEl = document.getElementById('recon-missions-count');
        if (!grid || !_reconMissionsParsed) return;
        var shown = _reconMissionsParsed.filter(_reconMissionMatchesFilter);
        if (countEl) {
            countEl.textContent = shown.length + ' of ' + _reconMissionsParsed.length + ' missions';
        }
        if (!shown.length) {
            grid.innerHTML = '<div class="recon-missions-empty">No missions match this filter.</div>';
            return;
        }
        var html = '';
        shown.forEach(function (p) {
            var dateLabel = p.dateISO
                ? (_RECON_MONTHS[p.month - 1] + ' ' + p.day + ', ' + p.year)
                : p.id;
            var rel = _reconRelDays(p.dateISO);
            var recentCls = (rel === 'Today' || rel === 'Yesterday') ? ' is-recent' : '';
            var safeId = String(p.id).replace(/'/g, '');
            html += '<button class="recon-mission-card' + recentCls + '"' +
                ' onclick="reconOpenMissionInTDR(\'' + safeId + '\')"' +
                ' title="Open ' + safeId + ' in the TDR viewer">' +
                '<div class="recon-mission-card-top">' +
                '<span class="recon-mission-date">' + dateLabel + '</span>' +
                (rel ? '<span class="recon-mission-rel">' + rel + '</span>' : '') +
                '</div>' +
                '<div class="recon-mission-flight">Flight ' + p.suffix + '</div>' +
                '<div class="recon-mission-meta">' +
                '<span class="recon-mission-tag">NOAA P-3</span>' +
                '<span class="recon-mission-tag tdr">TDR</span>' +
                '</div>' +
                '<div class="recon-mission-open">Open in TDR &rarr;</div>' +
                '</button>';
        });
        grid.innerHTML = html;
    }

    function _reconRenderMissionsDashboard(force) {
        var grid = document.getElementById('recon-missions-grid');
        var countEl = document.getElementById('recon-missions-count');
        if (!grid) return;
        if (_reconMissionsDashLoaded && !force) return;
        _reconMissionsDashLoaded = true;
        grid.innerHTML = '<div class="recon-missions-loading">Loading missions…</div>';
        if (countEl) countEl.textContent = '';

        fetchWithRetry(API_BASE + RT_PREFIX + '/missions')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                _reconMissionsList = (json && json.missions) || [];
                if (!_reconMissionsList.length) {
                    grid.innerHTML = '<div class="recon-missions-empty">No recent reconnaissance missions in the real-time archive.</div>';
                    return;
                }
                _reconMissionsParsed = _reconMissionsList.map(_reconParseMission);
                _reconPopulateMissionFilter();
                _reconRenderMissionCards();
            })
            .catch(function (err) {
                grid.innerHTML = '<div class="recon-missions-empty">Could not load missions: ' +
                    (err && err.message ? err.message : err) + '</div>';
            });
    }

    // Re-render the grid when the user changes the date filter (no refetch).
    window.reconFilterMissions = function (val) {
        _reconMissionsFilter = val;
        _reconRenderMissionCards();
    };

    window.reconReloadMissions = function () {
        _reconMissionsDashLoaded = false;
        _reconRenderMissionsDashboard(true);
    };

    // Select a mission in the TDR dropdown (adding the option if missing)
    // and fire its change handler to load that mission's analysis files.
    function _reconSelectMission(missionId) {
        var sel = document.getElementById('rt-mission-select');
        if (!sel) return;
        var found = false;
        for (var i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === missionId) { found = true; break; }
        }
        if (!found) {
            var opt = document.createElement('option');
            opt.value = missionId;
            var label = missionId;
            var mm = missionId.match(/^(\d{4})(\d{2})(\d{2})(.+)$/);
            if (mm) label = mm[1] + '-' + mm[2] + '-' + mm[3] + ' ' + mm[4];
            opt.textContent = label;
            sel.appendChild(opt);
        }
        sel.value = missionId;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Jump from a Missions-dashboard card into the TDR viewer.
    window.reconOpenMissionInTDR = function (missionId) {
        window.switchReconSub('tdr');
        var sel = document.getElementById('rt-mission-select');
        if (sel && !sel.disabled && sel.options.length > 1) {
            _reconSelectMission(missionId);
        } else {
            // Mission list still loading — apply once loadMissions() finishes.
            _reconPendingMission = missionId;
        }
    };

    // ── Recon · Flight-Level (Live HDOB) sub-tab ─────────────────
    var _MS2KT = 1.94384;
    var _reconFLMissionsLoaded = false;
    var _reconFLCurrentMission = null;

    function _reconFLMissionLabel(id) {
        var p = _reconParseMission(id);
        return p.dateISO ? (p.dateISO + ' ' + p.suffix) : id;
    }

    function _reconEnsureFLMissions() {
        var sel = document.getElementById('recon-fl-mission');
        if (!sel || _reconFLMissionsLoaded) return;
        _reconFLMissionsLoaded = true;
        var populate = function (list) {
            sel.innerHTML = '<option value="">Select a mission…</option>';
            list.forEach(function (id) {
                var opt = document.createElement('option');
                opt.value = id;
                opt.textContent = _reconFLMissionLabel(id);
                sel.appendChild(opt);
            });
        };
        if (_reconMissionsList && _reconMissionsList.length) { populate(_reconMissionsList); return; }
        fetchWithRetry(API_BASE + RT_PREFIX + '/missions')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) { _reconMissionsList = (json && json.missions) || []; populate(_reconMissionsList); })
            .catch(function () { sel.innerHTML = '<option value="">Error loading missions</option>'; });
    }

    function _reconFLRenderSummary(json) {
        var el = document.getElementById('recon-fl-summary');
        if (!el) return;
        var s = json.summary || {};
        function card(label, val, unit) {
            return '<div class="recon-fl-stat"><div class="recon-fl-stat-val">' + val +
                (unit ? '<span class="recon-fl-stat-unit">' + unit + '</span>' : '') +
                '</div><div class="recon-fl-stat-label">' + label + '</div></div>';
        }
        var maxFL = s.max_fl_wspd_ms != null ? Math.round(s.max_fl_wspd_ms * _MS2KT) : null;
        var maxSF = s.max_sfmr_wspd_ms != null ? Math.round(s.max_sfmr_wspd_ms * _MS2KT) : null;
        var html = '';
        html += card('Peak FL Wind', maxFL != null ? maxFL : '—', maxFL != null ? ' kt' : '');
        html += card('Peak SFMR Sfc', maxSF != null ? maxSF : '—', maxSF != null ? ' kt' : '');
        html += card('Min SLP', s.min_slp_hpa != null ? Math.round(s.min_slp_hpa) : '—', s.min_slp_hpa != null ? ' hPa' : '');
        html += card('Min Flt Pres', s.min_static_pres_hpa != null ? Math.round(s.min_static_pres_hpa) : '—', s.min_static_pres_hpa != null ? ' hPa' : '');
        html += card('Mean Alt', s.mean_alt_m != null ? (s.mean_alt_m / 1000).toFixed(1) : '—', s.mean_alt_m != null ? ' km' : '');
        html += card('Obs', json.n_obs != null ? json.n_obs : '—', '');
        el.innerHTML = html;
        el.style.display = '';
    }

    function _reconFLRenderCharts(json) {
        var el = document.getElementById('recon-fl-charts');
        if (!el || !window.Plotly) return;
        var obs = json.observations;
        var t = obs.map(function (o) { return o.time; });
        function col(key, scale) {
            return obs.map(function (o) {
                var v = o[key];
                return (v === null || v === undefined) ? null : (scale ? v * scale : v);
            });
        }
        var anyExtrap = obs.some(function (o) { return o.extrapolated_sfc_wspd_ms != null; });

        var traces = [
            { x: t, y: col('fl_wspd_ms', _MS2KT), name: 'FL Wind', type: 'scatter', mode: 'lines', line: { color: '#0ea5e9', width: 1.5 }, yaxis: 'y' },
            { x: t, y: col('sfmr_wspd_ms', _MS2KT), name: 'SFMR Sfc', type: 'scatter', mode: 'lines', line: { color: '#fb923c', width: 1.5 }, yaxis: 'y' }
        ];
        if (anyExtrap) {
            traces.push({ x: t, y: col('extrapolated_sfc_wspd_ms', _MS2KT), name: 'Extrap Sfc', type: 'scatter', mode: 'lines', line: { color: '#ca8a04', width: 1, dash: 'dot' }, yaxis: 'y' });
        }
        traces.push({ x: t, y: col('slp_hpa'), name: 'SLP', type: 'scatter', mode: 'lines', line: { color: '#a855f7', width: 1.5 }, yaxis: 'y2' });
        traces.push({ x: t, y: col('static_pres_hpa'), name: 'Flt Pres', type: 'scatter', mode: 'lines', line: { color: '#3b82f6', width: 1, dash: 'dot' }, yaxis: 'y2' });
        traces.push({ x: t, y: col('temp_c'), name: 'Temp', type: 'scatter', mode: 'lines', line: { color: '#ef4444', width: 1.5 }, yaxis: 'y3' });
        traces.push({ x: t, y: col('dewpoint_c'), name: 'Dewpt', type: 'scatter', mode: 'lines', line: { color: '#16a34a', width: 1.5 }, yaxis: 'y3' });
        traces.push({ x: t, y: col('gps_alt_m', 0.001), name: 'GPS Alt', type: 'scatter', mode: 'lines', line: { color: '#64748b', width: 1.5 }, yaxis: 'y4' });

        // Theme bridge: read the page's Plotly tokens so the chart chrome
        // (bg / text / grid) tracks the active light/dark theme.
        var rootStyle = getComputedStyle(document.documentElement);
        function rv(name, fallback) { return (rootStyle.getPropertyValue(name) || '').trim() || fallback; }
        var plotBg = rv('--plot-paper', '#ffffff');
        var plotText = rv('--plot-text', '#0f1623');
        var plotGrid = rv('--plot-grid', 'rgba(15,22,35,0.10)');
        var plotAxis = rv('--plot-axis', '#5b6573');
        var hoverBg = rv('--plot-hover-bg', '#ffffff');
        var hoverBorder = rv('--plot-hover-border', 'rgba(15,22,35,0.15)');

        function yax(domain, title) {
            return { gridcolor: plotGrid, zeroline: false, color: plotAxis, domain: domain, title: { text: title, font: { size: 11 } } };
        }
        var layout = {
            height: 660,
            margin: { l: 62, r: 16, t: 8, b: 40 },
            paper_bgcolor: plotBg,
            plot_bgcolor: plotBg,
            font: { color: plotText, family: 'DM Sans, sans-serif', size: 11 },
            showlegend: true,
            legend: { orientation: 'h', x: 0, y: 1.07, font: { size: 10 } },
            hovermode: 'x unified',
            hoverlabel: { bgcolor: hoverBg, bordercolor: hoverBorder, font: { color: plotText, size: 12 } },
            xaxis: { gridcolor: plotGrid, zeroline: false, color: plotAxis, anchor: 'y4', title: { text: 'Time (UTC)', font: { size: 11 } } },
            yaxis: yax([0.78, 1.0], 'Wind (kt)'),
            yaxis2: yax([0.52, 0.74], 'Pressure (hPa)'),
            yaxis3: yax([0.26, 0.48], 'Temp (°C)'),
            yaxis4: yax([0.0, 0.22], 'Alt (km)')
        };
        el.style.display = '';
        window.Plotly.newPlot(el, traces, layout, { responsive: true, displayModeBar: false });
    }

    window.reconLoadFlightLevel = function (mission) {
        var statusEl = document.getElementById('recon-fl-status');
        var summaryEl = document.getElementById('recon-fl-summary');
        var chartsEl = document.getElementById('recon-fl-charts');
        var emptyEl = document.getElementById('recon-fl-empty');
        if (!mission) {
            _reconFLCurrentMission = null;
            if (statusEl) statusEl.textContent = '';
            if (summaryEl) summaryEl.style.display = 'none';
            if (chartsEl) { chartsEl.style.display = 'none'; }
            if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = 'Select a mission above to view its flight-level data.'; }
            return;
        }
        _reconFLCurrentMission = mission;
        if (emptyEl) emptyEl.style.display = 'none';
        if (summaryEl) summaryEl.style.display = 'none';
        if (chartsEl) { chartsEl.style.display = 'none'; chartsEl.innerHTML = ''; }
        if (statusEl) statusEl.textContent = 'Loading flight-level data…';

        fetchWithRetry(API_BASE + RT_PREFIX + '/flightlevel_mission?mission=' + encodeURIComponent(mission))
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                if (_reconFLCurrentMission !== mission) return;  // superseded by a newer selection
                var obs = json.observations || [];
                if (!obs.length) {
                    if (statusEl) statusEl.textContent = '';
                    if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = json.message || 'No flight-level data available for this mission.'; }
                    return;
                }
                if (statusEl) statusEl.textContent = json.n_obs + ' pts · ' + (json.n_obs_total || 0) + ' raw 1-Hz';
                _reconFLRenderSummary(json);
                _reconFLRenderCharts(json);
                _ga('recon_fl_load', { mission: mission, n: json.n_obs });
            })
            .catch(function (err) {
                if (_reconFLCurrentMission !== mission) return;
                if (statusEl) statusEl.textContent = '';
                if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = 'Could not load flight-level data: ' + (err && err.message ? err.message : err); }
            });
    };

    // ── Recon · Vortex Data Messages (VDM) sub-tab ──────────────
    // Storm picker is driven by the RT Monitor's live active-storms
    // list (window._irGetActiveStorms, defined in realtime_ir.js).
    // VDMs only exist for Atlantic / East+Central Pacific recon, so we
    // filter to AL/EP/CP basins. Data comes from the existing
    // /global/vdm endpoint (storm-keyed; needs name+year+atcf+dates).
    var _reconVdmStormsLoaded = false;
    var _reconVdmCurrentId = null;
    var _RECON_VDM_BASINS = { AL: 1, EP: 1, CP: 1 };

    function _reconVdmEligible(s) {
        var id = (s && s.atcf_id ? String(s.atcf_id) : '').toUpperCase();
        return !!_RECON_VDM_BASINS[id.slice(0, 2)];
    }

    function _reconVdmStormDates(s) {
        // Derive start/end YYYY-MM-DD from the storm's track for the
        // /global/vdm month-context resolution; pad a little for safety.
        var track = (s && s.track) || [];
        var startISO = track.length ? track[0].time : s.last_fix_utc;
        var endISO = s.last_fix_utc || (track.length ? track[track.length - 1].time : null);
        function dpart(iso) { return iso ? String(iso).slice(0, 10) : null; }
        return { start: dpart(startISO), end: dpart(endISO) };
    }

    function _reconVdmYear(s) {
        var id = (s && s.atcf_id ? String(s.atcf_id) : '').toUpperCase();
        var m = id.match(/(\d{4})$/);
        if (m) return +m[1];
        if (s && s.last_fix_utc) return +String(s.last_fix_utc).slice(0, 4);
        return new Date().getUTCFullYear();
    }

    function _reconEnsureVdmStorms() {
        var sel = document.getElementById('recon-vdm-storm');
        if (!sel) return;
        if (_reconVdmStormsLoaded) return;

        var storms = (window._irGetActiveStorms && window._irGetActiveStorms()) || [];
        var populate = function (list) {
            var eligible = (list || []).filter(_reconVdmEligible);
            // Strongest first — mirrors the Satellite tab default ordering.
            eligible.sort(function (a, b) { return (b.vmax_kt || 0) - (a.vmax_kt || 0); });
            sel.innerHTML = '<option value="">Select a storm…</option>';
            eligible.forEach(function (s) {
                var label = (s.name || 'UNNAMED') + ' (' + s.atcf_id + ')';
                var opt = document.createElement('option');
                opt.value = s.atcf_id;
                opt.textContent = label;
                sel.appendChild(opt);
            });
            _reconVdmStormsLoaded = true;
            var emptyEl = document.getElementById('recon-vdm-empty');
            if (!eligible.length && emptyEl) {
                emptyEl.style.display = '';
                emptyEl.textContent = 'No active Atlantic or Pacific storms with reconnaissance right now.';
            }
        };

        if (storms.length) {
            populate(storms);
        } else if (window._irOnceStormsLoaded) {
            var emptyEl = document.getElementById('recon-vdm-empty');
            if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = 'Waiting for active-storms list…'; }
            window._irOnceStormsLoaded(function (list) { populate(list); });
        } else {
            populate([]);
        }
    }

    function _reconVdmStormById(atcfId) {
        var storms = (window._irGetActiveStorms && window._irGetActiveStorms()) || [];
        for (var i = 0; i < storms.length; i++) {
            if (String(storms[i].atcf_id).toUpperCase() === String(atcfId).toUpperCase()) {
                return storms[i];
            }
        }
        return null;
    }

    function _reconVdmFmtLatLon(lat, lon) {
        if (lat == null || lon == null) return '—';
        var ns = lat >= 0 ? 'N' : 'S';
        var ew = lon >= 0 ? 'E' : 'W';
        return Math.abs(lat).toFixed(2) + '°' + ns + ' ' + Math.abs(lon).toFixed(2) + '°' + ew;
    }

    function _reconVdmFmtTime(iso) {
        if (!iso) return '—';
        // iso like "2025-10-28T14:49:00" (UTC, no Z) → "Oct 28, 14:49Z"
        var p = iso.split('T');
        if (p.length < 2) return iso;
        var d = p[0].split('-');
        var t = p[1].slice(0, 5);
        return _RECON_MONTHS[(+d[1]) - 1] + ' ' + (+d[2]) + ', ' + t + 'Z';
    }

    function _reconVdmStat(label, value, unit, accent) {
        if (value == null || value === '') return '';
        return '<div class="recon-vdm-stat' + (accent ? ' is-accent' : '') + '">' +
            '<div class="recon-vdm-stat-val">' + value +
            (unit ? '<span class="recon-vdm-stat-unit">' + unit + '</span>' : '') + '</div>' +
            '<div class="recon-vdm-stat-label">' + label + '</div></div>';
    }

    function _reconVdmRenderList(json) {
        var listEl = document.getElementById('recon-vdm-list');
        var emptyEl = document.getElementById('recon-vdm-empty');
        if (!listEl) return;
        var vdms = (json && json.vdms) || [];
        if (!vdms.length) {
            listEl.style.display = 'none';
            listEl.innerHTML = '';
            if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = 'No vortex data messages found for this storm.'; }
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        // Latest message first.
        var sorted = vdms.slice().sort(function (a, b) {
            return String(b.time || '').localeCompare(String(a.time || ''));
        });

        var html = '';
        sorted.forEach(function (v, idx) {
            var fixWind = null;
            if (v.max_fl_wind_kt != null) {
                fixWind = v.max_fl_wind_kt + '<span class="recon-vdm-stat-unit"> kt</span>';
                if (v.max_fl_wind_bearing != null && v.max_fl_wind_range_nm != null) {
                    fixWind += '<span class="recon-vdm-stat-unit"> @ ' + v.max_fl_wind_bearing + '°/' + v.max_fl_wind_range_nm + ' nm</span>';
                }
            }
            var eye = '';
            if (v.eye_shape || v.eye_diameter_nm != null) {
                var parts = [];
                if (v.eye_shape) parts.push(v.eye_shape);
                if (v.eye_diameter_nm != null) parts.push(v.eye_diameter_nm + ' nm');
                eye = parts.join(' · ');
            }
            var tags = '';
            if (v.aircraft) tags += '<span class="recon-vdm-tag">' + v.aircraft + '</span>';
            if (v.mission_id) tags += '<span class="recon-vdm-tag">' + v.mission_id + '</span>';
            if (v.ob_number != null) tags += '<span class="recon-vdm-tag">OB ' + v.ob_number + '</span>';

            var rawId = 'recon-vdm-raw-' + idx;
            html += '<div class="recon-vdm-card">' +
                '<div class="recon-vdm-card-top">' +
                    '<div class="recon-vdm-time">' + _reconVdmFmtTime(v.time) + '</div>' +
                    '<div class="recon-vdm-pos">' + _reconVdmFmtLatLon(v.lat, v.lon) + '</div>' +
                '</div>' +
                '<div class="recon-vdm-stats">' +
                    _reconVdmStat('Min SLP', v.min_slp_hpa, ' mb', true) +
                    _reconVdmStat('Max FL Wind', fixWind, '') +
                    _reconVdmStat('Max Sfc (SFMR)', v.max_sfmr_kt, ' kt') +
                    _reconVdmStat('Flight Level', v.flight_level_mb, ' mb') +
                    _reconVdmStat('Eye', eye, '') +
                    _reconVdmStat('Eye Temp', v.eye_temp_c, ' °C') +
                '</div>' +
                (tags ? '<div class="recon-vdm-tags">' + tags + '</div>' : '') +
                (v.raw_text ? '<details class="recon-vdm-raw"><summary>Raw message</summary><pre>' +
                    String(v.raw_text).replace(/</g, '&lt;') + '</pre></details>' : '') +
            '</div>';
        });
        listEl.innerHTML = html;
        listEl.style.display = '';
    }

    window.reconLoadVdm = function (atcfId) {
        var statusEl = document.getElementById('recon-vdm-status');
        var listEl = document.getElementById('recon-vdm-list');
        var emptyEl = document.getElementById('recon-vdm-empty');
        if (!atcfId) {
            _reconVdmCurrentId = null;
            if (statusEl) statusEl.textContent = '';
            if (listEl) { listEl.style.display = 'none'; listEl.innerHTML = ''; }
            if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = 'Select a storm above to view its decoded vortex data messages.'; }
            return;
        }
        var storm = _reconVdmStormById(atcfId);
        if (!storm) {
            if (statusEl) statusEl.textContent = '';
            if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = 'Storm not found in the active list.'; }
            return;
        }
        _reconVdmCurrentId = atcfId;
        if (listEl) { listEl.style.display = 'none'; listEl.innerHTML = ''; }
        if (emptyEl) emptyEl.style.display = 'none';
        if (statusEl) statusEl.textContent = 'Loading VDMs…';

        var dates = _reconVdmStormDates(storm);
        var qs = 'storm_name=' + encodeURIComponent(storm.name || '') +
            '&year=' + _reconVdmYear(storm) +
            '&atcf_id=' + encodeURIComponent(storm.atcf_id);
        if (dates.start) qs += '&start_date=' + dates.start;
        if (dates.end) qs += '&end_date=' + dates.end;

        fetchWithRetry(API_BASE + '/global/vdm?' + qs)
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (json) {
                if (_reconVdmCurrentId !== atcfId) return;  // superseded
                if (statusEl) statusEl.textContent = (json.n_vdms || 0) + ' message' + ((json.n_vdms === 1) ? '' : 's');
                _reconVdmRenderList(json);
                _ga('recon_vdm_load', { atcf: atcfId, n: json.n_vdms });
            })
            .catch(function (err) {
                if (_reconVdmCurrentId !== atcfId) return;
                if (statusEl) statusEl.textContent = '';
                if (emptyEl) { emptyEl.style.display = ''; emptyEl.textContent = 'Could not load VDMs: ' + (err && err.message ? err.message : err); }
            });
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
                // A Missions-dashboard card may have requested a mission
                // before the list finished loading — apply it now. Otherwise,
                // auto-load the most recent analysis if one is fresh enough.
                if (_reconPendingMission) {
                    var pm = _reconPendingMission;
                    _reconPendingMission = null;
                    _reconSelectMission(pm);
                } else {
                    _rtAutoLoadRecent();
                }
            })
            .catch(function (err) {
                sel.innerHTML = '<option value="">Error loading missions</option>';
                rtToast('Could not load missions: ' + err.message, 'error');
            });
    }
    window._rtLoadMissions = loadMissions;

    // ── Load files for a mission ─────────────────────────────────
    // cb(files|null) fires after the dropdown is populated, so callers (e.g. the
    // recent-analysis auto-loader) can act on the list without re-fetching.
    function loadFiles(mission, cb) {
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
                    if (cb) cb([]);
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
                if (cb) cb(json.files);
            })
            .catch(function (err) {
                sel.innerHTML = '<option value="">Error loading files</option>';
                rtToast('Could not list files: ' + err.message, 'error');
                if (cb) cb(null);
            });
    }

    // ── Auto-load the most recent analysis (within RECENT_H hours) ───
    // So opening the TDR tab during/just-after a sortie lands straight on the
    // freshest analysis instead of an empty mission picker — the same "it just
    // works" behaviour as Live Flight auto-selecting the active storm. If nothing
    // is recent (off-season, or the newest analysis is stale) it leaves the manual
    // picker untouched. Only ever runs once, and never overrides a user choice.
    var _RT_RECENT_H = 12;
    var _rtAutoLoadTried = false;
    function _rtAutoLoadRecent() {
        if (_rtAutoLoadTried || _currentFileUrl) return;   // once, and never over a live selection
        var msel = document.getElementById('rt-mission-select');
        if (!msel || msel.disabled || msel.options.length < 2) return;  // missions not ready yet
        if (msel.value) return;                             // user already picked a mission
        _rtAutoLoadTried = true;
        var newestMission = msel.options[1].value;          // options[0] = "Select…"; list is reverse-chron
        if (!newestMission) return;
        loadFiles(newestMission, function (files) {
            if (!files || !files.length) return;
            // Files come back oldest→newest (backend sorts by production time).
            var latest = files[files.length - 1];
            var ts = latest.datetime_utc ? Date.parse(latest.datetime_utc) : NaN;
            var ageH = isNaN(ts) ? Infinity : (Date.now() - ts) / 3600000;
            if (ageH > _RT_RECENT_H) return;                // nothing fresh → stay on manual picker
            // Reflect the auto-selection in both dropdowns, then load it.
            msel.value = newestMission;
            var fsel = document.getElementById('rt-file-select');
            fsel.value = latest.url;
            var goBtn = document.getElementById('rt-go-btn');
            if (goBtn) goBtn.disabled = false;
            _ga('rt_autoload_recent', { mission: newestMission, age_h: Math.round(ageH * 10) / 10 });
            window.rtExploreFile();
            if (typeof rtToast === 'function') {
                var lbl = (latest.time_label && latest.time_label.length === 4)
                    ? latest.time_label.slice(0, 2) + ':' + latest.time_label.slice(2) + ' UTC' : '';
                rtToast('Showing the latest TDR analysis' + (lbl ? ' (' + lbl + ')' : '') +
                        ' — pick another from the menu above.', 'info');
            }
        });
    }

    // ── Event: mission selected ──────────────────────────────────
    // readyState-aware: this module can be LAZY-LOADED on first Recon-tab
    // click, long after DOMContentLoaded — a bare listener would never fire.
    var _tdrWireDom = function () {
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
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _tdrWireDom);
    } else {
        _tdrWireDom();
    }

    // ── Feature hooks ──────────────────────────────────────────────
    // Sondes / flight-level / NEXRAD attach their per-file reset, post-render
    // and map-cleanup steps here instead of re-wrapping rtExploreFile,
    // rtRenderPlot, rtOpen3DModal and _rtCleanupMap (which were reassigned up
    // to three times each, 2026-09-28 cleanup).
    var _rtHooks = { beforeExplore: [], afterRender: [], after3D: [], cleanupMap: [] };
    function _rtOn(name, fn) { _rtHooks[name].push(fn); }
    function _rtRunHooks(name, a, b) {
        _rtHooks[name].forEach(function (fn) { try { fn(a, b); } catch (e) { console.warn('[rt hook ' + name + ']', e); } });
    }

    // ── Go button: load the file and show viz panel ──────────────
    window.rtExploreFile = function () {
        _rtRunHooks('beforeExplore');
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
        // Keep centre-track mode across sweeps of the SAME mission (re-projected
        // per sweep); drop it + the cache when the mission changes.
        if (_rtCtrkData && _rtCtrkData.mission !== _rtCurrentMission()) {
            _rtCtrkData = null; _rtCtrkOverlay = false;
            var _cte = document.getElementById('rt-ctrk-result'); if (_cte) _cte.innerHTML = '';
        }
        var ctrkBtn = document.getElementById('rt-ctrk-btn'); if (ctrkBtn) { ctrkBtn.disabled = true; ctrkBtn.classList.toggle('active', _rtCtrkOverlay); }
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

    // ── Analysis stepper (◀ n of N ▶ within the mission), like the explorer's case nav ──
    function _rtFileOptions() {
        var sel = document.getElementById('rt-file-select');
        return sel ? [].filter.call(sel.options, function (o) { return !!o.value; }) : [];
    }
    function _rtStepperHTML() {
        var opts = _rtFileOptions(), sel = document.getElementById('rt-file-select');
        if (opts.length < 2 || !sel) return '';
        var i = opts.findIndex(function (o) { return o.value === sel.value; });
        return '<span class="case-nav-bar">' +
            '<button class="case-nav-btn" onclick="rtStepAnalysis(-1)" title="Previous analysis"' + (i <= 0 ? ' disabled' : '') + '>\u25C0</button>' +
            '<span class="case-nav-pos">' + (i + 1) + ' of ' + opts.length + '</span>' +
            '<button class="case-nav-btn" onclick="rtStepAnalysis(1)" title="Next analysis"' + (i >= opts.length - 1 ? ' disabled' : '') + '>\u25B6</button></span>';
    }
    window.rtStepAnalysis = function (d) {
        var opts = _rtFileOptions(), sel = document.getElementById('rt-file-select');
        var i = opts.findIndex(function (o) { return o.value === sel.value; });
        var j = i + d;
        if (i < 0 || j < 0 || j >= opts.length) return;
        sel.value = opts[j].value;
        rtExploreFile();
    };

    // ── Fetch and display metadata ───────────────────────────────
    function rtFetchMeta(fileUrl) {
        // case_meta rides on every /data response, so join the plan view's
        // in-flight request instead of firing a second (differently-keyed, so
        // separately computed — often on another instance) /data call.
        var p = (_rtPlanInflight && _rtPlanInflight.fileUrl === fileUrl) ? _rtPlanInflight.promise
            : fetchWithRetry(API_BASE + RT_PREFIX + '/data?file_url=' + encodeURIComponent(fileUrl) + '&variable=' + DEFAULT_RT_VAR + '&level_km=2')
                .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
        p.then(function (json) {
                var m = json.case_meta || {};
                _rtCaseMeta = m;  // Store for SHIPS auto-fetch
                // Compact header like the explorer's (name + analysis stepper, one
                // info line); the details sit behind a disclosure.
                var html = '<div class="panel-storm-name">' + (m.storm_name || 'Unknown') + _rtStepperHTML() + '</div>' +
                    '<div class="panel-mission">' + (m.mission_id || '') + ' \u00b7 ' + (m.datetime || '') + '</div>' +
                    '<div class="panel-mission" id="rt-maxwind-line"></div>' +
                    '<details class="rt-meta-more"><summary>Analysis details</summary>' +
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
                    '</div></details>';
                document.getElementById('rt-meta-panel').innerHTML = html;

                // Init Leaflet map + fetch max 2-km wind for marker
                if (m.latitude && m.longitude) {
                    _rtInitMap(m);
                    _rtFetchMaxWind(_currentFileUrl, m);
                }
            })
            .catch(function () { /* metadata will show from the plot fetch anyway */ });
    }

    // ── Plan-view wind barbs ─────────────────────────────────────
    // Ported from tc_radar_app.js:_buildPlanViewWindBarbs so the recon
    // page (which does NOT load tc_radar_app.js) can draw barbs.
    // barbData = { u:[[]], v:[[]], x:[], y:[], units:'m/s', type:'earth_relative' }
    // axRanges = { xMin, xMax, yMin, yMax }. Returns Plotly shape objects.
    function _buildPlanViewWindBarbs(barbData, axRanges) { return TDRView.windBarbShapes(barbData, axRanges); }

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

        var cacheKey = _currentFileUrl + '_' + variable + '_' + level_km + '_' + overlay + (_rtBarbsEnabled ? '_barbs' : '') + (_rtStormRelative ? '_sr' : '');
        if (_rtDataCache[cacheKey]) {
            rtRenderPlot(_rtDataCache[cacheKey], resultDiv);
            btn.disabled = false; btn.textContent = 'Update Plan View';
            if (callback) callback(); return;
        }

        var controller = new AbortController();
        var timeout = setTimeout(function () { controller.abort(); }, 120000);
        var url = API_BASE + RT_PREFIX + '/data?file_url=' + encodeURIComponent(_currentFileUrl) + '&variable=' + variable + '&level_km=' + level_km;
        if (overlay) url += '&overlay=' + overlay;
        if (_rtBarbsEnabled) url += '&wind_barbs=true';
        if (_rtStormRelative) url += '&storm_relative=true';

        var planPromise = fetch(url, { signal: controller.signal })
            .then(function (r) { if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); });
        _rtPlanInflight = { fileUrl: _currentFileUrl, promise: planPromise };
        planPromise
            .then(function (json) { _rtDataCache[cacheKey] = json; if (json.case_meta) _rtCaseMeta = json.case_meta; rtRenderPlot(json, resultDiv); if (callback) callback(); })
            .catch(function (err) {
                var msg = err.name === 'AbortError' ? '⚠️ Request timed out (120s).' : '⚠️ ' + err.message;
                resultDiv.innerHTML = '<div class="explorer-status error">' + msg + '</div>';
                rtAnimStop();
            })
            .finally(function () { clearTimeout(timeout); btn.disabled = false; btn.textContent = 'Update Plan View'; });
    };

    // ── Max value helpers (mirrors archive findDataMax / buildMaxMarkerTrace / buildMaxAnnotation) ──
    function rtFindDataMax(zData, xCoords, yCoords) { return TDRView.findDataMax(zData, xCoords, yCoords); }

    function rtIsWindVariable(varName) { return TDRView.isWindVariable(varName); }

    function rtBuildMaxMarkerTrace(maxInfo, units) { return TDRView.maxMarkerTrace(maxInfo, units); }

    function rtBuildMaxAnnotation(maxInfo, units, xLabel, yLabel, fontSize) { return TDRView.maxAnnotation(maxInfo, units, xLabel, yLabel, fontSize); }

    // ── Rubber-band line for cross-section (follows mouse from A to cursor) ──
    function _rtStartRubberBand(plotDiv, pxA, pyA) { _rtCsMouseHandler = TDRView.startRubberBand(plotDiv, pxA, pyA, 'rt-cs-rubber-band'); }

    function _rtRemoveRubberBand() {
        TDRView.stopRubberBand(document.getElementById('rt-plotly-chart'), 'rt-cs-rubber-band', _rtCsMouseHandler);
        _rtCsMouseHandler = null;
    }

    // ── Default colormap helper: returns 'Jet' for tangential wind / wind speed ──
    function _rtDefaultCmapForVariable(varName) {
        if (varName === 'TANGENTIAL_WIND' || varName === 'WIND_SPEED') return 'Jet';
        return null; // use server default
    }

    // ── Render plan-view from JSON ───────────────────────────────
    function rtRenderPlot(json, resultDiv) {
        var zData = json.data, x = json.x, y = json.y, varInfo = json.variable, meta = json.case_meta || {};
        if (!TDRView.hasAnyData(zData)) {
            resultDiv.innerHTML = TDRView.noDataHTML(meta.storm_name, varInfo && varInfo.display_name, json.actual_level_km);
            return;
        }
        // Plan view (left) + azimuthal-mean placeholder (right) — shared with the explorer
        resultDiv.innerHTML = TDRView.dualPanelHTML('rt-', { onExpand: 'rtOpenFullscreen', onToggle: '_rtToggleDualPane', onSave: 'rtSaveTDRView' });
        _rtDefaultColorscale = varInfo.colorscale;
        _rtDefaultVmin = varInfo.vmin;
        _rtDefaultVmax = varInfo.vmax;

        // Colorscale: user override > variable-specific default > server default
        var varDefault = _rtDefaultCmapForVariable(varInfo.key || (document.getElementById('rt-var') || {}).value || '');
        var activeColorscale = _rtColorscale(varInfo);
        var activeVmin = _rtGetVmin(), activeVmax = _rtGetVmax();
        var frameTag = json.storm_relative ? ' <span style="color:#2563eb;">\u00b7 storm-relative</span>' : '';
        var title = TDRView.planTitle((meta.storm_name || 'Real-Time TDR') + ' | ' + (meta.datetime || ''),
                                      varInfo, json.actual_level_km, json, frameTag);
        var fig = TDRView.planFigure({
            z: zData, x: x, y: y, varInfo: varInfo, colorscale: activeColorscale, zmin: activeVmin, zmax: activeVmax,
            title: title, hasOverlay: !!json.overlay,
            // RMW circle at the WCM center, not the grid origin
            rmw: { r: json.wcm_rmw_km, cx: json.wcm_center_x_km || 0, cy: json.wcm_center_y_km || 0 },
            barbs: json.wind_barbs, overlayTraces: rtBuildOverlayContours(json, x, y, false),
            windMarker: _rtWindMarker()
        });
        var heatmap = fig.heatmap, layout = fig.layout, baseLayout = fig.baseLayout, config = fig.config;
        var overlayTraces = fig.overlayTraces, maxTraces = fig.maxTraces;
        var _rtMetaStripHTML = _rtStripHTML(json);
        var rtDualWrap = document.getElementById('rt-dual-panel-wrap');
        if (rtDualWrap && _rtMetaStripHTML) rtDualWrap.insertAdjacentHTML('beforebegin', _rtMetaStripHTML);

        // Coastline overlay (storm-relative km) — drawn above the heatmap/IR
        // underlay, below max markers. Included in the trace list so it exports.
        var coastTrace = _rtCoastVisible ? _rtBuildCoastTrace(meta) : null;
        var coastTraces = coastTrace ? [coastTrace] : [];
        // Coast is on by default, so the GeoJSON may not be fetched yet on the
        // first plot — kick off the load and re-render once it lands.
        if (_rtCoastVisible && !_rtCoastGeoJSON && !_rtCoastLoading) {
            _rtLoadCoastline(function () { rtGeneratePlot(); });
        }

        // Center-track mode: replace the wind field with the mission's 2/6 km
        // centres (projected into THIS sweep's km frame) over the IR underlay +
        // coastlines. Overlay contours / max marker / RMW & barb shapes are
        // dropped for clarity; toggle the mode off to get the winds back.
        var _ctrk = (_rtCtrkOverlay && _rtCtrkData && _rtCtrkData.points && _rtCtrkData.points.length)
            ? _rtBuildCenterTrackTraces(meta) : null;
        var _planTraces, _planLayout;
        if (_ctrk) {
            _planTraces = coastTraces.concat(_ctrk.traces);
            _planLayout = Object.assign({}, layout, {
                title: { text: _ctrk.title, font: { color: '#0f1623', size: 11 }, y: 0.965, x: 0.5, xanchor: 'center', yanchor: 'top' },
                annotations: _ctrk.annotations,
                shapes: []
            });
        } else {
            _planTraces = [heatmap].concat(coastTraces).concat(overlayTraces).concat(maxTraces);
            _planLayout = layout;
        }
        Plotly.newPlot('rt-plotly-chart', _planTraces, _planLayout, config);
        _rtLastPlotlyData = { heatmap: heatmap, overlayTraces: overlayTraces, maxTraces: maxTraces, baseLayout: baseLayout, title: title, config: config, json: json };

        // Capture the field for the map drape (storm-relative km → lat/lon) and
        // arm the two-panel default. Deferred so the Plotly plan chart renders
        // at full size first (clean toggle-back); idempotent, so it also
        // re-hides the pane after variable / level re-renders.
        var _dm = (meta && meta.latitude != null) ? meta : (_rtCaseMeta || {});
        _rtPlan = {
            z: zData, x: x, y: y,
            vmin: (activeVmin != null ? activeVmin : varInfo.vmin), vmax: (activeVmax != null ? activeVmax : varInfo.vmax),
            colorscale: activeColorscale, default_colorscale: (varDefault || varInfo.colorscale),
            units: varInfo.units, display_name: varInfo.display_name, level_km: json.actual_level_km,
            rmw_km: json.wcm_rmw_km, rmw_cx: json.wcm_center_x_km || 0, rmw_cy: json.wcm_center_y_km || 0,
            barbs: json.wind_barbs || null, ctrk: !!_ctrk,
            center_lat: (_dm.latitude != null && !(_dm.latitude === 0 && _dm.longitude === 0)) ? _dm.latitude : null,
            center_lon: _dm.longitude
        };
        setTimeout(_rtDrapeAuto, 60);

        // newPlot replaces layout.images, so re-apply the IR underlay if active.
        if (_rtIRPlotlyVisible) _rtApplyIRUnderlay();

        // Auto-generate azimuthal mean in the right dual pane
        _rtAutoFetchDualAzimuthalMean();

        // Enable action buttons
        var csBtn = document.getElementById('rt-cs-btn'); if (csBtn) csBtn.disabled = false;
        var volBtn = document.getElementById('rt-vol-btn'); if (volBtn) volBtn.disabled = false;
        var azBtn = document.getElementById('rt-az-btn'); if (azBtn) azBtn.disabled = false;
        var cfadBtn = document.getElementById('rt-cfad-btn'); if (cfadBtn) cfadBtn.disabled = false;
        var ctrkBtn = document.getElementById('rt-ctrk-btn'); if (ctrkBtn) { ctrkBtn.disabled = false; ctrkBtn.classList.toggle('active', _rtCtrkOverlay); }
        // Keep the centre-track table in sync when the mode is active (e.g. after
        // switching sweeps within the same mission — the centres re-project).
        if (_rtCtrkOverlay && _rtCtrkData) _rtRenderCenterTrackTable();
        var tiltBtn = document.getElementById('rt-tilt-btn'); if (tiltBtn) tiltBtn.disabled = false;
        var barbBtn = document.getElementById('rt-barb-btn'); if (barbBtn) { barbBtn.disabled = false; barbBtn.classList.toggle('active', _rtBarbsEnabled); }
        var coastBtn = document.getElementById('rt-coast-btn'); if (coastBtn) { coastBtn.disabled = false; coastBtn.classList.toggle('active', _rtCoastVisible); }
        var maxBtn = document.getElementById('rt-maxmark-btn'); if (maxBtn) maxBtn.disabled = false;
        var srBtn = document.getElementById('rt-sr-btn'); if (srBtn) { srBtn.disabled = false; srBtn.classList.toggle('active', _rtStormRelative); }
        // Anomaly + Quadrant buttons stay disabled until SHIPS is loaded
        // (they need Vmax / SDDC from SHIPS)

        // Auto-fetch SHIPS data in background (silent — no error toast on failure)
        if (!_rtShipsData && !_rtShipsLoading) {
            _rtAutoFetchSHIPS();
        }

        // Click handler for cross-section
        document.getElementById('rt-plotly-chart').on('plotly_click', rtHandlePlotClick);
        _rtRunHooks('afterRender', json, resultDiv);
    }

    // ══════════════════════════════════════════════════════════════
    //  Radar → Map: drape the plan-view field on the geographic map
    //  Ported from tc_radar_app.js (_radarMapDraw and friends) so the
    //  real-time tab matches the explorer's focus mode: the map IS the plan
    //  view, and the redundant Plotly plan pane is hidden while draped. The
    //  "Radar on map" pill (or collapsing the map) brings the pane back, which
    //  is also where the Plotly-only layers live (contour overlay, tilt,
    //  max marker, centre-track mode, fullscreen / save).
    // ══════════════════════════════════════════════════════════════
    var _rtPlan = null;            // last plan-view field, captured by rtRenderPlot
    var _rtDrapeOn = false;        // field currently on the map
    var _rtDrapeDisabled = false;  // user turned the drape off — don't re-arm
    var _rtDrapeHoverBound = false, _rtDrapeFramedFor = null;

    // The drape itself (canvas field, RMW ring at the WCM center, vector barbs,
    // hover readout, editable colorbar, km <-> lat/lon) is TDRView.createDrape,
    // shared with the TC-RADAR explorer; this file only decides WHEN to drape.
    var _rtDrape = TDRView.createDrape({
        map: function () { return _rtMap; },
        prefix: 'rt',
        barbsVisible: function () { return _rtBarbsEnabled; },
        hoverSuppressed: function () { return _rtCsMode; },
        colorbar: {
            host: function () { return document.getElementById('rt-map-wrapper'); },
            id: 'rt-drape-colorbar', cls: 'rt-cb', className: 'rt-drape-colorbar', opacity: true,
            onRange: function (mn, mx) {
                var a = document.getElementById('rt-vmin'), b = document.getElementById('rt-vmax');
                if (a) a.value = mn; if (b) b.value = mx;
                rtApplyColorRange();
            },
            onReset: function () { rtResetColorRange(); }
        },
        onDraw: function () {
            if (!_rtDrapeHoverBound) { _rtMap.on('click', _rtCsMapClick); _rtMap.on('mousemove', _rtCsMapMove); _rtDrapeHoverBound = true; }
            // The centre dot sits on the eye and hides the field there.
            if (_rtMapMarker && _rtMap.hasLayer && _rtMap.hasLayer(_rtMapMarker)) { try { _rtMap.removeLayer(_rtMapMarker); } catch (e) {} }
        },
        onOff: function () {
            if (_rtMap && _rtMapMarker && _rtMap.hasLayer && !_rtMap.hasLayer(_rtMapMarker)) { try { _rtMapMarker.addTo(_rtMap); } catch (e) {} }
        }
    });
    function _rtMapPanelVisible() {
        var lay = document.querySelector('.rt-viz-layout');
        return !!(lay && !lay.classList.contains('rt-map-collapsed'));
    }
    function _rtDrapeDraw() { if (_rtMap && _rtPlan) _rtDrape.draw(_rtPlan); }
    // Re-color the draped field after a colormap / range change in the panel.
    function _rtDrapeRecolor() {
        if (!_rtPlan) return;
        var sel = document.getElementById('rt-cmap'), cs = sel && sel.value;
        if (cs) { try { _rtPlan.colorscale = JSON.parse(cs); } catch (e) { _rtPlan.colorscale = cs; } }
        else _rtPlan.colorscale = _rtPlan.default_colorscale;
        var mn = _rtGetVmin(), mx = _rtGetVmax();
        if (mn != null && !isNaN(mn)) _rtPlan.vmin = mn;
        if (mx != null && !isNaN(mx)) _rtPlan.vmax = mx;
        if (_rtDrapeOn) _rtDrapeDraw();
    }

    // Hide / restore the Plotly plan pane (the map carries it while draped) and
    // let the azimuthal-mean pane fill the row.
    function _rtApplyTwoPanel(on) {
        var wrap = document.getElementById('rt-dual-panel-wrap');
        if (!wrap) return;
        var left = document.getElementById('rt-dual-pane-left');
        var right = document.getElementById('rt-dual-pane-right');
        var divider = wrap.querySelector('.dual-pane-divider');
        if (on) {
            if (left) left.style.display = 'none';
            if (divider) divider.style.display = 'none';
            // A narrow-width media query hides the last .dual-pane; while draped
            // it is the only pane, so force it visible.
            if (right) { right.style.display = 'flex'; right.style.flex = '1 1 100%'; right.style.maxWidth = '100%'; }
        } else {
            if (left) left.style.display = '';
            if (divider) divider.style.display = '';
            if (right) { right.style.display = ''; right.style.flex = ''; right.style.maxWidth = ''; }
        }
        var hint = document.getElementById('rt-plan-hint');
        if (hint) hint.textContent = on
            ? 'Radar field is on the map · hover it for values · “Radar on map” brings the plan view back'
            : 'Hover for values · scroll to zoom · drag to pan · ⛶ expand';
        try {
            if (window.Plotly) {
                var az = document.getElementById('rt-dual-az-chart'); if (az && az.data) Plotly.Plots.resize(az);
                var pv = document.getElementById('rt-plotly-chart'); if (!on && pv && pv.data) Plotly.Plots.resize(pv);
            }
        } catch (e) {}
    }
    function _rtDrapeSyncBtn() {
        var btn = document.getElementById('rt-drape-btn');
        if (btn) { btn.disabled = !_rtPlan; btn.classList.toggle('active', _rtDrapeOn); }
    }
    // Take the field off the map and bring the Plotly plan pane back.
    function _rtDrapeOff() {
        _rtDrapeOn = false;
        _rtDrape.off();
        _rtCsMapClear();
        _rtApplyTwoPanel(false);
        _rtDrapeSyncBtn();
    }
    // Default after every plan-view render: drape + hide the plan pane, unless
    // the user turned it off, the map is collapsed, or centre-track mode (a
    // Plotly-only view) is showing.
    function _rtDrapeAuto() {
        var can = _rtPlan && _rtMap && !_rtDrapeDisabled && _rtMapPanelVisible() && !_rtPlan.ctrk;
        if (!can) { if (_rtDrapeOn) _rtDrapeOff(); else _rtDrapeSyncBtn(); return; }
        _rtDrapeOn = true;
        _rtDrapeDraw();
        // renderPlot rebuilds the dual-panel HTML each time → re-hide the pane.
        _rtApplyTwoPanel(true);
        _rtDrapeSyncBtn();
        if (_rtDrapeFramedFor !== _currentFileUrl) { _rtDrapeFramedFor = _currentFileUrl; _rtDrape.frame(); }
    }
    window.rtToggleDrape = function () {
        if (_rtDrapeOn) { _rtDrapeDisabled = true; _rtDrapeOff(); }
        else {
            if (!_rtPlan) return;
            _rtDrapeDisabled = false;
            if (!_rtMapPanelVisible()) { rtToggleMapPanel(); return; }   // re-arms via the toggle
            _rtDrapeAuto();
        }
        _ga('rt_toggle_drape', { on: _rtDrapeOn });
    };

    // ── Cross-section picking on the draped map ──────────────────
    // Same compute as the Plotly path (rtFetchCrossSection); only the point
    // picking differs: map clicks → storm-relative km.
    var _rtCsMapA = null, _rtCsMapLayers = [], _rtCsMapRubber = null;
    function _rtCsMapClear() {
        if (_rtMap) {
            _rtCsMapLayers.forEach(function (l) { try { _rtMap.removeLayer(l); } catch (e) {} });
            if (_rtCsMapRubber) { try { _rtMap.removeLayer(_rtCsMapRubber); } catch (e) {} }
        }
        _rtCsMapLayers = []; _rtCsMapRubber = null; _rtCsMapA = null;
        var w = document.getElementById('rt-map-wrapper'); if (w) w.classList.remove('rt-cs-picking');
    }
    function _rtCsMapDot(ll) {
        return L.circleMarker(ll, { radius: 5, color: '#fff', weight: 1.5, fillColor: '#ef4444', fillOpacity: 1, interactive: false }).addTo(_rtMap);
    }
    function _rtCsMapMove(e) {
        if (!_rtCsMode || !_rtCsMapA || !_rtDrapeOn) return;
        var pts = [[_rtCsMapA.lat, _rtCsMapA.lng], [e.latlng.lat, e.latlng.lng]];
        if (!_rtCsMapRubber) _rtCsMapRubber = L.polyline(pts, { color: '#ef4444', weight: 2, dashArray: '5 5', interactive: false }).addTo(_rtMap);
        else _rtCsMapRubber.setLatLngs(pts);
    }
    function _rtCsMapClick(e) {
        if (!_rtCsMode || !_rtDrapeOn) return;
        var km = _rtDrape.kmFromLatLng(e.latlng); if (!km) return;
        var status = document.getElementById('rt-cs-status'), btn = document.getElementById('rt-cs-btn');
        if (!_rtCsMapA) {
            _rtCsMapA = e.latlng; _rtCsPointA = km;
            _rtCsMapLayers.push(_rtCsMapDot(e.latlng));
            if (btn) btn.textContent = '✂ Click point B on the map…';
            if (status) status.textContent = 'A: (' + km.x.toFixed(0) + ', ' + km.y.toFixed(0) + ') km — now click the end point';
        } else {
            var a = _rtCsPointA, b = km, llA = _rtCsMapA;
            _rtCsMode = false; _rtCsPointA = null;
            if (_rtCsMapRubber) { try { _rtMap.removeLayer(_rtCsMapRubber); } catch (e2) {} _rtCsMapRubber = null; }
            _rtCsMapA = null;
            _rtCsMapLayers.push(L.polyline([[llA.lat, llA.lng], [e.latlng.lat, e.latlng.lng]], { color: '#ef4444', weight: 2.5, interactive: false }).addTo(_rtMap));
            _rtCsMapLayers.push(_rtCsMapDot(e.latlng));
            var w = document.getElementById('rt-map-wrapper'); if (w) w.classList.remove('rt-cs-picking');
            if (btn) { btn.classList.remove('active'); btn.textContent = '✂ Cross Section'; }
            if (status) status.textContent = 'A→B: (' + a.x.toFixed(0) + ',' + a.y.toFixed(0) + ') → (' + b.x.toFixed(0) + ',' + b.y.toFixed(0) + ') km';
            rtFetchCrossSection(a, b);
        }
    }

    // ── Shear vector inset (uses SHIPS SDDC) ─────────────────────
    // Shear-heading label for the cross-section / azimuthal-mean panels (SHIPS
    // SDDC = downshear heading, SHDC kt); empty until SHIPS has loaded.
    function _rtPanelShearInset(isFullsize) {
        var sd = (_rtShipsData && _rtShipsData.ships_data) ? _rtShipsData.ships_data : {};
        return TDRView.shearInsetCS(sd.sddc != null ? sd.sddc : null, isFullsize, sd.shear_kt != null ? sd.shear_kt : null);
    }
    // Colormap for a panel: picker override > per-variable default (Jet for winds) > server default.
    function _rtColorscale(vi) {
        var sel = document.getElementById('rt-cmap');
        if (sel && sel.value) { try { return JSON.parse(sel.value); } catch (e) { return sel.value; } }
        return _rtDefaultCmapForVariable(vi.key || (document.getElementById('rt-var') || {}).value || '') || vi.colorscale;
    }
    // WCM RMW for the dashed RMW line: the panel's own value, else the plan view's
// (the azimuthal-mean / quadrant endpoints don't return it).
function _rtRmwKm(json) {
    if (json && json.wcm_rmw_km != null) return json.wcm_rmw_km;
    var pj = _rtLastPlotlyData && _rtLastPlotlyData.json;
    return pj ? pj.wcm_rmw_km : null;
}
function _rtWindMarker() { return _rtMaxMarkerEnabled && rtIsWindVariable((document.getElementById('rt-var') || {}).value || ''); }

    // Apply shear+motion inset to an already-rendered plan-view plot.
    // Shear/motion vectors now rendered as HTML compass in metadata strip only.
    // This function is kept as a no-op to avoid breaking callers.
    function _rtApplyShearInsetToPlot() {
        // No longer adds shear inset to Plotly; compass strip handles display
    }

    // ── Compass / intensity strip above the dual panel ────────────
    // Shear from SHIPS (SDDC = downshear heading, same as the archive -- no
    // flip); motion from SHIPS heading/speed, else the TDR file's U/V; Vmax
    // from SHIPS, else case_meta; RMW / tilt from the plan-view response.
    function _rtStripHTML(json) {
        var sd = (_rtShipsData && _rtShipsData.ships_data) ? _rtShipsData.ships_data : {};
        var meta = (json && json.case_meta) || _rtCaseMeta || {};
        var moDir = null, moSpd = null;
        if (sd.stm_heading_deg != null && sd.stm_speed_kt != null && sd.stm_speed_kt > 0) {
            moDir = sd.stm_heading_deg; moSpd = sd.stm_speed_kt;
        } else {
            var su = meta.storm_motion_east_ms, sv = meta.storm_motion_north_ms;
            if (su != null && sv != null && su !== -999 && sv !== -999) {
                var spdMs = Math.sqrt(su * su + sv * sv);
                if (spdMs > 0.1) {
                    moSpd = Math.round(spdMs * 1.94384 * 10) / 10;
                    moDir = ((90 - Math.atan2(sv, su) * 180 / Math.PI) % 360 + 360) % 360;
                }
            }
        }
        var j = json || (_rtLastPlotlyData && _rtLastPlotlyData.json) || {};
        return TDRView.metaStripHTML({
            vmax: sd.vmax_kt || meta.vmax_kt, rmw: j.wcm_rmw_km, tilt: j.tilt_2_6_km,
            sddc: (sd.sddc != null && sd.sddc !== 9999) ? sd.sddc : null, shdc: sd.shear_kt || null,
            motionDir: moDir, motionSpd: moSpd, sddcDisplay: sd.sddc
        });
    }
    // Called after SHIPS loads so the shear vector is incorporated.
    function _rtUpdateCompassStrip() {
        var html = _rtStripHTML(null);
        if (!html) return;
        var old = document.querySelector('.dual-panel-strip'), wrap = document.getElementById('rt-dual-panel-wrap');
        if (old) old.outerHTML = html;
        else if (wrap) wrap.insertAdjacentHTML('beforebegin', html);
    }

    // ── Overlay contours ─────────────────────────────────────────
    function rtBuildOverlayContours(json, x, y, isCS) {
        var intInput = document.getElementById('rt-contour-int');
        return TDRView.overlayContours(json, x, y, isCS, intInput ? parseFloat(intInput.value) : NaN);
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
        _rtDrapeRecolor();
    };

    window.rtApplyColorRange = function () {
        var zmin = _rtGetVmin(), zmax = _rtGetVmax(); if (zmin === null || zmax === null) return;
        ['rt-plotly-chart', 'rt-fullscreen-chart', 'rt-cs-fullscreen'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el && el.data && el.data.length) Plotly.restyle(el, { zmin: [zmin], zmax: [zmax] }, [0]);
        });
        _rtDrapeRecolor();
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
        _rtDrapeRecolor();
    };

    // ── Fullscreen modal (reuse the existing plotModal) ──────────
    window.rtOpenFullscreen = function () {
        if (!_rtLastPlotlyData) return;
        TDRView.openPlotModal();   // creates the dialog on this page (it had none)

        var d = _rtLastPlotlyData;
        var fullLayout = Object.assign({}, d.baseLayout, {
            title: { text: d.title, font: { color: '#0f1623', size: 14 }, y: 0.97, x: 0.5, xanchor: 'center', yanchor: 'top' },
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
        // While draped the plan view is the map, so the line is drawn there.
        var onMap = _rtDrapeOn;
        _rtCsMapClear();
        if (_rtCsMode) {
            btn.classList.add('active'); btn.textContent = '✂ Click point A on ' + (onMap ? 'the map…' : 'plot…');
            if (status) status.textContent = 'Click the starting point on the ' + (onMap ? 'map' : 'plan view above');
            if (onMap) { var w = document.getElementById('rt-map-wrapper'); if (w) w.classList.add('rt-cs-picking'); }
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

    // Multi-variable cross-section along the same A→B line (TDRView.runMultiSection,
    // shared with the TC-RADAR explorer).
    var _rtCsLastAB = null;
    var _RT_MCS_KEYS = { refl: 'REFLECTIVITY', vt: 'TANGENTIAL_WIND', vr: 'RADIAL_WIND', w: 'W', wspd: 'WIND_SPEED' };
    function _rtMcsKeyFor(id) { return _RT_MCS_KEYS[id] || null; }
    window.rtRunMultiCS = function () {
        if (!_rtCsLastAB || !_currentFileUrl) return;
        var a = _rtCsLastAB.a, b = _rtCsLastAB.b, p = _rtPlan, meta = _rtCaseMeta || {};
        _ga('rt_cross_section_multi', {});
        TDRView.runMultiSection({
            prefix: 'rt-', keyFor: _rtMcsKeyFor,
            fetch: function (key) {
                var url = API_BASE + RT_PREFIX + '/cross_section?file_url=' + encodeURIComponent(_currentFileUrl) +
                    '&variable=' + key + '&x0=' + a.x + '&y0=' + a.y + '&x1=' + b.x + '&y1=' + b.y + '&n_points=150';
                return fetch(url).then(function (r) { if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); });
            },
            endpoints: { x0: a.x, y0: a.y, x1: b.x, y1: b.y },
            locator: p ? { z: p.z, x: p.x, y: p.y, colorscale: p.colorscale, zmin: p.vmin, zmax: p.vmax } : null,
            title: (meta.storm_name || 'Real-Time TDR') + (meta.datetime ? ' | ' + meta.datetime : '') + ' \u2014 TDR cross-section (' +
                   Math.round(Math.hypot(b.x - a.x, b.y - a.y)) + ' km)',
            plot: function (id, t, l, c) { Plotly.newPlot(id, t, l, c); }
        });
    };

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
                _rtCsLastAB = { a: a, b: b };
                csResult.insertAdjacentHTML('beforeend', TDRView.multiSectionControlsHTML('rt-', _rtMcsKeyFor, 'rtRunMultiCS'));
            })
            .catch(function (err) { csResult.innerHTML = '<div class="explorer-status error">⚠️ ' + err.message + '</div>'; });
    }

    function rtRenderCrossSection(json) {
        // Render inline below the plan view
        var csResult = document.getElementById('rt-cs-result');
        csResult.innerHTML = '<div style="position:relative;"><div id="rt-cs-chart" style="width:100%;height:300px;border-radius:6px;overflow:hidden;margin-top:8px;"></div>' +
            _rtSaveBtnHTML('rt-cs-chart', 'TDR_CrossSection', 'position:absolute;top:14px;right:6px;z-index:10;') + '</div>';
        var ep = json.endpoints;
        var fig = TDRView.sectionFigure({
            z: json.cross_section, x: json.distance_km, y: json.height_km, varInfo: json.variable,
            colorscale: _rtColorscale(json.variable), zmin: _rtGetVmin(), zmax: _rtGetVmax(),
            title: 'Cross Section: (' + ep.x0.toFixed(0) + ',' + ep.y0.toFixed(0) + ') \u2192 (' + ep.x1.toFixed(0) + ',' + ep.y1.toFixed(0) + ') km' + TDRView.sectionTitleOverlay(json),
            xTitle: 'Distance along line (km)', maxLabels: ['Dist', 'Z'], size: 'small',
            margin: { l: 45, r: 12, t: json.overlay ? 62 : 44, b: 38 },
            windMarker: _rtWindMarker(),
            overlayTraces: rtBuildOverlayContours(json, null, null, true),
            inset: _rtPanelShearInset(false)
        });
        Plotly.newPlot('rt-cs-chart', fig.traces, fig.layout, { responsive: true, displayModeBar: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'] });
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

    // ── Save the MAP view (radar draped on IR) as a branded PNG ──
    // The drape, barbs, RMW ring and IR all render into the MapLibre canvas, so
    // one GL readback (the Live Flight export's glSnapshot) captures the science;
    // the title strip and colorbar are drawn here with the 2-D API (never
    // html2canvas — iOS Safari taints it). Falls back to the Plotly plan-view
    // save when the map isn't draped.
    window.rtSaveTDRMap = function () {
        var kit = window._ReconKit, glMap = _rtMap && _rtMap._gl;
        var p = _rtDrape && _rtDrape.isOn() ? _rtDrape.plan() : null;
        if (!p || !kit || !kit.glSnapshot || !glMap) {
            if (typeof rtSaveTDRView === 'function') return rtSaveTDRView();
            return;
        }
        var btn = document.getElementById('rt-map-save-btn');
        if (btn) btn.disabled = true;
        _ga('export_png', { chart: 'TDR_Map', module: 'realtime_tdr' });
        Promise.all([kit.glSnapshot(glMap), kit.watermarkReady ? kit.watermarkReady() : null]).then(function (r) {
            var snap = r[0];
            if (!snap || snap.__glBlank) throw new Error('the browser could not read the map canvas');
            var W = snap.width, H = snap.height;
            var cssW = (glMap.getCanvas().clientWidth || W), k = W / cssW;     // device-pixel scale
            var headH = Math.round(58 * k), footH = Math.round(46 * k);
            var c = document.createElement('canvas'); c.width = W; c.height = H + headH + footH;
            var x = c.getContext('2d');
            x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
            var meta = _rtCaseMeta || {};
            var lvl = p.level_km != null ? (p.level_km < 0.05 ? '10 m' : p.level_km.toFixed(1) + ' km') : '';
            var font = '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
            // Shrink a line's font until it fits the (possibly phone-narrow) width.
            var fit = function (str, px, weight, y, color) {
                var sz = px * k;
                do { x.font = (weight ? weight + ' ' : '') + Math.round(sz) + 'px ' + font; sz -= 0.5 * k; }
                while (x.measureText(str).width > W - 24 * k && sz > 8 * k);
                x.fillStyle = color; x.fillText(str, 12 * k, y);
            };
            x.textBaseline = 'top';
            fit((meta.storm_name || '') + '  \u00b7  ' + (meta.mission_id || '') + '  \u00b7  ' + (meta.datetime || ''), 17, '600', 9 * k, '#0f1623');
            var ext = TDRView.planExtremesText ? TDRView.planExtremesText(p) : '';
            fit((p.display_name || '') + (p.units ? ' (' + p.units + ')' : '') + '  \u00b7  ' + lvl + (ext ? '  \u00b7  ' + ext : ''), 13, '', 33 * k, '#374151');
            x.drawImage(snap, 0, headH);
            // Colorbar strip under the map.
            var lut = TDRView.csLUT(p.colorscale), gx = 12 * k, gy = H + headH + 10 * k, gw = Math.min(W * 0.55, 420 * k), gh = 12 * k;
            for (var i = 0; i < gw; i++) {
                var li = Math.round(i / (gw - 1) * 255) * 3;
                x.fillStyle = 'rgb(' + lut[li] + ',' + lut[li + 1] + ',' + lut[li + 2] + ')';
                x.fillRect(gx + i, gy, 1.5, gh);
            }
            x.strokeStyle = '#9ca3af'; x.lineWidth = 1; x.strokeRect(gx, gy, gw, gh);
            x.fillStyle = '#374151'; x.font = Math.round(11 * k) + 'px ' + font;
            x.fillText(String(Math.round(p.vmin * 100) / 100), gx, gy + gh + 3 * k);
            var mxs = String(Math.round(p.vmax * 100) / 100) + (p.units ? ' ' + p.units : '');
            x.fillText(mxs, gx + gw - x.measureText(mxs).width, gy + gh + 3 * k);
            var dataUrl = c.toDataURL('image/png');
            var fn = (_currentFileUrl || '').split('/').pop().replace(/_xy\.nc(\.gz)?$/i, '') || 'TDR';
            var name = 'TDR_Map_' + fn + '_' + (p.display_name || 'field').replace(/[^A-Za-z0-9]+/g, '') + '_' + lvl.replace(/\s+/g, '') + '.png';
            var done = function (blob) { TCExport.save(blob || dataUrl, name); if (btn) btn.disabled = false; };
            if (kit.stampExport) kit.stampExport(dataUrl, c.width, c.height, done, fn);
            else done(null);
        }).catch(function (e) {
            if (btn) btn.disabled = false;
            console.error('[rtSaveTDRMap]', e);
            if (typeof rtToast === 'function') rtToast('Could not save the map: ' + (e && e.message ? e.message : e), 'warn');
        });
    };

    // ── vol3d.js preset-view hooks (Views menu, IR floor, downshear camera) ──
    var _rt3DViewFetches = {};   // url -> Promise; one fetch per field/box per analysis
    window.vol3dFetchVolume = function (variable, box) {
        var url = API_BASE + RT_PREFIX + '/volume?file_url=' + encodeURIComponent(_currentFileUrl) +
            '&variable=' + variable + '&stride=' + box.stride + '&max_height_km=' + box.max_height_km +
            '&radius_km=' + box.radius_km + '&tilt_profile=true';
        if (!_rt3DViewFetches[url]) {
            _rt3DViewFetches[url] = fetch(url)
                .then(function (r) { if (!r.ok) return r.json().then(function (e) { throw new Error(e.detail || 'HTTP ' + r.status); }); return r.json(); })
                .catch(function (e) { delete _rt3DViewFetches[url]; throw e; });
        }
        return _rt3DViewFetches[url];
    };
    window.vol3dFloorImage = function () {
        if (!_rtIRData || !_rtIRData.bounds_km || !_rtIRFrameURLs.length) return null;
        var src = _rtIRFrameURLs[_rtIRAnimFrame] || _rtIRFrameURLs[0];
        if (!src) return null;
        var b = _rtIRData.bounds_km;
        return { src: src, x_min_km: b.x_min_km, x_max_km: b.x_max_km, y_min_km: b.y_min_km, y_max_km: b.y_max_km };
    };
    window.vol3dShearHeading = function () {
        var sd = _rtShipsData && _rtShipsData.ships_data;
        return (sd && sd.sddc != null) ? sd.sddc : null;
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
        _rtRunHooks('after3D');
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

        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
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

        var windStr = maxWind != null ? maxWind.toFixed(1) + ' m/s (' + Math.round(maxWind / 0.514444) + ' kt)' : 'N/A';
        var catStr = cat ? ' (' + cat + ')' : '';
        var popupHtml =
            '<div style="font-family:DM Sans,sans-serif;font-size:12px;line-height:1.5;min-width:180px;">' +
            '<strong style="font-size:14px;color:' + color + ';">' + (meta.storm_name || 'Unknown') + '</strong><br>' +
            '<span style="color:#aaa;">' + (meta.mission_id || '') + ' · ' + (meta.datetime || '') + '</span><br>' +
            '<span style="margin-top:4px;display:inline-block;">Max 2-km earth-rel. wind: <strong style="color:' + color + ';">' + windStr + catStr + '</strong></span><br>' +
            '<span style="color:#aaa;font-size:10px;">' +
            (meta.latitude ? meta.latitude.toFixed(2) + '°N, ' + Math.abs(meta.longitude).toFixed(2) + '°' + (meta.longitude < 0 ? 'W' : 'E') : '') +
            '</span></div>';
        _rtMapMarker.bindPopup(popupHtml, { maxWidth: 280, minWidth: 200 });
        // While the radar field is draped the dot would cover the eye; the RMW
        // ring marks the centre instead. _rtDrapeOff puts the marker back.
        if (_rtDrapeOn) { try { _rtMap.removeLayer(_rtMapMarker); } catch (e) {} }
    }

    function _rtFetchMaxWind(fileUrl, meta) {
        // Max EARTH-RELATIVE wind at 2 km (explicitly earth-relative, so the
        // number means the same thing whatever frame the plan view is in).
        var url = API_BASE + RT_PREFIX + '/data?file_url=' + encodeURIComponent(fileUrl) +
            '&variable=EARTH_REL_WSPD&level_km=2';
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
                _rtShowMaxWindLine(fileUrl);
            })
            .catch(function () {
                _rtMaxWind2km = null;
                _rtUpdateMapMarker(meta, null);
                _rtShowMaxWindLine(fileUrl);
            });
    }

    function _rtShowMaxWindLine(fileUrl) {
        var el = document.getElementById('rt-maxwind-line');
        if (!el || fileUrl !== _currentFileUrl) return;
        if (_rtMaxWind2km == null) { el.textContent = ''; return; }
        var kt = Math.round(_rtMaxWind2km / 0.514444), cat = _rtWindCategory(_rtMaxWind2km);
        el.innerHTML = 'Max 2-km TDR wind (earth-rel.): <strong style="color:' + _rtWindColor(_rtMaxWind2km) + ';">' +
            _rtMaxWind2km.toFixed(1) + ' m/s \u00b7 ' + kt + ' kt</strong>' + (cat ? ' (' + cat + ')' : '');
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
            // Full opacity so the left-panel IR reads like the Global Map's
            // satellite (crisp, not washed to grey over the basemap). This map
            // shows IR as the primary imagery — the faint, see-through underlay
            // is only the plan-view panel, where the radar draws on top and the
            // opacity is intentional (and slider-controlled).
            _rtIRMapOverlay = L.imageOverlay(url, bounds, {
                opacity: 1.0, interactive: false, zIndex: 200
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
        // Mirror play state on the content-panel Loop pill (the map play button
        // may be hidden when the geographic map is collapsed).
        var loopPill = document.getElementById('rt-ir-play-btn');
        if (loopPill) loopPill.classList.toggle('active', _rtMapIRAnimPlaying);
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
        _rtRunHooks('cleanupMap');
        _rtRemoveIRFromMap();
        _rtIRMapVisible = true;
        _rtIRMapBoundsSet = false;
        _rtMaxWind2km = null;
        _rtPlan = null; _rtDrapeFramedFor = null;
        if (_rtDrapeOn) _rtDrapeOff(); else _rtDrapeSyncBtn();
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
        var vi = json.variable, meta = json.case_meta || {};
        var covPct = Math.round((json.coverage_min || 0.5) * 100);
        var intInput = document.getElementById('rt-contour-int');
        var fig = TDRView.sectionFigure({
            z: json.azimuthal_mean, x: json.radius_km, y: json.height_km, varInfo: vi,
            colorscale: _rtColorscale(vi), zmin: _rtGetVmin(), zmax: _rtGetVmax(),
            title: (meta.storm_name || 'Real-Time TDR') + ' | ' + (meta.datetime || '') + '<br>Azimuthal Mean: ' + vi.display_name + ' (\u2265' + covPct + '%)',
            size: 'dual', margin: { l: 48, r: 14, t: json.overlay ? 78 : 68, b: 44 }, rmwX: _rtRmwKm(json),
            windMarker: _rtWindMarker(),
            overlayTraces: TDRView.contourTraces(json.overlay, json.overlay && json.overlay.azimuthal_mean, json.radius_km, json.height_km, intInput ? parseFloat(intInput.value) : NaN)
        });
        container.innerHTML = '<div id="rt-dual-az-chart" style="width:100%;height:100%;min-height:320px;"></div>';
        Plotly.newPlot('rt-dual-az-chart', fig.traces, fig.layout, { responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d','select2d','toggleSpikelines'], displaylogo: false });
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
            '<button onclick="rtOpenFullscreen()" title="Expand to fullscreen" style="position:absolute;top:6px;right:6px;z-index:10;background:rgba(15, 22, 35,0.08);border:none;color:#5b6573;font-size:16px;width:30px;height:30px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;" onmouseover="this.style.background=\'rgba(15, 22, 35,0.2)\'" onmouseout="this.style.background=\'rgba(15, 22, 35,0.08)\'">\u26F6</button></div>' +
            '<div style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Radius\u2013height azimuthal mean \u00b7 hover for values \u00b7 \u26F6 expand</div>';
        var vi = json.variable, meta = json.case_meta || {};
        var covPct = Math.round((json.coverage_min || 0.5) * 100);
        var intInput = document.getElementById('rt-contour-int');
        var fig = TDRView.sectionFigure({
            z: json.azimuthal_mean, x: json.radius_km, y: json.height_km, varInfo: vi,
            colorscale: _rtColorscale(vi), zmin: _rtGetVmin(), zmax: _rtGetVmax(),
            title: (meta.storm_name || 'Real-Time TDR') + ' | ' + (meta.datetime || '') + '<br>Azimuthal Mean: ' + vi.display_name + ' (\u2265' + covPct + '% coverage)' + TDRView.sectionTitleOverlay(json),
            size: 'small', rmwX: _rtRmwKm(json),
            margin: { l: 45, r: 12, t: json.overlay ? 78 : 64, b: 38 },
            windMarker: _rtWindMarker(),
            overlayTraces: TDRView.contourTraces(json.overlay, json.overlay && json.overlay.azimuthal_mean, json.radius_km, json.height_km, intInput ? parseFloat(intInput.value) : NaN),
            inset: _rtPanelShearInset(false)
        });
        Plotly.newPlot('rt-az-chart', fig.traces, fig.layout, { responsive: true, displayModeBar: false, displaylogo: false });
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
        _rtIRUserToggledOff = false;   // next analysis defaults IR back on
        _rtIRAllLoaded = false;
        _rtIRLoadedCount = 0;
        _rtIRFetching = false;
        _rtIRMapBoundsSet = false;
        var irBtn = document.getElementById('rt-ir-underlay-btn');
        if (irBtn) { irBtn.disabled = true; irBtn.innerHTML = _icon('satellite') + 'IR Off'; irBtn.classList.remove('active'); }
        var irPlayBtn = document.getElementById('rt-ir-play-btn');
        if (irPlayBtn) { irPlayBtn.disabled = true; irPlayBtn.classList.remove('active'); }
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

                // Enable the Plotly underlay button — and turn the IR underlay
                // ON by default once frame0 is available (unless the user has
                // explicitly toggled it off for this analysis).
                var irBtn = document.getElementById('rt-ir-underlay-btn');
                if (irBtn && json.frame0) {
                    irBtn.disabled = false;
                    if (!_rtIRUserToggledOff) {
                        _rtIRPlotlyVisible = true;
                        irBtn.classList.add('active');
                        irBtn.innerHTML = _icon('satellite') + 'IR';
                        _rtApplyIRUnderlay();
                    }
                }
                // Enable the content-panel IR Loop control (animates the plan-view
                // background — usable even when the geographic map is collapsed).
                var irPlayBtn = document.getElementById('rt-ir-play-btn');
                if (irPlayBtn && json.frame0) irPlayBtn.disabled = false;

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
            // Enable the play/step controls once there's more than one frame,
            // but DON'T auto-play — default to the still frame closest to the
            // analysis time (frame 0 = t=0). Auto-animating on every load was
            // distracting and inconsistent with the rest of the site, where the
            // satellite loop is opt-in. The user can press play when they want it.
            if (_rtIRLoadedCount >= 2) _rtEnableIRAnimControls();
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
    // Collapse / expand the left geographic map so the plan view can go
    // full-width. The IR loop still animates the plan-view background via the
    // Loop pill, so hiding the map doesn't lose the animation.
    window.rtToggleMapPanel = function () {
        var layoutEl = document.querySelector('.rt-viz-layout');
        if (!layoutEl) return;
        var collapsed = layoutEl.classList.toggle('rt-map-collapsed');
        var btn = document.getElementById('rt-map-toggle-btn');
        if (btn) btn.classList.toggle('active', !collapsed);
        _rtFocusLayoutSync();
        // Reflow after the layout settles: a window resize event reflows every
        // responsive Plotly chart; re-showing the map needs a size recompute
        // (it was display:none, so Leaflet/GL measured 0×0).
        setTimeout(function () {
            try { window.dispatchEvent(new Event('resize')); } catch (e) {}
            if (!collapsed && _rtMap) { try { _rtMap.invalidateSize(); } catch (e) {} }
            // The drape needs a visible map: collapsing brings the Plotly plan
            // pane back, reopening drapes again (unless the user turned it off).
            _rtDrapeAuto();
        }, 60);
        if (typeof _ga === 'function') _ga('rt_toggle_map_panel', { collapsed: collapsed });
    };

    // ── Explorer focus-mode layout (2026-09-28) ──────────────────
    // With the map open the panel uses the explorer's focus-mode layout and
    // CSS (.tdr-focus-panel): Explore Data grid + "More options", View row,
    // Analysis grid, results as tabs, map-drawn layer pills on the map. With the
    // map collapsed it falls back to the stacked panel + controls rail.
    var _RT_MAP_LAYER_PILLS = ['rt-fl-btn', 'rt-sonde-btn', 'rt-mw-overlay-btn', 'rt-nexrad-btn', 'rt-barb-btn'];
    var _RT_WIDE_MQ = window.matchMedia ? window.matchMedia('(min-width: 1025px)') : null;
    var _rtAzTabLabel = 'Azim. Mean';
    // The panel keeps the focus layout either way (collapsing the map just
    // widens it); only the on-map overlay bar follows the map.
    function _rtFocusOn() { return true; }
    var _rtResultTabs = TDRView.createResultTabs({
        host: function () { return document.getElementById('rt-results'); },
        barId: 'rt-result-tabs', defaultId: 'rt-display-area',
        enabled: _rtFocusOn,
        tabs: [
            { id: 'rt-display-area', label: function () { return 'Overview'; } },
            { id: 'rt-az-result', label: function () { return _rtAzTabLabel; } },
            { id: 'rt-anomaly-result', label: function () { return 'Z* Anomaly'; } },
            { id: 'rt-quad-result', label: function () { return 'Shear Quads'; } },
            { id: 'rt-cs-result', label: function () { return 'Cross Section'; } },
            { id: 'rt-vp-result', label: function () { return 'VP Scatter'; } },
            { id: 'rt-ctrk-result', label: function () { return 'Center Track'; } }
        ]
    });
    function _rtFocusLayoutSync() {
        TDRView.syncMapLayerBar({
            on: _rtMapPanelVisible() && (!_RT_WIDE_MQ || _RT_WIDE_MQ.matches), host: document.getElementById('rt-map-wrapper'),
            strip: document.querySelector('.rt-viz-content-panel .overlay-strip'),
            pillIds: _RT_MAP_LAYER_PILLS, barId: 'map-layer-bar',
            scrollTo: { 'rt-mw-overlay-btn': 'rt-mw-overpass-panel', 'rt-nexrad-btn': 'rt-nexrad-panel' }
        });
        _rtResultTabs.sync();
    }
    (function _rtFocusLayoutInit() {
        var acts = document.getElementById('rt-cs-btn');
        acts = acts && acts.closest('.action-section');
        if (acts) acts.addEventListener('click', function (e) {
            var b = e.target.closest && e.target.closest('button');
            if (!b) return;
            if (b.id === 'rt-az-btn') _rtAzTabLabel = 'Azim. Mean';
            else if (b.id === 'rt-cfad-btn') _rtAzTabLabel = 'CFAD';
        }, true);
        try {
            if (localStorage.getItem('rt_explorer_more') === '1') {
                var c = document.querySelector('.rt-viz-content-panel .explorer-controls');
                if (c) c.classList.add('show-more');
                var mb = document.getElementById('rt-more-btn');
                if (mb) { mb.textContent = 'Fewer options ▴'; mb.setAttribute('aria-expanded', 'true'); }
            }
        } catch (e) {}
        _rtResultTabs.init();
        _rtFocusLayoutSync();
        if (_RT_WIDE_MQ && _RT_WIDE_MQ.addEventListener) _RT_WIDE_MQ.addEventListener('change', _rtFocusLayoutSync);
    })();
    window.rtToggleExplorerMore = function () {
        var c = document.querySelector('.rt-viz-content-panel .explorer-controls');
        var b = document.getElementById('rt-more-btn');
        if (!c) return;
        var on = c.classList.toggle('show-more');
        if (b) { b.textContent = on ? 'Fewer options ▴' : 'More options ▾'; b.setAttribute('aria-expanded', on ? 'true' : 'false'); }
        try { localStorage.setItem('rt_explorer_more', on ? '1' : '0'); } catch (e) {}
    };
    // "Azim. mean in" picker (the Z* anomaly used to be its own button).
    window.rtDispatchAzimuthalMean = function () {
        var mode = (document.getElementById('rt-az-coord-mode') || {}).value || 'standard';
        if (mode === 'anomaly') {
            var zb = document.getElementById('rt-anomaly-btn');
            if (zb && zb.disabled) { rtToast('Z* anomaly needs SHIPS (Vmax) — still loading.', 'warn'); return; }
            rtFetchAnomaly();
        } else rtFetchAzimuthalMean();
    };
    window.rtAzCoordChanged = function () {
        var btn = document.getElementById('rt-az-btn');
        if (btn && !btn.disabled) rtDispatchAzimuthalMean();
    };

    window.rtToggleIRUnderlay = function () {
        _rtIRPlotlyVisible = !_rtIRPlotlyVisible;
        _rtIRUserToggledOff = !_rtIRPlotlyVisible;  // remember an explicit off
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
            opacity: _rtIROpacity,
            layer: 'below',
            _rtIRUnderlay: true,
        };
    }

    // Slider handler: update IR underlay opacity live (0–1).
    window.rtSetIROpacity = function (val) {
        _rtIROpacity = Math.max(0, Math.min(1, parseFloat(val)));
        var lbl = document.getElementById('rt-ir-opacity-val');
        if (lbl) lbl.textContent = Math.round(_rtIROpacity * 100) + '%';
        if (_rtIRPlotlyVisible) _rtApplyIRUnderlay();
    };

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

    // ── Coastline overlay (storm-relative km) ─────────────────────
    // Projects Natural Earth coastlines into the plan-view's km frame
    // (equirectangular about the grid origin = storm center), so they line up
    // with the IR underlay and export with the saved image.
    var _rtCoastVisible = true;   // on by default — geographic context on the plan view
    var _rtCoastGeoJSON = null;   // cached Natural Earth FeatureCollection
    var _rtCoastLoading = false;

    function _rtLoadCoastline(cb) {
        if (_rtCoastGeoJSON) { if (cb) cb(); return; }
        if (_rtCoastLoading) return;
        _rtCoastLoading = true;
        fetch('assets/coastlines/ne_10m_coastline.geojson')
            .then(function (r) { return r.json(); })
            .then(function (gj) { _rtCoastGeoJSON = gj; _rtCoastLoading = false; if (cb) cb(); })
            .catch(function () {
                _rtCoastLoading = false;
                if (typeof rtToast === 'function') rtToast('Coastline data unavailable', 'warn');
            });
    }

    // Build a Plotly lines trace of coastlines in storm-relative km, clipped to
    // the plot domain. Returns null if no data / no center / nothing in view.
    function _rtBuildCoastTrace(meta) {
        if (!_rtCoastGeoJSON || !meta) return null;
        var lat0 = meta.latitude, lon0 = meta.longitude;
        if (lat0 == null || lon0 == null || (lat0 === 0 && lon0 === 0)) return null;
        var kmPerDegLat = 110.574;
        var kmPerDegLon = 111.320 * Math.cos(lat0 * Math.PI / 180);
        // Half-extent to project. Kept wider than the ±250 km default plot so the
        // coast stays drawn when the user scrolls to zoom / drags to pan out, and
        // so it spans the full IR underlay box (~±440 km at these latitudes).
        var RANGE = 500;  // km half-extent
        var dLat = RANGE / kmPerDegLat + 0.5;
        var dLon = RANGE / Math.max(1e-3, kmPerDegLon) + 0.5;
        var xs = [], ys = [];
        function addSeg(coords) {
            var started = false;
            for (var i = 0; i < coords.length; i++) {
                var lon = coords[i][0], lat = coords[i][1];
                if (lat < lat0 - dLat || lat > lat0 + dLat ||
                    lon < lon0 - dLon || lon > lon0 + dLon) {
                    if (started) { xs.push(null); ys.push(null); started = false; }
                    continue;
                }
                xs.push((lon - lon0) * kmPerDegLon);
                ys.push((lat - lat0) * kmPerDegLat);
                started = true;
            }
            if (started) { xs.push(null); ys.push(null); }
        }
        var feats = _rtCoastGeoJSON.features || [];
        for (var f = 0; f < feats.length; f++) {
            var g = feats[f].geometry;
            if (!g) continue;
            if (g.type === 'LineString') addSeg(g.coordinates);
            else if (g.type === 'MultiLineString') {
                for (var k = 0; k < g.coordinates.length; k++) addSeg(g.coordinates[k]);
            }
        }
        if (!xs.length) return null;
        return {
            x: xs, y: ys, type: 'scatter', mode: 'lines',
            line: { color: 'rgba(15,22,35,0.55)', width: 1 },
            hoverinfo: 'skip', showlegend: false, _rtCoast: true,
        };
    }

    window.rtToggleCoast = function () {
        var btn = document.getElementById('rt-coast-btn');
        _rtCoastVisible = !_rtCoastVisible;
        if (btn) btn.classList.toggle('active', _rtCoastVisible);
        if (_rtCoastVisible && !_rtCoastGeoJSON) {
            _rtLoadCoastline(function () { rtGeneratePlot(); });
        } else {
            rtGeneratePlot();
        }
    };

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
                bgcolor: 'rgba(255,255,255,0.85)', bordercolor: '#3b82f6', borderwidth: 1, borderpad: 2,
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
                bgcolor: 'rgba(255,255,255,0.85)', bordercolor: '#f59e0b', borderwidth: 1, borderpad: 2,
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
            paper_bgcolor: '#ffffff',
            plot_bgcolor: '#ffffff',
            xaxis: {
                title: { text: 'Wind Speed (m/s)', font: { color: '#22c55e', size: 12 } },
                tickfont: { color: '#22c55e', size: 10 },
                gridcolor: _tdrGrid(),
                zeroline: true, zerolinecolor: _tdrGrid(),
                side: 'bottom',
            },
            xaxis2: {
                title: { text: 'Temperature (\u00b0C)', font: { color: '#ef4444', size: 11 } },
                tickfont: { color: '#ef4444', size: 9 },
                gridcolor: 'rgba(239,68,68,0.08)',
                side: 'top', overlaying: 'x', anchor: 'y',
            },
            yaxis: {
                title: { text: 'Pressure (hPa)', font: { color: '#5b6573', size: 12 } },
                tickfont: { color: '#5b6573', size: 10 },
                gridcolor: _tdrGrid(),
                autorange: 'reversed', type: 'log',
                range: [Math.log10(pMax), Math.log10(pMin)],
                dtick: 'D1',
            },
            yaxis2: {
                title: { text: 'Altitude (km)', font: { color: '#5b6573', size: 11 } },
                tickfont: { color: '#5b6573', size: 9 },
                side: 'right', overlaying: 'y', type: 'log',
                range: [Math.log10(pMax), Math.log10(pMin)],
                tickvals: altTickVals, ticktext: altTickText,
                showgrid: false,
            },
            margin: { l: 55, r: 55, t: 70, b: 82 },
            legend: { x: 0.01, y: 0.01, bgcolor: 'rgba(255,255,255,0.85)', font: { color: '#0f1623', size: 10 },
                      xanchor: 'left', yanchor: 'bottom' },
            showlegend: true,
            shapes: shapes,
            annotations: annotations,
            hoverlabel: { bgcolor: '#ffffff', font: { color: '#0f1623', size: 11 } },
        };

        // On-plot title and info annotations (visible in saved PNG)
        // Position title above the top x-axis (temperature) so they don't overlap
        layout.annotations.push({
            text: plotTitleLine,
            xref: 'paper', yref: 'paper', x: 0.5, y: 1.14,
            showarrow: false, font: { color: '#0f1623', size: 11 }, xanchor: 'center',
        });
        layout.annotations.push({
            text: plotInfoParts.join(' \u00b7 '),
            xref: 'paper', yref: 'paper', x: 0.5, y: -0.18,
            showarrow: false, font: { color: '#5b6573', size: 9.5 }, xanchor: 'center', yanchor: 'top',
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
        // Every isosurface (a preset view has several), not just trace 0.
        var idx = [];
        chartDiv.data.forEach(function (t, i) { if (t.type === 'isosurface') idx.push(i); });
        Plotly.restyle(chartDiv, { visible: vis }, idx);
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
    _rtOn('beforeExplore', _rtSondeCleanup);

    // ── Hook: patch rtRenderPlot to re-add sondes after re-render ──
    _rtOn('afterRender', function () {
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
    });

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
    _rtOn('after3D', function () {
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
    });

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

            // Hover keeps only the TDR@FL value (0.5/2.0 km comparisons stay
            // available in the time-series chart).
            var tdrStr = '';
            if (o.tdr_wspd_fl_alt != null) {
                var altKm = (o.gps_alt_m != null) ? (o.gps_alt_m / 1000).toFixed(2) + ' km' : '?';
                tdrStr = 'TDR@FL (' + altKm + '): ' + o.tdr_wspd_fl_alt.toFixed(1) + ' m/s';
            }

            var tOffsetMin = (o.time_offset_s != null && isFinite(o.time_offset_s)) ? (o.time_offset_s / 60) : null;
            var timeStr = (o.time || '') + ' UTC';
            if (tOffsetMin != null) timeStr += ' (T' + (tOffsetMin >= 0 ? '+' : '') + tOffsetMin.toFixed(1) + ' min)';

            var altStr = '';
            if (o.gps_alt_m != null && isFinite(o.gps_alt_m)) {
                altStr = 'Alt: ' + o.gps_alt_m.toFixed(0) + ' m (' + Math.round(o.gps_alt_m * 3.28084) + ' ft)<br>';
            }

            // Aircraft position (lat/lon)
            var posStr = '';
            if (o.lat != null && o.lon != null && isFinite(o.lat) && isFinite(o.lon)) {
                posStr = 'Lat/Lon: ' + Math.abs(o.lat).toFixed(3) + '\u00b0' + (o.lat >= 0 ? 'N' : 'S') +
                    ', ' + Math.abs(o.lon).toFixed(3) + '\u00b0' + (o.lon >= 0 ? 'E' : 'W') + '<br>';
            }

            texts.push(
                '<b>\u2708 Flight Level</b><br>' +
                'Wind: ' + (ws != null ? ws.toFixed(1) + ' m/s (' + (ws * 1.94384).toFixed(0) + ' kt)' : 'N/A') + '<br>' +
                'Wind Dir: ' + (o.fl_wdir_deg != null ? o.fl_wdir_deg.toFixed(0) + '\u00b0' : 'N/A') + '<br>' +
                altStr +
                (tdrStr ? tdrStr + '<br>' : '') +
                posStr +
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

        // Layout with up to 4 y-axes — driven by the site theme vars (light/dark)
        // so the panel matches the rest of the monitor instead of a fixed muddy
        // translucent grey. tc_radar_styles.css defines these for both themes.
        var _flCS = getComputedStyle(document.documentElement);
        function _flVar(n, f) { return (_flCS.getPropertyValue(n) || '').trim() || f; }
        var flPaper = _flVar('--plot-paper', '#ffffff');
        var flBg    = _flVar('--plot-bg', '#ffffff');
        var flInk   = _flVar('--text', '#334155');
        var flInkDim = _flVar('--text-dim', '#5b6573');
        var gridColor = _flVar('--plot-grid', 'rgba(148,163,184,0.15)');
        var layout = {
            paper_bgcolor: flPaper,
            plot_bgcolor: flBg,
            // Top margin holds the legend strip (see below) so it stops covering
            // the traces it describes — the wind peaks sit exactly where the old
            // top-right vertical legend floated.
            margin: { l: 55, r: 55, t: 44, b: 40 },
            font: { family: 'DM Sans, sans-serif', size: 11, color: flInkDim },
            legend: {
                // Horizontal strip ABOVE the plot (was a floating box INSIDE it).
                orientation: 'h', x: 0, xanchor: 'left', y: 1.0, yanchor: 'bottom',
                font: { size: 9, color: flInkDim },
                // Match the (theme-aware) plot surface so the strip reads on both
                // light and dark rather than being a fixed light slab.
                bgcolor: flPaper,
                bordercolor: gridColor, borderwidth: 1,
                traceorder: 'grouped', tracegroupgap: 4,
            },
            hovermode: 'x unified',
            xaxis: {
                title: { text: 'Minutes from Analysis Time', font: { size: 11 } },
                color: flInkDim,
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
                // Theme-aware stats inset: paper-coloured fill + primary ink so it
                // reads on both light and dark (was a fixed light slab).
                font: { family: 'DM Sans, sans-serif', size: 10, color: flInk },
                align: 'left',
                xanchor: 'left',
                yanchor: 'top',
                bgcolor: flPaper,
                bordercolor: gridColor,
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
    _rtOn('beforeExplore', function () { _rtFLCleanup(); window.rtFLCloseTimeSeries(); });

    // ── Patch _rtCleanupMap to also remove FL layers ──────────
    _rtOn('cleanupMap', function () {
        _rtRemoveFLFromMap();
        if (_rtFLTSHighlight) {
            _rtMap.removeLayer(_rtFLTSHighlight);
            _rtFLTSHighlight = null;
        }
    });

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
        var atcfTag = data.atcf_id ? ' <span style="color:var(--slate);font-weight:400;">(' + data.atcf_id + ')</span>' : '';
        var autoTag = data.auto_detected ? ' <span style="color:var(--um-green, #005030);font-size:9px;font-weight:600;">auto</span>' : '';

        var sumBits = [];
        if (sd.vmax_kt != null) sumBits.push('Vmax ' + sd.vmax_kt + ' kt');
        if (sd.shear_kt != null) sumBits.push('shear ' + sd.shear_kt + ' kt' + (sd.sddc != null ? ' / ' + sd.sddc + '\u00b0' : ''));
        var rows = [
            '<details class="rt-meta-more"><summary>SHIPS environment' + atcfTag + autoTag + (sumBits.length ? ' <span class="rt-meta-sum">\u00b7 ' + sumBits.join(' \u00b7 ') + '</span>' : '') + '</summary>',
            '<table style="width:100%;font-size:10px;color:var(--text, #0f1623);border-collapse:collapse;">',
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
            rows.push('<tr><td style="padding:1px 4px;color:var(--slate);white-space:nowrap;">' + f[0] + '</td>' +
                '<td style="padding:1px 4px;text-align:right;font-variant-numeric:tabular-nums;color:var(--text, #0f1623);">' + f[1] + '</td></tr>');
        });

        rows.push('</table></details>');
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
        container.innerHTML =
            '<div class="storm-timeline-panel" style="margin-top:10px;">' +
            '<div class="fl-ts-header">' +
            '<span class="fl-ts-title">\u2299 Shear-Relative Quadrant Means (SDDC: ' + data.sddc + '\u00b0)</span>' +
            _rtSaveBtnHTML('rt-quad-chart', 'QuadrantMeans', 'margin-left:auto;') +
            '<button onclick="document.getElementById(\'rt-quad-result\').innerHTML=\'\'" class="fl-ts-close" title="Close">&times;</button>' +
            '</div>' +
            '<div id="rt-quad-chart" style="width:100%;height:550px;border-radius:6px;overflow:hidden;"></div>' +
            '</div>';
        // The quadrant endpoint returns the variable KEY only; take the display info from the plan view.
        var pj = (_rtLastPlotlyData && _rtLastPlotlyData.json) || {};
        var varInfo = pj.variable || { display_name: variable, units: '', vmin: 0, vmax: 80, colorscale: 'RdBu' };
        var covPct = Math.round((data.coverage_min || 0.5) * 100);
        var intInput = document.getElementById('rt-contour-int');
        var fig = TDRView.quadrantFigure(data, {
            varInfo: varInfo, colorscale: _rtColorscale(varInfo), zmin: _rtGetVmin(), zmax: _rtGetVmax(),
            rmw: pj.wcm_rmw_km, sddc: data.sddc, contourInterval: intInput ? parseFloat(intInput.value) : NaN,
            title: 'Shear-Relative Quadrant Mean: ' + varInfo.display_name + ' (\u2265' + covPct + '% cov.)' + TDRView.sectionTitleOverlay(data)
        });
        Plotly.newPlot('rt-quad-chart', fig.traces, fig.layout, { responsive: true, displayModeBar: false, displaylogo: false });
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
    function _rtBuildHybridXAxis(rHAxis, nInner) { return TDRView.hybridXAxis(rHAxis, nInner); }

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
                '<div style="font-size:9px;color:var(--slate);padding:2px 8px;">' + climNote + '</div>' +
                '<div id="rt-anomaly-chart" style="width:100%;height:320px;"></div>' +
            '</div>';
        var fig = TDRView.anomalyFigure(data, { citation: false });
        Plotly.newPlot('rt-anomaly-chart', fig.traces, fig.layout, { responsive: true, displayModeBar: false, displaylogo: false });
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
        // Same figure as the explorer (paper ellipses); the star is the live storm.
        var fig = TDRView.vpScatterFigure(Object.assign({}, json, { color_by: json.color_by || colorBy }), {
            current: currentVP != null ? { vp: currentVP, vf: currentVF, vh: currentVH, vw: currentVW,
                label: stormName || 'Current', vmax: currentVmax, annotate: true } : null });
        if (fig.message) {
            container.querySelector('#rt-vp-chart').innerHTML = '<div style="color:var(--slate);text-align:center;padding:40px;">' + fig.message + '</div>';
            return;
        }
        Plotly.newPlot('rt-vp-chart', fig.traces, fig.layout, { responsive: true, displayModeBar: false, displaylogo: false });
    }

    // ── Center Track: 2-km (L) + 6-km (M) TDR centres over IR ────
    // Plots the evolution of the vortex centre across every sweep in the current
    // mission, in lat/lon, over a single GOES IR frame. L = 2 km, M = 6 km.

    var _rtCtrkLoading = false;
    var _rtCtrkOverlay = false;   // when on, the plan view shows the centre track (wind field hidden)
    var _rtCtrkData = null;       // cached /center_track response (keyed by mission)

    function _rtCurrentMission() {
        var sel = document.getElementById('rt-mission-select');
        return sel ? (sel.value || '') : '';
    }

    // Center Track is a plan-view MODE: it hides the wind field and draws the
    // mission's 2/6 km WCM centres (all sweeps) over the IR underlay + coastlines,
    // in this sweep's storm-relative km frame. The table sits below the map.
    window.rtToggleCenterTrack = function () {
        var btn = document.getElementById('rt-ctrk-btn');
        var tableEl = document.getElementById('rt-ctrk-result');
        // Toggle OFF → the wind field returns on the next render.
        if (_rtCtrkOverlay) {
            _rtCtrkOverlay = false;
            if (btn) btn.classList.remove('active');
            if (tableEl) tableEl.innerHTML = '';
            rtGeneratePlot();
            return;
        }
        if (!_currentFileUrl) {
            if (tableEl) tableEl.innerHTML = '<div style="color:var(--slate);padding:10px;font-size:12px;">Load an analysis first.</div>';
            return;
        }
        var mission = _rtCurrentMission();
        if (!mission) {
            if (tableEl) tableEl.innerHTML = '<div style="color:var(--slate);padding:10px;font-size:12px;">Select a mission first.</div>';
            return;
        }
        // Cached for this mission → flip on instantly.
        if (_rtCtrkData && _rtCtrkData.mission === mission && _rtCtrkData.points && _rtCtrkData.points.length) {
            _rtCtrkOverlay = true;
            if (btn) btn.classList.add('active');
            rtGeneratePlot();
            _rtRenderCenterTrackTable();
            return;
        }
        if (_rtCtrkLoading) return;
        _rtCtrkLoading = true;
        if (btn) { btn.classList.add('active'); btn.disabled = true; }
        if (tableEl) tableEl.innerHTML = '<div style="color:var(--slate);padding:10px;font-size:12px;">Solving 2-km &amp; 6-km centres for each sweep… (first load may take ~20-40s)</div>';

        var ctUrl = API_BASE + RT_PREFIX + '/center_track?mission=' + encodeURIComponent(mission) + '&max_files=30';
        fetch(ctUrl, { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('center_track ' + r.status); return r.json(); })
            .then(function (json) {
                _rtCtrkData = json;
                if (!json.points || !json.points.length) {
                    _rtCtrkOverlay = false;
                    if (btn) btn.classList.remove('active');
                    if (tableEl) tableEl.innerHTML = '<div style="color:var(--slate);padding:10px;font-size:12px;">No converged 2-km / 6-km centres in this mission yet.</div>';
                    return;
                }
                _rtCtrkOverlay = true;
                rtGeneratePlot();
                _rtRenderCenterTrackTable();
                _ga('center_track', { module: 'realtime_tdr', mission: mission });
            })
            .catch(function (e) {
                _rtCtrkOverlay = false;
                if (btn) btn.classList.remove('active');
                if (tableEl) tableEl.innerHTML = '<div style="color:#f87171;padding:10px;font-size:12px;">Could not build center track: ' + (e && e.message ? e.message : e) + '</div>';
            })
            .finally(function () { _rtCtrkLoading = false; if (btn) btn.disabled = false; });
    };

    // Project the mission's 2/6 km centres (lat/lon) into THIS sweep's storm-
    // relative km frame (the same projection the coastline overlay uses) and
    // return plan-view traces + time-label annotations + a title.
    function _rtBuildCenterTrackTraces(meta) {
        var pts = (_rtCtrkData && _rtCtrkData.points) || [];
        var lat0 = meta && meta.latitude, lon0 = meta && meta.longitude;
        if (lat0 == null || lon0 == null || !pts.length) return { traces: [], annotations: [], title: 'Center Track' };
        var kLat = 110.574, kLon = 111.320 * Math.cos(lat0 * Math.PI / 180);
        var x2 = [], y2 = [], cd2 = [], x6 = [], y6 = [], cd6 = [], ann = [];
        pts.forEach(function (p) {
            if (p.lat2 != null) {
                var xa = (p.lon2 - lon0) * kLon, ya = (p.lat2 - lat0) * kLat;
                x2.push(xa); y2.push(ya); cd2.push(p.time_label);
                ann.push({ x: xa, y: ya, text: p.time_label + 'Z', showarrow: false,
                           xanchor: 'left', yanchor: 'bottom', xshift: 7, yshift: 3,
                           font: { color: '#1e3a8a', size: 9, family: 'Arial, sans-serif' } });
            }
            if (p.lat6 != null) {
                x6.push((p.lon6 - lon0) * kLon); y6.push((p.lat6 - lat0) * kLat); cd6.push(p.time_label);
            }
        });
        var traces = [
            { x: x2, y: y2, mode: 'markers+lines+text', type: 'scatter', name: '2 km (L)',
              text: x2.map(function () { return 'L'; }), textposition: 'middle center',
              textfont: { color: '#ffffff', size: 10, family: 'Arial Black, Arial, sans-serif' },
              line: { color: 'rgba(96,165,250,0.75)', width: 1.5 },
              marker: { size: 15, color: '#60a5fa', line: { color: '#1e3a8a', width: 1 } },
              customdata: cd2, hovertemplate: '<b>%{customdata}Z</b> · 2 km centre<extra></extra>' },
            { x: x6, y: y6, mode: 'markers+lines+text', type: 'scatter', name: '6 km (M)',
              text: x6.map(function () { return 'M'; }), textposition: 'middle center',
              textfont: { color: '#ffffff', size: 10, family: 'Arial Black, Arial, sans-serif' },
              line: { color: 'rgba(37,99,235,0.6)', width: 1.5, dash: 'dot' },
              marker: { size: 15, color: '#2563eb', symbol: 'diamond', line: { color: '#1e3a8a', width: 1 } },
              customdata: cd6, hovertemplate: '<b>%{customdata}Z</b> · 6 km centre<extra></extra>' }
        ];
        var storm = ((_rtCtrkData && _rtCtrkData.storm_name) || (meta && meta.storm_name) || '').trim();
        var title = (storm ? storm + ' | ' + (meta.datetime || '') + '<br>' : '') +
            '2-km (L) &amp; 6-km (M) Center Track · ' + pts.length + ' sweeps';
        return { traces: traces, annotations: ann, title: title };
    }

    // Compact time × centre × tilt table below the plan view.
    function _rtRenderCenterTrackTable() {
        var el = document.getElementById('rt-ctrk-result');
        if (!el || !_rtCtrkData) return;
        var pts = _rtCtrkData.points || [];
        var rows = pts.map(function (p) {
            var c2 = p.lat2 != null ? '(' + p.lon2.toFixed(2) + ', ' + p.lat2.toFixed(2) + ')' : '—';
            var c6 = p.lat6 != null ? '(' + p.lon6.toFixed(2) + ', ' + p.lat6.toFixed(2) + ')' : '—';
            var tilt = p.tilt_2_6_km != null ? p.tilt_2_6_km.toFixed(1) : '—';
            return '<tr><td style="padding:1px 10px 1px 0;color:#2563eb;">' + p.time_label + 'Z</td>' +
                   '<td style="padding:1px 10px 1px 0;color:var(--text);">' + c2 + '</td>' +
                   '<td style="padding:1px 10px 1px 0;color:var(--text);">' + c6 + '</td>' +
                   '<td style="padding:1px 0;color:var(--slate);">' + tilt + '</td></tr>';
        }).join('');
        el.innerHTML =
            '<div class="storm-timeline-panel" style="margin-top:8px;padding:8px 10px;">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
            '<span style="font-size:12px;font-weight:600;color:var(--text);">◎ Center Track · ' + pts.length + ' sweeps</span>' +
            '<span style="flex:1;"></span>' +
            '<button onclick="rtToggleCenterTrack()" class="fl-ts-close" title="Hide the centre track (winds return)">&times;</button>' +
            '</div>' +
            '<table style="font-size:10.5px;border-collapse:collapse;font-variant-numeric:tabular-nums;">' +
            '<thead><tr style="color:var(--slate);text-align:left;border-bottom:1px solid rgba(148,163,184,0.25);">' +
            '<th style="padding:1px 10px 3px 0;font-weight:600;">Time (Z)</th>' +
            '<th style="padding:1px 10px 3px 0;font-weight:600;">2-km (lon, lat)</th>' +
            '<th style="padding:1px 10px 3px 0;font-weight:600;">6-km (lon, lat)</th>' +
            '<th style="padding:1px 0 3px;font-weight:600;">Tilt (km)</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table></div>';
    }


    // ── Real-Time Wind Barbs ────────────────────────────────────

    var _rtBarbsEnabled = true;   // ON by default on first plot load

    window.rtToggleBarbs = function () {
        var btn = document.getElementById('rt-barb-btn');
        _rtBarbsEnabled = !_rtBarbsEnabled;
        if (btn) btn.classList.toggle('active', _rtBarbsEnabled);
        // Re-generate the plot (barbs are added as Plotly shapes during render)
        rtGeneratePlot();
    };

    // Max-value "X" marker: OFF by default — on a wind field it reads like a
    // center fix and is easily confused with the TC center. The max VALUE is
    // always shown as a text annotation; this toggle re-adds the glyph.
    var _rtMaxMarkerEnabled = false;

    window.rtToggleMaxMarker = function () {
        var btn = document.getElementById('rt-maxmark-btn');
        _rtMaxMarkerEnabled = !_rtMaxMarkerEnabled;
        if (btn) btn.classList.toggle('active', _rtMaxMarkerEnabled);
        rtGeneratePlot();
    };

    // Storm-relative frame: when on, the backend subtracts the storm-motion
    // vector from U/V before deriving WIND_SPEED / TANGENTIAL / RADIAL / U / V
    // and the barbs. Default off (earth/ground-relative).
    var _rtStormRelative = false;

    window.rtToggleStormRelative = function () {
        var btn = document.getElementById('rt-sr-btn');
        _rtStormRelative = !_rtStormRelative;
        if (btn) btn.classList.toggle('active', _rtStormRelative);
        rtGeneratePlot();
    };

    // ── Real-Time Tilt Hodograph ──────────────────────────────────

    var _rtTiltData = null;          // tilt profile from API
    var _rtTiltTraceStart = -1;      // index where tilt traces start in plan-view
    var _rtTiltEnabled = false;      // toggle state
    var _rtTilt3DTraceStart = -1;    // index where tilt traces start in 3D viewer

    // Tilt-height colorscale. Deliberately a magenta/purple family: the fields
    // it overlays — Jet wind and the reflectivity rainbow — both run
    // blue→green→yellow→red, and the IR backdrop is grayscale, so a Viridis
    // (blue/green/yellow) tilt column blended right in. Magenta sits outside all
    // of those, and the ramp stays bright at every height so low-level points
    // don't disappear over the dark inner core.
    var _RT_TILT_COLORSCALE = [
        [0.00, '#f9a8d4'],   // 0 km  — light pink
        [0.40, '#e879f9'],   //         magenta
        [0.70, '#c026d3'],   //         bright magenta
        [1.00, '#86198f']    // 14 km — deep magenta
    ];
    var _RT_TILT_LINE   = 'rgba(192,38,211,0.85)';   // connecting line (magenta, was green)
    var _RT_TILT_OUTLINE = 'rgba(20,0,28,0.9)';      // marker edge — dark so dots read on light areas

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
            line: { color: _RT_TILT_LINE, width: 1.5, dash: 'dot' },
            hoverinfo: 'skip', showlegend: false
        };

        var markerTrace = {
            x: xAbs, y: yAbs,
            mode: 'markers', type: 'scatter',
            marker: {
                size: sizes, color: z,
                colorscale: _RT_TILT_COLORSCALE, cmin: 0, cmax: 14,
                line: { color: _RT_TILT_OUTLINE, width: 1 },
                colorbar: {
                    title: { text: 'Tilt Height (km)', font: { color: '#5b6573', size: 9 } },
                    tickfont: { color: '#5b6573', size: 8 },
                    thickness: 10, len: 0.30,
                    x: 1.01, xpad: 2, y: 0.02,
                    yanchor: 'bottom', outlinewidth: 0
                }
            },
            text: hoverText, hoverinfo: 'text',
            hoverlabel: { bgcolor: '#ffffff', font: { color: '#0f1623', size: 11 } },
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

    // The shared 3D module (vol3d.js _build3DTiltTraces) now renders the vortex-
    // tilt column + RMW rings itself — magenta, matching the archive — so this
    // RT-side duplicate is retired: it was adding a SECOND (Viridis) tilt overlay
    // that the Tilt button couldn't even control. No-op keeps its call sites
    // (rtOpen3DModal, the vol3d-rerendered listener) harmless; the Tilt button now
    // drives vol3d's toggle3DTilt().
    window._rtAddTiltTo3D = function () { return; };


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
        var meta = json.case_meta || {};
        var fig = TDRView.cfadFigure(json, { subtitle: meta.datetime ? ' | ' + meta.datetime : '' });
        var el = document.getElementById('rt-az-result');
        if (!el) el = document.getElementById('rt-cs-result');
        if (el) {
            el.innerHTML = '<div id="rt-cfad-chart" style="width:100%;height:400px;border-radius:6px;overflow:hidden;"></div>';
            Plotly.newPlot('rt-cfad-chart', fig.traces, fig.layout, { responsive: true, displayModeBar: true, displaylogo: false });
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
    _rtOn('beforeExplore', _rtRemoveNexradOverlay);

    // ── Patch _rtCleanupMap to also remove NEXRAD layers ──────
    _rtOn('cleanupMap', function () {
        if (_rtNexradMapOverlay && _rtMap) { _rtMap.removeLayer(_rtNexradMapOverlay); _rtNexradMapOverlay = null; }
    });

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
            '&product=' + product + '&mwv=3';
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
                var mwFname = 'MW_' + (json.sensor || 'sensor') + '_' + product + '_' + dtSafe + '.png';
                dlBtn.onclick = function (ev) {
                    ev.preventDefault();
                    TCExport.save(imgUrl, mwFname);
                };
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
        var plotBg = '#ffffff';
        var config = { responsive: true, displayModeBar: true,
            modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'], displaylogo: false };
        var centerTrace = { x: [0], y: [0], type: 'scatter', mode: 'markers',
            marker: { symbol: 'cross', size: 10, color: 'white', line: { color: 'white', width: 2 } },
            showlegend: false, hoverinfo: 'skip' };

        if (hasRGB) {
            var ext = (json.storm_grid && json.storm_grid.extent_km) || 250;
            var layout = {
                title: { text: titleText, font: { color: '#0f1623', size: 11 }, y: 0.96, x: 0.5, xanchor: 'center', yanchor: 'top' },
                paper_bgcolor: plotBg, plot_bgcolor: plotBg,
                xaxis: { title: { text: 'Eastward distance (km)', font: { color: '#5b6573', size: 10 } },
                         tickfont: { color: '#5b6573', size: 9 }, gridcolor: 'rgba(15,22,35,0.22)',
                         zeroline: true, zerolinecolor: 'rgba(255,255,255,0.12)',
                         scaleanchor: 'y', range: [-ext, ext] },
                yaxis: { title: { text: 'Northward distance (km)', font: { color: '#5b6573', size: 10 } },
                         tickfont: { color: '#5b6573', size: 9 }, gridcolor: 'rgba(15,22,35,0.22)',
                         zeroline: true, zerolinecolor: 'rgba(255,255,255,0.12)',
                         scaleanchor: 'x', scaleratio: 1, range: [-ext, ext] },
                margin: { l: 52, r: 16, t: 46, b: 44 },
                images: [{ source: 'data:image/png;base64,' + json.storm_grid_rgb_b64,
                    xref: 'x', yref: 'y', x: -ext, y: ext,
                    sizex: 2 * ext, sizey: 2 * ext,
                    xanchor: 'left', yanchor: 'top',
                    sizing: 'stretch', opacity: 0.95, layer: 'below' }],
                hoverlabel: { bgcolor: '#ffffff', font: { color: '#0f1623', size: 12 } },
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
                colorbar: { title: { text: cbarTitle, font: { color: '#5b6573', size: 10 } },
                            tickfont: { color: '#5b6573', size: 9 }, thickness: 12, len: 0.85 },
                hovertemplate: '<b>MW %{z:.0f} K</b><br>X: %{x:.0f} km  Y: %{y:.0f} km<extra>MW</extra>',
                hoverongaps: false, name: 'MW ' + cbarTitle.replace(' (K)', '')
            };
            var layout2 = {
                title: { text: titleText, font: { color: '#0f1623', size: 11 }, y: 0.96, x: 0.5, xanchor: 'center', yanchor: 'top' },
                paper_bgcolor: plotBg, plot_bgcolor: plotBg,
                xaxis: { title: { text: 'Eastward distance (km)', font: { color: '#5b6573', size: 10 } },
                         tickfont: { color: '#5b6573', size: 9 }, gridcolor: 'rgba(15,22,35,0.22)',
                         zeroline: true, zerolinecolor: 'rgba(255,255,255,0.12)',
                         scaleanchor: 'y', range: [-ext2, ext2] },
                yaxis: { title: { text: 'Northward distance (km)', font: { color: '#5b6573', size: 10 } },
                         tickfont: { color: '#5b6573', size: 9 }, gridcolor: 'rgba(15,22,35,0.22)',
                         zeroline: true, zerolinecolor: 'rgba(255,255,255,0.12)',
                         scaleanchor: 'x', scaleratio: 1, range: [-ext2, ext2] },
                margin: { l: 52, r: 60, t: 46, b: 44 },
                hoverlabel: { bgcolor: '#ffffff', font: { color: '#0f1623', size: 12 } },
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
