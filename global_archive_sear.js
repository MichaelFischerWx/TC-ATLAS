/* global_archive_sear.js — Global Archive tab 5: SEAR (experimental).
 *
 * SEAR (Surface Estimation from Aircraft Reconnaissance) turns a recon
 * flight-level wind into a 10-m wind in two learned steps (flight level ->
 * 500 m, taught by TC-RADAR tail Doppler radar; 500 m -> lowest-150-m mean,
 * taught by dropsondes) plus a measured factor to 10 m. This tab browses the
 * HISTORICAL record one flight at a time: pick a storm, then a flight, and see
 * the flight-level wind and SEAR's estimate along it, as a time series plus a
 * map or storm-relative plan view, with the pass maxima marked.
 *
 * Data: cdn.tcatlas.org/sear-hist/v2/ (bin/build_sear_hist_v2.py), a storm
 * file + one file per flight. v1 (one file per storm, scored obs only) stays
 * where it is for the Storm Detail recon section. The record is scored with
 * the record's own chain (Stage 1 v4 / Stage 2 v8); the real-time product has
 * run Stage 1 v6.1 / Stage 2 v11 since 29 Sep 2026. Never label this as v6.1.
 *
 * Standing rules carried into the UI: SFMR is a shape / sanity reference only
 * (never a target), best track is a comparison (never a target).
 *
 * Borrowed from global_archive.js through window.GAArchive (getTrack /
 * getStorm / toast) — see the bridge at the bottom of that file.
 * Public API: window.activateSearView() (called from switchTab),
 *             window.searShareParams() (read by buildShareHash).
 */
