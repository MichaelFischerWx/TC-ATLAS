/* global_archive_ghostra.js — Global Archive tab 4: GHOST Reanalysis.
 *
 * Recon-independent TC intensity estimates (GHOST-FPM) over 1998–2025, as a
 * frame cloud on the archive map plus the MergIR scene behind each estimate.
 * Design doc: GHOST/TCATLAS_GHOSTRA_TAB_PLAN_2026-08-14.md
 * Producer:   TC-SWARM experiments/stage0_intensity/build_ghostra_publish.py
 *
 * Deliberately NOT self-contained — it is a tab, not a page, and reuses what
 * global_archive.js already has in memory, via the window.GAArchive bridge it
 * exposes at the bottom of its IIFE:
 *   GA().getTrack(sid)  the IBTrACS track — and the same object handed to
 *                       /global/ir/meta, so this tab and Storm Detail share
 *                       one frame-index space and one set of warmed R2 frames
 *   GA().getStorm(sid)  the IBTrACS record, for the Storm Detail handoff
 *   GA().selectStorm / GA().syncIRToTime / GA().toast — only window.switchTab
 *   and window.selectStormFromPopup are true globals over there
 *
 * Map: built with L.* exactly like initBrowserMap(), so pan/zoom/basemap match
 * the Storm Browser. The one departure is the point layer — 42k+ frames go in
 * as a native MapLibre circle layer via map.getGL(), because Leaflet markers
 * stutter at that count and, more importantly, the intensity filters then
 * become setFilter() expressions evaluated on the GPU instead of a rebuild.
 *
 * Public API: window.activateGhostRAView()  (called from switchTab).
 */
