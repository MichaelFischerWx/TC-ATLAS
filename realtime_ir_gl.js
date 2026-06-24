/* realtime_ir_gl.js — MapLibre GL proof-of-concept for the RT monitor Global Map.
 *
 * Proves WebGL continuous zoom (the thing Leaflet can't do) on a parallel,
 * throwaway-safe page. Does NOT touch realtime_ir.js.
 *
 * Three IR modes:
 *   (default)              3 bounded GIBS sources (GOES-E/W + Himawari)
 *   ?mosaic=<ts-dir>       one composited mosaic raster source (our tiles)
 *   ?anim=<dir>            loop a manifest of mosaic frames (dir/frames.json)
 * Plus coastlines (GPU vector) + active-storm markers.
 */
(function () {
    'use strict';

    var API_BASE  = 'https://api.tcatlas.org';
    var GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
    var MATRIX    = 'GoogleMapsCompatible_Level6';
    var GIBS_IR   = {
        'GOES-East': 'GOES-East_ABI_Band13_Clean_Infrared',
        'GOES-West': 'GOES-West_ABI_Band13_Clean_Infrared',
        'Himawari':  'Himawari_AHI_Band13_Clean_Infrared'
    };

    // Round down to a 10-min GIBS slot, backed off ~40 min for ingest latency.
    function gibsTime() {
        var d = new Date(Date.now() - 40 * 60 * 1000);
        d.setUTCMinutes(d.getUTCMinutes() - (d.getUTCMinutes() % 10), 0, 0);
        return d.toISOString().slice(0, 19) + 'Z';
    }
    function gibsTiles(layer, t) {
        return [GIBS_BASE + '/' + layer + '/default/' + t + '/' + MATRIX + '/{z}/{y}/{x}.png'];
    }
    function carto(style) {
        return ['a', 'b', 'c', 'd'].map(function (s) {
            return 'https://' + s + '.basemaps.cartocdn.com/' + style + '/{z}/{x}/{y}.png';
        });
    }
    function fmtTs(ts) {  // YYYYMMDDHHMM → "MM-DD HH:MM UTC"
        return ts.slice(4, 6) + '-' + ts.slice(6, 8) + ' ' +
               ts.slice(8, 10) + ':' + ts.slice(10, 12) + ' UTC';
    }

    var qs     = new URLSearchParams(location.search);
    var MOSAIC = qs.get('mosaic');   // single-timestamp tile dir
    var ANIM   = qs.get('anim');     // dir containing frames.json
    var T      = gibsTime();
    var tEl    = document.getElementById('poc-time');
    var map;

    // optional ?center=lat,lon&zoom=Z to open already framed on a storm
    var center0 = [-55, 20], zoom0 = 3;
    if (qs.get('center')) {
        var p = qs.get('center').split(',').map(Number);
        if (p.length === 2 && isFinite(p[0]) && isFinite(p[1])) center0 = [p[1], p[0]];
    }
    if (qs.get('zoom') && isFinite(Number(qs.get('zoom')))) zoom0 = Number(qs.get('zoom'));

    function boot(frames) {
        var irSources = {}, irLayers = [];
        if (frames && frames.length) {
            // one raster source/layer per frame; opacity-crossfade between them
            frames.forEach(function (ts, i) {
                irSources['ir-f' + i] = { type: 'raster', maxzoom: 7, tileSize: 256,
                    tiles: [ANIM.replace(/\/$/, '') + '/' + ts + '/{z}/{x}/{y}.png'],
                    attribution: 'TC-ATLAS mosaic · NOAA GOES/Himawari' };
                irLayers.push({ id: 'ir-f' + i, type: 'raster', source: 'ir-f' + i,
                    paint: { 'raster-opacity': i === 0 ? 0.9 : 0,
                             'raster-opacity-transition': { duration: 250 } } });
            });
        } else if (MOSAIC) {
            // maxzoom 7: global tiles to z5, storm patches to z7; MapLibre
            // overzooms the z5 parent elsewhere (missing tiles fall back).
            irSources['ir-mosaic'] = { type: 'raster', maxzoom: 7, tileSize: 256,
                tiles: [MOSAIC.replace(/\/$/, '') + '/{z}/{x}/{y}.png'],
                attribution: 'TC-ATLAS mosaic · NOAA GOES/Himawari' };
            irLayers.push({ id: 'ir-mosaic', type: 'raster', source: 'ir-mosaic',
                            paint: { 'raster-opacity': 0.9 } });
        } else {
            // bounded GIBS fallback (no blend); the mosaic modes are the real demo
            irSources = {
                'ir-west': { type: 'raster', tiles: gibsTiles(GIBS_IR['GOES-West'], T), tileSize: 256, maxzoom: 6, bounds: [-180, -85.05, -106, 85.05], attribution: 'NASA GIBS' },
                'ir-east': { type: 'raster', tiles: gibsTiles(GIBS_IR['GOES-East'], T), tileSize: 256, maxzoom: 6, bounds: [-106, -85.05, -20, 85.05] },
                'ir-hima': { type: 'raster', tiles: gibsTiles(GIBS_IR['Himawari'],  T), tileSize: 256, maxzoom: 6, bounds: [75, -85.05, 180, 85.05] }
            };
            irLayers = [
                { id: 'ir-east', type: 'raster', source: 'ir-east', paint: { 'raster-opacity': 0.85 } },
                { id: 'ir-west', type: 'raster', source: 'ir-west', paint: { 'raster-opacity': 0.85 } },
                { id: 'ir-hima', type: 'raster', source: 'ir-hima', paint: { 'raster-opacity': 0.85 } }
            ];
        }

        var style = {
            version: 8,
            sources: Object.assign({
                'carto-dark':   { type: 'raster', tiles: carto('dark_nolabels'),    tileSize: 256, attribution: '© CARTO' },
                'carto-labels': { type: 'raster', tiles: carto('dark_only_labels'), tileSize: 256 }
            }, irSources),
            layers: [
                { id: 'bg',         type: 'background', paint: { 'background-color': '#0f172a' } },
                { id: 'carto-dark', type: 'raster', source: 'carto-dark' }
            ].concat(irLayers)
        };

        map = new maplibregl.Map({
            container: 'map', style: style, center: center0, zoom: zoom0,
            minZoom: 1, maxZoom: 10, dragRotate: false, pitchWithRotate: false,
            attributionControl: { compact: true }
        });
        map.touchZoomRotate.disableRotation();
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
        map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
        requestAnimationFrame(function () { map.resize(); });
        window.addEventListener('load', function () { map.resize(); });
        window._glMap = map;

        if (tEl) {
            tEl.textContent = frames ? 'Mosaic loop · ' + frames.length + ' frames'
                : MOSAIC ? 'Mosaic IR (GOES+Himawari blend) · ' + (MOSAIC.split('/').pop() || '')
                : 'GIBS IR: ' + T.replace('T', ' ').replace('Z', ' UTC');
        }

        map.on('load', function () {
            fetch('assets/coastlines/ne_10m_coastline.geojson')
                .then(function (r) { return r.json(); })
                .then(function (gj) {
                    map.addSource('coastline', { type: 'geojson', data: gj });
                    map.addLayer({ id: 'coastline', type: 'line', source: 'coastline',
                        paint: { 'line-color': '#000', 'line-width': 1, 'line-opacity': 0.6 } });
                    map.addLayer({ id: 'carto-labels', type: 'raster', source: 'carto-labels' });
                })
                .catch(function (e) { console.warn('coastline load failed', e); });
            loadStorms();

            if (frames && frames.length > 1) {
                var fi = 0;
                setInterval(function () {
                    var prev = fi; fi = (fi + 1) % frames.length;
                    map.setPaintProperty('ir-f' + prev, 'raster-opacity', 0);
                    map.setPaintProperty('ir-f' + fi, 'raster-opacity', 0.9);
                    if (tEl) tEl.textContent = 'Mosaic loop · ' + fmtTs(frames[fi]) +
                        '  (' + (fi + 1) + '/' + frames.length + ')';
                }, 700);
            }
        });
    }

    // ── Active storms → markers + popups ──
    function catColor(vmax) {
        if (vmax == null) return '#94a3b8';
        if (vmax >= 137) return '#ff2079';
        if (vmax >= 113) return '#ff5ca2';
        if (vmax >= 96)  return '#ff8c42';
        if (vmax >= 83)  return '#ffd23f';
        if (vmax >= 64)  return '#fde047';
        if (vmax >= 34)  return '#38bdf8';
        return '#a5b4fc';
    }
    function loadStorms() {
        fetch(API_BASE + '/ir-monitor/active-storms', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var storms = (data && data.storms) || [];
                storms.forEach(function (s) {
                    if (typeof s.lat !== 'number' || typeof s.lon !== 'number') return;
                    var el = document.createElement('div');
                    el.className = 'ml-storm';
                    el.style.background = catColor(s.vmax_kt);
                    var html = '<b>' + (s.name || s.atcf_id || 'Disturbance') + '</b><br>' +
                        (s.category || '') + (s.vmax_kt != null ? '  ' + s.vmax_kt + ' kt' : '') + '<br>' +
                        '<span style="color:#94a3b8">' + (s.basin || '') +
                        (s.satellite ? '  ·  ' + s.satellite : '') + '</span>';
                    new maplibregl.Marker({ element: el })
                        .setLngLat([s.lon, s.lat])
                        .setPopup(new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(html))
                        .addTo(map);
                });
                console.log('[GL POC] placed', storms.length, 'storm markers');
            })
            .catch(function (e) { console.warn('active-storms load failed', e); });
    }

    // anim mode needs the manifest before building sources; everything else
    // boots synchronously.
    if (ANIM) {
        fetch(ANIM.replace(/\/$/, '') + '/frames.json')
            .then(function (r) { return r.json(); })
            .then(function (j) { boot((j && j.frames) || []); })
            .catch(function (e) { console.warn('frames.json load failed', e); boot(null); });
    } else {
        boot(null);
    }
})();
