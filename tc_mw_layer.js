/* ─────────────────────────────────────────────────────────────────────
 *  tc_mw_layer.js — Shared "Microwave passes (last N hrs)" overlay.
 *
 *  Adds a toggleable Leaflet overlay that paints recent GMI/GPM
 *  microwave swaths onto any map. Used by both the RT Monitor
 *  (#ir-map) and the Global Archive storm-browser map (#storm-map).
 *
 *  Public API (exposed on window.TCMicrowave):
 *    create(map, opts) → instance
 *      opts.container       (DOM) where the toggle UI is mounted
 *      opts.defaultHours    (number, default 6)
 *      opts.maxHours        (number, default 48)
 *      opts.manifestUrl     (string, override for testing)
 *      opts.product         ('37color' | '89pct', default '37color')
 *      opts.onAttribution   (fn(attrStr)) optional hook so the
 *                           hosting page can wire it into its own
 *                           attribution control if it owns one.
 *      opts.compact         (bool) compact UI shell (default false)
 *
 *  An instance exposes:
 *    enable() / disable() / toggle()
 *    setHours(n) / setProduct(p) / refresh()
 *    isEnabled()
 *    destroy()
 *
 *  Manifest schema (https://storage.googleapis.com/tc-atlas-microwave-nrt/
 *  manifest_latest_48h.json):
 *    { updated, retention_hours,
 *      entries: [ { sensor, platform, orbit_id, scan_start,
 *                   product, png_url, geojson_url, bounds, source }, ... ] }
 *  Entries pair on (orbit_id) — one entry per product per orbit.
 *
 *  The layer does not own its DOM toggle button — the host page mounts
 *  a small UI block (button + product radio + hours slider + status
 *  line) into `opts.container`. This keeps both the RT Monitor's
 *  right-rail Layers panel and the Global Archive's map-corner control
 *  free to wrap the helper in whatever shell makes sense locally.
 * ───────────────────────────────────────────────────────────────────── */

