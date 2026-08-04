/* lflet_gl.js — a Leaflet-API facade backed by MapLibre GL.
 *
 * INCREMENT 1 of the RT-monitor engine swap (branch gl-engine-swap). The branch's
 * realtime_ir.html loads THIS instead of leaflet.js, so realtime_ir.js (and all the
 * chrome) runs essentially unchanged on a WebGL map → "exact UI" by construction.
 *
 * Scope of this file grows per increment. It currently implements the subset
 * initMap()/the IR animation use, with graceful stubs (no-op layers) for not-yet-
 * ported primitives so the host app's init doesn't throw. Coordinate convention is
 * translated at the boundary: Leaflet is [lat, lng]; MapLibre is [lng, lat].
 *
 * Status by primitive:
 *   L.map / Map nav+events+projection+panes ......... implemented
 *   L.tileLayer (raster) ............................ implemented
 *   L.marker / circleMarker / divIcon / popup ....... implemented
 *   L.imageOverlay .................................. implemented (image source)
 *   L.geoJSON (line/fill) ........................... implemented
 *   L.layerGroup .................................... implemented
 *   L.GridLayer.extend (composite IR) ............... raster-source bridge (inc 1)
 *   L.Layer.extend (canvas overlays: barbs/MW) ...... stub (inc 4/6/7)
 *   L.DomUtil / L.DomEvent .......................... thin helpers
 */