(function () {
    'use strict';

    var qs = new URLSearchParams(location.search);
    /* Published to gs://tc-atlas-ir-cache/ghost-ra/ and mirrored to R2; read
       from the CDN so egress is free and edge-cached, exactly like ghost-rt.
       On localhost, default to the sibling ghost-ra/ tree instead: it is where
       build_ghostra_publish.py writes, and it means a dev server just works
       without remembering a query string. ?ghostra=<base> overrides either. */
    var LOCALHOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    var CDN = 'https://cdn.tcatlas.org/ghost-ra/v1';
    /* GCS is the primary WRITE; R2 is a best-effort mirror. Read from the CDN
       (free egress, edge-cached) but fall back to GCS if a mirror write ever
       failed — same arrangement realtime_experimental.js uses for ghost-rt, so
       a missed mirror degrades to the old egress cost instead of an empty tab. */
    var GCS = 'https://storage.googleapis.com/tc-atlas-ir-cache/ghost-ra/v1';
    var DATA = (qs.get('ghostra') || (LOCALHOST ? 'ghost-ra/v1' : CDN)).replace(/\/$/, '');
    var API = 'https://api.tcatlas.org';

    /* Never hand an error page to JSON.parse. A missing object on the CDN comes
       back as HTML, and the resulting "Unexpected token '<'" tells the reader
       nothing about what actually went wrong. */
    function _fetchJSON(url) {
        return fetch(url, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + url);
            return r.text().then(function (t) {
                try {
                    return JSON.parse(t);
                } catch (e) {
                    throw new Error('not JSON at ' + url +
                        ' (got "' + t.slice(0, 30).replace(/\s+/g, ' ') + '…")');
                }
            });
        });
    }

    /* Try the CDN, fall back to GCS for the same object. Only when reading the
       published tree — a local dev path has nowhere to fall back to. */
    function getJSON(url) {
        return _fetchJSON(url).catch(function (e) {
            if (DATA !== CDN || url.indexOf(CDN) !== 0) throw e;
            return _fetchJSON(GCS + url.slice(CDN.length));
        });
    }

    /* global_archive.js is a single IIFE, so its allTracks / allStorms /
       syncIRToTime / showToast are module-private and unreachable from this
       file. It exposes window.GAArchive as a narrow bridge; everything this
       tab borrows from the archive goes through GA(). */
    function GA() { return window.GAArchive || null; }

    var SRC = 'ghostra-src', LYR = 'ghostra-lyr';
    var MISSING = -9999;          // JSON null → sentinel; interpolate() hates null

    // ── data palettes ────────────────────────────────────────────────
    /* Saffir–Simpson: the shared site values (realtime_ir.js,
       global_archive.js, realtime_experimental.js) so a category reads
       identically everywhere. A domain-standard ordinal scale — deliberately
       not swapped for a single-hue ramp. */
    var SS = ['#60a5fa', '#34d399', '#fbbf24', '#fb923c', '#f87171', '#ef4444', '#dc2626'];
    var SS_BRK = [34, 64, 83, 96, 113, 137];
    var SS_LBL = ['TD', 'TS', 'C1', 'C2', 'C3', 'C4', 'C5'];
    /* Sequential (pressure): ONE hue, light→dark, reversed so deep = dark.
       Floored well above the lightest step — over a basemap the palest blues
       disappear rather than merely receding. */
    var SEQ = [[1015, '#86b6ef'], [1000, '#6da7ec'], [985, '#3987e5'], [968, '#2a78d6'],
    [950, '#256abf'], [930, '#184f95'], [910, '#104281'], [880, '#0d366b']];
    /* Diverging (GHOST − BT): two hues + a NEUTRAL midpoint, equal arms.
       Blue = GHOST deeper, red = GHOST weaker. The gray midpoint is stepped
       to stay visible on the CARTO basemap without reading as a hue. */
    var DIV = [[-40, '#0d366b'], [-25, '#2a78d6'], [-10, '#9ec5f4'], [0, '#b9b7b1'],
    [10, '#f2a9a8'], [25, '#e34948'], [40, '#8f1f1f']];

    /* Basin grouping order + the titles the sidebar heading takes on. The
       heading tracks the sort so it never claims "deepest" while showing a
       season or disagreement ordering. */
    /* The filter currency follows what the product is actually about. The
       headline quantity is Pmin, so hPa is the default — filtering a pressure
       map by knots was asking the reader to convert in their head. Both the
       observed and the GHOST slider always use the SAME unit, so the two-slider
       query stays a like-for-like comparison. */
    var UNITS = {
        hPa: { obs: 'bp', gh: 'gp', min: 880, max: 1020, step: 5,
               label: 'P<sub>min</sub> (hPa)' },
        kt: { obs: 'bv', gh: 'gv', min: 0, max: 185, step: 5,
              label: 'V<sub>max</sub> (kt)' }
    };
    var funit = 'hPa';

    var BASIN_ORDER = ['AL', 'EP', 'CP', 'WP'];
    var BASIN_LABEL = {
        AL: 'Atlantic', EP: 'East Pacific',
        CP: 'Central Pacific', WP: 'West Pacific'
    };
    var SORT_TITLE = {
        ghost: 'Deepest TCs — GHOST', bt: 'Deepest TCs — best track',
        diff: 'Largest disagreements', basin: 'Deepest TCs by basin',
        year: 'By season'
    };

    var MODES = {
        gp: { f: 'gp', kind: 'seq', t: 'GHOST-FPM P<sub>min</sub> (hPa)' },
        bp: { f: 'bp', kind: 'seq', t: 'Best track P<sub>min</sub> (hPa)' },
        gv: { f: 'gv', kind: 'ss', t: 'GHOST-FPM V<sub>max</sub> (kt)' },
        bv: { f: 'bv', kind: 'ss', t: 'Best track V<sub>max</sub> (kt)' },
        diff: { f: 'd', kind: 'div', t: 'GHOST &minus; best track P<sub>min</sub> (hPa)' }
    };

    // ── state ────────────────────────────────────────────────────────
    var booted = false, gmap = null, gl = null;
    var index = null, byId = {};
    var fc = { type: 'FeatureCollection', features: [] };
    var mode = 'gp', sortKey = 'ghost', basinsOn = {}, visSids = null;
    var sel = null, selLine = null, presetOn = false;
    var posMarker = null, selLonMid = null;   // frame position marker + track unwrap ref
    var stormCache = {}, irMeta = {}, irFrames = {}, ir = null, tb = null;

    function $(id) { return document.getElementById(id); }

    // ══════════════════════════════════════════════════════════════
    //  activation
    // ══════════════════════════════════════════════════════════════
    window.activateGhostRAView = function () {
        if (booted) { sizeTab(); setTimeout(function () { if (gmap) gmap.invalidateSize(); }, 100); return; }
        booted = true;
        wire();
        sizeTab();
        watchToolbar();
        initMap();
        getJSON(DATA + '/index.json')
            .then(function (j) {
                index = j;
                j.storms.forEach(function (s) { byId[s.sid] = s; });
                (j.basins || []).forEach(function (b) { basinsOn[b] = true; });
                renderBasins();
                renderFoot();
                sizeTab();          // basin chips just changed the toolbar height
                return Promise.all((j.basins || []).map(loadPoints));
            })
            .then(function () {
                addLayer(); applyFilter(true); fitAll();
                $('gra-loading').style.display = 'none';
            })
            .catch(function (e) {
                var pub = DATA.indexOf('http') === 0;
                $('gra-loading').innerHTML =
                    '<span style="max-width:340px;text-align:center;line-height:1.5;">' +
                    'Could not load the reanalysis from<br><code>' + DATA + '</code>' +
                    '<br><small>' + e.message + '</small>' +
                    (pub ? '<br><small>If the tree has not been published yet, point the ' +
                        'tab at a local build with <code>?ghostra=/ghost-ra/v1</code>.</small>' : '') +
                    '</span>';
            });
    };

    /* Fill exactly from the panel's top to the bottom of the window.
       The chrome above it measures ~138px (page offset + topbar + stats strip
       + tab bar) rather than the 52+42 the older layout classes assume, and the
       toolbar re-wraps at narrow widths, so any hard-coded calc is wrong at
       some viewport. Measuring is the only version that stays right — and it
       matters here because the legend and the IR chip are anchored to the
       BOTTOM of the map, so an over-tall panel silently clips them off-screen
       instead of just leaving dead space. */
    function sizeTab() {
        var el = document.getElementById('tab-reanalysis');
        if (!el || !el.classList.contains('active')) return;
        /* Below 768px the archive stacks the split pane and lets the PAGE
           scroll; pinning a viewport height here would fight that and crush the
           map to nothing. Hand the height back to CSS. */
        if (window.innerWidth <= 768) {
            el.style.height = '';
            if (gmap) gmap.invalidateSize();
            return;
        }
        var top = el.getBoundingClientRect().top;
        el.style.height = Math.max(420, Math.round(window.innerHeight - top)) + 'px';
        if (gmap) gmap.invalidateSize();
    }
    var _sizeT = null;
    function sizeSoon() { clearTimeout(_sizeT); _sizeT = setTimeout(sizeTab, 60); }
    window.addEventListener('resize', sizeSoon);
    /* A one-shot measurement is not enough: sizeTab() first runs while the
       toolbar is still EMPTY, and the basin chips (and any late web-font
       reflow) grow it afterwards — which pushes the panel down without
       changing its fixed height, so the bottom of the map, the colour bar and
       the IR chip all slide under the fold. Watch the toolbar and re-measure
       whenever it reflows. */
    function watchToolbar() {
        if (typeof ResizeObserver === 'undefined') return;
        var tb = document.querySelector('#tab-reanalysis .gra-toolbar');
        if (tb) new ResizeObserver(sizeSoon).observe(tb);
    }

    /* Parallel arrays → GeoJSON, once. Every later interaction is a setFilter
       or setPaintProperty; the source is never rebuilt. */
    function loadPoints(basin) {
        return getJSON(DATA + '/points/' + basin + '.json')
            .then(function (P) {
                for (var i = 0; i < P.n; i++) {
                    var gp = P.gp[i], bp = P.bp[i];
                    var st = byId[P.sids[P.si[i]]];
                    fc.features.push({
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [P.lo[i], P.la[i]] },
                        properties: {
                            s: P.sids[P.si[i]], tm: P.tm[i], b: basin, rc: P.rc[i], gp: gp,
                            gv: P.gv[i] === null ? MISSING : P.gv[i],
                            bp: bp === null ? MISSING : bp,
                            bv: P.bv[i] === null ? MISSING : P.bv[i],
                            // precomputed so the diverging mode is a plain
                            // ['get','d'], not arithmetic re-evaluated per frame
                            d: bp === null ? MISSING : Math.round((gp - bp) * 10) / 10,
                            /* Season and QC are storm-level, but they are
                               copied onto every frame on purpose: it turns the
                               season/QC filter into two numeric comparisons
                               instead of an ['in', ['get','s'], [~650 strings]]
                               literal that MapLibre re-evaluates per feature.
                               That single clause was most of the slider lag. */
                            yr: st ? st.year : 0,
                            sus: (st && st.suspect) ? 1 : 0
                        }
                    });
                }
            });
    }

    // ══════════════════════════════════════════════════════════════
    //  map — same construction as global_archive.js:initBrowserMap()
    // ══════════════════════════════════════════════════════════════
    function initMap() {
        gmap = L.map('gra-map', {
            center: [20, -60], zoom: 2, zoomControl: true,
            worldCopyJump: true, zoomSnap: 0, zoomDelta: 0.5
        });
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
            subdomains: 'abcd', maxZoom: 12
        }).addTo(gmap);
        gl = gmap.getGL();
        gl.on('load', markGLReady);
        // 'load' may already have fired (warm style, cached tiles) — in that
        // case the listener above would never run.
        if (gl.loaded() || (gl.isStyleLoaded && gl.isStyleLoaded())) markGLReady();
    }

    /* Track readiness with an explicit flag and a queue — the same lesson
       lflet_gl.js records in its own constructor. isStyleLoaded()/loaded()
       FLICKER FALSE while tiles stream, and 'load' fires only once per map, so
       the obvious `if (!ready) gl.once('load', fn)` silently drops every call
       made during a flicker: the handler is registered for an event that has
       already fired and will never fire again. That is how a mode switch can
       leave the layer painted with the previous mode's filter. */
    var glReady = false, glQueue = [];
    function markGLReady() {
        if (glReady) return;
        glReady = true;
        var q = glQueue; glQueue = [];
        q.forEach(function (fn) { try { fn(); } catch (e) { console.warn('[ghostra]', e); } });
    }
    function whenGL(fn) {
        if (glReady) { try { fn(); } catch (e) { console.warn('[ghostra]', e); } return; }
        glQueue.push(fn);
    }

    function addLayer() {
        function go() {
            if (gl.getSource(SRC)) { gl.getSource(SRC).setData(fc); return; }
            gl.addSource(SRC, { type: 'geojson', data: fc });
            gl.addLayer({
                id: LYR, type: 'circle', source: SRC,
                paint: {
                    'circle-color': colorExpr(),
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 2.1, 4, 3.2, 6, 5, 9, 8],
                    'circle-opacity': 0.85,
                    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 0, 6, 0.5],
                    'circle-stroke-color': 'rgba(255,255,255,.65)'
                }
            });
            gl.on('click', LYR, function (e) {
                if (e.features && e.features.length) {
                    select(e.features[0].properties.s, e.features[0].properties.tm);
                }
            });
            gl.on('mouseenter', LYR, function () { gl.getCanvas().style.cursor = 'pointer'; });
            gl.on('mouseleave', LYR, function () {
                gl.getCanvas().style.cursor = '';
                tipData = null;
                $('gra-tip').classList.remove('on');
            });
            /* Hover readout. Everything shown is already in the browser, so
               this costs no request — which is also why it is safe to run on
               hover at all, unlike the IR fetch. rAF-throttled because
               mousemove fires far faster than the DOM needs updating. */
            var tipQueued = false, tipData = null;
            gl.on('mousemove', LYR, function (e) {
                if (!e.features || !e.features.length) return;
                /* Capture SYNCHRONOUSLY: MapLibre attaches e.features for the
                   duration of the delegated call and deletes it the moment the
                   listener returns, so anything deferred to a later tick finds
                   it gone. Reading e.features inside the rAF silently produced
                   no tooltip at all. */
                tipData = { p: e.features[0].properties, x: e.point.x, y: e.point.y };
                if (tipQueued) return;
                tipQueued = true;
                requestAnimationFrame(function () {
                    tipQueued = false;
                    if (tipData) showTip(tipData);
                });
            });
            /* Keep the points above the basemap. addLayer() appends to the top
               of the style, but the facade inserts its raster tile layer when
               IT is ready — which can be after us — and that raster then paints
               straight over the cloud: the layer still passes the filter and
               still answers queryRenderedFeatures, it is simply buried, so the
               only symptom is an empty map. Re-assert the position whenever the
               style changes; the last-layer check stops the moveLayer() from
               retriggering styledata forever. */
            gl.on('styledata', function () {
                if (!gl.getLayer(LYR)) return;
                var ls = gl.getStyle().layers;
                if (ls[ls.length - 1].id !== LYR) gl.moveLayer(LYR);
            });
        }
        whenGL(go);
        renderLegend();
    }

    function fmt(v, dp, unit) {
        return (v === undefined || v === null || v === MISSING)
            ? '<span class="gra-tip-na">—</span>'
            : v.toFixed(dp) + (unit || '');
    }

    function showTip(t) {
        var p = t.p, st = byId[p.s] || {};
        var t = new Date(p.tm * 60000).toISOString().replace('T', ' ').slice(0, 16);
        var d = (p.d === MISSING) ? null : p.d;
        var el = $('gra-tip');
        el.innerHTML =
            '<div class="gra-tip-hd">' + (st.name || st.atcf || p.s) +
            '<span class="gra-tip-sub">' + p.b + ' · ' + t + 'Z</span></div>' +
            '<div class="gra-tip-row"><span class="gra-tip-k gra-tip-g">GHOST</span>' +
            '<b>' + fmt(p.gp, 1) + '</b> hPa <b>' + fmt(p.gv, 0) + '</b> kt</div>' +
            '<div class="gra-tip-row"><span class="gra-tip-k">Best track</span>' +
            '<b>' + fmt(p.bp, 0) + '</b> hPa <b>' + fmt(p.bv, 0) + '</b> kt</div>' +
            (d === null ? '' :
                '<div class="gra-tip-row"><span class="gra-tip-k">Δ</span>' +
                '<b style="color:' + (d < 0 ? '#2a78d6' : '#e34948') + '">' +
                (d > 0 ? '+' : '−') + Math.abs(d).toFixed(1) + '</b> hPa ' +
                (d < 0 ? 'deeper' : 'weaker') + ' than best track</div>') +
            (p.rc === 1 ? '<div class="gra-tip-flag">recon-proximate</div>' : '');
        // flip the card away from the pointer near the panel edges
        var w = gl.getCanvas().clientWidth, h = gl.getCanvas().clientHeight;
        var right = t.x > w - 210, below = t.y > h - 130;
        el.style.left = (right ? t.x - 200 : t.x + 14) + 'px';
        el.style.top = (below ? t.y - 118 : t.y + 14) + 'px';
        el.classList.add('on');
    }

    function colorExpr() {
        var m = MODES[mode], e;
        if (m.kind === 'ss') {
            e = ['step', ['get', m.f], SS[0]];
            SS_BRK.forEach(function (b, i) { e.push(b, SS[i + 1]); });
        } else {
            e = ['interpolate', ['linear'], ['get', m.f]];
            (m.kind === 'div' ? DIV : SEQ).slice()
                .sort(function (a, b) { return a[0] - b[0]; })   // interpolate needs ascending
                .forEach(function (s) { e.push(s[0], s[1]); });
        }
        return ['case', ['==', ['get', m.f], MISSING], 'rgba(0,0,0,0)', e];
    }

    /* Open on the published extent — this is a multi-basin product, so a
       hard-coded Atlantic view would start WP/EP off-screen.
       Longitude can't be min/max'd: the basins straddle the antimeridian, so
       the raw extent is -180..180 and a naive fit centres the map on the one
       part of the world with no tropical cyclones in it. Take the complement
       of the LARGEST empty longitude gap instead — for AL+EP+WP+CP that gap is
       Africa→Asia, and the fit lands Pacific-centred with every basin in
       frame. Works unchanged if basins are added later. */
    function fitAll() {
        var s = 90, n = -90, lons = [];
        fc.features.forEach(function (f) {
            var c = f.geometry.coordinates;
            if (c[1] < s) s = c[1];
            if (c[1] > n) n = c[1];
            lons.push(c[0]);
        });
        if (s > n) return;
        lons.sort(function (a, b) { return a - b; });
        var gap = -1, gi = 0;
        for (var i = 0; i < lons.length; i++) {
            var a = lons[i], b = (i === lons.length - 1) ? lons[0] + 360 : lons[i + 1];
            if (b - a > gap) { gap = b - a; gi = i; }
        }
        var w = lons[(gi + 1) % lons.length];              // first lon after the gap
        var e = lons[gi] + (gi === lons.length - 1 ? 0 : 360);  // last one before it
        if (e < w) e += 360;
        gmap.fitBounds([[s - 6, w], [n + 6, e]], { padding: [20, 20] });
    }

    // ══════════════════════════════════════════════════════════════
    //  filters — GPU-side, no rebuild
    // ══════════════════════════════════════════════════════════════
    function ranges() {
        var U = UNITS[funit];
        return {
            U: U,
            olo: +$('gra-obslo').value, ohi: +$('gra-obshi').value,
            glo: +$('gra-ghlo').value, ghi: +$('gra-ghhi').value,
            ylo: +$('gra-yrlo').value, yhi: +$('gra-yrhi').value,
            rec: $('gra-recon').checked, sus: $('gra-hidesus').checked,
            oOn: (+$('gra-obslo').value > U.min || +$('gra-obshi').value < U.max),
            gOn: (+$('gra-ghlo').value > U.min || +$('gra-ghhi').value < U.max)
        };
    }

    /* Split deliberately: setFilter is a GPU operation and runs on EVERY input
       event so the dots track the handle, while the expensive JS — the 42k-frame
       recount and the 400-row list rebuild — is debounced. Running all three per
       event is what made the sliders feel laggy. */
    var _heavyT = null;
    function applyFilter(now) {
        if (!index) return;
        var r = ranges(), U = r.U, f = ['all'];
        f.push(['in', ['get', 'b'], ['literal',
            Object.keys(basinsOn).filter(function (b) { return basinsOn[b]; })]]);

        /* Observed and GHOST intensity, ANDed — the two-slider query. A frame
           with no best-track value drops out once the observed slider leaves its
           full range: silently keeping unknowns would misreport the result. */
        if (r.oOn) {
            f.push(['all', ['!=', ['get', U.obs], MISSING],
                ['>=', ['get', U.obs], r.olo], ['<=', ['get', U.obs], r.ohi]]);
        }
        if (r.gOn) {
            f.push(['all', ['!=', ['get', U.gh], MISSING],
                ['>=', ['get', U.gh], r.glo], ['<=', ['get', U.gh], r.ghi]]);
        }
        if (r.rec) f.push(['==', ['get', 'rc'], 1]);
        if (r.sus) f.push(['==', ['get', 'sus'], 0]);
        f.push(['>=', ['get', 'yr'], r.ylo], ['<=', ['get', 'yr'], r.yhi]);
        f.push(['!=', ['get', MODES[mode].f], MISSING]);
        if (presetOn) f.push(['<=', ['get', 'd'], -15], ['==', ['get', 'rc'], 0]);

        whenGL(function () { if (gl.getLayer(LYR)) gl.setFilter(LYR, f); });

        // cheap enough to keep in lockstep with the handle
        $('gra-obsout').textContent = r.olo + '–' + r.ohi;
        $('gra-ghout').textContent = r.glo + '–' + r.ghi;
        $('gra-yrout').textContent = r.ylo + '–' + r.yhi;

        clearTimeout(_heavyT);
        if (now) { recount(r); renderList(); }
        else _heavyT = setTimeout(function () { recount(r); renderList(); }, 130);
    }

    /* Evaluating the predicates over the source once is cheaper than
       querySourceFeatures on every move — and unlike a rendered count, it is
       viewport-independent, which is what the reader actually wants. */
    function recount(r) {
        var U = r.U, need = MODES[mode].f, n = 0, st = {};
        for (var i = 0; i < fc.features.length; i++) {
            var p = fc.features[i].properties;
            if (!basinsOn[p.b] || p[need] === MISSING) continue;
            if (p.yr < r.ylo || p.yr > r.yhi) continue;
            if (r.sus && p.sus) continue;
            if (r.oOn && (p[U.obs] === MISSING || p[U.obs] < r.olo || p[U.obs] > r.ohi)) continue;
            if (r.gOn && (p[U.gh] === MISSING || p[U.gh] < r.glo || p[U.gh] > r.ghi)) continue;
            if (r.rec && p.rc !== 1) continue;
            if (presetOn && (p.d === MISSING || p.d > -15 || p.rc !== 0)) continue;
            n++; st[p.s] = 1;
        }
        visSids = st;
        var ns = Object.keys(st).length;
        $('gra-count').textContent = n.toLocaleString() + ' of ' +
            fc.features.length.toLocaleString() + ' frames · ' + ns + ' storms' +
            (presetOn ? '  — preset active' : '');
        $('gra-sub').textContent = ns + ' storms in view · ' + index.n_storms + ' published';
    }

    // ══════════════════════════════════════════════════════════════
    //  legend
    // ══════════════════════════════════════════════════════════════
    function renderLegend() {
        var m = MODES[mode], h = '<div class="gra-lt">' + m.t + '</div>';
        if (m.kind === 'ss') {
            h += '<div class="gra-swatches">' + SS.map(function (c, i) {
                return '<span><span class="gra-sw" style="background:' + c + '"></span>' + SS_LBL[i] + '</span>';
            }).join('') + '</div>';
        } else {
            var ord = (m.kind === 'div' ? DIV : SEQ).slice().sort(function (a, b) { return a[0] - b[0]; });
            var lo = ord[0][0], hi = ord[ord.length - 1][0];
            h += '<div class="gra-bar" style="background:linear-gradient(90deg,' +
                ord.map(function (s) {
                    return s[1] + ' ' + ((s[0] - lo) / (hi - lo) * 100).toFixed(1) + '%';
                }).join(',') + ')"></div>' +
                '<div class="gra-ticks"><span>' + lo + '</span>' +
                (m.kind === 'div' ? '<span>0 · agree</span>' : '') + '<span>' + hi + '</span></div>';
            if (m.kind === 'div') {
                h += '<div class="gra-ticks"><span>GHOST deeper</span><span>GHOST weaker</span></div>' +
                    '<div class="gra-note">Outside the recon stratum, best-track pressure is ' +
                    'largely Dvorak-derived — this is model vs model, not verification.</div>';
            }
        }
        $('gra-legend').innerHTML = h;
    }

    function renderFoot() {
        $('gra-foot').innerHTML =
            'GHOST-FPM ' + (index.version || '') + ' · ' + (index.model || '') +
            '<br>Recon-independent research estimates from geostationary IR + ' +
            'reanalysis environment. Not an official analysis. ' +
            '<b>OOB</b> = out-of-basin apply (trained on AL/EP recon labels); ' +
            '<b>QC</b> = flagged by the producer’s trace-vs-best-track test.';
    }

    // ══════════════════════════════════════════════════════════════
    //  leaderboard
    // ══════════════════════════════════════════════════════════════
    function renderList() {
        if (!index) return;
        var r = ranges();
        /* A name match deliberately IGNORES the map filters: someone typing
           "Ioke" wants to be told where Ioke is, not to be shown an empty list
           because the sliders happen to exclude it. Selecting the row still
           flies the map to the storm. */
        var q = ($('gra-search').value || '').trim().toLowerCase();
        var rows = index.storms.filter(function (s) {
            if (q) {
                return (s.name || '').toLowerCase().indexOf(q) >= 0 ||
                    (s.atcf || '').toLowerCase().indexOf(q) >= 0 ||
                    String(s.year).indexOf(q) === 0;
            }
            return basinsOn[s.basin] && s.year >= r.ylo && s.year <= r.yhi &&
                !(r.sus && s.suspect) && (!visSids || visSids[s.sid]);
        });
        var deep = function (s) { return s.ghost_min_hpa === null ? 9e9 : s.ghost_min_hpa; };
        var key = {
            ghost: deep,
            bt: function (s) { return s.bt_min_hpa === null ? 9e9 : s.bt_min_hpa; },
            diff: function (s) {
                return (s.ghost_min_hpa === null || s.bt_min_hpa === null) ? 1
                    : -Math.abs(s.ghost_min_hpa - s.bt_min_hpa);
            },
            // basin is a GROUPING, not a ranking — order the groups, then keep
            // the deepest-first ordering inside each so the list still answers
            // "what were this basin's strongest storms"
            basin: function (s) {
                var i = BASIN_ORDER.indexOf(s.basin);
                return (i < 0 ? BASIN_ORDER.length : i) * 1e6 + deep(s);
            },
            year: function (s) { return -s.year; }
        }[sortKey];
        rows.sort(function (a, b) { return key(a) - key(b); });
        $('gra-title').textContent = q ? 'Search results' : (SORT_TITLE[sortKey] || 'Storms');

        var lastBasin = null;
        $('gra-list').innerHTML = rows.slice(0, 400).map(function (s) {
            var d = (s.ghost_min_hpa !== null && s.bt_min_hpa !== null)
                ? s.ghost_min_hpa - s.bt_min_hpa : null;
            var hdr = '';
            if (sortKey === 'basin' && s.basin !== lastBasin) {
                lastBasin = s.basin;
                hdr = '<div class="gra-group">' + (BASIN_LABEL[s.basin] || s.basin) + '</div>';
            }
            return hdr + '<div class="gra-item' + (sel === s.sid ? ' active' : '') +
                '" data-sid="' + s.sid + '">' +
                '<div class="gra-nm">' + (s.name || s.atcf) +
                (s.suspect ? '<span class="gra-flag" title="QC-suspect (' + (s.qc_src || '') + ')">QC</span>' : '') +
                (s.out_of_basin ? '<span class="gra-flag oob" title="Out-of-basin apply — trained on AL/EP recon labels">OOB</span>' : '') +
                '</div>' +
                '<div class="gra-num gra-g">' + (s.ghost_min_hpa !== null ? s.ghost_min_hpa.toFixed(1) : '—') + '</div>' +
                '<div class="gra-meta">' + s.year + ' · ' + s.basin + ' · ' + s.n + ' fr</div>' +
                '<div class="gra-num">BT ' + (s.bt_min_hpa !== null ? s.bt_min_hpa.toFixed(0) : '—') +
                (d !== null ? ' <span style="color:' + (d < 0 ? '#2a78d6' : '#e34948') + '">' +
                    (d > 0 ? '+' : '−') + Math.abs(d).toFixed(0) + '</span>' : '') +
                '</div></div>';
        }).join('') ||
            '<div style="padding:16px;color:var(--slate);font-size:0.72rem;">' +
            (q ? 'No storm matches &ldquo;' + q + '&rdquo;.' : 'No storms match the filters.') +
            '</div>';

        Array.prototype.forEach.call($('gra-list').querySelectorAll('.gra-item'), function (el) {
            el.onclick = function () { select(el.dataset.sid, null); };
        });
    }

    // ══════════════════════════════════════════════════════════════
    //  selection
    // ══════════════════════════════════════════════════════════════
    function select(sid, tm) {
        if (!byId[sid]) return;
        sel = sid;
        renderList();
        whenGL(function () {
            if (!gl.getLayer(LYR)) return;      // interaction before the layer landed
            gl.setPaintProperty(LYR, 'circle-opacity',
                ['case', ['==', ['get', 's'], sid], 0.95, 0.16]);
            gl.setPaintProperty(LYR, 'circle-stroke-width',
                ['case', ['==', ['get', 's'], sid], 1.1, 0]);
        });
        openIR(sid, tm);                      // chip + sparkline need no track
        withTrack(sid, function (t) {         // track line + IR do
            if (sel !== sid) return;          // user moved on while we waited
            drawTrack(sid, t);
            loadIRMeta(sid, tm, t);
        });
    }

    /* global_archive.js streams ~46 MB of IBTrACS tracks in the background and
       signals completion only with a toast — no flag, no event — and its
       single-file fallback REASSIGNS allTracks wholesale. So: never cache the
       object, read allTracks[sid] fresh, and poll rather than dead-ending when
       a storm is opened before the database has finished loading. */
    function withTrack(sid, cb) {
        var deadline = Date.now() + 45000;
        (function poll() {
            var t = GA() ? GA().getTrack(sid) : null;
            if (t && t.length) return cb(t);
            if (Date.now() > deadline) {
                $('gra-ir-status').textContent =
                    'The archive’s track data has not loaded — the IR scene needs it ' +
                    'to locate frames. Try again in a moment.';
                return;
            }
            if (sel === sid && !$('gra-ir-status').textContent) {
                $('gra-ir-status').textContent = 'Waiting for the archive’s track data…';
            }
            setTimeout(poll, 400);
        })();
    }

    function clearSel() {
        sel = null;
        if (selLine) { gmap.removeLayer(selLine); selLine = null; }
        if (posMarker) { gmap.removeLayer(posMarker); posMarker = null; }
        selLonMid = null;
        whenGL(function () {
            if (!gl.getLayer(LYR)) return;
            gl.setPaintProperty(LYR, 'circle-opacity', 0.85);
            gl.setPaintProperty(LYR, 'circle-stroke-width',
                ['interpolate', ['linear'], ['zoom'], 4, 0, 6, 0.5]);
        });
        $('gra-ir').classList.remove('open');
        renderList();
    }

    function drawTrack(sid, t) {
        if (selLine) { gmap.removeLayer(selLine); selLine = null; }
        if (!t || t.length < 2) return;
        var pts = [], prev = null, s = 90, n = -90, w = 180, e = -180;
        for (var i = 0; i < t.length; i++) {
            if (t[i].la == null || t[i].lo == null) continue;
            var lo = t[i].lo;
            // unwrap: unlike the point cloud, a polyline needs continuity
            // across the antimeridian (lflet_gl carries lng < -180)
            if (prev !== null && Math.abs(lo - prev) > 180) lo += (prev > lo ? 360 : -360);
            prev = lo;
            pts.push([t[i].la, lo]);
            s = Math.min(s, t[i].la); n = Math.max(n, t[i].la);
            w = Math.min(w, lo); e = Math.max(e, lo);
        }
        if (pts.length < 2) return;
        selLine = L.polyline(pts, { color: '#0f172a', weight: 1.6, opacity: 0.75 }).addTo(gmap);
        selLonMid = (w + e) / 2;   // the polyline may be unwrapped past ±180
        // lflet_gl.js's Polyline has no getBounds() — a missing facade method
        // silently no-ops, so bounds are accumulated above instead.
        gmap.fitBounds([[s, w], [n, e]], { padding: [60, 60], maxZoom: 6 });
    }

    // ══════════════════════════════════════════════════════════════
    //  IR chip — the MergIR scene behind the estimate
    // ══════════════════════════════════════════════════════════════
    function openIR(sid, tm) {
        var s = byId[sid];
        $('gra-ir').classList.add('open');
        $('gra-ir-name').textContent = s.name || s.atcf;
        $('gra-ir-basin').textContent = s.basin + ' · ' + s.year;
        $('gra-ir-vals').innerHTML = '';
        $('gra-ir-hover').textContent = '';
        $('gra-ir-status').textContent = '';
        ir = { sid: sid, want: tm, idx: null };
        _off = null; zoom = 1; cx = 0; cy = 0;   // new storm, new view
        fillCmapPicker();
        loadStorm(sid, function () {
            drawSpark(sid);
            // the per-storm JSON can arrive after the frame list, in which case
            // pickFrame had no peak to aim at yet — take the shot now
            if (ir && ir.sid === sid && tm == null && irMeta[sid]) pickFrame(sid, null);
        });
    }

    function loadIRMeta(sid, tm, t) {
        if (irMeta[sid]) return pickFrame(sid, tm);
        $('gra-ir-status').textContent = 'Loading IR frame list…';
        /* Pass the track VERBATIM, exactly as the Storm Detail tab does. The
           frame index space is derived from whatever track /ir/meta is handed,
           so any edit here would fork this tab's R2 frame cache away from
           Storm Detail's and double the stored objects for no benefit. */
        var trk = t.map(function (p) { return { t: p.t, la: p.la, lo: p.lo }; });
        getJSON(API + '/global/ir/meta?sid=' + encodeURIComponent(sid) +
            '&track=' + encodeURIComponent(JSON.stringify(trk)))
            .then(function (j) {
                irMeta[sid] = j;
                if (!j.available) {
                    $('gra-ir-status').textContent = 'No IR available: ' + (j.reason || 'unknown');
                    return;
                }
                pickFrame(sid, tm);
            })
            .catch(function (e) { $('gra-ir-status').textContent = 'IR metadata failed: ' + e; });
    }

    /* Put a marker where the displayed frame actually is. Without it the chip
       tells you the storm and the time but not the place, and on a fitted track
       there is nothing tying the picture to a point on the map.
       The longitude is unwrapped toward the drawn polyline: the track may carry
       lng past ±180 across the dateline, and a marker left in -180..180 would
       land a world away from its own track. */
    function showPos(lat, lon) {
        if (lat == null || lon == null) return;
        if (selLonMid != null) {
            while (lon - selLonMid > 180) lon -= 360;
            while (selLonMid - lon > 180) lon += 360;
        }
        if (posMarker) { gmap.removeLayer(posMarker); posMarker = null; }
        posMarker = L.circleMarker([lat, lon], {
            radius: 7, color: '#ffffff', weight: 2.5,
            fillColor: '#f43f5e', fillOpacity: 0.95
        }).addTo(gmap);
        // nudge into view only if the frame sits off-screen — panning on every
        // arrow-key step would make the map jitter while scrubbing
        try {
            if (!gmap.getBounds().contains([lat, lon])) gmap.panTo([lat, lon]);
        } catch (e) { }
    }

    /* Time of the storm's deepest GHOST estimate — where a reader who just
       searched a storm by name actually wants to land. */
    function peakTime(sid) {
        var st = stormCache[sid];
        if (!st) return null;
        var S = series(st);
        if (!S.t || !S.gp) return null;
        var bi = -1, best = Infinity;
        for (var i = 0; i < S.gp.length && i < S.t.length; i++) {
            if (S.gp[i] == null) continue;
            if (S.gp[i] < best) { best = S.gp[i]; bi = i; }
        }
        return bi < 0 ? null : Date.parse(S.t[bi] + 'Z');
    }

    function pickFrame(sid, tm) {
        var m = irMeta[sid];
        if (!m || !m.available || !m.frames.length) return;
        var want;
        if (tm === null || tm === undefined) {
            /* No frame was clicked (name search or leaderboard row) — open on
               the storm's PEAK rather than the middle of its life, which was
               arbitrary and usually showed the storm still spinning up. */
            var pk = peakTime(sid);
            if (pk === null) return showFrame(sid, Math.floor(m.frames.length / 2));
            want = pk;
            ir.want = Math.round(pk / 60000);   // keep Δt in the same units
        } else {
            want = tm * 60000;
        }
        var best = 0, bd = Infinity;
        for (var j = 0; j < m.frames.length; j++) {
            var d = Math.abs(Date.parse(m.frames[j].datetime + 'Z') - want);
            if (d < bd) { bd = d; best = j; }
        }
        showFrame(sid, best);
    }

    function showFrame(sid, idx) {
        var m = irMeta[sid];
        if (!m || !m.available || idx < 0 || idx >= m.frames.length) return;
        ir.sid = sid; ir.idx = idx;
        var f = m.frames[idx];
        $('gra-ir-stamp').textContent = f.datetime.replace('T', ' ') + 'Z · frame ' +
            (idx + 1) + '/' + m.frames.length;
        $('gra-ir-prev').disabled = idx <= 0;
        $('gra-ir-next').disabled = idx >= m.frames.length - 1;

        /* Δt on the panel face, never in a tooltip: the archive's MergIR frame
           list is 3-hourly while the recon-board channel is hourly, so an
           exact match is the exception, not the rule. */
        var el = $('gra-ir-dt'), dt = null;
        if (ir.want) dt = Math.round((Date.parse(f.datetime + 'Z') - ir.want * 60000) / 60000);
        var pk = peakTime(sid);
        var atPeak = pk !== null &&
            Math.abs(Date.parse(f.datetime + 'Z') - pk) <= 90 * 60000;
        el.textContent = atPeak ? 'GHOST peak'
            : (dt === null ? '' : (dt === 0 ? 'exact match'
                : 'Δ ' + (dt > 0 ? '+' : '−') + Math.abs(dt) + ' min vs GHOST'));
        el.className = 'gra-ir-delta' + (dt !== null && Math.abs(dt) > 45 ? ' far' : '');

        valsAt(sid, Date.parse(f.datetime + 'Z'));
        drawSpark(sid);
        showPos(f.lat, f.lon);

        var key = sid + '/' + idx;
        if (irFrames[key]) return paint(irFrames[key]);
        $('gra-ir-status').textContent = 'Fetching IR frame…';

        /* Direct from the CDN prefix the meta response advertises — no Cloud
           Run hop for an already-rendered frame. The API fallback renders it,
           caches it to GCS and mirrors it to R2 for next time. */
        var direct = m.frame_cdn_base ? m.frame_cdn_base + '/' + sid + '/' + idx + '.json' : null;
        var api = API + '/global/ir/frame?sid=' + encodeURIComponent(sid) +
            '&frame_idx=' + idx + '&lat=' + f.lat + '&lon=' + f.lon +
            '&dt=' + encodeURIComponent(f.datetime);
        (direct
            ? fetch(direct).then(function (r) {
                return r.ok ? r.json() : fetch(api).then(function (x) { return x.json(); });
            })
            : fetch(api).then(function (r) { return r.json(); })
        ).then(function (j) {
            if (!j || !j.tb_data) { $('gra-ir-status').textContent = 'No IR data for this frame.'; return; }
            irFrames[key] = j;
            if (ir.sid === sid && ir.idx === idx) paint(j);
        }).catch(function (e) { $('gra-ir-status').textContent = 'IR frame failed: ' + e; });
    }

    /* The frame payload is base64 uint8 brightness temperature, NOT a PNG:
       0 = invalid, 1..255 linear across [tb_vmin, tb_vmax] — the same encoding
       global_archive.js:decodeTbData reads. */
    function paint(j) {
        $('gra-ir-status').textContent = '';
        var bin = atob(j.tb_data), raw = new Uint8Array(bin.length), i;
        for (i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
        tb = { raw: raw, rows: j.tb_rows, cols: j.tb_cols, vmin: j.tb_vmin,
               scale: 254 / (j.tb_vmax - j.tb_vmin), b: j.bounds };
        repaint();
    }

    /* Colour with the SITE's own LUTs, borrowed through the bridge, so this chip
       is pixel-identical to the Storm Detail viewer for the same scene. They are
       256x4 RGBA arrays indexed directly by the raw uint8 Tb byte — exactly what
       the frame payload carries — so there is no ramp to re-derive here. */
    var CMAP_LABEL = {
        'claude-ir': 'Claude IR', enhanced: 'Enhanced IR', dvorak: 'Dvorak BD',
        grayscale: 'Greyscale', funktop: 'Funktop', avn: 'AVN', nhc: 'NHC',
        rammb: 'RAMMB', irb: 'IR-B'
    };
    var cmap = 'claude-ir';

    /* View state for the chip. The colour pass renders once into an offscreen
       canvas at full source resolution; zoom/pan then only re-blit a sub-rect,
       so panning stays smooth and never re-runs the LUT over ~200k pixels.
       Zoom is preserved across frame steps on purpose — that is how you watch
       an eye evolve — and reset when the storm changes. */
    var _off = null, zoom = 1, cx = 0, cy = 0;

    function repaint() {
        if (!tb) return;
        var maps = (GA() && GA().irColormaps) ? GA().irColormaps() : null;
        var lut = maps ? (maps[cmap] || maps['claude-ir'] || maps['enhanced']) : null;
        if (!_off) _off = document.createElement('canvas');
        _off.width = tb.cols; _off.height = tb.rows;
        var octx = _off.getContext('2d');
        var im = octx.createImageData(tb.cols, tb.rows);
        /* NO-DATA must not look like a temperature. MergIR is a merge of several
           geostationary satellites; when one granule is missing for a half-hour
           its whole longitude sector comes back null — Haiyan 2013 18Z has 150
           contiguous dead columns straight through the eastern eyewall. Painted
           flat black those pixels read as ~273 K, i.e. warm clear air, which is
           the opposite of the truth. A desaturated checker belongs to no
           colormap and cannot be mistaken for a Tb value. */
        var nodata = 0;
        for (var i = 0, n = tb.rows * tb.cols; i < n; i++) {
            var v = tb.raw[i], o = i * 4;
            if (v === 0) {
                nodata++;
                var yy = (i / tb.cols) | 0, xx = i - yy * tb.cols;
                var q = (((xx >> 3) + (yy >> 3)) & 1) ? 122 : 98;
                im.data[o] = im.data[o + 1] = im.data[o + 2] = q; im.data[o + 3] = 255;
            } else if (lut) {
                var k = v * 4;
                im.data[o] = lut[k]; im.data[o + 1] = lut[k + 1];
                im.data[o + 2] = lut[k + 2]; im.data[o + 3] = 255;
            } else {                             // bridge missing — stay readable
                var g = 255 - v;
                im.data[o] = im.data[o + 1] = im.data[o + 2] = g; im.data[o + 3] = 255;
            }
        }
        octx.putImageData(im, 0, 0);
        tb.nodata = nodata / (tb.rows * tb.cols);
        var cov = $('gra-ir-cover');
        if (cov) {
            cov.textContent = tb.nodata > 0.02
                ? Math.round(tb.nodata * 100) + '% no data' : '';
            cov.title = 'Missing satellite coverage in the MergIR merge at this '
                + 'time — not cloud-free sky. Step a frame for fuller coverage.';
        }
        if (cx === 0 && cy === 0) { cx = tb.cols / 2; cy = tb.rows / 2; }
        blit();
    }

    /* Source rect currently in view, clamped so panning can't leave the frame. */
    function srcRect() {
        var sw = tb.cols / zoom, sh = tb.rows / zoom;
        var sx = Math.max(0, Math.min(tb.cols - sw, cx - sw / 2));
        var sy = Math.max(0, Math.min(tb.rows - sh, cy - sh / 2));
        return { sx: sx, sy: sy, sw: sw, sh: sh };
    }

    function blit() {
        if (!tb || !_off) return;
        var c = $('gra-ir-canvas');
        c.width = tb.cols; c.height = tb.rows;
        var ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;       // keep pixels honest when zoomed
        var r = srcRect();
        ctx.drawImage(_off, r.sx, r.sy, r.sw, r.sh, 0, 0, c.width, c.height);
        var z = $('gra-ir-zoom');
        if (z) z.textContent = zoom > 1.01 ? zoom.toFixed(1) + '× — double-click to reset' : '';
    }

    function resetZoom() {
        zoom = 1;
        cx = tb ? tb.cols / 2 : 0;
        cy = tb ? tb.rows / 2 : 0;
        blit();
    }

    /* Screen point -> source pixel, through the current zoom/pan. */
    function toSrc(e, el) {
        var b = el.getBoundingClientRect(), r = srcRect();
        return {
            x: r.sx + (e.clientX - b.left) / b.width * r.sw,
            y: r.sy + (e.clientY - b.top) / b.height * r.sh
        };
    }

    function fillCmapPicker() {
        var sel = $('gra-ir-cmap');
        if (!sel || sel.options.length) return;
        var maps = (GA() && GA().irColormaps) ? GA().irColormaps() : {};
        // open on whatever the rest of the page is currently showing
        if (GA() && GA().irColormapName && maps[GA().irColormapName()]) {
            cmap = GA().irColormapName();
        }
        Object.keys(maps).forEach(function (k) {
            var o = document.createElement('option');
            o.value = k; o.textContent = CMAP_LABEL[k] || k;
            if (k === cmap) o.selected = true;
            sel.appendChild(o);
        });
        sel.onchange = function () { cmap = sel.value; repaint(); };
    }

    function loadStorm(sid, cb) {
        if (stormCache[sid]) return cb();
        getJSON(DATA + '/storm/' + sid + '.json')
            .catch(function () { return null; })
            .then(function (j) { if (j) { stormCache[sid] = j; cb(); } });
    }

    /* Which series a storm carries depends on its channel: the lifecycle trace
       (genesis→decay, 3-hourly) where it exists, the recon board otherwise. */
    function series(st) {
        return st.lt
            ? { t: st.lt, gp: st.lp, bp: st.lbp, gv: st.lv || st.wv, bv: st.lbv || st.vw }
            : { t: st.t, gp: st.duo || st.g2, bp: st.p, gv: st.wv, bv: st.vw };
    }

    function valsAt(sid, ms) {
        var st = stormCache[sid];
        if (!st) return;
        var S = series(st);
        if (!S.t || !S.t.length) return;
        var bi = 0, bd = Infinity;
        for (var i = 0; i < S.t.length; i++) {
            var d = Math.abs(Date.parse(S.t[i] + 'Z') - ms);
            if (d < bd) { bd = d; bi = i; }
        }
        var f = function (a, dp) {
            return (a && a[bi] !== null && a[bi] !== undefined) ? a[bi].toFixed(dp) : '—';
        };
        $('gra-ir-vals').innerHTML =
            '<span class="gra-g">GHOST</span> <b>' + f(S.gp, 1) + '</b> hPa / <b>' +
            f(S.gv, 0) + '</b> kt &nbsp;·&nbsp; BT <b>' + f(S.bp, 0) + '</b> hPa / <b>' +
            f(S.bv, 0) + '</b> kt';
    }

    /* Sparkline: GHOST vs best track over the lifetime, with the IR cursor.
       The full multi-product chart (SATCON / D-PRINT / DMINT / AiDT, which the
       per-storm JSON already carries) is the next phase — this is only enough
       to make a selection mean something. */
    function drawSpark(sid) {
        var st = stormCache[sid];
        if (!st) { $('gra-ir-spark').innerHTML = ''; return; }
        var S = series(st);
        if (!S.t || S.t.length < 2) { $('gra-ir-spark').innerHTML = ''; return; }
        var W = 302, H = 52, P = 2;
        var vals = [].concat(S.gp || [], S.bp || []).filter(function (v) { return v != null; });
        if (!vals.length) { $('gra-ir-spark').innerHTML = ''; return; }
        var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
        if (hi - lo < 5) { hi += 3; lo -= 3; }
        var t0 = Date.parse(S.t[0] + 'Z'), t1 = Date.parse(S.t[S.t.length - 1] + 'Z');
        var X = function (i) { return P + (Date.parse(S.t[i] + 'Z') - t0) / (t1 - t0 || 1) * (W - 2 * P); };
        var Y = function (v) { return P + (v - lo) / (hi - lo) * (H - 2 * P); };  // low pressure at top
        var path = function (a) {
            var d = '', pen = false;
            for (var i = 0; a && i < a.length; i++) {
                if (a[i] == null) { pen = false; continue; }
                d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(a[i]).toFixed(1) + ' ';
                pen = true;
            }
            return d;
        };
        var cur = '';
        if (ir && ir.idx !== null && irMeta[sid] && irMeta[sid].frames) {
            var x = P + (Date.parse(irMeta[sid].frames[ir.idx].datetime + 'Z') - t0) /
                (t1 - t0 || 1) * (W - 2 * P);
            if (x >= 0 && x <= W) {
                cur = '<line x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="0" y2="' + H +
                    '" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2" opacity=".7"/>';
            }
        }
        $('gra-ir-spark').innerHTML =
            '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="color:var(--text)">' +
            '<path d="' + path(S.bp) + '" fill="none" stroke="var(--slate)" stroke-width="1.4"/>' +
            '<path d="' + path(S.gp) + '" fill="none" stroke="#f43f5e" stroke-width="1.7"/>' + cur + '</svg>' +
            '<div style="display:flex;justify-content:space-between;font-size:0.58rem;color:var(--slate);margin-top:1px;">' +
            '<span><b style="color:#f43f5e;">—</b> GHOST &nbsp; <b>—</b> best track</span>' +
            '<span>' + Math.round(hi) + '–' + Math.round(lo) + ' hPa</span></div>';
    }

    // ══════════════════════════════════════════════════════════════
    //  wiring
    // ══════════════════════════════════════════════════════════════
    function renderBasins() {
        $('gra-basins').innerHTML = Object.keys(basinsOn).map(function (b) {
            return '<button class="basin-chip active" data-basin="' + b + '">' + b + '</button>';
        }).join('');
        Array.prototype.forEach.call($('gra-basins').children, function (el) {
            el.onclick = function () {
                basinsOn[el.dataset.basin] = !basinsOn[el.dataset.basin];
                el.classList.toggle('active');
                applyFilter(true);
            };
        });
    }

    function setMode(m) {
        mode = m;
        Array.prototype.forEach.call($('gra-modes').children, function (x) {
            x.classList.toggle('active', x.dataset.mode === m);
        });
        whenGL(function () { if (gl.getLayer(LYR)) gl.setPaintProperty(LYR, 'circle-color', colorExpr()); });
        renderLegend();
        applyFilter(true);
    }

    /* Switching currency resets both ranges to full: a 0-185 kt window has no
       meaning once the axis is hPa, and silently reinterpreting the numbers
       would hand back a filter the reader never asked for. */
    function setUnit(u) {
        if (!UNITS[u]) return;
        funit = u;
        var U = UNITS[u];
        Array.prototype.forEach.call($('gra-unit').children, function (x) {
            x.classList.toggle('active', x.dataset.unit === u);
        });
        [['obs', 'Observed'], ['gh', 'GHOST']].forEach(function (pair) {
            var lo = $('gra-' + pair[0] + 'lo'), hi = $('gra-' + pair[0] + 'hi');
            lo.min = hi.min = U.min; lo.max = hi.max = U.max;
            lo.step = hi.step = U.step;
            lo.value = U.min; hi.value = U.max;
            $('gra-' + pair[0] + 'label').innerHTML = pair[1] + ' ' + U.label;
        });
        applyFilter(true);
    }

    function wire() {
        Array.prototype.forEach.call($('gra-modes').children, function (el) {
            el.onclick = function () { setMode(el.dataset.mode); };
        });
        ['obs', 'gh', 'yr'].forEach(function (p) {
            ['lo', 'hi'].forEach(function (h) {
                $('gra-' + p + h).oninput = function () {
                    // keep the pair ordered without fighting the handle in hand
                    var lo = $('gra-' + p + 'lo'), hi = $('gra-' + p + 'hi');
                    if (+lo.value > +hi.value) {
                        if (h === 'lo') hi.value = lo.value; else lo.value = hi.value;
                    }
                    applyFilter();          // debounced heavy work — see applyFilter
                };
            });
        });
        Array.prototype.forEach.call($('gra-unit').children, function (el) {
            el.onclick = function () { setUnit(el.dataset.unit); };
        });
        // one delegated listener instead of rebinding ~400 rows per render
        $('gra-list').onclick = function (e) {
            var row = e.target.closest ? e.target.closest('.gra-item') : null;
            if (row && row.dataset.sid) select(row.dataset.sid, null);
        };
        var _searchT = null;
        $('gra-search').oninput = function () {
            clearTimeout(_searchT);
            _searchT = setTimeout(renderList, 120);
        };
        $('gra-recon').onchange = function () { applyFilter(true); };
        $('gra-hidesus').onchange = function () { applyFilter(true); };
        $('gra-preset').onclick = function () {
            presetOn = !presetOn;
            this.classList.toggle('ga-btn-accent', presetOn);
            if (presetOn) { $('gra-recon').checked = false; setMode('diff'); }
            else applyFilter(true);
        };
        $('gra-reset').onclick = function () {
            $('gra-yrlo').value = 1998; $('gra-yrhi').value = 2025;
            $('gra-search').value = '';
            $('gra-recon').checked = false; $('gra-hidesus').checked = true;
            presetOn = false; $('gra-preset').classList.remove('ga-btn-accent');
            Object.keys(basinsOn).forEach(function (b) { basinsOn[b] = true; });
            renderBasins(); clearSel(); setUnit('hPa'); setMode('gp'); fitAll();
        };
        Array.prototype.forEach.call($('gra-sorts').children, function (el) {
            el.onclick = function () {
                Array.prototype.forEach.call($('gra-sorts').children, function (x) {
                    x.classList.remove('active');
                });
                el.classList.add('active');
                sortKey = el.dataset.sort;
                renderList();
            };
        });
        /* Open the explainer once per browser, then remember. A colleague
           following a shared link lands on a map of 45k dots with no idea what
           they are looking at; a returning user does not need telling twice. */
        function showAbout(on) { $('gra-about').classList.toggle('open', on); }
        $('gra-more').onclick = function () {
            var tb = document.querySelector('#tab-reanalysis .gra-toolbar');
            var open = tb.classList.toggle('open');
            this.innerHTML = 'Filters &amp; options ' + (open ? '\u25B4' : '\u25BE');
            sizeTab();
        };
        $('gra-about-btn').onclick = function () {
            showAbout(!$('gra-about').classList.contains('open'));
        };
        $('gra-about-x').onclick = function () {
            showAbout(false);
            try { localStorage.setItem('gra-about-seen', '1'); } catch (e) { }
        };
        try {
            if (!localStorage.getItem('gra-about-seen')) showAbout(true);
        } catch (e) { /* private mode — just don't auto-open */ }

        $('gra-ir-close').onclick = clearSel;
        $('gra-ir-prev').onclick = function () { if (ir) showFrame(ir.sid, ir.idx - 1); };
        $('gra-ir-next').onclick = function () { if (ir) showFrame(ir.sid, ir.idx + 1); };

        /* Handoff to Storm Detail: the same SID the archive is keyed on, so
           selectStorm() finds it and the full environment (IR animation, MW,
           recon, wind radii) opens at the frame the reader was looking at. */
        $('gra-ir-detail').onclick = function () {
            if (!ir || !ir.sid) return;
            var s = GA() ? GA().getStorm(ir.sid) : null;
            if (!s) { if (GA()) GA().toast('Storm not in the archive index'); return; }
            var dt = (irMeta[ir.sid] && ir.idx !== null)
                ? irMeta[ir.sid].frames[ir.idx].datetime : null;
            GA().selectStorm(s);
            switchTab('detail');
            if (dt && GA()) setTimeout(function () { GA().syncIRToTime(dt); }, 600);
        };

        var cv = $('gra-ir-canvas'), drag = null;
        cv.addEventListener('wheel', function (e) {
            if (!tb) return;
            e.preventDefault();
            var before = toSrc(e, cv);
            var next = Math.max(1, Math.min(8, zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
            if (next === zoom) return;
            zoom = next;
            // keep the pixel under the cursor put, so zoom feels anchored
            var after = toSrc(e, cv);
            cx += before.x - after.x;
            cy += before.y - after.y;
            blit();
        }, { passive: false });
        cv.addEventListener('mousedown', function (e) {
            if (!tb || zoom <= 1.01) return;
            drag = { x: e.clientX, y: e.clientY, cx: cx, cy: cy };
            cv.style.cursor = 'grabbing';
            e.preventDefault();
        });
        window.addEventListener('mouseup', function () {
            if (drag) { drag = null; cv.style.cursor = ''; }
        });
        cv.addEventListener('dblclick', function () { if (tb) resetZoom(); });

        cv.onmousemove = function (e) {
            if (!tb) return;
            if (drag) {
                var b = cv.getBoundingClientRect(), r = srcRect();
                cx = drag.cx - (e.clientX - drag.x) / b.width * r.sw;
                cy = drag.cy - (e.clientY - drag.y) / b.height * r.sh;
                blit();
                return;
            }
            var pt = toSrc(e, cv);
            var px = Math.floor(pt.x), py = Math.floor(pt.y);
            if (px < 0 || py < 0 || px >= tb.cols || py >= tb.rows) return;
            var v = tb.raw[py * tb.cols + px];
            if (v === 0) { $('gra-ir-hover').textContent = 'no data'; return; }
            var txt = 'Tb ' + (tb.vmin + (v - 1) / tb.scale).toFixed(1) + ' K';
            if (tb.b) {
                txt += '   ' + (tb.b.north - (py + 0.5) / tb.rows * (tb.b.north - tb.b.south)).toFixed(2) +
                    '°, ' + (tb.b.west + (px + 0.5) / tb.cols * (tb.b.east - tb.b.west)).toFixed(2) + '°';
            }
            $('gra-ir-hover').textContent = txt;
        };
        $('gra-ir-canvas').onmouseleave = function () { $('gra-ir-hover').textContent = ''; };
    }
})();