(function () {
    'use strict';

    var qs = new URLSearchParams(location.search);
    var LOCALHOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    var CDN_ROOT = 'https://cdn.tcatlas.org/sear-hist/v2';
    var LOCAL_ROOT = 'sear-hist/v2';
    /* A dev server reads the local build (sear-hist/v2 -> ~/Data/sear_hist_v2)
       and falls back to the CDN when there is none. ?sear=<base> overrides,
       on a local host only: it picks where every rendered string comes from. */
    var _ov = LOCALHOST ? (qs.get('sear') || '').replace(/\/+$/, '') : '';
    var ROOT = _ov || (LOCALHOST ? LOCAL_ROOT : CDN_ROOT);

    var KT_STOPS = [   // = global_archive.js _GA_RECON_WIND_STOPS (Saffir-Simpson bins); keep in sync
        [34, '#60a5fa'], [50, '#22c55e'], [64, '#eab308'], [83, '#f97316'],
        [96, '#ef4444'], [113, '#9d174d'], [137, '#c026d3'], [9999, '#7c3aed']
    ];
    var KT_LABELS = ['<34', '34–49', '50–63', '64–82', '83–95', '96–112', '113–136', '≥137'];
    var Z_STOPS = [    // aircraft height, m (viridis, low = light)
        [500, '#fde725'], [1000, '#a0da39'], [2000, '#4ac16d'], [3000, '#1fa187'],
        [4500, '#277f8e'], [6500, '#365c8d'], [9000, '#46327e'], [99999, '#440154']
    ];
    var Z_LABELS = ['<0.5', '0.5–1', '1–2', '2–3', '3–4.5', '4.5–6.5', '6.5–9', '≥9'];
    var MISSING = -9999;
    var GREY = '#9ca3af';

    function $(id) { return document.getElementById(id); }
    function GA() { return window.GAArchive || null; }
    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function dark() {   // from the CSS token the charts use, not data-theme (light has no attribute)
        var v = (window.TCATheme && TCATheme.readVar('--plot-paper')) || '';
        return /^#0|^#1|rgb\(\s*1?\d,/.test(v);
    }
    function tv(name, dflt) { return (window.TCATheme && TCATheme.readVar(name)) || dflt; }
    function pink() { return dark() ? '#f472b6' : '#be185d'; }
    function ktColor(v) {
        if (v == null || !isFinite(v)) return GREY;
        for (var i = 0; i < KT_STOPS.length; i++) if (v < KT_STOPS[i][0]) return KT_STOPS[i][1];
        return KT_STOPS[KT_STOPS.length - 1][1];
    }
    function zColor(v) {
        if (v == null || !isFinite(v)) return GREY;
        for (var i = 0; i < Z_STOPS.length; i++) if (v < Z_STOPS[i][0]) return Z_STOPS[i][1];
        return Z_STOPS[Z_STOPS.length - 1][1];
    }
    function r0(v) { return v == null ? '—' : String(Math.round(v)); }
    function utc(t, o) { return window.TCTime ? TCTime.utc(t, o) : new Date(t).toISOString(); }
    function ms(epochS) { return epochS * 1000; }
    /* Plotly draws numeric epoch-ms in the BROWSER's zone; a zone-less date
       string is drawn as written. Every chart x value goes through this. */
    function D(msv) { return new Date(msv).toISOString().slice(0, 19).replace('T', ' '); }
    function compass(az) {
        if (az == null) return '';
        return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((az % 360) + 360) % 360 / 45) % 8];
    }
    function where(az, r) {
        if (r == null) return '';
        return (az != null ? compass(az) + ' ' : '') + Math.round(r) + ' km (' + Math.round(r * 0.5399568) + ' n mi) from center';
    }
    function flightSpan(f) {
        var a = ms(f.t0), b = ms(f.t1);
        var sameDay = new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
        return utc(a, { zone: false }) + '–' + (sameDay ? utc(b, { date: false }) : utc(b));
    }
    function kindShort(f) {
        if (/^hdob/.test(f.src)) return 'HDOB 30-s';
        if (/-1s$/.test(f.tail)) return 'HRD 1-s';
        return 'HRD 10-s';
    }
    function tailName(t) { return String(t || '').replace(/-(1|10)s$/, ''); }
    function stormLabel(s) {
        var n = s.name && s.name !== 'NOT_NAMED' && s.name !== 'UNNAMED'
            ? s.name.charAt(0) + s.name.slice(1).toLowerCase() : s.atcf;
        return n + ' ' + s.year;
    }
    function isFix(p) { return String(p.src || '').indexOf('fix') === 0; }
    function passV(p) { return p.y_corr_kt != null ? p.y_corr_kt : p.y_kt; }

    // ── data ─────────────────────────────────────────────────────
    function fetchJSON(url) {
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + url);
            return r.text().then(function (t) {
                try { return JSON.parse(t); } catch (e) {
                    throw new Error('not JSON at ' + url + ' (got "' + t.slice(0, 30).replace(/\s+/g, ' ') + '…")');
                }
            });
        });
    }
    function getIndex() {
        return fetchJSON(ROOT + '/index.json').catch(function (e) {
            if (ROOT !== LOCAL_ROOT) throw e;
            console.info('[sear] no local build at ' + LOCAL_ROOT + ' — reading the CDN');
            ROOT = CDN_ROOT;
            return fetchJSON(ROOT + '/index.json');
        });
    }

    // ── state ────────────────────────────────────────────────────
    var booted = false, index = null, rows = [], byAtcf = {};
    var sortKey = 'max', query = '';
    var stormCache = {}, flightCache = {};
    var sel = null, storm = null, fIdx = -1, flight = null, flightReq = 0, stormReq = 0;
    var colorBy = 'y', view = 'map';
    var SERIES = [   // the time-series pills; `on` = default
        { k: 'fl', label: 'Flight level', on: true },
        { k: 'y5', label: 'SEAR 500 m', on: false, title: 'SEAR’s first step: the flight-level wind brought down to 500 m (radar-taught)' },
        { k: 'y', label: 'SEAR 10-m', on: true },
        { k: 'y30', label: '30-s scale', on: false, title: 'SEAR 10-m on the 30-s averaging scale (the headline is on the 10-s-peak scale)' },
        { k: 'sf', label: 'SFMR', on: false, title: 'SFMR as reported in the HDOB: a shape and sanity reference only, not a calibration target' },
        { k: 'bt', label: 'Best track', on: true, title: 'Best-track maximum wind, for comparison only (SEAR is not fitted to it)' },
        { k: 'r', label: 'Radius', on: true, axis: true, title: 'Distance from the storm center (right axis)' },
        { k: 'z', label: 'Height', on: false, axis: true, title: 'Aircraft height (right axis)' }
    ];
    var seriesOn = {};
    SERIES.forEach(function (s) { seriesOn[s.k] = s.on; });
    var deep = (function () {        // #tab=sear&sear=ATCF&flight=key, read before anything rewrites the hash
        var h = {};
        (location.hash || '').replace(/^#/, '').split('&').forEach(function (p) {
            var kv = p.split('='); if (kv.length === 2) h[kv[0]] = decodeURIComponent(kv[1]);
        });
        return h.tab === 'sear' && h.sear ? { storm: h.sear.toUpperCase(), flight: h.flight || null } : null;
    })();

    window.searShareParams = function () {
        var a = sel || (deep && deep.storm), k = (flight && flight.key) || (deep && deep.flight);
        var out = [];
        if (a) out.push('sear=' + encodeURIComponent(a));
        if (a && k) out.push('flight=' + encodeURIComponent(k));
        return out;
    };
    function syncHash() {
        try {
            var p = ['tab=sear'].concat(window.searShareParams());
            history.replaceState(null, '', location.pathname + location.search + '#' + p.join('&'));
        } catch (e) { }
    }

    // ══════════════════════════════════════════════════════════════
    //  activation
    // ══════════════════════════════════════════════════════════════
    window.activateSearView = function () {
        if (booted) { sizeTab(); setTimeout(resizeAll, 100); return; }
        booted = true;
        wire();
        renderEmptySeries('Pick a storm on the map or in the list, then a flight.');
        sizeTab();
        watchToolbar();
        initMap();
        loadIndex();
    };

    function loadIndex() {
        $('gsr-loading').style.display = '';
        $('gsr-loading').innerHTML = '<div class="tc-spinner"></div><span>Loading the SEAR record&hellip;</span>';
        getIndex().then(function (j) {
            index = j;
            rows = Object.keys(j.storms || {}).map(function (a) {
                var s = j.storms[a];
                var r = { atcf: a, name: s.name, year: s.year, sid: s.sid, basin: s.basin, era: s.era,
                    max_kt: s.max_kt, max_src: s.max_src, at: s.max_at || null, fl_max_kt: s.fl_max_kt,
                    n_flights: s.n_flights || 0, n_passes: s.n_passes || 0 };
                r.label = stormLabel(r);
                r.hay = (r.label + ' ' + a + ' ' + (s.name || '')).toLowerCase();
                byAtcf[a] = r;
                return r;
            });
            renderVersion();
            renderList();
            renderFoot();
            stormPoints();
            $('gsr-loading').style.display = 'none';
            if (deep && byAtcf[deep.storm]) openStorm(deep.storm, deep.flight);
            deep = null;
        }).catch(function (e) {
            if (window.TCErrors) {
                TCErrors.log(e, 'the SEAR record from ' + ROOT);
                TCErrors.show($('gsr-loading'), e, 'the SEAR record', loadIndex);
            } else {
                $('gsr-loading').innerHTML = '<span>Could not load the SEAR record.</span>';
            }
        });
    }

    function renderVersion() {
        var el = $('gsr-ver'), src = (index && index.sources) || {};
        var d = function (k) { return src[k] && src[k].mtime ? src[k].mtime.slice(0, 10) : '?'; };
        var built = index && index.generated ? index.generated.slice(0, 10) : '?';
        el.title = 'SEAR historical record, scored with the record’s model chain (Stage 1 v4 / Stage 2 v8). ' +
            'The real-time SEAR product has run a newer chain (Stage 1 v6.1 / Stage 2 v11) since 29 Sep 2026, so ' +
            'its values for the same flight can differ.\nBuilt ' + built + ' from MLBT record files: Atlantic HDOB ' +
            d('hdob_al') + ', Pacific HDOB ' + d('hdob_ep') + ', HRD 1998–2007 ' + d('hrd') + ', HRD before 1997 ' +
            d('hrd_pre') + ', VDM-fix passes ' + d('fix') + '.';
        el.setAttribute('aria-label', el.title);
        var m = $('gsr-about-model');
        if (m && !m.dataset.v) {
            m.dataset.v = '1';
            m.insertAdjacentHTML('beforeend', ' <span class="gra-about-note">(Record: Stage&nbsp;1&nbsp;v4 / ' +
                'Stage&nbsp;2&nbsp;v8. Real time: Stage&nbsp;1&nbsp;v6.1 / Stage&nbsp;2&nbsp;v11.)</span>');
        }
    }

    function renderFoot() {
        var nF = 0, nP = 0;
        rows.forEach(function (r) { nF += r.n_flights; nP += r.n_passes; });
        var built = index && index.generated ? utc(index.generated, { time: false, year: true }) : '';
        $('gsr-sub').textContent = rows.length + ' storms · ' + nF.toLocaleString() + ' flights · ' +
            nP.toLocaleString() + ' pass maxima';
        $('gsr-foot').innerHTML = '<b>Experimental.</b> SEAR historical record' + (built ? ', built ' + esc(built) : '') +
            '. Not an official analysis; best track and SFMR are references, not targets. ' +
            '<a href="#" id="gsr-foot-about">About SEAR</a>';
        var a = $('gsr-foot-about');
        if (a) a.onclick = function (e) { e.preventDefault(); showAbout(true); };
    }

    // ══════════════════════════════════════════════════════════════
    //  layout
    // ══════════════════════════════════════════════════════════════
    function sizeTab() {
        var el = $('tab-sear');
        if (!el || !el.classList.contains('active')) return;
        if (window.innerWidth <= 768) { el.style.height = ''; resizeAll(); return; }
        var top = el.getBoundingClientRect().top;
        el.style.height = Math.max(520, Math.round(window.innerHeight - top)) + 'px';
        resizeAll();
    }
    var _sizeT = null;
    function sizeSoon() { clearTimeout(_sizeT); _sizeT = setTimeout(sizeTab, 60); }
    window.addEventListener('resize', sizeSoon);
    function watchToolbar() {
        if (typeof ResizeObserver === 'undefined') return;
        var tb = document.querySelector('#tab-sear .gsr-toolbar');
        if (tb) new ResizeObserver(sizeSoon).observe(tb);
        var ts = $('gsr-ts');
        if (ts) new ResizeObserver(function () { plotResize('gsr-ts'); }).observe(ts);
    }
    function plotResize(id) {
        var el = $(id);
        if (el && el._fullLayout && window.Plotly) { try { Plotly.Plots.resize(el); } catch (e) { } }
    }
    function resizeAll() {
        if (gmap) gmap.invalidateSize();
        plotResize('gsr-ts'); plotResize('gsr-rel'); plotResize('gsr-life');
    }

    // ══════════════════════════════════════════════════════════════
    //  map (same construction as the GHOST tab / Storm Browser)
    // ══════════════════════════════════════════════════════════════
    var gmap = null, gl = null, glReady = false, glQueue = [];
    var L_ST = 'gsr-st', L_BT = 'gsr-bt', L_BTP = 'gsr-btp', L_TRK = 'gsr-trk', L_OBS = 'gsr-obs',
        L_PS = 'gsr-ps', L_HL = 'gsr-hl';
    var ORDER = [L_ST, L_BT, L_BTP, L_TRK, L_OBS, L_PS, L_HL];
    var passLabels = [];
    var EMPTY = { type: 'FeatureCollection', features: [] };
    var LANDING = [[22, -85], 2.3];   // Atlantic + E/C Pacific, with the western Pacific HRD storms at the edge

    function initMap() {
        gmap = L.map('gsr-map', { center: LANDING[0], zoom: LANDING[1], zoomControl: true, worldCopyJump: true, zoomSnap: 0, zoomDelta: 0.5 });
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://carto.com/">CARTO</a>', subdomains: 'abcd', maxZoom: 12
        }).addTo(gmap);
        gl = gmap.getGL();
        gl.on('load', markReady);
        if (gl.loaded() || (gl.isStyleLoaded && gl.isStyleLoaded())) markReady();
    }
    function markReady() {
        if (glReady) return;
        glReady = true;
        addLayers();
        var q = glQueue; glQueue = [];
        q.forEach(function (fn) { try { fn(); } catch (e) { console.warn('[sear]', e); } });
    }
    function whenGL(fn) {
        if (glReady) { try { fn(); } catch (e) { console.warn('[sear]', e); } return; }
        glQueue.push(fn);
    }
    function setSrc(id, fc) { whenGL(function () { var s = gl.getSource(id); if (s) s.setData(fc || EMPTY); }); }
    function stepExpr(prop, stops) {
        var e = ['step', ['get', prop], stops[0][1]];
        for (var i = 0; i < stops.length - 1; i++) e.push(stops[i][0], stops[i + 1][1]);
        return ['case', ['==', ['get', prop], MISSING], GREY, e];
    }
    function addLayers() {
        ORDER.forEach(function (id) { gl.addSource(id, { type: 'geojson', data: EMPTY }); });
        gl.addLayer({ id: L_ST, type: 'circle', source: L_ST, paint: {
            'circle-color': stepExpr('v', KT_STOPS),
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 3.6, 5, 6, 8, 8],
            'circle-opacity': 0.9,
            'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(255,255,255,.85)' } });
        gl.addLayer({ id: L_BT, type: 'line', source: L_BT, layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#334155', 'line-width': 1.6, 'line-opacity': 0.7, 'line-dasharray': [2, 1.5] } });
        gl.addLayer({ id: L_BTP, type: 'circle', source: L_BTP, paint: {
            'circle-radius': 2.4, 'circle-color': '#334155', 'circle-opacity': 0.75 } });
        gl.addLayer({ id: L_TRK, type: 'line', source: L_TRK, layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#475569', 'line-width': 1.2, 'line-opacity': 0.55 } });
        gl.addLayer({ id: L_OBS, type: 'circle', source: L_OBS, paint: {
            'circle-color': stepExpr('v', KT_STOPS),
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 1.8, 7, 3, 10, 4.5],
            'circle-opacity': ['case', ['==', ['get', 'v'], MISSING], 0.45, 0.95] } });
        gl.addLayer({ id: L_PS, type: 'circle', source: L_PS, paint: {
            'circle-color': stepExpr('v', KT_STOPS),
            'circle-radius': ['case', ['==', ['get', 'cur'], 1], 7, 4],
            'circle-opacity': ['case', ['==', ['get', 'cur'], 1], 1, 0.55],
            'circle-stroke-width': ['case', ['==', ['get', 'cur'], 1], 2, 1],
            'circle-stroke-color': '#ffffff' } });
        gl.addLayer({ id: L_HL, type: 'circle', source: L_HL, paint: {
            'circle-radius': 8, 'circle-color': 'rgba(255,255,255,.25)',
            'circle-stroke-width': 2.5, 'circle-stroke-color': '#0f172a' } });
        mapTheme();
        /* Keep our layers above the basemap: the facade can insert its raster
           layer after us (same lesson as the GHOST tab's styledata guard). */
        gl.on('styledata', function () {
            if (!gl.getLayer(L_HL)) return;
            var ls = gl.getStyle().layers;
            if (ls[ls.length - 1].id !== L_HL) ORDER.forEach(function (id) { if (gl.getLayer(id)) gl.moveLayer(id); });
        });
        gl.on('click', L_ST, function (e) {
            if (sel) return;   // the landing points are context once a storm is open
            if (e.features && e.features.length) openStorm(e.features[0].properties.a);
        });
        function hoverOn(layer, fmt) {
            gl.on('mousemove', layer, function (e) {
                if (!e.features || !e.features.length) return;
                var h = fmt(e.features[0].properties);
                if (!h) return;
                gl.getCanvas().style.cursor = 'pointer';
                showTip(h, e.point.x, e.point.y);
            });
            gl.on('mouseleave', layer, function () { gl.getCanvas().style.cursor = ''; hideTip(); });
        }
        hoverOn(L_ST, function (p) {
            if (sel) return null;
            var r = byAtcf[p.a]; if (!r) return null;
            return '<b>' + esc(r.label) + '</b> <span class="gsr-tip-sub">' + esc(r.atcf) + '</span><br>' +
                'Max SEAR 10-m <b>' + r0(r.max_kt) + ' kt</b> · ' + r.n_flights + ' flights' +
                (r.era === 'extrapolated' ? '<br><span class="gsr-tip-warn">Before 1997: extrapolated</span>' : '');
        });
        hoverOn(L_OBS, function (p) { return obsTip(p.i); });
        hoverOn(L_PS, function (p) { return passTip(storm && storm.passes[p.i]); });
        gl.on('mousemove', L_OBS, function (e) { if (e.features && e.features.length) highlight(e.features[0].properties.i, 'map'); });
    }
    /* Neutral line colors follow the basemap (dark_all in dark mode); the data
       colors do not change. */
    function mapTheme() {
        if (!glReady || !gl.getLayer(L_BT)) return;
        var d = dark(), ink = d ? '#cbd5e1' : '#334155';
        gl.setPaintProperty(L_BT, 'line-color', ink);
        gl.setPaintProperty(L_BTP, 'circle-color', ink);
        gl.setPaintProperty(L_TRK, 'line-color', d ? '#94a3b8' : '#475569');
        gl.setPaintProperty(L_HL, 'circle-stroke-color', d ? '#f8fafc' : '#0f172a');
        gl.setPaintProperty(L_PS, 'circle-stroke-color', d ? '#0f172a' : '#ffffff');
        gl.setPaintProperty(L_ST, 'circle-stroke-color', d ? 'rgba(15,23,42,.85)' : 'rgba(255,255,255,.85)');
    }
    function showTip(html, x, y) {
        var t = $('gsr-tip'); if (!t) return;
        t.innerHTML = html;
        t.classList.add('on');
        var w = t.offsetWidth, hgt = t.offsetHeight, W = t.parentNode.clientWidth;
        t.style.left = Math.max(6, Math.min(W - w - 6, x + 14)) + 'px';
        t.style.top = Math.max(6, y - hgt - 10) + 'px';
    }
    function hideTip() { var t = $('gsr-tip'); if (t) t.classList.remove('on'); }

    function stormPoints() {
        var fs = [];
        if (sel) { setSrc(L_ST, EMPTY); return; }   // once a storm is open the others are noise
        rows.forEach(function (r) {
            if (!r.at || r.at.lat == null || r.at.lon == null) return;
            fs.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.at.lon, r.at.lat] },
                properties: { a: r.atcf, v: r.max_kt == null ? MISSING : r.max_kt } });
        });
        fs.sort(function (a, b) { return a.properties.v - b.properties.v; });   // strongest on top
        setSrc(L_ST, { type: 'FeatureCollection', features: fs });
    }

    // ══════════════════════════════════════════════════════════════
    //  storm list
    // ══════════════════════════════════════════════════════════════
    function renderList() {
        var q = query.trim().toLowerCase();
        var terms = q ? q.split(/\s+/) : [];
        var list = rows.filter(function (r) {
            for (var i = 0; i < terms.length; i++) if (r.hay.indexOf(terms[i]) < 0) return false;
            return true;
        });
        var cmp = {
            max: function (a, b) { return (b.max_kt || 0) - (a.max_kt || 0) || b.year - a.year; },
            year: function (a, b) { return b.year - a.year || (b.max_kt || 0) - (a.max_kt || 0); },
            name: function (a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; },
            flights: function (a, b) { return b.n_flights - a.n_flights || (b.max_kt || 0) - (a.max_kt || 0); }
        }[sortKey];
        list.sort(cmp);
        var el = $('gsr-list');
        if (!list.length) { el.innerHTML = '<div class="gra-empty">No storm matches “' + esc(query) + '”.</div>'; return; }
        var html = [];
        list.forEach(function (r, i) {
            html.push('<div class="gra-item gsr-item' + (r.atcf === sel ? ' active' : '') + '" data-a="' + esc(r.atcf) + '" role="button" tabindex="0">' +
                '<span class="gra-rk">' + (sortKey === 'max' && !q ? (i + 1) : '') + '</span>' +
                '<div class="gra-it-main"><div class="gra-nm">' + esc(r.label) +
                (r.era === 'extrapolated' ? '<span class="gra-flag" title="Before 1997: outside SEAR’s training era, extrapolated">pre-1997</span>' : '') + '</div>' +
                '<div class="gra-meta"><span>' + esc(r.atcf) + '</span><span>' + r.n_flights + ' flight' + (r.n_flights === 1 ? '' : 's') +
                ' · ' + r.n_passes + ' passes</span></div></div>' +
                '<div class="gra-it-vals"><div class="gra-num gsr-num"><b>' + r0(r.max_kt) + '</b> kt</div>' +
                '<div class="gra-num">FL ' + r0(r.fl_max_kt) + '</div></div></div>');
        });
        el.innerHTML = html.join('');
    }

    // ══════════════════════════════════════════════════════════════
    //  storm
    // ══════════════════════════════════════════════════════════════
    function openStorm(atcf, flightKey) {
        atcf = String(atcf).toUpperCase();
        var r = byAtcf[atcf]; if (!r) return;
        sel = atcf; storm = null; flight = null; fIdx = -1;
        var req = ++stormReq;
        $('gsr-pane-list').hidden = true;
        $('gsr-pane-storm').hidden = false;
        $('gsr-st-name').textContent = r.label;
        $('gsr-st-sub').textContent = r.atcf + ' · loading…';
        $('gsr-tiles').innerHTML = '';
        $('gsr-flights').innerHTML = '';
        clearPlot($('gsr-life'));
        $('gsr-life').innerHTML = '';
        clearFlightLayers();
        stormPoints();
        drawBT(r);
        renderEmptySeries('Loading ' + esc(r.label) + '…');
        var p = stormCache[atcf] ? Promise.resolve(stormCache[atcf]) : fetchJSON(ROOT + '/' + atcf + '.json');
        p.then(function (j) {
            if (req !== stormReq) return;
            stormCache[atcf] = j; storm = j;
            renderStorm();
            var i = -1;
            if (flightKey) j.flights.forEach(function (f, k) { if (f.key === flightKey) i = k; });
            if (i < 0) i = bestFlight(j);
            if (i >= 0) selectFlight(i, true);
            else {
                fitStorm();
                renderLegend();
                renderEmptySeries('No flight-level file for this storm in the record. Its pass maxima come from ' +
                    'vortex data messages (the maximum flight-level wind of each center fix).');
                drawPassLayer();
                syncHash();
            }
        }).catch(function (e) {
            if (req !== stormReq) return;
            if (window.TCErrors) TCErrors.log(e, 'SEAR storm ' + atcf);
            $('gsr-st-sub').textContent = r.atcf + ' · could not load this storm';
            renderEmptySeries('Could not load ' + esc(r.label) + '. Try again in a moment.');
        });
        syncHash();
    }
    function bestFlight(j) {
        var best = -1, bv = -1;
        j.flights.forEach(function (f, k) {
            var v = Math.max(f.pass_max_kt || 0, f.y_max_kt || 0);
            if (v > bv) { bv = v; best = k; }
        });
        return best;
    }
    function closeStorm() {
        sel = null; storm = null; flight = null; fIdx = -1; stormReq++; flightReq++;
        $('gsr-pane-list').hidden = false;
        $('gsr-pane-storm').hidden = true;
        clearFlightLayers();
        setSrc(L_BT, EMPTY); setSrc(L_BTP, EMPTY); setSrc(L_PS, EMPTY);
        stormPoints();
        try { gmap.flyTo(LANDING[0], LANDING[1], { duration: 0.6 }); } catch (e) { }
        fillFlightSelect();
        renderEmptySeries('Pick a storm on the map or in the list, then a flight.');
        if (view === 'rel') renderRel();
        renderLegend();
        renderList();
        syncHash();
    }

    function renderStorm() {
        var r = byAtcf[sel], j = storm;
        var bt = btPeak(r);
        var sub = [r.atcf];
        if (j.basin) sub.push(j.basin);
        sub.push(j.flights.length + ' flight' + (j.flights.length === 1 ? '' : 's'));
        $('gsr-st-sub').textContent = sub.join(' · ');
        var maxWhere = j.max_src === 'obs' ? 'on a flight' : (/^fix/.test(j.max_src) ? 'VDM pass' : 'eyewall pass');
        var tiles = [
            ['Max SEAR 10-m', '<b class="gsr-pk">' + r0(j.max_kt) + '</b> kt', maxWhere],
            ['Max flight level', '<b>' + r0(j.fl_max_kt) + '</b> kt', 'in the record’s files'],
            ['Best-track peak', '<b>' + r0(bt) + '</b> kt', 'comparison only']
        ];
        $('gsr-tiles').innerHTML = tiles.map(function (t) {
            return '<div class="gsr-tile"><span class="gsr-tl">' + t[0] + '</span><span class="gsr-tv">' + t[1] +
                '</span><span class="gsr-tsub">' + t[2] + '</span></div>';
        }).join('') + (j.era === 'extrapolated'
            ? '<div class="gsr-era">Before 1997: outside SEAR’s training era (older aircraft navigation), so these are extrapolations.</div>' : '');
        $('gsr-fl-n').textContent = j.flights.length ? '(' + j.flights.length + ')' : '';
        renderFlights();
        fillFlightSelect();
        renderLife();
    }
    function btTrack(r) {
        var g = GA();
        return (g && r && r.sid && g.getTrack) ? g.getTrack(r.sid) : null;
    }
    function btPeak(r) {
        var g = GA(), st = g && r && r.sid && g.getStorm ? g.getStorm(r.sid) : null;
        return st && st.peak_wind_kt != null ? st.peak_wind_kt : null;
    }
    var _btRetry = null;
    function drawBT(r) {
        clearTimeout(_btRetry);
        var t = btTrack(r);
        var g = GA(), waiting = r.sid && g && g.tracksReady && !g.tracksReady();
        if (!t && waiting) {   // tracks still streaming in: try again shortly (bounded)
            var n = 0;
            (function retry() {
                _btRetry = setTimeout(function () {
                    if (sel !== r.atcf) return;
                    var tt = btTrack(r);
                    if (tt) { drawBT(r); if (storm) { renderLife(); if (flight) renderSeries(); } return; }
                    if (++n < 30) retry();
                }, 1000);
            })();
            setSrc(L_BT, EMPTY); setSrc(L_BTP, EMPTY);
            return;
        }
        if (!t || !t.length) { setSrc(L_BT, EMPTY); setSrc(L_BTP, EMPTY); return; }   // no IBTrACS match
        var lon0 = t[0].lo, coords = [], pts = [];
        t.forEach(function (p) {
            var lo = p.lo; while (lo - lon0 > 180) lo -= 360; while (lo - lon0 < -180) lo += 360; lon0 = lo;
            coords.push([lo, p.la]);
            pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lo, p.la] }, properties: {} });
        });
        setSrc(L_BT, { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] });
        setSrc(L_BTP, { type: 'FeatureCollection', features: pts });
    }
    /* Best-track wind at epoch-ms times (linear in time; null outside the track). */
    function btAt(r, times) {
        var t = btTrack(r); if (!t || !t.length) return null;
        var T = t.map(function (p) { return Date.parse(p.t.length <= 16 ? p.t + 'Z' : p.t); });
        return times.map(function (x) {
            if (x < T[0] || x > T[T.length - 1]) return null;
            var k = 0; while (k < T.length - 1 && T[k + 1] < x) k++;
            var a = t[k], b = t[Math.min(k + 1, t.length - 1)];
            if (a.w == null || b.w == null) return a.w != null ? a.w : b.w;
            var f = T[k + 1] > T[k] ? (x - T[k]) / (T[k + 1] - T[k]) : 0;
            return a.w + f * (b.w - a.w);
        });
    }

    function renderFlights() {
        var el = $('gsr-flights'), j = storm;
        if (!j.flights.length) {
            el.innerHTML = '<div class="gra-empty">No flight-level files in the record for this storm.</div>';
            return;
        }
        el.innerHTML = j.flights.map(function (f, k) {
            var v = Math.max(f.pass_max_kt || 0, f.y_max_kt || 0) || null;
            return '<div class="gra-item gsr-fitem' + (k === fIdx ? ' active' : '') + '" data-f="' + k + '" role="button" tabindex="0">' +
                '<div class="gra-it-main"><div class="gra-nm">' + esc(flightSpan(f)) + '</div>' +
                '<div class="gra-meta"><span>' + esc(tailName(f.tail)) + '</span><span>' + esc(kindShort(f)) +
                (f.n_passes ? ' · ' + f.n_passes + ' pass' + (f.n_passes === 1 ? '' : 'es') : '') + '</span></div></div>' +
                '<div class="gra-it-vals"><div class="gra-num gsr-num">' + (v ? '<b>' + r0(v) + '</b> kt' : '<span class="gsr-none">not scored</span>') + '</div>' +
                '<div class="gra-num">FL ' + r0(f.fl_max_kt) + '</div></div></div>';
        }).join('');
    }
    function fillFlightSelect() {
        var s = $('gsr-flight');
        if (!storm || !storm.flights.length) {
            s.innerHTML = '<option>' + (storm ? 'No flight-level files' : 'Pick a storm first') + '</option>';
            s.disabled = true; $('gsr-fprev').disabled = true; $('gsr-fnext').disabled = true;
            return;
        }
        s.innerHTML = storm.flights.map(function (f, k) {
            return '<option value="' + k + '">' + esc(flightSpan(f) + ' · ' + tailName(f.tail)) + '</option>';
        }).join('');
        s.disabled = false;
        if (fIdx >= 0) s.value = String(fIdx);
        $('gsr-fprev').disabled = fIdx <= 0;
        $('gsr-fnext').disabled = fIdx < 0 || fIdx >= storm.flights.length - 1;
    }

    // ══════════════════════════════════════════════════════════════
    //  flight
    // ══════════════════════════════════════════════════════════════
    function selectFlight(k, fit) {
        if (!storm || k < 0 || k >= storm.flights.length) return;
        fIdx = k;
        var f = storm.flights[k], ck = storm.atcf + '/' + f.key, req = ++flightReq;
        flight = null;
        fillFlightSelect();
        Array.prototype.forEach.call(document.querySelectorAll('#gsr-flights .gsr-fitem'), function (el) {
            el.classList.toggle('active', +el.dataset.f === k);
            if (+el.dataset.f === k && el.scrollIntoView && el.parentNode.scrollHeight > el.parentNode.clientHeight) {
                var P = el.parentNode, top = el.offsetTop - P.offsetTop;
                if (top < P.scrollTop || top + el.offsetHeight > P.scrollTop + P.clientHeight) P.scrollTop = Math.max(0, top - 40);
            }
        });
        renderLife();
        renderEmptySeries('Loading the flight…');
        var p = flightCache[ck] ? Promise.resolve(flightCache[ck]) : fetchJSON(ROOT + '/' + storm.atcf + '/' + f.key + '.json');
        p.then(function (j) {
            if (req !== flightReq) return;
            flightCache[ck] = j;
            flight = j;
            prepFlight(j);
            drawFlight(fit !== false);
            renderSeries();
            if (view === 'rel') renderRel();
            syncHash();
        }).catch(function (e) {
            if (req !== flightReq) return;
            if (window.TCErrors) TCErrors.log(e, 'SEAR flight ' + ck);
            renderEmptySeries('Could not load this flight. Try again in a moment.');
        });
    }
    /* Derived per-ob values, once per flight: epoch ms, unwrapped longitude,
       storm-relative x/y (km east / north of center; az is a compass bearing). */
    function prepFlight(j) {
        if (j._prep) return;
        var o = j.obs, n = o.t.length, lon0 = null;
        o.ms = new Array(n); o.ds = new Array(n); o.ulon = new Array(n); o.x = new Array(n); o.yy = new Array(n);
        for (var i = 0; i < n; i++) {
            o.ms[i] = o.t[i] * 1000; o.ds[i] = D(o.ms[i]);
            var lo = o.lon[i];
            if (lon0 == null) lon0 = lo;
            while (lo - lon0 > 180) lo -= 360; while (lo - lon0 < -180) lo += 360;
            lon0 = lo; o.ulon[i] = lo;
            if (o.r[i] != null && o.az[i] != null) {
                var a = o.az[i] * Math.PI / 180;
                o.x[i] = o.r[i] * Math.sin(a); o.yy[i] = o.r[i] * Math.cos(a);
            } else { o.x[i] = null; o.yy[i] = null; }
        }
        j._prep = true;
    }
    function flightPasses() {
        if (!storm || fIdx < 0) return [];
        var out = [];
        storm.passes.forEach(function (p, i) { if (p.f === fIdx && passV(p) != null) out.push(i); });
        return out;
    }
    function colorVal(i) {
        var o = flight.obs;
        var v = colorBy === 'fl' ? o.fl[i] : colorBy === 'z' ? o.z[i] : o.y[i];
        return v == null ? MISSING : v;
    }
    function clearFlightLayers() {
        setSrc(L_TRK, EMPTY); setSrc(L_OBS, EMPTY); setSrc(L_HL, EMPTY);
        passLabels.forEach(function (m) { try { gmap.removeLayer(m); } catch (e) { } });
        passLabels = [];
        hideTip();
    }
    function drawFlight(fit) {
        var o = flight.obs, n = o.t.length, coords = [], fs = [];
        for (var i = 0; i < n; i++) {
            coords.push([o.ulon[i], o.lat[i]]);
            fs.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [o.ulon[i], o.lat[i]] },
                properties: { i: i, v: colorVal(i) } });
        }
        // scored points on top of the grey unscored ones
        fs.sort(function (a, b) { return (a.properties.v === MISSING ? -1 : a.properties.v) - (b.properties.v === MISSING ? -1 : b.properties.v); });
        setSrc(L_TRK, { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] });
        setSrc(L_OBS, { type: 'FeatureCollection', features: fs });
        whenGL(function () {
            gl.setPaintProperty(L_OBS, 'circle-color', stepExpr('v', colorBy === 'z' ? Z_STOPS : KT_STOPS));
        });
        drawPassLayer();
        renderLegend();
        if (fit && n) {
            /* Frame the part of the flight near the storm (ferry legs from the
               base would otherwise shrink the eyewall pattern to a few pixels). */
            var near = 0;
            for (var q = 0; q < n; q++) if (o.r[q] != null && o.r[q] <= 300) near++;
            var la0 = 90, la1 = -90, lo0 = 1e9, lo1 = -1e9;
            for (var k = 0; k < n; k++) {
                if (near >= 10 && !(o.r[k] != null && o.r[k] <= 300)) continue;
                if (o.lat[k] < la0) la0 = o.lat[k]; if (o.lat[k] > la1) la1 = o.lat[k];
                if (o.ulon[k] < lo0) lo0 = o.ulon[k]; if (o.ulon[k] > lo1) lo1 = o.ulon[k];
            }
            try { gmap.fitBounds([[la0, lo0], [la1, lo1]], { padding: 40, maxZoom: 8 }); } catch (e) { }
        }
    }
    function fitStorm() {
        var la = [], lo = [];
        storm.passes.forEach(function (p) { if (p.lat != null && p.lon != null) { la.push(p.lat); lo.push(p.lon); } });
        var t = btTrack(byAtcf[sel]);
        if (t) t.forEach(function (p) { la.push(p.la); lo.push(p.lo); });
        if (!la.length) return;
        try {
            gmap.fitBounds([[Math.min.apply(null, la), Math.min.apply(null, lo)], [Math.max.apply(null, la), Math.max.apply(null, lo)]],
                { padding: 40, maxZoom: 7 });
        } catch (e) { }
    }
    /* Every pass maximum of the storm that has a position; this flight's are
       drawn large and labeled. */
    function drawPassLayer() {
        passLabels.forEach(function (m) { try { gmap.removeLayer(m); } catch (e) { } });
        passLabels = [];
        if (!storm) { setSrc(L_PS, EMPTY); return; }
        var fs = [];
        storm.passes.forEach(function (p, i) {
            var v = passV(p);
            if (p.lat == null || p.lon == null || v == null) return;
            var cur = p.f === fIdx && fIdx >= 0 ? 1 : 0;
            var lon = p.lon;
            if (cur && flight && flight.obs.ulon.length) {      // follow the flight's unwrapped longitude
                var l0 = flight.obs.ulon[0];
                while (lon - l0 > 180) lon -= 360; while (lon - l0 < -180) lon += 360;
            }
            fs.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, p.lat] }, properties: { i: i, v: v, cur: cur } });
            if (cur && L.divIcon) {
                var m = L.marker([p.lat, lon], {
                    icon: L.divIcon({ className: 'gsr-plabel', html: '<span>' + Math.round(v) + '</span>', iconSize: null, iconAnchor: [-8, 22] }),
                    interactive: false, keyboard: false
                });
                m.addTo(gmap); passLabels.push(m);
            }
        });
        fs.sort(function (a, b) { return a.properties.cur - b.properties.cur || a.properties.v - b.properties.v; });
        setSrc(L_PS, { type: 'FeatureCollection', features: fs });
    }
    function obsTip(i) {
        if (!flight) return '';
        var o = flight.obs, rows = [];
        rows.push('<b>' + esc(utc(o.ms[i], { sec: true })) + '</b> <span class="gsr-tip-sub">' + esc(tailName(flight.tail)) + '</span>');
        rows.push('Flight level <b>' + r0(o.fl[i]) + ' kt</b>' + (o.z[i] != null ? ' at ' + (o.z[i] / 1000).toFixed(1) + ' km' : '') +
            (o.p[i] != null ? ' (' + Math.round(o.p[i]) + ' hPa)' : ''));
        if (o.y[i] != null) {
            rows.push('<span style="color:' + pink() + '">SEAR 10-m <b>' + o.y[i] + ' kt</b></span>' +
                (o.y5[i] != null ? ' · 500 m ' + o.y5[i] + ' kt' : ''));
        } else rows.push('<span class="gsr-tip-sub">SEAR: not scored here</span>');
        if (o.r[i] != null) rows.push(where(o.az[i], o.r[i]) + (o.rr[i] != null ? ' · r/RMW ' + o.rr[i].toFixed(2) : ''));
        if (o.sf[i] != null && seriesOn.sf) rows.push('<span class="gsr-tip-sub">SFMR ' + o.sf[i] + ' kt (reference only)</span>');
        return rows.join('<br>');
    }
    function passTip(p) {
        if (!p) return '';
        var v = passV(p), fix = isFix(p);
        return '<b>Pass maximum ' + r0(v) + ' kt</b> <span class="gsr-tip-sub">' + esc(utc(p.t)) + '</span><br>' +
            (fix ? 'From the vortex message’s max flight-level wind ' : 'Flight-level peak ') + r0(p.fl_peak_kt) + ' kt' +
            (p.rmw_km != null ? ' · RMW ' + Math.round(p.rmw_km) + ' km' : '') +
            (p.tail ? '<br>' + esc(tailName(p.tail)) + (p.mission ? ' · mission ' + esc(p.mission) : '') : '');
    }

    var _hlLast = -1;
    function highlight(i, from) {
        if (!flight || i == null || i === _hlLast) return;
        _hlLast = i;
        var o = flight.obs;
        if (from !== 'map') {
            setSrc(L_HL, { type: 'FeatureCollection', features: [{ type: 'Feature',
                geometry: { type: 'Point', coordinates: [o.ulon[i], o.lat[i]] }, properties: {} }] });
        }
        var rel = $('gsr-rel');
        if (view === 'rel' && rel && rel._fullLayout && window.Plotly && rel._hlTrace != null) {
            try { Plotly.restyle(rel, { x: [[o.x[i]]], y: [[o.yy[i]]] }, [rel._hlTrace]); } catch (e) { }
        }
        var ts = $('gsr-ts');
        if (from !== 'ts' && ts && ts._fullLayout && window.Plotly) {
            try { Plotly.relayout(ts, { 'shapes[0].x0': o.ds[i], 'shapes[0].x1': o.ds[i], 'shapes[0].visible': true }); } catch (e) { }
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  charts
    // ══════════════════════════════════════════════════════════════
    function plotBase() {
        var T = window.TCATheme ? TCATheme.plotly() : {};
        return {
            paper_bgcolor: tv('--plot-paper', '#fff'), plot_bgcolor: tv('--plot-bg', '#fff'),
            font: T.font || { family: '"DM Sans", -apple-system, "Helvetica Neue", Arial, sans-serif', size: 11 },
            hoverlabel: T.hoverlabel || {},
            grid: tv('--plot-grid', 'rgba(15,22,35,.08)'), axis: tv('--plot-axis', '#5b6573'), text: tv('--plot-text', '#0f1623')
        };
    }
    function ax(B, o) {
        var a = { gridcolor: B.grid, linecolor: B.grid, zerolinecolor: B.grid, tickfont: { color: B.axis, size: 10 },
            title: { font: { color: B.axis, size: 10.5 } } };
        for (var k in o) {
            if (k === 'title') a.title.text = o.title; else a[k] = o[k];
        }
        return a;
    }
    function plot(el, data, layout, cfg) {
        return window.ensurePlotly().then(function () {
            el.classList.add('js-theme-ignore');   // redrawn on theme:change below, with theme-dependent trace colors
            return Plotly.react(el, data, layout, Object.assign({ responsive: true, displaylogo: false, displayModeBar: false }, cfg || {}));
        });
    }
    function clearPlot(el) {
        if (el && el._fullLayout && window.Plotly) { try { Plotly.purge(el); } catch (e) { } }
        if (el) el._gsrWired = false;
    }
    /* With no flight open the series panel is only a prompt: shrink it so the
       map gets the room, and give it back when a flight arrives. */
    function seriesOpen(on) {
        var tab = $('tab-sear');
        if (!tab || tab.classList.contains('gsr-noflight') === !on) return;
        tab.classList.toggle('gsr-noflight', !on);
        setTimeout(function () { if (gmap) gmap.invalidateSize(); plotResize('gsr-rel'); }, 30);
    }
    function renderEmptySeries(msg) {
        seriesOpen(false);
        var em = $('gsr-ts-empty'), ts = $('gsr-ts');
        em.innerHTML = msg; em.hidden = false;
        clearPlot(ts);
        ts.hidden = true;
        $('gsr-save').disabled = true;
        $('gsr-ts-title').textContent = storm ? stormLabel(storm) : 'Flight-level wind and SEAR along the flight';
    }

    function renderSeries() {
        if (!flight) return;
        var o = flight.obs, B = plotBase(), f = storm.flights[fIdx], r = byAtcf[sel];
        seriesOpen(true);
        $('gsr-ts-empty').hidden = true;
        var ts = $('gsr-ts'); ts.hidden = false;
        $('gsr-save').disabled = false;
        $('gsr-ts-title').textContent = stormLabel(storm) + ' · ' + tailName(f.tail) + ' · ' + flightSpan(f);
        var flC = dark() ? '#94a3b8' : '#475569';
        var data = [], fmtT = '%d %b %H:%M:%S UTC';
        var hv = function (lbl) { return lbl + ' %{y:.0f} kt<extra></extra>'; };
        if (seriesOn.fl) data.push({ x: o.ds, y: o.fl, name: 'Flight level', type: 'scattergl', mode: 'lines',
            line: { color: flC, width: 1.3 }, hovertemplate: hv('Flight level') });
        if (seriesOn.sf) data.push({ x: o.ds, y: o.sf, name: 'SFMR (reference only)', type: 'scattergl', mode: 'lines',
            line: { color: '#16a34a', width: 1, dash: 'dot' }, connectgaps: false, hovertemplate: hv('SFMR (reference)') });
        if (seriesOn.y5) data.push({ x: o.ds, y: o.y5, name: 'SEAR 500 m', type: 'scattergl', mode: 'lines',
            line: { color: dark() ? '#38bdf8' : '#0284c7', width: 1.2, dash: 'dash' }, connectgaps: false, hovertemplate: hv('SEAR 500 m') });
        if (seriesOn.y30) data.push({ x: o.ds, y: o.y30, name: 'SEAR 10-m (30-s)', type: 'scattergl', mode: 'lines',
            line: { color: pink(), width: 1, dash: 'dot' }, opacity: 0.8, connectgaps: false, hovertemplate: hv('SEAR 10-m, 30-s') });
        if (seriesOn.y) data.push({ x: o.ds, y: o.y, name: 'SEAR 10-m', type: 'scattergl', mode: 'lines',
            line: { color: pink(), width: 2 }, connectgaps: false, hovertemplate: hv('SEAR 10-m') });
        if (seriesOn.bt) {
            var bx = [], t0 = o.ms[0], t1 = o.ms[o.ms.length - 1];
            for (var t = t0; t <= t1; t += 600000) bx.push(t);
            bx.push(t1);
            var by = btAt(r, bx);
            if (by) data.push({ x: bx.map(D), y: by, name: 'Best track (comparison)', type: 'scatter', mode: 'lines',
                line: { color: dark() ? '#cbd5e1' : '#334155', width: 1.3, dash: 'longdash' }, hovertemplate: hv('Best track') });
        }
        // pass maxima: stars at the pass time (VDM-fix passes as open diamonds)
        var P = flightPasses().map(function (i) { return storm.passes[i]; });
        if (P.length) {
            data.push({ x: P.map(function (p) { return D(Date.parse(p.t)); }), y: P.map(passV), name: 'Pass maximum',
                type: 'scatter', mode: 'markers+text', text: P.map(function (p) { return String(Math.round(passV(p))); }),
                textposition: 'top center', textfont: { size: 10, color: B.text },
                marker: { symbol: P.map(function (p) { return isFix(p) ? 'diamond-open' : 'star'; }), size: 11,
                    color: P.map(function (p) { return ktColor(passV(p)); }), line: { color: B.text, width: 0.8 } },
                customdata: P.map(function (p) { return [p.fl_peak_kt, p.rmw_km == null ? '—' : Math.round(p.rmw_km)]; }),
                hovertemplate: 'Pass maximum %{y:.0f} kt<br>FL peak %{customdata[0]} kt · RMW %{customdata[1]} km<extra></extra>' });
        }
        var right = seriesOn.r ? 'r' : seriesOn.z ? 'z' : null;
        if (right === 'r') data.push({ x: o.ds, y: o.r, name: 'Radius', yaxis: 'y2', type: 'scattergl', mode: 'lines',
            line: { color: B.axis, width: 0.9 }, opacity: 0.45, hovertemplate: 'Radius %{y:.0f} km<extra></extra>' });
        if (right === 'z') data.push({ x: o.ds, y: o.z.map(function (v) { return v == null ? null : v / 1000; }), name: 'Height',
            yaxis: 'y2', type: 'scattergl', mode: 'lines', line: { color: '#1fa187', width: 1 }, opacity: 0.6,
            hovertemplate: 'Height %{y:.2f} km<extra></extra>' });
        var ymax = 40;
        [o.fl, o.y].forEach(function (a) { for (var i = 0; i < a.length; i++) if (a[i] != null && a[i] < 220 && a[i] > ymax) ymax = a[i]; });
        P.forEach(function (p) { if (passV(p) > ymax) ymax = passV(p); });
        var layout = {
            paper_bgcolor: B.paper_bgcolor, plot_bgcolor: B.plot_bgcolor, font: B.font, hoverlabel: B.hoverlabel,
            margin: { l: 44, r: right ? 44 : 12, t: 8, b: 30 }, hovermode: 'x unified', dragmode: 'zoom',
            showlegend: false, uirevision: storm.atcf + '/' + f.key,
            xaxis: ax(B, { type: 'date', hoverformat: fmtT }),
            yaxis: ax(B, { title: 'kt', range: [0, Math.ceil((ymax * 1.12) / 10) * 10], fixedrange: false }),
            shapes: [{ type: 'line', xref: 'x', yref: 'paper', x0: o.ds[0], x1: o.ds[0], y0: 0, y1: 1, visible: false,
                line: { color: B.axis, width: 1, dash: 'dot' } }]
        };
        if (right) layout.yaxis2 = ax(B, { title: right === 'r' ? 'radius, km' : 'height, km', overlaying: 'y', side: 'right',
            showgrid: false, rangemode: 'tozero', range: right === 'r' ? [0, Math.min(600, maxOf(o.r) * 1.05 || 300)] : undefined });
        plot(ts, data, layout).then(function () {
            if (ts._gsrWired) return;
            ts._gsrWired = true;
            ts.on('plotly_hover', function (ev) {
                if (!flight || !ev.points || !ev.points.length) return;
                var x = ev.points[0].x; x = typeof x === 'number' ? x : Date.parse(String(x).replace(' ', 'T') + 'Z');
                highlight(nearestIdx(flight.obs.ms, x), 'ts');
            });
            ts.on('plotly_unhover', function () { setSrc(L_HL, EMPTY); _hlLast = -1; });
        });
    }
    function maxOf(a) { var m = 0; for (var i = 0; i < a.length; i++) if (a[i] != null && a[i] > m) m = a[i]; return m; }
    function nearestIdx(T, x) {
        var lo = 0, hi = T.length - 1;
        while (hi - lo > 1) { var m = (lo + hi) >> 1; if (T[m] < x) lo = m; else hi = m; }
        return Math.abs(T[lo] - x) <= Math.abs(T[hi] - x) ? lo : hi;
    }

    function renderRel() {
        var el = $('gsr-rel'), B = plotBase();
        if (!flight) {
            clearPlot(el);
            el.innerHTML = '<div class="gsr-rel-empty">' + (sel ? 'Pick a flight to see it relative to the storm center.' :
                'Pick a storm, then a flight, to see it relative to the storm center.') + '</div>';
            return;
        }
        var o = flight.obs, n = o.t.length, X = [], Y = [], C = [], I = [], txt = [];
        var Rs = [];
        for (var i = 0; i < n; i++) {
            if (o.x[i] == null || o.r[i] > 400) continue;
            X.push(o.x[i]); Y.push(o.yy[i]); I.push(i);
            var v = colorBy === 'fl' ? o.fl[i] : colorBy === 'z' ? o.z[i] : o.y[i];
            C.push(colorBy === 'z' ? zColor(v) : ktColor(v));
            txt.push(utc(o.ms[i], { sec: true }) + '<br>FL ' + r0(o.fl[i]) + ' kt' + (o.y[i] != null ? ' · SEAR ' + o.y[i] + ' kt' : ' · not scored') +
                '<br>' + where(o.az[i], o.r[i]));
            if (o.y[i] != null) Rs.push(o.r[i]);
        }
        if (!X.length) { clearPlot(el); el.innerHTML = '<div class="gsr-rel-empty">This flight has no storm-relative positions within 400 km.</div>'; return; }
        if (!el._fullLayout) el.innerHTML = '';
        /* Default frame: where 90% of the scored observations are, so the
           eyewall pattern is not shrunk by the outer legs (zoom out by drag). */
        Rs.sort(function (a, b) { return a - b; });
        var R = Rs.length ? Rs[Math.floor(Rs.length * 0.9)] : 150;
        R = Math.max(60, Math.min(260, R * 1.15));
        var P = flightPasses().map(function (k) { return storm.passes[k]; }).filter(function (p) { return p.r != null && p.az != null; });
        var data = [
            { x: X, y: Y, type: 'scattergl', mode: 'lines', line: { color: B.axis, width: 0.6 }, opacity: 0.35, hoverinfo: 'skip' },
            { x: X, y: Y, type: 'scattergl', mode: 'markers', marker: { color: C, size: 5 }, text: txt, hovertemplate: '%{text}<extra></extra>' },
            { x: P.map(function (p) { return p.r * Math.sin(p.az * Math.PI / 180); }), y: P.map(function (p) { return p.r * Math.cos(p.az * Math.PI / 180); }),
                type: 'scatter', mode: 'markers+text', text: P.map(function (p) { return String(Math.round(passV(p))); }),
                textposition: 'top center', textfont: { size: 11, color: B.text },
                marker: { symbol: 'star', size: 13, color: P.map(function (p) { return ktColor(passV(p)); }), line: { color: B.text, width: 0.8 } },
                hovertemplate: 'Pass maximum %{text} kt<extra></extra>' },
            { x: [0], y: [0], type: 'scatter', mode: 'markers', marker: { symbol: 'cross-thin', size: 14, line: { color: B.text, width: 2 } }, hoverinfo: 'skip' },
            { x: [null], y: [null], type: 'scatter', mode: 'markers', hoverinfo: 'skip',
                marker: { size: 13, color: 'rgba(0,0,0,0)', line: { color: B.text, width: 2.2 } } }
        ];
        var rings = [50, 100, 150, 200, 250].filter(function (k) { return k <= R * 1.4; }).map(function (k) {
            return { type: 'circle', xref: 'x', yref: 'y', x0: -k, x1: k, y0: -k, y1: k, line: { color: B.grid, width: 1, dash: 'dot' } };
        });
        var ann = [50, 100, 200].filter(function (k) { return k < R; }).map(function (k) {
            return { x: k * 0.7071, y: k * 0.7071, text: k + ' km', showarrow: false, font: { size: 9, color: B.axis }, xanchor: 'left' };
        });
        var layout = {
            paper_bgcolor: B.paper_bgcolor, plot_bgcolor: B.plot_bgcolor, font: B.font, hoverlabel: B.hoverlabel,
            margin: { l: 46, r: 14, t: 34, b: 40 }, showlegend: false, hovermode: 'closest',
            uirevision: storm.atcf + '/' + storm.flights[fIdx].key,
            xaxis: ax(B, { title: 'km east of center', range: [-R, R], zeroline: false }),
            yaxis: ax(B, { title: 'km north of center', range: [-R, R], scaleanchor: 'x', scaleratio: 1, zeroline: false }),
            shapes: rings, annotations: ann.concat([{ xref: 'paper', yref: 'paper', x: 1, y: 1.02, yanchor: 'bottom', xanchor: 'right',
                showarrow: false, font: { size: 10.5, color: B.axis },
                text: 'North up, relative to the center the record uses for each pass' }])
        };
        plot(el, data, layout).then(function () {
            el._hlTrace = data.length - 1;
            if (el._gsrWired) return;
            el._gsrWired = true;
            el.on('plotly_hover', function (ev) {
                var pt = ev.points && ev.points[0];
                if (!pt || pt.curveNumber !== 1 || !flight) return;
                var idx = el._idx && el._idx[pt.pointIndex];
                if (idx != null) highlight(idx, 'rel');
            });
        });
        el._idx = I;
    }

    /* Sidebar: every pass maximum over the storm's life, best track for comparison,
       the open flight shaded. A click on a pass opens its flight. */
    function renderLife() {
        if (!storm) return;
        var el = $('gsr-life'), B = plotBase(), r = byAtcf[sel];
        var P = storm.passes.filter(function (p) { return passV(p) != null; });
        if (!P.length) { clearPlot(el); el.innerHTML = '<div class="gra-empty">No pass maxima.</div>'; return; }
        if (!el._fullLayout) el.innerHTML = '';
        var data = [], X = P.map(function (p) { return Date.parse(p.t); });
        var t0 = Math.min.apply(null, X), t1 = Math.max.apply(null, X);
        var tr = btTrack(r);
        if (tr && tr.length) {
            var tx = tr.map(function (p) { return Date.parse(p.t.length <= 16 ? p.t + 'Z' : p.t); });
            data.push({ x: tx.map(D), y: tr.map(function (p) { return p.w; }), type: 'scatter', mode: 'lines', name: 'Best track',
                line: { color: dark() ? '#cbd5e1' : '#334155', width: 1.2, dash: 'longdash' }, hovertemplate: 'Best track %{y:.0f} kt<extra></extra>' });
            t0 = Math.min(t0, tx[0]); t1 = Math.max(t1, tx[tx.length - 1]);
        }
        var leg = P.filter(function (p) { return !isFix(p); }), fix = P.filter(isFix);
        var mk = function (arr, sym, nm) {
            return { x: arr.map(function (p) { return D(Date.parse(p.t)); }), y: arr.map(passV), type: 'scatter', mode: 'markers', name: nm,
                marker: { symbol: sym, size: arr.map(function (p) { return p.f === fIdx && fIdx >= 0 ? 9 : 6.5; }),
                    color: sym === 'diamond-open' ? arr.map(function (p) { return ktColor(passV(p)); }) : arr.map(function (p) { return ktColor(passV(p)); }),
                    line: { color: arr.map(function (p) { return p.f === fIdx && fIdx >= 0 ? B.text : 'rgba(255,255,255,.7)'; }), width: arr.map(function (p) { return p.f === fIdx && fIdx >= 0 ? 1.4 : 0.6; }) } },
                customdata: arr.map(function (p) { return storm.passes.indexOf(p); }),
                hovertemplate: '%{x|%d %b %H:%M} UTC<br>' + nm + ' %{y:.0f} kt<extra></extra>' };
        };
        if (leg.length) data.push(mk(leg, 'circle', 'Pass maximum'));
        if (fix.length) data.push(mk(fix, 'diamond-open', 'VDM pass'));
        var shapes = [];
        if (fIdx >= 0) {
            var f = storm.flights[fIdx];
            shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: D(ms(f.t0)), x1: D(ms(f.t1)), y0: 0, y1: 1,
                fillcolor: dark() ? 'rgba(244,114,182,.16)' : 'rgba(190,24,93,.10)', line: { width: 0 } });
        }
        var pad = Math.max(3600e3, (t1 - t0) * 0.04);
        plot(el, data, {
            paper_bgcolor: B.paper_bgcolor, plot_bgcolor: B.plot_bgcolor, font: B.font, hoverlabel: B.hoverlabel,
            margin: { l: 34, r: 8, t: 6, b: 24 }, showlegend: false, hovermode: 'closest', shapes: shapes,
            xaxis: ax(B, { type: 'date', range: [D(t0 - pad), D(t1 + pad)], fixedrange: true, nticks: 5 }),
            yaxis: ax(B, { title: 'kt', rangemode: 'tozero', fixedrange: true })
        }).then(function () {
            if (el._gsrWired) return;
            el._gsrWired = true;
            el.on('plotly_click', function (ev) {
                var pt = ev.points && ev.points[0];
                if (!pt || pt.customdata == null || !storm) return;
                var p = storm.passes[pt.customdata];
                if (p && p.f != null && p.f !== fIdx) selectFlight(p.f, true);
                else if (p && p.f == null && window.GAArchive) GA().toast('This pass comes from a vortex message; no flight-level file covers it.');
            });
        });
    }

    function renderLegend() {
        var el = $('gsr-legend');
        var z = colorBy === 'z';
        var title = z ? 'Aircraft height (km)' : colorBy === 'fl' ? 'Flight-level wind (kt)' : 'SEAR 10-m wind (kt, experimental)';
        if (!flight) title = sel ? 'SEAR pass maxima (kt, experimental)' : 'Max SEAR 10-m per storm (kt)';
        var stops = z && flight ? Z_STOPS : KT_STOPS, labels = z && flight ? Z_LABELS : KT_LABELS;
        el.innerHTML = '<div class="gra-lt">' + title + '</div><div class="gra-swatches">' +
            stops.map(function (s, i) { return '<span><i class="gra-sw" style="background:' + s[1] + '"></i>' + labels[i] + '</span>'; }).join('') +
            (flight && colorBy === 'y' ? '<span><i class="gra-sw" style="background:' + GREY + '"></i>not scored</span>' : '') + '</div>' +
            (flight ? '<div class="gsr-lg-keys"><span><i class="gsr-k-star"></i>pass maximum</span><span><i class="gsr-k-bt"></i>best track</span></div>' : '');
    }

    // ══════════════════════════════════════════════════════════════
    //  wiring
    // ══════════════════════════════════════════════════════════════
    var showAbout = function () { };
    function wire() {
        $('gsr-search').addEventListener('input', function () { query = this.value; renderList(); });
        Array.prototype.forEach.call(document.querySelectorAll('#gsr-sorts .gra-chip'), function (b) {
            b.onclick = function () {
                Array.prototype.forEach.call(document.querySelectorAll('#gsr-sorts .gra-chip'), function (x) { x.classList.remove('active'); });
                b.classList.add('active'); sortKey = b.dataset.sort; renderList();
            };
        });
        function onRow(listId, attr, fn) {
            var el = $(listId);
            el.addEventListener('click', function (e) {
                var it = e.target.closest('[data-' + attr + ']'); if (it) fn(it.getAttribute('data-' + attr));
            });
            el.addEventListener('keydown', function (e) {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                var it = e.target.closest('[data-' + attr + ']'); if (it) { e.preventDefault(); fn(it.getAttribute('data-' + attr)); }
            });
        }
        onRow('gsr-list', 'a', function (a) { openStorm(a); });
        onRow('gsr-flights', 'f', function (k) { selectFlight(+k, true); });
        $('gsr-back').onclick = closeStorm;
        $('gsr-flight').onchange = function () { selectFlight(+this.value, true); };
        $('gsr-fprev').onclick = function () { if (fIdx > 0) selectFlight(fIdx - 1, true); };
        $('gsr-fnext').onclick = function () { if (storm && fIdx < storm.flights.length - 1) selectFlight(fIdx + 1, true); };
        segWire('gsr-color', 'c', function (v) {
            colorBy = v;
            if (flight) { drawFlight(false); if (view === 'rel') renderRel(); } else renderLegend();
        });
        segWire('gsr-view', 'v', function (v) {
            view = v;
            $('gsr-rel').hidden = v !== 'rel';
            $('gsr-map').style.visibility = v === 'rel' ? 'hidden' : '';
            if (v === 'rel') renderRel(); else setTimeout(function () { gmap.invalidateSize(); }, 30);
        });
        // series pills
        $('gsr-pills').innerHTML = SERIES.map(function (s) {
            return '<button type="button" class="gsr-pill gsr-pill-' + s.k + (seriesOn[s.k] ? ' on' : '') + '" data-k="' + s.k + '" aria-pressed="' +
                (seriesOn[s.k] ? 'true' : 'false') + '"' + (s.title ? ' title="' + esc(s.title) + '"' : '') + '><i></i>' + esc(s.label) + '</button>';
        }).join('');
        $('gsr-pills').addEventListener('click', function (e) {
            var b = e.target.closest('.gsr-pill'); if (!b) return;
            var k = b.dataset.k, def = SERIES.filter(function (s) { return s.k === k; })[0];
            seriesOn[k] = !seriesOn[k];
            if (def.axis && seriesOn[k]) SERIES.forEach(function (s) { if (s.axis && s.k !== k) seriesOn[s.k] = false; });   // one right axis
            Array.prototype.forEach.call(document.querySelectorAll('#gsr-pills .gsr-pill'), function (x) {
                x.classList.toggle('on', !!seriesOn[x.dataset.k]); x.setAttribute('aria-pressed', seriesOn[x.dataset.k] ? 'true' : 'false');
            });
            if (flight) renderSeries();
        });
        $('gsr-save').onclick = savePng;
        // About
        showAbout = function (on) {
            $('gsr-about').classList.toggle('open', on);
            $('gsr-about-scrim').classList.toggle('open', on);
        };
        function closeAbout() { showAbout(false); try { localStorage.setItem('gsr-about-seen', '1'); } catch (e) { } }
        $('gsr-about-btn').onclick = function () { if ($('gsr-about').classList.contains('open')) closeAbout(); else showAbout(true); };
        $('gsr-about-x').onclick = closeAbout;
        $('gsr-about-scrim').onclick = closeAbout;
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && $('gsr-about').classList.contains('open')) closeAbout();
        });
        try { if (!localStorage.getItem('gsr-about-seen') && !deep) showAbout(true); } catch (e) { }
        // tooltip host
        var tip = document.createElement('div');
        tip.id = 'gsr-tip'; tip.className = 'gra-tip gsr-tip';
        document.querySelector('#tab-sear .gsr-plan').appendChild(tip);
        // theme: trace colors depend on it, so redraw rather than patch
        document.documentElement.addEventListener('theme:change', function () {
            if (!booted) return;
            setTimeout(function () {
                mapTheme();
                if (flight) { renderSeries(); if (view === 'rel') renderRel(); }
                if (storm) renderLife();
            }, 30);
        });
        renderLegend();
    }
    function segWire(id, attr, fn) {
        var btns = document.querySelectorAll('#' + id + ' button');
        Array.prototype.forEach.call(btns, function (b) {
            b.onclick = function () {
                Array.prototype.forEach.call(btns, function (x) { x.classList.toggle('active', x === b); });
                fn(b.dataset[attr]);
            };
        });
    }

    /* Saved figure: title + ONE status line, in the viewer's theme. */
    function savePng() {
        var ts = $('gsr-ts');
        if (!flight || !ts._fullLayout || !window.TCExport) return;
        var f = storm.flights[fIdx], P = flightPasses().map(function (i) { return storm.passes[i]; });
        var pm = P.length ? Math.max.apply(null, P.map(passV)) : f.y_max_kt;
        var title = stormLabel(storm) + ' — ' + tailName(f.tail) + ', ' + flightSpan(f) + ' UTC';
        var status = 'SEAR 10-m (experimental) max ' + r0(pm) + ' kt · flight-level max ' + r0(f.fl_max_kt) + ' kt · TC-ATLAS';
        var fam = '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif';
        var keep = { 'margin.t': ts.layout.margin.t, 'title.text': '', showlegend: false };
        Plotly.relayout(ts, { 'margin.t': 58, 'title.text': title + '<br><span style="font-size:11px">' + status + '</span>',
            'title.x': 0.01, 'title.xanchor': 'left', 'title.font.size': 14, 'title.font.family': fam,
            showlegend: true, 'legend.orientation': 'h', 'legend.y': -0.16, 'legend.font.size': 10 }).then(function () {
            var file = 'SEAR_' + storm.atcf + '_' + f.key + '.png';
            return TCExport.savePlotly(ts, file, { scale: 2 });
        }).catch(function (e) { console.warn('[sear] save', e); }).then(function () {
            Plotly.relayout(ts, keep);
        });
    }
})();