(function (global) {
    'use strict';
    if (typeof maplibregl === 'undefined') { console.error('lflet_gl: maplibregl missing'); return; }

    var _uid = 0;
    function uid(p) { return (p || 'l') + (++_uid); }
    function isArr(a) { return Object.prototype.toString.call(a) === '[object Array]'; }

    // ── stacking: MapLibre markers/popups vs the Leaflet-style panes ──────────
    // Markers render inside .maplibregl-canvas-container and popups directly in
    // the map container, both at `z-index: auto`. Our Leaflet-emulating panes are
    // siblings with EXPLICIT z-index (tilePane 200 … popupPane 700), and a
    // positioned element with a z-index always paints above one with `auto` —
    // so every pane, including custom canvas layers (recon barbs, env barbs,
    // microwave), painted OVER markers and popups. A dropsonde popup came up
    // underneath the wind barbs.
    // Give the MapLibre-rendered pieces the same stacking level as the Leaflet
    // panes they stand in for (markerPane 600), which is the order Leaflet itself
    // uses and what the rest of the facade assumes.
    // Popups sit at 1100 rather than Leaflet's popupPane 700 because
    // setZIndexOffset() writes an INLINE z-index on a marker element (beating this
    // class rule, as an explicit per-marker boost should) and callers use values up
    // to 1000 — e.g. the recon aircraft glyph. A popup must clear the whole marker
    // range, or opening one lands it underneath the markers it was opened from.
    (function _injectStackingCSS() {
        try {
            if (document.getElementById('lflet-gl-stacking')) return;
            var s = document.createElement('style');
            s.id = 'lflet-gl-stacking';
            s.textContent =
                '.maplibregl-marker{z-index:600;}' +
                '.maplibregl-popup{z-index:1100;}';
            (document.head || document.documentElement).appendChild(s);
        } catch (e) {}
    })();

    // ── coordinate helpers (Leaflet [lat,lng] ↔ MapLibre [lng,lat]) ──
    function LatLng(lat, lng) { this.lat = +lat; this.lng = +lng; }
    LatLng.prototype.equals = function (o) { o = toLatLng(o); return o && Math.abs(this.lat - o.lat) < 1e-9 && Math.abs(this.lng - o.lng) < 1e-9; };
    function toLatLng(a, b) {
        if (a instanceof LatLng) return a;
        if (isArr(a)) return new LatLng(a[0], a[1]);
        if (b !== undefined) return new LatLng(a, b);
        if (a && typeof a === 'object' && 'lat' in a) return new LatLng(a.lat, a.lng !== undefined ? a.lng : a.lon);
        return null;
    }
    function ll2ml(a, b) { var p = toLatLng(a, b); return [p.lng, p.lat]; }   // → [lng,lat]
    function _wrapLng(lng) { return ((lng + 180) % 360 + 360) % 360 - 180; }  // → [-180,180]
    // Point markers/popups must use a wrapped longitude: a track that crosses the
    // antimeridian can carry lng like -235 (=125°E unwrapped). maplibregl draws a
    // marker there fine (world copies), but Popup.setLngLat() can't project an
    // out-of-range lng and strands the popup at 0,0 (top-left). Wrapping is a no-op
    // for the marker's on-screen position but makes getLngLat()/popups sane.
    function mlWrap(a, b) { var p = toLatLng(a, b); return [_wrapLng(p.lng), p.lat]; }

    function LatLngBounds(a, b) { this._sw = null; this._ne = null; if (a) this.extend(a); if (b) this.extend(b); }
    LatLngBounds.prototype.extend = function (o) {
        if (isArr(o) && isArr(o[0])) { this.extend(o[0]); this.extend(o[1]); return this; }
        var p = toLatLng(o); if (!p) return this;
        if (!this._sw) { this._sw = new LatLng(p.lat, p.lng); this._ne = new LatLng(p.lat, p.lng); }
        else {
            this._sw.lat = Math.min(this._sw.lat, p.lat); this._sw.lng = Math.min(this._sw.lng, p.lng);
            this._ne.lat = Math.max(this._ne.lat, p.lat); this._ne.lng = Math.max(this._ne.lng, p.lng);
        }
        return this;
    };
    LatLngBounds.prototype.pad = function (r) {
        if (!this._sw) return this;
        var dh = (this._ne.lat - this._sw.lat) * r, dw = (this._ne.lng - this._sw.lng) * r;
        return new LatLngBounds([this._sw.lat - dh, this._sw.lng - dw], [this._ne.lat + dh, this._ne.lng + dw]);
    };
    LatLngBounds.prototype.getSouthWest = function () { return this._sw; };
    LatLngBounds.prototype.getNorthEast = function () { return this._ne; };
    LatLngBounds.prototype.getNorthWest = function () { return new LatLng(this._ne.lat, this._sw.lng); };
    LatLngBounds.prototype.getSouthEast = function () { return new LatLng(this._sw.lat, this._ne.lng); };
    LatLngBounds.prototype.getSouth = function () { return this._sw.lat; };
    LatLngBounds.prototype.getWest = function () { return this._sw.lng; };
    LatLngBounds.prototype.getNorth = function () { return this._ne.lat; };
    LatLngBounds.prototype.getEast = function () { return this._ne.lng; };
    LatLngBounds.prototype.getCenter = function () { return new LatLng((this._sw.lat + this._ne.lat) / 2, (this._sw.lng + this._ne.lng) / 2); };
    LatLngBounds.prototype.contains = function (o) { var p = toLatLng(o); return p && p.lat >= this._sw.lat && p.lat <= this._ne.lat && p.lng >= this._sw.lng && p.lng <= this._ne.lng; };
    LatLngBounds.prototype.pad = function (r) { var sw = this._sw, ne = this._ne;
        var hb = Math.abs(sw.lat - ne.lat) * r, wb = Math.abs(sw.lng - ne.lng) * r;
        return new LatLngBounds(new LatLng(sw.lat - hb, sw.lng - wb), new LatLng(ne.lat + hb, ne.lng + wb)); };
    LatLngBounds.prototype.isValid = function () { return !!this._sw; };

    function Point(x, y) { this.x = x; this.y = y; }
    function toPoint(p) { return p instanceof Point ? p : isArr(p) ? new Point(p[0], p[1]) : new Point(p.x, p.y); }
    Point.prototype.subtract = function (p) { return new Point(this.x - p.x, this.y - p.y); };
    Point.prototype.add = function (p) { return new Point(this.x + p.x, this.y + p.y); };
    Point.prototype.multiplyBy = function (n) { return new Point(this.x * n, this.y * n); };
    Point.prototype.divideBy = function (n) { return new Point(this.x / n, this.y / n); };
    Point.prototype.round = function () { return new Point(Math.round(this.x), Math.round(this.y)); };
    Point.prototype.floor = function () { return new Point(Math.floor(this.x), Math.floor(this.y)); };
    Point.prototype.clone = function () { return new Point(this.x, this.y); };
    Point.prototype.distanceTo = function (p) { var dx = this.x - p.x, dy = this.y - p.y; return Math.sqrt(dx * dx + dy * dy); };

    // ── Bounds (pixel-space rectangle; mirrors L.Bounds) ──
    function Bounds(a, b) { var pts = b !== undefined ? [a, b] : a; this.min = null; this.max = null;
        if (pts) { for (var i = 0; i < pts.length; i++) this.extend(pts[i]); } }
    Bounds.prototype.extend = function (p) { p = toPoint(p);
        if (!this.min) { this.min = p.clone(); this.max = p.clone(); }
        else { this.min.x = Math.min(p.x, this.min.x); this.min.y = Math.min(p.y, this.min.y);
               this.max.x = Math.max(p.x, this.max.x); this.max.y = Math.max(p.y, this.max.y); } return this; };
    Bounds.prototype.getSize = function () { return this.max.subtract(this.min); };
    Bounds.prototype.getCenter = function () { return new Point((this.min.x + this.max.x) / 2, (this.min.y + this.max.y) / 2); };
    Bounds.prototype.contains = function (p) { p = toPoint(p); return p.x >= this.min.x && p.x <= this.max.x && p.y >= this.min.y && p.y <= this.max.y; };

    // ── event translation ──
    var EVT = { moveend: 'moveend', movestart: 'movestart', move: 'move', zoom: 'zoom',
                zoomend: 'zoomend', zoomstart: 'zoomstart', load: 'load', click: 'click',
                mousemove: 'mousemove', mouseout: 'mouseout', resize: 'resize', dblclick: 'dblclick' };
    function wrapEvent(map, fn) {
        return function (e) {
            var o = { type: e && e.type, target: map, originalEvent: e && e.originalEvent };
            if (e && e.lngLat) { o.latlng = new LatLng(e.lngLat.lat, e.lngLat.lng); }
            if (e && e.point) { o.containerPoint = new Point(e.point.x, e.point.y); o.layerPoint = o.containerPoint; }
            fn(o);
        };
    }

    // ── the Map facade ──
    function Map(container, options) {
        options = options || {};
        var el = typeof container === 'string' ? document.getElementById(container) : container;
        var center = options.center ? ll2ml(options.center) : [0, 0];
        this._panes = {};
        this._handlers = [];          // {type, fn, wrapped}
        this._layers = {};            // id → layer facade
        this._glz = {};               // gl layer id → pane z-index (stacking order)
        this._maxZoom = options.maxZoom != null ? options.maxZoom : 22;
        try { (global.__lfletMaps = global.__lfletMaps || []).push(this); } catch (e) {}  // debug registry

        this._gl = new maplibregl.Map({
            container: el,
            style: { version: 8, sources: {},
                // Glyphs for symbol text (marker-cluster counts). Public CORS server;
                // self-host for production hardening. Bubbles still render if it fails.
                glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
                layers: [
                { id: 'bg', type: 'background', paint: { 'background-color': '#0b1220' } } ] },
            center: center,
            zoom: options.zoom != null ? options.zoom : 2,
            minZoom: options.minZoom != null ? options.minZoom : 0,
            maxZoom: this._maxZoom,
            dragRotate: false, pitchWithRotate: false,
            // Keep the WebGL backbuffer readable so PNG/GIF export (html2canvas /
            // getCanvas().toDataURL) captures the rendered map instead of blank.
            preserveDrawingBuffer: true,
            attributionControl: { compact: true },
            renderWorldCopies: options.worldCopyJump !== false
        });
        this._gl.touchZoomRotate.disableRotation();
        // Track readiness explicitly: after 'load' the style accepts addSource/
        // addLayer even while tiles stream (isStyleLoaded()/loaded() flicker false
        // during tile loads, which previously stranded layers added post-load).
        this._loaded = false;
        // Custom Leaflet layers branch on these internals; the facade has no
        // zoom-anim transform (canvas layers redraw on move), so report false.
        this._zoomAnimated = false;
        this._animatingZoom = false;
        var _self = this; this._gl.on('load', function () { _self._loaded = true; });
        // Self-heal container-size changes. MapLibre reads the container size
        // once at construction; if the element was hidden/zero-sized/wrong at
        // that moment (embedded webviews, panel resizes, phone rotation) the
        // canvas stayed at the 400×300 default forever — nothing ever called
        // invalidateSize(). A ResizeObserver on the container closes that hole.
        try {
            if (typeof ResizeObserver !== 'undefined' && el) {
                this._resizeObs = new ResizeObserver(function () {
                    try { _self._gl.resize(); } catch (e) {}
                });
                this._resizeObs.observe(el);
            }
        } catch (e) { /* non-fatal: behaves as before */ }
        // Registering an 'error' listener suppresses MapLibre's default console.error.
        // Full-globe image overlays (env filled fields) make MapLibre request a
        // wrapped world-copy tile (x=-1) that throws a harmless "outside of bounds"
        // during _finishLoading — the overlay still renders. Swallow only that;
        // surface everything else.
        this._gl.on('error', function (ev) { var err = ev && ev.error, m = (err && err.message) || '';
            // Benign + unactionable: the full-globe image-tile bounds quirk, and
            // AbortErrors from image sources whose in-flight load was superseded
            // (the storm-card lazy-decode window swaps frame URLs rapidly).
            if (/outside of bounds/.test(m)) return;
            if ((err && err.name === 'AbortError') || /abort/i.test(m)) return;
            console.error('[lflet_gl]', err || ev); });

        // Leaflet-style default panes: DOM divs over the canvas. Custom canvas
        // layers (barbs/microwave) draw into these via L.DomUtil + projection.
        var Z = { mapPane: 0, tilePane: 200, overlayPane: 400, shadowPane: 500,
                  markerPane: 600, tooltipPane: 650, popupPane: 700 };
        var _self0 = this;
        Object.keys(Z).forEach(function (n) { var p = _self0.createPane(n); p.style.zIndex = Z[n]; });

        // zoomControl facade (Leaflet adds a +/- control; MapLibre's NavigationControl)
        this.zoomControl = { _ctrl: null, setPosition: function (pos) {
            if (this._ctrl) return; this._ctrl = new maplibregl.NavigationControl({ showCompass: false });
            this._map._gl.addControl(this._ctrl, (pos || 'topleft').replace('top', 'top-').replace('bottom', 'bottom-')); }, _map: this };
        if (options.zoomControl !== false) this.zoomControl.setPosition('topleft');
    }

    Map.prototype.getContainer = function () { return this._gl.getContainer(); };
    Map.prototype.getGL = function () { return this._gl; };

    Map.prototype.setView = function (ll, zoom) {
        this._gl.jumpTo({ center: ll2ml(ll), zoom: zoom != null ? zoom : this._gl.getZoom() }); return this; };
    Map.prototype.panTo = function (ll, opts) { (opts && opts.animate === false ? this._gl.jumpTo : this._gl.easeTo).call(this._gl, { center: ll2ml(ll) }); return this; };
    Map.prototype.fitBounds = function (b, opts) {
        b = (b instanceof LatLngBounds) ? b : new LatLngBounds(b);
        if (!b.isValid()) return this;
        opts = opts || {};
        var mlOpts = { animate: opts.animate !== false,
            padding: opts.padding != null ? opts.padding : 20 };
        // Leaflet passes maxZoom via options; MapLibre honors it natively — pass it
        // through so a tiny bounds (e.g. an aircraft still near its takeoff base)
        // doesn't fit to street-level zoom.
        if (opts.maxZoom != null) mlOpts.maxZoom = opts.maxZoom;
        this._gl.fitBounds([[b._sw.lng, b._sw.lat], [b._ne.lng, b._ne.lat]], mlOpts);
        return this; };
    // flyTo(latlng, zoom, opts) — Leaflet duration is SECONDS; MapLibre wants ms.
    // essential:true so it runs even under prefers-reduced-motion.
    Map.prototype.flyTo = function (ll, zoom, opts) { opts = opts || {};
        this._gl.flyTo({ center: ll2ml(ll), zoom: zoom != null ? zoom : this._gl.getZoom(),
            duration: opts.animate === false ? 0 : (opts.duration != null ? opts.duration * 1000 : 1000),
            essential: true }); return this; };
    Map.prototype.getZoom = function () { return this._gl.getZoom(); };
    Map.prototype.setZoom = function (z) { this._gl.setZoom(z); return this; };
    Map.prototype.setMaxZoom = function (z) { this._maxZoom = z; this._gl.setMaxZoom(z); return this; };
    Map.prototype.setMinZoom = function (z) { this._gl.setMinZoom(z); return this; };
    Map.prototype.getCenter = function () { var c = this._gl.getCenter(); return new LatLng(c.lat, c.lng); };
    Map.prototype.getBounds = function () { var b = this._gl.getBounds(); return new LatLngBounds([b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]); };
    Map.prototype.getSize = function () { var c = this.getContainer(); return new Point(c.clientWidth, c.clientHeight); };
    Map.prototype.invalidateSize = function () { this._gl.resize(); return this; };
    Map.prototype.remove = function () {
        try { if (this._resizeObs) { this._resizeObs.disconnect(); this._resizeObs = null; } } catch (e) {}
        try { this._gl.remove(); } catch (e) {}
    };

    // projection
    Map.prototype.latLngToContainerPoint = function (ll) { var p = this._gl.project(ll2ml(ll)); return new Point(p.x, p.y); };
    Map.prototype.latLngToLayerPoint = Map.prototype.latLngToContainerPoint;
    Map.prototype.containerPointToLatLng = function (pt) { var x = isArr(pt) ? pt[0] : pt.x, y = isArr(pt) ? pt[1] : pt.y; var c = this._gl.unproject([x, y]); return new LatLng(c.lat, c.lng); };
    Map.prototype.project = function (ll) { var p = this._gl.project(ll2ml(ll)); return new Point(p.x, p.y); };
    Map.prototype.unproject = function (pt) { var x = isArr(pt) ? pt[0] : pt.x, y = isArr(pt) ? pt[1] : pt.y; var c = this._gl.unproject([x, y]); return new LatLng(c.lat, c.lng); };
    // The facade keeps panes un-transformed (custom layers redraw on move), so
    // layerPoint == containerPoint. Canvas overlays position themselves at the
    // container origin and draw via latLngToContainerPoint.
    Map.prototype.containerPointToLayerPoint = function (pt) { var x = isArr(pt) ? pt[0] : pt.x, y = isArr(pt) ? pt[1] : pt.y; return new Point(x, y); };
    Map.prototype.layerPointToContainerPoint = function (pt) { var x = isArr(pt) ? pt[0] : pt.x, y = isArr(pt) ? pt[1] : pt.y; return new Point(x, y); };
    Map.prototype.layerPointToLatLng = function (pt) { return this.containerPointToLatLng(pt); };
    Map.prototype.getPixelOrigin = function () { return new Point(0, 0); };
    // L.Renderer internals used by the microwave mosaic canvas layer. project()
    // is screen-relative (current zoom); _getNewPixelOrigin stays consistent with
    // it so _updateTransform's (project(center) - origin) term cancels to size/2.
    Map.prototype.getZoomScale = function (toZoom, fromZoom) { return Math.pow(2, toZoom - (fromZoom == null ? this.getZoom() : fromZoom)); };
    Map.prototype.getScaleZoom = function (scale, fromZoom) { return (fromZoom == null ? this.getZoom() : fromZoom) + Math.log(scale) / Math.LN2; };
    Map.prototype._getNewPixelOrigin = function (center, zoom) { return this.project(center, zoom).subtract(this.getSize().divideBy(2)).round(); };
    Map.prototype.getPixelWorldBounds = function () { var s = this.getSize(); return new Bounds(new Point(0, 0), new Point(s.x, s.y)); };
    Map.prototype.getPixelBounds = function () { var s = this.getSize(); return { min: new Point(0, 0), max: new Point(s.x, s.y) }; };

    // events
    Map.prototype.on = function (types, fn, ctx) {
        var self = this; var bound = ctx ? fn.bind(ctx) : fn; String(types).split(' ').forEach(function (t) {
            t = t.trim(); if (!t) return; var ml = EVT[t] || t; var w = wrapEvent(self, bound);
            self._handlers.push({ type: t, fn: fn, ctx: ctx, wrapped: w, ml: ml }); self._gl.on(ml, w); }); return this; };
    Map.prototype.off = function (types, fn, ctx) {
        var self = this; String(types || '').split(' ').forEach(function (t) {
            t = t.trim(); self._handlers = self._handlers.filter(function (h) {
                if (h.type === t && (!fn || h.fn === fn) && (!ctx || h.ctx === ctx)) { self._gl.off(h.ml, h.wrapped); return false; } return true; }); }); return this; };
    Map.prototype.once = function (types, fn, ctx) {
        var self = this, done = false;
        function one(e) { if (done) return; done = true; self.off(types, one); if (ctx) fn.call(ctx, e); else fn(e); }
        return this.on(types, one); };
    Map.prototype.fire = function () { return this; };

    // panes (DOM divs over the canvas)
    Map.prototype.createPane = function (name) {
        if (this._panes[name]) return this._panes[name];
        var d = document.createElement('div'); d.className = 'leaflet-pane leaflet-' + name;
        d.style.position = 'absolute'; d.style.left = 0; d.style.top = 0; d.style.pointerEvents = 'none';
        // A pane born while overlays are hidden ("imagery only") starts hidden too,
        // otherwise turning a layer on mid-clean-view would pop it back on screen.
        if (this._ovHidden && (this._ovKeepPanes || []).indexOf(name) < 0) d.style.display = 'none';
        this.getContainer().appendChild(d); this._panes[name] = d; return d; };
    Map.prototype.getPane = function (name) { return this._panes[name] || this.createPane(name); };
    Map.prototype.getPanes = function () { return this._panes; };

    // ── "Imagery only" — hide every annotation overlay ────────────
    // Panes are the only classifier the facade has (every GL layer carries its
    // pane's z in _glz, every custom canvas layer draws into a pane div), so the
    // caller expresses what to KEEP as pane names — e.g. the satellite mosaic
    // (tilePane), radar, coastlines. Everything else — tracks, cones, genesis
    // dots, env rasters, wind barbs, markers, popups — goes dark, leaving a clean
    // frame to export. Nothing is removed, so restoring is one setLayoutProperty.
    // Keep-z is recomputed on demand, not cached: panes like gRadarPane /
    // mwMosaicPane are created lazily, and _paneZ() of a pane that doesn't exist
    // yet falls back to 400 — which would spare overlayPane by accident.
    // A keep-pane whose z collides with a pane we're hiding is dropped rather
    // than honored: a lazily-created pane that never got its z-index reads as
    // overlayPane's 400, and sparing 400 would spare every track on the map.
    // Hiding too much is a visible, one-click-reversible mistake; hiding
    // nothing silently defeats the whole feature.
    Map.prototype._ovKeepZ = function () {
        var self = this, keep = this._ovKeepPanes || [], banned = {}, out = [];
        Object.keys(this._panes).forEach(function (n) {
            if (keep.indexOf(n) < 0) banned[self._paneZ(n)] = true;
        });
        keep.forEach(function (n) {
            if (!self._panes[n]) return;
            var z = self._paneZ(n);
            if (!banned[z]) out.push(z);
        });
        return out;
    };
    Map.prototype.setOverlaysHidden = function (hidden, keepPanes) {
        var self = this;
        hidden = !!hidden;
        this._ovHidden = hidden;
        if (keepPanes) this._ovKeepPanes = keepPanes.slice();
        var keep = this._ovKeepZ(), keepNames = this._ovKeepPanes || [];
        Object.keys(this._glz).forEach(function (id) {
            if (keep.indexOf(self._glz[id]) >= 0) return;
            try { if (self._gl.getLayer(id)) self._gl.setLayoutProperty(id, 'visibility', hidden ? 'none' : 'visible'); }
            catch (e) {}
        });
        Object.keys(this._panes).forEach(function (n) {
            if (keepNames.indexOf(n) >= 0) return;
            self._panes[n].style.display = hidden ? 'none' : '';
        });
        // Markers/popups are maplibregl DOM children of the container, not panes —
        // a container class covers the ones added after the toggle too.
        var c = this.getContainer();
        if (c) { if (hidden) c.classList.add('lflet-overlays-hidden'); else c.classList.remove('lflet-overlays-hidden'); }
        if (hidden && !document.getElementById('lflet-gl-ov-css')) {
            var st = document.createElement('style'); st.id = 'lflet-gl-ov-css';
            st.textContent = '.lflet-overlays-hidden .maplibregl-marker,'
                           + '.lflet-overlays-hidden .maplibregl-popup{display:none !important;}';
            document.head.appendChild(st);
        }
        return this;
    };
    Map.prototype.overlaysHidden = function () { return !!this._ovHidden; };

    // layer add/remove. Built-in facade layers implement _addToGL/_removeFromGL.
    // Custom Leaflet layers (L.Layer.extend with onAdd/getEvents — env barbs,
    // recon barbs, microwave) are bridged: onAdd builds their pane canvas, and
    // their getEvents() redraw is re-fired on every MapLibre move so the canvas
    // stays synced through continuous zoom (they project via latLngToContainerPoint).
    // ── pane-aware GL layer stacking ──────────────────────────────
    // MapLibre has no panes: gl.addLayer() always appends on top, so a tile
    // layer re-added later (the IR mosaic refreshing every frame) would bury
    // vector overlays added earlier. Leaflet avoids this with fixed-z panes.
    // We mirror that: every GL layer carries its pane's z-index, and we insert
    // it *below* the first existing layer with a higher z (MapLibre beforeId).
    var _DEFAULT_PANE_Z = { mapPane: 0, tilePane: 200, overlayPane: 400,
        shadowPane: 500, markerPane: 600, tooltipPane: 650, popupPane: 700 };
    Map.prototype._paneZ = function (name) {
        if (name == null) return null;
        var p = this._panes[name];
        if (p && p.style.zIndex !== '') return parseInt(p.style.zIndex, 10);
        return _DEFAULT_PANE_Z[name] != null ? _DEFAULT_PANE_Z[name] : 400;
    };
    // Insert a GL layer at the stacking position for z (lower z = further back).
    // Among equal z, later additions sit on top (Leaflet insertion order).
    Map.prototype._glAdd = function (def, z) {
        // getStyle() is undefined until MapLibre's 'load' fires. With the page's
        // scripts loading in parallel (defer), a fast frames.json can race the
        // style and land here early — queue the add instead of crashing. Queued
        // adds replay in registration order, preserving stacking.
        if (!(this._loaded || this._gl.isStyleLoaded())) {
            var self = this;
            this._whenStyle(function () { self._glAdd(def, z); });
            return;
        }
        z = z == null ? 400 : z;
        var layers = this._gl.getStyle().layers, before = null;
        for (var i = 0; i < layers.length; i++) {
            var lz = this._glz[layers[i].id];
            if (lz != null && lz > z) { before = layers[i].id; break; }
        }
        if (before) this._gl.addLayer(def, before); else this._gl.addLayer(def);
        this._glz[def.id] = z;
        // Inherit "imagery only" — a track built while the clean view is on must
        // not paint over the frame the user is about to save.
        if (this._ovHidden && this._ovKeepZ().indexOf(z) < 0) {
            try { this._gl.setLayoutProperty(def.id, 'visibility', 'none'); } catch (e) {}
        }
    };
    Map.prototype.addLayer = function (layer) {
        if (!layer) return this;
        layer._map = this;
        if (layer._addToGL) layer._addToGL(this);
        else if (typeof layer.onAdd === 'function') this._addCustomLayer(layer);
        this._layers[layer._lid || (layer._lid = uid())] = layer;
        return this;
    };
    Map.prototype._addCustomLayer = function (layer) {
        try { layer.onAdd(this); } catch (e) { console.warn('lflet_gl: custom layer onAdd failed', e); return; }
        var evs = (typeof layer.getEvents === 'function') ? layer.getEvents() : {};
        var redraw = evs.viewreset || evs.moveend || evs.move || evs.zoom || evs.zoomend;
        if (redraw) {
            var h = function () { try { redraw.call(layer); } catch (e) {} };
            this._gl.on('move', h); this._gl.on('moveend', h);
            layer._glRedraw = h; setTimeout(h, 0);
        }
    };
    Map.prototype.removeLayer = function (layer) {
        if (!layer) return this;
        if (layer._removeFromGL) layer._removeFromGL(this);
        else {
            if (layer._glRedraw) { this._gl.off('move', layer._glRedraw); this._gl.off('moveend', layer._glRedraw); layer._glRedraw = null; }
            if (typeof layer.onRemove === 'function') { try { layer.onRemove(this); } catch (e) {} }
        }
        delete this._layers[layer._lid];
        return this;
    };
    Map.prototype.hasLayer = function (layer) { return !!(layer && this._layers[layer._lid]); };
    Map.prototype.eachLayer = function (fn) { var s = this; Object.keys(this._layers).forEach(function (k) { fn(s._layers[k]); }); return this; };
    Map.prototype.whenReady = function (fn) { if (this._gl.loaded()) fn(); else this._gl.once('load', fn); return this; };
    Map.prototype.stop = function () { this._gl.stop(); return this; };
    Map.prototype._whenStyle = function (fn) {
        if (this._loaded || this._gl.isStyleLoaded()) { fn(); return; }
        this._gl.once('load', fn);
    };

    // ── Layer base + Leaflet-style .extend ──
    function extend(proto) {
        var Parent = this;
        function Child() { Parent.apply(this, arguments); if (this.initialize) this.initialize.apply(this, arguments); }
        Child.prototype = Object.create(Parent.prototype);
        Object.keys(proto || {}).forEach(function (k) { Child.prototype[k] = proto[k]; });
        if (proto && proto.options) Child.prototype.options = Object.assign({}, Parent.prototype.options, proto.options);
        Child.prototype.constructor = Child; Child.extend = extend; return Child;
    }
    function Layer() {}
    Layer.prototype.addTo = function (map) { map.addLayer(this); return this; };
    Layer.prototype.remove = function () { if (this._map) this._map.removeLayer(this); return this; };
    Layer.prototype.removeFrom = function (m) { m.removeLayer(this); return this; };
    Layer.prototype.on = function () { return this; };
    Layer.prototype.once = function (t, fn) { if (t === 'load' && fn) setTimeout(fn, 0); return this; };
    Layer.prototype.off = function () { return this; };
    Layer.prototype.setZIndex = function () { return this; };
    Layer.extend = extend;

    // ── TileLayer → raster source ──
    var TileLayer = extend.call(Layer, {
        initialize: function (url, opts) { this._url = url; this.options = opts || {}; this._id = uid('tile'); },
        _glUrls: function () {
            var subs = (this.options.subdomains || 'abc'); if (typeof subs === 'string') subs = subs.split('');
            var u = this._url.replace('{r}', '');
            if (u.indexOf('{s}') >= 0) return subs.map(function (s) { return u.replace('{s}', s); });
            return [u];
        },
        _addToGL: function (map) {
            this._map = map; var gl = map._gl, id = this._id, self = this;
            map._whenStyle(function () {
                if (gl.getSource(id)) return;
                gl.addSource(id, { type: 'raster', tiles: self._glUrls(),
                    // tileSize defaults to 256 (most XYZ sources here). The IR mosaic
                    // serves 512px tiles (4× fewer tiles/frame, same native pixels) and
                    // passes tileSize:512 — MapLibre then maps map-zoom→tile-z directly.
                    tileSize: self.options.tileSize || 256,
                    // maxNativeZoom (Leaflet) == source maxzoom (MapLibre): MapLibre
                    // overzooms the deepest native tiles past this instead of fetching.
                    maxzoom: self.options.maxNativeZoom || self.options.maxZoom || 19,
                    attribution: self.options.attribution || '' });
                // Bridge MapLibre source errors (tile 404 / decode) to Leaflet's
                // 'tileerror' so the animation self-heal handler fires.
                if (self._errCbs && self._errCbs.length && !self._errBound) { self._errBound = true;
                    gl.on('error', function (e) { if (e && e.sourceId === id) self._errCbs.forEach(function (f) { try { f(e); } catch (x) {} }); }); }
                var paint = { 'raster-opacity': self.options.opacity != null ? self.options.opacity : 1,
                    // No tile cross-fade, and NO opacity transition: the animation
                    // swaps frame opacity 0↔0.85, and MapLibre's default 300ms
                    // raster-opacity transition made the basemap pulse through mid-fade
                    // ("white opaque layer that fades in and out" between frames).
                    'raster-fade-duration': 0,
                    'raster-opacity-transition': { duration: 0 } };
                // crisp: pixel-exact overzoom (the IR mosaic; keeps the sharp,
                // non-interpolated look past native zoom). Default basemap stays linear.
                if (self.options.crisp) paint['raster-resampling'] = 'nearest';
                var layer = { id: id, type: 'raster', source: id, paint: paint };
                map._glAdd(layer, map._paneZ(self.options.pane || 'tilePane'));
                self._added = true;
                (self._loadCbs || []).forEach(function (f) { setTimeout(f, 0); });
            });
        },
        _removeFromGL: function (map) {
            var gl = map._gl; try { if (gl.getLayer(this._id)) gl.removeLayer(this._id); if (gl.getSource(this._id)) gl.removeSource(this._id); } catch (e) {}
            this._added = false;
        },
        // 'load' fires when the raster source is added (tiles stream lazily after).
        // 'tileerror' bridges MapLibre source errors (wired in _addToGL).
        on: function (t, fn) { if (t === 'load') { (this._loadCbs = this._loadCbs || []).push(fn); if (this._added) setTimeout(fn, 0); }
            else if (t === 'tileerror') { (this._errCbs = this._errCbs || []).push(fn); } return this; },
        once: function (t, fn) { return this.on(t, fn); },
        setOpacity: function (o) { var gl = this._map && this._map._gl; if (gl && gl.getLayer(this._id)) gl.setPaintProperty(this._id, 'raster-opacity', o); this.options.opacity = o; return this; },
        setUrl: function (url) {
            this._url = url;
            if (!this._map) return this;
            var self = this, map = this._map, gl = map._gl;
            // Prefer an in-place tiles swap: it changes the source URL without
            // removing the layer, so stacking is preserved. A remove+re-add
            // (the old path) re-appends this raster and — among equal-z
            // tilePane layers — lands it ON TOP, which is how a theme swap of
            // the CARTO basemap was burying the IR mosaic ("satellite imagery
            // disappears on dark-mode toggle").
            var src = gl && gl.getSource(this._id);
            if (src && typeof src.setTiles === 'function') {
                try { src.setTiles(this._glUrls()); return this; } catch (e) {}
            }
            // Fallback: capture the layer currently above this one, re-add,
            // then move back to that original slot.
            var beforeId = null;
            try {
                var ls = gl.getStyle().layers;
                for (var i = 0; i < ls.length; i++) {
                    if (ls[i].id === this._id) {
                        beforeId = (i + 1 < ls.length) ? ls[i + 1].id : null; break;
                    }
                }
            } catch (e2) {}
            this._removeFromGL(map);
            this._addToGL(map);
            map._whenStyle(function () {
                try {
                    if (beforeId && gl.getLayer(self._id) && gl.getLayer(beforeId)) {
                        gl.moveLayer(self._id, beforeId);
                    }
                } catch (e3) {}
            });
            return this;
        },
        bringToFront: function () { return this; }
    });

    // ── ImageOverlay → image source ──
    var ImageOverlay = extend.call(Layer, {
        initialize: function (url, bounds, opts) { this._url = url; this._bounds = bounds; this.options = opts || {}; this._id = uid('img'); },
        _coords: function () { var b = this._bounds, s, w, n, e; // accepts [[s,w],[n,e]] OR a LatLngBounds
            if (b && b.getSouthWest) { var sw = b.getSouthWest(), ne = b.getNorthEast(); s = sw.lat; w = sw.lng; n = ne.lat; e = ne.lng; }
            else { s = b[0][0]; w = b[0][1]; n = b[1][0]; e = b[1][1]; }
            // Web Mercator can't represent the poles; clamp lat to its limit so a
            // full-globe overlay ([-90..90]) doesn't push the image tile out of bounds.
            var M = 85.05112878; s = Math.max(-M, Math.min(M, s)); n = Math.max(-M, Math.min(M, n));
            // A lng span reaching exactly ±180 makes MapLibre's ImageSource compute a
            // corner tile at x=2^z (or a wrapped x=-1) and throw "outside of bounds"
            // during load. Pull the edges a hair inside so the source stays within
            // [0,1) Mercator-x; the sub-pixel inset is invisible at any zoom.
            if (w <= -180) w = -179.99; if (e >= 180) e = 179.99;
            return [[w, n], [e, n], [e, s], [w, s]]; },
        setBounds: function (b) { this._bounds = b; var gl = this._map && this._map._gl, src = gl && gl.getSource(this._id); if (src) src.setCoordinates(this._coords()); return this; },
        _addToGL: function (map) { this._map = map; var gl = map._gl, id = this._id, self = this;
            map._whenStyle(function () { if (gl.getSource(id)) return;
                gl.addSource(id, { type: 'image', url: self._url, coordinates: self._coords() });
                // Default image overlays (env filled fields, IR frames) sit above
                // the tile basemap but below vector overlays; an explicit pane wins.
                var imgZ = self.options.pane ? map._paneZ(self.options.pane) : 350;
                map._glAdd({ id: id, type: 'raster', source: id,
                    paint: { 'raster-opacity': self.options.opacity != null ? self.options.opacity : 1,
                             'raster-resampling': 'nearest', 'raster-fade-duration': 0,
                             'raster-opacity-transition': { duration: 0 } } }, imgZ); self._added = true; }); },
        _removeFromGL: function (map) { var gl = map._gl; try { if (gl.getLayer(this._id)) gl.removeLayer(this._id); if (gl.getSource(this._id)) gl.removeSource(this._id); } catch (e) {} },
        setOpacity: function (o) { var gl = this._map && this._map._gl; if (gl && gl.getLayer(this._id)) gl.setPaintProperty(this._id, 'raster-opacity', o); this.options.opacity = o; return this; },
        setUrl: function (u) { this._url = u; var gl = this._map && this._map._gl, src = gl && gl.getSource(this._id); if (src) src.updateImage({ url: u }); return this; },
        // The per-band (Vis/WV) bundle counts valid frames via lyr.once('load'/'error')
        // on each overlay (the IR bundle skips this via lazy-decode). MapLibre image
        // sources don't surface a per-source load event, so probe the URL with an
        // Image() and fire from that. Without this, Vis/WV never finalized → the
        // product fell back to IR ("no Visible/WV on the storm sector").
        on: function (type, fn) { if (type !== 'load' && type !== 'error') return this;
            this._evts = this._evts || {}; (this._evts[type] = this._evts[type] || []).push(fn); this._probeLoad(); return this; },
        once: function (type, fn) { return this.on(type, fn); },
        _probeLoad: function () { if (this._probed || !this._url) return; this._probed = true; var self = this;
            var img = new Image();
            img.onload = function () { self._fireImg('load'); };
            img.onerror = function () { self._fireImg('error'); };
            try { img.src = self._url; } catch (e) { setTimeout(function () { self._fireImg('error'); }, 0); }
            if (img.complete && img.naturalWidth) setTimeout(function () { self._fireImg('load'); }, 0); },
        _fireImg: function (type) { if (this._fired) return; this._fired = true;
            ((this._evts && this._evts[type]) || []).forEach(function (f) { try { f(); } catch (e) {} }); },
        // Z-order is governed by pane assignment (_paneZ), not front/back calls,
        // so these are no-ops — present so callers (e.g. the storm-card Vis/SWIR
        // backdrop behind the MW swath) don't throw on GL.
        bringToFront: function () { return this; }, bringToBack: function () { return this; }
    });

    // ── GeoJSON → geojson source (line + optional fill) ──
    var _emptyFC = function () { return { type: 'FeatureCollection', features: [] }; };
    function _normFC(d) {
        if (!d) return _emptyFC();
        if (d.type === 'FeatureCollection') return { type: 'FeatureCollection', features: (d.features || []).slice() };
        if (d.type === 'Feature') return { type: 'FeatureCollection', features: [d] };
        if (d.type) return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: d }] };  // bare geometry
        return _emptyFC();
    }
    var GeoJSON = extend.call(Layer, {
        initialize: function (data, opts) { this.options = opts || {}; this._id = uid('geo'); this._data = _normFC(data); this._bakeStyle(); },
        // A Leaflet style can be a per-feature FUNCTION (contours color each line by
        // value). MapLibre paint is one expression for the whole layer, so we bake
        // each feature's computed style into its properties (_lc/_lw/_lo/_fc/_fo)
        // and read them with ['get', ...]. Evaluating the fn once with a dummy
        // feature (as before) collapsed every line to the default — black, which is
        // invisible on the IR. A plain-object style keeps constant paint.
        _styleIsFn: function () { return typeof this.options.style === 'function'; },
        _bakeStyle: function () {
            if (!this._styleIsFn()) return; var st = this.options.style, feats = this._data.features || [];
            this._anyFill = false;
            for (var i = 0; i < feats.length; i++) { var f = feats[i]; if (!f.properties) f.properties = {};
                var s = {}; try { s = st(f) || {}; } catch (e) {}
                if (s.color != null) f.properties._lc = s.color;
                if (s.weight != null) f.properties._lw = s.weight;
                if (s.opacity != null) f.properties._lo = s.opacity;
                if (s.fillColor != null) { f.properties._fc = s.fillColor; this._anyFill = true; }
                if (s.fillOpacity != null) f.properties._fo = s.fillOpacity; }
        },
        _setData: function () { this._bakeStyle(); var gl = this._map && this._map._gl, src = gl && gl.getSource(this._id); if (src) src.setData(this._data); },
        addData: function (d) {
            var fc = _normFC(d);
            this._data.features = (this._data.features || []).concat(fc.features);
            this._setData(); return this;
        },
        clearLayers: function () { this._data = _emptyFC(); this._setData(); return this; },
        setData: function (d) { this._data = _normFC(d); this._setData(); return this; },
        _addToGL: function (map) {
            this._map = map; var gl = map._gl, id = this._id, self = this;
            var fn = this._styleIsFn(), st = fn ? {} : (this.options.style || {});
            map._whenStyle(function () {
                if (gl.getSource(id)) return;
                gl.addSource(id, { type: 'geojson', data: self._data });
                var gz = map._paneZ(self.options.pane || 'overlayPane');
                var lineColor = fn ? ['coalesce', ['get', '_lc'], '#3388ff'] : (st.color || '#000');
                var lineWidth = fn ? ['coalesce', ['get', '_lw'], 1] : (st.weight != null ? st.weight : 1);
                var lineOpac = fn ? ['coalesce', ['get', '_lo'], 1] : (st.opacity != null ? st.opacity : 1);
                if ((fn && self._anyFill) || (!fn && st.fill && st.fillColor)) map._glAdd({ id: id + '-f', type: 'fill', source: id,
                    paint: { 'fill-color': fn ? ['coalesce', ['get', '_fc'], '#3388ff'] : st.fillColor,
                             'fill-opacity': fn ? ['coalesce', ['get', '_fo'], 0.2] : (st.fillOpacity != null ? st.fillOpacity : 0.2) } }, gz - 1);
                map._glAdd({ id: id + '-l', type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' },
                    paint: { 'line-color': lineColor, 'line-width': lineWidth, 'line-opacity': lineOpac } }, gz);
                self._added = true;
            });
        },
        _removeFromGL: function (map) { var gl = map._gl; [this._id + '-l', this._id + '-f'].forEach(function (l) { try { if (gl.getLayer(l)) gl.removeLayer(l); } catch (e) {} }); try { if (gl.getSource(this._id)) gl.removeSource(this._id); } catch (e) {} },
        // setStyle on a whole GeoJSON layer (e.g. env contours dimming with the
        // opacity slider). Applies to the line layer + fill layer if present.
        setStyle: function (st) { st = st || {}; var gl = this._map && this._map._gl; if (!gl) { Object.assign(this.options, st); return this; }
            var lid = this._id + '-l', fid = this._id + '-f';
            if (gl.getLayer(lid)) { if (st.opacity != null) gl.setPaintProperty(lid, 'line-opacity', st.opacity);
                if (st.color) gl.setPaintProperty(lid, 'line-color', st.color); if (st.weight != null) gl.setPaintProperty(lid, 'line-width', st.weight); }
            if (gl.getLayer(fid)) { if (st.fillOpacity != null) gl.setPaintProperty(fid, 'fill-opacity', st.fillOpacity);
                else if (st.opacity != null) gl.setPaintProperty(fid, 'fill-opacity', st.opacity); if (st.fillColor) gl.setPaintProperty(fid, 'fill-color', st.fillColor); }
            Object.assign(this.options, st); return this; },
        bringToFront: function () { return this; }
    });

    // ── Polyline → geojson line (storm tracks, forecast cones, etc.) ──
    function _coordsOf(lls) { return lls.map(function (p) { var l = toLatLng(p); return [l.lng, l.lat]; }); }
    var Polyline = extend.call(Layer, {
        initialize: function (latlngs, opts) { this._lls = latlngs || []; this.options = opts || {}; this._id = uid('line'); },
        _geo: function () {
            var first = this._lls[0];
            var isPt = function (x) { return isArr(x) || (x && typeof x === 'object' && 'lat' in x); };
            // MultiLineString when the first element is itself a list of points
            var multi = first && isArr(first) && first.length && isPt(first[0]);
            var geom = multi ? { type: 'MultiLineString', coordinates: this._lls.map(_coordsOf) }
                             : { type: 'LineString', coordinates: _coordsOf(this._lls) };
            return { type: 'Feature', geometry: geom };
        },
        _addToGL: function (map) {
            this._map = map; var gl = map._gl, id = this._id, self = this, o = this.options;
            // Batched: a shared L.canvas renderer draws thousands of polylines as ONE
            // geojson layer (the archive's 13k-track view). Route to it, no own layer.
            if (o.renderer && o.renderer._isBatch) { o.renderer._ensure(map); o.renderer._addLine(this); this._batch = o.renderer; return; }
            map._whenStyle(function () {
                if (gl.getSource(id)) return;
                gl.addSource(id, { type: 'geojson', data: self._geo() });
                var paint = { 'line-color': o.color || '#3388ff', 'line-width': o.weight != null ? o.weight : 3,
                              'line-opacity': o.opacity != null ? o.opacity : 1 };
                if (o.dashArray) paint['line-dasharray'] = String(o.dashArray).split(/[ ,]+/).map(Number).map(function (n) { return n / (o.weight || 3); });
                map._glAdd({ id: id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: paint }, map._paneZ(o.pane || 'overlayPane'));
                self._added = true;
            });
        },
        _removeFromGL: function (map) { if (this._batch) { this._batch._removeLine(this); return; }
            var gl = map._gl; try { if (gl.getLayer(this._id)) gl.removeLayer(this._id); if (gl.getSource(this._id)) gl.removeSource(this._id); } catch (e) {} },
        setLatLngs: function (lls) { this._lls = lls; var gl = this._map && this._map._gl, src = gl && gl.getSource(this._id); if (src) src.setData(this._geo()); return this; },
        setStyle: function (st) { var gl = this._map && this._map._gl; if (gl && gl.getLayer(this._id)) { if (st.color) gl.setPaintProperty(this._id, 'line-color', st.color); if (st.opacity != null) gl.setPaintProperty(this._id, 'line-opacity', st.opacity); if (st.weight != null) gl.setPaintProperty(this._id, 'line-width', st.weight); } Object.assign(this.options, st); return this; },
        bindTooltip: function (content, opts) { this._tip = { content: content, opts: opts || {} }; return this; },
        bindPopup: function (content, opts) { this._popup = content instanceof Popup ? content : new Popup(opts).setContent(content); return this; },
        on: function (type, fn, ctx) { var self = this; if (!this._evts) this._evts = {}; String(type).split(' ').forEach(function (t) { (self._evts[t] = self._evts[t] || []).push(ctx ? fn.bind(ctx) : fn); }); return this; },
        bringToFront: function () { return this; }
    });

    // ── L.canvas → a real batch renderer (thousands of polylines/circleMarkers on
    //    ONE geojson source each). Leaflet uses a shared canvas; we collect every
    //    layer that names this renderer and draw them as 2 line layers (solid +
    //    dashed) + 1 circle layer. Click/hover dispatch via a per-feature index. ──
    function CanvasRenderer(opts) { this.options = opts || {}; this._isBatch = true; this._id = uid('canv');
        this._lines = []; this._circs = []; this._map = null; this._ready = false; this._raf = null; this._rmL = 0; this._rmC = 0; }
    CanvasRenderer.prototype._ensure = function (map) {
        if (this._map) return; this._map = map; var gl = map._gl, id = this._id, self = this;
        map._whenStyle(function () {
            gl.addSource(id + '-l', { type: 'geojson', data: self._lineFC() });
            gl.addSource(id + '-c', { type: 'geojson', data: self._circFC() });
            var zl = map._paneZ('overlayPane'), zc = map._paneZ('markerPane');
            map._glAdd({ id: id + '-ls', type: 'line', source: id + '-l', filter: ['!=', ['get', '_d'], 1],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-color': ['get', '_lc'], 'line-width': ['get', '_lw'], 'line-opacity': ['get', '_lo'] } }, zl);
            map._glAdd({ id: id + '-ld', type: 'line', source: id + '-l', filter: ['==', ['get', '_d'], 1],
                layout: { 'line-join': 'round' },
                paint: { 'line-color': ['get', '_lc'], 'line-width': ['get', '_lw'], 'line-opacity': ['get', '_lo'], 'line-dasharray': [4, 3] } }, zl);
            map._glAdd({ id: id + '-cm', type: 'circle', source: id + '-c',
                paint: { 'circle-color': ['get', '_fc'], 'circle-radius': ['get', '_r'], 'circle-opacity': ['get', '_fo'],
                         'circle-stroke-width': ['get', '_sw'], 'circle-stroke-color': ['get', '_sc'] } }, zc);
            ['-ls', '-ld', '-cm'].forEach(function (suf) {
                var arr = suf === '-cm' ? '_circs' : '_lines';
                gl.on('click', id + suf, function (e) { self._dispatch(self[arr], e); });
                gl.on('mousemove', id + suf, function (e) { self._hover(self[arr], e); });
                gl.on('mouseenter', id + suf, function () { gl.getCanvas().style.cursor = 'pointer'; });
                gl.on('mouseleave', id + suf, function () { self._unhover(); gl.getCanvas().style.cursor = ''; });
            });
            self._ready = true; self._flush();
        });
    };
    CanvasRenderer.prototype._addLine = function (l) { this._lines.push(l); this._flush(); };
    CanvasRenderer.prototype._addCirc = function (c) { this._circs.push(c); this._flush(); };
    CanvasRenderer.prototype._removeLine = function (l) { l._bRemoved = true; this._rmL++; this._flush(); };
    CanvasRenderer.prototype._removeCirc = function (c) { c._bRemoved = true; this._rmC++; this._flush(); };
    CanvasRenderer.prototype._lineFC = function () { var fs = [];
        for (var i = 0; i < this._lines.length; i++) { var L = this._lines[i]; if (L._bRemoved) continue; var o = L.options || {};
            var g = L._geo(); g.properties = { _bi: i, _lc: o.color || '#3388ff', _lw: o.weight != null ? o.weight : 2,
                _lo: o.opacity != null ? o.opacity : 1, _d: o.dashArray ? 1 : 0 }; fs.push(g); }
        return { type: 'FeatureCollection', features: fs }; };
    CanvasRenderer.prototype._circFC = function () { var fs = [];
        for (var i = 0; i < this._circs.length; i++) { var C = this._circs[i]; if (C._bRemoved) continue; var o = C.options || {}, ll = C._ll;
            fs.push({ type: 'Feature', properties: { _bi: i, _fc: o.fillColor || o.color || '#3388ff', _r: o.radius || 4,
                _fo: o.fillOpacity != null ? o.fillOpacity : 1, _sw: o.weight != null ? o.weight : 1, _sc: o.color || '#fff' },
                geometry: { type: 'Point', coordinates: [_wrapLng(ll.lng), ll.lat] } }); }
        return { type: 'FeatureCollection', features: fs }; };
    CanvasRenderer.prototype._flush = function () { if (!this._ready || this._raf) return; var self = this;
        // setTimeout, NOT requestAnimationFrame: rAF is paused in a backgrounded tab,
        // which would strand the batched setData. setTimeout still fires (clamped).
        this._raf = setTimeout(function () { self._raf = null;
            if (self._rmL > 256) { self._lines = self._lines.filter(function (l) { return !l._bRemoved; }); self._rmL = 0; }
            if (self._rmC > 256) { self._circs = self._circs.filter(function (c) { return !c._bRemoved; }); self._rmC = 0; }
            var gl = self._map._gl, ls = gl.getSource(self._id + '-l'), cs = gl.getSource(self._id + '-c');
            if (ls) ls.setData(self._lineFC()); if (cs) cs.setData(self._circFC()); }, 0); };
    CanvasRenderer.prototype._dispatch = function (arr, e) { var L = arr[e.features[0].properties._bi]; if (!L) return;
        if (L._evts && L._evts.click) L._evts.click.forEach(function (fn) { try { fn({ type: 'click', target: L, latlng: e.lngLat }); } catch (x) {} });
        if (L._popup && this._map) L._popup._ml().setLngLat(e.lngLat).addTo(this._map._gl); };
    CanvasRenderer.prototype._hover = function (arr, e) { var L = arr[e.features[0].properties._bi]; if (!L || !L._tip) { this._unhover(); return; }
        if (!this._tipEl) { this._tipEl = document.createElement('div'); this._tipEl.style.cssText = 'position:fixed;z-index:1200;pointer-events:none;white-space:nowrap;'; }
        this._tipEl.className = 'leaflet-tooltip ' + (L._tip.opts.className || '');
        var c = L._tip.content; this._tipEl.innerHTML = typeof c === 'string' ? c : (c && c.outerHTML || '');
        document.body.appendChild(this._tipEl);
        this._tipEl.style.left = (e.originalEvent.clientX + 12) + 'px'; this._tipEl.style.top = (e.originalEvent.clientY - 8) + 'px'; };
    CanvasRenderer.prototype._unhover = function () { if (this._tipEl && this._tipEl.parentNode) this._tipEl.parentNode.removeChild(this._tipEl); };

    // ── Circle (radius in METRES) → geojson polygon ──
    var Circle = extend.call(Layer, {
        initialize: function (latlng, opts) { this._ll = toLatLng(latlng); this.options = opts || {}; this._radius = (opts && opts.radius) || 1000; this._id = uid('circ'); },
        _geo: function () { var c = this._ll, R = this._radius, latR = c.lat * Math.PI / 180, pts = [];
            for (var i = 0; i <= 64; i++) { var a = i / 64 * 2 * Math.PI;
                pts.push([c.lng + (R * Math.cos(a)) / (111320 * Math.cos(latR)), c.lat + (R * Math.sin(a)) / 110540]); }
            return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] } }; },
        _addToGL: function (map) { this._map = map; var gl = map._gl, id = this._id, self = this, o = this.options;
            map._whenStyle(function () { if (gl.getSource(id)) return; gl.addSource(id, { type: 'geojson', data: self._geo() });
                var cz = map._paneZ(o.pane || 'overlayPane');
                if (o.fill !== false) map._glAdd({ id: id + '-f', type: 'fill', source: id, paint: { 'fill-color': o.fillColor || o.color || '#3388ff', 'fill-opacity': o.fillOpacity != null ? o.fillOpacity : 0.2 } }, cz - 1);
                map._glAdd({ id: id, type: 'line', source: id, paint: { 'line-color': o.color || '#3388ff', 'line-width': o.weight != null ? o.weight : 2, 'line-opacity': o.opacity != null ? o.opacity : 1 } }, cz); self._added = true; }); },
        _removeFromGL: function (map) { var gl = map._gl; [this._id, this._id + '-f'].forEach(function (l) { try { if (gl.getLayer(l)) gl.removeLayer(l); } catch (e) {} }); try { if (gl.getSource(this._id)) gl.removeSource(this._id); } catch (e) {} },
        setRadius: function (r) { this._radius = r; var src = this._map && this._map._gl.getSource(this._id); if (src) src.setData(this._geo()); return this; },
        setLatLng: function (ll) { this._ll = toLatLng(ll); var src = this._map && this._map._gl.getSource(this._id); if (src) src.setData(this._geo()); return this; },
        setStyle: function () { return this; }, bringToFront: function () { return this; }
    });

    // ── Rectangle (bounds → filled polygon; interactive hit target) ──
    //    Used by the microwave layer for per-swath click/hover popups. The
    //    fill is usually transparent (fillOpacity 0) but still hit-tests, so
    //    the user can click anywhere inside the swath rectangle. Modeled on
    //    Circle, plus event wiring (Circle is non-interactive). Without this
    //    class L.rectangle was undefined → _addOrbit threw on the first orbit
    //    and aborted _renderAll before setItems(), so the MW mosaic stayed empty.
    var Rectangle = extend.call(Layer, {
        initialize: function (bounds, opts) {
            this._bounds = bounds instanceof LatLngBounds ? bounds : new LatLngBounds(bounds);
            this.options = opts || {}; this._id = uid('rect');
        },
        _geo: function () {
            var b = this._bounds, s = b.getSouth(), w = b.getWest(), n = b.getNorth(), e = b.getEast();
            var ring = [[w, s], [e, s], [e, n], [w, n], [w, s]];
            return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } };
        },
        _addToGL: function (map) {
            this._map = map; var gl = map._gl, id = this._id, self = this, o = this.options;
            map._whenStyle(function () {
                if (gl.getSource(id)) return;
                gl.addSource(id, { type: 'geojson', data: self._geo() });
                var z = map._paneZ(o.pane || 'overlayPane');
                if (o.fill !== false) map._glAdd({ id: id + '-f', type: 'fill', source: id,
                    paint: { 'fill-color': o.fillColor || o.color || '#ffffff',
                             'fill-opacity': o.fillOpacity != null ? o.fillOpacity : 0 } }, z - 1);
                map._glAdd({ id: id, type: 'line', source: id,
                    paint: { 'line-color': o.color || '#3388ff', 'line-width': o.weight != null ? o.weight : 1,
                             'line-opacity': o.opacity != null ? o.opacity : 1 } }, z);
                self._added = true;
                if (o.interactive !== false && o.fill !== false) self._wire(gl, id + '-f');
            });
        },
        _wire: function (gl, hitId) {
            var self = this;
            this._glClick = function (e) {
                if (self._popup && self._map) self._popup._ml().setLngLat(e.lngLat).addTo(self._map._gl);
                self._fire('click', e);
            };
            this._glEnter = function (e) { gl.getCanvas().style.cursor = 'pointer'; self._fire('mouseover', e); };
            this._glLeave = function (e) { gl.getCanvas().style.cursor = ''; self._fire('mouseout', e); };
            gl.on('click', hitId, this._glClick);
            gl.on('mouseenter', hitId, this._glEnter);
            gl.on('mouseleave', hitId, this._glLeave);
        },
        _fire: function (type, e) { var self = this;
            ((this._evts && this._evts[type]) || []).forEach(function (fn) {
                try { fn({ type: type, target: self, latlng: e && e.lngLat }); } catch (x) {} }); },
        on: function (type, fn, ctx) { var self = this; if (!this._evts) this._evts = {};
            String(type).split(' ').forEach(function (t) { (self._evts[t] = self._evts[t] || []).push(ctx ? fn.bind(ctx) : fn); }); return this; },
        off: function () { return this; },
        bindPopup: function (content, opts) { this._popup = content instanceof Popup ? content : new Popup(opts).setContent(content); return this; },
        bindTooltip: function (content, opts) { this._tip = { content: content, opts: opts || {} }; return this; },
        setStyle: function (st) { var gl = this._map && this._map._gl;
            if (gl && gl.getLayer(this._id)) {
                if (st.color) gl.setPaintProperty(this._id, 'line-color', st.color);
                if (st.opacity != null) gl.setPaintProperty(this._id, 'line-opacity', st.opacity);
                if (st.weight != null) gl.setPaintProperty(this._id, 'line-width', st.weight);
            }
            if (gl && gl.getLayer(this._id + '-f')) {
                if (st.fillColor) gl.setPaintProperty(this._id + '-f', 'fill-color', st.fillColor);
                if (st.fillOpacity != null) gl.setPaintProperty(this._id + '-f', 'fill-opacity', st.fillOpacity);
            }
            Object.assign(this.options, st); return this; },
        setBounds: function (b) { this._bounds = b instanceof LatLngBounds ? b : new LatLngBounds(b);
            var src = this._map && this._map._gl.getSource(this._id); if (src) src.setData(this._geo()); return this; },
        bringToFront: function () { return this; },
        _removeFromGL: function (map) { var gl = map._gl, id = this._id;
            if (this._glClick) { try { gl.off('click', id + '-f', this._glClick);
                gl.off('mouseenter', id + '-f', this._glEnter); gl.off('mouseleave', id + '-f', this._glLeave); } catch (e) {} }
            [id, id + '-f'].forEach(function (l) { try { if (gl.getLayer(l)) gl.removeLayer(l); } catch (e) {} });
            try { if (gl.getSource(id)) gl.removeSource(id); } catch (e) {} }
    });

    // ── Control (custom corner widgets) ──
    // Merge prototype options (where L.Control.extend subclasses put their
    // default { position: ... }) with the passed opts, like Leaflet's setOptions.
    // Without this, `new Sub()` (no opts) shadowed the prototype's position and
    // every option-less control fell back to 'topright' (e.g. the bottom-left
    // animation/DeepMind dock landed top-right).
    function Control(opts) { this.options = Object.assign({}, this.options, opts); }
    Control.prototype.addTo = function (map) { map.addControl(this); return this; };
    Control.prototype.setPosition = function (p) { this.options.position = p; if (this._el) _placeCtrl(this._el, p); return this; };
    Control.prototype.remove = function () { if (this._map) this._map.removeControl(this); return this; };
    Control.extend = function (proto) { function C(o) { Control.call(this, o); if (this.initialize) this.initialize(o); } C.prototype = Object.create(Control.prototype); Object.assign(C.prototype, proto || {}); C.extend = Control.extend; return C; };
    function _placeCtrl(el, pos) { pos = pos || 'topright'; el.style.position = 'absolute';
        // Controls (Layers menu, zoom, etc.) must sit above every pane — Leaflet's
        // controlContainer is ~z800, above popupPane (700). At z5 the env wind-barb
        // canvas (overlayPane, z400) painted over the open Layers menu.
        el.style.zIndex = 800;
        el.style.top = el.style.bottom = el.style.left = el.style.right = '';
        el.style[pos.indexOf('top') >= 0 ? 'top' : 'bottom'] = '10px';
        el.style[pos.indexOf('left') >= 0 ? 'left' : 'right'] = '10px'; }
    Map.prototype.addControl = function (ctrl) {
        if (ctrl && typeof ctrl.onAdd === 'function') { ctrl._map = this; var el = ctrl.onAdd(this);
            if (el) { _placeCtrl(el, (ctrl.options && ctrl.options.position) || 'topright'); this.getContainer().appendChild(el); ctrl._el = el; } }
        return this;
    };
    Map.prototype.removeControl = function (ctrl) { if (ctrl && ctrl._el && ctrl._el.parentNode) ctrl._el.parentNode.removeChild(ctrl._el); return this; };

    // ── Markers / popups (DOM) ──
    function makeIconEl(icon) {
        var el = document.createElement('div');
        if (icon && icon._html != null) { el.innerHTML = icon._html; if (icon._className) el.className = icon._className; }
        else { el.style.width = '12px'; el.style.height = '12px'; el.style.borderRadius = '50%'; el.style.background = '#3388ff'; el.style.border = '2px solid #fff'; }
        return el;
    }
    var _domEvtMap = { click: 'click', dblclick: 'dblclick', mousedown: 'mousedown', mouseup: 'mouseup', mouseover: 'mouseenter', mouseout: 'mouseleave', contextmenu: 'contextmenu' };
    var Marker = extend.call(Layer, {
        initialize: function (latlng, opts) { this._ll = toLatLng(latlng); this.options = opts || {}; this._evts = {}; },
        _addToGL: function (map) { this._map = map;
            this._m = new maplibregl.Marker({ element: this.options.icon ? makeIconEl(this.options.icon) : undefined, anchor: 'center' })
                .setLngLat(mlWrap(this._ll)).addTo(map._gl);
            if (this._popup) { this._m.setPopup(this._popup._ml()); this._bridgePopup(); }
            // maplibregl markers all share one DOM container ordered by insertion, so
            // Leaflet pane z-order doesn't apply. Honor zIndexOffset as a CSS z-index
            // so e.g. genesis pills can sit above the track dots regardless of order.
            if (this.options.zIndexOffset != null) this.setZIndexOffset(this.options.zIndexOffset);
            this._applyTooltip(); this._applyEvents(); },
        _removeFromGL: function () { if (this._tipHide) this._tipHide(); if (this._m) this._m.remove(); },
        setLatLng: function (ll) { this._ll = toLatLng(ll); if (this._m) this._m.setLngLat(mlWrap(this._ll)); return this; },
        getLatLng: function () { return this._ll; },
        // Fire a synthetic Leaflet event to handlers registered via .on().
        _fireEvt: function (type, data) { var self = this; ((this._evts && this._evts[type]) || []).forEach(function (fn) {
            try { fn(Object.assign({ type: type, target: self, latlng: self._ll }, data || {})); } catch (e) {} }); },
        // Bridge the native maplibregl popup's open/close to Leaflet popupopen/popupclose
        // (e.g. RT monitor prefetches a storm's frame bundle on popupopen).
        _bridgePopup: function () { var self = this, p = this._popup && this._popup._mlp; if (!p || this._popupBridged) return; this._popupBridged = true;
            p.on('open', function () { self._fireEvt('popupopen'); }); p.on('close', function () { self._fireEvt('popupclose'); }); },
        bindPopup: function (content, opts) { this._popup = content instanceof Popup ? content : new Popup(opts).setContent(content); if (this._m) { this._m.setPopup(this._popup._ml()); this._bridgePopup(); } return this; },
        bindTooltip: function (content, opts) { this._tip = { content: content, opts: opts || {} }; if (this._m) this._applyTooltip(); return this; },
        setTooltipContent: function (content) {
            this._tip = this._tip || { content: '', opts: {} };
            this._tip.content = content;
            // Live-update if the tip div is currently shown (hover open).
            if (this._tipEl) this._tipEl.innerHTML = typeof content === 'string' ? content : (content && content.outerHTML || '');
            return this; },
        setIcon: function (icon) { this.options.icon = icon;
            // Refresh the live marker element in place (keeps position/popup/events)
            // so an icon CHANGE (e.g. the IR objective-center marker restyling) shows.
            if (this._m) { var cur = this._m.getElement(), neu = makeIconEl(icon);
                if (cur && neu) { cur.className = neu.className; cur.style.cssText = neu.style.cssText; cur.innerHTML = neu.innerHTML; } }
            return this; },
        on: function (type, fn, ctx) { if (!this._evts) this._evts = {}; var _self = this;
            String(type).split(' ').forEach(function (t) { (_self._evts[t] = _self._evts[t] || []).push(ctx ? fn.bind(ctx) : fn); });
            if (this._m) this._applyEvents(); return this; },
        off: function () { return this; },
        // Tooltips are positioned DOM divs anchored to the marker's on-screen rect,
        // NOT maplibregl.Popup. maplibregl re-expresses a marker's lng in the
        // world-copy nearest the map center (a WPac marker reads as lng -235), and
        // Popup.setLngLat() can't project that → it strands the tip at 0,0 (top-left).
        // The marker DOM element is always correctly placed, so we hang the tip off
        // its getBoundingClientRect. Using the Leaflet tooltip classes also lets the
        // site's .leaflet-tooltip / .ir-stn-plot-tooltip CSS style it (readable).
        _applyTooltip: function () { var self = this; if (!this._tip || !this._m || this._tipBound) return; var el = this._m.getElement(); if (!el) return; this._tipBound = true;
            var dir = this._tip.opts.direction || 'top', off = this._tip.opts.offset || [0, 0];
            el.style.cursor = el.style.cursor || 'pointer';
            function show() {
                if (!self._tipEl) { self._tipEl = document.createElement('div');
                    self._tipEl.className = 'leaflet-tooltip leaflet-tooltip-' + dir + ' ' + (self._tip.opts.className || '');
                    self._tipEl.style.cssText = 'position:fixed;z-index:1200;pointer-events:none;opacity:1;white-space:nowrap;'; }
                var c = self._tip.content; self._tipEl.innerHTML = typeof c === 'string' ? c : (c && c.outerHTML || '');
                var wasOpen = !!self._tipEl.parentNode;
                document.body.appendChild(self._tipEl);
                // Fire Leaflet's tooltipopen so handlers relying on it work (e.g. the
                // archive's recon/FL hover guard _gaFLTooltipOpen, which suppresses the
                // IR Tb hover so recon takes precedence). Only on the open transition.
                if (!wasOpen) self._fireEvt('tooltipopen');
                var r = el.getBoundingClientRect(), t = self._tipEl.getBoundingClientRect();
                var cx = r.left + r.width / 2, ox = off[0] || 0, oy = off[1] || 0, x, y;
                if (dir === 'bottom') { x = cx - t.width / 2; y = r.bottom + 6; }
                else if (dir === 'left') { x = r.left - t.width - 6; y = r.top + r.height / 2 - t.height / 2; }
                else if (dir === 'right') { x = r.right + 6; y = r.top + r.height / 2 - t.height / 2; }
                else { x = cx - t.width / 2; y = r.top - t.height - 6; }   // 'top' (default)
                self._tipEl.style.left = Math.round(x + ox) + 'px'; self._tipEl.style.top = Math.round(y + oy) + 'px';
            }
            self._tipHide = function () { if (self._tipEl && self._tipEl.parentNode) { self._tipEl.parentNode.removeChild(self._tipEl); self._fireEvt('tooltipclose'); } };
            el.addEventListener('mouseenter', show);
            if (this._tip.opts.sticky) el.addEventListener('mousemove', function () { if (self._tipEl && self._tipEl.parentNode) show(); });
            el.addEventListener('mouseleave', self._tipHide); },
        _applyEvents: function () { var self = this; if (!this._m || !this._evts) return; var el = this._m.getElement(); if (!el) return; this._boundT = this._boundT || {};
            Object.keys(this._evts).forEach(function (t) { if (self._boundT[t]) return; self._boundT[t] = true;
                el.addEventListener(_domEvtMap[t] || t, function (ev) {
                    var e = { type: t, originalEvent: ev, latlng: self._ll, target: self,
                              stopPropagation: function () { ev.stopPropagation(); }, preventDefault: function () { ev.preventDefault(); } };
                    (self._evts[t] || []).forEach(function (fn) { fn(e); }); }); }); },
        setOpacity: function (o) { if (this._m && this._m.getElement()) this._m.getElement().style.opacity = o; return this; },
        setZIndexOffset: function (z) { this.options.zIndexOffset = z; var el = this._m && this._m.getElement(); if (el) el.style.zIndex = z; return this; }
    });
    var CircleMarker = extend.call(Marker, {
        initialize: function (latlng, opts) { this._ll = toLatLng(latlng); this.options = opts || {}; this._evts = {}; var o = this.options;
            var el = document.createElement('div'); var r = (o.radius || 5) * 2;
            el.style.width = r + 'px'; el.style.height = r + 'px'; el.style.borderRadius = '50%';
            el.style.background = o.fillColor || o.color || '#3388ff'; el.style.opacity = o.fillOpacity != null ? o.fillOpacity : 1;
            el.style.border = (o.weight || 1) + 'px solid ' + (o.color || '#fff'); this.options.icon = { _el: el }; },
        _addToGL: function (map) { this._map = map; var o = this.options;
            // Batched (shared L.canvas renderer): join the renderer's circle source
            // instead of making a DOM marker — the archive draws thousands of
            // genesis/LMI dots this way.
            if (o.renderer && o.renderer._isBatch) { o.renderer._ensure(map); o.renderer._addCirc(this); this._batch = o.renderer; return; }
            this._m = new maplibregl.Marker({ element: this.options.icon._el, anchor: 'center' }).setLngLat(mlWrap(this._ll)).addTo(map._gl);
            if (this._popup) this._m.setPopup(this._popup._ml()); this._applyTooltip(); this._applyEvents(); },
        _removeFromGL: function () { if (this._batch) { this._batch._removeCirc(this); return; } if (this._tipHide) this._tipHide(); if (this._m) this._m.remove(); },
        // setRadius/setStyle on circle dots (e.g. WeatherLab genesis markers rescaled
        // on zoom). Batched dots re-render via the renderer's circle source; DOM dots
        // mutate their element. Without setRadius the zoom-rescale loop threw.
        setRadius: function (radius) { this.options.radius = radius;
            if (this._batch) { this._batch._flush(); return this; }
            var el = this.options.icon && this.options.icon._el; if (el) { var d = (radius || 5) * 2; el.style.width = d + 'px'; el.style.height = d + 'px'; }
            return this; },
        setStyle: function (st) { st = st || {}; Object.assign(this.options, st);
            if (this._batch) { this._batch._flush(); return this; }
            var el = this.options.icon && this.options.icon._el; if (el) {
                if (st.fillColor || st.color) el.style.background = this.options.fillColor || this.options.color || '#3388ff';
                if (st.fillOpacity != null) el.style.opacity = st.fillOpacity;
                if (st.color || st.weight != null) el.style.border = (this.options.weight || 1) + 'px solid ' + (this.options.color || '#fff'); }
            return this; }
    });

    function Popup(opts) { this.options = opts || {}; this._content = ''; }
    Popup.prototype.setContent = function (c) { this._content = c; if (this._mlp) this._mlp.setHTML(typeof c === 'string' ? c : (c.outerHTML || '')); return this; };
    Popup.prototype.setLatLng = function (ll) { this._ll = toLatLng(ll); return this; };
    Popup.prototype._ml = function () { if (!this._mlp) { this._mlp = new maplibregl.Popup({ offset: this.options.offset || 12, closeButton: this.options.closeButton !== false, maxWidth: this.options.maxWidth || '320px' }); this._mlp.setHTML(typeof this._content === 'string' ? this._content : (this._content.outerHTML || '')); } return this._mlp; };
    Popup.prototype.addTo = function (map) { var p = this._ml(); if (this._ll) p.setLngLat(mlWrap(this._ll)); p.addTo(map._gl); return this; };
    Popup.prototype.openOn = Popup.prototype.addTo;

    function DivIcon(opts) { opts = opts || {}; this._html = opts.html || ''; this._className = opts.className || ''; }
    function Icon(opts) { opts = opts || {}; this._html = '<img src="' + (opts.iconUrl || '') + '">'; this._className = opts.className || ''; }

    // ── LayerGroup ──
    var LayerGroup = extend.call(Layer, {
        initialize: function (layers) { this._members = (layers || []).slice(); },
        _addToGL: function (map) { this._map = map; this._members.forEach(function (l) { map.addLayer(l); }); },
        _removeFromGL: function (map) { this._members.forEach(function (l) { map.removeLayer(l); }); },
        addLayer: function (l) { this._members.push(l); if (this._map) this._map.addLayer(l); return this; },
        removeLayer: function (l) { var i = this._members.indexOf(l); if (i >= 0) this._members.splice(i, 1); if (this._map) this._map.removeLayer(l); return this; },
        clearLayers: function () { var m = this._map; this._members.forEach(function (l) { if (m) m.removeLayer(l); }); this._members = []; return this; },
        eachLayer: function (fn) { this._members.forEach(fn); return this; }
    });

    // ── MarkerClusterGroup → MapLibre native (supercluster) clustering ──
    // Leaflet.markercluster groups N markers DOM-side (slow at thousands). MapLibre
    // clusters a geojson source on the GPU. We collect added markers, project them to
    // a clustered source, and render: unclustered = colored circles (the markers are
    // just colored dots), clusters = bubble + count, click point → the marker's own
    // click handler + popup, click cluster → zoom to expansion.
    function _markerColor(m) {
        var icon = m && m.options && m.options.icon, html = icon && icon._html;
        if (html) { var mt = /background(?:-color)?:\s*([^;"')]+)/i.exec(html); if (mt) return mt[1].trim(); }
        return (m && m.options && (m.options.fillColor || m.options.color)) || '#3388ff';
    }
    var MarkerClusterGroup = extend.call(Layer, {
        initialize: function (opts) { this.options = opts || {}; this._markers = []; this._id = uid('mcg'); },
        addLayer: function (m) { this._markers.push(m); this._refresh(); return this; },
        addLayers: function (arr) { var s = this; (arr || []).forEach(function (m) { s._markers.push(m); }); this._refresh(); return this; },
        removeLayer: function (m) { var i = this._markers.indexOf(m); if (i >= 0) this._markers.splice(i, 1); this._refresh(); return this; },
        clearLayers: function () { this._markers = []; this._refresh(); return this; },
        eachLayer: function (fn) { this._markers.forEach(fn); return this; },
        getLayers: function () { return this._markers.slice(); },
        _fc: function () { return { type: 'FeatureCollection', features: this._markers.map(function (m, i) {
            var ll = m._ll || toLatLng(m.getLatLng ? m.getLatLng() : m);
            return { type: 'Feature', properties: { _mi: i, color: _markerColor(m) },
                     geometry: { type: 'Point', coordinates: [_wrapLng(ll.lng), ll.lat] } }; }) }; },
        _refresh: function () { var gl = this._map && this._map._gl, src = gl && gl.getSource(this._id); if (src) src.setData(this._fc()); },
        _addToGL: function (map) { this._map = map; var gl = map._gl, id = this._id, self = this, o = this.options;
            map._whenStyle(function () {
                if (gl.getSource(id)) { gl.getSource(id).setData(self._fc()); return; }
                gl.addSource(id, { type: 'geojson', data: self._fc(), cluster: true,
                    clusterRadius: o.maxClusterRadius || 50,
                    clusterMaxZoom: (o.disableClusteringAtZoom != null ? o.disableClusteringAtZoom : 9) - 1 });
                var z = map._paneZ('markerPane');
                map._glAdd({ id: id + '-pts', type: 'circle', source: id, filter: ['!', ['has', 'point_count']],
                    paint: { 'circle-color': ['get', 'color'], 'circle-radius': 6, 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' } }, z);
                map._glAdd({ id: id + '-cl', type: 'circle', source: id, filter: ['has', 'point_count'],
                    paint: { 'circle-color': 'rgba(46,125,255,0.85)', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff',
                             'circle-radius': ['step', ['get', 'point_count'], 14, 25, 18, 100, 24] } }, z);
                map._glAdd({ id: id + '-cnt', type: 'symbol', source: id, filter: ['has', 'point_count'],
                    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true },
                    paint: { 'text-color': '#fff' } }, z + 1);
                gl.on('click', id + '-pts', function (e) { var f = e.features[0], m = self._markers[f.properties._mi]; if (m) self._activate(m, e.lngLat); });
                gl.on('click', id + '-cl', function (e) { var f = e.features[0]; var src = gl.getSource(id);
                    src.getClusterExpansionZoom(f.properties.cluster_id, function (err, zm) { if (!err) gl.easeTo({ center: f.geometry.coordinates, zoom: zm }); }); });
                ['-pts', '-cl'].forEach(function (suf) {
                    gl.on('mouseenter', id + suf, function () { gl.getCanvas().style.cursor = 'pointer'; });
                    gl.on('mouseleave', id + suf, function () { gl.getCanvas().style.cursor = ''; }); });
                self._added = true;
            }); },
        _activate: function (m, lngLat) {
            if (m._evts && m._evts.click) m._evts.click.forEach(function (fn) { try { fn({ type: 'click', target: m, latlng: m._ll }); } catch (e) {} });
            if (m._popup && this._map) { var p = m._popup._ml(); p.setLngLat(lngLat).addTo(this._map._gl); } },
        _removeFromGL: function (map) { var gl = map._gl;
            [this._id + '-pts', this._id + '-cl', this._id + '-cnt'].forEach(function (l) { try { if (gl.getLayer(l)) gl.removeLayer(l); } catch (e) {} });
            try { if (gl.getSource(this._id)) gl.removeSource(this._id); } catch (e) {} }
    });

    // ── GridLayer: generic stub; the composite IR layers are bridged to the
    //    mosaic raster source via a host-app edit (inc 1). A bare GridLayer here
    //    is inert so init doesn't throw. ──
    var GridLayer = extend.call(Layer, {
        initialize: function (opts) { this.options = opts || {}; },
        _addToGL: function () {}, _removeFromGL: function () {},
        setOpacity: function () { return this; }, redraw: function () { return this; }, setZIndex: function () { return this; }
    });

    // ── thin DomUtil / DomEvent ──
    var DomUtil = {
        create: function (tag, cls, parent) { var e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; },
        get: function (id) { return typeof id === 'string' ? document.getElementById(id) : id; },
        addClass: function (e, c) { e && e.classList.add(c); }, removeClass: function (e, c) { e && e.classList.remove(c); },
        hasClass: function (e, c) { return e && e.classList.contains(c); },
        // MUST write the SAME CSS property as setTransform (transform), like real
        // Leaflet. The canvas-overlay layers (MW mosaic, IR vector canvases) call
        // setPosition in _update and setTransform during zoom-anim on the SAME
        // element; if these wrote different properties (left/top vs transform) they
        // COMPOUND — the MW swaths landed ~15% of the viewport off the IR base.
        setPosition: function (e, p) { if (!e) return; e._leaflet_pos = p;
            e.style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0)'; },
        getPosition: function (e) { return (e && e._leaflet_pos) || new Point(0, 0); },
        remove: function (e) { if (e && e.parentNode) e.parentNode.removeChild(e); },
        setTransform: function (e, offset, scale) { if (!e) return; var p = offset || new Point(0, 0);
            e.style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0)' + (scale ? ' scale(' + scale + ')' : ''); }
    };
    var DomEvent = {
        on: function (el, t, fn, ctx) { el && el.addEventListener(t, ctx ? fn.bind(ctx) : fn); return this; },
        off: function (el, t, fn) { el && el.removeEventListener(t, fn); return this; },
        stop: function (e) { if (e) { e.preventDefault(); e.stopPropagation(); } return this; },
        preventDefault: function (e) { if (e) e.preventDefault(); return this; },
        stopPropagation: function (e) { if (e) e.stopPropagation(); return this; },
        disableClickPropagation: function () { return this; }, disableScrollPropagation: function () { return this; }
    };

    // ── public L namespace ──
    var L = {
        version: 'lflet_gl-0.1',
        map: function (c, o) { return new Map(c, o); },
        latLng: function (a, b) { return toLatLng(a, b); },
        latLngBounds: function (a, b) { return new LatLngBounds(a, b); },
        point: function (x, y) { return new Point(x, y); },
        bounds: function (a, b) { return new Bounds(a, b); },
        Point: Point, Bounds: Bounds,
        tileLayer: function (u, o) { return new TileLayer(u, o); },
        imageOverlay: function (u, b, o) { return new ImageOverlay(u, b, o); },
        geoJSON: function (d, o) { return new GeoJSON(d, o); },
        marker: function (ll, o) { return new Marker(ll, o); },
        circleMarker: function (ll, o) { return new CircleMarker(ll, o); },
        divIcon: function (o) { return new DivIcon(o); },
        icon: function (o) { return new Icon(o); },
        popup: function (o) { return new Popup(o); },
        layerGroup: function (l) { return new LayerGroup(l); },
        featureGroup: function (l) { return new LayerGroup(l); },
        markerClusterGroup: function (o) { return new MarkerClusterGroup(o); },
        createObjectURL: function (b) { return URL.createObjectURL(b); },
        revokeObjectURL: function (u) { return URL.revokeObjectURL(u); },
        polyline: function (ll, o) { return new Polyline(ll, o); },
        polygon: function (ll, o) { var p = new Polyline(ll, o); return p; },
        circle: function (ll, o) { return new Circle(ll, o); },
        rectangle: function (b, o) { return new Rectangle(b, o); },
        control: function (o) { return new Control(o); },
        canvas: function (o) { return new CanvasRenderer(o); },
        svg: function (o) { return new CanvasRenderer(o); },
        Map: Map, Layer: Layer, TileLayer: TileLayer, ImageOverlay: ImageOverlay,
        GeoJSON: GeoJSON, Marker: Marker, CircleMarker: CircleMarker, Popup: Popup,
        LayerGroup: LayerGroup, GridLayer: GridLayer, DivIcon: DivIcon, Icon: Icon,
        Polyline: Polyline, Circle: Circle, Rectangle: Rectangle, Control: Control,
        DomUtil: DomUtil, DomEvent: DomEvent, Util: { bind: function (fn, ctx) { return fn.bind(ctx); }, extend: Object.assign },
        Browser: { mobile: /Mobi|Android/i.test(navigator.userAgent), retina: (window.devicePixelRatio || 1) > 1, any3d: true }
    };
    // tileLayer.wms etc. — stub so missing plugins don't throw
    L.tileLayer.wms = function (u, o) { return new TileLayer(u, o); };

    global.L = L;
    global.LFLET_GL = true;
})(window);
