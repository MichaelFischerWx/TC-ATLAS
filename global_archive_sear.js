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
    /* The flight-level MAXIMA count only the storm's core (bin/build_sear_hist_v2.py
       CORE_R_KM / CORE_Z_M): farther out the files carry jet-stream winds and some bad
       stretches in old 10-s files. The time series still draws every observation. */
    function inCore(o, i) { return o.r[i] != null && o.r[i] <= 250 && o.z[i] != null && o.z[i] >= 300 && o.z[i] <= 5000; }
    function flTitle(src) {
        return ' title="' + (src === 'vdm'
            ? 'Maximum flight-level wind reported in a vortex data message; no flight-level file in the record covers it'
            : 'Maximum flight-level wind within 250 km of the center, aircraft below 5 km') + '"';
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
                    max_kt: s.max_kt, max_src: s.max_src, at: s.max_at || null, fl_max_kt: s.fl_max_kt, fl_src: s.fl_max_src || null,
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
                '<div class="gra-meta"><span>' + esc(r.atcf) + '</span><span' +
                (r.n_flights ? '>' + r.n_flights + ' flight' + (r.n_flights === 1 ? '' : 's')
                    : ' title="No flight-level file in the record: its passes come from vortex data messages">VDM fixes only') +
                ' · ' + r.n_passes + ' passes</span></div></div>' +
                '<div class="gra-it-vals"><div class="gra-num gsr-num"><b>' + r0(r.max_kt) + '</b> kt</div>' +
                '<div class="gra-num"' + flTitle(r.fl_src) + '>FL ' + r0(r.fl_max_kt) + (r.fl_src === 'vdm' ? ' <span class="gsr-vdm">VDM</span>' : '') +
                '</div></div></div>');
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
        $('gsr-maxnote').hidden = true;
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
            /* Land on the storm's maximum. When a vortex message sets it and no flight
               file covers it (165 storms), open the flight nearest it in time, say so
               above the chart, and in the Satellite view show the image at the maximum. */
            var mp = maxPassIdx(j), vdmMax = mp >= 0 && j.passes[mp].f == null;
            sat.pass = (vdmMax && !flightKey && view === 'sat') ? mp : null;
            sat.R = null; sat.idx = null;
            if (i < 0) i = landingFlight(j, mp);
            renderMaxNote(j, mp);
            if (i >= 0) selectFlight(i, true, true);
            else {
                fitStorm();
                renderLegend();
                renderEmptySeries('No flight-level file for this storm in the record. Its pass maxima come from ' +
                    'vortex data messages (the maximum flight-level wind of each center fix).' +
                    (vdmMax ? ' <button type="button" class="gsr-linkbtn" data-satpass="' + mp + '">See the storm maximum on the satellite image</button>' : ''));
                if (view === 'sat') renderSat();
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
    /* Index of the pass that sets the storm maximum, or -1 when an observation sets it. */
    function maxPassIdx(j) {
        if (j.max_src === 'obs' || j.pass_max_kt == null) return -1;
        for (var k = 0; k < j.passes.length; k++) if (j.passes[k].y_corr_kt === j.pass_max_kt) return k;
        return -1;
    }
    /* The flight that holds the maximum, else the one nearest it in time. */
    function landingFlight(j, mp) {
        if (!j.flights.length) return -1;
        if (mp < 0) return bestFlight(j);
        var p = j.passes[mp];
        if (p.f != null) return p.f;
        var tp = Date.parse(p.t) / 1000, best = -1, bd = Infinity;
        j.flights.forEach(function (f, k) {
            var d = tp < f.t0 ? f.t0 - tp : tp > f.t1 ? tp - f.t1 : 0;
            if (d < bd) { bd = d; best = k; }
        });
        return best;
    }
    function renderMaxNote(j, mp) {
        var el = $('gsr-maxnote'), p = mp >= 0 ? j.passes[mp] : null;
        if (!p || p.f != null || !j.flights.length) { el.hidden = true; el.innerHTML = ''; return; }
        el.hidden = false;
        el.innerHTML = 'Storm maximum <b>' + r0(passV(p)) + ' kt</b>, ' + esc(utc(Date.parse(p.t))) +
            ', is a vortex-message pass: no flight-level file covers it. ' +
            '<button type="button" class="gsr-linkbtn" data-satpass="' + mp + '">See it on the satellite image</button>';
    }
    /* Satellite view at one vortex-message pass (no flight file behind it). */
    function enterPassMode(k) {
        if (!storm || !storm.passes[k]) return;
        sat.pass = k; sat.idx = null; sat.R = null;
        if (view !== 'sat') document.querySelector('#gsr-view [data-v="sat"]').click();
        else renderSat();
    }
    function passMode() { return (storm && sat.pass != null) ? storm.passes[sat.pass] || null : null; }
    function passR(p) { return Math.max(60, Math.min(200, ((p && p.rmw_km) || 20) * 8)); }
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
        sat.pass = null; $('gsr-maxnote').hidden = true;
        $('gsr-pane-list').hidden = false;
        $('gsr-pane-storm').hidden = true;
        clearFlightLayers();
        setSrc(L_BT, EMPTY); setSrc(L_BTP, EMPTY); setSrc(L_PS, EMPTY);
        stormPoints();
        try { gmap.flyTo(LANDING[0], LANDING[1], { duration: 0.6 }); } catch (e) { }
        fillFlightSelect();
        renderEmptySeries('Pick a storm on the map or in the list, then a flight.');
        if (view === 'rel') renderRel();
        if (view === 'sat') renderSat();
        renderLegend();
        renderList();
        syncHash();
    }

    function renderStorm() {
        var r = byAtcf[sel], j = storm;
        var bt = btPeak(r);
        var sub = [r.atcf];
        if (j.basin) sub.push(j.basin);
        sub.push(j.flights.length ? j.flights.length + ' flight' + (j.flights.length === 1 ? '' : 's') : 'vortex messages only');
        $('gsr-st-sub').textContent = sub.join(' · ');
        var maxWhere = j.max_src === 'obs' ? 'on a flight' : (/^fix/.test(j.max_src) ? 'VDM pass' : 'eyewall pass');
        var tiles = [
            ['Max SEAR 10-m', '<b class="gsr-pk">' + r0(j.max_kt) + '</b> kt', maxWhere],
            ['Max flight level', '<b>' + r0(j.fl_max_kt) + '</b> kt',
                j.fl_max_src === 'vdm' ? 'from a vortex message' : 'within 250 km, below 5 km'],
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
                '<div class="gra-num"' + flTitle('flight') + '>FL ' + r0(f.fl_max_kt) + '</div></div></div>';
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
    function selectFlight(k, fit, keepPass) {
        if (!storm || k < 0 || k >= storm.flights.length) return;
        if (!keepPass && sat.pass != null) { sat.pass = null; sat.R = null; sat.idx = null; }   // a picked flight leaves the pass view
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
            satReset();
            renderSeries();
            if (view === 'rel') renderRel();
            if (view === 'sat') renderSat();
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
        if (view === 'sat') { sat.hover = i; drawSat(); }
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
        for (var i = 0; i < o.fl.length; i++) {   // axis from the storm's core, as the maxima are
            if (o.y[i] != null && o.y[i] > ymax) ymax = o.y[i];
            if (o.fl[i] != null && o.fl[i] > ymax && inCore(o, i)) ymax = o.fl[i];
        }
        P.forEach(function (p) { if (passV(p) > ymax) ymax = passV(p); });
        var layout = {
            paper_bgcolor: B.paper_bgcolor, plot_bgcolor: B.plot_bgcolor, font: B.font, hoverlabel: B.hoverlabel,
            margin: { l: 44, r: right ? 44 : 12, t: 8, b: 30 }, hovermode: 'x unified', dragmode: 'zoom',
            showlegend: false, uirevision: storm.atcf + '/' + f.key,
            xaxis: ax(B, { type: 'date', hoverformat: fmtT }),
            yaxis: ax(B, { title: 'kt', range: [0, Math.ceil((ymax * 1.12) / 10) * 10], fixedrange: false }),
            shapes: [{ type: 'line', xref: 'x', yref: 'paper', x0: o.ds[0], x1: o.ds[0], y0: 0, y1: 1, visible: false,
                line: { color: B.axis, width: 1, dash: 'dot' } },
                // the satellite image's time (Satellite view only)
                { type: 'line', xref: 'x', yref: 'paper', x0: o.ds[0], x1: o.ds[0], y0: 0, y1: 1, visible: false,
                    line: { color: '#0ea5e9', width: 2 } }]
        };
        if (right) layout.yaxis2 = ax(B, { title: right === 'r' ? 'radius, km' : 'height, km', overlaying: 'y', side: 'right',
            showgrid: false, rangemode: 'tozero', range: right === 'r' ? [0, Math.min(600, maxOf(o.r) * 1.05 || 300)] : undefined });
        plot(ts, data, layout).then(function () {
            if (view === 'sat' && sat.idx != null && irMeta[sat.sid]) markSeriesImage(frameMs(irMeta[sat.sid].frames[sat.idx]));
            if (ts._gsrWired) return;
            ts._gsrWired = true;
            ts.on('plotly_hover', function (ev) {
                if (!flight || !ev.points || !ev.points.length) return;
                var x = ev.points[0].x; x = typeof x === 'number' ? x : Date.parse(String(x).replace(' ', 'T') + 'Z');
                highlight(nearestIdx(flight.obs.ms, x), 'ts');
            });
            ts.on('plotly_unhover', function () {
                setSrc(L_HL, EMPTY); _hlLast = -1;
                if (view === 'sat' && sat.hover >= 0) { sat.hover = -1; drawSat(); }
            });
            /* Satellite view: a click on the chart asks for the image nearest that time. */
            ts.on('plotly_click', function (ev) {
                if (view !== 'sat' || !flight || !ev.points || !ev.points.length || !irMeta[sat.sid]) return;
                var x = ev.points[0].x; x = typeof x === 'number' ? x : Date.parse(String(x).replace(' ', 'T') + 'Z');
                sat.pass = null;                      // the chart is the flight's: leave the pass view
                sat.focus = x; sat.what = 'the time you picked';
                showSatFrame(nearestFrame(irMeta[sat.sid], x));
            });
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
        data.forEach(function (tr) {
            if (tr.name === 'VDM pass') tr.hovertemplate = '%{x|%d %b %H:%M} UTC<br>VDM pass %{y:.0f} kt<br>click: see it on the satellite image<extra></extra>';
        });
        var mpi = maxPassIdx(storm);
        if (mpi >= 0) {      // ring + label on the pass that sets the storm maximum
            var mp = storm.passes[mpi];
            data.push({ x: [D(Date.parse(mp.t))], y: [passV(mp)], type: 'scatter', mode: 'markers+text', hoverinfo: 'skip',
                text: [r0(passV(mp))], textposition: 'top center', textfont: { size: 10, color: B.text },
                marker: { symbol: 'circle-open', size: 15, line: { color: B.text, width: 1.5 } }, customdata: [mpi] });
        }
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
                else if (p && p.f == null) enterPassMode(pt.customdata);   // no flight file: show it on the image
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
    //  satellite view: the archive's infrared image nearest a time,
    //  with the flight pattern drawn on it
    // ══════════════════════════════════════════════════════════════
    /* The same frames as Storm Detail and the GHOST Reanalysis chip: /global/ir/meta
       lists one frame per best-track time (3-hourly), each a ~20-degree box of uint8
       brightness temperature centered on the best-track position, pre-rendered on the
       CDN (v7/ir/<sid>/<idx>.json) with the API as fallback. The track goes to
       /ir/meta VERBATIM, exactly as those views send it, so all three share one frame
       index space and one set of warmed R2 objects.

       The flight is placed by each observation's distance and bearing from the
       record's own center (r, az), around the image's best-track center. That lines
       the pattern up with the storm in the picture; plotting the as-flown lat/lon on
       a single 3-hourly snapshot would smear it along the storm's motion. */
    var API = 'https://api.tcatlas.org';
    var irMeta = {}, irMetaReq = {}, irFrames = {};
    var sat = { sid: null, idx: null, focus: null, what: '', tb: null, off: null, R: null, hover: -1, key: '' };
    var IR_CMAPS = [['claude-ir', 'Claude IR'], ['enhanced', 'Enhanced IR'], ['dvorak', 'Dvorak BD'],
        ['grayscale', 'Greyscale'], ['funktop', 'Funktop'], ['avn', 'AVN'], ['nhc', 'NHC'], ['rammb', 'RAMMB'], ['irb', 'IR-B']];
    var satCmap = null;
    var KM = 111.32;

    /* No image to show: clear it and hide the image's chrome (time, colorbar,
       readout) so nothing from the previous storm lingers next to the message. */
    function satNone(t) {
        sat.tb = null; sat.idx = null;
        $('gsr-sat').classList.add('gsr-sat-none');
        markSeriesImage(null);
        drawSat();
        satMsg(t);
    }
    function satMsg(t) {
        var m = $('gsr-sat-msg');
        m.innerHTML = t || '';
        m.style.display = t ? '' : 'none';
    }
    function satLut() {
        var maps = GA() && GA().irColormaps ? GA().irColormaps() : null;
        return maps ? (maps[satCmap] || maps['claude-ir'] || maps.enhanced) : null;
    }
    function fillSatCmaps() {
        var s = $('gsr-sat-cmap');
        if (s.options.length) return;
        var maps = GA() && GA().irColormaps ? GA().irColormaps() : {};
        var stored = null;
        try { stored = localStorage.getItem('gsr-ir-cmap'); } catch (e) { }
        satCmap = (stored && maps[stored]) ? stored : ((GA() && GA().irColormapName && GA().irColormapName()) || 'claude-ir');
        s.innerHTML = IR_CMAPS.filter(function (c) { return maps[c[0]]; })
            .map(function (c) { return '<option value="' + c[0] + '">' + c[1] + '</option>'; }).join('');
        s.value = satCmap;
    }
    /* The time the image should match: the flight's strongest pass, else its
       strongest scored observation, else the middle of the flight. */
    function satDefaultFocus() {
        var P = flightPasses().map(function (i) { return storm.passes[i]; });
        if (P.length) {
            var best = P[0];
            P.forEach(function (p) { if (passV(p) > passV(best)) best = p; });
            return { t: Date.parse(best.t), what: 'the strongest pass' };
        }
        var o = flight.obs, k = -1;
        for (var i = 0; i < o.y.length; i++) if (o.y[i] != null && (k < 0 || o.y[i] > o.y[k])) k = i;
        if (k >= 0) return { t: o.ms[k], what: 'the strongest SEAR estimate' };
        return { t: (o.ms[0] + o.ms[o.ms.length - 1]) / 2, what: 'mid-flight' };
    }
    function satReset() {
        sat.idx = null; sat.tb = null; sat.off = null; sat.R = null; sat.hover = -1; sat.key = '';
        var f = satDefaultFocus();
        sat.focus = f.t; sat.what = f.what;
    }
    var _satRetry = null;
    function renderSat() {
        if (view !== 'sat') return;
        fillSatCmaps();
        clearTimeout(_satRetry);
        var pm = passMode();
        if (!flight && !pm) {
            satNone(sel ? (storm && !storm.flights.length
                ? 'This storm has no flight-level file in the record, so there is no flight to draw.'
                : 'Loading the flight&hellip;') : 'Pick a storm, then a flight, to see it on the satellite image.');
            return;
        }
        var r = byAtcf[sel];
        if (!r || !r.sid) { satNone('No best-track match for this storm, so no satellite image.'); return; }
        var t = btTrack(r);
        if (!t || !t.length) {
            satMsg('Waiting for the best track&hellip;');
            _satRetry = setTimeout(renderSat, 1000);
            return;
        }
        if (pm) {
            sat.focus = Date.parse(pm.t);
            sat.what = (sat.pass === maxPassIdx(storm)) ? 'the storm maximum' : 'this vortex-message pass';
            if (sat.R == null) sat.R = passR(pm);
        } else if (sat.focus == null) satReset();
        loadIRMeta(r.sid, t).then(function (m) {
            if (view !== 'sat' || (!flight && !passMode()) || byAtcf[sel].sid !== r.sid) return;
            if (!m || !m.available || !m.frames || !m.frames.length) {
                satNone('No infrared image for this storm' + (m && m.reason ? ': ' + esc(m.reason) : '') + '.');
                return;
            }
            sat.sid = r.sid;
            showSatFrame(nearestFrame(m, sat.focus));
        }).catch(function (e) {
            if (window.TCErrors) TCErrors.log(e, 'SEAR satellite frame list');
            satMsg('Could not load the satellite frame list. <a href="#" id="gsr-sat-retry">Try again</a>');
            var a = $('gsr-sat-retry');
            if (a) a.onclick = function (ev) { ev.preventDefault(); delete irMetaReq[r.sid]; renderSat(); };
        });
    }
    function loadIRMeta(sid, t) {
        if (irMeta[sid]) return Promise.resolve(irMeta[sid]);
        if (irMetaReq[sid]) return irMetaReq[sid];
        satMsg('Loading the satellite frame list&hellip;');
        var trk = t.map(function (p) { return { t: p.t, la: p.la, lo: p.lo }; });
        irMetaReq[sid] = fetchJSON(API + '/global/ir/meta?sid=' + encodeURIComponent(sid) +
            '&track=' + encodeURIComponent(JSON.stringify(trk))).then(function (j) {
            irMeta[sid] = j; return j;
        }).catch(function (e) { delete irMetaReq[sid]; throw e; });
        return irMetaReq[sid];
    }
    function frameMs(f) { return Date.parse(f.datetime + 'Z'); }
    function nearestFrame(m, t) {
        var best = 0, bd = Infinity;
        for (var i = 0; i < m.frames.length; i++) {
            var d = Math.abs(frameMs(m.frames[i]) - t);
            if (d < bd) { bd = d; best = i; }
        }
        return best;
    }
    function showSatFrame(idx) {
        var m = irMeta[sat.sid];
        if (!m || idx < 0 || idx >= m.frames.length) return;
        sat.idx = idx;
        var f = m.frames[idx], ms = frameMs(f);
        $('gsr-sat-time').innerHTML = '<span class="gsr-full">IR </span>' + esc(utc(ms));   // the year is in the flight label
        var dt = Math.round((ms - sat.focus) / 60000);
        $('gsr-sat-dt').textContent = dt === 0 ? ' · at ' + sat.what
            : ' · ' + Math.abs(dt) + ' min ' + (dt < 0 ? 'before ' : 'after ') + sat.what;
        $('gsr-sat-prev').disabled = idx <= 0;
        $('gsr-sat-next').disabled = idx >= m.frames.length - 1;
        markSeriesImage(passMode() ? null : ms);   // a pass-mode image belongs to no flight on the chart
        var key = sat.sid + '/' + idx;
        if (irFrames[key]) return paintSat(irFrames[key], key);
        satMsg('Loading the infrared image&hellip;');
        var direct = m.frame_cdn_base ? m.frame_cdn_base + '/' + sat.sid + '/' + idx + '.json' : null;
        var api = API + '/global/ir/frame?sid=' + encodeURIComponent(sat.sid) + '&frame_idx=' + idx +
            '&lat=' + f.lat + '&lon=' + f.lon + '&dt=' + encodeURIComponent(f.datetime);
        (direct ? fetch(direct).then(function (r) { return r.ok ? r.json() : fetchJSON(api); }) : fetchJSON(api))
            .then(function (j) {
                if (!j || !j.tb_data) throw new Error('no IR data for this frame');
                irFrames[key] = j;
                if (sat.idx === idx && sat.sid + '/' + idx === key) paintSat(j, key);
            }).catch(function (e) {
                if (sat.idx !== idx) return;
                sat.tb = null; drawSat();
                satMsg('No infrared image for ' + esc(utc(ms)) + ' (' + esc(e.message || e) + '). Step to another image.');
            });
    }
    /* uint8 Tb: 0 = no data, 1..255 linear over [tb_vmin, tb_vmax] (global_archive.js decodeTbData). */
    function paintSat(j, key) {
        var bin = atob(j.tb_data), raw = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
        sat.tb = { raw: raw, rows: j.tb_rows, cols: j.tb_cols, vmin: j.tb_vmin, vmax: j.tb_vmax, b: j.bounds,
            source: j.source || null, at: j.actual_datetime || null };
        sat.key = key;
        $('gsr-sat').classList.remove('gsr-sat-none');
        colorSat();
        var src = sat.tb.source === 'gridsat' ? 'GridSat-B1 8 km' : sat.tb.source === 'hursat' ? 'HURSAT' : 'MergIR 4 km';
        var sub = sat.tb.source === 'hursat' && sat.tb.at ? ' (scan ' + utc(sat.tb.at, { date: false }) + ')' : '';
        $('gsr-sat-time').title = 'Infrared brightness temperature, ' + src + sub +
            '. The same image Storm Detail shows for this time.';
        satMsg('');
        drawSat();
    }
    /* One LUT pass into an offscreen canvas at source resolution; zoom and hover
       only re-blit it. No-data is a grey checker that belongs to no colormap. */
    function colorSat() {
        var tb = sat.tb; if (!tb) return;
        var lut = satLut();
        if (!sat.off) sat.off = document.createElement('canvas');
        sat.off.width = tb.cols; sat.off.height = tb.rows;
        var octx = sat.off.getContext('2d'), im = octx.createImageData(tb.cols, tb.rows), d = im.data;
        for (var i = 0, n = tb.rows * tb.cols; i < n; i++) {
            var v = tb.raw[i], o = i * 4;
            if (v === 0) {
                var yy = (i / tb.cols) | 0, xx = i - yy * tb.cols, q = (((xx >> 3) + (yy >> 3)) & 1) ? 122 : 98;
                d[o] = d[o + 1] = d[o + 2] = q;
            } else if (lut) {
                var k = v * 4; d[o] = lut[k]; d[o + 1] = lut[k + 1]; d[o + 2] = lut[k + 2];
            } else { d[o] = d[o + 1] = d[o + 2] = 255 - v; }
            d[o + 3] = 255;
        }
        octx.putImageData(im, 0, 0);
        drawSatBar();
    }
    function drawSatBar() {
        var tb = sat.tb, lut = satLut(), c = $('gsr-sat-bar'), tk = $('gsr-sat-ticks');
        if (!tb || !lut) { c.parentNode.style.display = 'none'; return; }
        c.parentNode.style.display = '';
        var ctx = c.getContext('2d'), im = ctx.createImageData(256, 8);
        for (var x = 0; x < 256; x++) {
            var v = Math.max(1, Math.min(255, x)), k = v * 4;
            for (var y = 0; y < 8; y++) { var o = (y * 256 + x) * 4; im.data[o] = lut[k]; im.data[o + 1] = lut[k + 1]; im.data[o + 2] = lut[k + 2]; im.data[o + 3] = 255; }
        }
        ctx.putImageData(im, 0, 0);
        var html = [];
        [-80, -60, -40, -20, 0, 20].forEach(function (cdeg) {
            var raw = 1 + (cdeg + 273.15 - tb.vmin) * 254 / (tb.vmax - tb.vmin);
            if (raw < 1 || raw > 255) return;
            html.push('<span style="left:' + (raw / 256 * 100).toFixed(1) + '%">' + (cdeg > 0 ? '+' : cdeg < 0 ? '−' : '') + Math.abs(cdeg) + '</span>');
        });
        tk.innerHTML = html.join('') + '<em>°C</em>';
    }
    /* km (east, north) of the image center <-> canvas px. The image center is the
       frame's best-track position; source pixels are a regular lat/lon grid. */
    function satGeom() {
        var cv = $('gsr-sat-canvas'), box = $('gsr-sat');
        var W = box.clientWidth, H = box.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
        if (!W || !H) return null;
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
            cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        }
        if (sat.R == null) sat.R = passMode() ? passR(passMode()) : flight ? satDefaultR() : 150;
        var k = (H * dpr) / (2 * sat.R);
        return { cv: cv, W: W * dpr, H: H * dpr, dpr: dpr, k: k };
    }
    function satDefaultR() {
        /* Frame the core: eight radii of maximum wind at the strongest pass (Melissa's
           13-km RMW opens at ~100 km, a broad storm at the 200-km cap); without an
           RMW, where most of the scored observations are. */
        var P = flightPasses().map(function (k) { return storm.passes[k]; }).filter(function (p) { return p.rmw_km; });
        if (P.length) {
            var best = P[0];
            P.forEach(function (p) { if (passV(p) > passV(best)) best = p; });
            return Math.max(60, Math.min(200, best.rmw_km * 8));
        }
        var o = flight.obs, rs = [];
        for (var i = 0; i < o.r.length; i++) if (o.y[i] != null && o.r[i] != null) rs.push(o.r[i]);
        rs.sort(function (a, b) { return a - b; });
        var R = rs.length ? rs[Math.floor(rs.length * 0.75)] : 150;
        return Math.max(60, Math.min(200, R * 1.1));
    }
    function satCenter() {
        var b = sat.tb && sat.tb.b;
        return b ? { lat: (b.north + b.south) / 2, lon: (b.west + b.east) / 2 } : null;
    }
    function drawSat() {
        var g = satGeom(); if (!g) return;
        var ctx = g.cv.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#05080d';
        ctx.fillRect(0, 0, g.W, g.H);
        var tb = sat.tb;
        var pm = passMode();
        if (!tb || !sat.off || (!flight && !pm)) return;
        var c = satCenter(), b = tb.b, cl = Math.cos(c.lat * Math.PI / 180);
        var toCx = function (xkm) { return g.W / 2 + xkm * g.k; }, toCy = function (ykm) { return g.H / 2 - ykm * g.k; };
        // image: the visible km window -> lon/lat -> source px, clamped to the frame
        var halfX = g.W / 2 / g.k, halfY = g.H / 2 / g.k;
        var lonL = c.lon - halfX / (KM * cl), lonR = c.lon + halfX / (KM * cl);
        var latT = c.lat + halfY / KM, latB = c.lat - halfY / KM;
        var sxPerLon = tb.cols / (b.east - b.west), syPerLat = tb.rows / (b.north - b.south);
        var s0x = (lonL - b.west) * sxPerLon, s1x = (lonR - b.west) * sxPerLon;
        var s0y = (b.north - latT) * syPerLat, s1y = (b.north - latB) * syPerLat;
        var d0x = 0, d1x = g.W, d0y = 0, d1y = g.H, sc;
        sc = (d1x - d0x) / (s1x - s0x);
        if (s0x < 0) { d0x -= s0x * sc; s0x = 0; } if (s1x > tb.cols) { d1x -= (s1x - tb.cols) * sc; s1x = tb.cols; }
        sc = (d1y - d0y) / (s1y - s0y);
        if (s0y < 0) { d0y -= s0y * sc; s0y = 0; } if (s1y > tb.rows) { d1y -= (s1y - tb.rows) * sc; s1y = tb.rows; }
        ctx.imageSmoothingEnabled = false;          // crisp pixels: the data's real resolution
        if (s1x > s0x && s1y > s0y) ctx.drawImage(sat.off, s0x, s0y, s1x - s0x, s1y - s0y, d0x, d0y, d1x - d0x, d1y - d0y);
        var px = g.dpr;
        // coastlines: full-resolution 10 m tiles for the window; the simplified copy while
        // they load, or when the window is too wide for tiles
        var hiCoast = window.TCCoastTiles ? TCCoastTiles.get(latB - 0.3, latT + 0.3, lonL - 0.3, lonR + 0.3, drawSat) : false;
        if (hiCoast === false && !satCoast) loadCoast();
        var coastGeo = hiCoast || satCoast;
        if (coastGeo) {
            ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
            [['rgba(0,0,0,.55)', 3 * px], ['rgba(255,255,255,.9)', 1.2 * px]].forEach(function (pass) {
                ctx.strokeStyle = pass[0]; ctx.lineWidth = pass[1]; ctx.beginPath();
                eachCoastRun(coastGeo, c, halfX, halfY, cl, function (run) {
                    for (var i = 0; i < run.length; i += 2) {
                        var X = toCx(run[i]), Y = toCy(run[i + 1]);
                        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
                    }
                });
                ctx.stroke();
            });
            ctx.restore();
        }
        // range rings
        ctx.save();
        ctx.setLineDash([4 * px, 4 * px]); ctx.lineWidth = 1 * px; ctx.strokeStyle = 'rgba(255,255,255,.45)';
        ctx.font = (10 * px) + 'px "DM Sans", -apple-system, Helvetica, Arial, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,.75)';
        [50, 100, 200, 300].forEach(function (rk) {
            if (rk > Math.max(halfX, halfY) * 1.3) return;
            ctx.beginPath(); ctx.arc(toCx(0), toCy(0), rk * g.k, 0, 2 * Math.PI); ctx.stroke();
            ctx.fillText(rk + ' km', toCx(rk * 0.7071) + 3 * px, toCy(rk * 0.7071) - 3 * px);
        });
        ctx.restore();
        if (pm) {   // a vortex-message pass: its RMW about the center (the message gives no bearing)
            if (pm.rmw_km) {
                ctx.save();
                ctx.setLineDash([6 * px, 4 * px]);
                [['rgba(0,0,0,.6)', 4 * px], ['#fbbf24', 2 * px]].forEach(function (pass) {
                    ctx.strokeStyle = pass[0]; ctx.lineWidth = pass[1];
                    ctx.beginPath(); ctx.arc(toCx(0), toCy(0), pm.rmw_km * g.k, 0, 2 * Math.PI); ctx.stroke();
                });
                ctx.restore();
            }
            satCross(ctx, toCx(0), toCy(0), px);
            var rr = (pm.rmw_km || 0) * g.k;
            satLabel(ctx, r0(passV(pm)) + ' kt SEAR \u00b7 VDM flight level ' + r0(pm.fl_peak_kt) + ' kt' +
                (pm.rmw_km ? ' \u00b7 RMW ' + Math.round(pm.rmw_km) + ' km' : ''), toCx(0) + rr * 0.72 + 8 * px, toCy(0) - rr * 0.72 - 8 * px, px);
            return;
        }
        // flight pattern: halo line, then dots colored like the map
        var o = flight.obs, n = o.t.length;
        ctx.save(); ctx.lineJoin = 'round';
        [['rgba(0,0,0,.6)', 3.2 * px], ['rgba(255,255,255,.75)', 1.2 * px]].forEach(function (pass) {
            ctx.strokeStyle = pass[0]; ctx.lineWidth = pass[1]; ctx.beginPath();
            var pen = false;
            for (var i = 0; i < n; i++) {
                if (o.x[i] == null || o.r[i] > 600) { pen = false; continue; }
                var X = toCx(o.x[i]), Y = toCy(o.yy[i]);
                if (pen) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
                pen = true;
            }
            ctx.stroke();
        });
        for (var i = 0; i < n; i++) {
            if (o.x[i] == null || o.r[i] > 600) continue;
            var v = colorBy === 'fl' ? o.fl[i] : colorBy === 'z' ? o.z[i] : o.y[i];
            ctx.beginPath(); ctx.arc(toCx(o.x[i]), toCy(o.yy[i]), 2.4 * px, 0, 2 * Math.PI);
            ctx.fillStyle = colorBy === 'z' ? zColor(v) : ktColor(v); ctx.fill();
            ctx.lineWidth = 0.6 * px; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
        }
        ctx.restore();
        // best-track center of the image (the frame is cut about it)
        satCross(ctx, toCx(0), toCy(0), px);
        // pass maxima
        flightPasses().forEach(function (k) {
            var p = storm.passes[k];
            if (p.r == null || p.az == null) return;
            var a = p.az * Math.PI / 180, X = toCx(p.r * Math.sin(a)), Y = toCy(p.r * Math.cos(a));
            satStar(ctx, X, Y, 7 * px, ktColor(passV(p)), px);
            satLabel(ctx, String(Math.round(passV(p))), X + 9 * px, Y - 9 * px, px);
        });
        // the observation under the chart / map cursor
        if (sat.hover >= 0 && sat.hover < n && o.x[sat.hover] != null) {
            ctx.beginPath(); ctx.arc(toCx(o.x[sat.hover]), toCy(o.yy[sat.hover]), 8 * px, 0, 2 * Math.PI);
            ctx.lineWidth = 2.6 * px; ctx.strokeStyle = '#0f172a'; ctx.stroke();
            ctx.lineWidth = 1.4 * px; ctx.strokeStyle = '#f8fafc'; ctx.stroke();
        }
    }
    function satCross(ctx, x, y, px) {
        var gap = 4 * px, arm = 9 * px;
        ctx.save(); ctx.lineCap = 'round';
        [['rgba(0,0,0,.65)', 4.4 * px], ['#38bdf8', 2 * px]].forEach(function (pass) {
            ctx.strokeStyle = pass[0]; ctx.lineWidth = pass[1]; ctx.beginPath();
            ctx.moveTo(x - gap - arm, y); ctx.lineTo(x - gap, y); ctx.moveTo(x + gap, y); ctx.lineTo(x + gap + arm, y);
            ctx.moveTo(x, y - gap - arm); ctx.lineTo(x, y - gap); ctx.moveTo(x, y + gap); ctx.lineTo(x, y + gap + arm);
            ctx.stroke();
        });
        ctx.restore();
    }
    function satStar(ctx, x, y, r, fill, px) {
        ctx.save(); ctx.beginPath();
        for (var i = 0; i < 10; i++) {
            var a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
            ctx[i ? 'lineTo' : 'moveTo'](x + rr * Math.cos(a), y + rr * Math.sin(a));
        }
        ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
        ctx.lineWidth = 1.4 * px; ctx.strokeStyle = '#ffffff'; ctx.stroke();
        ctx.restore();
    }
    function satLabel(ctx, s, x, y, px) {
        ctx.save();
        ctx.font = '600 ' + (11 * px) + 'px "DM Sans", -apple-system, Helvetica, Arial, sans-serif';
        ctx.lineWidth = 3 * px; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.lineJoin = 'round';
        ctx.strokeText(s, x, y); ctx.fillStyle = '#ffffff'; ctx.fillText(s, x, y);
        ctx.restore();
    }
    /* Coastlines: full-resolution Natural Earth 10 m tiles (coast_tiles.js) under the
       window; the vendored simplified whole-world copy is the fallback. Runs are
       converted to km about the image center. */
    var satCoast = null, _coastLoading = false;
    function loadCoast() {
        if (satCoast || _coastLoading) return;
        _coastLoading = true;
        fetch('assets/coastlines/ne_10m_coastline_simplified.geojson').then(function (r) { return r.json(); })
            .then(function (gj) { satCoast = gj; drawSat(); })
            .catch(function () { _coastLoading = false; });
    }
    function eachCoastRun(geo, c, halfX, halfY, cl, fn) {
        var feats = geo.features || [], padX = halfX * 1.1, padY = halfY * 1.1;
        for (var i = 0; i < feats.length; i++) {
            var gm = feats[i].geometry; if (!gm) continue;
            var lines = gm.type === 'LineString' ? [gm.coordinates] : gm.type === 'MultiLineString' ? gm.coordinates : null;
            if (!lines) continue;
            for (var L2 = 0; L2 < lines.length; L2++) {
                var cs = lines[L2], run = null;
                for (var k = 0; k < cs.length; k++) {
                    var lon = cs[k][0]; while (lon - c.lon > 180) lon -= 360; while (c.lon - lon > 180) lon += 360;
                    var x = (lon - c.lon) * KM * cl, y = (cs[k][1] - c.lat) * KM;
                    if (Math.abs(x) <= padX && Math.abs(y) <= padY) {
                        if (!run) run = [];
                        run.push(x, y);
                    } else if (run) { run.push(x, y); fn(run); run = null; }
                }
                if (run) fn(run);
            }
        }
    }
    /* Cursor readout: brightness temperature and where it is. */
    function satRead(ev) {
        var g = satGeom(), tb = sat.tb, out = $('gsr-sat-read');
        if (!g || !tb || !sat.off) { out.textContent = ''; return; }
        var rect = g.cv.getBoundingClientRect();
        var X = (ev.clientX - rect.left) * g.dpr, Y = (ev.clientY - rect.top) * g.dpr;
        var xkm = (X - g.W / 2) / g.k, ykm = (g.H / 2 - Y) / g.k, c = satCenter(), b = tb.b;
        var lat = c.lat + ykm / KM, lon = c.lon + xkm / (KM * Math.cos(c.lat * Math.PI / 180));
        var col = Math.floor((lon - b.west) / (b.east - b.west) * tb.cols), row = Math.floor((b.north - lat) / (b.north - b.south) * tb.rows);
        if (col < 0 || row < 0 || col >= tb.cols || row >= tb.rows) { out.textContent = ''; return; }
        var v = tb.raw[row * tb.cols + col], r = Math.sqrt(xkm * xkm + ykm * ykm);
        var az = (Math.atan2(xkm, ykm) * 180 / Math.PI + 360) % 360;
        var tc = v ? (tb.vmin + (v - 1) * (tb.vmax - tb.vmin) / 254 - 273.15) : null;
        out.textContent = (tc == null ? 'no data' : (tc < 0 ? '−' : '') + Math.abs(tc).toFixed(0) + ' °C') +
            ' · ' + Math.round(r) + ' km ' + compass(az) + ' of the best-track center';
    }
    /* The image time on the series chart (shapes[1]), so the reader sees which
       part of the flight the picture belongs to. */
    function markSeriesImage(ms) {
        var ts = $('gsr-ts');
        if (!ts || !ts._fullLayout || !window.Plotly || !ts.layout.shapes || ts.layout.shapes.length < 2) return;
        var show = view === 'sat' && ms != null;
        try { Plotly.relayout(ts, { 'shapes[1].x0': D(ms || 0), 'shapes[1].x1': D(ms || 0), 'shapes[1].visible': show }); } catch (e) { }
    }
    function wireSat() {
        $('gsr-sat-prev').onclick = function () { if (sat.idx > 0) showSatFrame(sat.idx - 1); };
        $('gsr-sat-next').onclick = function () { var m = irMeta[sat.sid]; if (m && sat.idx < m.frames.length - 1) showSatFrame(sat.idx + 1); };
        $('gsr-sat-zin').onclick = function () { if (sat.R) { sat.R = Math.max(30, sat.R / 1.4); drawSat(); } };
        $('gsr-sat-zout').onclick = function () { if (sat.R) { sat.R = Math.min(1100, sat.R * 1.4); drawSat(); } };
        $('gsr-sat-cmap').onchange = function () {
            satCmap = this.value;
            try { localStorage.setItem('gsr-ir-cmap', satCmap); } catch (e) { }
            colorSat(); drawSat();
        };
        var cv = $('gsr-sat-canvas');
        cv.addEventListener('wheel', function (e) {
            if (!sat.R || !sat.tb) return;
            e.preventDefault();
            sat.R = Math.max(30, Math.min(1100, sat.R * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
            drawSat();
        }, { passive: false });
        cv.addEventListener('dblclick', function () {
            if (passMode()) sat.R = passR(passMode()); else if (flight) sat.R = satDefaultR(); else return;
            drawSat();
        });
        cv.addEventListener('mousemove', satRead);
        cv.addEventListener('mouseleave', function () { $('gsr-sat-read').textContent = ''; });
        wireSatTouch(cv);
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(function () { if (view === 'sat') drawSat(); }).observe($('gsr-sat'));
    }

    /* Touch: two-finger pinch sets the zoom (the window's radius scales with the
       finger spread), one finger reads the brightness temperature under it, and a
       double tap resets the zoom like a double click. Mouse input keeps the wheel. */
    function wireSatTouch(cv) {
        var pts = {}, pinch = null, lastTap = null, raf = 0;
        function list() { return Object.keys(pts).map(function (k) { return pts[k]; }); }
        function spread() { var a = list(); return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
        function redraw() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; drawSat(); }); }
        cv.addEventListener('pointerdown', function (e) {
            if (e.pointerType === 'mouse') return;
            pts[e.pointerId] = { x: e.clientX, y: e.clientY };
            try { cv.setPointerCapture(e.pointerId); } catch (err) { }
            var n = list().length;
            if (n === 2 && sat.R && sat.tb) { pinch = { d: Math.max(spread(), 1), R: sat.R }; lastTap = null; return; }
            if (n !== 1) return;
            var now = Date.now();
            if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
                lastTap = null;
                if (passMode()) sat.R = passR(passMode()); else if (flight) sat.R = satDefaultR(); else return;
                drawSat(); return;
            }
            lastTap = { t: now, x: e.clientX, y: e.clientY };
            satRead(e);
        });
        cv.addEventListener('pointermove', function (e) {
            if (!(e.pointerId in pts)) return;
            pts[e.pointerId] = { x: e.clientX, y: e.clientY };
            if (pinch && list().length >= 2) {
                var d = spread(); if (d < 8) return;
                sat.R = Math.max(30, Math.min(1100, pinch.R * pinch.d / d));
                redraw();
            } else if (!pinch) satRead(e);
        });
        function lift(e) {
            if (!(e.pointerId in pts)) return;
            delete pts[e.pointerId];
            if (list().length < 2) pinch = null;
        }
        cv.addEventListener('pointerup', lift);
        cv.addEventListener('pointercancel', lift);
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
            if (flight) { drawFlight(false); if (view === 'rel') renderRel(); if (view === 'sat') drawSat(); } else renderLegend();
        });
        segWire('gsr-view', 'v', function (v) {
            view = v;
            $('gsr-rel').hidden = v !== 'rel';
            $('gsr-sat').hidden = v !== 'sat';
            $('gsr-map').style.visibility = v === 'map' ? '' : 'hidden';
            markSeriesImage(v === 'sat' && sat.idx != null && irMeta[sat.sid] ? frameMs(irMeta[sat.sid].frames[sat.idx]) : null);
            if (v === 'rel') renderRel();
            else if (v === 'sat') renderSat();
            else setTimeout(function () { gmap.invalidateSize(); }, 30);
        });
        wireSat();
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
        $('gsr-series').addEventListener('click', function (e) {
            var b = e.target.closest('[data-satpass]');
            if (b) enterPassMode(+b.getAttribute('data-satpass'));
        });
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
