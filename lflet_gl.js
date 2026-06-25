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
        this._maxZoom = options.maxZoom != null ? options.maxZoom : 22;

        this._gl = new maplibregl.Map({
            container: el,
            style: { version: 8, sources: {}, layers: [
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
        // Registering an 'error' listener suppresses MapLibre's default console.error.
        // Full-globe image overlays (env filled fields) make MapLibre request a
        // wrapped world-copy tile (x=-1) that throws a harmless "outside of bounds"
        // during _finishLoading — the overlay still renders. Swallow only that;
        // surface everything else.
        this._gl.on('error', function (ev) { var m = ev && ev.error && ev.error.message || '';
            if (/outside of bounds/.test(m)) return; console.error('[lflet_gl]', ev && ev.error || ev); });

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
        this._gl.fitBounds([[b._sw.lng, b._sw.lat], [b._ne.lng, b._ne.lat]],
            { animate: !(opts && opts.animate === false), padding: 20 }); return this; };
    Map.prototype.getZoom = function () { return this._gl.getZoom(); };
    Map.prototype.setZoom = function (z) { this._gl.setZoom(z); return this; };
    Map.prototype.setMaxZoom = function (z) { this._maxZoom = z; this._gl.setMaxZoom(z); return this; };
    Map.prototype.setMinZoom = function (z) { this._gl.setMinZoom(z); return this; };
    Map.prototype.getCenter = function () { var c = this._gl.getCenter(); return new LatLng(c.lat, c.lng); };
    Map.prototype.getBounds = function () { var b = this._gl.getBounds(); return new LatLngBounds([b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]); };
    Map.prototype.getSize = function () { var c = this.getContainer(); return new Point(c.clientWidth, c.clientHeight); };
    Map.prototype.invalidateSize = function () { this._gl.resize(); return this; };
    Map.prototype.remove = function () { try { this._gl.remove(); } catch (e) {} };

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
        this.getContainer().appendChild(d); this._panes[name] = d; return d; };
    Map.prototype.getPane = function (name) { return this._panes[name] || this.createPane(name); };
    Map.prototype.getPanes = function () { return this._panes; };

    // layer add/remove. Built-in facade layers implement _addToGL/_removeFromGL.
    // Custom Leaflet layers (L.Layer.extend with onAdd/getEvents — env barbs,
    // recon barbs, microwave) are bridged: onAdd builds their pane canvas, and
    // their getEvents() redraw is re-fired on every MapLibre move so the canvas
    // stays synced through continuous zoom (they project via latLngToContainerPoint).
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
                gl.addSource(id, { type: 'raster', tiles: self._glUrls(), tileSize: 256,
                    maxzoom: self.options.maxZoom || 19, attribution: self.options.attribution || '' });
                var layer = { id: id, type: 'raster', source: id,
                    paint: { 'raster-opacity': self.options.opacity != null ? self.options.opacity : 1 } };
                gl.addLayer(layer);
                self._added = true;
                (self._loadCbs || []).forEach(function (f) { setTimeout(f, 0); });
            });
        },
        _removeFromGL: function (map) {
            var gl = map._gl; try { if (gl.getLayer(this._id)) gl.removeLayer(this._id); if (gl.getSource(this._id)) gl.removeSource(this._id); } catch (e) {}
            this._added = false;
        },
        // 'load' fires when the raster source is added (tiles stream lazily after).
        on: function (t, fn) { if (t === 'load') { (this._loadCbs = this._loadCbs || []).push(fn); if (this._added) setTimeout(fn, 0); } return this; },
        once: function (t, fn) { return this.on(t, fn); },
        setOpacity: function (o) { var gl = this._map && this._map._gl; if (gl && gl.getLayer(this._id)) gl.setPaintProperty(this._id, 'raster-opacity', o); this.options.opacity = o; return this; },
        setUrl: function (url) { this._url = url; if (this._map) { this._removeFromGL(this._map); this._addToGL(this._map); } return this; },
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
                gl.addLayer({ id: id, type: 'raster', source: id,
                    paint: { 'raster-opacity': self.options.opacity != null ? self.options.opacity : 1,
                             'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }); self._added = true; }); },
        _removeFromGL: function (map) { var gl = map._gl; try { if (gl.getLayer(this._id)) gl.removeLayer(this._id); if (gl.getSource(this._id)) gl.removeSource(this._id); } catch (e) {} },
        setOpacity: function (o) { var gl = this._map && this._map._gl; if (gl && gl.getLayer(this._id)) gl.setPaintProperty(this._id, 'raster-opacity', o); this.options.opacity = o; return this; },
        setUrl: function (u) { this._url = u; var gl = this._map && this._map._gl, src = gl && gl.getSource(this._id); if (src) src.updateImage({ url: u }); return this; },
        bringToFront: function () { return this; }
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
        initialize: function (data, opts) { this._data = _normFC(data); this.options = opts || {}; this._id = uid('geo'); },
        _setData: function () { var gl = this._map && this._map._gl, src = gl && gl.getSource(this._id); if (src) src.setData(this._data); },
        addData: function (d) {
            var fc = _normFC(d);
            this._data.features = (this._data.features || []).concat(fc.features);
            this._setData(); return this;
        },
        clearLayers: function () { this._data = _emptyFC(); this._setData(); return this; },
        setData: function (d) { this._data = _normFC(d); this._setData(); return this; },
        _addToGL: function (map) {
            this._map = map; var gl = map._gl, id = this._id, self = this;
            var st = this.options.style; if (typeof st === 'function') st = st({}) || {}; st = st || {};
            map._whenStyle(function () {
                if (gl.getSource(id)) return;
                gl.addSource(id, { type: 'geojson', data: self._data });
                gl.addLayer({ id: id + '-l', type: 'line', source: id,
                    paint: { 'line-color': st.color || '#000', 'line-width': st.weight != null ? st.weight : 1,
                             'line-opacity': st.opacity != null ? st.opacity : 1 } });
                if (st.fill && st.fillColor) gl.addLayer({ id: id + '-f', type: 'fill', source: id,
                    paint: { 'fill-color': st.fillColor, 'fill-opacity': st.fillOpacity != null ? st.fillOpacity : 0.2 } }, id + '-l');
                self._added = true;
            });
        },
        _removeFromGL: function (map) { var gl = map._gl; [this._id + '-l', this._id + '-f'].forEach(function (l) { try { if (gl.getLayer(l)) gl.removeLayer(l); } catch (e) {} }); try { if (gl.getSource(this._id)) gl.removeSource(this._id); } catch (e) {} },
        setStyle: function () { return this; }, bringToFront: function () { return this; }
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
            map._whenStyle(function () {
                if (gl.getSource(id)) return;
                gl.addSource(id, { type: 'geojson', data: self._geo() });
                var paint = { 'line-color': o.color || '#3388ff', 'line-width': o.weight != null ? o.weight : 3,
                              'line-opacity': o.opacity != null ? o.opacity : 1 };
                if (o.dashArray) paint['line-dasharray'] = String(o.dashArray).split(/[ ,]+/).map(Number).map(function (n) { return n / (o.weight || 3); });
                gl.addLayer({ id: id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: paint });
                self._added = true;
            });
        },
        _removeFromGL: function (map) { var gl = map._gl; try { if (gl.getLayer(this._id)) gl.removeLayer(this._id); if (gl.getSource(this._id)) gl.removeSource(this._id); } catch (e) {} },
        setLatLngs: function (lls) { this._lls = lls; var gl = this._map && this._map._gl, src = gl && gl.getSource(this._id); if (src) src.setData(this._geo()); return this; },
        setStyle: function (st) { var gl = this._map && this._map._gl; if (gl && gl.getLayer(this._id)) { if (st.color) gl.setPaintProperty(this._id, 'line-color', st.color); if (st.opacity != null) gl.setPaintProperty(this._id, 'line-opacity', st.opacity); if (st.weight != null) gl.setPaintProperty(this._id, 'line-width', st.weight); } Object.assign(this.options, st); return this; },
        bringToFront: function () { return this; }, on: function () { return this; }
    });

    // ── Circle (radius in METRES) → geojson polygon ──
    var Circle = extend.call(Layer, {
        initialize: function (latlng, opts) { this._ll = toLatLng(latlng); this.options = opts || {}; this._radius = (opts && opts.radius) || 1000; this._id = uid('circ'); },
        _geo: function () { var c = this._ll, R = this._radius, latR = c.lat * Math.PI / 180, pts = [];
            for (var i = 0; i <= 64; i++) { var a = i / 64 * 2 * Math.PI;
                pts.push([c.lng + (R * Math.cos(a)) / (111320 * Math.cos(latR)), c.lat + (R * Math.sin(a)) / 110540]); }
            return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] } }; },
        _addToGL: function (map) { this._map = map; var gl = map._gl, id = this._id, self = this, o = this.options;
            map._whenStyle(function () { if (gl.getSource(id)) return; gl.addSource(id, { type: 'geojson', data: self._geo() });
                if (o.fill !== false) gl.addLayer({ id: id + '-f', type: 'fill', source: id, paint: { 'fill-color': o.fillColor || o.color || '#3388ff', 'fill-opacity': o.fillOpacity != null ? o.fillOpacity : 0.2 } });
                gl.addLayer({ id: id, type: 'line', source: id, paint: { 'line-color': o.color || '#3388ff', 'line-width': o.weight != null ? o.weight : 2, 'line-opacity': o.opacity != null ? o.opacity : 1 } }); self._added = true; }); },
        _removeFromGL: function (map) { var gl = map._gl; [this._id, this._id + '-f'].forEach(function (l) { try { if (gl.getLayer(l)) gl.removeLayer(l); } catch (e) {} }); try { if (gl.getSource(this._id)) gl.removeSource(this._id); } catch (e) {} },
        setRadius: function (r) { this._radius = r; var src = this._map && this._map._gl.getSource(this._id); if (src) src.setData(this._geo()); return this; },
        setLatLng: function (ll) { this._ll = toLatLng(ll); var src = this._map && this._map._gl.getSource(this._id); if (src) src.setData(this._geo()); return this; },
        setStyle: function () { return this; }, bringToFront: function () { return this; }
    });

    // ── Control (custom corner widgets) ──
    function Control(opts) { this.options = opts || {}; }
    Control.prototype.addTo = function (map) { map.addControl(this); return this; };
    Control.prototype.setPosition = function (p) { this.options.position = p; if (this._el) _placeCtrl(this._el, p); return this; };
    Control.prototype.remove = function () { if (this._map) this._map.removeControl(this); return this; };
    Control.extend = function (proto) { function C(o) { Control.call(this, o); if (this.initialize) this.initialize(o); } C.prototype = Object.create(Control.prototype); Object.assign(C.prototype, proto || {}); C.extend = Control.extend; return C; };
    function _placeCtrl(el, pos) { pos = pos || 'topright'; el.style.position = 'absolute'; el.style.zIndex = 5;
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
                .setLngLat(ll2ml(this._ll)).addTo(map._gl);
            if (this._popup) this._m.setPopup(this._popup._ml());
            this._applyTooltip(); this._applyEvents(); },
        _removeFromGL: function () { if (this._tipPopup) this._tipPopup.remove(); if (this._m) this._m.remove(); },
        setLatLng: function (ll) { this._ll = toLatLng(ll); if (this._m) this._m.setLngLat(ll2ml(this._ll)); return this; },
        getLatLng: function () { return this._ll; },
        bindPopup: function (content, opts) { this._popup = content instanceof Popup ? content : new Popup(opts).setContent(content); if (this._m) this._m.setPopup(this._popup._ml()); return this; },
        bindTooltip: function (content, opts) { this._tip = { content: content, opts: opts || {} }; if (this._m) this._applyTooltip(); return this; },
        setIcon: function (icon) { this.options.icon = icon; return this; },
        on: function (type, fn, ctx) { if (!this._evts) this._evts = {}; var _self = this;
            String(type).split(' ').forEach(function (t) { (_self._evts[t] = _self._evts[t] || []).push(ctx ? fn.bind(ctx) : fn); });
            if (this._m) this._applyEvents(); return this; },
        off: function () { return this; },
        _applyTooltip: function () { var self = this; if (!this._tip || !this._m || this._tipBound) return; var el = this._m.getElement(); if (!el) return; this._tipBound = true;
            var dir = this._tip.opts.direction || 'top';
            var anchor = dir === 'top' ? 'bottom' : dir === 'bottom' ? 'top' : dir === 'left' ? 'right' : dir === 'right' ? 'left' : 'bottom';
            el.style.cursor = el.style.cursor || 'pointer';
            el.addEventListener('mouseenter', function () {
                if (!self._tipPopup) self._tipPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, anchor: anchor, offset: 10, className: 'lflet-tip ' + (self._tip.opts.className || '') });
                var c = self._tip.content; self._tipPopup.setHTML(typeof c === 'string' ? c : (c && c.outerHTML || '')).setLngLat(self._m.getLngLat()).addTo(self._map._gl); });
            el.addEventListener('mouseleave', function () { if (self._tipPopup) self._tipPopup.remove(); }); },
        _applyEvents: function () { var self = this; if (!this._m || !this._evts) return; var el = this._m.getElement(); if (!el) return; this._boundT = this._boundT || {};
            Object.keys(this._evts).forEach(function (t) { if (self._boundT[t]) return; self._boundT[t] = true;
                el.addEventListener(_domEvtMap[t] || t, function (ev) {
                    var e = { type: t, originalEvent: ev, latlng: self._ll, target: self,
                              stopPropagation: function () { ev.stopPropagation(); }, preventDefault: function () { ev.preventDefault(); } };
                    (self._evts[t] || []).forEach(function (fn) { fn(e); }); }); }); },
        setOpacity: function (o) { if (this._m && this._m.getElement()) this._m.getElement().style.opacity = o; return this; }, setZIndexOffset: function () { return this; }
    });
    var CircleMarker = extend.call(Marker, {
        initialize: function (latlng, opts) { this._ll = toLatLng(latlng); this.options = opts || {}; this._evts = {}; var o = this.options;
            var el = document.createElement('div'); var r = (o.radius || 5) * 2;
            el.style.width = r + 'px'; el.style.height = r + 'px'; el.style.borderRadius = '50%';
            el.style.background = o.fillColor || o.color || '#3388ff'; el.style.opacity = o.fillOpacity != null ? o.fillOpacity : 1;
            el.style.border = (o.weight || 1) + 'px solid ' + (o.color || '#fff'); this.options.icon = { _el: el }; },
        _addToGL: function (map) { this._map = map; this._m = new maplibregl.Marker({ element: this.options.icon._el, anchor: 'center' }).setLngLat(ll2ml(this._ll)).addTo(map._gl);
            if (this._popup) this._m.setPopup(this._popup._ml()); this._applyTooltip(); this._applyEvents(); }
    });

    function Popup(opts) { this.options = opts || {}; this._content = ''; }
    Popup.prototype.setContent = function (c) { this._content = c; if (this._mlp) this._mlp.setHTML(typeof c === 'string' ? c : (c.outerHTML || '')); return this; };
    Popup.prototype.setLatLng = function (ll) { this._ll = toLatLng(ll); return this; };
    Popup.prototype._ml = function () { if (!this._mlp) { this._mlp = new maplibregl.Popup({ offset: this.options.offset || 12, closeButton: this.options.closeButton !== false, maxWidth: this.options.maxWidth || '320px' }); this._mlp.setHTML(typeof this._content === 'string' ? this._content : (this._content.outerHTML || '')); } return this._mlp; };
    Popup.prototype.addTo = function (map) { var p = this._ml(); if (this._ll) p.setLngLat(ll2ml(this._ll)); p.addTo(map._gl); return this; };
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
        setPosition: function (e, p) { if (e) { e.style.left = p.x + 'px'; e.style.top = p.y + 'px'; } },
        getPosition: function (e) { return new Point(parseInt(e.style.left, 10) || 0, parseInt(e.style.top, 10) || 0); },
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
        polyline: function (ll, o) { return new Polyline(ll, o); },
        polygon: function (ll, o) { var p = new Polyline(ll, o); return p; },
        circle: function (ll, o) { return new Circle(ll, o); },
        control: function (o) { return new Control(o); },
        canvas: function (o) { return { _stub: 'canvas', options: o || {} }; },
        svg: function (o) { return { _stub: 'svg', options: o || {} }; },
        Map: Map, Layer: Layer, TileLayer: TileLayer, ImageOverlay: ImageOverlay,
        GeoJSON: GeoJSON, Marker: Marker, CircleMarker: CircleMarker, Popup: Popup,
        LayerGroup: LayerGroup, GridLayer: GridLayer, DivIcon: DivIcon, Icon: Icon,
        Polyline: Polyline, Circle: Circle, Control: Control,
        DomUtil: DomUtil, DomEvent: DomEvent, Util: { bind: function (fn, ctx) { return fn.bind(ctx); }, extend: Object.assign },
        Browser: { mobile: /Mobi|Android/i.test(navigator.userAgent), retina: (window.devicePixelRatio || 1) > 1, any3d: true }
    };
    // tileLayer.wms etc. — stub so missing plugins don't throw
    L.tileLayer.wms = function (u, o) { return new TileLayer(u, o); };

    global.L = L;
    global.LFLET_GL = true;
})(window);
