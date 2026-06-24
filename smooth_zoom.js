/* smooth_zoom.js — continuous, cursor-anchored wheel zoom for Leaflet.
 *
 * Leaflet's default scroll-wheel zoom debounces wheel deltas, computes a
 * single target zoom, and animates toward it — then _stop()s that animation
 * the instant the next wheel event arrives. Rapid trackpad scrolling keeps
 * interrupting the in-flight animation, which reads as the map "snapping"
 * between levels rather than tracking the wheel. zoomSnap:0 only removes the
 * rounding of the target; it does NOT make the wheel continuous.
 *
 * This handler instead eases the live zoom toward a goal each animation frame
 * (requestAnimationFrame), anchored at the cursor, so zoom follows the wheel
 * smoothly the way a GPU canvas viewer does.
 *
 * Opt-in per map: set { scrollWheelZoom: false, smoothWheelZoom: true } in the
 * map options (and keep zoomSnap:0 so the eased fractional zoom isn't snapped).
 * Default is OFF so other maps (mini locators, etc.) are unaffected.
 *
 * Adapted from mutsuyuki/Leaflet.SmoothWheelZoom (MIT).
 */
(function () {
    'use strict';
    if (typeof L === 'undefined' || L.Map.SmoothWheelZoom) return;

    L.Map.mergeOptions({ smoothWheelZoom: false, smoothSensitivity: 1 });

    L.Map.SmoothWheelZoom = L.Handler.extend({
        addHooks: function () {
            L.DomEvent.on(this._map._container, 'wheel', this._onWheelScroll, this);
        },

        removeHooks: function () {
            L.DomEvent.off(this._map._container, 'wheel', this._onWheelScroll, this);
        },

        _onWheelScroll: function (e) {
            if (!this._isWheeling) this._onWheelStart(e);
            this._onWheeling(e);
        },

        _onWheelStart: function (e) {
            var map = this._map;
            this._isWheeling = true;
            this._wheelMousePosition = map.mouseEventToContainerPoint(e);
            this._centerPoint = map.getSize()._divideBy(2);
            this._startLatLng = map.containerPointToLatLng(this._centerPoint);
            this._wheelStartLatLng = map.containerPointToLatLng(this._wheelMousePosition);
            this._startZoom = map.getZoom();
            this._moved = false;
            this._zooming = true;

            map._stop();
            if (map._panAnim) map._panAnim.stop();

            this._goalZoom = map.getZoom();
            this._prevCenter = map.getCenter();
            this._prevZoom = map.getZoom();

            this._zoomAnimationId = requestAnimationFrame(this._updateWheelZoom.bind(this));
        },

        _onWheeling: function (e) {
            var map = this._map;

            this._goalZoom = this._goalZoom - e.deltaY * 0.003 * map.options.smoothSensitivity;
            if (this._goalZoom < map.getMinZoom() || this._goalZoom > map.getMaxZoom()) {
                this._goalZoom = map._limitZoom(this._goalZoom);
            }
            this._wheelMousePosition = map.mouseEventToContainerPoint(e);

            clearTimeout(this._timeoutId);
            this._timeoutId = setTimeout(this._onWheelEnd.bind(this), 200);

            L.DomEvent.preventDefault(e);
            L.DomEvent.stopPropagation(e);
        },

        _onWheelEnd: function () {
            this._isWheeling = false;
            cancelAnimationFrame(this._zoomAnimationId);
            this._map._moveEnd(true);
        },

        _updateWheelZoom: function () {
            var map = this._map;

            if ((!map.getCenter().equals(this._prevCenter)) || map.getZoom() !== this._prevZoom) return;

            this._zoom = map.getZoom() + (this._goalZoom - map.getZoom()) * 0.3;
            this._zoom = Math.floor(this._zoom * 100) / 100;

            var delta = this._wheelMousePosition.subtract(this._centerPoint);
            if (delta.x === 0 && delta.y === 0) return;

            if (map.options.smoothWheelZoom === 'center') {
                this._center = this._startLatLng;
            } else {
                this._center = map.unproject(
                    map.project(this._wheelStartLatLng, this._zoom).subtract(delta), this._zoom);
            }

            map.setView(this._center, this._zoom, { animate: false });

            this._prevCenter = map.getCenter();
            this._prevZoom = map.getZoom();

            this._zoomAnimationId = requestAnimationFrame(this._updateWheelZoom.bind(this));
        }
    });

    L.Map.addInitHook('addHandler', 'smoothWheelZoom', L.Map.SmoothWheelZoom);
})();
