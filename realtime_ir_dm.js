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

    // Official track on MAPS: a cased black-and-white dashed line (railroad
    // style) — reads over the yellow→purple field, the cyan swath, the orange
    // mean, and bare ocean in both themes. Charts keep the plain red line.
    function ofclCasing() { return B.isDark() ? '#f8fafc' : '#0f172a'; }
    function ofclInner() { return B.isDark() ? '#0f172a' : '#ffffff'; }
    function ofclStyles() {
        return {
            casing: { color: ofclCasing(), weight: 5, opacity: 0.9, interactive: false, pane: 'dmProbPane' },
            inner:  { color: ofclInner(), weight: 2.4, opacity: 1, dashArray: '8,7', interactive: false, pane: 'dmProbPane' },
            marker: { radius: 4.5, color: ofclCasing(), weight: 1.6, fillColor: ofclInner(), fillOpacity: 1, pane: 'dmProbPane' },
        };
    }
    function ofclSwatch() { return '<span style="color:' + (B.isDark() ? '#f8fafc' : '#0f172a') + ';">━ ━</span>'; }
    function ofclLabel(fc) { return (fc.name || fc.tech) + ' forecast · issued ' + fmtInit(fc.init) + ' UTC'; }
    // Official points deduped by tau (a-deck repeats rows per radius line).
    function ofclPoints(fc) {
        var seen = {}, out = [];
        (fc.track.points || []).forEach(function (p) { if (p.lat != null && !seen[p.tau]) { seen[p.tau] = 1; out.push(p); } });
        return out.sort(function (a, b) { return a.tau - b.tau; });
    }
    var S = {
        visible: false,
        tab: 'intensity',
        stormId: null,
        risk: { thresh: 0, horizon: 120, layers: [], ellipses: false, ellipseLayers: [],
                grids: {}, point: null, marker: null, clickBound: false, nhc: true, nhcLayers: [] },
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
    // On-map liability badge: shown on any map while an ensemble overlay is
    // drawn, so a screenshot of the map alone still says what it is.
    var BADGE_TEXT = 'DeepMind ensemble \u00b7 experimental research guidance \u00b7 NOT an official forecast or NHC cone';
    function showBadge(map, key, text) {
        if (!map || !map.getContainer) return;
        var host = map.getContainer(); if (!host) return;
        var id = 'rt-dm-badge-' + key, el = document.getElementById(id);
        if (!el) { el = document.createElement('div'); el.id = id; el.className = 'rt-dm-map-badge'; host.appendChild(el); }
        el.textContent = text || BADGE_TEXT;
    }
    function hideBadge(key) { var el = document.getElementById('rt-dm-badge-' + key); if (el && el.parentNode) el.parentNode.removeChild(el); }
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
                   grids: {}, point: null, marker: null, clickBound: false, nhc: true, nhcLayers: [] };
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
            + chip('Ensemble ellipses', r.ellipses, 'window.RTDM.toggleEllipses()',
                   '50% and 90% ellipses of member positions every 24 h — an ensemble statistic, not the NHC forecast cone')
            + '</div>';
        var fcCard = officialTrack();
        if (fcCard) {
            html += '<div class="rt-dm-row"><span class="rt-dm-row-l">Reference</span>'
                + chip(ofclSwatch() + ' ' + esc(fcCard.name || fcCard.tech), r.nhc, 'window.RTDM.toggleNhc()',
                       'Show the official forecast track (red dashed) as the authoritative reference')
                + '<span class="rt-dm-readout-sub">' + esc(ofclLabel(fcCard)) + ' · the authoritative forecast</span></div>';
        }
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
        if (r.nhc) drawCardNhc();
        bindClick();
    }
    function setRisk(th) {
        S.risk.thresh = th; renderRisk();
        if (B) B.ga('rt_dm_risk_layer', { thresh: th, horizon: S.risk.horizon });
    }
    function setHorizon(h) { S.risk.horizon = h; S.risk.grids = {}; renderRisk(); }
    function toggleEllipses() { S.risk.ellipses = !S.risk.ellipses; renderRisk(); }
    function toggleNhc() { S.risk.nhc = !S.risk.nhc; renderRisk(); }
    function drawCardNhc() {
        removeLayers(S.risk.nhcLayers);
        var map = B.map(), fc = officialTrack(); if (!map || !fc) return;
        var pts = ofclPoints(fc), st = ofclStyles();
        var segs = B.splitAtAntimeridian(pts.map(function (p) { return [p.lat, p.lon]; }));
        for (var i = 0; i < segs.length; i++) if (segs[i].length >= 2) S.risk.nhcLayers.push(L.polyline(segs[i], st.casing).addTo(map));
        for (var i2 = 0; i2 < segs.length; i2++) if (segs[i2].length >= 2) S.risk.nhcLayers.push(L.polyline(segs[i2], st.inner).addTo(map));
        for (var j = 0; j < pts.length; j++) {
            var p = pts[j]; if (p.tau % 24 !== 0) continue;
            var m = L.circleMarker([p.lat, p.lon], st.marker).addTo(map);
            m.bindTooltip('<b>' + esc(fc.name || fc.tech) + '</b> +' + p.tau + ' h · ' + fmtTauDate(fc.init, p.tau) + '<br>' + B.fmtLatLon(p.lat, p.lon)
                + (p.wind != null ? '<br>' + p.wind + ' kt' : '') + '<br><i>official forecast — authoritative</i>', { direction: 'top', offset: [0, -6] });
            S.risk.nhcLayers.push(m);
        }
    }

    function riskGrid(th) {
        var key = th + '@' + S.risk.horizon;
        if (!S.risk.grids[key]) {
            var wl = B.wl(); if (!wl) return null;
            S.risk.grids[key] = T().windProbGrid(wl.members, { thresh: th, maxTau: S.risk.horizon, cellDeg: 0.2, stepH: 2 }) || false;
        }
        return S.risk.grids[key] || null;
    }
    function clearRiskLayers() {
        hideBadge('card');
        removeLayers(S.risk.layers); removeLayers(S.risk.ellipseLayers); removeLayers(S.risk.nhcLayers);
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
        showBadge(map, 'card');
    }
    function drawEllipses() {
        removeLayers(S.risk.ellipseLayers);
        var map = B.map(), wl = B.wl(); if (!map || !wl) return;
        var taus = [];
        for (var t = 24; t <= S.risk.horizon; t += 24) taus.push(t);
        var ells = T().trackEllipses(wl.members, taus);
        showBadge(map, 'card');
        for (var i = 0; i < ells.length; i++) {
            var e = ells[i];
            var p90 = L.polygon(e.poly90, { color: CYAN, weight: 1, opacity: 0.55, dashArray: '4,4',
                                            fillColor: CYAN, fillOpacity: 0.06, interactive: false, pane: 'dmProbPane' }).addTo(map);
            var p50 = L.polygon(e.poly50, { color: CYAN, weight: 1.2, opacity: 0.8,
                                            fillColor: CYAN, fillOpacity: 0.14, interactive: true, pane: 'dmProbPane' }).addTo(map);
            p50.bindTooltip('<b>+' + e.tau + ' h</b> · ' + e.n + ' members<br>50% / 90% ensemble position ellipses<br>'
                + 'σ ' + Math.round(e.sigmaKm[0]) + ' × ' + Math.round(e.sigmaKm[1]) + ' km<br><i>not the NHC cone</i>', { direction: 'top' });
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
            html += '<div class="rt-dm-callout" style="border-color:rgba(52,211,153,0.35); background:rgba(52,211,153,0.08);"><b style="color:#34d399;">Landfall chance 0%</b> — no member brings the center over land within 15 days.</div>';
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
    function officialTrack() { return officialTrackFrom(B.adeck()); }
    function officialTrackFrom(ad) {
        if (!ad || !ad.cycles || !ad.init_times || !ad.init_times.length) return null;
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

    // ═════════════════════════════════════════════════════════════════════
    //  GLOBAL MAP — basin-wide wind-risk layer, point probe, popup lines
    // ═════════════════════════════════════════════════════════════════════
    var G = { thresh: 0, horizon: 120, layers: [], grids: {}, clickBound: false, probe: null, pending: false };
    function gMap() { return B && B.globalMap && B.globalMap(); }
    function gData() { return B && B.globalWL && B.globalWL(); }
    function globalSetRisk(th) {
        G.thresh = th;
        if (th && !gData()) { G.pending = true; B.loadGlobalWL(); }
        drawGlobalRisk();
        if (B) B.ga('rt_dm_global_risk', { thresh: th, horizon: G.horizon });
    }
    function globalSetHorizon(h) { G.horizon = h; G.grids = {}; drawGlobalRisk(); }
    function onGlobalData() {
        G.grids = {};
        if (G.pending || G.thresh) { G.pending = false; drawGlobalRisk(); }
    }
    function globalGrid(th) {
        var key = th + '@' + G.horizon;
        if (G.grids[key] === undefined) {
            var d = gData(), grids = [];
            var tracks = d && d.tracks || [];
            for (var i = 0; i < tracks.length; i++) {
                var g = T().windProbGrid(tracks[i].members || {}, { thresh: th, maxTau: G.horizon, cellDeg: 0.2, stepH: 2 });
                if (g) grids.push(g);
            }
            G.grids[key] = T().compositeGrids(grids) || null;
        }
        return G.grids[key];
    }
    function clearGlobalRisk() {
        hideBadge('global');
        removeLayersOn(gMap(), G.layers);
        if (G.probe) { try { gMap().removeLayer(G.probe); } catch (e) {} G.probe = null; }
        if (G.clickBound && gMap()) { try { gMap().off('click', onGlobalClick); } catch (e) {} G.clickBound = false; }
    }
    function removeLayersOn(map, arr) {
        for (var i = 0; i < arr.length; i++) { try { if (map) map.removeLayer(arr[i]); } catch (e) {} }
        arr.length = 0;
    }
    function drawGlobalRisk() {
        var map = gMap(); if (!map) return;
        removeLayersOn(map, G.layers);
        if (!G.thresh) { clearGlobalRisk(); B.refreshLayersCount(); return; }
        if (!gData()) return;   // arrives via onGlobalData
        var g = globalGrid(G.thresh);
        if (g) {
            var parts = T().rasterizeMercator(g, probColor, { pxPerCell: 4 });
            for (var i = 0; i < parts.length; i++) {
                G.layers.push(L.imageOverlay(parts[i].url, parts[i].bounds, { opacity: 0.6, pane: 'dmProbPane', interactive: false }).addTo(map));
            }
        }
        if (!G.clickBound) { map.on('click', onGlobalClick); G.clickBound = true; }
        showBadge(map, 'global');
        B.refreshLayersCount();
    }
    function onGlobalClick(ev) {
        if (!G.thresh) return;
        var ll = ev && ev.latlng; if (!ll) return;
        var lat = ll.lat, lon = ll.lng != null ? ll.lng : ll.lon;
        var d = gData(); if (!d) return;
        var tracks = d.tracks || [], best = null;
        for (var i = 0; i < tracks.length; i++) {
            var pp = T().pointProbabilities(tracks[i].members || {}, lat, lon, { maxTau: G.horizon, mean: tracks[i].ensemble_mean });
            if (!best || pp.p34 > best.pp.p34 || (pp.p34 === best.pp.p34 && pp.p64 > best.pp.p64)) best = { pp: pp, id: tracks[i].track_id };
        }
        var map = gMap();
        if (G.probe) { try { map.removeLayer(G.probe); } catch (e) {} }
        var html;
        if (!best || !best.pp.p34) {
            html = '<div class="rt-dm-probe"><div class="rt-dm-probe-h">' + B.fmtLatLon(lat, lon) + '</div>'
                + 'No ensemble member brings tropical-storm-force wind here within ' + G.horizon + ' h.'
                + '<div class="rt-dm-probe-note">' + esc(modelTag()) + ' · experimental, not a forecast</div></div>';
        } else {
            var pp = best.pp, q = T().percentiles(pp.arrival34, [0.1, 0.5, 0.9]);
            var nm = B.stormName ? (B.stormNameById(best.id) || best.id) : best.id;
            html = '<div class="rt-dm-probe"><div class="rt-dm-probe-h">' + B.fmtLatLon(lat, lon) + ' <span style="opacity:0.7;font-weight:400;">· ' + esc(nm) + '</span></div>'
                + '<div class="rt-dm-probe-row"><span>≥34 kt</span><b style="color:#34d399;">' + pct(pp.p34) + '</b></div>'
                + '<div class="rt-dm-probe-row"><span>≥50 kt</span><b style="color:#fbbf24;">' + pct(pp.p50) + '</b></div>'
                + '<div class="rt-dm-probe-row"><span>≥64 kt</span><b style="color:#ef4444;">' + pct(pp.p64) + '</b></div>'
                + '<div class="rt-dm-probe-row"><span>TS wind arrives</span><b>' + fmtTauDate(d.init_time, q[1]) + '</b></div>'
                + '<div class="rt-dm-probe-note">within ' + G.horizon + ' h · ' + pp.n + ' members · 80% arrive +' + q[0] + '–' + q[2] + ' h<br>'
                + esc(modelTag()) + ' · experimental, not a forecast — see NHC / JTWC</div></div>';
        }
        G.probe = L.circleMarker([lat, lon], { radius: 6, color: '#fff', weight: 2, fillColor: CYAN, fillOpacity: 1, pane: 'dmProbPane' }).addTo(map);
        G.probe.bindPopup(html, { maxWidth: 260 });
        try { G.probe.openPopup(); } catch (e) {}
        B.ga('rt_dm_global_probe', { thresh: G.thresh });
    }
    // Layers-panel chip row HTML (rendered by realtime_ir.js inside its menu).
    function globalRiskRowHtml() {
        function chip(label, on, attr, title) {
            return '<button type="button" class="ir-global-genvariant-chip ir-global-dmrisk-chip" ' + attr
                + (title ? ' title="' + esc(title) + '"' : '')
                + ' style="background:' + (on ? 'rgba(0,229,255,0.28)' : 'transparent') + '; color:' + (on ? '#00e5ff' : 'inherit') + ';">' + label + '</button>';
        }
        var h = '<div class="ir-global-menu-row ir-global-method-row" style="opacity:' + (G.thresh ? 1 : 0.7) + ';">'
            + '<span style="font-size:0.72rem; opacity:0.75; margin-right:8px;" title="Chance of wind at or above the threshold within the window, from every active storm and invest\'s ensemble">Wind risk:</span>'
            + chip('Off', !G.thresh, 'data-dmrisk="0"')
            + chip('≥34 kt', G.thresh === 34, 'data-dmrisk="34"', 'Tropical-storm-force wind chance')
            + chip('≥50 kt', G.thresh === 50, 'data-dmrisk="50"')
            + chip('≥64 kt', G.thresh === 64, 'data-dmrisk="64"', 'Hurricane-force wind chance')
            + '</div>';
        if (G.thresh) {
            h += '<div class="ir-global-menu-row ir-global-method-row">'
                + '<span style="font-size:0.72rem; opacity:0.75; margin-right:8px;">Within:</span>'
                + chip('72 h', G.horizon === 72, 'data-dmhorizon="72"') + chip('120 h', G.horizon === 120, 'data-dmhorizon="120"') + chip('168 h', G.horizon === 168, 'data-dmhorizon="168"')
                + '<span style="font-size:0.62rem; opacity:0.65; margin-left:8px;">click the map for a point readout</span></div>'
                + '<div class="ir-global-menu-row" style="display:block; padding:2px 0 4px;">'
                + '<div class="rt-dm-legend-bar" style="background:' + legendCSS() + '; height:6px; max-width:260px;"></div>'
                + '<div class="rt-dm-legend-ticks" style="max-width:260px;"><span>5%</span><span>20%</span><span>40%</span><span>60%</span><span>80%</span><span>100%</span></div>'
                + '<div style="font-size:0.58rem; opacity:0.65; margin-top:2px;">Experimental research guidance, not a forecast — official wind-speed probabilities: NHC / CPHC / JTWC.</div></div>';
        }
        return h;
    }
    function bindGlobalRiskChips(content) {
        var chips = content.querySelectorAll('.ir-global-dmrisk-chip');
        for (var i = 0; i < chips.length; i++) {
            (function (el) {
                el.addEventListener('click', function (ev) {
                    ev.preventDefault(); ev.stopPropagation();
                    if (el.hasAttribute('data-dmrisk')) globalSetRisk(parseInt(el.getAttribute('data-dmrisk'), 10) || 0);
                    else if (el.hasAttribute('data-dmhorizon')) globalSetHorizon(parseInt(el.getAttribute('data-dmhorizon'), 10) || 120);
                    if (B.rerenderLayersPanel) B.rerenderLayersPanel();
                });
            })(chips[i]);
        }
    }
    // Storm-popup lines: landfall + RI from the storm's own ensemble.
    function fillPopupLines(atcfId, el) {
        if (!el) return;
        var d = gData();
        if (!d) {
            el.innerHTML = '<span class="ir-popup-dm-tag">DeepMind: loading ensemble…</span>';
            if (!G._popupWait) { G._popupWait = true; B.loadGlobalWL(); }
            G._popupPending = { id: atcfId, el: el };
            return;
        }
        var trk = (d.tracks || []).filter(function (t) { return t.track_id === atcfId; })[0];
        if (!trk) { el.innerHTML = '<span class="ir-popup-dm-tag">' + esc(modelTag()) + ': no run for this system yet</span>'; return; }
        var ri = T().riFromMembers(trk.members || {}, { thresh: 30 });
        var i48 = idxAtOrBelow(ri.taus, 48);
        var riTxt = i48 >= 0 ? pct(ri.pBy[i48]) : '—';
        var html = '<span class="ir-popup-dm-tag">' + esc(modelTag()) + ' · ' + (trk.n_members || Object.keys(trk.members || {}).length) + ' members · init ' + fmtInit(d.init_time) + '</span><br>'
            + 'RI (≥30 kt/24 h) by +48 h: <b>' + riTxt + '</b><br>';
        if (S.landMask) {
            var lf = T().landfall(trk.members || {}, S.landMask, { maxTau: 168, stepH: 1, horizons: [120] });
            if (lf.events.length) {
                var q = T().percentiles(lf.taus, [0.5]), wq = T().percentiles(lf.winds, [0.5]);
                html += 'Landfall within 7 d: <b>' + pct(lf.pAny) + '</b> · median ' + fmtTauDate(d.init_time, q[0]) + ' as <b>' + catLabel(T().catOf(wq[0])) + '</b><br>';
            } else html += 'Landfall within 7 d: <b>0%</b><br>';
        } else {
            html += '<span id="ir-popup-dm-lf-' + atcfId + '">Landfall: computing…</span><br>';
            ensureLandMask().then(function () { var e2 = document.getElementById('ir-popup-dm-lf-' + atcfId); if (e2 && e2.closest('.ir-popup-dm')) fillPopupLines(atcfId, e2.closest('.ir-popup-dm')); }).catch(function () {});
        }
        html += '<span class="ir-popup-dm-note">Experimental research guidance, not a forecast — see NHC / JTWC.</span>';
        el.innerHTML = html;
    }
    function onGlobalDataForPopup() {
        if (G._popupPending && document.body.contains(G._popupPending.el)) fillPopupLines(G._popupPending.id, G._popupPending.el);
        G._popupPending = null; G._popupWait = false;
    }

    // ═════════════════════════════════════════════════════════════════════
    //  DEEPMIND MODAL — Wind Risk + Landfall panes on the Plotly geo map
    // ═════════════════════════════════════════════════════════════════════
    var M = { data: null, adeck: null, risk: { thresh: 34, horizon: 120, swath: 90, nhc: true, grids: {}, contours: {}, swaths: {}, probe: null }, lf: null, rendered: {} };
    function onGenesisDetail(d) {
        // d = { memberKeys, members, mean, stats, init, variant, label, alreadyTC, atcf }
        M.data = d; M.adeck = null; M.risk.grids = {}; M.risk.contours = {}; M.risk.swaths = {}; M.risk.probe = null; M.lf = null; M.rendered = {};
        var r = $('rt-genesis-pane-risk'), l = $('rt-genesis-pane-landfall');
        if (r) r.innerHTML = ''; if (l) l.innerHTML = '';
        // Official forecast for designated systems: fetched once, then laid
        // onto the This-run map, the intensity fan, and the Wind Risk map.
        if (d.atcf && B.fetchAdeck) {
            var want = d.atcf;
            B.fetchAdeck(want).then(function (ad) {
                if (!M.data || M.data.atcf !== want) return;
                M.adeck = ad;
                decorateTrackMap('rt-genesis-modal-map'); decorateIntensity('rt-genesis-modal-int');
                if (S_modalPaneVisible('risk')) drawModalRiskMap();
            }).catch(function () {});
        }
    }
    function S_modalPaneVisible(name) { var p = $('rt-genesis-pane-' + name); return !!(p && p.style.display !== 'none'); }
    function onGenesisClose() { M.data = null; M.adeck = null; M.rendered = {}; }
    function modalOfficial() { return M.adeck ? officialTrackFrom(M.adeck) : null; }

    // ── NHC reference on existing charts ───────────────────────────────
    // Remove any trace we added before (idempotent re-decoration).
    function stripOurTraces(el) {
        if (!el || !el.data) return;
        var idx = [];
        for (var i = 0; i < el.data.length; i++) if (el.data[i] && el.data[i]._rtdm) idx.push(i);
        if (idx.length) { try { Plotly.deleteTraces(el, idx); } catch (e) {} }
    }
    // This-run track map (scattergeo, unwrapped-lon frame on el._genesisLonRef).
    function decorateTrackMap(elId) {
        var el = $(elId); if (!el || !el.data || typeof Plotly === 'undefined') return;
        stripOurTraces(el);
        var fc = modalOfficial(); if (!fc) return;
        var ref = el._genesisLonRef != null ? el._genesisLonRef : 0;
        var pts = ofclPoints(fc);
        var lon = [], lat = [], txt = [], sz = [];
        pts.forEach(function (p) { lon.push(T().unwrapLon(p.lon, ref)); lat.push(p.lat); sz.push(p.tau % 24 === 0 ? 7 : 0);
            txt.push('<b>' + esc(fc.name || fc.tech) + '</b> +' + p.tau + ' h · ' + fmtTauDate(fc.init, p.tau) + (p.wind != null ? ' · ' + p.wind + ' kt' : '') + '<br>official forecast — authoritative'); });
        var last = pts.length - 1;
        Plotly.addTraces(el, ofclGeoTraces(lon, lat, sz, txt, fc).concat([
            { type: 'scattergeo', mode: 'text', lon: [lon[last]], lat: [lat[last]], text: ['  ' + (fc.name || fc.tech)], textposition: 'middle right',
              textfont: { size: 10, color: ofclCasing() }, hoverinfo: 'skip', showlegend: false, _rtdm: 1 },
        ]));
    }
    // Cased black/white dashed official track for scattergeo maps (3 traces).
    function ofclGeoTraces(lon, lat, sz, txt, fc) {
        // Lines are hover-silent so the wind-chance lattice always wins;
        // only the 24-h dots carry the official-forecast tooltip.
        var dl = [], dla = [], dt = [];
        for (var i = 0; i < lon.length; i++) if (sz[i] > 0) { dl.push(lon[i]); dla.push(lat[i]); dt.push(txt[i]); }
        return [
            { type: 'scattergeo', mode: 'lines', lon: lon, lat: lat, line: { color: ofclCasing(), width: 5 }, opacity: 0.9, hoverinfo: 'skip', showlegend: false, _rtdm: 1 },
            { type: 'scattergeo', mode: 'lines', lon: lon, lat: lat, line: { color: ofclInner(), width: 2.4, dash: 'dash' }, hoverinfo: 'skip', showlegend: false, _rtdm: 1 },
            { type: 'scattergeo', mode: 'markers', lon: dl, lat: dla, text: dt, hovertemplate: '%{text}<extra></extra>',
              marker: { size: 7, color: ofclInner(), line: { color: ofclCasing(), width: 1.6 } }, name: ofclLabel(fc), showlegend: false, _rtdm: 1 },
        ];
    }
    // Intensity fan (categorical '+Xh' x axis). Valid-time aligned: official
    // tau + (official init − ensemble init) → ensemble tau label.
    function decorateIntensity(elId) {
        var el = $(elId); if (!el || !el.data || typeof Plotly === 'undefined') return;
        stripOurTraces(el);
        var fc, dmInit;
        if (elId === 'ir-intensity-chart') { fc = officialTrack(); dmInit = B.wl() && B.wl().init_time; }
        else { fc = modalOfficial(); dmInit = M.data && M.data.init; }
        if (!fc || !dmInit) return;
        var off = T().initOffsetH(dmInit, fc.init);
        var cats = {}; (el.data[0] && el.data[0].x || []).forEach(function (x) { cats[x] = 1; });
        if (!Object.keys(cats).length) return;
        var mslp = B.intensityMetric && B.intensityMetric() === 'mslp';
        var xs = [], ys = [], txt = [];
        ofclPoints(fc).forEach(function (p) {
            var v = mslp ? p.pres : p.wind; if (v == null) return;
            var lab = '+' + (p.tau + off) + 'h'; if (!cats[lab]) return;
            xs.push(lab); ys.push(v); txt.push(fmtTauDate(fc.init, p.tau) + ' (official +' + p.tau + ' h)');
        });
        if (!xs.length) return;
        // Same cased black/white dashed line as on the maps (consistent, and it
        // reads over the orange percentile bands). The casing trace carries the
        // legend entry; the inner dashed trace would vanish on the legend's
        // light background.
        var hov = '%{text}<br>' + esc(fc.name || fc.tech) + ': %{y:.0f} ' + (mslp ? 'hPa' : 'kt') + '<extra>authoritative forecast</extra>';
        Plotly.addTraces(el, [
            { type: 'scatter', mode: 'lines+markers', x: xs, y: ys, text: txt, hovertemplate: hov,
              line: { color: ofclCasing(), width: 4.6 }, marker: { size: 7.5, color: ofclCasing() },
              name: (fc.name || fc.tech) + ' forecast', showlegend: true, _rtdm: 1 },
            { type: 'scatter', mode: 'lines+markers', x: xs, y: ys, hoverinfo: 'skip',
              line: { color: ofclInner(), width: 2.2, dash: 'dash' }, marker: { size: 4.5, color: ofclInner() },
              showlegend: false, _rtdm: 1 },
        ]);
    }
    function renderGenesisPane(name) {
        if (!M.data) return;
        if (name === 'risk') renderModalRisk();
        else if (name === 'landfall') renderModalLandfall();
    }
    function modalChip(label, on, onclick, title) {
        return '<button type="button" class="rt-dm-chip' + (on ? ' active' : '') + '" onclick="' + onclick + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + label + '</button>';
    }
    function modalModelTag() {
        var v = M.data && M.data.variant;
        return v === 'wnv3' ? 'WeatherNext 3 (experimental)' : 'DeepMind FNV3';
    }
    function renderModalRisk() {
        var el = $('rt-genesis-pane-risk'); if (!el || !M.data) return;
        var r = M.risk;
        var html = '<div class="rt-genesis-risk-controls">'
            + '<div class="rt-dm-row"><span class="rt-dm-row-l">Wind chance</span>'
            + modalChip('Off', r.thresh === 0, 'window.RTDM.modalRisk(0)') + modalChip('≥34 kt', r.thresh === 34, 'window.RTDM.modalRisk(34)')
            + modalChip('≥50 kt', r.thresh === 50, 'window.RTDM.modalRisk(50)') + modalChip('≥64 kt', r.thresh === 64, 'window.RTDM.modalRisk(64)') + '</div>'
            + '<div class="rt-dm-row"><span class="rt-dm-row-l">Within</span>'
            + modalChip('72 h', r.horizon === 72, 'window.RTDM.modalHorizon(72)') + modalChip('120 h', r.horizon === 120, 'window.RTDM.modalHorizon(120)') + modalChip('168 h', r.horizon === 168, 'window.RTDM.modalHorizon(168)') + '</div>'
            + '<div class="rt-dm-row"><span class="rt-dm-row-l">Ensemble swath</span>'
            + modalChip('Off', r.swath === 0, 'window.RTDM.modalSwath(0)') + modalChip('50%', r.swath === 50, 'window.RTDM.modalSwath(50)', 'Half of the members stay inside this swath — an ensemble statistic, not the NHC forecast cone')
            + modalChip('90%', r.swath === 90, 'window.RTDM.modalSwath(90)', 'Nine in ten members stay inside this swath — an ensemble statistic, not the NHC forecast cone') + '</div>'
            + (modalOfficial() ? '<div class="rt-dm-row"><span class="rt-dm-row-l">Reference</span>'
                + modalChip(ofclSwatch() + ' ' + esc(modalOfficial().name || modalOfficial().tech), r.nhc, 'window.RTDM.modalNhc()', 'Official forecast track (red dashed) — the authoritative guidance')
                + '<span class="rt-dm-readout-sub">' + esc(ofclLabel(modalOfficial())) + '</span></div>' : '')
            + '</div>'
            + '<div class="rt-dm-readout-sub" style="margin:0 0 2px;">Hover the field for wind chances at any point · click to set the probe · scroll or pinch to zoom, drag to pan</div>'
            // Capped width + centred: at full modal width a compact system left
            // wide empty ocean on both sides; ~2:1 keeps the field filling the frame.
            // .rt-genesis-modal-chart-wrap = same wrapper as the other modal
            // charts, so the ⤓ PNG button gets its own strip above the map on
            // phones instead of sitting on the plot.
            + '<div class="rt-genesis-modal-chart-wrap" style="position:relative; max-width:860px; margin:0 auto; padding-top:32px;">'
            + '<button type="button" class="rt-genesis-modal-save" title="Save the wind-risk map as PNG (with TC-ATLAS watermark and the not-an-official-forecast note)" onclick="window.RTDM.exportModalRiskMap()">⤓ PNG</button>'
            + '<div id="rt-genesis-modal-riskmap" style="width:100%; height:420px;"></div>'
            + '</div>'
            + '<div class="rt-dm-legend" style="max-width:860px; margin:6px auto 2px;"><span class="rt-dm-legend-t">' + (r.thresh ? 'P(≥' + r.thresh + ' kt) within ' + r.horizon + ' h — filled contours at 10 / 30 / 50 / 70 / 90 %' : 'Wind-chance layer off') + '</span>'
            + (r.thresh ? '<div class="rt-dm-legend-bar" style="background:' + legendCSS() + ';"></div><div class="rt-dm-legend-ticks"><span>5%</span><span>20%</span><span>40%</span><span>60%</span><span>80%</span><span>100%</span></div>' : '') + '</div>'
            + '<div class="rt-genesis-probe" style="max-width:860px; margin:6px auto;"><span>Probe a point:</span>'
            + '<input id="rt-genesis-probe-lat" placeholder="lat" inputmode="decimal" value="' + (r.probe ? r.probe.lat.toFixed(2) : '') + '">'
            + '<input id="rt-genesis-probe-lon" placeholder="lon" inputmode="decimal" value="' + (r.probe ? r.probe.lon.toFixed(2) : '') + '">'
            + '<button type="button" class="rt-dm-chip" onclick="window.RTDM.modalProbe()">Go</button>'
            + (r.probe ? '<button type="button" class="rt-dm-chip" onclick="window.RTDM.modalProbe(null)">Clear</button>' : '')
            + '<span class="rt-dm-readout-sub">°N / °E (use negative for S / W)</span></div>'
            + '<div id="rt-genesis-probe-out" style="max-width:860px; margin:0 auto;"></div>'
            + note('<b>Not an official forecast and not the NHC cone.</b> Wind chances count members whose modeled wind field reaches a location within the window, using each member\'s own wind radii; '
                + 'the ensemble swath is the union of the members\' 50 % / 90 % position ellipses through the window (the ensemble analogue of a lifetime wind swath) and is unrelated to the NHC cone of uncertainty, which is built from official track-error statistics. '
                + 'Experimental research guidance from ' + esc(modalModelTag()) + ' — <b>not a forecast</b>. Official forecasts, watches and warnings: '
                + '<a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener">NHC</a> / CPHC / JTWC or your national weather service.');
        el.innerHTML = html;
        B.whenPlotly(function () { drawModalRiskMap(); renderModalProbe(); });
    }
    function modalRisk(th) { M.risk.thresh = th; renderModalRisk(); }
    function modalHorizon(h) { M.risk.horizon = h; M.risk.grids = {}; M.risk.contours = {}; M.risk.swaths = {}; renderModalRisk(); }
    function modalSwath(v) { M.risk.swath = v; renderModalRisk(); }
    function modalNhc() { M.risk.nhc = !M.risk.nhc; renderModalRisk(); }
    function modalProbe(clear) {
        if (clear === null) { M.risk.probe = null; renderModalRisk(); return; }
        if (clear && typeof clear === 'object' && clear.lat != null) { M.risk.probe = { lat: clear.lat, lon: clear.lon }; renderModalRisk(); return; }
        var la = parseFloat(($('rt-genesis-probe-lat') || {}).value), lo = parseFloat(($('rt-genesis-probe-lon') || {}).value);
        if (!isFinite(la) || !isFinite(lo)) { var o = $('rt-genesis-probe-out'); if (o) o.innerHTML = '<div class="rt-dm-hint">Enter a latitude and longitude, e.g. 21.3 and -157.9.</div>'; return; }
        M.risk.probe = { lat: la, lon: lo };
        renderModalRisk();
    }
    function renderModalProbe() {
        var o = $('rt-genesis-probe-out'); if (!o || !M.data) return;
        var p = M.risk.probe; if (!p) { o.innerHTML = ''; return; }
        var pp = T().pointProbabilities(M.data.members, p.lat, p.lon, { maxTau: M.risk.horizon, mean: M.data.mean });
        var q = T().percentiles(pp.arrival34, [0.1, 0.5, 0.9]);
        var html = '<div class="rt-dm-tiles rt-dm-tiles-3" style="max-width:520px;">'
            + tile('≥34 kt', pct(pp.p34), 'within ' + M.risk.horizon + ' h', '#34d399') + tile('≥50 kt', pct(pp.p50), '', '#fbbf24') + tile('≥64 kt', pct(pp.p64), 'hurricane', '#ef4444') + '</div>';
        if (pp.arrival34.length) html += '<div class="rt-dm-readout-sub">TS wind arrives: median ' + fmtTauDate(M.data.init, q[1]) + ' (+' + q[1] + ' h) · 80% of members +' + q[0] + '–' + q[2] + ' h' + (pp.nearest ? ' · mean track passes ' + Math.round(pp.nearest.km) + ' km away at +' + pp.nearest.tau + ' h' : '') + '</div>';
        else html += '<div class="rt-dm-readout-sub">No member brings tropical-storm-force wind to this point within ' + M.risk.horizon + ' h.</div>';
        o.innerHTML = html;
    }
    function gridFor(th) {
        var r = M.risk, key = th + '@' + r.horizon;
        if (r.grids[key] === undefined) r.grids[key] = T().windProbGrid(M.data.members, { thresh: th, maxTau: r.horizon, cellDeg: 0.2, stepH: 2 }) || null;
        return r.grids[key];
    }
    function modalGrid() { return gridFor(M.risk.thresh); }
    function modalContours() {
        var r = M.risk, key = r.thresh + '@' + r.horizon;
        if (r.contours[key] === undefined) { var g = modalGrid(); r.contours[key] = g ? T().probContours(g, [0.1, 0.3, 0.5, 0.7, 0.9], { smooth: 2, minCells: 4 }) : []; }
        return r.contours[key];
    }
    function modalSwathRings() {
        var r = M.risk, key = r.swath + '@' + r.horizon;
        if (r.swaths[key] === undefined) r.swaths[key] = r.swath ? T().trackSwath(M.data.members, { level: r.swath / 100, maxTau: r.horizon, cellDeg: 0.1 }).rings : [];
        return r.swaths[key];
    }
    function drawModalRiskMap() {
        var el = $('rt-genesis-modal-riskmap'); if (!el || !M.data) return;
        var d = M.data, mean = d.mean && d.mean.points || [];
        var isDark = B.isDark();
        var refLon = B.circMeanLon(mean.filter(function (p) { return p.lon != null; }).map(function (p) { return p.lon; }));
        function U(lon) { return T().unwrapLon(lon, refLon); }
        var maxTau = M.risk.horizon;
        // Spaghetti (one trace, null-separated) + mean.
        var sx = [], sy = [];
        for (var i = 0; i < d.memberKeys.length; i++) {
            var pts = (d.members[d.memberKeys[i]].points || []).filter(function (p) { return p.lat != null && p.tau <= maxTau; });
            var last = null;
            for (var j = 0; j < pts.length; j++) { var lo = U(pts[j].lon); if (last != null && Math.abs(lo - last) > 180) { sx.push(null); sy.push(null); } sx.push(lo); sy.push(pts[j].lat); last = lo; }
            sx.push(null); sy.push(null);
        }
        var mx = [], my = [], mt = [], mw = [];
        mean.forEach(function (p) { if (p.lat != null && p.tau <= maxTau) { mx.push(U(p.lon)); my.push(p.lat); mt.push(p.tau); mw.push(p.wind); } });
        // Framing anchor. A late-forming cluster (median genesis beyond the
        // horizon) has NO mean points inside the window, and genesisBounds
        // falls back to a fixed western-Pacific box when handed nothing —
        // an Atlantic wave then opened on a map of Japan. Frame on the
        // full-lifetime mean instead, then on the member cloud.
        var fLat = my.slice(), fLon = mx.slice(), framedOutsideWindow = false;
        if (!fLat.length) {
            mean.forEach(function (p) { if (p.lat != null) { fLon.push(U(p.lon)); fLat.push(p.lat); } });
            if (!fLat.length) for (var mk = 0; mk < d.memberKeys.length; mk++) {
                (d.members[d.memberKeys[mk]].points || []).forEach(function (p) { if (p.lat != null && p.lon != null) { fLon.push(U(p.lon)); fLat.push(p.lat); } });
            }
            framedOutsideWindow = fLat.length > 0;
        }
        var allLat = fLat.slice(), allLon = fLon.slice();
        var traces = [];
        // Filled contours low→high.
        if (M.risk.thresh) {
            var cts = modalContours();
            for (var c = 0; c < cts.length; c++) {
                var col = probColor(cts[c].level + 0.05) || [124, 58, 237, 160];
                var rings = cts[c].rings;
                for (var rr = 0; rr < rings.length; rr++) {
                    var ring = rings[rr];
                    var lon = ring.map(function (q) { return U(q[1]); }), lat = ring.map(function (q) { return q[0]; });
                    lon.push(lon[0]); lat.push(lat[0]);
                    allLat = allLat.concat(lat); allLon = allLon.concat(lon);
                    traces.push({ type: 'scattergeo', mode: 'lines', lon: lon, lat: lat, fill: 'toself',
                                  fillcolor: 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + (0.42).toFixed(2) + ')',
                                  line: { color: 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',0.9)', width: 0.8 },
                                  name: '≥' + Math.round(cts[c].level * 100) + '%', hoverinfo: 'skip', showlegend: false });
                }
            }
        }
        traces.push({ type: 'scattergeo', mode: 'lines', lon: sx, lat: sy, line: { color: isDark ? 'rgba(249,115,22,0.22)' : 'rgba(249,115,22,0.28)', width: 0.9 }, hoverinfo: 'skip', showlegend: false });
        // Swath — Chavas-style smooth outline, cyan fill.
        if (M.risk.swath) {
            var sw = modalSwathRings();
            for (var s2 = 0; s2 < sw.length; s2++) {
                var rg = sw[s2], slon = rg.map(function (q) { return U(q[1]); }), slat = rg.map(function (q) { return q[0]; });
                slon.push(slon[0]); slat.push(slat[0]);
                allLat = allLat.concat(slat); allLon = allLon.concat(slon);
                traces.push({ type: 'scattergeo', mode: 'lines', lon: slon, lat: slat, fill: 'toself',
                              fillcolor: 'rgba(0,229,255,' + (M.risk.swath === 90 ? 0.08 : 0.14) + ')',
                              line: { color: 'rgba(0,229,255,0.85)', width: 2.2, dash: M.risk.swath === 90 ? 'dash' : 'solid' },
                              name: M.risk.swath + '% ensemble swath (not the NHC cone)', hoverinfo: 'skip', showlegend: false });
            }
        }
        // Ensemble mean: cased SOLID white line (the orange of the This-run map
        // vanished into the orange/red probability shading here). Dots keep the
        // Saffir–Simpson colour for intensity; the official track is the DASHED
        // cased line, so the two never read as one.
        traces.push({ type: 'scattergeo', mode: 'lines', lon: mx, lat: my, line: { color: ofclCasing(), width: 4.6 }, opacity: 0.9, hoverinfo: 'skip', showlegend: false });
        traces.push({ type: 'scattergeo', mode: 'lines', lon: mx, lat: my, line: { color: ofclInner(), width: 2.2 }, hoverinfo: 'skip', showlegend: false });
        var dmx = [], dmy = [], dmw = [], dmt = [];
        mt.forEach(function (t, k) { if (t % 24 === 0) { dmx.push(mx[k]); dmy.push(my[k]); dmw.push(mw[k]); dmt.push('+' + t + ' h · ' + fmtTauDate(d.init, t) + (mw[k] != null ? ' · ' + Math.round(mw[k]) + ' kt' : '')); } });
        traces.push({ type: 'scattergeo', mode: 'markers', lon: dmx, lat: dmy, text: dmt, hovertemplate: '%{text}<extra>ensemble mean</extra>',
                      marker: { size: 8, color: dmw, colorscale: B.ssScale(), cmin: 0, cmax: 200, line: { color: ofclCasing(), width: 1.4 } }, showlegend: false });
        // Hover grid: Plotly geo only reports hovers on drawn points, so lay an
        // invisible lattice over the field carrying P(≥34/50/64) per cell.
        // Clicking a lattice point sets the probe (arrival timing below).
        if (M.risk.thresh) {
            var g34 = gridFor(34), g50 = gridFor(50), g64 = gridFor(64), gBase = modalGrid();
            if (gBase) {
                var stepC = Math.max(1, Math.round(0.25 / gBase.dLon));
                var hl = [], hla = [], ht = [];
                for (var rr2 = 0; rr2 < gBase.ny; rr2 += stepC) for (var cc2 = 0; cc2 < gBase.nx; cc2 += stepC) {
                    var pv = gBase.prob[rr2 * gBase.nx + cc2]; if (!(pv >= 0.03)) continue;
                    var cl = gBase.lat0 - (rr2 + 0.5) * gBase.dLat, cn = gBase.lon0 + (cc2 + 0.5) * gBase.dLon;
                    var p34 = T().gridSample(g34, cl, cn), p50 = T().gridSample(g50, cl, cn), p64 = T().gridSample(g64, cl, cn);
                    hl.push(U(cn)); hla.push(cl);
                    ht.push(B.fmtLatLon(cl, T().wrapLon(cn)) + '<br>≥34 kt <b>' + pct(p34) + '</b> · ≥50 kt <b>' + pct(p50) + '</b> · ≥64 kt <b>' + pct(p64) + '</b><br><span style="font-size:0.8em">within ' + M.risk.horizon + ' h · click for arrival timing</span>');
                }
                traces.push({ type: 'scattergeo', mode: 'markers', lon: hl, lat: hla, text: ht, hovertemplate: '%{text}<extra></extra>',
                              marker: { size: 12, opacity: 0.001, color: '#000' }, showlegend: false, _hoverGrid: 1 });
            }
        }
        if (M.risk.nhc && modalOfficial()) {
            var fcm = modalOfficial(), fpts = ofclPoints(fcm);
            var flon = fpts.map(function (p) { return U(p.lon); }), flat = fpts.map(function (p) { return p.lat; });
            var ftxt = fpts.map(function (p) { return '<b>' + esc(fcm.name || fcm.tech) + '</b> +' + p.tau + ' h · ' + fmtTauDate(fcm.init, p.tau) + (p.wind != null ? ' · ' + p.wind + ' kt' : '') + '<br>official forecast — authoritative'; });
            var fsz = fpts.map(function (p) { return p.tau % 24 === 0 ? 7 : 0; });
            ofclGeoTraces(flon, flat, fsz, ftxt, fcm).forEach(function (t) { traces.push(t); });
            fpts.forEach(function (p) { allLat.push(p.lat); allLon.push(U(p.lon)); });
        }
        if (M.risk.probe) {
            traces.push({ type: 'scattergeo', mode: 'markers+text', lon: [U(M.risk.probe.lon)], lat: [M.risk.probe.lat], text: ['probe'], textposition: 'top center',
                          textfont: { size: 10, color: CYAN }, marker: { size: 11, color: CYAN, line: { color: '#fff', width: 2 } }, hoverinfo: 'skip', showlegend: false });
            allLat.push(M.risk.probe.lat); allLon.push(U(M.risk.probe.lon));
        }
        var rect = el.getBoundingClientRect();
        var aspect = rect.height > 0 ? Math.max(0.8, (rect.width - 20) / rect.height) : 2.0;
        var bounds = B.genesisBounds(fLat, fLon, allLat, allLon, aspect);
        var insetLat = fLat.length ? fLat[0] : 0, insetLon = fLon.length ? T().wrapLon(fLon[0]) : 0;
        var layout = B.geoLayout(bounds, { domainY: [0, 1], insetLon: insetLon, insetLat: insetLat, insetDomain: { x: [0.01, 0.17], y: [0.02, 0.36] } });
        layout.margin = { l: 4, r: 4, t: 8, b: 4 };
        // Burn the liability note into the map itself (survives screenshots).
        // Plotly annotations clip rather than wrap, so fit the box to the map:
        // pick the largest font whose longest line fits, then shorten lines.
        var mapW = Math.max(200, el.clientWidth || 600);
        var fcm2 = M.risk.nhc && modalOfficial();
        function annLines(short) {
            var L = ['<b>Not an official forecast</b>',
                     esc(short ? (M.data.variant === 'wnv3' ? 'WN3' : 'FNV3') + ' ensemble' : modalModelTag() + ' ensemble · experimental'),
                     '<span style="color:' + ofclCasing() + ';">━━</span> ensemble mean' + (short ? '' : ' (solid)')];
            if (M.risk.swath) L.push('<span style="color:' + CYAN + ';">╌╌</span> ' + M.risk.swath + '% ensemble swath' + (short ? ' — not NHC cone' : ' — not the NHC cone'));
            else L.push(short ? 'wind chances — not NHC' : 'wind chances — not NHC probabilities');
            if (fcm2) L.push(ofclSwatch() + ' ' + esc(fcm2.name || fcm2.tech) + (short ? ' (dashed)' : ' forecast (dashed) — authoritative'));
            return L;
        }
        function plainLen(t) { return t.replace(/<[^>]*>/g, '').length; }
        var annFont = 10, lines = annLines(false), maxPx = mapW - 28;
        function widest(ls) { return Math.max.apply(null, ls.map(function (t) { return plainLen(t) * annFont * 0.56; })); }
        while (widest(lines) > maxPx && annFont > 8) annFont--;
        if (widest(lines) > maxPx) { lines = annLines(true); while (widest(lines) > maxPx && annFont > 7) annFont--; }
        layout.annotations = (layout.annotations || []).concat([{
            // Bottom-left: clear of the ⤓ PNG button (top-right) on every width.
            xref: 'paper', yref: 'paper', x: 0.005, y: 0.01, xanchor: 'left', yanchor: 'bottom', showarrow: false, align: 'left',
            text: lines.join('<br>'),
            font: { size: annFont, color: isDark ? '#e2e8f0' : '#0f172a' },
            bgcolor: isDark ? 'rgba(15,23,42,0.72)' : 'rgba(255,255,255,0.78)',
            bordercolor: 'rgba(0,229,255,0.45)', borderwidth: 1, borderpad: 5,
        }]);
        // The liability box is pinned to the frame by index: capture it BEFORE
        // the window note is appended.
        var annIdx = layout.annotations.length - 1;
        if (framedOutsideWindow) {
            var firstMean = mean.filter(function (p) { return p.lat != null; })[0];
            layout.annotations.push({
                xref: 'paper', yref: 'paper', x: 0.5, y: 0.985, xanchor: 'center', yanchor: 'top', showarrow: false, align: 'center',
                text: 'No cluster member is tracked within ' + maxTau + ' h'
                    + (firstMean ? ' — the ensemble mean first appears at +' + Math.round(firstMean.tau) + ' h' : '')
                    + (maxTau < 168 ? '<br>Try the 168 h window' : ''),
                font: { size: 11, color: isDark ? '#fbbf24' : '#b45309' },
                bgcolor: isDark ? 'rgba(15,23,42,0.72)' : 'rgba(255,255,255,0.85)',
                bordercolor: 'rgba(245,158,11,0.55)', borderwidth: 1, borderpad: 5,
            });
        }
        layout.dragmode = 'pan';
        layout.hovermode = 'closest';
        Plotly.react(el, traces, layout, { displayModeBar: false, responsive: true, scrollZoom: true })
            .then(function () { anchorAnnotationToFrame(el, annIdx); });
        if (!el._rtdmRelayoutBound) {
            el._rtdmRelayoutBound = true;
            // Zoom / pan / resize move the frame: keep the box pinned to it.
            el.on('plotly_relayout', function (ev) {
                if (ev && (ev['annotations[' + annIdx + '].x'] != null)) return;   // our own relayout
                anchorAnnotationToFrame(el, annIdx);
            });
        }
        if (!el._rtdmClickBound) {
            el._rtdmClickBound = true;
            el.on('plotly_click', function (ev) {
                var pt = ev && ev.points && ev.points[0]; if (!pt || !pt.data || !pt.data._hoverGrid) return;
                modalProbe({ lat: pt.lat, lon: T().wrapLon(pt.lon) });
            });
        }
    }
    // PNG of the modal Wind Risk map: rasterize the geo panel (SVG path on
    // Safari) then stamp the footer — caption (storm · model · layer · NOT an
    // official forecast) bottom-left, TC-ATLAS logo + tcatlas.org bottom-right.
    function exportModalRiskMap() {
        var el = $('rt-genesis-modal-riskmap'); if (!el || !el.data || !M.data || typeof Plotly === 'undefined') return;
        // Size the export to the MAP FRAME's aspect (not the container's): a geo
        // frame is letterboxed inside the plot area, and Plotly anchors the
        // legend box to the plot area — matching aspects makes the frame fill
        // the image so the box lands inside the map, and no blank margins.
        var W = 1600, H;
        try {
            var sp = el._fullLayout.geo._subplot;
            H = Math.round((W - 8) * sp.yaxis._length / sp.xaxis._length) + 12;
        } catch (e) { H = Math.round(W * el.clientHeight / Math.max(1, el.clientWidth)); }
        H = Math.max(500, Math.min(2200, H));
        var r = M.risk;
        // Keep it to one line clear of the watermark: the map's own annotation
        // already carries the swath / cone wording.
        var caption = (M.data.label || '') + ' · ' + modalModelTag() + ' · init ' + fmtInit(M.data.init)
            + (r.thresh ? ' · P(≥' + r.thresh + ' kt) within ' + r.horizon + ' h' : '')
            + ' · NOT an official forecast';
        var fn = 'TC-ATLAS_' + (M.data.atcf || (M.data.label || 'system').replace(/[^a-z0-9]+/gi, '_')) + '_wind_risk'
            + (r.thresh ? '_p' + r.thresh + '_' + r.horizon + 'h' : '') + '_' + (M.data.variant === 'wnv3' ? 'WN3' : 'FNV3') + '_init' + (M.data.init || '') + '.png';
        // Export goes through an SVG image, where the DM Sans web font is not
        // available: text falls back to a wider system face than the one
        // Plotly measured the legend box with, and the box clips it. Export a
        // copy whose fonts name the system stack up front so measurement and
        // rendering use the same face.
        var SYS = '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif';
        var lay = JSON.parse(JSON.stringify(el.layout));
        lay.font = Object.assign({}, lay.font, { family: SYS });
        (lay.annotations || []).forEach(function (a) { a.font = Object.assign({}, a.font, { family: SYS }); a.borderpad = Math.max(a.borderpad || 0, 6);
            // The frame fills the export, so anchor just inside its corner.
            if (a.xanchor === 'left' && a.yanchor === 'bottom') { a.x = 0.008; a.y = 0.012; } });
        if (lay.geo && lay.geo.lonaxis && lay.geo.lonaxis.tickfont) lay.geo.lonaxis.tickfont.family = SYS;
        if (lay.geo && lay.geo.lataxis && lay.geo.lataxis.tickfont) lay.geo.lataxis.tickfont.family = SYS;
        var shim = { data: el.data, layout: lay };
        B.panelExportURL(shim, 2.2, W, H, 1).then(function (url) {
            B.stampExport(url, W, H, function (blob) { if (blob) B.saveImageBlob(blob, fn); }, caption);
        }).catch(function (e) { console.warn('[RTDM] risk map export failed', e); });
        B.ga('rt_dm_modal_risk_export', { thresh: r.thresh });
    }
    // Plotly annotations use "paper" coordinates = the whole plot area, but a
    // geo map draws its frame centred and letterboxed inside that area, so a
    // box at paper (0,0) can land outside the map. Read the frame's pixel
    // rectangle from the rendered subplot and move the box just inside its
    // bottom-left corner.
    function anchorAnnotationToFrame(el, idx) {
        try {
            var fl = el._fullLayout, sp = fl && fl.geo && fl.geo._subplot;
            if (!sp || !sp.xaxis || !sp.yaxis || !fl._size) return;
            var ax = sp.xaxis, ay = sp.yaxis, sz = fl._size;
            var left = ax._offset, bottom = ay._offset + ay._length;
            var x = (left - sz.l) / sz.w + 6 / sz.w;
            var y = 1 - (bottom - sz.t) / sz.h + 6 / sz.h;
            var upd = {}; upd['annotations[' + idx + '].x'] = x; upd['annotations[' + idx + '].y'] = y;
            var cur = fl.annotations && fl.annotations[idx];
            if (cur && Math.abs(cur.x - x) < 1e-4 && Math.abs(cur.y - y) < 1e-4) return;
            Plotly.relayout(el, upd);
        } catch (e) { /* leave the paper-anchored fallback */ }
    }
    function renderModalLandfall() {
        var el = $('rt-genesis-pane-landfall'); if (!el || !M.data) return;
        if (!S.landMask) {
            el.innerHTML = '<div class="rt-dm-hint">Loading coastline mask…</div>';
            ensureLandMask().then(function () { renderModalLandfall(); }).catch(function () { el.innerHTML = '<div class="rt-dm-hint">Land mask unavailable.</div>'; });
            return;
        }
        var d = M.data;
        if (!M.lf) M.lf = T().landfall(d.members, S.landMask, { maxTau: 360, stepH: 1, horizons: [72, 120, 168] });
        var lf = M.lf, init = d.init, n = lf.n;
        var html = '';
        var preGenesis = !d.alreadyTC;
        // Modal-native chrome: the same stat row / chart wrap / ⤓ PNG button
        // the other panes use, so this pane doesn't read as a different app.
        function mstat(label, value, hint, color) {
            return '<div class="rt-genesis-stat"><div class="rt-genesis-stat-label">' + label + '</div>'
                + '<div class="rt-genesis-stat-value"' + (color ? ' style="color:' + color + ';"' : '') + '>' + value + '</div>'
                + (hint ? '<div class="rt-genesis-stat-hint">' + hint + '</div>' : '') + '</div>';
        }
        function msection(title, note, chartId, height, label) {
            return '<div class="rt-genesis-modal-chart-wrap" style="position:relative; margin-top:14px;">'
                + '<button type="button" class="rt-genesis-modal-save" title="Save as PNG" onclick="window.RTDM.exportChart(\'' + chartId + '\',\'' + label + '\')">⤓ PNG</button>'
                + '<div class="rt-genesis-trend-head"><span class="rt-genesis-trend-title">' + title + '</span>' + (note ? '<span class="rt-genesis-trend-note">' + note + '</span>' : '') + '</div>'
                + '<div id="' + chartId + '" style="width:100%; height:' + height + 'px;"></div></div>';
        }
        if (!lf.events.length) {
            html += '<div class="rt-genesis-stat-row">' + mstat('Landfall chance', '0%', 'no member brings the center over land within 15 days', '#34d399') + '</div>';
        } else {
            var q = T().percentiles(lf.taus, [0.1, 0.5, 0.9]), wq = T().percentiles(lf.winds, [0.5]), medCat = T().catOf(wq[0]);
            html += '<div class="rt-genesis-stat-row">'
                + mstat('Landfall chance', pct(lf.pAny), 'within 15 d · ' + pct(lf.pBy['120']) + ' by +120 h' + (preGenesis ? ' · of all members, forming or not' : ''), lf.pAny >= 0.5 ? '#ef4444' : lf.pAny >= 0.2 ? '#fb923c' : '#f59e0b')
                + mstat('Median timing', '+' + q[1] + ' h', fmtTauDate(init, q[1]) + ' · 80% in +' + q[0] + '–' + q[2] + ' h')
                + mstat('Intensity at landfall', catLabel(medCat), 'median ' + Math.round(wq[0]) + ' kt among landfalling members', catColor(medCat))
                + '</div>';
            html += msection('When members make landfall', '12-h bins, stacked by intensity at landfall', 'rt-genesis-lf-chart', 200, 'Landfall timing');
            // Hotspots: cluster events on a 1° grid, top 5.
            var cells = {};
            lf.events.forEach(function (e) { var k = Math.round(e.lat) + ',' + Math.round(e.lon); (cells[k] = cells[k] || []).push(e); });
            var hot = Object.keys(cells).map(function (k) { return { k: k, ev: cells[k] }; }).sort(function (a, b) { return b.ev.length - a.ev.length; }).slice(0, 5);
            html += '<div class="rt-genesis-trend-head" style="margin-top:14px;"><span class="rt-genesis-trend-title">Where</span><span class="rt-genesis-trend-note">member landfalls grouped to 1°</span></div><div class="rt-genesis-hotspots">';
            hot.forEach(function (h) {
                var la = h.ev.reduce(function (a, e) { return a + e.lat; }, 0) / h.ev.length, lo = h.ev.reduce(function (a, e) { return a + e.lon; }, 0) / h.ev.length;
                var tq = T().percentiles(h.ev.map(function (e) { return e.tau; }), [0.5]), wq2 = T().percentiles(h.ev.filter(function (e) { return e.wind != null; }).map(function (e) { return e.wind; }), [0.5]);
                html += '<div class="rt-genesis-hot"><span class="rt-genesis-hot-p">' + pct(h.ev.length / n) + '</span><span>near ' + B.fmtLatLon(la, lo) + '</span>'
                    + '<span class="rt-dm-readout-sub">median ' + fmtTauDate(init, tq[0]) + (wq2[0] != null ? ' · ' + catLabel(T().catOf(wq2[0])) : '') + '</span></div>';
            });
            html += '</div>';
        }
        html += msection('Members still tracking the system', 'share of members that still carry the system at each lead', 'rt-genesis-surv-chart', 140, 'Ensemble survival');
        html += note('"Landfall" = the member\'s center first crossing from sea to land on a 0.1° coastline mask (small islands and narrow peninsulas can be missed; timing ±1 h).'
            + (preGenesis ? ' For a pre-genesis cluster the chance is over all members, so it already folds in the odds of forming.' : '')
            + ' Experimental research guidance from ' + esc(modalModelTag()) + ' — <b>not a forecast</b>. For official track forecasts, watches and warnings see '
            + '<a href="https://www.nhc.noaa.gov/" target="_blank" rel="noopener">NHC</a> / CPHC / JTWC or your national weather service.');
        el.innerHTML = html;
        B.whenPlotly(function () {
            if (lf.events.length) { var lfEl = $('rt-genesis-lf-chart'); if (lfEl) drawLfChartInto(lfEl, lf, init); }
            var sv = $('rt-genesis-surv-chart'); if (sv) drawSurvivalInto(sv, d.members, T().survival(d.members, allTaus(d.members)).taus);
        });
    }
    function allTaus(members) {
        var set = {}; Object.keys(members).forEach(function (k) { (members[k].points || []).forEach(function (p) { set[p.tau] = 1; }); });
        return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    }
    // Chart helpers shared by card + modal (element-targeted variants).
    function drawLfChartInto(el, lf, init) {
        var bin = 12, maxT = 0, cats = ['TD', 'TS', 'C1', 'C2', 'C3', 'C4', 'C5'], byBin = {};
        for (var i = 0; i < lf.events.length; i++) { var e = lf.events[i], b = Math.floor(e.tau / bin) * bin; if (b > maxT) maxT = b; var c = T().catOf(e.wind); byBin[b] = byBin[b] || {}; byBin[b][c] = (byBin[b][c] || 0) + 1; }
        var xs = []; for (var t = 0; t <= maxT; t += bin) xs.push(t);
        var traces = [];
        for (var ci = 0; ci < cats.length; ci++) {
            var ys = xs.map(function (t) { return 100 * ((byBin[t] && byBin[t][cats[ci]]) || 0) / lf.n; });
            if (!ys.some(function (v) { return v > 0; })) continue;
            traces.push({ type: 'bar', name: catLabel(cats[ci]), x: xs.map(function (t) { return '+' + t + 'h'; }), y: ys, marker: { color: catColor(cats[ci]) },
                          text: xs.map(function (t) { return fmtTauDate(init, t) + ' – ' + fmtTauDate(init, t + bin); }),
                          hovertemplate: '%{text}<br>' + catLabel(cats[ci]) + ': %{y:.1f}% of members<extra></extra>' });
        }
        var layout = B.chartLayout({ margin: { l: 36, r: 8, t: 6, b: 30 }, fontSize: 10, legend: true,
            yaxis: { title: { text: '% members', font: { size: 10 } }, rangemode: 'tozero', ticksuffix: '%' }, xaxis: { tickfont: { size: 9 }, nticks: 10 }, extra: { barmode: 'stack' } });
        layout.legend.font.size = 9;
        Plotly.react(el, traces, layout, { displayModeBar: false, responsive: true });
    }
    function drawSurvivalInto(el, members, taus) {
        var sv = T().survival(members, taus);
        var layout = B.chartLayout({ margin: { l: 36, r: 8, t: 6, b: 26 }, fontSize: 10,
            yaxis: { range: [0, 105], ticksuffix: '%', title: { text: '% members', font: { size: 10 } } }, xaxis: { tickfont: { size: 9 }, nticks: 10 } });
        Plotly.react(el, [{ type: 'scatter', mode: 'lines', x: sv.taus.map(function (t) { return '+' + t + 'h'; }), y: sv.frac.map(function (f) { return 100 * f; }),
                            fill: 'tozeroy', fillcolor: 'rgba(0,229,255,0.12)', line: { color: CYAN, width: 2 },
                            hovertemplate: '%{x}: %{y:.0f}% of members still carry the system<extra></extra>' }], layout, { displayModeBar: false, responsive: true });
    }

    window.RTDM = {
        attach: function (bridge) { B = bridge; },
        // Global Map
        globalSetRisk: globalSetRisk, globalSetHorizon: globalSetHorizon, onGlobalData: function () { onGlobalData(); onGlobalDataForPopup(); },
        globalRiskRowHtml: globalRiskRowHtml, bindGlobalRiskChips: bindGlobalRiskChips, fillPopupLines: fillPopupLines,
        globalRiskOn: function () { return !!G.thresh; }, clearGlobalRisk: clearGlobalRisk,
        // DeepMind modal
        onGenesisDetail: onGenesisDetail, onGenesisClose: onGenesisClose, renderGenesisPane: renderGenesisPane,
        modalRisk: modalRisk, modalHorizon: modalHorizon, modalSwath: modalSwath, modalProbe: modalProbe, modalNhc: modalNhc,
        decorateTrackMap: decorateTrackMap, decorateIntensity: decorateIntensity, toggleNhc: toggleNhc,
        exportModalRiskMap: exportModalRiskMap,
        _m: M,
        onWeatherlab: onWeatherlab, onEnsemble: onEnsemble, onPanels: onPanels, onStormClose: onStormClose,
        setTab: setTab, setRisk: setRisk, setHorizon: setHorizon, toggleEllipses: toggleEllipses, clearPoint: clearPoint,
        toggleLfPoints: toggleLfPoints, loadOther: loadOther, toggleCmpOverlay: toggleCmpOverlay,
        exportChart: exportChart,
        _state: S,
    };
})();
