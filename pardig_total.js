/* ══════════════════════════════════════════════════════════════
   PardigTotal — storm-total rain from Google DeepMind PARDIG (CC BY 4.0),
   shared by the RT monitor storm card (realtime_ir.js) and the Global
   Archive detail map (global_archive.js).

   Data (built by pardig_storm_totals.py / build_pardig_archive.py):
     <base>/index.json        grid edges, encoding, coverage, series, credit
     <base>/total-<sha>.png   8-bit index grid, north-up, equirectangular 0.1°
   Index: 0 outside the swath, 1 below min_mm, 2..254 log bins over
   [min_mm, max_mm), 255 at or above max_mm.

   Drawn through the Leaflet-API GL facade (lflet_gl.js): the PNG is
   re-projected to Web Mercator here (an equirectangular image stretched
   over Mercator bounds lands degrees off) and added as ONE image overlay,
   even over the antimeridian, where its longitudes run past ±180 with the
   center kept inside ±180 (two halves leave a seam at the facade's ±179.99
   inset).
   ══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // Same 22-color ramp as the RT monitor's PARDIG rain-rate legend, binned
    // for totals (mm); white = the top bin.
    var COLORS = [[67, 122, 205, 85], [62, 127, 218, 120], [54, 135, 229, 154], [44, 145, 236, 179],
        [37, 161, 213, 197], [32, 181, 168, 209], [49, 195, 130, 218], [83, 204, 96, 223],
        [109, 211, 70, 228], [151, 215, 55, 232], [216, 215, 45, 237], [250, 198, 38, 241],
        [250, 170, 34, 244], [250, 143, 31, 246], [246, 113, 32, 248], [238, 82, 38, 250],
        [232, 56, 42, 251], [224, 44, 66, 252], [209, 41, 124, 254], [188, 46, 175, 255],
        [163, 61, 210, 255], [255, 255, 255, 255]];
    var EDGES = [5, 10, 15, 20, 30, 40, 50, 65, 80, 100, 125, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1250, 1500];
    var TICKS = [[5, 0], [20, 3], [50, 6], [100, 9], [250, 13], [1000, 19]];   // clear at a 150-px legend
    // Rain RATE (mm/h): the RT monitor's Rain-mode bins; white = the 75 mm/h cap.
    var RATE_EDGES = [0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7, 10, 13, 16, 20, 25, 30, 35, 40, 50, 60, 74.9];
    var RATE_TICKS = [['0.2', 0], ['1', 4], ['5', 9], ['20', 14], ['50', 19], ['75', 21]];
    // Inches under the same bar (2026-11-16): one bar, two scales -- mm above, inches below -- rather than a unit
    // toggle, so every reader (and every saved figure) gets both without a setting to carry around. Round inch
    // values placed where they fall inside the bins (barPos), not mm ticks relabeled.
    var MM_PER_IN = 25.4;
    var IN_TICKS = [1, 2, 5, 10, 20, 40];              // storm total, in
    var RATE_IN_TICKS = [0.01, 0.1, 0.5, 1, 2];        // rain rate, in/h

    /** Where v (mm or mm/h) sits along a bar of equal-width bins, 0..1: bin k spans [edges[k], edges[k+1]),
     *  log-spaced inside the bin; the last bin is the open-ended top (white). */
    function barPos(v, edges) {
        var n = edges.length;
        if (v <= edges[0]) return 0;
        for (var k = 0; k < n - 1; k++) {
            if (v < edges[k + 1]) return (k + Math.log(v / edges[k]) / Math.log(edges[k + 1] / edges[k])) / n;
        }
        return (n - 1) / n;
    }

    /** mm (or mm/h) -> inches as text: 2 decimals under 1, 1 under 10, whole numbers above. */
    function inText(mm) {
        var v = mm / MM_PER_IN;
        return v < 1 ? v.toFixed(2) : (v < 10 ? v.toFixed(1) : String(Math.round(v)));
    }

    function idxToMm(i, enc) {
        enc = enc || {};
        var lo = enc.min_mm || 1, hi = enc.max_mm || 3000, n = enc.bins || 253;
        if (i <= 0) return null;          // outside the swath
        if (i === 1) return 0;            // inside, below min_mm
        if (i >= 255) return hi;
        return lo * Math.pow(hi / lo, (i - 2 + 0.5) / n);
    }

    /** Rate index (frames.json-style: 0 nodata, 1 dry, 2..254 log over
     *  [dry, cap), 255 at the cap) -> mm/h (bin geometric center). */
    function idxToRate(i, enc) {
        enc = enc || {};
        var dry = enc.dry_mm_h || 0.1, cap = enc.cap_mm_h || 75, n = enc.bins || 253;
        if (i <= 0) return null;
        if (i === 1) return 0;
        if (i >= 255) return cap;
        return dry * Math.pow(cap / dry, (i - 2 + 0.5) / n);
    }

    function lut(enc, kind) {
        var out = new Uint8ClampedArray(256 * 4), rate = kind === 'rate';
        var edges = rate ? RATE_EDGES : EDGES;
        for (var i = 2; i < 256; i++) {
            var v = rate ? idxToRate(i, enc) : idxToMm(i, enc), k = -1;
            for (var j = 0; j < edges.length; j++) if (v >= edges[j]) k = j;
            if (k >= 0) out.set(COLORS[k], i * 4);
        }
        return out;
    }

    /** Fetch <base>index.json + its PNG. Resolves {meta, idx} or null when the
     *  storm has no total (404); rejects on other failures. `query` (e.g.
     *  '?u=<manifest updated>') versions the index URL past the CDN cache. */
    function load(base, fetchJson, query) {
        var meta = null;
        var getJson = fetchJson || function (u) { return fetch(u, { cache: 'no-store' }); };
        return getJson(base + 'index.json' + (query || ''))
            .then(function (r) {
                if (r.status === 404 || r.status === 403) return null;
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (m) {
                meta = m;
                if (!m || !m.png || !m.grid) return null;
                return fetch(base + m.png, { mode: 'cors' }).then(function (r) {
                    if (!r.ok) throw new Error('png HTTP ' + r.status);
                    return r.blob();
                }).then(function (b) {
                    return createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
                }).then(function (bmp) {
                    if (bmp.width !== m.grid.nx || bmp.height !== m.grid.ny) throw new Error('grid size mismatch');
                    var c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
                    var cx = c.getContext('2d', { willReadFrequently: true });
                    cx.drawImage(bmp, 0, 0);
                    var px = cx.getImageData(0, 0, bmp.width, bmp.height).data;
                    var idx = new Uint8Array(bmp.width * bmp.height);
                    for (var i = 0, j = 0; i < idx.length; i++, j += 4) idx[i] = px[j];
                    return { meta: m, idx: idx };
                });
            });
    }

    /** Mercator-warped canvas (data URL) + bounds; each output row samples
     *  the source row under its latitude (nearest). */
    var _lutCache = {};
    function piece(meta, idx, kind) {
        var g = meta.grid, nx = g.nx, ny = g.ny, res = g.res_deg || 0.1;
        var lk = (kind || 'total') + JSON.stringify(meta.encoding || {});
        var L = _lutCache[lk] || (_lutCache[lk] = lut(meta.encoding, kind)), M = 85.05;
        var latN = Math.min(g.lat_n, M), latS = Math.max(g.lat_s, -M);
        function my(lat) { return Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)); }
        var yN = my(latN), yS = my(latS);
        var absMin = (latS <= 0 && latN >= 0) ? 0 : Math.min(Math.abs(latS), Math.abs(latN));
        var dyMin = (res * Math.PI / 180) / Math.cos(absMin * Math.PI / 180);
        var H = Math.max(1, Math.min(4096, Math.ceil((yN - yS) / dyMin)));
        var cv = document.createElement('canvas'); cv.width = nx; cv.height = H;
        var cx = cv.getContext('2d'), im = cx.createImageData(nx, H), d = im.data;
        for (var r = 0; r < H; r++) {
            var y = yN - (r + 0.5) / H * (yN - yS);
            var lat = (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
            var sr = Math.max(0, Math.min(ny - 1, Math.floor((g.lat_n - lat) / res)));
            var so = sr * nx, o = r * nx * 4;
            for (var c = 0; c < nx; c++, o += 4) {
                var q = idx[so + c] * 4;
                d[o] = L[q]; d[o + 1] = L[q + 1]; d[o + 2] = L[q + 2]; d[o + 3] = L[q + 3];
            }
        }
        cx.putImageData(im, 0, 0);
        var w = g.lon_w, e = g.lon_e, mid = (w + e) / 2;
        if (mid >= 180) { w -= 360; e -= 360; } else if (mid < -180) { w += 360; e += 360; }
        return { url: cv.toDataURL('image/png'), bounds: [[latS, w], [latN, e]], wraps: w < -180 || e > 180 };
    }

    /** Add the total to a facade map; returns the overlay (remove with
     *  map.removeLayer). `pane` (optional) sets its stacking slot. */
    function addTo(map, meta, idx, opacity, pane, kind) {
        var p = piece(meta, idx, kind);
        var opts = { opacity: opacity == null ? 0.85 : opacity, crisp: true, interactive: false };
        if (pane) opts.pane = pane;
        var ov = L.imageOverlay(p.url, p.bounds, opts);
        if (p.wraps && window.LFLET_GL && ov._coords) {
            // Past ±180 on purpose (see header): skip the facade's clamp.
            var b = p.bounds;
            ov._coords = function () { return [[b[0][1], b[1][0]], [b[1][1], b[1][0]], [b[1][1], b[0][0]], [b[0][1], b[0][0]]]; };
        }
        return ov.addTo(map);
    }

    /** Move an overlay made by addTo to another frame (same kind). */
    function update(ov, meta, idx, kind) {
        var p = piece(meta, idx, kind), b = p.bounds;
        if (p.wraps && window.LFLET_GL) {
            ov._coords = function () { return [[b[0][1], b[1][0]], [b[1][1], b[1][0]], [b[1][1], b[0][0]], [b[0][1], b[0][0]]]; };
        } else if (ov.hasOwnProperty('_coords')) {
            delete ov._coords;
        }
        ov.setBounds(b);
        ov.setUrl(p.url);
        return ov;
    }

    /** Hourly rate snapshots: fetch <base><rate.png> (an atlas of rate.tile^2
     *  cells per hour, rate.cols across) -> {w, h, px} (index per pixel). */
    function loadAtlas(base, rate) {
        return fetch(base + rate.png, { mode: 'cors' }).then(function (r) {
            if (!r.ok) throw new Error('rate png HTTP ' + r.status);
            return r.blob();
        }).then(function (b) {
            return createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        }).then(function (bmp) {
            var c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
            var cx = c.getContext('2d', { willReadFrequently: true });
            cx.drawImage(bmp, 0, 0);
            var d = cx.getImageData(0, 0, bmp.width, bmp.height).data, px = new Uint8Array(bmp.width * bmp.height);
            for (var i = 0, j = 0; i < px.length; i++, j += 4) px[i] = d[j];
            return { w: bmp.width, h: bmp.height, px: px };
        });
    }
    /** Frame k of the atlas as a {meta, idx} pair piece()/addTo() can draw. */
    function rateFrame(rate, atlas, k) {
        var n = rate.tile, cols = rate.cols, y0 = Math.floor(k / cols) * n, x0 = (k % cols) * n;
        var idx = new Uint8Array(n * n);
        for (var r = 0; r < n; r++) idx.set(atlas.px.subarray((y0 + r) * atlas.w + x0, (y0 + r) * atlas.w + x0 + n), r * n);
        var res = rate.res_deg || 0.1, s = rate.lat_s[k], w = rate.lon_w[k];
        return { meta: { encoding: rate.encoding,
                         grid: { nx: n, ny: n, res_deg: res, lat_s: s, lat_n: s + n * res, lon_w: w, lon_e: w + n * res } },
                 idx: idx };
    }
    /** Index of the snapshot nearest `ms` (epoch ms) within maxMin minutes, or -1. */
    function nearestFrame(rate, ms, maxMin) {
        var best = -1, bd = Infinity;
        for (var k = 0; k < rate.t.length; k++) {
            var s = rate.t[k];
            var tk = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12));
            var d = Math.abs(tk - ms);
            if (d < bd) { bd = d; best = k; }
        }
        return (best >= 0 && bd <= (maxMin || 45) * 60000) ? best : -1;
    }

    /** Hover text for (lat, lon), or null outside the swath. */
    function valueText(meta, idx, lat, lon, kind) {
        if (!meta || !idx) return null;
        var g = meta.grid, res = g.res_deg || 0.1;
        var x = ((lon - g.lon_w) % 360 + 360) % 360;
        var col = Math.floor(x / res), row = Math.floor((g.lat_n - lat) / res);
        if (col < 0 || col >= g.nx || row < 0 || row >= g.ny) return null;
        var i = idx[row * g.nx + col];
        if (!i) return null;
        if (kind === 'rate') {
            if (i === 1) return '&lt; 0.1 mm/h';
            if (i === 255) return '&ge; 75 mm/h, ' + inText(75) + ' in/h (cap)';
            var rr = idxToRate(i, meta.encoding);
            return '\u2248 ' + (rr < 10 ? rr.toFixed(1) : Math.round(rr)) + ' mm/h (' + inText(rr) + ' in/h)';
        }
        if (i === 1) return '&lt; 1 mm';
        var top = idxToMm(255, meta.encoding);
        if (i === 255) return '&ge; ' + Math.round(top) + ' mm (' + inText(top) + ' in)';
        var mm = idxToMm(i, meta.encoding);
        return '≈ ' + (mm < 10 ? mm.toFixed(1) : Math.round(mm)) + ' mm (' + inText(mm) + ' in)';
    }

    function rampCss() {
        var n = COLORS.length;
        return 'linear-gradient(to right,' + COLORS.map(function (c, i) {
            return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] / 255).toFixed(2) + ') ' + Math.round(i / (n - 1) * 100) + '%';
        }).join(',') + ')';
    }

    /** Discrete bar with mm ticks above and inch ticks below, each row's unit in a gutter right of the bar (uses
     *  the RT monitor's .ir-rain-legend-* classes, or any page CSS that styles them). Tick offsets are inline, so
     *  the pages' :first-child / :last-child tick rules no longer apply. */
    function barHtml(barClass, tickClass, kind) {
        var rate = kind === 'rate', n = COLORS.length, sw = '';
        var edges = rate ? RATE_EDGES : EDGES, tc = tickClass || 'ir-rain-legend-ticks';
        for (var i = 0; i < n; i++) {
            var c = COLORS[i];
            sw += '<span style="background:rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] / 255).toFixed(2) + ')"></span>';
        }
        function row(items, unit) {
            var s = '';
            items.forEach(function (t) {
                s += '<span style="left:' + (t[1] * 100).toFixed(1) + '%;transform:translateX('
                    + (t[1] === 0 ? '0' : '-50%') + ')">' + t[0] + '</span>';
            });
            return '<div class="' + tc + '">' + s + '<span class="rain-unit" style="left:calc(100% + 5px);'
                + 'transform:none;white-space:nowrap">' + unit + '</span></div>';
        }
        var mm = (rate ? RATE_TICKS : TICKS).map(function (t) { return [t[0], t[1] / n]; });
        var inch = (rate ? RATE_IN_TICKS : IN_TICKS).map(function (v) { return [String(v), barPos(v * MM_PER_IN, edges)]; });
        return '<div class="rain-axis" style="margin-right:' + (rate ? 30 : 22) + 'px">'    // the unit tag's room
            + row(mm, rate ? 'mm/h' : 'mm')
            + '<div class="' + (barClass || 'ir-rain-legend-bar') + '">' + sw + '</div>'
            + row(inch, rate ? 'in/h' : 'in')
            + '</div>';
    }

    var CREDIT_HTML = '<a href="https://developers.google.com/weathernext/guides/pardig" target="_blank" rel="noopener">PARDIG</a>'
        + ' &copy; Google DeepMind, experimental &middot; <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>'
        + ' &middot; summed by <span style="white-space:nowrap">TC-ATLAS</span>'
        + ' &middot; <a href="about.html#deepmind-credits" target="_blank" rel="noopener">credits</a>';
    // Hourly rain-rate snapshots are binned, not summed.
    var RATE_CREDIT_HTML = '<a href="https://developers.google.com/weathernext/guides/pardig" target="_blank" rel="noopener">PARDIG</a>'
        + ' &copy; Google DeepMind, experimental &middot; <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>'
        + ' &middot; binned by <span style="white-space:nowrap">TC-ATLAS</span>'
        + ' &middot; <a href="about.html#deepmind-credits" target="_blank" rel="noopener">credits</a>';
    var ATTRIB_HTML = 'Rain: <a href="https://developers.google.com/weathernext/guides/pardig" target="_blank" rel="noopener">PARDIG</a>'
        + ' &copy; Google DeepMind (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>, modified)';
    var EXPORT_CREDIT = 'Rain total: PARDIG © Google DeepMind, CC BY 4.0, summed by TC-ATLAS';

    /** Put the PARDIG credit in a facade map's attribution line (an empty
     *  GeoJSON source carrying `attribution`, which MapLibre lists while the
     *  source is in use). */
    function attribution(map, on) {
        var gl = map && map._gl;
        if (!gl || !gl.getSource) return;
        try {
            if (on && !gl.getSource('rain-credit')) {
                gl.addSource('rain-credit', { type: 'geojson', attribution: ATTRIB_HTML,
                    data: { type: 'FeatureCollection', features: [] } });
                gl.addLayer({ id: 'rain-credit', type: 'circle', source: 'rain-credit', paint: { 'circle-radius': 0 } });
            } else if (!on && gl.getSource('rain-credit')) {
                if (gl.getLayer('rain-credit')) gl.removeLayer('rain-credit');
                gl.removeSource('rain-credit');
            }
        } catch (e) { console.warn('[PardigTotal] attribution', e); }
    }

    window.PardigTotal = {
        COLORS: COLORS, EDGES: EDGES, TICKS: TICKS,
        idxToMm: idxToMm, idxToRate: idxToRate, load: load, piece: piece, addTo: addTo, update: update,
        loadAtlas: loadAtlas, rateFrame: rateFrame, nearestFrame: nearestFrame, valueText: valueText,
        rampCss: rampCss, barHtml: barHtml, attribution: attribution, inText: inText, MM_PER_IN: MM_PER_IN,
        CREDIT_HTML: CREDIT_HTML, RATE_CREDIT_HTML: RATE_CREDIT_HTML, ATTRIB_HTML: ATTRIB_HTML, EXPORT_CREDIT: EXPORT_CREDIT
    };
})();
