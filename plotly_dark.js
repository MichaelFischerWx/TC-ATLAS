/* plotly_dark.js — dark theme for charts drawn with light-theme literals.

   The Recon tab's charts (realtime_tdr.js and the shared tdr_view.js
   figures) were written for the light theme: white paper, #0f1623 titles,
   #5b6573 axes, rgba(15,22,35,a) grids. In dark mode they drew as white
   panels. This is the same mapping TC-RADAR's tc_radar_app.js applies in
   tcrNewPlot / tcrReact: light backgrounds under *bgcolor keys and dark
   "ink" under every other color key are swapped in dark mode, while data
   colors, colorscales and white/black marker outlines are left alone. Each
   chart keeps the colors it was drawn with, so a theme toggle re-colors it
   either way.

   Use TCAPlotDark.newPlot / .react in place of Plotly.newPlot / .react. */
(function () {
    'use strict';

    function isDark() {
        return document.documentElement.getAttribute('data-theme') === 'dark';
    }
    function darkColor(v, isBg, inTrace) {
        if (typeof v !== 'string') return v;
        var k = v.replace(/\s+/g, '').toLowerCase(), m;
        if (isBg) {
            if (inTrace) return v;
            if (k === '#ffffff' || k === '#fff' || k === 'white' || k === 'rgb(255,255,255)') {
                return (window.TCATheme && TCATheme.readVar('--plot-paper')) || '#0a0e14';
            }
            if (k === 'rgba(247,248,250,0.85)') return 'rgba(22,27,36,0.85)';
            if ((m = /^rgba\(255,255,255,([\d.]+)\)$/.exec(k))) return 'rgba(22,27,36,' + m[1] + ')';
            return v;
        }
        if (k === '#0f1623') return '#e6e8eb';
        if (k === '#5b6573') return '#8a93a3';
        if (k === '#6b7280' || k === '#64748b') return '#9ca3af';
        if (k === '#475569' || k === '#334155') return '#cbd5e1';
        if ((m = /^rgba\(15,22,35,([\d.]+)\)$/.exec(k))) return 'rgba(230,232,235,' + m[1] + ')';
        if (!inTrace && (k === '#000' || k === '#000000' || k === 'black')) return '#e6e8eb';
        return v;
    }
    // Copy-on-write walk: returns obj itself when nothing changed, so trace
    // data arrays are shared, never copied.
    function mapColors(obj, inTrace, depth) {
        if (!obj || typeof obj !== 'object' || depth > 8 || ArrayBuffer.isView(obj)) return obj;
        if (Array.isArray(obj)) {
            if (!obj.length || typeof obj[0] !== 'object') return obj;
            var outA = null;
            for (var i = 0; i < obj.length; i++) {
                var mi = mapColors(obj[i], inTrace, depth + 1);
                if (mi !== obj[i]) { if (!outA) outA = obj.slice(); outA[i] = mi; }
            }
            return outA || obj;
        }
        var out = null;
        for (var key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key) || key === 'colorscale') continue;
            var v = obj[key], mv = v;
            if (/color$/i.test(key)) {
                var isBg = /bgcolor$/i.test(key);
                if (typeof v === 'string') mv = darkColor(v, isBg, inTrace);
                else if (Array.isArray(v) && typeof v[0] === 'string') {
                    var changed = false;
                    var arr = v.map(function (c) { var d = darkColor(c, isBg, inTrace); if (d !== c) changed = true; return d; });
                    if (changed) mv = arr;
                }
            } else if (v && typeof v === 'object') {
                mv = mapColors(v, inTrace, depth + 1);
            }
            if (mv !== v) { if (!out) out = Object.assign({}, obj); out[key] = mv; }
        }
        return out || obj;
    }
    function themeArgs(el, traces, layout) {
        var node = (typeof el === 'string') ? document.getElementById(el) : el;
        // Snapshot the light-theme colors as {path: value} so a later toggle can
        // re-color either way. Not the objects themselves: Plotly keeps and
        // mutates the layout/traces it is given, so a dark relayout would
        // overwrite them.
        if (node) node._tcaDarkSrc = {
            layout: colorPaths(layout, '', {}, 0),
            traces: (traces || []).map(function (t) { return colorPaths(t, '', {}, 0); })
        };
        if (!isDark()) return [traces, layout];
        return [(traces || []).map(function (t) { return mapColors(t, true, 0); }),
                mapColors(layout, false, 0)];
    }
    // Flat {path: value} of every color in obj, for Plotly.relayout/restyle.
    function colorPaths(obj, prefix, out, depth) {
        if (!obj || typeof obj !== 'object' || depth > 8 || ArrayBuffer.isView(obj)) return out;
        if (Array.isArray(obj)) {
            if (obj.length && typeof obj[0] === 'object') {
                for (var i = 0; i < obj.length; i++) colorPaths(obj[i], prefix + '[' + i + ']', out, depth + 1);
            }
            return out;
        }
        for (var key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key) || key === 'colorscale') continue;
            var p = prefix ? prefix + '.' + key : key, v = obj[key];
            if (/color$/i.test(key) && typeof v === 'string') out[p] = v;
            else if (/color$/i.test(key) && Array.isArray(v) && typeof v[0] === 'string') out[p] = v.slice();
            else if (v && typeof v === 'object') colorPaths(v, p, out, depth + 1);
        }
        return out;
    }
    function pathColor(path, v, inTrace, dark) {
        if (!dark) return v;
        var isBg = /bgcolor$/i.test(path);
        return Array.isArray(v)
            ? v.map(function (c) { return darkColor(c, isBg, inTrace); })
            : darkColor(v, isBg, inTrace);
    }
    document.documentElement.addEventListener('theme:change', function () {
        if (typeof Plotly === 'undefined') return;
        var dark = isDark();
        document.querySelectorAll('.js-plotly-plot').forEach(function (node) {
            var src = node._tcaDarkSrc;
            if (!src || !node._fullLayout) return;
            try {
                var lay = {}, p;
                for (p in src.layout) lay[p] = pathColor(p, src.layout[p], false, dark);
                if (Object.keys(lay).length) Plotly.relayout(node, lay);
                src.traces.forEach(function (tp, i) {
                    var upd = {};
                    for (var q in tp) upd[q] = [pathColor(q, tp[q], true, dark)];
                    if (Object.keys(upd).length) Plotly.restyle(node, upd, [i]);
                });
            } catch (e) { /* chart re-renders with the right colors on its next draw */ }
        });
    });

    function newPlot(el, traces, layout, config) {
        var t = themeArgs(el, traces, layout);
        return Plotly.newPlot(el, t[0], t[1], config);
    }
    function react(el, traces, layout, config) {
        var t = themeArgs(el, traces, layout);
        return Plotly.react(el, t[0], t[1], config);
    }

    window.TCAPlotDark = { newPlot: newPlot, react: react };
})();
