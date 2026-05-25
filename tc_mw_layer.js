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
    var PREFS_KEY    = 'tc-atlas-mw-prefs';

    // Per-sensor border colors so users can distinguish sensors at a
    // glance without clicking each swath.
    var SENSOR_COLORS = {
        GMI:   '#4ade80',   // green
        SSMIS: '#60a5fa',   // blue
        AMSR2: '#fb923c'    // orange
    };

    // Storm-highlighted swath styling — stronger weight + a hot accent
    // color that wins against the sensor stroke. Used for the most
    // recent pass that covered each active ATCF storm/invest.
    var HIGHLIGHT_COLOR  = '#fde047';   // amber / yellow
    var HIGHLIGHT_WEIGHT = 3.5;

    /** Does an L.imageOverlay bounds rectangle [[s,w],[n,e]] contain the
     *  given lat/lon point? Handles dateline-wrapping bounds (west > east)
     *  by accepting longitudes on either side of the seam. */
    function _boundsContains(bounds, lat, lon) {
        var south = bounds[0][0], west = bounds[0][1];
        var north = bounds[1][0], east = bounds[1][1];
        if (lat < south || lat > north) return false;
        if (west <= east) {
            return lon >= west && lon <= east;
        }
        // Wrapped: covers (west..180) ∪ (-180..east)
        return lon >= west || lon <= east;
    }

    function _loadPrefs() {
        try {
            var raw = window.localStorage && window.localStorage.getItem(PREFS_KEY);
            if (!raw) return null;
            var obj = JSON.parse(raw);
            return (obj && typeof obj === 'object') ? obj : null;
        } catch (e) {
            return null;
        }
    }
    function _writePrefs(obj) {
        try {
            if (window.localStorage) {
                window.localStorage.setItem(PREFS_KEY, JSON.stringify(obj));
            }
        } catch (e) {
            // private browsing / quota — silently degrade to in-memory state
        }
    }

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

    /** Cursor readout — terser than _fmtAge ("-32m" / "-3.2h" / "-1.5d")
     *  so it fits comfortably in the small UI strip. */
    function _fmtCursorBack(ageMin) {
        if (ageMin < 60) return '-' + Math.round(ageMin) + 'm';
        var h = ageMin / 60;
        if (h < 24) return '-' + h.toFixed(1) + 'h';
        return '-' + (h / 24).toFixed(1) + 'd';
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

        // Layer prefs persist across reloads via localStorage. Pull them
        // before mounting the UI so the initial render reflects the user's
        // last session.
        var prefs = _loadPrefs();
        var shouldAutoEnable = false;
        if (prefs) {
            if (prefs.sensors && typeof prefs.sensors === 'object') {
                // Only honor keys we know about.
                for (var ks = 0; ks < KNOWN_SENSORS.length; ks++) {
                    var sk = KNOWN_SENSORS[ks].key;
                    if (prefs.sensors[sk] === false) this._sensors[sk] = false;
                    else if (prefs.sensors[sk] === true) this._sensors[sk] = true;
                }
            }
            if (prefs.product === '37color' || prefs.product === '89pct') {
                this._product = prefs.product;
            }
            if (typeof prefs.hours === 'number' && prefs.hours >= 1 && prefs.hours <= this._maxHours) {
                this._hours = Math.round(prefs.hours);
            }
            if (prefs.enabled === true) shouldAutoEnable = true;
        }

        this._enabled       = false;
        this._manifest      = null;      // normalized
        this._loading       = false;
        this._lastFetchErr  = null;
        this._refreshTimer  = null;
        this._attrAdded     = false;
        // Suppress prefs writes while the constructor is restoring state.
        this._prefsReady    = false;

        // Time-scrubber state. _cursorAgeMin = how far back (in minutes
        // from "now") the playback head is parked. 0 = "live" (show
        // everything in window). When > 0, only orbits older than the
        // cursor are visible — i.e. the view shows what coverage looked
        // like _cursorAgeMin minutes ago. Ephemeral by design (Live is
        // the right default on every page load), so not persisted.
        this._cursorAgeMin  = 0;
        this._playing       = false;
        this._playTimer     = null;

        // Active ATCF storms / invests for highlighting passes that
        // covered them. The host page is the source of truth (it already
        // polls /ir-monitor/active-storms for the D1/D2 markers) and
        // pushes updates via setActiveStorms(); we fall back to a one-shot
        // fetch on first enable if the host never pushed (standalone use).
        // Each entry: { atcf_id, name, lat, lon, vmax_kt, ... }
        this._activeStorms       = opts.activeStorms || [];
        this._activeStormsApiUrl = opts.activeStormsApiUrl || null;
        this._stormsFetchAttempted = false;
        // Animation cadence: ~50 ticks/window at ~80 ms each → a 6 h
        // window plays back in ~4 s, a 24 h window in ~4 s as well
        // (steps scale with window). Pause briefly at "live" before
        // looping so the user catches up visually.
        this._playStepsPerLoop = 50;
        this._playTickMs       = 80;

        // { orbit_id: [ { overlay (L.imageOverlay), hit (L.rectangle) } ] }
        // — array because dateline-wrapping orbits create two halves.
        this._renderedOrbits = {};

        // DOM refs (filled by _mountUI)
        this._ui = null;

        if (this._container) this._mountUI();
        this._prefsReady = true;
        if (shouldAutoEnable) this.enable();
    }

    MWLayer.prototype._savePrefs = function () {
        if (!this._prefsReady) return;
        _writePrefs({
            sensors: this._sensors,
            product: this._product,
            hours:   this._hours,
            enabled: this._enabled
        });
    };

    MWLayer.prototype.isEnabled = function () { return this._enabled; };

    MWLayer.prototype.enable = function () {
        if (this._enabled) return;
        this._enabled = true;
        if (this._ui && this._ui.btn) this._ui.btn.classList.add('active');
        this._addAttribution();
        var self = this;
        // Kick off the fallback storm fetch in parallel with the manifest —
        // a no-op when the host already pushed storms via setActiveStorms.
        this._tryFetchActiveStorms();
        this._fetchManifest().then(function () {
            self._renderAll();
        });
        this._refreshTimer = setInterval(function () {
            self._fetchManifest().then(function () {
                if (self._enabled) self._renderAll();
            });
        }, REFRESH_MS);
        this._savePrefs();
    };

    MWLayer.prototype.disable = function () {
        if (!this._enabled) return;
        this._enabled = false;
        this.pause();  // stop animation if running
        if (this._ui && this._ui.btn) this._ui.btn.classList.remove('active');
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
        this._clearAll();
        this._removeAttribution();
        this._updateStatus('');
        this._savePrefs();
    };

    MWLayer.prototype.toggle = function () {
        if (this._enabled) this.disable(); else this.enable();
    };

    MWLayer.prototype.setHours = function (n) {
        n = Math.max(1, Math.min(this._maxHours, parseInt(n, 10) || this._defaultHours));
        this._hours = n;
        // Cap cursor to new window — sliding the window shorter shouldn't
        // leave the cursor parked beyond its right edge.
        var windowMin = this._hours * 60;
        if (this._cursorAgeMin > windowMin) this._cursorAgeMin = windowMin;
        if (this._ui && this._ui.hoursLabel) {
            this._ui.hoursLabel.textContent = n + ' hr';
        }
        this._syncCursorUI();
        if (this._enabled) this._renderAll();
        this._savePrefs();
    };

    MWLayer.prototype.setCursorAgeMin = function (m) {
        var windowMin = this._hours * 60;
        m = Math.max(0, Math.min(windowMin, Number(m) || 0));
        this._cursorAgeMin = m;
        this._syncCursorUI();
        if (this._enabled) this._renderAll();
    };

    MWLayer.prototype.goLive = function () {
        this.pause();
        this.setCursorAgeMin(0);
    };

    MWLayer.prototype.play = function () {
        if (this._playing) return;
        var windowMin = this._hours * 60;
        // Always rewind to the start of the window when (re)playing —
        // animation reads as "watch coverage build up from window-edge
        // toward now."
        this._cursorAgeMin = windowMin;
        this._playing = true;
        if (this._ui && this._ui.playBtn) this._ui.playBtn.classList.add('playing');
        this._syncCursorUI();
        if (this._enabled) this._renderAll();
        var self = this;
        var step = windowMin / this._playStepsPerLoop;
        this._playTimer = setInterval(function () {
            // Advance toward live (cursor age decreases → more orbits revealed).
            self._cursorAgeMin = Math.max(0, self._cursorAgeMin - step);
            self._syncCursorUI();
            if (self._enabled) self._renderAll();
            if (self._cursorAgeMin <= 0) {
                self.pause();
                // Brief hold at "live" before looping, so the user sees the
                // final state before the rewind.
                setTimeout(function () {
                    if (!self._playing && self._enabled) self.play();
                }, 1500);
            }
        }, this._playTickMs);
    };

    MWLayer.prototype.pause = function () {
        this._playing = false;
        if (this._playTimer) {
            clearInterval(this._playTimer);
            this._playTimer = null;
        }
        if (this._ui && this._ui.playBtn) this._ui.playBtn.classList.remove('playing');
    };

    MWLayer.prototype.togglePlay = function () {
        if (this._playing) this.pause(); else this.play();
    };

    // Keep slider + readout in sync with _cursorAgeMin.
    MWLayer.prototype._syncCursorUI = function () {
        if (!this._ui || !this._ui.cursorSlider) return;
        var windowMin = this._hours * 60;
        // Slider max tracks the current window so the handle uses the
        // full track regardless of window size. Right = live.
        this._ui.cursorSlider.max = String(windowMin);
        // Slider value = windowMin − cursorAgeMin so RIGHT is "live"
        // and LEFT is "window ago."
        this._ui.cursorSlider.value = String(windowMin - this._cursorAgeMin);
        if (this._ui.cursorReadout) {
            this._ui.cursorReadout.textContent = (this._cursorAgeMin <= 0)
                ? 'LIVE'
                : _fmtCursorBack(this._cursorAgeMin);
        }
        if (this._ui.liveBtn) {
            this._ui.liveBtn.classList.toggle('active', this._cursorAgeMin <= 0);
        }
    };

    MWLayer.prototype.setProduct = function (p) {
        if (p !== '37color' && p !== '89pct') return;
        this._product = p;
        if (this._ui) {
            var radios = this._ui.container.querySelectorAll('input[name="tc-mw-product-' + this._uid + '"]');
            for (var i = 0; i < radios.length; i++) radios[i].checked = (radios[i].value === p);
        }
        this._updateLegend();
        if (this._enabled) this._renderAll();
        this._savePrefs();
    };

    MWLayer.prototype.setSensor = function (sensor, enabled) {
        this._sensors[sensor] = !!enabled;
        if (this._ui && this._ui.sensorChecks && this._ui.sensorChecks[sensor]) {
            this._ui.sensorChecks[sensor].checked = !!enabled;
        }
        if (this._enabled) this._renderAll();
        this._savePrefs();
    };

    MWLayer.prototype.setActiveStorms = function (storms) {
        // Accept either the raw API payload `{storms: [...]}` or the
        // inner array — host pages have varying conventions.
        if (storms && Array.isArray(storms.storms)) storms = storms.storms;
        this._activeStorms = Array.isArray(storms) ? storms.filter(function (s) {
            return s && isFinite(s.lat) && isFinite(s.lon);
        }) : [];
        if (this._enabled) this._renderAll();
    };

    /** Fallback when the host page didn't push storms: one-shot fetch
     *  from the active-storms API endpoint (configurable so the layer
     *  works on dev / staging / prod without baked URLs). */
    MWLayer.prototype._tryFetchActiveStorms = function () {
        if (this._stormsFetchAttempted) return Promise.resolve();
        this._stormsFetchAttempted = true;
        if (!this._activeStormsApiUrl) return Promise.resolve();
        if (this._activeStorms && this._activeStorms.length) return Promise.resolve();
        var self = this;
        return fetch(this._activeStormsApiUrl, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (json) { if (json) self.setActiveStorms(json); })
            .catch(function (err) { console.warn('[MW] active-storms fetch failed', err); });
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
        // Counts of orbits within the time window per sensor (regardless
        // of toggle state). Drives the "(N)" suffix on the checkbox row
        // so users see how much data each sensor contributes.
        var perSensorCounts = {};
        for (var ks = 0; ks < KNOWN_SENSORS.length; ks++) {
            perSensorCounts[KNOWN_SENSORS[ks].key] = 0;
        }
        var cursorAgeMin = this._cursorAgeMin || 0;

        // Pass 1: figure out which orbit each storm's "most recent
        // covering pass" is, walking orbits newest-first. The map
        // `latestForStorm[atcf_id] = orbit_id` lets pass 2 (rendering)
        // decide which swaths get the storm-highlight upgrade.
        var storms = this._activeStorms || [];
        var latestForStorm = {};
        var stormsByOrbit = {};
        if (storms.length) {
            for (var oi = 0; oi < orbits.length; oi++) {
                var o = orbits[oi];
                var oAge = (now - o.scan_start_ms) / 60000;
                if (oAge < 0 || oAge > windowMin) continue;
                if (o.sensor && this._sensors[o.sensor] === false) continue;
                if (oAge < cursorAgeMin) continue;
                if (!o.products[this._product]) continue;
                for (var sti = 0; sti < storms.length; sti++) {
                    var s = storms[sti];
                    var key = s.atcf_id || (s.lat + ',' + s.lon);
                    if (latestForStorm[key]) continue;  // already assigned a newer orbit
                    if (_boundsContains(o.bounds, s.lat, s.lon)) {
                        latestForStorm[key] = o.orbit_id;
                        (stormsByOrbit[o.orbit_id] = stormsByOrbit[o.orbit_id] || []).push(s);
                    }
                }
            }
        }

        for (var i = 0; i < orbits.length; i++) {
            var orb = orbits[i];
            var ageMin = (now - orb.scan_start_ms) / 60000;
            if (ageMin < 0 || ageMin > windowMin) continue;
            // Count regardless of sensor toggle state.
            if (orb.sensor && perSensorCounts.hasOwnProperty(orb.sensor)) {
                perSensorCounts[orb.sensor]++;
            }
            if (orb.sensor && this._sensors[orb.sensor] === false) continue;
            // Cursor filter: when the playback head is parked at age T > 0,
            // hide orbits younger than T so the view shows what coverage
            // looked like T minutes ago.
            if (ageMin < cursorAgeMin) continue;
            var entry = orb.products[this._product];
            if (!entry) continue;       // no PNG for the active product
            this._addOrbit(orb, entry, ageMin, windowMin, stormsByOrbit[orb.orbit_id]);
            nVisible++;
        }
        this._updateSensorCounts(perSensorCounts);
        // Status line — either count or empty-state message
        var cursorSuffix = (cursorAgeMin > 0)
            ? ' · cursor ' + _fmtCursorBack(cursorAgeMin)
            : '';
        if (this._lastFetchErr && nVisible === 0) {
            this._updateStatus('Manifest unreachable — last good data shown if any.');
        } else if (nVisible === 0) {
            var anyOn = false;
            for (var sk in this._sensors) { if (this._sensors[sk]) { anyOn = true; break; } }
            if (!anyOn) {
                this._updateStatus('All sensors off — toggle one on to see passes');
            } else {
                this._updateStatus('No microwave passes in the last ' + this._hours + ' hr' + cursorSuffix);
            }
        } else {
            this._updateStatus(nVisible + ' pass' + (nVisible === 1 ? '' : 'es') + ' · last ' + this._hours + ' hr' + cursorSuffix);
        }
    };

    MWLayer.prototype._addOrbit = function (orb, entry, ageMin, windowMin, highlightStorms) {
        var map = this._map;
        var opacity = _ageOpacity(ageMin, windowMin);
        var boundsList = _wrapsDateline(entry.bounds) ? _splitAtDateline(entry.bounds) : [entry.bounds];
        var parts = [];
        var popupHtml = this._popupHtml(orb, ageMin, highlightStorms);
        var isHighlighted = !!(highlightStorms && highlightStorms.length);
        var borderColor = isHighlighted ? HIGHLIGHT_COLOR : (SENSOR_COLORS[orb.sensor] || '#cbd5e1');
        var borderWeight = isHighlighted ? HIGHLIGHT_WEIGHT : 1.5;

        for (var i = 0; i < boundsList.length; i++) {
            var b = boundsList[i];
            var img = L.imageOverlay(entry.png_url, b, {
                opacity: opacity,
                interactive: false,
                // Don't request crossOrigin — we don't sample pixels and
                // some PPS-fed buckets serve without CORS by default.
                attribution: ATTRIBUTION
            }).addTo(map);

            // Click-hit rectangle doubles as the sensor-color border so
            // users can distinguish GMI / SSMI/S / AMSR2 at a glance.
            // Stroke opacity tracks the image's age-decay opacity.
            // If this orbit is the most recent pass over any active storm,
            // the border swaps to a hot accent color and thickens.
            var hit = L.rectangle(b, {
                color: borderColor,
                weight: borderWeight,
                opacity: Math.max(opacity, isHighlighted ? 0.85 : opacity),
                fillColor: '#ffffff',
                fillOpacity: 0,
                interactive: true,
                pane: 'overlayPane'
            }).addTo(map);
            hit.bindPopup(popupHtml, { maxWidth: 320 });
            parts.push({ overlay: img, hit: hit });
        }
        this._renderedOrbits[orb.orbit_id] = parts;
    };

    MWLayer.prototype._popupHtml = function (orb, ageMin, highlightStorms) {
        var d = new Date(orb.scan_start_ms);
        var storms = (highlightStorms || []).map(function (s) {
            var label = s.name ? (s.name + ' (' + (s.atcf_id || '?') + ')') : (s.atcf_id || '?');
            var vmax = isFinite(s.vmax_kt) ? ' · ' + Math.round(s.vmax_kt) + ' kt' : '';
            return _esc(label + vmax);
        });
        var stormsHtml = storms.length
            ? '<div class="tc-mw-popup-storms">'
                + '<div class="tc-mw-popup-storms-title">Latest pass over:</div>'
                + storms.map(function (s) { return '<div class="tc-mw-popup-storm">★ ' + s + '</div>'; }).join('')
            + '</div>'
            : '';
        return '<div class="tc-mw-popup">'
            + '<div class="tc-mw-popup-title">' + _esc(orb.sensor) + ' &middot; ' + _esc(orb.platform) + '</div>'
            + '<div class="tc-mw-popup-row"><b>Scan:</b> ' + _esc(_fmtUTC(d)) + '</div>'
            + '<div class="tc-mw-popup-row"><b>Age:</b> ' + _esc(_fmtAge(ageMin)) + '</div>'
            + '<div class="tc-mw-popup-row"><b>Source:</b> ' + _esc(orb.source || 'PPS_NRT') + '</div>'
            + '<div class="tc-mw-popup-row" style="opacity:0.7;font-size:0.62rem;">Orbit ' + _esc(orb.orbit_id) + '</div>'
            + stormsHtml
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
                      var swatch = SENSOR_COLORS[s.key] || '#cbd5e1';
                      return '<label class="tc-mw-sensor-opt">'
                          +    '<input type="checkbox" data-tc-mw-sensor="' + s.key + '"'
                          +      (this._sensors[s.key] ? ' checked' : '') + '>'
                          +    '<span class="tc-mw-sensor-swatch" style="background:' + swatch + ';"></span>'
                          +    '<span class="tc-mw-sensor-label" data-tc-mw-sensor-label="' + s.key + '">' + s.label + '</span>'
                          +  '</label>';
                  }.bind(this)).join('')
            +   '</div>'
            +   '<div class="tc-mw-legend" data-tc-mw-legend></div>'
            +   '<div class="tc-mw-control-row tc-mw-time-row">'
            +     '<button type="button" class="tc-mw-play-btn" title="Play coverage build-up">'
            +       '<span class="tc-mw-play-icon" aria-hidden="true"></span>'
            +     '</button>'
            +     '<input type="range" class="tc-mw-cursor-slider" min="0" max="' + (this._hours * 60) + '" step="1" value="' + (this._hours * 60) + '" title="Scrub through history (drag) or click LIVE">'
            +     '<button type="button" class="tc-mw-live-btn active" title="Snap to live (show all in window)">LIVE</button>'
            +     '<span class="tc-mw-cursor-readout">LIVE</span>'
            +   '</div>'
            +   '<div class="tc-mw-control-row tc-mw-hours-row">'
            +     '<label class="tc-mw-hours-label">Window'
            +       '<span class="tc-mw-hours-val">' + this._hours + ' hr</span>'
            +     '</label>'
            +     '<input type="range" class="tc-mw-hours-slider" min="1" max="' + this._maxHours + '" step="1" value="' + this._hours + '">'
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
        // Sensor name <span>s so _renderAll can append "(N)" counts.
        var sensorLabels = {};
        var labelEls = wrap.querySelectorAll('[data-tc-mw-sensor-label]');
        for (var lj = 0; lj < labelEls.length; lj++) {
            sensorLabels[labelEls[lj].getAttribute('data-tc-mw-sensor-label')] = labelEls[lj];
        }
        var legend = wrap.querySelector('[data-tc-mw-legend]');
        var cursorSlider  = wrap.querySelector('.tc-mw-cursor-slider');
        var cursorReadout = wrap.querySelector('.tc-mw-cursor-readout');
        var playBtn       = wrap.querySelector('.tc-mw-play-btn');
        var liveBtn       = wrap.querySelector('.tc-mw-live-btn');

        this._ui = {
            container: wrap, btn: btn, slider: slider,
            hoursLabel: hoursLbl, status: status,
            sensorChecks: sensorChecks,
            sensorLabels: sensorLabels,
            legend: legend,
            cursorSlider: cursorSlider,
            cursorReadout: cursorReadout,
            playBtn: playBtn,
            liveBtn: liveBtn
        };
        this._updateLegend();
        this._syncCursorUI();

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
        // Manual scrub pauses any in-flight playback so the user is in control.
        cursorSlider.addEventListener('input', function () {
            if (self._playing) self.pause();
            var windowMin = self._hours * 60;
            // Slider value = windowMin − cursorAgeMin (right = live)
            var v = parseInt(cursorSlider.value, 10);
            if (isNaN(v)) v = windowMin;
            self.setCursorAgeMin(windowMin - v);
        });
        playBtn.addEventListener('click', function () { self.togglePlay(); });
        liveBtn.addEventListener('click', function () { self.goLive(); });
    };

    MWLayer.prototype._updateStatus = function (msg) {
        if (this._ui && this._ui.status) this._ui.status.textContent = msg;
    };

    // Tiny inline guide that flips with the product picker. Helps
    // non-experts read the active color scheme without leaving the map.
    MWLayer.prototype._updateLegend = function () {
        if (!this._ui || !this._ui.legend) return;
        var html;
        if (this._product === '89pct') {
            html =
                  '<div class="tc-mw-legend-title">89 GHz PCT (K)</div>'
                + '<div class="tc-mw-legend-bar tc-mw-legend-bar-89"></div>'
                + '<div class="tc-mw-legend-ticks">'
                +   '<span>180</span><span>220</span><span>260</span><span>290</span>'
                + '</div>';
        } else {
            html =
                  '<div class="tc-mw-legend-title">37 GHz color</div>'
                + '<div class="tc-mw-legend-chunks">'
                +   '<span class="tc-mw-legend-chunk" style="background:#0b5d3b;" title="Clear ocean"></span>'
                +   '<span class="tc-mw-legend-chunk" style="background:#22d3ee;" title="Land / shallow rain"></span>'
                +   '<span class="tc-mw-legend-chunk" style="background:#d946ef;" title="Deep convection"></span>'
                +   '<span class="tc-mw-legend-chunk" style="background:#dc2626;" title="Ice scattering"></span>'
                + '</div>'
                + '<div class="tc-mw-legend-labels">'
                +   '<span>Ocean</span><span>Land/rain</span><span>Convect</span><span>Ice</span>'
                + '</div>';
        }
        this._ui.legend.innerHTML = html;
    };

    MWLayer.prototype._updateSensorCounts = function (counts) {
        if (!this._ui || !this._ui.sensorLabels) return;
        for (var i = 0; i < KNOWN_SENSORS.length; i++) {
            var s = KNOWN_SENSORS[i];
            var el = this._ui.sensorLabels[s.key];
            if (!el) continue;
            var n = counts[s.key] || 0;
            // Always show "(N)" — including (0) — for consistency so the
            // row width doesn't jitter as the window slider moves.
            el.textContent = s.label + ' (' + n + ')';
        }
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
