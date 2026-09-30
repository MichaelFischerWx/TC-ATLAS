// sonde_card.js — calm dropsonde card (design study v2, 2026-09-30).
//
// One number, one chart, one idea at a time: WL150 set large, a single
// height-based chart that switches between Wind / Inflow / θe / Drift (plus
// the classic Skew-T), and the rest of the flight as small tiles. Replaces
// the popup table + skew-T-first modal when the page is opened with
// ?sonde=v2 (off by default). realtime_ir.js owns the markers and the modal
// element; this file only renders into them (window.SondeCard).
(function () {
    'use strict';

    var NS = 'http://www.w3.org/2000/svg';
    var ON = /[?&]sonde=v2\b/.test(location.search);

    // ── colour ──────────────────────────────────────────────────────────
    // theme.js: dark = data-theme="dark"; light = no attribute.
    function isLight() { return document.documentElement.getAttribute('data-theme') !== 'dark'; }
    // Wind speed, lightness-ordered (calm recedes, intense glows). Light theme
    // ends dark so the strongest winds stay visible on white.
    var RAMP_D = [[0, '#3a4a86'], [34, '#5b49b0'], [64, '#8f45b3'], [96, '#c9418a'], [120, '#ef5a55'], [145, '#fb923c'], [170, '#fcd34d'], [200, '#fff8e1']];
    var RAMP_L = [[0, '#a8b4f5'], [34, '#7f86f0'], [64, '#9333ea'], [96, '#c026d3'], [120, '#e11d48'], [145, '#ea580c'], [170, '#c2410c'], [200, '#7c2d12']];
    function hex2(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
    function wc(v, onWhite) {
        var R = (onWhite || isLight()) ? RAMP_L : RAMP_D;
        if (v == null || isNaN(v)) return tok('--slate');
        if (v <= R[0][0]) return R[0][1];
        for (var i = 0; i < R.length - 1; i++) if (v <= R[i + 1][0]) {
            var f = (v - R[i][0]) / (R[i + 1][0] - R[i][0]), a = hex2(R[i][1]), b = hex2(R[i + 1][1]);
            return 'rgb(' + Math.round(a[0] + f * (b[0] - a[0])) + ',' + Math.round(a[1] + f * (b[1] - a[1])) + ',' + Math.round(a[2] + f * (b[2] - a[2])) + ')';
        }
        return R[R.length - 1][1];
    }
    var _tokEl = null;
    function tok(name) { return getComputedStyle(_tokEl || document.documentElement).getPropertyValue(name).trim(); }

    // ── svg helpers ─────────────────────────────────────────────────────
    function el(tag, attrs, parent, text) {
        var e = document.createElementNS(NS, tag);
        for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
        if (text != null) e.textContent = text;
        if (parent) parent.appendChild(e);
        return e;
    }
    function svg(w, h, parent, label) {
        var s = el('svg', { width: w, height: h, viewBox: '0 0 ' + w + ' ' + h, role: 'img', 'aria-label': label || '' }, parent);
        s.style.display = 'block'; s.style.maxWidth = '100%'; s.style.touchAction = 'pan-y';
        return s;
    }
    var gid = 0;
    function windGradient(root, x0, x1, vmax) {
        var id = 'sv2g' + (++gid), g = el('linearGradient', { id: id, gradientUnits: 'userSpaceOnUse', x1: x0, y1: 0, x2: x1, y2: 0 }, el('defs', {}, root));
        for (var v = 0; v <= vmax; v += 5) el('stop', { offset: (v / vmax).toFixed(4), 'stop-color': wc(v) }, g);
        return 'url(#' + id + ')';
    }
    // Polyline split into runs of one 5-kt colour bin; runs share an end vertex
    // so round joins hide the seams 1-s segments would leave.
    function colorRuns(parent, L, P, width) {
        var run = null, last = null;
        function flush() { if (run && run.pts.length > 1) el('path', { d: 'M' + run.pts.join('L'), fill: 'none', stroke: wc(run.v), 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, parent); }
        for (var k = 0; k < L.length; k++) {
            var ws = L[k].ws != null ? L[k].ws : last; last = ws;
            var b = ws == null ? -1 : Math.round(ws / 5), pt = P(L[k]).map(function (q) { return q.toFixed(1); }).join(',');
            if (!run || run.b !== b) { var prev = run ? run.pts[run.pts.length - 1] : null; flush(); run = { b: b, v: ws, pts: prev ? [prev] : [] }; }
            run.pts.push(pt);
        }
        flush();
    }
    // Label placer: first candidate whose padded box stays in bounds, crosses no
    // plotted segment and overlaps no placed label/marker; otherwise dropped
    // (the header / caption carry the same number).
    function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
        function o(px, py, qx, qy, rx, ry) { return Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px)); }
        return o(ax, ay, bx, by, cx, cy) !== o(ax, ay, bx, by, dx, dy) && o(cx, cy, dx, dy, ax, ay) !== o(cx, cy, dx, dy, bx, by);
    }
    function segHitsRect(s, r) {
        var x1 = s[0], y1 = s[1], x2 = s[2], y2 = s[3];
        if (Math.max(x1, x2) < r.x0 || Math.min(x1, x2) > r.x1 || Math.max(y1, y2) < r.y0 || Math.min(y1, y2) > r.y1) return false;
        function inR(x, y) { return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1; }
        if (inR(x1, y1) || inR(x2, y2)) return true;
        return segCross(x1, y1, x2, y2, r.x0, r.y0, r.x1, r.y0) || segCross(x1, y1, x2, y2, r.x1, r.y0, r.x1, r.y1) ||
               segCross(x1, y1, x2, y2, r.x0, r.y1, r.x1, r.y1) || segCross(x1, y1, x2, y2, r.x0, r.y0, r.x0, r.y1);
    }
    function Placer(root, bounds, pad) {
        var segs = [], rects = [];
        pad = pad == null ? 3 : pad;
        return {
            path: function (pts) { for (var i = 1; i < pts.length; i++) segs.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]]); },
            block: function (x0, y0, x1, y1) { rects.push({ x0: x0, y0: y0, x1: x1, y1: y1 }); },
            label: function (texts, attrs, cands) {
                texts = [].concat(texts);
                for (var ti = 0; ti < texts.length; ti++) {
                    for (var c = 0; c < cands.length; c++) {
                        var a = {}; for (var k in attrs) a[k] = attrs[k];
                        a.x = cands[c][0]; a.y = cands[c][1]; a['text-anchor'] = cands[c][2] || 'start';
                        var node = el('text', a, root, texts[ti]), bb = null;
                        try { bb = node.getBBox(); } catch (e) {}
                        if (!bb || !bb.width) {
                            var fs = +attrs['font-size'] || 11, w = texts[ti].length * fs * 0.6;
                            bb = { x: a['text-anchor'] === 'end' ? a.x - w : a['text-anchor'] === 'middle' ? a.x - w / 2 : a.x, y: a.y - fs * 0.8, width: w, height: fs };
                        }
                        var r = { x0: bb.x - pad, y0: bb.y - pad * 0.7, x1: bb.x + bb.width + pad, y1: bb.y + bb.height + pad * 0.7 };
                        var ok = r.x0 >= bounds[0] && r.y0 >= bounds[1] && r.x1 <= bounds[2] && r.y1 <= bounds[3];
                        for (var i = 0; ok && i < segs.length; i++) if (segHitsRect(segs[i], r)) ok = false;
                        for (var j = 0; ok && j < rects.length; j++) { var q = rects[j]; if (!(r.x1 < q.x0 || r.x0 > q.x1 || r.y1 < q.y0 || r.y0 > q.y1)) ok = false; }
                        if (ok) { rects.push(r); return node; }
                        root.removeChild(node);
                    }
                }
                return null;
            }
        };
    }

    function r0(v) { return v == null || isNaN(v) ? '–' : Math.round(v); }
    function r1(v) { return v == null || isNaN(v) ? '–' : (Math.round(v * 10) / 10).toFixed(1); }
    function obLabel(ob) { return ob == null || ob === '' ? '' : 'OB ' + String(ob).replace(/^(\d)$/, '0$1'); }
    function hhmm(iso) { return iso ? String(iso).slice(11, 16) + 'Z' : ''; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

    // ── storm centre from the blob's VDM fixes ──────────────────────────
    function tsec(iso) { var t = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z'); return isNaN(t) ? null : t / 1000; }
    function centerFn(vdms) {
        var V = (vdms || []).filter(function (v) { return v.lat != null && v.lon != null && v.t; })
            .map(function (v) { return [tsec(v.t), v.lat, v.lon, v.max_fl_wind_range_nm]; })
            .filter(function (v) { return v[0] != null; }).sort(function (a, b) { return a[0] - b[0]; });
        if (!V.length) return null;
        var f = function (t) {
            if (t <= V[0][0]) return [V[0][1], V[0][2]];
            if (t >= V[V.length - 1][0]) return [V[V.length - 1][1], V[V.length - 1][2]];
            for (var i = 0; i < V.length - 1; i++) if (t >= V[i][0] && t <= V[i + 1][0]) {
                var w = (t - V[i][0]) / (V[i + 1][0] - V[i][0]);
                return [V[i][1] + w * (V[i + 1][1] - V[i][1]), V[i][2] + w * (V[i + 1][2] - V[i][2])];
            }
            return [V[V.length - 1][1], V[V.length - 1][2]];
        };
        // Flight-level RMW from the latest fix that reports one (nm → km).
        for (var k = V.length - 1; k >= 0; k--) if (V[k][3] != null) { f.rmw = V[k][3] * 1.852; break; }
        return f;
    }

    // ── one sounding → level rows + derived numbers ─────────────────────
    function thetaE(tc, tdc, p) {
        if (tc == null || tdc == null || p == null) return null;
        var T = tc + 273.15, Td = tdc + 273.15;
        var e = 6.112 * Math.exp(17.67 * tdc / (tdc + 243.5)), q = 0.622 * e / (p - e);
        var Tl = 1 / (1 / (Td - 56) + Math.log(T / Td) / 800) + 56;
        return T * Math.pow(1000 / p, 0.2854 * (1 - 0.28 * q)) * Math.exp((3.376 / Tl - 0.00254) * q * 1000 * (1 + 0.81 * q));
    }
    function finish(S, center) {
        var L = S.lv;
        L.sort(function (a, b) { return a.z - b.z; });
        var t0 = tsec(S.t);
        L.forEach(function (r) {
            r.the = thetaE(r.t, r.td, r.p);
            r.x = r.y = r.vt = r.vr = null;
            if (!center || r.lat == null || t0 == null) return;
            var c = center(t0 + (r.dt || 0));
            r.x = (r.lon - c[1]) * 111.32 * Math.cos(c[0] * Math.PI / 180);
            r.y = (r.lat - c[0]) * 110.57;
            var rr = Math.hypot(r.x, r.y);
            if (r.ws != null && r.wd != null && rr > 0.3) {
                var a = r.wd * Math.PI / 180, u = -r.ws * Math.sin(a), v = -r.ws * Math.cos(a);
                r.vr = (u * r.x + v * r.y) / rr; r.vt = (-u * r.y + v * r.x) / rr;
            }
        });
        S.ztop = L.length ? L[L.length - 1].z : 0;
        var top = L[L.length - 1], bot = L[0];
        S.hasPos = !!(center && top && top.x != null && bot && bot.x != null);
        S.rmw = center && center.rmw ? center.rmw : null;
        if (S.hasPos) {
            S.r_rel = Math.hypot(top.x, top.y); S.r_spl = Math.hypot(bot.x, bot.y);
            var da = (Math.atan2(bot.y, bot.x) - Math.atan2(top.y, top.x)) * 180 / Math.PI;
            while (da > 180) da -= 360; while (da < -180) da += 360;
            S.dAng = da; S.drift = Math.hypot(bot.x - top.x, bot.y - top.y);
        }
        S.fall = bot && bot.dt != null ? bot.dt : null;
        var q = S.hasPos && S.rmw ? S.r_spl / S.rmw : null;
        S.cls = q == null ? null : q < 0.4 ? 'Eye' : q < 1.7 ? 'Eyewall' : q < 4 ? 'Inner core' : 'Outer';
        S.eye = S.hasPos && (S.cls === 'Eye' || S.r_spl < 4);
        S.inflowTop = null; S.vr0 = null;
        if (S.hasPos && !S.eye) {
            var run = 0;
            for (var i = 0; i < L.length; i++) {
                var vr = L[i].vr; if (vr == null) continue;
                if (S.vr0 == null) S.vr0 = vr;
                if (vr >= 0) { run++; if (run >= 3) { S.inflowTop = L[i - 2].z; break; } } else run = 0;
            }
        }
        if (S.vmax == null) {
            var m = null; L.forEach(function (r) { if (r.ws != null && (!m || r.ws > m.ws)) m = r; });
            if (m) { S.vmax = m.ws; S.vmaxz = m.z; }
        }
        S.sfcp = bot ? bot.p : null;
        return S;
    }
    function fromHires(h, sonde, center) {
        var lv = h.levels, n = lv.p_hpa.length, L = [];
        for (var i = 0; i < n; i++) {
            if (lv.z_m[i] == null || lv.p_hpa[i] == null) continue;
            var ws = lv.wspd_kt[i]; if (ws != null && ws > 250) ws = null;   // decode artefact
            L.push({ z: lv.z_m[i], p: lv.p_hpa[i], t: lv.t_c[i], td: lv.td_c[i], wd: lv.wdir[i], ws: ws,
                     lat: lv.lat ? lv.lat[i] : null, lon: lv.lon ? lv.lon[i] : null, dt: lv.dt_s ? lv.dt_s[i] : null });
        }
        // nearest-valid fill for the odd level with no GPS fix (else the path jumps)
        var valid = L.filter(function (r) { return r.lat != null && r.lon != null; });
        if (valid.length) L.forEach(function (r) {
            if (r.lat != null && r.lon != null) return;
            var best = valid[0]; valid.forEach(function (v) { if (Math.abs(v.z - r.z) < Math.abs(best.z - r.z)) best = v; });
            r.lat = best.lat; r.lon = best.lon;
        });
        return finish({ src: 'hires', t: h.t || sonde.t, ob: h.ob != null ? h.ob : sonde.ob, n: h.n_levels || L.length,
                        wl150: h.wl150_kt, mbl: h.mbl_kt, vmax: h.max_wind_kt, vmaxz: h.max_wind_z_m, lv: L }, center);
    }
    // TEMP DROP (FM-37) fallback: mandatory levels carry heights; significant
    // levels are placed by log-p interpolation between them. No per-level GPS,
    // so storm-relative views stay off.
    function fromTempDrop(sonde) {
        var prof = sonde.profile || {}, mand = (prof.mandatory || []).filter(function (L) { return L.p != null && L.hgt != null; });
        if (mand.length < 2) return null;
        var ph = mand.map(function (L) { return [L.p, L.hgt]; }).sort(function (a, b) { return b[0] - a[0]; });
        function zAt(p) {
            for (var i = 0; i < ph.length - 1; i++) if (p <= ph[i][0] && p >= ph[i + 1][0]) {
                var f = Math.log(ph[i][0] / p) / Math.log(ph[i][0] / ph[i + 1][0]); return ph[i][1] + f * (ph[i + 1][1] - ph[i][1]);
            }
            return null;
        }
        var byP = {};
        mand.concat(prof.sig_temp || []).forEach(function (L) { if (L.p == null) return; var o = byP[L.p] || (byP[L.p] = { p: L.p }); if (L.t != null) { o.t = L.t; o.td = L.td; } if (L.hgt != null) o.z = L.hgt; });
        mand.concat(prof.sig_wind || []).forEach(function (L) { if (L.p == null || L.wspd == null || L.wspd > 250) return; var o = byP[L.p] || (byP[L.p] = { p: L.p }); o.ws = L.wspd; o.wd = L.wdir; });
        var L = Object.keys(byP).map(function (k) { var o = byP[k]; if (o.z == null) o.z = zAt(o.p); return o; })
            .filter(function (o) { return o.z != null; });
        return finish({ src: 'tempdrop', t: sonde.t, ob: sonde.ob, n: L.length, wl150: sonde.sfc_wind_kt, mbl: sonde.mbl_wind_kt, lv: L }, null);
    }

    // ── tooltip ─────────────────────────────────────────────────────────
    var tipEl = null;
    function showTip(html, ev) {
        if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'sv2-tip'; document.body.appendChild(tipEl); }
        tipEl.innerHTML = html; tipEl.style.display = 'block';
        var x = ev.clientX + 14, y = ev.clientY - 38, w = tipEl.offsetWidth;
        if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
        if (y < 8) y = ev.clientY + 16;
        tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
    }
    function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

    // ── the one chart (height on y; x per mode) ─────────────────────────
    function levelAtZ(L, z) {
        var lo = 0, hi = L.length - 1;
        while (hi - lo > 1) { var m = (lo + hi) >> 1; if (L[m].z < z) lo = m; else hi = m; }
        return Math.abs(L[lo].z - z) < Math.abs(L[hi].z - z) ? lo : hi;
    }
    function profileChart(box, S, mode) {
        var W = box.clientWidth || 520, H = Math.round(Math.max(260, Math.min(360, W * 0.56)));
        var root = svg(W, H, box, mode + ' profile');
        var m = { l: 34, r: 16, t: 22, b: 30 };
        var zmax = Math.max(2500, Math.ceil(S.ztop / 500) * 500);
        var pw = W - m.l - m.r, ph = H - m.t - m.b;
        function Y(z) { return m.t + ph * (1 - z / zmax); }
        var key, xmin, xmax, step, unit;
        if (mode === 'wind') { key = 'ws'; xmin = 0; xmax = Math.max(100, Math.ceil(((S.vmax || 0) + 10) / 50) * 50); step = 50; unit = 'kt'; }
        else if (mode === 'inflow') {
            key = 'vr'; var lo = -10, hi = 10;
            S.lv.forEach(function (r) { if (r.vr != null) { lo = Math.min(lo, r.vr); hi = Math.max(hi, r.vr); } });
            xmin = Math.floor((lo - 5) / 20) * 20; xmax = Math.max(20, Math.ceil((hi + 5) / 20) * 20); step = 20; unit = 'kt';
        } else {
            key = 'the'; xmin = 340; xmax = 380;
            S.lv.forEach(function (r) { if (r.the != null) { xmin = Math.min(xmin, Math.floor((r.the - 3) / 10) * 10); xmax = Math.max(xmax, Math.ceil((r.the + 3) / 10) * 10); } });
            step = 10; unit = 'K';
        }
        if (pw / ((xmax - xmin) / step) < 60) step *= 2;
        xmin = Math.floor(xmin / step) * step; xmax = Math.ceil(xmax / step) * step;
        function X(v) { return m.l + (v - xmin) / (xmax - xmin) * pw; }

        for (var z = 0; z <= zmax; z += 1000) {
            el('line', { x1: m.l, x2: m.l + pw, y1: Y(z), y2: Y(z), stroke: tok('--sv2-rule') }, root);
            el('text', { x: m.l - 8, y: Y(z) + 4, 'text-anchor': 'end', 'font-size': 11, fill: tok('--slate') }, root, z / 1000);
        }
        el('text', { x: m.l - 8, y: m.t - 10, 'text-anchor': 'end', 'font-size': 10, fill: tok('--sv2-muted') }, root, 'km');
        for (var v = xmin; v <= xmax; v += step) {
            var last = v + step > xmax;
            el('text', { x: last ? m.l + pw : X(v), y: m.t + ph + 18, 'text-anchor': last ? 'end' : 'middle', 'font-size': 11, fill: tok('--slate') }, root, v + (last ? ' ' + unit : ''));
        }
        el('line', { x1: m.l, x2: m.l + pw, y1: Y(0), y2: Y(0), stroke: tok('--sv2-rule2') }, root);

        var pts = S.lv.filter(function (r) { return r[key] != null && r.z <= zmax; });
        if (pts.length < 2) {
            el('text', { x: m.l + pw / 2, y: m.t + ph / 2, 'text-anchor': 'middle', 'font-size': 12, fill: tok('--slate') }, root, 'Not measured in this sounding');
            return;
        }
        var d = pts.map(function (r, i) { return (i ? 'L' : 'M') + X(r[key]).toFixed(1) + ',' + Y(r.z).toFixed(1); }).join('');
        var pl = Placer(root, [m.l, m.t - 12, W - 2, m.t + ph + 4]);
        pl.path(pts.map(function (r) { return [X(r[key]), Y(r.z)]; }));

        if (mode === 'wind') {
            el('rect', { x: m.l, y: Y(150), width: pw, height: Y(0) - Y(150), fill: tok('--sv2-band') }, root);
            var grad = windGradient(root, X(0), X(xmax), xmax);
            el('path', { d: d + 'L' + X(0) + ',' + Y(pts[pts.length - 1].z) + 'L' + X(0) + ',' + Y(pts[0].z) + 'Z', fill: grad, 'fill-opacity': 0.22 }, root);
            el('path', { d: d, fill: 'none', stroke: grad, 'stroke-width': 2.4, 'stroke-linejoin': 'round' }, root);
            if (S.vmax != null && S.vmaxz != null && S.vmaxz <= zmax) {
                var px = X(S.vmax), py = Y(S.vmaxz);
                el('circle', { cx: px, cy: py, r: 5, fill: wc(S.vmax), stroke: tok('--surface'), 'stroke-width': 2 }, root);
                pl.block(px - 6, py - 6, px + 6, py + 6);
                var pc = [];
                [4, -10, 18, -24, 32, -38, 46].forEach(function (dy) { pc.push([px + 11, py + dy, 'start']); pc.push([px - 11, py + dy, 'end']); });
                [-14, -28, -42].forEach(function (dy) { pc.push([px, py + dy, 'middle']); });
                pl.label(['peak ' + Math.round(S.vmax) + ' kt', Math.round(S.vmax) + ' kt'], { 'class': 'sv2-ann', 'font-size': 12, 'font-weight': 600, fill: tok('--text') }, pc);
            }
            pl.label('lowest 150 m', { 'class': 'sv2-ann', 'font-size': 10.5, fill: tok('--slate') },
                [[m.l + 6, Y(0) - 4, 'start'], [m.l + pw - 6, Y(0) - 4, 'end'], [m.l + 6, Y(150) - 5, 'start'], [m.l + pw - 6, Y(150) - 5, 'end']]);
        } else if (mode === 'inflow') {
            var inC = tok('--sv2-inflow');
            el('line', { x1: X(0), x2: X(0), y1: m.t, y2: m.t + ph, stroke: tok('--sv2-rule2') }, root);
            var dIn = 'M' + X(0) + ',' + Y(pts[0].z);
            pts.forEach(function (r) { dIn += 'L' + X(Math.min(0, r.vr)).toFixed(1) + ',' + Y(r.z).toFixed(1); });
            el('path', { d: dIn + 'L' + X(0) + ',' + Y(pts[pts.length - 1].z) + 'Z', fill: inC, 'fill-opacity': 0.25 }, root);
            el('path', { d: d, fill: 'none', stroke: inC, 'stroke-width': 2.2 }, root);
            pl.path([[X(0), m.t], [X(0), m.t + ph]]);
            if (S.inflowTop != null && S.inflowTop <= zmax) {
                var yi = Y(S.inflowTop), inTop = Math.round(S.inflowTop / 10) * 10 + ' m';
                el('line', { x1: m.l, x2: m.l + pw, y1: yi, y2: yi, stroke: inC, 'stroke-dasharray': '3 3', 'stroke-opacity': 0.8 }, root);
                pl.label(['top of inflow ' + inTop, 'inflow top ' + inTop, inTop], { 'class': 'sv2-ann', 'font-size': 11, 'font-weight': 600, fill: inC },
                    [[m.l + pw - 4, yi - 6, 'end'], [m.l + 4, yi - 6, 'start'], [m.l + pw - 4, yi + 15, 'end'], [m.l + 4, yi + 15, 'start'], [m.l + pw / 2, yi - 6, 'middle'], [m.l + pw / 2, yi + 15, 'middle']]);
                pl.path([[m.l, yi], [m.l + pw, yi]]);
            }
            var ys = [0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72].map(function (f) { return m.t + 10 + f * ph; });
            pl.label('← inflow', { 'class': 'sv2-ann', 'font-size': 10.5, fill: tok('--slate') },
                ys.map(function (y) { return [X(0) - 6, y, 'end']; }).concat(ys.map(function (y) { return [m.l + 4, y, 'start']; })));
            pl.label('outflow →', { 'class': 'sv2-ann', 'font-size': 10.5, fill: tok('--slate') },
                ys.map(function (y) { return [X(0) + 6, y, 'start']; }).concat(ys.map(function (y) { return [m.l + pw - 4, y, 'end']; })));
        } else {
            el('path', { d: d, fill: 'none', stroke: tok('--text'), 'stroke-width': 2.2 }, root);
        }

        // hover: one dot + a tooltip, no permanent readout
        var hl = el('line', { x1: m.l, x2: m.l + pw, y1: -9, y2: -9, stroke: tok('--sv2-rule2') }, root);
        var hd = el('circle', { cx: -9, cy: -9, r: 4, fill: tok('--text'), stroke: tok('--surface'), 'stroke-width': 2 }, root);
        var hit = el('rect', { x: 0, y: m.t, width: W, height: ph, fill: 'transparent' }, root);
        function mv(ev) {
            var rr = root.getBoundingClientRect(), sy = (ev.clientY - rr.top) * (H / rr.height);
            var r = S.lv[levelAtZ(S.lv, Math.max(0, Math.min(zmax, (1 - (sy - m.t) / ph) * zmax)))];
            var y = Y(r.z); hl.setAttribute('y1', y); hl.setAttribute('y2', y);
            if (r[key] != null) { hd.setAttribute('cx', X(r[key])); hd.setAttribute('cy', y); } else hd.setAttribute('cx', -9);
            var val = mode === 'wind' ? (r.ws != null ? '<b>' + Math.round(r.ws) + ' kt</b>' + (r.wd != null ? ' <span>from ' + String(Math.round(r.wd)).padStart(3, '0') + '°</span>' : '') : '–')
                : mode === 'inflow' ? (r.vr != null ? '<b>' + Math.abs(Math.round(r.vr)) + ' kt ' + (r.vr < 0 ? 'inward' : 'outward') + '</b>' : '–')
                : (r.the != null ? '<b>θe ' + Math.round(r.the) + ' K</b>' : '–');
            showTip('<span>' + Math.round(r.z) + ' m · ' + r1(r.p) + ' hPa</span>&nbsp; ' + val, ev);
        }
        hit.addEventListener('pointermove', mv); hit.addEventListener('pointerdown', mv);
        hit.addEventListener('pointerleave', function () { hideTip(); hl.setAttribute('y1', -9); hl.setAttribute('y2', -9); hd.setAttribute('cx', -9); });
    }

    function driftChart(box, S) {
        var W = box.clientWidth || 520, H = Math.round(Math.max(260, Math.min(360, W * 0.56)));
        var root = svg(W, H, box, 'Drift of this sonde around the storm center');
        var rmw = S.rmw || 0;
        var ext = Math.max(12, Math.max(S.r_rel, S.r_spl, rmw) + 5), cx = W / 2, cy = H / 2, sc = Math.min(W, H) / 2 / ext;
        function P(x, y) { return [cx + x * sc, cy - y * sc]; }
        if (rmw) el('circle', { cx: cx, cy: cy, r: rmw * sc, fill: 'none', stroke: tok('--sv2-rule2'), 'stroke-dasharray': '4 4' }, root);
        el('path', { d: 'M' + (cx - 6) + ',' + cy + 'h12M' + cx + ',' + (cy - 6) + 'v12', stroke: tok('--slate'), 'stroke-width': 1.5 }, root);
        colorRuns(root, S.lv, function (r) { return P(r.x, r.y); }, 4);
        var L = S.lv, a = P(L[L.length - 1].x, L[L.length - 1].y), b = P(L[0].x, L[0].y);
        el('circle', { cx: a[0], cy: a[1], r: 5, fill: tok('--surface'), stroke: tok('--text'), 'stroke-width': 1.5 }, root);
        el('circle', { cx: b[0], cy: b[1], r: 6, fill: wc(S.wl150), stroke: tok('--surface'), 'stroke-width': 2 }, root);
        var pl = Placer(root, [0, 0, W, H], 4);
        pl.path(L.map(function (r) { return P(r.x, r.y); }));
        pl.block(a[0] - 6, a[1] - 6, a[0] + 6, a[1] + 6); pl.block(b[0] - 7, b[1] - 7, b[0] + 7, b[1] + 7); pl.block(cx - 7, cy - 7, cx + 7, cy + 7);
        function around(p, g) { return [[p[0] + g, p[1] + 4, 'start'], [p[0] - g, p[1] + 4, 'end'], [p[0], p[1] - g, 'middle'], [p[0], p[1] + g + 10, 'middle'], [p[0] + g, p[1] - g, 'start'], [p[0] - g, p[1] - g, 'end'], [p[0] + g, p[1] + g + 8, 'start'], [p[0] - g, p[1] + g + 8, 'end']]; }
        pl.label('splash', { 'class': 'sv2-ann', 'font-size': 11, 'font-weight': 600, fill: tok('--text') }, around(b, 13));
        pl.label('released', { 'class': 'sv2-ann', 'font-size': 11, fill: tok('--slate') }, around(a, 12));
        pl.label('center', { 'class': 'sv2-ann', 'font-size': 10.5, fill: tok('--sv2-muted') }, around([cx, cy], 11));
        if (rmw) {
            var rr = rmw * sc * 0.7071;
            pl.label('RMW', { 'class': 'sv2-ann', 'font-size': 10.5, fill: tok('--slate') }, [[cx + rr + 5, cy - rr - 5, 'start'], [cx - rr - 5, cy - rr - 5, 'end'], [cx + rr + 5, cy + rr + 14, 'start'], [cx - rr - 5, cy + rr + 14, 'end']]);
        }
        pl.label('N ↑', { 'font-size': 10.5, fill: tok('--sv2-muted') }, [[W - 4, 14, 'end'], [4, 14, 'start'], [W - 4, H - 6, 'end']]);
    }

    function mini(S, W, H) {
        var root = svg(W, H, null, 'wind profile');
        var zmax = 3200, vmax = 200;
        function X(v) { return 1 + Math.min(v, vmax) / vmax * (W - 2); }
        function Y(z) { return 1 + (H - 2) * (1 - Math.min(z, zmax) / zmax); }
        var grad = windGradient(root, X(0), X(vmax), vmax);
        var pts = S.lv.filter(function (r) { return r.ws != null; });
        if (pts.length > 1) {
            var d = pts.map(function (r, i) { return (i ? 'L' : 'M') + X(r.ws).toFixed(1) + ',' + Y(r.z).toFixed(1); }).join('');
            el('path', { d: d + 'L' + X(0) + ',' + Y(pts[pts.length - 1].z) + 'L' + X(0) + ',' + Y(pts[0].z) + 'Z', fill: grad, 'fill-opacity': 0.22 }, root);
            el('path', { d: d, fill: 'none', stroke: grad, 'stroke-width': 1.6 }, root);
        }
        el('line', { x1: 0, x2: W, y1: Y(0), y2: Y(0), stroke: tok('--sv2-rule2') }, root);
        return root;
    }

    // ── hires fetch cache ───────────────────────────────────────────────
    var _hiresCache = {};      // id -> Promise<json|null>
    function fetchHires(apiBase, id) {
        if (!_hiresCache[id]) {
            _hiresCache[id] = fetch(apiBase + '/recon/sonde-hires?id=' + encodeURIComponent(id))
                .then(function (r) { return r.ok ? r.json() : null; })
                .catch(function () { delete _hiresCache[id]; return null; });
        }
        return _hiresCache[id];
    }
    // Is the BUFR sounding the same drop as this TEMP DROP? Compare the coded
    // mandatory-level winds with the 1-s profile at those pressures (median
    // |Δ| ≤ max(12 kt, 25 %)). This beats the legacy 62626-MBL comparison,
    // which rejected the RIGHT twin whenever the MBL group decoded wrong (the
    // ≥100-kt hundreds-digit fold, e.g. Polo OB 29: MBL 55 vs 158 kt). Falls
    // back to that MBL check only when no mandatory winds are coded.
    function twinOk(sonde, h) {
        if (!h || !h.levels) return false;
        var lv = h.levels, mand = ((sonde.profile || {}).mandatory || []).filter(function (L) { return L.p != null && L.wspd != null && L.wspd <= 250; });
        var diffs = [];
        mand.forEach(function (L) {
            for (var i = 0; i < lv.p_hpa.length - 1; i++) {
                var p0 = lv.p_hpa[i], p1 = lv.p_hpa[i + 1], w0 = lv.wspd_kt[i], w1 = lv.wspd_kt[i + 1];
                if (p0 == null || p1 == null || w0 == null || w1 == null || (p0 - L.p) * (p1 - L.p) > 0) continue;
                var w = p0 === p1 ? w0 : w0 + (L.p - p0) / (p1 - p0) * (w1 - w0);
                diffs.push([Math.abs(w - L.wspd), Math.max(w, L.wspd)]); break;
            }
        });
        if (diffs.length) {
            diffs.sort(function (x, y) { return x[0] - y[0]; });
            var md = diffs[Math.floor(diffs.length / 2)];
            return md[0] <= Math.max(12, 0.25 * md[1]);
        }
        var a = sonde.mbl_wind_kt, b = h.mbl_kt;
        if (a == null || b == null || Math.max(a, b) < 25) return true;
        return Math.abs(a - b) <= Math.max(15, 0.4 * Math.max(a, b));
    }

    // ── popup glance (replaces the text table) ──────────────────────────
    function headline(sonde) {
        var h = sonde.hires || {};
        return h.wl150_kt != null ? h.wl150_kt : sonde.sfc_wind_kt;
    }
    function glanceHTML(sonde, key, tailName, fmtTime) {
        var h = sonde.hires || {}, wl = headline(sonde);
        var mbl = h.mbl_kt != null ? h.mbl_kt : sonde.mbl_wind_kt;
        var pk = h.max_wind_kt;
        var has = !!(h.id || (sonde.profile && sonde.profile.mandatory && sonde.profile.mandatory.length));
        return '<div class="sv2-glance">' +
            '<div class="sv2-glance-who"><span class="sv2-diamond"></span>' + esc(obLabel(sonde.ob) || 'Dropsonde') +
                ' · ' + esc(tailName ? tailName(sonde.tail) : sonde.tail || '') + ' · ' + esc(hhmm(sonde.t)) + '</div>' +
            // map popups are always white, whatever the site theme → light-theme ramp
            '<div class="sv2-glance-num"' + (wl != null ? ' style="color:' + wc(wl, true) + '"' : '') + '>' + r0(wl) + '<small>kt</small></div>' +
            '<div class="sv2-glance-lab">WL150 · lowest 150 m</div>' +
            '<div class="sv2-glance-sub">' + (mbl != null ? 'MBL <b>' + r0(mbl) + '</b>' : '') + (pk != null ? ' · peak <b>' + r0(pk) + '</b> kt' : (mbl != null ? ' kt' : '')) + '</div>' +
            (has ? '<button type="button" class="sv2-open" onclick="window._reconShowSkewT(\'' + String(key).replace(/'/g, "\\'") + '\')">Open sonde</button>' : '') +
            '</div>';
    }

    // ── the card ────────────────────────────────────────────────────────
    var CAPS = {
        wind: function (S) { return 'Wind speed from release to the sea. Mean in the lowest 500 m: <b>' + r0(S.mbl) + ' kt</b>.'; },
        inflow: function (S) { return 'Air moving toward the center. <b>' + Math.abs(r0(S.vr0)) + ' kt inward</b> at the surface' + (S.inflowTop ? ', inflow layer <b>' + Math.round(S.inflowTop / 10) * 10 + ' m</b> deep.' : '.'); },
        thermo: function (S) { var b = S.lv.filter(function (r) { return r.the != null; })[0]; return 'Equivalent potential temperature. <b>' + r0(b && b.the) + ' K</b> at the surface.'; },
        drift: function (S) { return 'Fell for <b>' + r0(S.fall) + ' s</b> and drifted <b>' + r1(S.drift) + ' km</b>' + (Math.abs(S.dAng) >= 5 ? ', ' + Math.abs(Math.round(S.dAng)) + '° ' + (S.dAng > 0 ? 'cyclonically' : 'anticyclonically') + ' around the center' : '') + '.'; },
        skewt: function (S) { return S.src === 'hires' ? 'The classic skew-T of the same 1-s sounding.' : 'The classic skew-T of the coded TEMP DROP levels.'; }
    };
    var cur = null;            // { opts, S, mode }
    var mode = 'wind';

    function modeOk(md, S) {
        if (md === 'inflow') return S.hasPos && !S.eye;
        if (md === 'drift') return S.hasPos;
        return true;
    }
    function renderChart() {
        if (!cur) return;
        var S = cur.S, box = cur.body.querySelector('.sv2-chart');
        if (!modeOk(mode, S)) mode = 'wind';
        box.innerHTML = ''; hideTip();
        if (mode === 'skewt') {
            box.innerHTML = '<div id="sv2-skewt" style="width:100%;height:' + Math.round(Math.max(300, Math.min(420, box.clientWidth * 0.7))) + 'px;"></div>';
            if (cur.opts.renderSkewT) {
                // Fit the pressure axis to this drop (splash → just above release) and
                // dress the shared skew-T in the card's tokens instead of its own chrome.
                var ps = S.lv.map(function (r) { return r.p; }).filter(function (p) { return p != null; });
                var pLo = Math.min.apply(null, ps), pHi = Math.max.apply(null, ps);
                var pBot = Math.min(1060, Math.ceil((pHi + 15) / 10) * 10);
                cur.opts.renderSkewT('sv2-skewt', cur.hires, {
                    pTop: Math.max(100, Math.floor((pLo - 25) / 50) * 50),
                    pBottom: pBot,
                    style: { noTitle: true, font: "'JetBrains Mono', ui-monospace, Menlo, monospace",
                             axisColor: tok('--slate'), textColor: tok('--text'), plotBg: 'rgba(0,0,0,0)',
                             legendBg: tok('--surface'), legendBorder: tok('--sv2-rule2'),
                             margin: { l: 44, r: 8, t: 8, b: 34 }, pTicks: [1000, 950, 900, 850, 800, 750, 700, 650, 600, 500, 400, 300]
                                 .filter(function (v) { return v <= pBot - 12; }) }   // none on the bottom edge (collides with the °C labels)
                });
            }
        } else if (mode === 'drift') driftChart(box, S);
        else profileChart(box, S, mode);
        cur.body.querySelectorAll('.sv2-seg button').forEach(function (b) {
            var md = b.getAttribute('data-m');
            b.setAttribute('aria-pressed', md === mode ? 'true' : 'false');
            b.disabled = !modeOk(md, S);
            b.title = b.disabled ? (md === 'inflow' && S.eye ? 'Eye drop: too close to the center for inflow' : 'Needs the full-resolution sounding and a center fix') : '';
        });
        cur.body.querySelector('.sv2-caption').innerHTML = CAPS[mode](S);
    }
    function renderHead() {
        var S = cur.S, o = cur.opts, sonde = o.sonde;
        var who = ['<b>' + esc(obLabel(S.ob) || 'Dropsonde') + '</b>', esc(o.tailName ? o.tailName(sonde.tail) : sonde.tail || ''), esc(hhmm(S.t))];
        if (S.cls) who.push(esc(S.cls));
        if (S.hasPos) who.push(r0(S.r_spl) + ' km from center');
        cur.body.querySelector('.sv2-who').innerHTML = who.map(function (x) { return '<span>' + x + '</span>'; }).join('');
        cur.body.querySelector('.sv2-num').innerHTML = '<span style="color:' + wc(S.wl150) + '">' + r0(S.wl150) + '</span><small>kt</small>';
        cur.body.querySelector('.sv2-second').innerHTML =
            (S.vmax != null ? '<span>peak <b>' + r0(S.vmax) + ' kt</b>' + (S.vmaxz != null ? ' at ' + r0(S.vmaxz) + ' m' : '') + '</span>' : '') +
            (S.sfcp != null ? '<span>splash <b>' + r1(S.sfcp) + ' hPa</b></span>' : '');
        cur.body.querySelector('.sv2-src').textContent = S.src === 'hires'
            ? 'Full-resolution sounding (NWS BUFR), ' + S.n + ' levels'
            : 'Coded TEMP DROP levels' + (sonde.hires && sonde.hires.id ? ' · loading the full-resolution sounding…' : '');
    }
    function renderTiles() {
        var o = cur.opts, g = cur.body.querySelector('.sv2-tiles');
        var list = (o.flight || []).slice(), sv = o.sortVar;
        // Same variable as the map's "Sonde color": strongest first (missing last).
        if (sv) list.sort(function (a, b) {
            var x = sv.value(a.sonde), y = sv.value(b.sonde);
            if (x == null) return y == null ? 0 : 1; if (y == null) return -1;
            return sv.asc ? x - y : y - x;
        });
        cur.body.querySelector('.sv2-flight-h').innerHTML = 'This flight <span>' + list.length + ' sondes · ' +
            esc(o.tailName ? o.tailName(o.sonde.tail) : o.sonde.tail || '') + (sv ? ' · by ' + esc(sv.label) : ' · by time') + '</span>';
        g.innerHTML = '';
        list.forEach(function (it) {
            var s = it.sonde, wl = headline(s);
            var b = document.createElement('button'); b.type = 'button'; b.className = 'sv2-tile';
            if (it.key === o.key) b.setAttribute('aria-current', 'true');
            b.innerHTML = '<div class="sv2-t1"><span>' + esc(obLabel(s.ob) || '—') + '</span><span>' + esc(hhmm(s.t)) + '</span></div>' +
                '<div class="sv2-tn"' + (wl != null ? ' style="color:' + wc(wl) + '"' : '') + '>' + r0(wl) + '</div><div class="sv2-tm"></div>';
            g.appendChild(b);
            b.addEventListener('click', function () { if (o.onPick) o.onPick(it.key); });
            var host = b.querySelector('.sv2-tm');
            function draw(S2) { if (S2 && S2.lv.length > 1) { host.innerHTML = ''; host.appendChild(mini(S2, 92, 40)); } }
            var td = fromTempDrop(s);
            if (td) draw(td);
            if (s.hires && s.hires.id) fetchHires(o.apiBase, s.hires.id).then(function (h) {
                if (h && h.levels && twinOk(s, h) && cur && cur.opts === o) draw(fromHires(h, s, null));
            });
        });
        var sel = g.querySelector('[aria-current="true"]');
        if (sel && sel.scrollIntoView) { try { sel.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) {} }
    }

    function open(opts) {
        var modal = opts.modal, content = modal.querySelector('.recon-skewt-content'), body = modal.querySelector('.recon-skewt-body');
        _tokEl = content;
        content.classList.add('sv2-on');
        modal.querySelector('.recon-skewt-title').textContent = 'Dropsonde';
        body.innerHTML =
            '<div class="sv2">' +
            '<div class="sv2-who"></div>' +
            '<div class="sv2-head"><div><div class="sv2-num"></div><div class="sv2-numlab">WL150 · mean wind in the lowest 150 m</div></div><div class="sv2-second"></div></div>' +
            '<div class="sv2-chart"></div>' +
            '<div class="sv2-seg" role="group" aria-label="What to show">' +
                '<button type="button" data-m="wind">Wind</button><button type="button" data-m="inflow">Inflow</button>' +
                '<button type="button" data-m="thermo">θe</button><button type="button" data-m="drift">Drift</button>' +
                '<button type="button" data-m="skewt">Skew-T</button></div>' +
            '<div class="sv2-caption"></div>' +
            '<div class="sv2-src"></div>' +
            '<div class="sv2-flight"><div class="sv2-flight-h"></div><div class="sv2-tiles"></div></div>' +
            '</div>';
        var center = centerFn(opts.vdms);
        var S = fromTempDrop(opts.sonde);
        cur = { opts: opts, body: body, S: S || { src: 'tempdrop', t: opts.sonde.t, ob: opts.sonde.ob, lv: [], n: 0, wl150: opts.sonde.sfc_wind_kt, mbl: opts.sonde.mbl_wind_kt }, hires: null };
        body.querySelectorAll('.sv2-seg button').forEach(function (b) {
            b.addEventListener('click', function () { if (b.disabled) return; mode = b.getAttribute('data-m'); renderChart(); });
        });
        modal.style.display = 'flex';
        // Lay out first, then measure (setTimeout, not rAF: rAF can stall in a hidden tab).
        setTimeout(function () {
            if (!cur || cur.opts !== opts) return;
            renderHead();
            if (cur.S.lv.length) renderChart(); else body.querySelector('.sv2-chart').innerHTML = '<div class="sv2-wait">Loading the full-resolution sounding…</div>';
            renderTiles();
        }, 0);
        var hr = opts.sonde.hires;
        if (hr && hr.id) {
            fetchHires(opts.apiBase, hr.id).then(function (h) {
                if (!cur || cur.opts !== opts || !h || !h.levels) { if (cur && cur.opts === opts) renderHead(); return; }
                if (!twinOk(opts.sonde, h)) { console.warn('[SondeCard] hi-res twin rejected: MBL ' + opts.sonde.mbl_wind_kt + ' vs ' + h.mbl_kt + ' kt'); renderHead(); return; }
                cur.S = fromHires(h, opts.sonde, center); cur.hires = h;
                renderHead(); renderChart();
            });
        }
    }
    function close() { cur = null; hideTip(); }

    var _rt; window.addEventListener('resize', function () { clearTimeout(_rt); _rt = setTimeout(function () { if (cur && cur.S.lv.length) renderChart(); }, 150); });

    window.SondeCard = { on: ON, glanceHTML: glanceHTML, open: open, close: close };
})();
