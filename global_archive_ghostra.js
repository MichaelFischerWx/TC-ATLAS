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
       without remembering a query string. ?ghostra=<base> overrides either.

       The ROOT is the tree ABOVE the version directory. The version itself is
       resolved at boot from <root>/versions.json, never hard-coded here: it
       used to be spelled out in three constants that had to move in lockstep
       with four cache tokens, which meant a rollback was a coordinated edit
       across several files instead of a choice a reader can make. */
    var LOCALHOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    var CDN_ROOT = 'https://cdn.tcatlas.org/ghost-ra';
    /* GCS is the primary WRITE; R2 is a best-effort mirror. Read from the CDN
       (free egress, edge-cached) but fall back to GCS if a mirror write ever
       failed — same arrangement realtime_experimental.js uses for ghost-rt, so
       a missed mirror degrades to the old egress cost instead of an empty tab. */
    var GCS_ROOT = 'https://storage.googleapis.com/tc-atlas-ir-cache/ghost-ra';
    /* Used ONLY when versions.json cannot be read — a tree published before
       the manifest existed, or a dev directory holding a single version. It is
       a last resort, not the default: the default comes from the data. */
    var FALLBACK_VERSION = 'v1';

    /* ?ghostra= has meant "the version directory" since this tab shipped
       (?ghostra=/ghost-ra/v1 is in the error message below and in people's
       bookmarks), and it now also accepts a bare root. Split on whether the
       last segment looks like a version so both keep working: a pinned
       directory disables the picker, a root drives it. */
    var _ov = (qs.get('ghostra') || '').replace(/\/+$/, '');
    var pinned = null, ROOT;
    if (_ov) {
        var m = _ov.match(/^(.*)\/(v[0-9][0-9A-Za-z._-]*)$/);
        if (m) { ROOT = m[1]; pinned = m[2]; } else { ROOT = _ov; }
    } else {
        ROOT = LOCALHOST ? 'ghost-ra' : CDN_ROOT;
    }
    var version = pinned || qs.get('ghostra_v') || null;   // resolved in boot()
    var versionList = null;      // from versions.json, or synthesised
    function DATA() { return ROOT + '/' + version; }
    var API = 'https://api.tcatlas.org';

    /* Never hand an error page to JSON.parse. A missing object on the CDN comes
       back as HTML, and the resulting "Unexpected token '<'" tells the reader
       nothing about what actually went wrong. */
    /* Default to the browser's normal HTTP cache. Everything under the versioned
       tree, the eye sidecars, the frame list and the f-deck all carry an origin
       max-age (300 s .. 86400 s) — re-pulling them with `no-store` on every tab
       open threw that away and made each open a fresh CDN / Cloud Run round
       trip. Only versions.json — the one object whose CHANGE is the point — is
       fetched no-store, so a republish or rollback is seen immediately. */
    function _fetchJSON(url, noStore) {
        return fetch(url, noStore ? { cache: 'no-store' } : {}).then(function (r) {
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
    function getJSON(url, noStore) {
        return _fetchJSON(url, noStore).catch(function (e) {
            if (ROOT !== CDN_ROOT || url.indexOf(CDN_ROOT) !== 0) throw e;
            return _fetchJSON(GCS_ROOT + url.slice(CDN_ROOT.length), noStore);
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
    /* The leaderboard speaks the filter's currency: in hPa it ranks the
       deepest storms; in kt it ranks the most intense. One switch (funit)
       drives the sliders, the sort, the row values, and these headings, so
       the panel never shows a pressure ranking under a wind title. */
    var SORT_TITLE = {
        hPa: {
            ghost: 'Deepest TCs — GHOST', bt: 'Deepest TCs — best track',
            diff: 'Largest disagreements', basin: 'Deepest TCs by basin',
            year: 'By season'
        },
        kt: {
            ghost: 'Most intense TCs — GHOST', bt: 'Most intense TCs — best track',
            diff: 'Largest disagreements', basin: 'Most intense TCs by basin',
            year: 'By season'
        }
    };

    var MODES = {
        gp: { f: 'gp', kind: 'seq', t: 'GHOST P<sub>min</sub> (hPa)' },
        bp: { f: 'bp', kind: 'seq', t: 'Best track P<sub>min</sub> (hPa)' },
        gv: { f: 'gv', kind: 'ss', t: 'GHOST V<sub>max</sub> (kt)' },
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
    /* Per-storm sidecars the chart / chip fetch lazily:
         fdeckCache[sid]  aircraft fix times from the archive's /global/fdeck
                          (SFMR + flight-level + dropsonde + other AIRC), or
                          null when the endpoint has nothing (WP/CP/IO have no
                          f-deck aircraft feed) — a MISS is cached too, so a
                          storm without recon is asked once, not per frame.
         eyeCache[sid]    the pipeline's IR-recentred centre per lifecycle
                          frame (<root>/eye/<sid>.json, ghostra_eye_sidecar.py). */
    var fdeckCache = {}, eyeCache = {};
    /* basin -> the producer's held-out declaration, or null where the manifest
       says none exists. Kept separate from the data so "no held-out channel
       was published" and "this frame happens to have no held-out value" stay
       distinguishable — the page has to render those two differently. */
    var heldout = {};

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
        resolveVersion().then(loadVersion);
    };

    /* Which published versions exist, and which one to open on.
       <root>/versions.json is written by the producer's release manifest
       (ghostra_release_manifest.write_versions_index). A rollback is a change
       to its `default` — one object — instead of a coordinated revert across
       three JS constants and four cache tokens.

       It is allowed to be missing: a tree published before the manifest
       existed, or a pinned dev directory, has none. In that case synthesise a
       single-entry list so the picker still describes what is loaded rather
       than disappearing. */
    function resolveVersion() {
        if (pinned) {                      // ?ghostra=…/v1 — an explicit tree
            versionList = [{ version: pinned, title: pinned + ' (pinned by URL)' }];
            version = pinned;
            return Promise.resolve();
        }
        return getJSON(ROOT + '/versions.json', true).then(function (j) {
            versionList = (j.versions || []).slice();
            var have = {};
            versionList.forEach(function (v) { have[v.version] = 1; });
            var stored = null;
            try { stored = localStorage.getItem('gra-version'); } catch (e) { }
            version = (qs.get('ghostra_v') && have[qs.get('ghostra_v')] && qs.get('ghostra_v'))
                || (stored && have[stored] && stored)
                || (have[j.default] && j.default)
                || (versionList.length ? versionList[versionList.length - 1].version : FALLBACK_VERSION);
        }).catch(function () {
            version = qs.get('ghostra_v') || FALLBACK_VERSION;
            versionList = [{ version: version, title: version, synthetic: true }];
        });
    }

    /* Load (or reload) one version's tree. Everything version-scoped is reset
       here — the feature collection, the storm and IR caches, the selection —
       because a version is a different dataset, not a filter over the same
       one, and a stale storm record surviving the switch would silently mix
       two model vintages in the storm view. */
    function loadVersion() {
        index = null; byId = {}; visSids = null;
        fc = { type: 'FeatureCollection', features: [] };
        stormCache = {}; irMeta = {}; irFrames = {}; ir = null; tb = null;
        sel = null; basinsOn = {};
        $('gra-loading').style.display = '';
        $('gra-loading').innerHTML =
            '<div class="ga-spinner"></div><span>Loading reanalysis&hellip;</span>';
        renderVersions();
        return getJSON(DATA() + '/index.json')
            .then(function (j) {
                index = j;
                j.storms.forEach(function (s) { byId[s.sid] = s; });
                (j.basins || []).forEach(function (b) { basinsOn[b] = true; });
                renderBasins();
                renderFoot();
                renderProtocols();
                renderVersions();   // index.json can caption the picker better
                sizeTab();          // basin chips just changed the toolbar height
                return Promise.all((j.basins || []).map(loadPoints));
            })
            .then(function () {
                clearSel();
                addLayer(); applyFilter(true); fitAll();
                $('gra-loading').style.display = 'none';
            })
            .catch(function (e) {
                var pub = DATA().indexOf('http') === 0;
                $('gra-loading').style.display = '';
                $('gra-loading').innerHTML =
                    '<span style="max-width:340px;text-align:center;line-height:1.5;">' +
                    'Could not load the reanalysis from<br><code>' + DATA() + '</code>' +
                    '<br><small>' + e.message + '</small>' +
                    (pub ? '<br><small>If the tree has not been published yet, point the ' +
                        'tab at a local build with <code>?ghostra=/ghost-ra/v1</code>.</small>' : '') +
                    '</span>';
            });
    }

    /* Switching version rewrites the URL so the view stays shareable — someone
       citing a number can hand over a link that still resolves to the tree the
       number came from after the next release ships. */
    function setVersion(v) {
        if (!v || v === version) return;
        version = v;
        try { localStorage.setItem('gra-version', v); } catch (e) { }
        try {
            var u = new URL(location.href);
            u.searchParams.set('ghostra_v', v);
            history.replaceState(null, '', u.toString());
        } catch (e) { }
        whenGL(function () {
            if (gl.getSource(SRC)) gl.getSource(SRC).setData(
                { type: 'FeatureCollection', features: [] });
        });
        loadVersion();
    }

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
        return getJSON(DATA() + '/points/' + basin + '.json')
            .then(function (P) {
                /* P.heldout is the producer's statement about this basin: an
                   object when a held-out channel was published, null when the
                   manifest declares there is none to publish. `ho` is absent
                   entirely in the second case — deliberately, so absence is a
                   missing key rather than an array of nulls that a careless
                   reader would treat as data. */
                heldout[basin] = P.heldout || null;
                for (var i = 0; i < P.n; i++) {
                    var gp = P.gp[i], bp = P.bp[i];
                    var ho = (P.ho && P.ho[i] !== undefined) ? P.ho[i] : null;
                    var st = byId[P.sids[P.si[i]]];
                    fc.features.push({
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [P.lo[i], P.la[i]] },
                        properties: {
                            s: P.sids[P.si[i]], tm: P.tm[i], b: basin, rc: P.rc[i], gp: gp,
                            ho: ho === null ? MISSING : ho,
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
        /* NOT `var t` — the timestamp used to be declared over the parameter,
           which left the edge-flip below reading `.x` off a string. It read
           undefined, every comparison was false, and the card never flipped:
           near the right or bottom of the map it simply ran off. */
        var ts = new Date(p.tm * 60000).toISOString().replace('T', ' ').slice(0, 16);
        var d = (p.d === MISSING) ? null : p.d;
        var el = $('gra-tip');
        el.innerHTML =
            '<div class="gra-tip-hd">' + (st.name || st.atcf || p.s) +
            '<span class="gra-tip-sub">' + p.b + ' · ' + ts + 'Z</span></div>' +
            '<div class="gra-tip-row"><span class="gra-tip-k gra-tip-g">GHOST</span>' +
            '<b>' + fmt(p.gp, 1) + '</b> hPa <b>' + fmt(p.gv, 0) + '</b> kt</div>' +
            /* Held out beside the product, never instead of it. Where the
               basin has no held-out channel the row says so in words — an
               em-dash here would read as "we looked and found nothing",
               which is a different claim from "there is nothing to look
               for". */
            (heldout[p.b]
                ? '<div class="gra-tip-row"><span class="gra-tip-k gra-tip-h">' +
                  (PROTO_SHORT[heldout[p.b].protocol] || 'held out') + '</span>' +
                  '<b>' + fmt(p.ho, 1) + '</b> hPa' +
                  (p.ho !== MISSING && p.gp !== undefined
                      ? ' <span class="gra-tip-na">(' +
                        (p.ho - p.gp > 0 ? '+' : '−') +
                        Math.abs(p.ho - p.gp).toFixed(1) + ')</span>' : '') +
                  '</div>'
                : '<div class="gra-tip-row"><span class="gra-tip-k gra-tip-h">' +
                  'held out</span><span class="gra-tip-none">' +
                  heldoutAbsence(p.b) + '</span></div>') +
            '<div class="gra-tip-row"><span class="gra-tip-k">Best track</span>' +
            '<b>' + fmt(p.bp, 0) + '</b> hPa <b>' + fmt(p.bv, 0) + '</b> kt</div>' +
            (d === null ? '' :
                '<div class="gra-tip-row"><span class="gra-tip-k">Δ</span>' +
                '<b style="color:' + (d < 0 ? '#2a78d6' : '#e34948') + '">' +
                (d > 0 ? '+' : '−') + Math.abs(d).toFixed(1) + '</b> hPa ' +
                (d < 0 ? 'deeper' : 'weaker') + ' than best track</div>') +
            (p.rc === 1 ? '<div class="gra-tip-flag">recon-proximate</div>' : '') +
            (protoLine(p.b) ? '<div class="gra-tip-proto">' + protoLine(p.b) +
                '</div>' : '');
        /* Flip the card away from the pointer near the panel edges. The height
           is MEASURED, not assumed: the card grew a held-out row and a
           protocol line, and the old constant flipped it too late — the extra
           rows simply fell off the bottom of the map. */
        el.classList.add('on');
        var w = gl.getCanvas().clientWidth, h = gl.getCanvas().clientHeight;
        var cw = el.offsetWidth || 200, chh = el.offsetHeight || 130;
        var right = t.x > w - (cw + 20), below = t.y > h - (chh + 20);
        el.style.left = (right ? t.x - cw : t.x + 14) + 'px';
        el.style.top = (below ? Math.max(2, t.y - chh - 4) : t.y + 14) + 'px';
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

    /* ── what the number IS, per basin ───────────────────────────────────
       index.models is written by the gated publisher from the release
       manifest: one entry per basin naming the column, the protocol and the
       held-out companion. Everything below reads it and degrades to "not
       stated in this version" when it is absent, which is exactly what a tree
       published before the manifest existed deserves — it did not say, so the
       page must not pretend it did. */
    var PROTO_SHORT = {
        frozen: 'frozen in-sample',
        loyo: 'leave-one-year-out',
        loso: 'leave-one-storm-out',
        transfer: 'out-of-basin transfer'
    };

    function basinModel(b) {
        return (index && index.models && index.models[b]) || null;
    }

    /* v4 and later publish the paper model (a two-member blend). Detected
       from the index's own model declaration, not from the version string. */
    function isBlendVersion() {
        var ms = (index && index.models) || {};
        return Object.keys(ms).some(function (b) {
            return ms[b] && ms[b].column === 'reco'; });
    }

    /* Why there is no held-out value here. The two reasons are not the same
       claim and must not share a phrasing: an out-of-basin transfer has
       nothing to hold out, whereas an older published version simply did not
       ship the channel it had. */
    function heldoutAbsence(b) {
        var m = basinModel(b);
        if (m && m.protocol === 'transfer') {
            return 'no held-out channel — every frame here is already out of sample';
        }
        /* v4+: the published estimate IS the held-out one (leave-one-year-out
           members), so there is no second, frozen channel to hold out from. */
        if (m && (m.protocol === 'loyo' || m.protocol === 'loso')) {
            return 'the published estimate is itself held out (' +
                (PROTO_SHORT[m.protocol] || m.protocol) +
                ') — there is no separate frozen channel';
        }
        return 'no held-out channel in this data version';
    }

    /* The one sentence a reader needs before believing a basin's number. */
    function protoLine(b) {
        var m = basinModel(b);
        if (!m) return null;
        var s = PROTO_SHORT[m.protocol] || m.protocol || '—';
        if (m.protocol === 'transfer') {
            s += ' — zero ' + b + ' frames in training';
        } else if (m.heldout_protocol) {
            s += ', ' + (PROTO_SHORT[m.heldout_protocol] || m.heldout_protocol) +
                ' shown alongside';
        } else if (m.protocol === 'loyo' || m.protocol === 'loso') {
            s += ' — the published value is the held-out one';
        } else {
            s += ', no held-out channel published';
        }
        return s;
    }

    function renderFoot() {
        var basins = (index.basins || []);
        var per = basins.map(function (b) {
            var m = basinModel(b);
            if (!m) return null;
            return '<span class="gra-proto-b">' + b + '</span> ' +
                '<span class="gra-proto-p ' + (m.protocol || '') + '">' +
                (PROTO_SHORT[m.protocol] || m.protocol || '—') + '</span>';
        }).filter(Boolean).join(' · ');
        /* A tree that self-identifies as a different version than the path it
           was served from is a mis-copy — the exact shape of a rollback done
           with `cp -R` — and the reader is the one who would cite the wrong
           number. Say so rather than concatenating the two labels into one
           plausible-looking string. */
        var mism = (index.version && version && index.version !== version)
            ? '<br><b class="gra-mismatch">served as ' + version +
              ' but the tree identifies itself as ' + index.version +
              '</b>' : '';
        /* The identity line (version, per-basin protocol, any version
           mismatch) stays ALWAYS VISIBLE — it is what tells a reader which
           model produced the numbers beside it. Everything below it is
           reference prose, and it used to starve the leaderboard down to ~2
           visible storms, so it collapses. */
        $('gra-foot').innerHTML =
            'GHOST ' + (version || index.version || '') +
            (index.title ? ' — ' + index.title : '') + mism +
            (per ? '<br>' + per : '<br>' + (index.model || '')) +
            '<details class="gra-foot-more"><summary>What these numbers are</summary>' +
            '<br>Recon-independent research estimates from geostationary IR + ' +
            'reanalysis environment. Not an official analysis. ' +
            '<b>OOB</b> = out-of-basin apply (trained on AL/EP recon labels); ' +
            '<b>QC</b> = flagged by the producer’s trace-vs-best-track test.' +
            /* Two surfaces publish a "GHOST-FPM Vmax" from the same pressure
               model, and they do NOT agree at the top. This one runs the full
               offline wind recipe; the real-time page cannot, because both of
               the extra pieces need something a live storm does not have (a
               held-out fold, and a best-track size analysis). Shipping both
               numbers silently was the one option ruled out — see
               TC-SWARM realtime/FPM_WIND_CONSISTENCY.md. */
            (isBlendVersion()
            /* v4+ (paper model): the wind is the tree member's DIRECT wind
               head, not a pressure-wind relationship; the pressure is the
               equal mean of the two members. */
            ? '<br><b>On the model:</b> P<sub>min</sub> is the equal mean of ' +
              'two independent held-out members — the first-principles ' +
              'ridge (FPM v2.1) and the boosted-tree stack (tree member) — ' +
              'with the tree’s last value carried for six hours where it ' +
              'abstains. V<sub>max</sub> is the tree member’s <i>direct</i> ' +
              'wind head with the v2.4 Cat-5 corrections; it is not derived ' +
              'from the pressure. In the Atlantic the wind abstains on ' +
              'QC-rejected frames (about a quarter); in the Pacific basins ' +
              'the last accepted wind is carried across them. The same ' +
              'blend runs in real time on the Real-Time Monitor’s ' +
              'Experimental tab.'
            : '<br><b>On the wind:</b> V<sub>max</sub> here is derived from the ' +
              'pressure by a fitted relationship, and it is the <i>offline</i> ' +
              'form of it — including a size term fed by best-track wind radii ' +
              'and a leave-one-storm-out correction to the strongest cases. ' +
              'Neither can be computed for a storm happening now, so the ' +
              'real-time FPM page reads a few knots lower for the same storm ' +
              'above about 110 kt. The pressure is the same model on both.') +
            '</details>';
    }

    /* The per-basin protocol table in the About panel. This is the statement
       the page previously did not make: Atlantic and East Pacific are frozen
       in-sample fits with a held-out channel available beside them, while the
       West Pacific is an out-of-basin transfer with no West Pacific frame in
       training at all — a STRICTER condition than either, and one a reader
       would otherwise read as the weakest row on the page. */
    function renderProtocols() {
        var el = $('gra-protocols');
        if (!el) return;
        var basins = (index.basins || []);
        var rows = basins.map(function (b) {
            var m = basinModel(b);
            if (!m) {
                return '<tr><th>' + (BASIN_LABEL[b] || b) + '</th>' +
                    '<td colspan="2" class="gra-absent">not stated in this ' +
                    'published version</td></tr>';
            }
            var ho = m.heldout_protocol
                ? (PROTO_SHORT[m.heldout_protocol] || m.heldout_protocol)
                : '<span class="gra-absent">none — nothing to hold out</span>';
            return '<tr><th>' + (BASIN_LABEL[b] || b) + '</th>' +
                '<td><span class="gra-proto-p ' + (m.protocol || '') + '">' +
                (PROTO_SHORT[m.protocol] || m.protocol) + '</span>' +
                (m.column ? '<br><code>' + m.column + '</code>' : '') + '</td>' +
                '<td>' + ho + '</td></tr>';
        }).join('');
        var detail = basins.map(function (b) {
            var m = basinModel(b);
            return m && m.protocol_detail
                ? '<p class="gra-about-note"><strong>' + (BASIN_LABEL[b] || b) +
                  ':</strong> ' + m.protocol_detail + '</p>'
                : '';
        }).join('');
        el.innerHTML =
            '<h4>What the estimate is, per basin</h4>' +
            '<table class="gra-proto-tbl"><thead><tr><th>Basin</th>' +
            '<th>Displayed estimate</th><th>Held out</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table>' + detail;
    }

    /* ── version picker ──────────────────────────────────────────────── */
    function renderVersions() {
        /* NOT named `sel` — that is the selected storm's SID at module scope,
           and shadowing it here is one careless edit away from clearing the
           selection every time the picker repaints. */
        var vsel = $('gra-version');
        if (!vsel) return;
        var list = versionList || [];
        if (list.length <= 1) {
            /* One version, or a pinned tree: show it, disabled. A control that
               vanishes leaves the reader unable to tell WHICH version they are
               looking at, which is the state this whole change exists to end. */
            vsel.innerHTML = '<option>' +
                ((list[0] && (list[0].title || list[0].version)) || version || '—') +
                '</option>';
            vsel.disabled = true;
        } else {
            vsel.disabled = false;
            vsel.innerHTML = list.map(function (v) {
                return '<option value="' + v.version + '"' +
                    (v.version === version ? ' selected' : '') + '>' +
                    (v.title || v.version) + '</option>';
            }).join('');
            vsel.value = version;
        }
        var note = $('gra-version-note');
        if (note) {
            var cur = list.filter(function (v) { return v.version === version; })[0];
            note.textContent = pinned ? 'pinned by URL'
                : (cur && cur.cut_date ? 'cut ' + cur.cut_date : '');
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  leaderboard
    // ══════════════════════════════════════════════════════════════
    /* The held-out minimum, beside the product minimum, in the leaderboard's
       own number column.

       Three states, and they must not look alike:
         a value          the storm has a held-out estimate — show it, and the
                          divergence is the information (Patricia: 868.6
                          frozen, 885.9 held out)
         "not held out"   the basin has NO held-out channel because there is
                          nothing to hold out — an out-of-basin transfer is
                          already out of sample everywhere
         "—"              a held-out channel exists for this basin but not for
                          this storm
       Rendering any of them as a repeat of the product value, or as a flat
       fill, would turn an absence into apparent corroboration. */
    function heldoutCell(s) {
        var m = basinModel(s.basin);
        if (s.heldout_min_hpa !== null && s.heldout_min_hpa !== undefined) {
            var d = (s.ghost_min_hpa !== null && s.ghost_min_hpa !== undefined)
                ? s.heldout_min_hpa - s.ghost_min_hpa : null;
            return '<span class="gra-ho" title="' +
                ((PROTO_SHORT[s.heldout_protocol] || 'held out')) +
                ' minimum — the same model refit without this storm&rsquo;s ' +
                'season">HO ' + s.heldout_min_hpa.toFixed(1) +
                (d !== null ? ' <i>' + (d > 0 ? '+' : '−') +
                    Math.abs(d).toFixed(1) + '</i>' : '') + '</span>';
        }
        if (m && m.protocol === 'transfer') {
            return '<span class="gra-ho gra-ho-na" title="Out-of-basin ' +
                'transfer: zero ' + s.basin + ' frames were in training, so ' +
                'every frame is already out of sample and there is nothing to ' +
                'hold out">not held out</span>';
        }
        if (m && !m.heldout_column &&
                (m.protocol === 'loyo' || m.protocol === 'loso')) {
            return '<span class="gra-ho gra-ho-na" title="' +
                heldoutAbsence(s.basin) + '">held out</span>';
        }
        if (s.heldout_available === false || !m || !m.heldout_column) {
            return '<span class="gra-ho gra-ho-na" title="' +
                heldoutAbsence(s.basin) + '">no held-out channel</span>';
        }
        return '<span class="gra-ho gra-ho-na" title="A held-out channel ' +
            'exists for this basin but not for this storm">HO —</span>';
    }

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
        /* Value accessors follow the filter currency. `== null` (not ===)
           because a tree published before the peak-kt columns existed simply
           lacks the field. rank() flips the sign for kt so ascending sort
           still puts the most intense storm first in either unit. */
        var kt = funit === 'kt';
        var gval = function (s) { var v = kt ? s.ghost_peak_kt : s.ghost_min_hpa; return v == null ? null : v; };
        var bval = function (s) { var v = kt ? s.bt_peak_kt : s.bt_min_hpa; return v == null ? null : v; };
        var rank = function (v) { return v === null ? 9e9 : (kt ? -v : v); };
        var deep = function (s) { return rank(gval(s)); };
        var key = {
            ghost: deep,
            bt: function (s) { return rank(bval(s)); },
            diff: function (s) {
                return (gval(s) === null || bval(s) === null) ? 1
                    : -Math.abs(gval(s) - bval(s));
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
        $('gra-title').textContent = q ? 'Search results' : (SORT_TITLE[funit][sortKey] || 'Storms');

        var lastBasin = null;
        $('gra-list').innerHTML = rows.slice(0, 400).map(function (s) {
            var gv = gval(s), bv = bval(s);
            var d = (gv !== null && bv !== null) ? gv - bv : null;
            // blue always means "GHOST more intense": deeper in hPa, stronger in kt
            var dBlue = kt ? d > 0 : d < 0;
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
                (s.min_uncorroborated ? '<span class="gra-flag unc" title="This storm&rsquo;s deepest frame is also its largest disagreement with best track (' +
                    s.min_gap + ' hPa), with no reconnaissance nearby — the minimum has no independent support">?</span>' : '') +
                '</div>' +
                '<div class="gra-num gra-g">' + (gv !== null ? gv.toFixed(kt ? 0 : 1) : '—') +
                heldoutCell(s) + '</div>' +
                '<div class="gra-meta">' + s.year + ' · ' + s.basin + ' · ' + s.n + ' fr</div>' +
                '<div class="gra-num">BT ' + (bv !== null ? bv.toFixed(0) : '—') +
                (d !== null ? ' <span style="color:' + (dBlue ? '#2a78d6' : '#e34948') + '">' +
                    (d > 0 ? '+' : '−') + Math.abs(d).toFixed(0) + '</span>' : '') +
                '</div></div>';
        }).join('') ||
            '<div style="padding:16px;color:var(--slate);font-size:0.72rem;">' +
            (q ? 'No storm matches &ldquo;' + q + '&rdquo;.' : 'No storms match the filters.') +
            '</div>';
        /* Row clicks are handled by ONE delegated listener on #gra-list (see
           wire()). A per-row onclick used to be bound here as well, so every
           row click ran select() TWICE — two storm-JSON fetches, two /ir/meta
           calls and two frame fetches per open. */
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
        /* Name the protocol on the storm the reader has open, not only in the
           explainer they may never have expanded. Short form in the header —
           the full sentence is a hover away, and a three-line chip header eats
           the IR canvas it sits above. */
        var _bm = basinModel(s.basin);
        var _bp = $('gra-ir-basin');
        _bp.textContent = s.basin + ' · ' + s.year +
            (_bm ? ' · ' + (PROTO_SHORT[_bm.protocol] || _bm.protocol) : '');
        _bp.title = protoLine(s.basin) || '';
        $('gra-ir-vals').innerHTML = '';
        $('gra-ir-hover').textContent = '';
        $('gra-ir-status').textContent = '';
        ir = { sid: sid, want: tm, idx: null };
        _off = null; zoom = 1; cx = 0; cy = 0;   // new storm, new view
        fillCmapPicker();
        loadEye(sid);
        loadStorm(sid, function () {
            drawSpark(sid);
            // the per-storm JSON can arrive after the frame list, in which case
            // pickFrame had no peak to aim at yet — take the shot now
            if (ir && ir.sid === sid && tm == null && irMeta[sid]) pickFrame(sid, null);
        });
    }

    var _metaInflight = {};
    function loadIRMeta(sid, tm, t) {
        if (irMeta[sid]) return pickFrame(sid, tm);
        if (_metaInflight[sid]) return;          // already on its way; it will pickFrame
        _metaInflight[sid] = true;
        $('gra-ir-status').textContent = 'Loading IR frame list…';
        /* Pass the track VERBATIM, exactly as the Storm Detail tab does. The
           frame index space is derived from whatever track /ir/meta is handed,
           so any edit here would fork this tab's R2 frame cache away from
           Storm Detail's and double the stored objects for no benefit. */
        var trk = t.map(function (p) { return { t: p.t, la: p.la, lo: p.lo }; });
        getJSON(API + '/global/ir/meta?sid=' + encodeURIComponent(sid) +
            '&track=' + encodeURIComponent(JSON.stringify(trk)))
            .then(function (j) {
                delete _metaInflight[sid];
                irMeta[sid] = j;
                if (!j.available) {
                    $('gra-ir-status').textContent = 'No IR available: ' + (j.reason || 'unknown');
                    return;
                }
                if (ir && ir.sid === sid) pickFrame(sid, tm);   // not if the reader moved on
            })
            .catch(function (e) { delete _metaInflight[sid]; $('gra-ir-status').textContent = 'IR metadata failed: ' + e; });
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
        /* Keep the marker in the part of the map the IR panel is NOT covering.
           The panel is bottom-right anchored and ~700 px wide, so a plain
           panTo() centres the storm underneath it — which is exactly where you
           cannot see it. Aim for the centre of the unoccluded strip instead.

           Still only nudges when the marker is outside that strip: re-centring
           on every arrow-key step would make the map jitter while scrubbing. */
        try {
            var panel = document.querySelector('.gra-ir');
            var size = gmap.getSize();
            var occW = (panel && panel.classList.contains('open'))
                ? panel.getBoundingClientRect().width + 20 : 0;
            var freeW = size.x - occW;
            if (freeW < 220) {                       // narrow window: no strip to aim at
                if (!gmap.getBounds().contains([lat, lon])) gmap.panTo([lat, lon]);
                return;
            }
            var pt = gmap.latLngToContainerPoint([lat, lon]);
            var pad = 60;
            var inFree = pt.x > pad && pt.x < freeW - pad &&
                         pt.y > pad && pt.y < size.y - pad;
            if (!inFree) {
                gmap.panBy([Math.round(pt.x - freeW / 2),
                            Math.round(pt.y - size.y / 2)], { animate: true });
            }
        } catch (e) { }
    }

    /* Index of the extreme of one series: sign=+1 for a maximum (wind),
       sign=-1 for a minimum (pressure). Shared by the landing-frame pick
       and the peak markers on the chart so they can never disagree. */
    function peakIdx(t, a, sign) {
        if (!t || !a) return -1;
        var bi = -1, best = -Infinity;
        for (var i = 0; i < a.length && i < t.length; i++) {
            if (a[i] == null) continue;
            var v = sign * a[i];
            if (v > best) { best = v; bi = i; }
        }
        return bi;
    }

    /* Time of the storm's GHOST peak in the ACTIVE currency — the highest
       Vmax when the tab is ranking in kt, the deepest Pmin in hPa — so a
       reader who sorted storms by wind lands on the wind peak they ranked
       by. Falls back to the other channel when one is absent (old trees). */
    function peakTime(sid) {
        var st = stormCache[sid];
        if (!st) return null;
        var S = series(st);
        if (!S.t) return null;
        var kt = funit === 'kt';
        var bi = kt ? peakIdx(S.t, S.gv, +1) : peakIdx(S.t, S.gp, -1);
        if (bi < 0) bi = kt ? peakIdx(S.t, S.gp, -1) : peakIdx(S.t, S.gv, +1);
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
        el.textContent = atPeak
            ? (funit === 'kt' ? 'GHOST peak Vmax' : 'GHOST peak Pmin')
            : (dt === null ? '' : (dt === 0 ? 'exact match'
                : 'Δ ' + (dt > 0 ? '+' : '−') + Math.abs(dt) + ' min vs GHOST'));
        el.className = 'gra-ir-delta' + (dt !== null && Math.abs(dt) > 45 ? ' far' : '');

        valsAt(sid, Date.parse(f.datetime + 'Z'));
        drawSpark(sid);
        showPos(f.lat, f.lon);

        var key = sid + '/' + idx;
        if (irFrames[key]) return paint(irFrames[key]);
        if (irFrames[key] === false) return;      // already being fetched
        irFrames[key] = false;
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
            if (!j || !j.tb_data) { delete irFrames[key]; $('gra-ir-status').textContent = 'No IR data for this frame.'; return; }
            irFrames[key] = j;
            if (ir && ir.sid === sid && ir.idx === idx) paint(j);
        }).catch(function (e) { delete irFrames[key]; $('gra-ir-status').textContent = 'IR frame failed: ' + e; });
    }

    /* The frame payload is base64 uint8 brightness temperature, NOT a PNG:
       0 = invalid, 1..255 linear across [tb_vmin, tb_vmax] — the same encoding
       global_archive.js:decodeTbData reads. */
    function paint(j) {
        $('gra-ir-status').textContent = '';
        /* A substituted scan must say so on its face. When the primary mosaic
           has no image for the requested hour, the API now serves the nearest
           scan from the coarser storm-centered archive and declares the scan's
           OWN time — before it did, Nida 2009's 18:00 Nov 25 slot silently
           wore imagery from Nov 27. */
        var sub = $('gra-ir-sub');
        if (sub) {
            if (j.source === 'hursat') {
                var at = (j.actual_datetime || '').replace('T', ' ').slice(0, 16);
                sub.textContent = 'backup scan' + (at ? ' · taken ' + at + 'Z' : '');
                sub.title = 'The primary satellite mosaic has no image for this hour, ' +
                    'so this is the nearest scan from a coarser storm-centered archive' +
                    (at ? ', taken ' + at + 'Z' : '') + '. GHOST does not read this ' +
                    'picture — the estimate is unaffected.';
            } else { sub.textContent = ''; sub.title = ''; }
        }
        var bin = atob(j.tb_data), raw = new Uint8Array(bin.length), i;
        for (i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
        tb = { raw: raw, rows: j.tb_rows, cols: j.tb_cols, vmin: j.tb_vmin,
               scale: 254 / (j.tb_vmax - j.tb_vmin), b: j.bounds };
        applyEye();
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
    /* Centre marks default ON: the chip otherwise shows a scene with no
       indication of where the storm is claimed to be, which is the one
       thing a reader checking an estimate wants to see. */
    var irCentres = true;

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
        wireCentres(); wireExpand(); syncCentreKey(); if (irCoast) loadCoast();
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
        drawCoast(ctx, c, r);
        drawCentres(ctx, c, r);
        var z = $('gra-ir-zoom');
        if (z) z.textContent = zoom > 1.01 ? zoom.toFixed(1) + '× — double-click to reset' : '';
    }

    /* ── coastlines ───────────────────────────────────────────────────────
       The chip is a native MergIR grid — a regular lat/lon box — so lat/lon
       maps to source pixel LINEARLY. `bounds` rides along on the frame payload
       ({south,north,west,east}), which is what makes this cheap: no projection,
       no reprojection, just a scale.

       Segments are clipped and converted to SOURCE pixels once per frame, not
       per blit — blit() runs on every zoom and pan step, and walking ~100k
       coastline vertices there would make panning stutter.

       Vendored Natural Earth 10m simplified (~0.2 MB gzip), the same asset the
       realtime viewer uses; the full 9.3 MB 10m file is not worth it at chip
       scale. */
    var coastGeo = null, coastLoading = false, coastSegs = null, coastKey = '';
    var irCoast = true;

    function loadCoast() {
        if (coastGeo || coastLoading) return;
        coastLoading = true;
        fetch('assets/coastlines/ne_10m_coastline_simplified.geojson')
            .then(function (r) { return r.json(); })
            .then(function (g) { coastGeo = g; coastSegs = null; blit(); })
            .catch(function () { coastLoading = false; });   // silent: decoration
    }

    /* Unwrap a longitude toward the chip's own frame. A chip straddling the
       dateline carries west/east past ±180, and a vertex left in -180..180
       would be projected a world away — the same trap the map marker hits. */
    function unwrap(lon, mid) {
        while (lon - mid > 180) lon -= 360;
        while (mid - lon > 180) lon += 360;
        return lon;
    }

    function buildCoast() {
        if (!coastGeo || !tb || !tb.b) { coastSegs = []; return; }
        var b = tb.b, key = [b.south, b.north, b.west, b.east].join(',');
        if (coastKey === key && coastSegs) return;
        coastKey = key; coastSegs = [];
        var midLon = (b.west + b.east) / 2, pad = 0.5;
        var sx = tb.cols / (b.east - b.west), sy = tb.rows / (b.north - b.south);
        var feats = coastGeo.features || [];
        for (var i = 0; i < feats.length; i++) {
            var gm = feats[i].geometry; if (!gm) continue;
            var lines = gm.type === 'LineString' ? [gm.coordinates]
                      : gm.type === 'MultiLineString' ? gm.coordinates : null;
            if (!lines) continue;
            for (var L = 0; L < lines.length; L++) {
                var cs = lines[L], run = null;
                for (var k = 0; k < cs.length; k++) {
                    var lon = unwrap(cs[k][0], midLon), lat = cs[k][1];
                    var inside = lon >= b.west - pad && lon <= b.east + pad &&
                                 lat >= b.south - pad && lat <= b.north + pad;
                    if (inside) {
                        if (!run) { run = []; coastSegs.push(run); }
                        run.push((lon - b.west) * sx, (b.north - lat) * sy);
                    } else if (run) {
                        run.push((lon - b.west) * sx, (b.north - lat) * sy);  // 1 pt past
                        run = null;
                    }
                }
            }
        }
    }

    function drawCoast(ctx, c, r) {
        if (!irCoast || !tb || !tb.b) return;
        if (!coastGeo) { loadCoast(); return; }
        buildCoast();
        if (!coastSegs.length) return;
        var kx = c.width / r.sw, ky = c.height / r.sh;
        ctx.save();
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        var w = Math.max(1.6, c.width / 300);
        var passes = [['rgba(0,0,0,.55)', w * 2.4], ['rgba(255,255,255,.92)', w]];
        for (var pi = 0; pi < passes.length; pi++) {
            ctx.strokeStyle = passes[pi][0]; ctx.lineWidth = passes[pi][1];
            ctx.beginPath();
            for (var i = 0; i < coastSegs.length; i++) {
                var g = coastSegs[i];
                for (var k = 0; k < g.length; k += 2) {
                    var X = (g[k] - r.sx) * kx, Y = (g[k + 1] - r.sy) * ky;
                    if (k === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
                }
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    /* ── centre marks ─────────────────────────────────────────────────────
       Two different centres can exist for one frame and they are not the same
       quantity, which is exactly why both are worth drawing:

         BEST TRACK  the interpolated track position. The chip is CUT about it
                     (`/global/ir/frame?...&lat=f.lat&lon=f.lon`), so it is the
                     chip centre by construction, not an estimate — always exact,
                     always available.

         EYE FIX     where the science pipeline's `recenter_ir` put the origin
                     when it found an eye. It is NOT in this data path today, so
                     it draws only when a frame supplies it. Worth showing when
                     it lands: that recentring maximises an eye-quality objective
                     and can therefore lock onto a corrupt pixel — the Amanda
                     2014 spike was exactly that, the origin pinned to a coded
                     329 K pixel 20 km off track — and ~21% of centre-found
                     frames hit the 50 km clamp, which nothing surfaces today. */
    function srcToCanvas(sx, sy, r, c) {
        return { x: (sx - r.sx) / r.sw * c.width,
                 y: (sy - r.sy) / r.sh * c.height };
    }

    /* Line widths are in SOURCE pixels but the canvas is displayed at roughly a
       third of its internal size (550 px backing store inside a ~180 px box), so
       a nominal 1 px stroke renders sub-pixel and vanishes. Scale off the
       backing store and keep a dark halo underneath so the mark survives both
       the cold-cloud purples and the warm-eye reds. */
    function crosshair(ctx, x, y, col, gap, arm, w) {
        ctx.save();
        ctx.lineCap = 'round';
        var passes = [['rgba(0,0,0,.65)', w * 2.2], [col, w]];
        for (var i = 0; i < passes.length; i++) {
            ctx.strokeStyle = passes[i][0];
            ctx.lineWidth = passes[i][1];
            ctx.beginPath();
            ctx.moveTo(x - gap - arm, y); ctx.lineTo(x - gap, y);
            ctx.moveTo(x + gap, y);       ctx.lineTo(x + gap + arm, y);
            ctx.moveTo(x, y - gap - arm); ctx.lineTo(x, y - gap);
            ctx.moveTo(x, y + gap);       ctx.lineTo(x, y + gap + arm);
            ctx.stroke();
        }
        ctx.restore();
    }

    function drawCentres(ctx, c, r) {
        if (!tb || !irCentres) return;
        var g = Math.max(4, c.width / 42), a = Math.max(8, c.width / 15);
        var w = Math.max(2.5, c.width / 150);
        // best track = chip centre, by construction
        var bt = srcToCanvas(tb.cols / 2, tb.rows / 2, r, c);
        crosshair(ctx, bt.x, bt.y, '#38bdf8', g, a, w);
        // eye fix, only if the frame actually carries one
        if (tb.eye_col != null && tb.eye_row != null) {
            var ey = srcToCanvas(tb.eye_col, tb.eye_row, r, c);
            crosshair(ctx, ey.x, ey.y, '#f43f5e', g, a, w);
            ctx.save();                                  // tie the two together
            ctx.setLineDash([w * 2, w * 2]); ctx.lineWidth = w * 0.8;
            ctx.strokeStyle = 'rgba(244,63,94,.85)';
            ctx.beginPath(); ctx.moveTo(bt.x, bt.y); ctx.lineTo(ey.x, ey.y); ctx.stroke();
            ctx.restore();
        }
    }

    /* Toggle + key state. The eye-fix key stays dimmed unless the frame
       supplies one — an absent channel must not read as "no displacement". */
    function wireCentres() {
        var el = $('gra-ir-centres');
        if (!el || el._wired) return;
        el._wired = true;
        el.addEventListener('change', function () { irCentres = el.checked; blit(); });
        var co = $('gra-ir-coast');
        if (co && !co._wired) {
            co._wired = true;
            co.addEventListener('change', function () {
                irCoast = co.checked;
                if (irCoast) loadCoast();
                blit();
            });
        }
    }

    /* The eye-fix key carries its own state text: how far the IR centre sits
       from the best track when it locked, and WHY there is no mark when it did
       not — a clamped frame (optimum >50 km off track, pipeline fell back to
       best track) is a different fact from a frame with no eye signal, and
       both differ from "not computed". */
    function syncCentreKey() {
        var k = document.querySelector('.gra-ir-ctr-key.eye');
        if (!k) return;
        var on = !!(tb && tb.eye_col != null && tb.eye_row != null);
        k.classList.toggle('on', on);
        var lab = k.querySelector('span'), e = tb && tb.eye;
        if (!lab) return;
        var E = ir && eyeCache[ir.sid];
        if (on) {
            lab.textContent = 'IR eye fix' + (e && e.d != null ? ' · ' + Math.round(e.d) + ' km off track' : '');
            k.title = 'Where the pipeline’s IR centre-finder placed the eye for this frame ' +
                '(core-Tb minimisation, accepted within 50 km of the best track). ' +
                'GHOST’s features were computed about this point.';
        } else if (e && e.r === 'clamped') {
            lab.textContent = 'IR eye fix · clamped' + (e.d != null ? ' (' + Math.round(e.d) + ' km)' : '');
            k.title = 'The centre-finder’s optimum lay more than 50 km from the best track, so the ' +
                'pipeline fell back to the best-track centre for this frame.';
        } else if (e) {
            lab.textContent = 'IR eye fix · no lock';
            k.title = 'No usable eye signal on this frame — the pipeline used the best-track centre.';
        } else if (E === false) {
            lab.textContent = 'IR eye fix · loading';
            k.title = '';
        } else {
            lab.textContent = 'IR eye fix';
            k.title = 'Not available for this frame.';
        }
    }

    /* Expand/collapse. blit() is re-run because the canvas backing store is
       fixed but its DISPLAYED size changes, and the crosshair/coastline stroke
       widths are derived from the backing store — they stay correct, but the
       repaint keeps the marks crisp after the layout settles. */
    function wireExpand() {
        var b = $('gra-ir-expand');
        if (!b || b._wired) return;
        b._wired = true;
        b.addEventListener('click', function () {
            var panel = document.querySelector('.gra-ir');
            var big = panel.classList.toggle('big');
            b.innerHTML = big ? '&#10231;' : '&#10530;';
            b.title = big ? 'Shrink the satellite view' : 'Expand the satellite view';
            setTimeout(function () { blit(); if (ir && ir.sid) drawSpark(ir.sid); }, 60);
        });
    }

    function resetZoom() {
        zoom = 1;
        cx = tb ? tb.cols / 2 : 0;
        cy = tb ? tb.rows / 2 : 0;
        blit();
    }

    /* Screen point -> source pixel, through the current zoom/pan.

       The canvas is `object-fit: contain`, so its CONTENT is letterboxed inside
       the element box whenever the two aspects differ — 550x549 backing store
       inside a 336x300 box leaves ~18px blank bars left and right. Mapping the
       cursor linearly across getBoundingClientRect() therefore stretched every
       reading by ~12% off-centre and, in the bars, produced an out-of-range
       index that made the handler return with the PREVIOUS text still showing —
       which is what surfaced as a spurious "no data" on Patricia and Maemi.

       Map through the rendered image rect instead. This also fixes drag-panning,
       which used the same helper. */
    function fitRect(el) {
        var b = el.getBoundingClientRect();
        var k = Math.min(b.width / el.width, b.height / el.height);
        var w = el.width * k, h = el.height * k;
        return { left: b.left + (b.width - w) / 2, top: b.top + (b.height - h) / 2,
                 width: w, height: h };
    }

    function toSrc(e, el) {
        var b = fitRect(el), r = srcRect();
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

    var _stormInflight = {};
    function loadStorm(sid, cb) {
        if (stormCache[sid]) return cb();
        if (!_stormInflight[sid]) {
            _stormInflight[sid] = getJSON(DATA() + '/storm/' + sid + '.json')
                .catch(function () { return null; })
                .then(function (j) { delete _stormInflight[sid]; if (j) stormCache[sid] = j; return j; });
        }
        _stormInflight[sid].then(function (j) { if (j) cb(); });
    }

    /* Aircraft fix TIMES from the archive's f-deck endpoint — every AIRC-derived
       fix type, not only the ones carrying a wind: the question the strip
       answers is "was a plane in the storm", not "what did it measure". NHC
       basins only; anywhere else the endpoint 404s and the miss is cached so
       the storm is asked once. The chart re-renders itself when the fetch
       lands, if that storm is still the one open. */
    function loadFdeck(sid, st) {
        if (fdeckCache[sid] !== undefined) return;
        var atcf = (st && st.atcf) || (byId[sid] && byId[sid].atcf);
        var b = (atcf || '').slice(0, 2);
        if (!atcf || (b !== 'AL' && b !== 'EP' && b !== 'CP')) { fdeckCache[sid] = null; return; }
        fdeckCache[sid] = false;                       // in flight
        _fetchJSON(API + '/global/fdeck?atcf_id=' + encodeURIComponent(atcf))
            .then(function (j) {
                var F = (j && j.fixes) || {}, ts = [];
                ['SFMR', 'FL_WIND', 'DROPSONDE', 'AIRC_OTHER'].forEach(function (k) {
                    (F[k] || []).forEach(function (r) {
                        var ms = Date.parse(String(r.time).replace(' ', 'T') + 'Z');
                        if (isFinite(ms)) ts.push(ms);
                    });
                });
                ts.sort(function (a, b) { return a - b; });
                // dedupe: SFMR + FL at the same minute is one aircraft, one time
                var u = [];
                for (var i = 0; i < ts.length; i++) if (!u.length || ts[i] - u[u.length - 1] >= 60e3) u.push(ts[i]);
                fdeckCache[sid] = u.length ? { t: u } : null;
            })
            .catch(function () { fdeckCache[sid] = null; })
            .then(function () { if (ir && ir.sid === sid) drawSpark(sid); });
    }

    /* The IR-recentred centre the pipeline used, per lifecycle frame. Absent
       for a storm (older sidecar build, or a frame the finder never saw)
       means the mark simply does not draw — never "no displacement". */
    function loadEye(sid) {
        if (eyeCache[sid] !== undefined) return;
        eyeCache[sid] = false;
        getJSON(ROOT + '/eye/' + sid + '.json')
            .then(function (j) {
                if (!j || !j.t) { eyeCache[sid] = null; return; }
                var ms = new Array(j.t.length);
                for (var i = 0; i < j.t.length; i++) ms[i] = Date.parse(j.t[i] + 'Z');
                j.ms = ms;
                eyeCache[sid] = j;
            })
            .catch(function () { eyeCache[sid] = null; })
            .then(function () { if (ir && ir.sid === sid && tb) { applyEye(); syncCentreKey(); blit(); } });
    }

    /* Resolve the open frame's eye fix into SOURCE pixel coordinates on the
       chip. The chip is a regular lat/lon box (bounds on the payload) so this
       is a scale, the same one the coastline uses. Frames are matched to the
       sidecar by time within the fetch's own ±20 min tolerance. */
    function applyEye() {
        if (!tb) return;
        tb.eye_col = tb.eye_row = null; tb.eye = null;
        var E = ir && eyeCache[ir.sid];
        var m = ir && irMeta[ir.sid];
        if (!E || !E.ms || !m || !m.frames || ir.idx === null) return;
        var f = m.frames[ir.idx];
        if (!f) return;
        var want = Date.parse(f.datetime + 'Z'), bi = -1, bd = 20 * 60e3;
        for (var i = 0; i < E.ms.length; i++) {
            var d = Math.abs(E.ms[i] - want);
            if (d <= bd) { bd = d; bi = i; }
        }
        if (bi < 0) return;
        tb.eye = { f: E.f ? E.f[bi] : 0, d: E.d ? E.d[bi] : null, r: E.r ? E.r[bi] : '',
                   la: E.la ? E.la[bi] : null, lo: E.lo ? E.lo[bi] : null };
        if (!tb.eye.f || tb.eye.la == null || tb.eye.lo == null || !tb.b) return;
        var b = tb.b, mid = (b.west + b.east) / 2, lon = tb.eye.lo;
        while (lon - mid > 180) lon -= 360;
        while (mid - lon > 180) lon += 360;
        tb.eye_col = (lon - b.west) / (b.east - b.west) * tb.cols;
        tb.eye_row = (b.north - tb.eye.la) / (b.north - b.south) * tb.rows;
    }

    /* Which series a storm carries depends on its channel: the lifecycle trace
       (genesis→decay, 3-hourly) where it exists, the recon board otherwise. */
    function series(st) {
        /* `lho` is written by the gated publisher from the board the release
           manifest declares, aligned to whichever time array it names in
           `lho_key`. Absent means absent — do not fall back to a payload
           array of unknown provenance to fill the line in. */
        var ho = (st.lho && st.lho_key === (st.lt ? 'lt' : 't')) ? st.lho : null;
        return st.lt
            ? { t: st.lt, gp: st.lp, bp: st.lbp, gv: st.lv || st.wv, bv: st.lbv || st.vw, ho: ho }
            : { t: st.t, gp: st.duo || st.g2, bp: st.p, gv: st.wv, bv: st.vw, ho: ho };
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
        var b = st.basin || (byId[sid] && byId[sid].basin);
        var hoTxt = S.ho
            ? '<span class="gra-ho">HO <b>' + f(S.ho, 1) + '</b></span>'
            : '<span class="gra-ho gra-ho-na" title="' + heldoutAbsence(b) +
              '">' + ((basinModel(b) || {}).protocol === 'transfer'
                  ? 'not held out' : 'no HO') + '</span>';
        $('gra-ir-vals').innerHTML =
            '<span class="gra-g">GHOST</span> <b>' + f(S.gp, 1) + '</b> hPa / <b>' +
            f(S.gv, 0) + '</b> kt &nbsp;·&nbsp; ' + hoTxt +
            ' &nbsp;·&nbsp; BT <b>' + f(S.bp, 0) + '</b> hPa / <b>' +
            f(S.bv, 0) + '</b> kt';
    }

    /* Sparkline: GHOST vs best track over the lifetime, with the IR cursor.
       The full multi-product chart (SATCON / D-PRINT / DMINT / AiDT, which the
       per-storm JSON already carries) is the next phase — this is only enough
       to make a selection mean something. */
    /* ── lifecycle chart ─────────────────────────────────────────────────
       Two stacked panels sharing one time axis — NEVER a dual axis. Pressure
       and wind are different units on different scales, and overlaying them on
       twin y-axes invites exactly the false crossings-and-convergences reading
       that a reader cannot unsee. Two panels cost vertical space and buy an
       honest comparison.

       The old sparkline plotted pressure only, unlabelled, and dropped wind
       entirely — so it was impossible to tell what was even being shown. */
    function drawSpark(sid) {
        var host = $('gra-ir-spark');
        var st = stormCache[sid];
        if (!st) { host.innerHTML = ''; return; }
        var S = series(st);
        if (!S.t || S.t.length < 2) { host.innerHTML = ''; return; }

        /* GAP holds the recon strip (band + ticks) between the panels, so it is
           wider than a title alone needs. */
        var W = 352, PL = 34, PR = 6, PT = 12, HP = 84, GAP = 34, HV = 62, PB = 16;
        var H = PT + HP + GAP + HV + PB;
        var t0 = Date.parse(S.t[0] + 'Z'), t1 = Date.parse(S.t[S.t.length - 1] + 'Z');
        var span = (t1 - t0) || 1;
        var X = function (ms) { return PL + (ms - t0) / span * (W - PL - PR); };
        var Xi = function (i) { return X(Date.parse(S.t[i] + 'Z')); };
        var XL = PL, XR = W - PR;
        var clampX = function (x) { return Math.max(XL, Math.min(XR, x)); };

        /* ── storm nature (IBTrACS `nature`): TS tropical, ET extratropical,
           SS subtropical, DS disturbance, MX mixed, NR not reported. Read off
           the archive's own track — the same object the frame index is cut
           from — so the bands line up with the frames by construction. Each
           track point owns the interval to the next point; only non-tropical
           stretches are drawn. */
        var NAT_NAME = { ET: 'extratropical', SS: 'subtropical', DS: 'disturbance',
                         MX: 'mixed', NR: 'nature not reported', TS: 'tropical' };
        var natSpans = [], natSeen = {};
        var trk = GA() ? GA().getTrack(sid) : null;
        if (trk && trk.length) {
            var cur = null;
            for (var q = 0; q < trk.length; q++) {
                var tp = trk[q], nn = (tp.n || 'NR').toUpperCase();
                var tms = Date.parse(tp.t + 'Z');
                if (!isFinite(tms)) continue;
                var tnext = q + 1 < trk.length ? Date.parse(trk[q + 1].t + 'Z') : tms + 3 * 3600e3;
                if (cur && cur.n === nn) { cur.b = tnext; }
                else { cur = { n: nn, a: tms, b: tnext }; natSpans.push(cur); }
            }
        }
        function natureAt(ms) {
            for (var i = 0; i < natSpans.length; i++) {
                if (ms >= natSpans[i].a && ms < natSpans[i].b) return natSpans[i].n;
            }
            return null;
        }
        function natBands(y, h) {
            var out = '';
            for (var i = 0; i < natSpans.length; i++) {
                var sp = natSpans[i];
                if (sp.n === 'TS' || sp.b < t0 || sp.a > t1) continue;
                var xa = clampX(X(sp.a)), xb = clampX(X(sp.b));
                if (xb - xa < 0.5) continue;
                natSeen[sp.n] = true;
                out += '<rect x="' + xa.toFixed(1) + '" y="' + y + '" width="' + (xb - xa).toFixed(1) +
                    '" height="' + h + '" class="gc-nat-' + sp.n + '"/>';
            }
            return out;
        }

        /* ── recon: two layers of the same fact.
             band  = `lr`, the recon-proximate flag on each published frame
                     (an f-deck aircraft MSLP within ±3 h — the SAME definition
                     the "Recon-proximate only" filter and the recon stratum
                     use, so what the chart shades is what the filter keeps).
             ticks = individual aircraft fix times from the f-deck, fetched
                     once per storm; drawn on top when they arrive. */
        var yStrip = PT + HP + 8, hStrip = 6;
        function reconStrip() {
            var out = '';
            var lr = st.lr;
            if (lr && lr.length === S.t.length) {
                var half = 1.5 * 3600e3;
                for (var i = 0; i < lr.length; i++) {
                    if (!lr[i]) continue;
                    var ms = Date.parse(S.t[i] + 'Z');
                    var xa = clampX(X(ms - half)), xb = clampX(X(ms + half));
                    out += '<rect x="' + xa.toFixed(1) + '" y="' + yStrip + '" width="' +
                        Math.max(0.6, xb - xa).toFixed(1) + '" height="' + hStrip + '" class="gc-rec-band"/>';
                }
            }
            var fx = fdeckCache[sid];
            if (fx && fx.t && fx.t.length) {
                for (var k = 0; k < fx.t.length; k++) {
                    var x = X(fx.t[k]);
                    if (x < XL - 0.5 || x > XR + 0.5) continue;
                    out += '<rect x="' + (x - 0.6).toFixed(1) + '" y="' + (yStrip - 1) +
                        '" width="1.2" height="' + (hStrip + 2) + '" class="gc-rec-tick"/>';
                }
            }
            if (!out) return '';
            return '<text x="' + (PL - 4) + '" y="' + (yStrip + hStrip - 0.5) +
                '" class="gc-rec-lab" text-anchor="end">recon</text>' + out;
        }
        function reconCount(ms) {          // aircraft fixes within ±3 h of ms
            var fx = fdeckCache[sid], n = 0;
            if (fx && fx.t) for (var i = 0; i < fx.t.length; i++) if (Math.abs(fx.t[i] - ms) <= 3 * 3600e3) n++;
            return n;
        }
        loadFdeck(sid, st);

        function rng(arrs, padFrac) {
            var v = [];
            for (var a = 0; a < arrs.length; a++) {
                var A = arrs[a];
                for (var i = 0; A && i < A.length; i++) if (A[i] != null) v.push(A[i]);
            }
            if (!v.length) return null;
            var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v);
            if (hi - lo < 4) { hi += 2; lo -= 2; }
            var pad = (hi - lo) * (padFrac || 0.08);
            return { lo: lo - pad, hi: hi + pad };
        }
        var rp = rng([S.gp, S.bp, S.ho], 0.08);
        var rv = rng([S.gv, S.bv], 0.10);

        // pressure: LOW at top, the convention every forecaster reads
        var Yp = rp ? function (v) { return PT + (v - rp.lo) / (rp.hi - rp.lo) * HP; } : null;
        var yv0 = PT + HP + GAP;
        var Yv = rv ? function (v) { return yv0 + HV - (v - rv.lo) / (rv.hi - rv.lo) * HV; } : null;

        function path(a, Y) {
            if (!a || !Y) return '';
            var d = '', pen = false;
            for (var i = 0; i < a.length; i++) {
                if (a[i] == null) { pen = false; continue; }
                d += (pen ? 'L' : 'M') + Xi(i).toFixed(1) + ' ' + Y(a[i]).toFixed(1) + ' ';
                pen = true;
            }
            return d;
        }
        function line(a, Y, col, w, dash) {
            var d = path(a, Y);
            return d ? '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="' + w +
                '"' + (dash ? ' stroke-dasharray="3 2"' : '') + ' stroke-linejoin="round"/>' : '';
        }
        function ylab(Y, r, unit) {
            if (!Y || !r) return '';
            var a = Math.round(r.lo + (r.hi - r.lo) * 0.08), b = Math.round(r.hi - (r.hi - r.lo) * 0.08);
            return ['<text x="' + (PL - 4) + '" y="' + (Y(a) + 3).toFixed(1) + '" class="gc-ax" text-anchor="end">' + a + '</text>',
                    '<text x="' + (PL - 4) + '" y="' + (Y(b) + 3).toFixed(1) + '" class="gc-ax" text-anchor="end">' + b + '</text>'].join('');
        }
        // a few date ticks so the axis is readable rather than decorative
        var ticks = '';
        for (var k = 0; k <= 3; k++) {
            var ms = t0 + span * k / 3, x = X(ms), dt = new Date(ms);
            var lab = (dt.getUTCMonth() + 1) + '/' + dt.getUTCDate();
            ticks += '<text x="' + x.toFixed(1) + '" y="' + (H - 4) + '" class="gc-ax" text-anchor="' +
                (k === 0 ? 'start' : k === 3 ? 'end' : 'middle') + '">' + lab + '</text>';
        }

        /* Aircraft fixes: the only barometer truth in this product. Everything
           else on the chart is either a model estimate or a best-track value
           that is itself largely Dvorak-derived outside the recon stratum, so
           marking WHEN a plane was actually there is the single most useful
           annotation available. Absent for most storms and for the whole West
           Pacific, which has no aircraft recon ever — so an empty array must
           render as nothing, never as a zero. */
        function vdmMarks(st, X, Yp, Yv) {
            var d = st.vdm;
            if (!d || !d.t || !d.t.length) return '';
            var out = '';
            for (var i = 0; i < d.t.length; i++) {
                var x = X(Date.parse(d.t[i] + 'Z'));
                if (!isFinite(x)) continue;
                if (d.p && d.p[i] != null && Yp) {
                    /* FOUR states, not two. ATCF field 16 (PRESSURE DERIVATION)
                       exists for exactly this distinction and is populated on 0
                       of 11,347 aircraft lines, so it survives only as free text
                       in the comment: D dropsonde 38%, X extrapolated 8%, B both
                       1%, U NOT RECORDED 53%. And the marker is era-dependent —
                       0% recorded before 2002, 93-100% from 2019.

                       So "unknown" gets its own rendering. Collapsing U into
                       "measured" would assert a provenance the record does not
                       carry, on half the fixes and on every pre-2002 one. */
                    var k = d.src ? String(d.src[i] || 'U').toUpperCase() : 'U';
                    var cls = k === 'D' ? '' : k === 'X' ? ' est' : k === 'B' ? ' both' : ' unk';
                    out += '<circle cx="' + x.toFixed(1) + '" cy="' + Yp(d.p[i]).toFixed(1) +
                        '" r="2.4" class="gc-vdm' + cls + '"/>';
                }
                if (d.v && d.v[i] != null && Yv) {
                    out += '<circle cx="' + x.toFixed(1) + '" cy="' + Yv(d.v[i]).toFixed(1) +
                        '" r="2.4" class="gc-vdm"/>';
                }
            }
            return out;
        }

        var bas = st.basin || (byId[sid] && byId[sid].basin);
        var vdmKey = (st.vdm && st.vdm.t && st.vdm.t.length)
            ? ' &nbsp; <b class="gc-vdm-key">&#9679;</b> aircraft (' + st.vdm.t.length + ')'
            : '';
        var hoKey = S.ho ? '<b style="color:#f43f5e">- -</b> held out'
                         : '<span class="gra-absent">' + heldoutAbsence(bas) + '</span>';

        // bands are built first so natSeen is populated for the key
        var bandsP = natBands(PT, HP), bandsV = natBands(yv0, HV);
        var strip = reconStrip();

        /* Dashed markers at the times of GHOST peak Vmax and peak Pmin,
           drawn through both panels — the two moments a reader compares,
           and they often differ (the wind typically peaks before the
           pressure bottoms). Computed by the same peakIdx the landing-frame
           pick uses, so the marker and the "GHOST peak" chip can never
           disagree. Coincident peaks (within a line width) collapse to a
           single line so the chart never shows a fake double marker. */
        var iPk = peakIdx(S.t, S.gp, -1), iVk = peakIdx(S.t, S.gv, +1);
        var xPk = iPk >= 0 ? clampX(Xi(iPk)) : null;
        var xVk = iVk >= 0 ? clampX(Xi(iVk)) : null;
        function peakLine(x, cls) {
            return '<line class="' + cls + '" x1="' + x.toFixed(1) + '" x2="' +
                x.toFixed(1) + '" y1="' + PT + '" y2="' + (yv0 + HV) + '"/>';
        }
        var peakLines = '', peakKey = '';
        if (xPk !== null && xVk !== null && Math.abs(xPk - xVk) < 2.5) {
            peakLines = peakLine(xPk, 'gc-peak-p');
            peakKey = ' &nbsp; <span class="gc-peak-key"><i class="p"></i>peak P<sub>min</sub> &amp; V<sub>max</sub></span>';
        } else {
            if (xPk !== null) {
                peakLines += peakLine(xPk, 'gc-peak-p');
                peakKey += ' &nbsp; <span class="gc-peak-key"><i class="p"></i>peak P<sub>min</sub></span>';
            }
            if (xVk !== null) {
                peakLines += peakLine(xVk, 'gc-peak-v');
                peakKey += ' &nbsp; <span class="gc-peak-key"><i class="v"></i>peak V<sub>max</sub></span>';
            }
        }
        var natKey = '';
        ['ET', 'SS', 'DS', 'MX', 'NR'].forEach(function (n) {
            if (natSeen[n]) natKey += ' &nbsp; <span class="gc-nat-key"><i class="' + n + '"></i>' + NAT_NAME[n] + '</span>';
        });
        var fx = fdeckCache[sid];
        var recKey = strip
            ? ' &nbsp; <span class="gc-rec-key"><i></i>recon' +
              (fx && fx.t && fx.t.length ? ' (' + fx.t.length + ' aircraft fixes)' : '') + '</span>'
            : (fx === undefined ? '' : '');

        host.innerHTML =
            '<svg id="gra-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" class="gra-chart">' +
            '<defs><pattern id="gc-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
            '<line x1="0" y1="0" x2="0" y2="4" class="gc-hatch-l"/></pattern></defs>' +
            '<rect x="' + PL + '" y="' + PT + '" width="' + (W - PL - PR) + '" height="' + HP + '" class="gc-bg"/>' +
            '<rect x="' + PL + '" y="' + yv0 + '" width="' + (W - PL - PR) + '" height="' + HV + '" class="gc-bg"/>' +
            bandsP + bandsV + strip +
            '<text x="' + PL + '" y="' + (PT - 3) + '" class="gc-t">Minimum pressure (hPa)</text>' +
            '<text x="' + PL + '" y="' + (yv0 - 3) + '" class="gc-t">Maximum wind (kt)</text>' +
            ylab(Yp, rp) + ylab(Yv, rv) + ticks +
            line(S.bp, Yp, 'var(--slate)', 1.5) + line(S.ho, Yp, '#f43f5e', 1.2, 1) +
            line(S.gp, Yp, '#f43f5e', 1.9) +
            line(S.bv, Yv, 'var(--slate)', 1.5) + line(S.gv, Yv, '#f43f5e', 1.9) +
            vdmMarks(st, X, Yp, Yv) +
            peakLines +
            '<line id="gc-cur" class="gc-cur" x1="0" x2="0" y1="' + PT + '" y2="' + (yv0 + HV) + '"/>' +
            '<line id="gc-hov" class="gc-hov" x1="0" x2="0" y1="' + PT + '" y2="' + (yv0 + HV) + '" style="display:none"/>' +
            '</svg>' +
            '<div class="gra-chart-key"><b style="color:#f43f5e">—</b> GHOST &nbsp; ' +
            '<b style="color:var(--slate)">—</b> best track &nbsp; ' + hoKey + vdmKey +
            natKey + recKey + peakKey + '</div>' +
            '<div id="gra-chart-read" class="gra-chart-read"></div>';

        var svg = $('gra-chart-svg');
        function markCurrent() {
            var cl = $('gc-cur');
            if (!cl || !ir || ir.idx === null || !irMeta[sid] || !irMeta[sid].frames) return;
            var f = irMeta[sid].frames[ir.idx];
            if (!f) return;
            var x = X(Date.parse(f.datetime + 'Z')).toFixed(1);
            cl.setAttribute('x1', x); cl.setAttribute('x2', x);
        }
        markCurrent();

        /* Hover reads the SERIES; click snaps to the nearest IR FRAME, which is
           a coarser grid — so the readout can show a time the chip cannot. Snap
           on click rather than silently showing the nearest frame's values under
           the cursor. */
        function msAt(ev) {
            var b = svg.getBoundingClientRect();
            var x = (ev.clientX - b.left) / b.width * W;
            return t0 + (x - PL) / (W - PL - PR) * span;
        }
        function nearestIdx(arrT, ms) {
            var bi = 0, bd = Infinity;
            for (var i = 0; i < arrT.length; i++) {
                var d = Math.abs(Date.parse(arrT[i] + 'Z') - ms);
                if (d < bd) { bd = d; bi = i; }
            }
            return bi;
        }
        var fmt = function (a, i, dp) {
            return (a && a[i] != null) ? a[i].toFixed(dp) : '—';
        };
        function hoverAt(ev) {
            var ms = msAt(ev), i = nearestIdx(S.t, ms);
            var hv = $('gc-hov'), x = Xi(i).toFixed(1);
            hv.style.display = ''; hv.setAttribute('x1', x); hv.setAttribute('x2', x);
            var tms = Date.parse(S.t[i] + 'Z'), d = new Date(tms);
            var nat = natureAt(tms);
            var rc = (st.lr && st.lr[i]) ? true : false, nfx = reconCount(tms);
            $('gra-chart-read').innerHTML =
                '<b>' + d.toISOString().slice(0, 16).replace('T', ' ') + 'Z' +
                (nat && nat !== 'TS' ? ' <span class="gc-nat-key"><i class="' + nat + '"></i>' + NAT_NAME[nat] + '</span>' : '') +
                (rc || nfx ? ' <span class="gc-rec-key"><i></i>recon' + (nfx ? ' (' + nfx + ' fix' + (nfx > 1 ? 'es' : '') + ' ±3 h)' : '') + '</span>' : '') +
                '</b>' +
                '<span><i style="background:#f43f5e"></i>GHOST ' + fmt(S.gp, i, 1) + ' hPa / ' + fmt(S.gv, i, 0) + ' kt</span>' +
                '<span><i style="background:var(--slate)"></i>BT ' + fmt(S.bp, i, 0) + ' hPa / ' + fmt(S.bv, i, 0) + ' kt</span>' +
                (S.ho ? '<span class="gra-ho">HO ' + fmt(S.ho, i, 1) + ' hPa</span>' : '') +
                vdmAt(st, tms);
        }
        svg.addEventListener('mousemove', hoverAt);
        /* Touch: a finger dragged across the chart scrubs the readout the way
           the pointer does; lifting it leaves the last value showing (there is
           no "leave" on a phone). Tap still snaps a frame via the click path. */
        svg.addEventListener('touchmove', function (ev) {
            if (!ev.touches || !ev.touches.length) return;
            hoverAt(ev.touches[0]);
            ev.preventDefault();
        }, { passive: false });
        svg.addEventListener('touchstart', function (ev) {
            if (ev.touches && ev.touches.length) hoverAt(ev.touches[0]);
        }, { passive: true });
        /* Only within +-3 h: the same window the recon flag uses, so what the
           readout calls an aircraft fix is the same thing the recon stratum
           counts. A looser window would quietly attribute a distant fix to a
           frame it never constrained. */
        function vdmAt(st, ms) {
            var d = st.vdm;
            if (!d || !d.t || !d.t.length) return '';
            var bi = -1, bd = 3 * 3600 * 1000;
            for (var i = 0; i < d.t.length; i++) {
                var g = Math.abs(Date.parse(d.t[i] + 'Z') - ms);
                if (g <= bd) { bd = g; bi = i; }
            }
            if (bi < 0) return '';
            var p = (d.p && d.p[bi] != null) ? d.p[bi].toFixed(0) + ' hPa' : '';
            /* `v` is the SURFACE wind (f-deck field 11), not flight level —
               flight-level wind is deliberately not published, because beside a
               best-track Vmax it would read as surface and overstate the storm. */
            var v = (d.v && d.v[bi] != null) ? d.v[bi].toFixed(0) + ' kt' : '';
            var K = d.src ? String(d.src[bi] || 'U').toUpperCase() : 'U';
            var how = K === 'D' ? ' dropsonde' : K === 'X' ? ' extrapolated'
                    : K === 'B' ? ' dropsonde + extrapolated' : ' (derivation not recorded)';
            return '<span class="gc-vdm-read"><i class="' +
                (K === 'D' ? '' : K === 'X' ? 'est' : K === 'B' ? 'both' : 'unk') +
                '"></i>aircraft ' + [p, v].filter(Boolean).join(' / ') + how + '</span>';
        }

        svg.addEventListener('mouseleave', function () {
            var hv = $('gc-hov'); if (hv) hv.style.display = 'none';
            $('gra-chart-read').innerHTML = '';
        });
        svg.addEventListener('click', function (ev) {
            var m = irMeta[sid];
            if (!m || !m.available || !m.frames || !m.frames.length) return;
            var ms = msAt(ev), bi = 0, bd = Infinity;
            for (var i = 0; i < m.frames.length; i++) {
                var d = Math.abs(Date.parse(m.frames[i].datetime + 'Z') - ms);
                if (d < bd) { bd = d; bi = i; }
            }
            showFrame(sid, bi);      // moves the chip AND the map marker
        });
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
        // the leaderboard's GHOST/BT chips rank in the same currency
        var quant = u === 'kt' ? 'V<sub>max</sub>' : 'P<sub>min</sub>';
        Array.prototype.forEach.call($('gra-sorts').children, function (x) {
            if (x.dataset.sort === 'ghost') x.innerHTML = 'GHOST ' + quant;
            if (x.dataset.sort === 'bt') x.innerHTML = 'BT ' + quant;
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
        if ($('gra-version')) {
            $('gra-version').onchange = function () { setVersion(this.value); };
        }
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
                var b = fitRect(cv), r = srcRect();
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
