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

    function idxToMm(i, enc) {
        enc = enc || {};
        var lo = enc.min_mm || 1, hi = enc.max_mm || 3000, n = enc.bins || 253;
        if (i <= 0) return null;          // outside the swath
        if (i === 1) return 0;            // inside, below min_mm
        if (i >= 255) return hi;
        return lo * Math.pow(hi / lo, (i - 2 + 0.5) / n);
    }

    function lut(enc) {
        var out = new Uint8ClampedArray(256 * 4);
        for (var i = 2; i < 256; i++) {
            var mm = idxToMm(i, enc), k = -1;
            for (var j = 0; j < EDGES.length; j++) if (mm >= EDGES[j]) k = j;
            if (k >= 0) out.set(COLORS[k], i * 4);
        }
        return out;
    }

    /** Fetch <base>index.json + its PNG. Resolves {meta, idx} or null when the
     *  storm has no total (404); rejects on other failures. */
    function load(base, fetchJson) {
        var meta = null;
        var getJson = fetchJson || function (u) { return fetch(u, { cache: 'no-store' }); };
        return getJson(base + 'index.json')
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
    function piece(meta, idx) {
        var g = meta.grid, nx = g.nx, ny = g.ny, res = g.res_deg || 0.1;
        var L = lut(meta.encoding), M = 85.05;
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
    function addTo(map, meta, idx, opacity, pane) {
        var p = piece(meta, idx);
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

    /** Hover text for (lat, lon), or null outside the swath. */
    function valueText(meta, idx, lat, lon) {
        if (!meta || !idx) return null;
        var g = meta.grid, res = g.res_deg || 0.1;
        var x = ((lon - g.lon_w) % 360 + 360) % 360;
        var col = Math.floor(x / res), row = Math.floor((g.lat_n - lat) / res);
        if (col < 0 || col >= g.nx || row < 0 || row >= g.ny) return null;
        var i = idx[row * g.nx + col];
        if (!i) return null;
        if (i === 1) return '&lt; 1 mm';
        if (i === 255) return '&ge; ' + Math.round(idxToMm(255, meta.encoding)) + ' mm';
        var mm = idxToMm(i, meta.encoding);
        return '≈ ' + (mm < 10 ? mm.toFixed(1) : Math.round(mm)) + ' mm';
    }

    function rampCss() {
        var n = COLORS.length;
        return 'linear-gradient(to right,' + COLORS.map(function (c, i) {
            return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] / 255).toFixed(2) + ') ' + Math.round(i / (n - 1) * 100) + '%';
        }).join(',') + ')';
    }

    /** Discrete bar + ticks (uses the RT monitor's .ir-rain-legend-* classes,
     *  or any page CSS that styles them). */
    function barHtml(barClass, tickClass) {
        var n = COLORS.length, sw = '', ticks = '';
        for (var i = 0; i < n; i++) {
            var c = COLORS[i];
            sw += '<span style="background:rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] / 255).toFixed(2) + ')"></span>';
        }
        TICKS.forEach(function (t) {
            ticks += '<span style="left:' + (t[1] / n * 100).toFixed(1) + '%">' + t[0] + '</span>';
        });
        return '<div class="' + (barClass || 'ir-rain-legend-bar') + '">' + sw + '</div>'
            + '<div class="' + (tickClass || 'ir-rain-legend-ticks') + '">' + ticks + '</div>';
    }

    var CREDIT_HTML = '<a href="https://developers.google.com/weathernext/guides/pardig" target="_blank" rel="noopener">PARDIG</a>'
        + ' &copy; Google DeepMind, experimental &middot; <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>'
        + ' &middot; summed by <span style="white-space:nowrap">TC-ATLAS</span>'
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
        idxToMm: idxToMm, load: load, piece: piece, addTo: addTo, valueText: valueText,
        rampCss: rampCss, barHtml: barHtml, attribution: attribution,
        CREDIT_HTML: CREDIT_HTML, ATTRIB_HTML: ATTRIB_HTML, EXPORT_CREDIT: EXPORT_CREDIT
    };
})();
