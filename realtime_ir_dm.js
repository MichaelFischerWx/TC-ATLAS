/* realtime_ir_dm.js — the storm card's tabbed "DeepMind Ensemble" panel
 * (Intensity · Wind Risk · Landfall · Compare). UI only: every number comes
 * from tc_dm_analytics.js (window.TCDM) over payloads the card already
 * fetched, so this adds no backend cost.
 *
 * realtime_ir.js hands over a small bridge (RTDM.attach) with getters for
 * the live map / data / helpers and calls the RTDM.on* hooks when data
 * arrives or the DeepMind overlay is toggled. Nothing here reaches into the
 * main IIFE directly.
 *
 * These are experimental research diagnostics from Google DeepMind
 * ensembles. Every tab carries the official-guidance note; nothing here is
 * a forecast and nothing may read as contradicting NHC / CPHC / JTWC.
 */
(function () {
    'use strict';

    var B = null;               // bridge from realtime_ir.js
    var T = function () { return window.TCDM; };

    var TABS = ['intensity', 'risk', 'landfall', 'compare'];
    var CYAN = '#00e5ff';
    var OTHER = '#f472b6';      // the *other* model in Compare (pink, reads on cyan)
    var OFCL_RED = '#ff4757';

    var S = {
        visible: false,
        tab: 'intensity',
        stormId: null,
        risk: { thresh: 0, horizon: 120, layers: [], ellipses: false, ellipseLayers: [],
                grids: {}, point: null, marker: null, clickBound: false },
        lf:   { data: null, layers: [], showPts: true, loading: false },
        cmp:  { other: null, otherModel: null, loading: false, overlay: false, layers: [] },
        landMask: null,
    };

    // ── small DOM helpers ─────────────────────────────────────────────────
    function $(id) { return document.getElementById(id); }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function pct(v, d) { return v == null ? '—' : (100 * v).toFixed(d || 0) + '%'; }
    function fmtTauDate(init, tau) {
        var ms = T().initToMs(init); if (ms == null) return '+' + tau + ' h';
        var d = new Date(ms + tau * 3600000);
        var mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
        return mon + ' ' + d.getUTCDate() + ' ' + ('0' + d.getUTCHours()).slice(-2) + 'Z';
    }
    function fmtInit(init) {
        if (!init || init.length < 10) return '';
        return init.slice(4, 6) + '/' + init.slice(6, 8) + ' ' + init.slice(8, 10) + 'Z';
    }
    function catLabel(c) {
        return { TD: 'TD', TS: 'TS', C1: 'Cat 1', C2: 'Cat 2', C3: 'Cat 3', C4: 'Cat 4', C5: 'Cat 5', NA: '—' }[c] || c;
    }
    function catColor(c) { return (B && B.ssColors && B.ssColors[c]) || '#94a3b8'; }
    function cardinal(deg) {
        var d = ['N','NE','E','SE','S','SW','W','NW'];
        return d[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
    }
    function tile(label, value, sub, color) {
        return '<div class="rt-dm-tile">'
            + '<div class="rt-dm-tile-v"' + (color ? ' style="color:' + color + ';"' : '') + '>' + value + '</div>'
            + '<div class="rt-dm-tile-l">' + label + '</div>'
            + (sub ? '<div class="rt-dm-tile-s">' + sub + '</div>' : '')
            + '</div>';
    }
    function note(text) {
        return '<div class="rt-dm-note">' + text + '</div>';
    }
    function exportBtn(elId, label) {
        return '<button type="button" class="rt-dm-export-btn" title="Save as PNG" '
            + 'onclick="window.RTDM.exportChart(\'' + elId + '\',\'' + esc(label).replace(/'/g, '') + '\')">&#8681;</button>';
    }
    function modelTag() { return B ? B.modelTag() : 'DeepMind'; }
    function nMembers() { var w = B && B.wl(); return w ? (w.n_members || Object.keys(w.members || {}).length) : 0; }

    // ── panel / tabs ──────────────────────────────────────────────────────
    function setVisible(v) {
        S.visible = !!v;
        var p = $('rt-dm-panel'); if (p) p.style.display = v ? '' : 'none';
        if (v) renderTab(S.tab); else clearAllMapLayers();
    }
    function setTab(name) {
        if (TABS.indexOf(name) < 0) name = 'intensity';
        S.tab = name;
        for (var i = 0; i < TABS.length; i++) {
            var c = $('rt-dm-tab-' + TABS[i]); if (c) c.hidden = TABS[i] !== name;
        }
        var btns = document.querySelectorAll('#rt-dm-tabs [data-dmtab]');
        for (var b = 0; b < btns.length; b++) {
            var on = btns[b].getAttribute('data-dmtab') === name;
            btns[b].classList.toggle('active', on);
            btns[b].setAttribute('aria-selected', on ? 'true' : 'false');
        }
        // Map overlays belong to their tab: leaving one clears them, coming
        // back restores whatever the user had switched on.
        clearRiskLayers(); clearLfLayers(); clearCmpLayers(); unbindClick();
        renderTab(name);
        if (B) B.ga('rt_dm_tab', { tab: name });
    }
    function renderTab(name) {
        if (!S.visible) return;
        if (!B || !B.wl()) return;
        if (name === 'intensity') renderIntensityStrip();
        else if (name === 'risk') renderRisk();
        else if (name === 'landfall') renderLandfall();
        else if (name === 'compare') renderCompare();
    }
    function clearAllMapLayers() { clearRiskLayers(); clearLfLayers(); clearCmpLayers(); unbindClick(); }
    function removeLayers(arr) {
        var map = B && B.map();
        for (var i = 0; i < arr.length; i++) { try { if (map) map.removeLayer(arr[i]); } catch (e) {} }
        arr.length = 0;
    }

    // ── hooks from realtime_ir.js ─────────────────────────────────────────
    function onWeatherlab(json) {
        var sid = B ? B.stormId() : null;
        if (sid !== S.stormId) resetStorm();
        S.stormId = sid;
        S.risk.grids = {}; S.lf.data = null; S.cmp.other = null; S.cmp.otherModel = null;
        S.risk.point = null;
        var tag = $('rt-dm-panel-src'); if (tag) tag.textContent = modelTag() + ' · ' + nMembers() + ' members · init ' + fmtInit(json && json.init_time);
        if (S.visible) renderTab(S.tab);
    }
    function onEnsemble() { if (S.visible && S.tab === 'intensity') renderIntensityStrip(); }
    function onPanels(v) { setVisible(v); }
    function onStormClose() { resetStorm(); setVisible(false); }
    function resetStorm() {
        clearAllMapLayers();
        S.risk = { thresh: 0, horizon: 120, layers: [], ellipses: false, ellipseLayers: [],
                   grids: {}, point: null, marker: null, clickBound: false };
        S.lf = { data: null, layers: [], showPts: true, loading: false };
        S.cmp = { other: null, otherModel: null, loading: false, overlay: false, layers: [] };
        var pr = $('rt-dm-point-readout'); if (pr) pr.innerHTML = '';
    }

    // ═════════════════════════════════════════════════════════════════════
    //  INTENSITY tab — outlook strip above the existing distribution panels
    // ═════════════════════════════════════════════════════════════════════
    function renderIntensityStrip() {
        var el = $('rt-dm-outlook'); if (!el) return;
        var wl = B.wl(), ens = B.ens();
        var tiles = [];
        if (ens) {
            var ri = T().riProbability(ens, { thresh: 30 });
            var i48 = idxAtOrBelow(ri.taus, 48), i120 = idxAtOrBelow(ri.taus, 120);
            var pk = 0; for (var k = 1; k < ri.pAt.length; k++) if (ri.pAt[k] > ri.pAt[pk]) pk = k;
            tiles.push(tile('RI chance by +48 h', pct(i48 >= 0 ? ri.pBy[i48] : null),
                            '≥30 kt in 24 h', riColor(i48 >= 0 ? ri.pBy[i48] : 0)));
            tiles.push(tile('RI chance by +120 h', pct(i120 >= 0 ? ri.pBy[i120] : null),
                            ri.pAt[pk] > 0.02 ? 'peaks +' + (ri.taus[pk] - 24) + '–' + ri.taus[pk] + ' h' : 'no RI window',
                            riColor(i120 >= 0 ? ri.pBy[i120] : 0)));
        }
        if (wl) {
            var taus = wl.lead_times_h || [];
            var t120 = taus.indexOf(120) >= 0 ? 120 : taus[Math.min(taus.length - 1, 20)];
            var st = T().ensembleStats(wl, t120);
            var fracTS = null;
            if (st) {
                var keys = Object.keys(wl.members), c = 0, n = 0;
                for (var m = 0; m < keys.length; m++) {
                    var pts = wl.members[keys[m]].points || [];
                    for (var j = 0; j < pts.length; j++) if (pts[j].tau === t120) { n++; if (pts[j].wind >= 34) c++; break; }
                }
                fracTS = keys.length ? c / keys.length : null;
            }
            tiles.push(tile('Still ≥ TS at +' + t120 + ' h', pct(fracTS),
                            st && st.p64 != null ? 'hurricane: ' + pct(st.p64) : '', '#34d399'));
        }
        el.innerHTML = '<div class="rt-dm-tiles">' + tiles.join('') + '</div>';
    }
    function idxAtOrBelow(taus, t) { var best = -1; for (var i = 0; i < taus.length; i++) if (taus[i] <= t) best = i; return best; }
    function riColor(p) { return p >= 0.5 ? '#ef4444' : p >= 0.25 ? '#fb923c' : p >= 0.1 ? '#fbbf24' : '#94a3b8'; }

    // ═════════════════════════════════════════════════════════════════════
    //  WIND RISK tab — probability overlay + point readout + track ellipses
    // ═════════════════════════════════════════════════════════════════════
    // Yellow → orange → red → magenta → violet. Kept translucent and never
    // near-black so the IR imagery and the spaghetti stay readable underneath.
    var PROB_STOPS = [   // p, [r,g,b]
        [0.05, [253, 224, 71]], [0.20, [251, 146, 60]], [0.40, [239, 68, 68]],
        [0.60, [219, 39, 119]], [0.80, [168, 85, 247]], [1.00, [124, 58, 237]],
    ];
    function probColor(p) {
        if (!(p >= 0.05)) return null;
        var a = Math.round(95 + 75 * Math.min(1, (p - 0.05) / 0.95));
        for (var i = 1; i < PROB_STOPS.length; i++) {
            if (p <= PROB_STOPS[i][0]) {
                var f = (p - PROB_STOPS[i - 1][0]) / (PROB_STOPS[i][0] - PROB_STOPS[i - 1][0]);
                var c0 = PROB_STOPS[i - 1][1], c1 = PROB_STOPS[i][1];
                return [Math.round(c0[0] + (c1[0] - c0[0]) * f), Math.round(c0[1] + (c1[1] - c0[1]) * f),
                        Math.round(c0[2] + (c1[2] - c0[2]) * f), a];
            }
        }
        var l = PROB_STOPS[PROB_STOPS.length - 1][1]; return [l[0], l[1], l[2], a];
    }
    function legendCSS() {
        return 'linear-gradient(90deg,' + PROB_STOPS.map(function (s) {
            return 'rgb(' + s[1].join(',') + ') ' + Math.round(s[0] * 100) + '%'; }).join(',') + ')';
    }

    function renderRisk() {
        var el = $('rt-dm-tab-risk'); if (!el) return;
        var r = S.risk;
        function chip(label, on, onclick, title) {
            return '<button type="button" class="rt-dm-chip' + (on ? ' active' : '') + '" onclick="' + onclick + '"'
                + (title ? ' title="' + esc(title) + '"' : '') + '>' + label + '</button>';
        }
        var html = '';
        html += '<div class="rt-dm-row"><span class="rt-dm-row-l">Map layer</span>'
            + chip('Off', r.thresh === 0, 'window.RTDM.setRisk(0)')
            + chip('≥34 kt', r.thresh === 34, 'window.RTDM.setRisk(34)', 'Chance of tropical-storm-force wind')
            + chip('≥50 kt', r.thresh === 50, 'window.RTDM.setRisk(50)')
            + chip('≥64 kt', r.thresh === 64, 'window.RTDM.setRisk(64)', 'Chance of hurricane-force wind')
            + '</div>';
        html += '<div class="rt-dm-row"><span class="rt-dm-row-l">Within</span>'
            + chip('72 h', r.horizon === 72, 'window.RTDM.setHorizon(72)')
            + chip('120 h', r.horizon === 120, 'window.RTDM.setHorizon(120)')
            + chip('168 h', r.horizon === 168, 'window.RTDM.setHorizon(168)')
            + '<span class="rt-dm-row-sp"></span>'
            + chip('Track ellipses', r.ellipses, 'window.RTDM.toggleEllipses()',
                   '50% and 90% ellipses of member positions every 24 h')
            + '</div>';
        html += '<div id="rt-dm-risk-legend" class="rt-dm-legend"' + (r.thresh ? '' : ' style="display:none;"') + '>'
            + '<span class="rt-dm-legend-t">P(≥' + (r.thresh || 34) + ' kt) within ' + r.horizon + ' h</span>'
            + '<div class="rt-dm-legend-bar" style="background:' + legendCSS() + ';"></div>'
            + '<div class="rt-dm-legend-ticks"><span>5%</span><span>20%</span><span>40%</span><span>60%</span><span>80%</span><span>100%</span></div>'
            + '</div>';
        html += '<div id="rt-dm-point-readout" class="rt-dm-readout"></div>';
        html += note('Probabilities count ensemble members whose modeled wind field reaches a location within the window, '
            + 'using each member\'s own wind radii. Experimental research guidance from ' + esc(modelTag()) + ' — '
            + '<b>not a forecast</b>. Official watches, warnings and wind-speed probabilities come from '
            + '<a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener">NHC</a> / CPHC / JTWC or your national weather service.');
        el.innerHTML = html;
        renderPointReadout();
        // Restore map state for this tab.
        if (r.thresh) drawRiskOverlay();
        if (r.ellipses) drawEllipses();
        bindClick();
    }
    function setRisk(th) {
        S.risk.thresh = th; renderRisk();
        if (B) B.ga('rt_dm_risk_layer', { thresh: th, horizon: S.risk.horizon });
    }
    function setHorizon(h) { S.risk.horizon = h; S.risk.grids = {}; renderRisk(); }
    function toggleEllipses() { S.risk.ellipses = !S.risk.ellipses; renderRisk(); }

    function riskGrid(th) {
        var key = th + '@' + S.risk.horizon;
        if (!S.risk.grids[key]) {
            var wl = B.wl(); if (!wl) return null;
            S.risk.grids[key] = T().windProbGrid(wl.members, { thresh: th, maxTau: S.risk.horizon, cellDeg: 0.2, stepH: 2 }) || false;
        }
        return S.risk.grids[key] || null;
    }
    function clearRiskLayers() {
        removeLayers(S.risk.layers); removeLayers(S.risk.ellipseLayers);
        if (S.risk.marker) { try { B.map().removeLayer(S.risk.marker); } catch (e) {} S.risk.marker = null; }
    }
    function drawRiskOverlay() {
        removeLayers(S.risk.layers);
        var map = B.map(); if (!map || !S.risk.thresh) return;
        var g = riskGrid(S.risk.thresh);
        if (!g) {
            var lg = $('rt-dm-risk-legend'); if (lg) lg.innerHTML = '<span class="rt-dm-legend-t">No member reaches ≥' + S.risk.thresh + ' kt within ' + S.risk.horizon + ' h</span>';
            return;
        }
        var parts = T().rasterizeMercator(g, probColor, { pxPerCell: 5 });
        for (var i = 0; i < parts.length; i++) {
            var ov = L.imageOverlay(parts[i].url, parts[i].bounds, { opacity: 0.62, pane: 'dmProbPane', interactive: false });
            ov.addTo(map); S.risk.layers.push(ov);
        }
    }
    function drawEllipses() {
        removeLayers(S.risk.ellipseLayers);
        var map = B.map(), wl = B.wl(); if (!map || !wl) return;
        var taus = [];
        for (var t = 24; t <= S.risk.horizon; t += 24) taus.push(t);
        var ells = T().trackEllipses(wl.members, taus);
        for (var i = 0; i < ells.length; i++) {
            var e = ells[i];
            var p90 = L.polygon(e.poly90, { color: CYAN, weight: 1, opacity: 0.55, dashArray: '4,4',
                                            fillColor: CYAN, fillOpacity: 0.06, interactive: false, pane: 'dmProbPane' }).addTo(map);
            var p50 = L.polygon(e.poly50, { color: CYAN, weight: 1.2, opacity: 0.8,
                                            fillColor: CYAN, fillOpacity: 0.14, interactive: true, pane: 'dmProbPane' }).addTo(map);
            p50.bindTooltip('<b>+' + e.tau + ' h</b> · ' + e.n + ' members<br>50% / 90% position ellipses<br>'
                + 'σ ' + Math.round(e.sigmaKm[0]) + ' × ' + Math.round(e.sigmaKm[1]) + ' km', { direction: 'top' });
            S.risk.ellipseLayers.push(p90, p50);
        }
    }
    function bindClick() {
        var map = B.map(); if (!map || S.risk.clickBound) return;
        map.on('click', onMapClick); S.risk.clickBound = true;
    }
    function unbindClick() {
        var map = B.map(); if (!map || !S.risk.clickBound) return;
        try { map.off('click', onMapClick); } catch (e) {}
        S.risk.clickBound = false;
    }
    function onMapClick(ev) {
        if (!S.visible || S.tab !== 'risk') return;
        var ll = ev && ev.latlng; if (!ll) return;
        var lat = ll.lat, lon = ll.lng != null ? ll.lng : ll.lon;
        S.risk.point = { lat: lat, lon: lon };
        var map = B.map();
        if (S.risk.marker) { try { map.removeLayer(S.risk.marker); } catch (e) {} }
        S.risk.marker = L.circleMarker([lat, lon], { radius: 6, color: '#fff', weight: 2, fillColor: CYAN, fillOpacity: 1, pane: 'dmProbPane' }).addTo(map);
        renderPointReadout();
        if (B) B.ga('rt_dm_point_probe', { horizon: S.risk.horizon });
    }
    function renderPointReadout() {
        var el = $('rt-dm-point-readout'); if (!el) return;
        var p = S.risk.point, wl = B.wl();
        if (!p || !wl) {
            el.innerHTML = '<div class="rt-dm-hint">Click anywhere on the map for that location\'s wind chances and arrival timing.</div>';
            return;
        }
        var pp = T().pointProbabilities(wl.members, p.lat, p.lon, { maxTau: S.risk.horizon, mean: wl.ensemble_mean });
        var q = T().percentiles(pp.arrival34, [0.1, 0.5, 0.9]);
        var init = wl.init_time;
        var html = '<div class="rt-dm-readout-h">'
            + '<span>' + B.fmtLatLon(p.lat, p.lon) + '</span>'
            + '<span class="rt-dm-readout-sub">within ' + S.risk.horizon + ' h · ' + pp.n + ' members</span>'
            + '<button type="button" class="rt-dm-x" title="Clear point" onclick="window.RTDM.clearPoint()">×</button></div>';
        html += '<div class="rt-dm-tiles rt-dm-tiles-3">'
            + tile('≥34 kt', pct(pp.p34), 'tropical storm', '#34d399')
            + tile('≥50 kt', pct(pp.p50), '', '#fbbf24')
            + tile('≥64 kt', pct(pp.p64), 'hurricane', '#ef4444')
            + '</div>';
        if (pp.arrival34.length) {
            html += '<div class="rt-dm-sub-h"><span>TS-wind arrival</span>'
                + '<span class="rt-dm-readout-sub">median ' + fmtTauDate(init, q[1]) + ' (+' + q[1] + ' h) · 80% of members ' + '+' + q[0] + '–' + q[2] + ' h</span>'
                + exportBtn('rt-dm-arrival-chart', 'TS-wind arrival time') + '</div>'
                + '<div id="rt-dm-arrival-chart" class="rt-dm-chart" style="height:120px;"></div>';
        } else {
            html += '<div class="rt-dm-hint">No member brings tropical-storm-force wind to this point within ' + S.risk.horizon + ' h.</div>';
        }
        if (pp.nearest) {
            html += '<div class="rt-dm-readout-sub" style="margin-top:4px;">Closest approach of the ensemble-mean track: '
                + Math.round(pp.nearest.km) + ' km at +' + pp.nearest.tau + ' h (' + fmtTauDate(init, pp.nearest.tau) + ')</div>';
        }
        el.innerHTML = html;
        if (pp.arrival34.length) B.whenPlotly(function () { drawArrivalChart(pp, init); });
    }
    function clearPoint() {
        S.risk.point = null;
        if (S.risk.marker) { try { B.map().removeLayer(S.risk.marker); } catch (e) {} S.risk.marker = null; }
        renderPointReadout();
    }
    function drawArrivalChart(pp, init) {
        var el = $('rt-dm-arrival-chart'); if (!el) return;
        var bin = 12, counts = {}, maxT = 0;
        for (var i = 0; i < pp.arrival34.length; i++) {
            var b = Math.floor(pp.arrival34[i] / bin) * bin; counts[b] = (counts[b] || 0) + 1; if (b > maxT) maxT = b;
        }
        var xs = [], ys = [], txt = [];
        for (var t = 0; t <= maxT; t += bin) {
            xs.push('+' + t + 'h'); ys.push(100 * (counts[t] || 0) / pp.n);
            txt.push(fmtTauDate(init, t) + ' – ' + fmtTauDate(init, t + bin) + '<br>' + (counts[t] || 0) + ' of ' + pp.n + ' members');
        }
        var layout = B.chartLayout({ margin: { l: 34, r: 8, t: 6, b: 30 }, fontSize: 9,
            yaxis: { title: { text: '% members', font: { size: 9 } }, rangemode: 'tozero', ticksuffix: '%' },
            xaxis: { tickfont: { size: 8 }, tickangle: 0, nticks: 8 } });
        Plotly.react(el, [{ type: 'bar', x: xs, y: ys, text: txt, hovertemplate: '%{text}<extra></extra>',
                            marker: { color: '#34d399', opacity: 0.9 } }], layout,
                     { displayModeBar: false, responsive: true });
    }

    // ═════════════════════════════════════════════════════════════════════
    //  LANDFALL tab
    // ═════════════════════════════════════════════════════════════════════
    function ensureLandMask() {
        if (S.landMask) return Promise.resolve(S.landMask);
        if (S._lmProm) return S._lmProm;
        S._lmProm = T().loadLandMask('assets/landmask_0p1.png?v=1').then(function (fn) { S.landMask = fn; return fn; });
        return S._lmProm;
    }
    function renderLandfall() {
        var el = $('rt-dm-tab-landfall'); if (!el) return;
        var wl = B.wl(); if (!wl) return;
        if (!S.landMask) {
            el.innerHTML = '<div class="rt-dm-hint">Loading coastline mask…</div>';
            ensureLandMask().then(function () { if (S.tab === 'landfall') renderLandfall(); })
                .catch(function () { el.innerHTML = '<div class="rt-dm-hint">Land mask unavailable.</div>'; });
            return;
        }
        if (!S.lf.data) S.lf.data = T().landfall(wl.members, S.landMask, { maxTau: 360, stepH: 1, horizons: [48, 72, 120, 168] });
        var lf = S.lf.data, init = wl.init_time;
        var html = '';
        if (!lf.events.length) {
            html += '<div class="rt-dm-tiles">' + tile('Landfall chance', '0%', 'no member brings the center over land within 15 days', '#34d399') + '</div>';
        } else {
            var q = T().percentiles(lf.taus, [0.1, 0.5, 0.9]);
            var wq = T().percentiles(lf.winds, [0.5]);
            var medCat = T().catOf(wq[0]);
            html += '<div class="rt-dm-tiles rt-dm-tiles-3">'
                + tile('Landfall chance', pct(lf.pAny), 'within 15 d · ' + pct(lf.pBy['120']) + ' by +120 h', lf.pAny >= 0.5 ? '#ef4444' : lf.pAny >= 0.2 ? '#fb923c' : '#fbbf24')
                + tile('Median timing', '+' + q[1] + ' h', fmtTauDate(init, q[1]) + ' · 80% in +' + q[0] + '–' + q[2] + ' h')
                + tile('Intensity at landfall', catLabel(medCat), 'median ' + Math.round(wq[0]) + ' kt among landfalling members', catColor(medCat))
                + '</div>';
            html += '<div class="rt-dm-sub-h"><span>When members make landfall</span>' + exportBtn('rt-dm-lf-chart', 'Landfall timing') + '</div>'
                + '<div id="rt-dm-lf-chart" class="rt-dm-chart" style="height:150px;"></div>';
        }
        html += '<div class="rt-dm-sub-h"><span>Members still tracking the system</span>' + exportBtn('rt-dm-surv-chart', 'Ensemble survival') + '</div>'
            + '<div id="rt-dm-surv-chart" class="rt-dm-chart" style="height:110px;"></div>';
        if (lf.events.length) {
            html += '<div class="rt-dm-row"><button type="button" class="rt-dm-chip' + (S.lf.showPts ? ' active' : '') + '" onclick="window.RTDM.toggleLfPoints()">Landfall points on map</button>'
                + '<span class="rt-dm-readout-sub">' + lf.events.length + ' of ' + lf.n + ' members · colored by intensity at landfall</span></div>';
        }
        html += note('"Landfall" = the member\'s center first crossing from sea to land on a 0.1° coastline mask, so small islands and '
            + 'narrow peninsulas can be missed and the timing is ±1 h. Experimental research guidance from ' + esc(modelTag())
            + ' — <b>not a forecast</b>. For official track forecasts, watches and warnings see '
            + '<a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener">NHC</a> / CPHC / JTWC or your national weather service.');
        el.innerHTML = html;
        B.whenPlotly(function () { drawLfChart(lf, init); drawSurvivalChart(wl); });
        if (S.lf.showPts && lf.events.length) drawLfPoints();
    }
    function drawLfChart(lf, init) {
        var el = $('rt-dm-lf-chart'); if (!el) return;
        var bin = 12, maxT = 0, cats = ['TD', 'TS', 'C1', 'C2', 'C3', 'C4', 'C5'];
        var byBin = {};
        for (var i = 0; i < lf.events.length; i++) {
            var e = lf.events[i], b = Math.floor(e.tau / bin) * bin; if (b > maxT) maxT = b;
            var c = T().catOf(e.wind); byBin[b] = byBin[b] || {}; byBin[b][c] = (byBin[b][c] || 0) + 1;
        }
        var xs = []; for (var t = 0; t <= maxT; t += bin) xs.push(t);
        var traces = [];
        for (var ci = 0; ci < cats.length; ci++) {
            var ys = xs.map(function (t) { return 100 * ((byBin[t] && byBin[t][cats[ci]]) || 0) / lf.n; });
            if (!ys.some(function (v) { return v > 0; })) continue;
            traces.push({ type: 'bar', name: catLabel(cats[ci]), x: xs.map(function (t) { return '+' + t + 'h'; }), y: ys,
                          marker: { color: catColor(cats[ci]) },
                          text: xs.map(function (t) { return fmtTauDate(init, t) + ' – ' + fmtTauDate(init, t + bin); }),
                          hovertemplate: '%{text}<br>' + catLabel(cats[ci]) + ': %{y:.1f}% of members<extra></extra>' });
        }
        var layout = B.chartLayout({ margin: { l: 34, r: 8, t: 6, b: 30 }, fontSize: 9, legend: true,
            yaxis: { title: { text: '% members', font: { size: 9 } }, rangemode: 'tozero', ticksuffix: '%' },
            xaxis: { tickfont: { size: 8 }, nticks: 8 }, extra: { barmode: 'stack' } });
        layout.legend.font.size = 8;
        Plotly.react(el, traces, layout, { displayModeBar: false, responsive: true });
    }
    function drawSurvivalChart(wl) {
        var el = $('rt-dm-surv-chart'); if (!el) return;
        var sv = T().survival(wl.members, wl.lead_times_h || []);
        var xs = sv.taus.map(function (t) { return '+' + t + 'h'; });
        var layout = B.chartLayout({ margin: { l: 34, r: 8, t: 6, b: 26 }, fontSize: 9,
            yaxis: { range: [0, 105], ticksuffix: '%', title: { text: '% members', font: { size: 9 } } },
            xaxis: { tickfont: { size: 8 }, nticks: 8 } });
        Plotly.react(el, [{ type: 'scatter', mode: 'lines', x: xs, y: sv.frac.map(function (f) { return 100 * f; }),
                            fill: 'tozeroy', fillcolor: 'rgba(0,229,255,0.12)', line: { color: CYAN, width: 2 },
                            hovertemplate: '%{x}: %{y:.0f}% of members still carry the system<extra></extra>' }],
                     layout, { displayModeBar: false, responsive: true });
    }
    function toggleLfPoints() { S.lf.showPts = !S.lf.showPts; renderLandfall(); if (!S.lf.showPts) clearLfLayers(); }
    function clearLfLayers() { removeLayers(S.lf.layers); }
    function drawLfPoints() {
        clearLfLayers();
        var map = B.map(), lf = S.lf.data, wl = B.wl(); if (!map || !lf) return;
        for (var i = 0; i < lf.events.length; i++) {
            var e = lf.events[i], c = T().catOf(e.wind);
            var m = L.circleMarker([e.lat, e.lon], { radius: 4, color: '#fff', weight: 1, fillColor: catColor(c), fillOpacity: 0.95, pane: 'dmProbPane' }).addTo(map);
            m.bindTooltip('<b>Member ' + e.member + '</b> landfall +' + e.tau + ' h<br>' + fmtTauDate(wl.init_time, e.tau)
                + (e.wind != null ? ' · ' + e.wind + ' kt (' + catLabel(c) + ')' : ''), { direction: 'top' });
            S.lf.layers.push(m);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    //  COMPARE tab — FNV3 vs WN3, and DeepMind vs the official forecast
    // ═════════════════════════════════════════════════════════════════════
    function otherModelKey() { return B.model() === 'wnv3' ? 'fnv3' : 'wnv3'; }
    function modelLabel(k) { return k === 'wnv3' ? 'WeatherNext 3' : 'FNV3'; }
    function renderCompare() {
        var el = $('rt-dm-tab-compare'); if (!el) return;
        var wl = B.wl(); if (!wl) return;
        var me = B.model(), other = otherModelKey();
        var html = '';
        // ── A. model vs model ───────────────────────────────────────────
        html += '<div class="rt-dm-sub-h"><span>' + modelLabel(me) + ' vs ' + modelLabel(other) + '</span>'
            + '<button type="button" class="rt-dm-chip' + (S.cmp.overlay ? ' active' : '') + '" onclick="window.RTDM.toggleCmpOverlay()"'
            + (S.cmp.other ? '' : ' disabled') + '>Overlay ' + modelLabel(other) + ' on map</button></div>';
        if (!S.cmp.other) {
            html += '<div class="rt-dm-hint">' + (S.cmp.loading ? 'Loading ' + modelLabel(other) + '…'
                : (S.cmp.otherMissing ? modelLabel(other) + ' has no run for this system yet.'
                   : '<button type="button" class="rt-dm-chip" onclick="window.RTDM.loadOther()">Load ' + modelLabel(other) + ' run</button>')) + '</div>';
        } else {
            var cmp = T().compareModels(wl, S.cmp.other, [24, 48, 72, 96, 120, 144]);
            var aLbl = modelLabel(me), bLbl = modelLabel(other);
            html += '<div class="rt-dm-readout-sub">' + aLbl + ' init ' + fmtInit(wl.init_time) + ' · ' + bLbl + ' init ' + fmtInit(S.cmp.other.init_time)
                + (cmp.offsetA || cmp.offsetB ? ' · aligned by valid time' : '') + '</div>';
            if (cmp.summary) {
                var sm = cmp.summary;
                var dvTxt = sm.maxDv == null ? '' : (Math.abs(sm.maxDv) < 3 ? 'intensities agree within 3 kt'
                    : bLbl + ' is ' + Math.abs(Math.round(sm.maxDv)) + ' kt ' + (sm.maxDv > 0 ? 'stronger' : 'weaker') + ' at +' + sm.maxDvTau + ' h');
                html += '<div class="rt-dm-callout">Tracks separate most at <b>+' + sm.maxSepTau + ' h</b> (' + Math.round(sm.maxSepKm) + ' km); ' + dvTxt + '.</div>';
            }
            html += '<div class="rt-dm-table-wrap"><table class="rt-dm-table"><thead><tr><th>Lead</th><th>Δ track</th>'
                + '<th style="color:' + CYAN + ';">' + aLbl + '</th><th style="color:' + OTHER + ';">' + bLbl + '</th>'
                + '<th>Spread</th><th>P(hurricane)</th></tr></thead><tbody>';
            for (var i = 0; i < cmp.rows.length; i++) {
                var r = cmp.rows[i];
                html += '<tr><td>+' + r.tau + ' h</td><td>' + Math.round(r.sepKm) + ' km ' + cardinal(r.dirDeg) + '</td>'
                    + '<td>' + (r.vA != null ? Math.round(r.vA) + ' kt' : '—') + '</td><td>' + (r.vB != null ? Math.round(r.vB) + ' kt' : '—') + '</td>'
                    + '<td>' + Math.round(r.spreadA) + ' / ' + Math.round(r.spreadB) + ' km</td>'
                    + '<td>' + pct(r.p64A) + ' / ' + pct(r.p64B) + '</td></tr>';
            }
            html += '</tbody></table></div>';
            html += '<div class="rt-dm-readout-sub">Δ track = distance from the ' + aLbl + ' mean to the ' + bLbl + ' mean (direction toward ' + bLbl + '). Spread = mean member distance from each ensemble\'s own mean.</div>';
        }
        // ── B. vs official ──────────────────────────────────────────────
        var fc = officialTrack();
        html += '<div class="rt-dm-sub-h" style="margin-top:12px;"><span>' + modelTag() + ' vs ' + (fc ? esc(fc.name || fc.tech) : 'official forecast') + '</span>'
            + (fc ? exportBtn('rt-dm-ofcl-chart', 'DeepMind vs official intensity') : '') + '</div>';
        if (!fc) {
            html += '<div class="rt-dm-hint">' + (B.adeck() ? 'No official (OFCL/JTWC) forecast in the latest a-deck cycle.' : 'Official forecast not loaded yet — open the Models section first.') + '</div>';
        } else {
            var vf = T().vsForecast(wl, fc.track, { fcInit: fc.init });
            html += '<div class="rt-dm-readout-sub">' + esc(fc.name || fc.tech) + ' init ' + fmtInit(fc.init) + ' · ' + modelTag() + ' init ' + fmtInit(wl.init_time) + ' · aligned by valid time</div>';
            html += '<div id="rt-dm-ofcl-chart" class="rt-dm-chart" style="height:190px;"></div>';
            if (vf.rows.length) {
                var mx = vf.rows.reduce(function (m, r) { return r.sepKm > m.sepKm ? r : m; }, vf.rows[0]);
                var r72 = vf.rows.filter(function (r) { return r.tau === 72; })[0] || vf.rows[Math.min(vf.rows.length - 1, 3)];
                html += '<div class="rt-dm-tiles rt-dm-tiles-3">'
                    + tile('Track offset at +' + r72.tau + ' h', Math.round(r72.sepKm) + ' km', 'ensemble mean ' + cardinal(r72.dirDeg) + ' of official')
                    + tile('Largest offset', Math.round(mx.sepKm) + ' km', 'at +' + mx.tau + ' h, ' + cardinal(mx.dirDeg) + ' of official')
                    + tile('Members right of track', pct(r72.fracRight), 'at +' + r72.tau + ' h, looking along the official motion')
                    + '</div>';
            }
        }
        html += note('<b>The official forecast is the authoritative guidance.</b> This panel shows how experimental research ensembles from Google DeepMind compare to it; '
            + 'differences are not corrections and must not be read as contradicting NHC / CPHC / JTWC. Refer to '
            + '<a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener">NHC</a> or your national weather service for forecasts, watches and warnings.');
        el.innerHTML = html;
        if (fc) B.whenPlotly(function () { drawOfclChart(wl, fc); });
        if (S.cmp.overlay && S.cmp.other) drawCmpOverlay();
    }
    // Latest a-deck cycle's official track (OFCL for NHC basins, JTWC elsewhere).
    function officialTrack() {
        var ad = B.adeck(); if (!ad || !ad.cycles || !ad.init_times || !ad.init_times.length) return null;
        for (var i = ad.init_times.length - 1; i >= 0 && i >= ad.init_times.length - 3; i--) {
            var init = ad.init_times[i], cyc = ad.cycles[init] || {};
            var techs = ['OFCL', 'JTWC'];
            for (var t = 0; t < techs.length; t++) {
                var tr = cyc[techs[t]];
                if (tr && tr.points && tr.points.some(function (p) { return p.tau > 0 && p.lat != null; })) {
                    var cons = cyc.TVCN || cyc.TVCA || cyc.IVCN || null;
                    return { track: tr, init: init, tech: techs[t], name: tr.name || techs[t], consensus: cons };
                }
            }
        }
        return null;
    }
    function drawOfclChart(wl, fc) {
        var el = $('rt-dm-ofcl-chart'); if (!el) return;
        var off = T().initOffsetH(wl.init_time, fc.init);   // + when official is later
        // Ensemble percentiles by official lead (valid-time aligned).
        var taus = (wl.lead_times_h || []).filter(function (t) { return t - off >= 0 && t - off <= 168; });
        var xs = [], p10 = [], p90 = [], p25 = [], p75 = [], mean = [];
        for (var i = 0; i < taus.length; i++) {
            var winds = [], keys = Object.keys(wl.members);
            for (var m = 0; m < keys.length; m++) {
                var pts = wl.members[keys[m]].points || [];
                for (var j = 0; j < pts.length; j++) if (pts[j].tau === taus[i] && pts[j].wind != null) { winds.push(pts[j].wind); break; }
            }
            if (winds.length < 3) continue;
            var q = T().percentiles(winds, [0.1, 0.25, 0.5, 0.75, 0.9]);
            var lead = taus[i] - off;
            xs.push(lead); p10.push(q[0]); p25.push(q[1]); p75.push(q[3]); p90.push(q[4]);
            var mm = winds.reduce(function (a, b) { return a + b; }, 0) / winds.length; mean.push(mm);
        }
        var seen = {}, fx = [], fy = [];
        (fc.track.points || []).forEach(function (p) { if (p.wind != null && !seen[p.tau] && p.tau <= 168) { seen[p.tau] = 1; fx.push(p.tau); fy.push(p.wind); } });
        var traces = [
            { type: 'scatter', x: xs, y: p10, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
            { type: 'scatter', x: xs, y: p90, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(0,229,255,0.10)', name: 'P10–P90', hoverinfo: 'skip' },
            { type: 'scatter', x: xs, y: p25, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
            { type: 'scatter', x: xs, y: p75, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(0,229,255,0.22)', name: 'P25–P75', hoverinfo: 'skip' },
            { type: 'scatter', x: xs, y: mean, mode: 'lines', line: { color: CYAN, width: 2 }, name: modelTag() + ' mean', hovertemplate: '+%{x}h: %{y:.0f} kt<extra>' + esc(modelTag()) + ' mean</extra>' },
            { type: 'scatter', x: fx, y: fy, mode: 'lines+markers', line: { color: OFCL_RED, width: 2.5 }, marker: { size: 5, color: OFCL_RED }, name: fc.name || fc.tech, hovertemplate: '+%{x}h: %{y:.0f} kt<extra>' + esc(fc.name || fc.tech) + '</extra>' },
        ];
        if (fc.consensus && fc.consensus.points) {
            var s2 = {}, cx = [], cy = [];
            fc.consensus.points.forEach(function (p) { if (p.wind != null && !s2[p.tau] && p.tau <= 168) { s2[p.tau] = 1; cx.push(p.tau); cy.push(p.wind); } });
            if (cx.length) traces.push({ type: 'scatter', x: cx, y: cy, mode: 'lines', line: { color: '#94a3b8', width: 1.5, dash: 'dot' }, name: fc.consensus.tech || 'consensus', hovertemplate: '+%{x}h: %{y:.0f} kt<extra>' + esc(fc.consensus.tech || 'consensus') + '</extra>' });
        }
        var layout = B.chartLayout({ margin: { l: 36, r: 8, t: 6, b: 30 }, fontSize: 9, legend: true,
            yaxis: { title: { text: 'Vmax (kt)', font: { size: 9 } }, rangemode: 'tozero' },
            xaxis: { title: { text: 'Lead from ' + (fc.tech) + ' init (h)', font: { size: 9 } }, tickfont: { size: 8 }, dtick: 24 } });
        layout.legend.font.size = 8; layout.legend.x = 0.985; layout.legend.y = 0.98;
        // Saffir–Simpson reference lines.
        layout.shapes = [64, 96, 113].map(function (k) { return { type: 'line', xref: 'paper', x0: 0, x1: 1, y0: k, y1: k, line: { color: B.refLineColor(), width: 1, dash: 'dot' } }; });
        Plotly.react(el, traces, layout, { displayModeBar: false, responsive: true });
    }
    function loadOther() {
        if (S.cmp.loading) return;
        var other = otherModelKey(); S.cmp.loading = true; S.cmp.otherMissing = false; renderCompare();
        B.fetchWeatherlab(other).then(function (json) {
            S.cmp.loading = false; S.cmp.other = json; S.cmp.otherModel = other; S.cmp.overlay = true; renderCompare();
            B.ga('rt_dm_compare_load', { other: other });
        }).catch(function () { S.cmp.loading = false; S.cmp.otherMissing = true; renderCompare(); });
    }
    function toggleCmpOverlay() { S.cmp.overlay = !S.cmp.overlay; if (!S.cmp.overlay) clearCmpLayers(); renderCompare(); }
    function clearCmpLayers() { removeLayers(S.cmp.layers); }
    function drawCmpOverlay() {
        clearCmpLayers();
        var map = B.map(), o = S.cmp.other; if (!map || !o) return;
        var lbl = modelLabel(S.cmp.otherModel);
        var mean = o.ensemble_mean && o.ensemble_mean.points || [];
        // Thin member spaghetti of the other model in its own color, then its mean.
        var keys = Object.keys(o.members || {});
        for (var k = 0; k < keys.length; k++) {
            var pts = (o.members[keys[k]].points || []).filter(function (p) { return p.lat != null; });
            var ll = pts.map(function (p) { return [p.lat, p.lon]; });
            var segs = B.splitAtAntimeridian(ll);
            for (var s = 0; s < segs.length; s++) {
                if (segs[s].length < 2) continue;
                S.cmp.layers.push(L.polyline(segs[s], { color: OTHER, weight: 0.8, opacity: 0.22, interactive: false, pane: 'dmProbPane' }).addTo(map));
            }
        }
        var mll = mean.filter(function (p) { return p.lat != null; }).map(function (p) { return [p.lat, p.lon]; });
        var msegs = B.splitAtAntimeridian(mll);
        for (var i = 0; i < msegs.length; i++) {
            if (msegs[i].length < 2) continue;
            S.cmp.layers.push(L.polyline(msegs[i], { color: OTHER, weight: 3, opacity: 0.95, dashArray: '8,5', interactive: false, pane: 'dmProbPane' }).addTo(map));
        }
        for (var j = 0; j < mean.length; j++) {
            var p = mean[j]; if (p.lat == null || (p.tau > 0 && p.tau % 24 !== 0)) continue;
            var m = L.circleMarker([p.lat, p.lon], { radius: 4, color: '#fff', weight: 1.2, fillColor: OTHER, fillOpacity: 1, pane: 'dmProbPane' }).addTo(map);
            m.bindTooltip('<b>' + lbl + ' mean</b> +' + p.tau + ' h · ' + fmtTauDate(o.init_time, p.tau) + '<br>' + B.fmtLatLon(p.lat, p.lon)
                + (p.wind != null ? '<br>' + Math.round(p.wind) + ' kt' : ''), { direction: 'top', offset: [0, -6] });
            S.cmp.layers.push(m);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Export — any of this module's Plotly charts, in the viewing theme
    // ═════════════════════════════════════════════════════════════════════
    function exportChart(elId, label) {
        var el = $(elId); if (!el || !el.data || typeof Plotly === 'undefined') return;
        var isDark = B.isDark();
        var wl = B.wl() || {};
        var data = JSON.parse(JSON.stringify(el.data)), layout = JSON.parse(JSON.stringify(el.layout));
        var storm = B.stormName() || '', sid = B.stormId() || '';
        var title = label + ' — ' + storm + ' (' + sid + ') — ' + modelTag() + ' init ' + fmtInit(wl.init_time);
        layout.title = { text: title, font: { size: 15, color: isDark ? '#e2e8f0' : '#1e293b' }, x: 0.5, xanchor: 'center', y: 0.97 };
        layout.paper_bgcolor = layout.plot_bgcolor = isDark ? '#0f172a' : '#ffffff';
        layout.width = 900; layout.height = 520;
        layout.margin = { l: 64, r: 30, t: 80, b: 90 };
        layout.font = Object.assign({}, layout.font, { size: 13 });
        ['xaxis', 'yaxis'].forEach(function (ax) { if (layout[ax]) { layout[ax].tickfont = { size: 12 }; if (layout[ax].title) layout[ax].title.font = { size: 13 }; } });
        if (layout.legend) layout.legend.font = { size: 11 };
        layout.annotations = (layout.annotations || []).concat([{
            text: 'Experimental research guidance (Google DeepMind ensemble via TC-ATLAS) — not an official forecast. See NHC / JTWC or your national weather service.',
            xref: 'paper', yref: 'paper', x: 0, y: -0.17, xanchor: 'left', yanchor: 'top', showarrow: false,
            font: { size: 10, color: isDark ? '#94a3b8' : '#64748b' } },
            { text: 'tcatlas.org', xref: 'paper', yref: 'paper', x: 1, y: -0.17, xanchor: 'right', yanchor: 'top', showarrow: false,
              font: { size: 10, color: isDark ? '#475569' : '#94a3b8' } }]);
        var tmp = document.createElement('div'); tmp.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
        document.body.appendChild(tmp);
        Plotly.newPlot(tmp, data, layout, { displayModeBar: false })
            .then(function () { return Plotly.toImage(tmp, { format: 'png', width: 900, height: 520, scale: 2 }); })
            .then(function (url) {
                var fn = 'TC-ATLAS_' + sid + '_' + label.replace(/[^a-z0-9]+/gi, '_') + '_' + (B.model() === 'wnv3' ? 'WN3' : 'FNV3') + '_init' + (wl.init_time || '') + '_' + (isDark ? 'dark' : 'light') + '.png';
                B.saveImageBlob(B.dataURLToBlob(url), fn);
            })
            .catch(function (e) { console.warn('[RTDM] export failed', e); })
            .then(function () { try { Plotly.purge(tmp); } catch (e) {} if (tmp.parentNode) tmp.parentNode.removeChild(tmp); });
    }

    window.RTDM = {
        attach: function (bridge) { B = bridge; },
        onWeatherlab: onWeatherlab, onEnsemble: onEnsemble, onPanels: onPanels, onStormClose: onStormClose,
        setTab: setTab, setRisk: setRisk, setHorizon: setHorizon, toggleEllipses: toggleEllipses, clearPoint: clearPoint,
        toggleLfPoints: toggleLfPoints, loadOther: loadOther, toggleCmpOverlay: toggleCmpOverlay,
        exportChart: exportChart,
        _state: S,
    };
})();