(function () {
    'use strict';

    var MANIFEST_URL = 'https://storage.googleapis.com/tc-atlas-microwave-nrt/manifest_latest_48h.json';
    var REFRESH_MS   = 5 * 60 * 1000;   // 5 minutes
    var ATTRIBUTION  = 'GMI/GPM (NASA/GPM/PPS NRT)';
    var MIN_OPACITY  = 0.4;             // oldest visible swath
    var MAX_OPACITY  = 1.0;             // newest swath

    /** Bounds wrap the antimeridian iff west > east. */
    function _wrapsDateline(bounds) {
        var south = bounds[0][0], west = bounds[0][1];
        var north = bounds[1][0], east = bounds[1][1];
        return west > east;
    }

    /** Split a dateline-wrapping bounds into two [west-half, east-half]
     *  L.imageOverlay bounds. Each half uses the same PNG — Leaflet
     *  clips it to the visible bounding box. This matches how most
     *  swath visualizers handle the few orbits per day that cross
     *  the antimeridian. */
    function _splitAtDateline(bounds) {
        var south = bounds[0][0], west = bounds[0][1];
        var north = bounds[1][0], east = bounds[1][1];
        // West half: [west, +180].  East half: [-180, east].
        return [
            [[south, west], [north,  180]],
            [[south, -180], [north,  east]]
        ];
    }

    /** linear interp newest→1.0, oldest→0.4 across the visible window */
    function _ageOpacity(ageMin, windowMin) {
        if (windowMin <= 0) return MAX_OPACITY;
        var t = Math.min(1, Math.max(0, ageMin / windowMin));
        return MAX_OPACITY + (MIN_OPACITY - MAX_OPACITY) * t;
    }

    function _fmtUTC(d) {
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
             + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
    }

    function _fmtAge(ageMin) {
        if (ageMin < 60) return Math.round(ageMin) + ' min ago';
        var h = ageMin / 60;
        if (h < 24) return h.toFixed(1) + ' h ago';
        return (h / 24).toFixed(1) + ' d ago';
    }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** Pair entries on orbit_id so toggling the product picker can
     *  swap the PNG url without re-fetching the manifest. Returns:
     *    { orbits: [ { orbit_id, sensor, platform, scan_start_iso,
     *                  scan_start_ms, source,
     *                  products: { '37color': entry, '89pct': entry } } ],
     *      updated, retention_hours }                                  */
    function _normalizeManifest(json) {
        var entries = (json && json.entries) || [];
        var byOrbit = {};
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e || !e.orbit_id || !e.png_url || !e.bounds) continue;
            var key = e.orbit_id;
            if (!byOrbit[key]) {
                var ms = Date.parse(e.scan_start);
                if (isNaN(ms)) continue;
                byOrbit[key] = {
                    orbit_id: e.orbit_id,
                    sensor: e.sensor,
                    platform: e.platform,
                    scan_start_iso: e.scan_start,
                    scan_start_ms: ms,
                    source: e.source,
                    bounds: e.bounds,
                    products: {}
                };
            }
            byOrbit[key].products[e.product] = e;
        }
        var orbits = Object.keys(byOrbit).map(function (k) { return byOrbit[k]; });
        // Newest first — render order doesn't matter for L.imageOverlay
        // but a tidy array helps debugging.
        orbits.sort(function (a, b) { return b.scan_start_ms - a.scan_start_ms; });
        return {
            orbits: orbits,
            updated: json && json.updated,
            retention_hours: (json && json.retention_hours) || 48
        };
    }

    // Sensors the layer knows how to render. Order = display order in UI.
    var KNOWN_SENSORS = [
        { key: 'GMI',   label: 'GMI'   },
        { key: 'SSMIS', label: 'SSMI/S' },
        { key: 'AMSR2', label: 'AMSR2' }
    ];

    function MWLayer(map, opts) {
        opts = opts || {};
        this._map           = map;
        this._container     = opts.container || null;
        this._defaultHours  = opts.defaultHours || 6;
        this._maxHours      = opts.maxHours     || 48;
        this._hours         = this._defaultHours;
        this._product       = opts.product || '37color';
        this._manifestUrl   = opts.manifestUrl || MANIFEST_URL;
        this._onAttribution = opts.onAttribution || null;
        this._compact       = !!opts.compact;

        // Enabled sensors — Set keyed by sensor string. Default: all on.
        // Pass opts.sensors as array (e.g. ['GMI']) to override.
        this._sensors = {};
        var initialSensors = opts.sensors || KNOWN_SENSORS.map(function (s) { return s.key; });
        for (var si = 0; si < initialSensors.length; si++) {
            this._sensors[initialSensors[si]] = true;
        }

        this._enabled       = false;
        this._manifest      = null;      // normalized
        this._loading       = false;
        this._lastFetchErr  = null;
        this._refreshTimer  = null;
        this._attrAdded     = false;

        // { orbit_id: [ { overlay (L.imageOverlay), hit (L.rectangle) } ] }
        // — array because dateline-wrapping orbits create two halves.
        this._renderedOrbits = {};

        // DOM refs (filled by _mountUI)
        this._ui = null;

        if (this._container) this._mountUI();
    }

    MWLayer.prototype.isEnabled = function () { return this._enabled; };

    MWLayer.prototype.enable = function () {
        if (this._enabled) return;
        this._enabled = true;
        if (this._ui && this._ui.btn) this._ui.btn.classList.add('active');
        this._addAttribution();
        var self = this;
        this._fetchManifest().then(function () {
            self._renderAll();
        });
        this._refreshTimer = setInterval(function () {
            self._fetchManifest().then(function () {
                if (self._enabled) self._renderAll();
            });
        }, REFRESH_MS);
    };

    MWLayer.prototype.disable = function () {
        if (!this._enabled) return;
        this._enabled = false;
        if (this._ui && this._ui.btn) this._ui.btn.classList.remove('active');
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
        this._clearAll();
        this._removeAttribution();
        this._updateStatus('');
    };

    MWLayer.prototype.toggle = function () {
        if (this._enabled) this.disable(); else this.enable();
    };

    MWLayer.prototype.setHours = function (n) {
        n = Math.max(1, Math.min(this._maxHours, parseInt(n, 10) || this._defaultHours));
        this._hours = n;
        if (this._ui && this._ui.hoursLabel) {
            this._ui.hoursLabel.textContent = n + ' hr';
        }
        if (this._enabled) this._renderAll();
    };

    MWLayer.prototype.setProduct = function (p) {
        if (p !== '37color' && p !== '89pct') return;
        this._product = p;
        if (this._ui) {
            var radios = this._ui.container.querySelectorAll('input[name="tc-mw-product-' + this._uid + '"]');
            for (var i = 0; i < radios.length; i++) radios[i].checked = (radios[i].value === p);
        }
        if (this._enabled) this._renderAll();
    };

    MWLayer.prototype.setSensor = function (sensor, enabled) {
        this._sensors[sensor] = !!enabled;
        if (this._ui && this._ui.sensorChecks && this._ui.sensorChecks[sensor]) {
            this._ui.sensorChecks[sensor].checked = !!enabled;
        }
        if (this._enabled) this._renderAll();
    };

    MWLayer.prototype.refresh = function () {
        var self = this;
        return this._fetchManifest().then(function () {
            if (self._enabled) self._renderAll();
        });
    };

    MWLayer.prototype.destroy = function () {
        this.disable();
        if (this._ui && this._ui.container && this._ui.container.parentNode) {
            this._ui.container.parentNode.removeChild(this._ui.container);
        }
        this._ui = null;
    };

    // ── Manifest fetch ─────────────────────────────────────────
    MWLayer.prototype._fetchManifest = function () {
        if (this._loading) return Promise.resolve();
        this._loading = true;
        this._updateStatus('Loading…');
        var self = this;
        return fetch(this._manifestUrl, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (json) {
                self._manifest = _normalizeManifest(json);
                self._lastFetchErr = null;
            })
            .catch(function (err) {
                console.warn('[MW] manifest fetch failed', err);
                self._lastFetchErr = err;
                self._manifest = self._manifest || { orbits: [], retention_hours: 48 };
            })
            .then(function () {
                self._loading = false;
            });
    };

    // ── Rendering ─────────────────────────────────────────────
    MWLayer.prototype._clearAll = function () {
        var map = this._map;
        Object.keys(this._renderedOrbits).forEach(function (k) {
            var parts = this._renderedOrbits[k];
            for (var i = 0; i < parts.length; i++) {
                if (parts[i].overlay) map.removeLayer(parts[i].overlay);
                if (parts[i].hit)     map.removeLayer(parts[i].hit);
            }
        }, this);
        this._renderedOrbits = {};
    };

    MWLayer.prototype._renderAll = function () {
        if (!this._map || !this._enabled) return;
        this._clearAll();
        var orbits = (this._manifest && this._manifest.orbits) || [];
        var now = Date.now();
        var windowMin = this._hours * 60;
        var nVisible = 0;
        for (var i = 0; i < orbits.length; i++) {
            var orb = orbits[i];
            var ageMin = (now - orb.scan_start_ms) / 60000;
            if (ageMin < 0 || ageMin > windowMin) continue;
            if (orb.sensor && this._sensors[orb.sensor] === false) continue;
            var entry = orb.products[this._product];
            if (!entry) continue;       // no PNG for the active product
            this._addOrbit(orb, entry, ageMin, windowMin);
            nVisible++;
        }
        // Status line — either count or empty-state message
        if (this._lastFetchErr && nVisible === 0) {
            this._updateStatus('Manifest unreachable — last good data shown if any.');
        } else if (nVisible === 0) {
            var anyOn = false;
            for (var sk in this._sensors) { if (this._sensors[sk]) { anyOn = true; break; } }
            if (!anyOn) {
                this._updateStatus('All sensors off — toggle one on to see passes');
            } else {
                this._updateStatus('No microwave passes in the last ' + this._hours + ' hr');
            }
        } else {
            this._updateStatus(nVisible + ' pass' + (nVisible === 1 ? '' : 'es') + ' · last ' + this._hours + ' hr');
        }
    };

    MWLayer.prototype._addOrbit = function (orb, entry, ageMin, windowMin) {
        var map = this._map;
        var opacity = _ageOpacity(ageMin, windowMin);
        var boundsList = _wrapsDateline(entry.bounds) ? _splitAtDateline(entry.bounds) : [entry.bounds];
        var parts = [];
        var popupHtml = this._popupHtml(orb, ageMin);

        for (var i = 0; i < boundsList.length; i++) {
            var b = boundsList[i];
            var img = L.imageOverlay(entry.png_url, b, {
                opacity: opacity,
                interactive: false,
                // Don't request crossOrigin — we don't sample pixels and
                // some PPS-fed buckets serve without CORS by default.
                attribution: ATTRIBUTION
            }).addTo(map);

            // Transparent rectangle on top for click capture — L.imageOverlay
            // doesn't reliably emit click on transparent pixels.
            var hit = L.rectangle(b, {
                color: 'transparent',
                weight: 0,
                fillColor: '#ffffff',
                fillOpacity: 0,
                interactive: true,
                pane: 'overlayPane'
            }).addTo(map);
            hit.bindPopup(popupHtml, { maxWidth: 280 });
            parts.push({ overlay: img, hit: hit });
        }
        this._renderedOrbits[orb.orbit_id] = parts;
    };

    MWLayer.prototype._popupHtml = function (orb, ageMin) {
        var d = new Date(orb.scan_start_ms);
        return '<div class="tc-mw-popup">'
            + '<div class="tc-mw-popup-title">' + _esc(orb.sensor) + ' &middot; ' + _esc(orb.platform) + '</div>'
            + '<div class="tc-mw-popup-row"><b>Scan:</b> ' + _esc(_fmtUTC(d)) + '</div>'
            + '<div class="tc-mw-popup-row"><b>Age:</b> ' + _esc(_fmtAge(ageMin)) + '</div>'
            + '<div class="tc-mw-popup-row"><b>Source:</b> ' + _esc(orb.source || 'PPS_NRT') + '</div>'
            + '<div class="tc-mw-popup-row" style="opacity:0.7;font-size:0.62rem;">Orbit ' + _esc(orb.orbit_id) + '</div>'
            + '</div>';
    };

    // ── Attribution ────────────────────────────────────────────
    MWLayer.prototype._addAttribution = function () {
        if (this._attrAdded) return;
        if (this._onAttribution) {
            this._onAttribution(ATTRIBUTION, true);
        } else if (this._map && this._map.attributionControl) {
            this._map.attributionControl.addAttribution(ATTRIBUTION);
        }
        this._attrAdded = true;
    };
    MWLayer.prototype._removeAttribution = function () {
        if (!this._attrAdded) return;
        if (this._onAttribution) {
            this._onAttribution(ATTRIBUTION, false);
        } else if (this._map && this._map.attributionControl) {
            this._map.attributionControl.removeAttribution(ATTRIBUTION);
        }
        this._attrAdded = false;
    };

    // ── UI shell ───────────────────────────────────────────────
    var _uidCounter = 0;
    MWLayer.prototype._mountUI = function () {
        this._uid = ++_uidCounter;
        var c = this._container;
        var wrap = document.createElement('div');
        wrap.className = 'tc-mw-ui' + (this._compact ? ' tc-mw-ui-compact' : '');
        wrap.innerHTML =
              '<button type="button" class="tc-mw-toggle" title="Toggle recent microwave passes">'
            +   '<span class="tc-mw-toggle-dot"></span>'
            +   '<span class="tc-mw-toggle-label">Microwave passes</span>'
            + '</button>'
            + '<div class="tc-mw-controls">'
            +   '<div class="tc-mw-control-row tc-mw-product-row">'
            +     '<label class="tc-mw-product-opt">'
            +       '<input type="radio" name="tc-mw-product-' + this._uid + '" value="37color" checked>'
            +       '<span>37 GHz color</span>'
            +     '</label>'
            +     '<label class="tc-mw-product-opt">'
            +       '<input type="radio" name="tc-mw-product-' + this._uid + '" value="89pct">'
            +       '<span>89 GHz PCT</span>'
            +     '</label>'
            +   '</div>'
            +   '<div class="tc-mw-control-row tc-mw-sensor-row">'
            +     KNOWN_SENSORS.map(function (s) {
                      return '<label class="tc-mw-sensor-opt">'
                          +    '<input type="checkbox" data-tc-mw-sensor="' + s.key + '"'
                          +      (this._sensors[s.key] ? ' checked' : '') + '>'
                          +    '<span>' + s.label + '</span>'
                          +  '</label>';
                  }.bind(this)).join('')
            +   '</div>'
            +   '<div class="tc-mw-control-row tc-mw-hours-row">'
            +     '<label class="tc-mw-hours-label">Window'
            +       '<span class="tc-mw-hours-val">' + this._defaultHours + ' hr</span>'
            +     '</label>'
            +     '<input type="range" class="tc-mw-hours-slider" min="1" max="' + this._maxHours + '" step="1" value="' + this._defaultHours + '">'
            +   '</div>'
            +   '<div class="tc-mw-status"></div>'
            +   '<div class="tc-mw-attribution">' + _esc(ATTRIBUTION) + '</div>'
            + '</div>';
        c.appendChild(wrap);

        var btn      = wrap.querySelector('.tc-mw-toggle');
        var slider   = wrap.querySelector('.tc-mw-hours-slider');
        var hoursLbl = wrap.querySelector('.tc-mw-hours-val');
        var status   = wrap.querySelector('.tc-mw-status');
        var radios   = wrap.querySelectorAll('input[name="tc-mw-product-' + this._uid + '"]');
        // Sync the initial product selection if caller overrode the default.
        for (var ri = 0; ri < radios.length; ri++) {
            radios[ri].checked = (radios[ri].value === this._product);
        }
        if (this._product === '89pct') {
            // (radio sync above)
        }
        // Collect sensor checkbox refs by sensor key, wire change events.
        var sensorChecks = {};
        var sensorBoxes = wrap.querySelectorAll('input[data-tc-mw-sensor]');
        for (var sj = 0; sj < sensorBoxes.length; sj++) {
            sensorChecks[sensorBoxes[sj].getAttribute('data-tc-mw-sensor')] = sensorBoxes[sj];
        }

        this._ui = {
            container: wrap, btn: btn, slider: slider,
            hoursLabel: hoursLbl, status: status,
            sensorChecks: sensorChecks
        };

        var self = this;
        btn.addEventListener('click', function () { self.toggle(); });
        slider.addEventListener('input', function () { self.setHours(slider.value); });
        for (var i = 0; i < radios.length; i++) {
            (function (r) {
                r.addEventListener('change', function () {
                    if (r.checked) self.setProduct(r.value);
                });
            })(radios[i]);
        }
        Object.keys(sensorChecks).forEach(function (key) {
            sensorChecks[key].addEventListener('change', function () {
                self.setSensor(key, sensorChecks[key].checked);
            });
        });
    };

    MWLayer.prototype._updateStatus = function (msg) {
        if (this._ui && this._ui.status) this._ui.status.textContent = msg;
    };

    // ── Public namespace ──────────────────────────────────────
    window.TCMicrowave = {
        create: function (map, opts) { return new MWLayer(map, opts); },
        // Exposed for tests / debugging.
        _normalizeManifest: _normalizeManifest,
        _ageOpacity: _ageOpacity,
        _wrapsDateline: _wrapsDateline,
        _splitAtDateline: _splitAtDateline
    };
})();
