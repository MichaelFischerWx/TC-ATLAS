/* realtime_ir_gl.js — MapLibre GL proof-of-concept for the RT monitor Global Map.
 *
 * Purpose: prove WebGL continuous zoom (the thing Leaflet can't do — see the
 * abandoned smooth_zoom.js experiment) on a parallel, throwaway-safe page. It
 * does NOT touch realtime_ir.js. Scope is deliberately minimal:
 *   basemap (raster) → GIBS IR raster (GOES-E/W + Himawari) → coastlines
 *   (GPU vector — crisp at zero CPU, unlike the 9.3 MB Leaflet canvas) → active
 *   storm markers + popups.
 *
 * Reuses the production GIBS config and the /ir-monitor/active-storms API so the
 * imagery and markers match the live monitor.
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
        return d.toISOString().slice(0, 19) + 'Z';   // YYYY-MM-DDTHH:MM:SSZ
    }

    function gibsTiles(layer, t) {
        // MapLibre substitutes {z}/{x}/{y}; GIBS wants {z}/{row=y}/{col=x}.
        return [GIBS_BASE + '/' + layer + '/default/' + t + '/' + MATRIX + '/{z}/{y}/{x}.png'];
    }

    function carto(style) {
        return ['a', 'b', 'c', 'd'].map(function (s) {
            return 'https://' + s + '.basemaps.cartocdn.com/' + style + '/{z}/{x}/{y}.png';
        });
    }

    var T = gibsTime();
    var irSourceIds = ['ir-east', 'ir-west', 'ir-hima'];

    // ?mosaic=<base> switches the IR layer to our own composited mosaic tiles
    // (one clean raster source) instead of the 3 bounded GIBS sources. e.g.
    //   realtime_ir_gl.html?mosaic=mosaic_out/ir/202606242140
    var MOSAIC = new URLSearchParams(location.search).get('mosaic');

    var irSources, irLayers;
    if (MOSAIC) {
        irSources = {
            // maxzoom 7: global tiles go to z5, storm patches to z7 — MapLibre
            // overzooms the z5 parent everywhere else (missing tiles fall back).
            'ir-mosaic': { type: 'raster', tiles: [MOSAIC.replace(/\/$/, '') + '/{z}/{x}/{y}.png'],
                           tileSize: 256, maxzoom: 7, attribution: 'TC-ATLAS mosaic · NOAA GOES' }
        };
        irLayers = [{ id: 'ir-mosaic', type: 'raster', source: 'ir-mosaic', paint: { 'raster-opacity': 0.9 } }];
    } else {
        // Bound each satellite to a longitude band near its sub-point so the
        // stretched off-nadir limbs don't bleed into a neighbor's territory
        // (the cause of the vertical "venetian-blind" smear + overlap seams).
        // Sub-points: GOES-W 137°W, GOES-E 75°W, Himawari 140°E. The 20°W–75°E
        // gap is honestly blank — Meteosat coverage we don't have yet. Crude
        // hard cuts (no feathered blend); seamless blending = the mosaic.
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
        ].concat(irLayers)   // coastline / labels / storms appended after load
    };

    var map = new maplibregl.Map({
        container: 'map',
        style: style,
        center: [-55, 20],
        zoom: 3,
        minZoom: 1,
        maxZoom: 10,
        dragRotate: false,           // keep it a flat north-up map like Leaflet
        pitchWithRotate: false,
        attributionControl: { compact: true }
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    // Defensive: if the container was measured before layout settled, force a
    // re-measure so the WebGL canvas fills the viewport.
    requestAnimationFrame(function () { map.resize(); });
    window.addEventListener('load', function () { map.resize(); });

    // Expose for console / preview inspection.
    window._glMap = map;

    var tEl = document.getElementById('poc-time');
    if (tEl) {
        tEl.textContent = MOSAIC
            ? 'Mosaic IR (GOES-19+18 blend) · ' + (MOSAIC.split('/').pop() || '')
            : 'GIBS IR: ' + T.replace('T', ' ').replace('Z', ' UTC');
    }

    map.on('load', function () {
        // ── Coastlines: GPU vector line. This is the layer that cost 242 ms/frame
        //    to keep crisp in Leaflet canvas; here the GPU re-rasterizes it every
        //    frame for free, so it stays sharp through continuous zoom. ──
        fetch('assets/coastlines/ne_10m_coastline.geojson')
            .then(function (r) { return r.json(); })
            .then(function (gj) {
                map.addSource('coastline', { type: 'geojson', data: gj });
                map.addLayer({
                    id: 'coastline', type: 'line', source: 'coastline',
                    paint: { 'line-color': '#000', 'line-width': 1, 'line-opacity': 0.6 }
                });
                // place labels above coastline + IR
                map.addLayer({ id: 'carto-labels', type: 'raster', source: 'carto-labels' });
            })
            .catch(function (e) { console.warn('coastline load failed', e); });

        loadStorms();
    });

    // ── Active storms → markers + popups (the marker-porting sample) ──
    function catColor(vmax) {
        if (vmax == null) return '#94a3b8';
        if (vmax >= 137) return '#ff2079';   // Cat 5
        if (vmax >= 113) return '#ff5ca2';   // Cat 4
        if (vmax >= 96)  return '#ff8c42';   // Cat 3
        if (vmax >= 83)  return '#ffd23f';   // Cat 2
        if (vmax >= 64)  return '#fde047';   // Cat 1
        if (vmax >= 34)  return '#38bdf8';   // TS
        return '#a5b4fc';                    // TD
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

                    var html =
                        '<b>' + (s.name || s.atcf_id || 'Disturbance') + '</b><br>' +
                        (s.category || '') + (s.vmax_kt != null ? '  ' + s.vmax_kt + ' kt' : '') + '<br>' +
                        '<span style="color:#94a3b8">' + (s.basin || '') +
                        (s.satellite ? '  ·  ' + s.satellite : '') + '</span>';

                    new maplibregl.Marker({ element: el })
                        .setLngLat([s.lon, s.lat])               // MapLibre is [lng, lat]
                        .setPopup(new maplibregl.Popup({ offset: 14, closeButton: false }).setHTML(html))
                        .addTo(map);
                });
                console.log('[GL POC] placed', storms.length, 'storm markers');
            })
            .catch(function (e) { console.warn('active-storms load failed', e); });
    }
})();
