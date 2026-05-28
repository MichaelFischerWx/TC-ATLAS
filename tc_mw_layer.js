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
    var PREDICTIONS_URL = 'https://storage.googleapis.com/tc-atlas-microwave-nrt/passes_predicted.json';
    var REFRESH_MS   = 5 * 60 * 1000;   // 5 minutes
    // Map-attribution string: concise enough for the Leaflet
    // attribution bar at the bottom of the map. The full acknowledgement
    // (per-sensor providers + TLE source) lives in POPOVER_ACK below
    // and is shown in the MW options popover where there's room.
    var ATTRIBUTION  = 'Microwave: NASA GPM/PPS NRT';
    var POPOVER_ACK  = 'Brightness temperatures: GMI (NASA/GPM), '
                     + 'SSMI/S (DMSP F16/F17/F18), AMSR2 (JAXA/GCOM-W1), '
                     + 'ATMS (NPP/NOAA-20/NOAA-21). NRT data via NASA GPM '
                     + 'Precipitation Processing System. Orbital predictions '
                     + 'via CelesTrak TLEs.';
    // Default age-decay floor — newest swath always renders at 1.0,
    // oldest visible swath drops to MIN_OPACITY. 0.7 keeps the data
    // readable end-to-end while still leaving a perceptible age cue
    // (~30-point opacity difference between newest and oldest), which
    // is reinforced by the time-scrubber readout. Users who want the
    // IR to show through older passes can lower the Opacity slider.
    var MIN_OPACITY  = 0.7;
    var MAX_OPACITY  = 1.0;
    var PREFS_KEY    = 'tc-atlas-mw-prefs';

    // Per-sensor border colors so users can distinguish sensors at a
    // glance without clicking each swath.
    var SENSOR_COLORS = {
        GMI:   '#4ade80',   // green
        SSMIS: '#60a5fa',   // blue
        AMSR2: '#fb923c',   // orange
        ATMS:  '#c084fc'    // purple — cross-track sounder, 89v-only
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

    // Sensor swath half-widths (km), mirroring PREDICT_SATELLITES'
    // swath_half_km in mw_ingest.py. A storm is "covered" by a pass when
    // its min distance to the pass's center-track polyline is within this
    // half-width — the same definition predict_passes() uses for upcoming
    // passes, so ingested and predicted coverage agree.
    var _SWATH_HALF_KM = { GMI: 445, SSMIS: 875, AMSR2: 725, ATMS: 1150 };
    var _SWATH_HALF_KM_DEFAULT = 900;
    // Small margin so the cheap geometric proxy errs toward inclusion; the
    // satellite page's PNG-crop check trims any remaining false positives.
    var _SWATH_COVER_MARGIN = 1.15;

    // Min great-circle distance (km) from (lat,lon) to the center-track
    // polyline, via a local equirectangular projection about the point
    // (<1% error at swath scales). Tests segment interiors, not just
    // vertices, so a storm sitting between two sparse track points isn't
    // missed.
    function _minDistKmToTrack(track, lat, lon) {
        if (!track || !track.length) return Infinity;
        var KM_PER_DEG = 111.195;
        var cosLat = Math.cos(lat * Math.PI / 180);
        function proj(p) {
            var dLon = p[1] - lon;
            if (dLon > 180) dLon -= 360;
            else if (dLon < -180) dLon += 360;
            return [dLon * cosLat * KM_PER_DEG, (p[0] - lat) * KM_PER_DEG];
        }
        if (track.length === 1) {
            var q = proj(track[0]);
            return Math.sqrt(q[0] * q[0] + q[1] * q[1]);
        }
        var best = Infinity;
        for (var i = 0; i < track.length - 1; i++) {
            var a = proj(track[i]), b = proj(track[i + 1]);
            var vx = b[0] - a[0], vy = b[1] - a[1];
            var len2 = vx * vx + vy * vy;
            var t = len2 > 0 ? -(a[0] * vx + a[1] * vy) / len2 : 0;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            var cx = a[0] + t * vx, cy = a[1] + t * vy;
            var d = Math.sqrt(cx * cx + cy * cy);
            if (d < best) best = d;
        }
        return best;
    }

    // Coverage gate shared by the schedule dashboard and the map's
    // storm-highlight pass. Prefers the honest center-track distance test;
    // falls back to bbox containment only for entries predating the
    // center_track field (during the 48 h rolling-window backfill).
    function _passCoversStorm(o, lat, lon) {
        if (!o || lat == null || lon == null) return false;
        if (o.center_track && o.center_track.length) {
            var half = (_SWATH_HALF_KM[o.sensor] || _SWATH_HALF_KM_DEFAULT)
                     * _SWATH_COVER_MARGIN;
            return _minDistKmToTrack(o.center_track, lat, lon) <= half;
        }
        return _boundsContains(o.bounds, lat, lon);
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

    /** linear interp newest→1.0, oldest→`minFloor` across the visible
     *  window. minFloor is configurable per-instance so users can raise
     *  the curve and completely cover the basemap with older swaths. */
    function _ageOpacity(ageMin, windowMin, minFloor) {
        if (typeof minFloor !== 'number') minFloor = MIN_OPACITY;
        if (windowMin <= 0) return MAX_OPACITY;
        var t = Math.min(1, Math.max(0, ageMin / windowMin));
        return MAX_OPACITY + (minFloor - MAX_OPACITY) * t;
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
                    center_track: e.center_track || null,
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
    // ATMS is a sounder (single-pol, 88.2 GHz only) and contributes to
    // the 89v product slot only — the dropdown will simply not render
    // its swaths when other products are selected.
    var KNOWN_SENSORS = [
        { key: 'GMI',   label: 'GMI'   },
        { key: 'SSMIS', label: 'SSMI/S' },
        { key: 'AMSR2', label: 'AMSR2' },
        { key: 'ATMS',  label: 'ATMS'  }
    ];

    // Products in the order they appear in the picker dropdown.
    // `composite: true` items are RGB / derived products (37-color, PCT)
    // and get the categorical chunk legend; the rest are single-pol Tb
    // fields that get a continuous colorbar.
    var KNOWN_PRODUCTS = [
        { key: '37color', label: '37 GHz color',     composite: true  },
        { key: '89pct',   label: '89 GHz PCT',       composite: false },
        { key: '37v',     label: '37 GHz V-pol',     composite: false },
        { key: '37h',     label: '37 GHz H-pol',     composite: false },
        { key: '89v',     label: '89 GHz V-pol',     composite: false },
        { key: '89h',     label: '89 GHz H-pol',     composite: false }
    ];
    var _knownProductKeys = KNOWN_PRODUCTS.map(function (p) { return p.key; });

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
            if (prefs.product && _knownProductKeys.indexOf(prefs.product) >= 0) {
                this._product = prefs.product;
            }
            if (typeof prefs.hours === 'number' && prefs.hours >= 1 && prefs.hours <= this._maxHours) {
                this._hours = Math.round(prefs.hours);
            }
            if (typeof prefs.minOpacity === 'number' &&
                prefs.minOpacity >= 0 && prefs.minOpacity <= 1) {
                this._minOpacity = prefs.minOpacity;
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

        // Pass-schedule state. Predictions live alongside manifest in
        // GCS (passes_predicted.json), refreshed every ~30 min by a
        // separate Cloud Scheduler entry. We pull them on enable and
        // alongside each manifest refresh so the per-storm dashboard
        // stays current.
        this._predictions   = null;

        // Age-decay opacity floor. Newest swaths always render at 1.0;
        // this controls how transparent the oldest visible swath gets.
        // Default 0.4 preserves the original age-fade; setting to 1.0
        // disables the fade so all swaths fully cover the basemap.
        // Restored from prefs below if the user adjusted it last time.
        this._minOpacity    = MIN_OPACITY;

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
            sensors:    this._sensors,
            product:    this._product,
            hours:      this._hours,
            minOpacity: this._minOpacity,
            enabled:    this._enabled
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
        this._fetchPredictions();
        this._fetchManifest().then(function () {
            self._renderAll();
        });
        this._refreshTimer = setInterval(function () {
            self._fetchPredictions();
            self._fetchManifest().then(function () {
                if (self._enabled) self._renderAll();
            });
        }, REFRESH_MS);
        this._savePrefs();
    };

    MWLayer.prototype.disable = function () {
        if (!this._enabled) return;
        // Trace the disable so we can correlate the user-reported
        // "MW disappears after zoom" symptom with whatever called it.
        // Logged via console.info so it stays visible without users
        // having to flip a debug flag.
        try {
            console.info('[MW] disable() called', {
                zoom: this._map && this._map.getZoom ? this._map.getZoom() : null,
                stack: new Error().stack
            });
        } catch (e) {}
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
        if (_knownProductKeys.indexOf(p) < 0) return;
        this._product = p;
        if (this._ui && this._ui.productSelect) {
            this._ui.productSelect.value = p;
        }
        this._updateLegend();
        if (this._enabled) this._renderAll();
        this._savePrefs();
    };

    MWLayer.prototype.setMinOpacity = function (v) {
        v = Math.max(0, Math.min(1, Number(v)));
        if (isNaN(v)) v = MIN_OPACITY;
        this._minOpacity = v;
        if (this._ui && this._ui.opacityLabel) {
            this._ui.opacityLabel.textContent = Math.round(v * 100) + '%';
        }
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

    /** Fetch the predicted-pass schedule (passes_predicted.json) — built
     *  by mw_ingest.py --predict-passes via the Cloud Scheduler entry
     *  that fires every 30 min. Refreshes alongside the manifest so the
     *  per-storm dashboard reflects the latest TLEs. */
    MWLayer.prototype._fetchPredictions = function () {
        var self = this;
        return fetch(PREDICTIONS_URL, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (json) {
                self._predictions = json;
                self._updateScheduleSection();
            })
            .catch(function (err) {
                console.warn('[MW] predictions fetch failed', err);
                self._updateScheduleSection();
            });
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
        var n = Object.keys(this._renderedOrbits).length;
        // Quiet trace — only when there were overlays to clear (otherwise
        // every _renderAll prefix would spam). Helps correlate the
        // "MW disappears after zoom" report with whatever fired the clear.
        if (n > 0) {
            try {
                console.debug('[MW] _clearAll', {
                    cleared: n,
                    enabled: this._enabled,
                    zoom: map && map.getZoom ? map.getZoom() : null
                });
            } catch (e) {}
        }
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
                    if (_passCoversStorm(o, s.lat, s.lon)) {
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
        this._updateScheduleSection();
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
            // "14 passes (3 orbits) · last 11 hr" — orbital count is each
            // contiguous run of same-sensor granules with <10 min gaps,
            // since GMI emits 5-min slices and SSMI/S+AMSR2 emit ~17 min
            // strips. So "14 passes" might be 1 long GMI track + a handful
            // of SSMI/S granules; users see the orbital decomposition.
            var nTracks = this._countOrbitalTracks(orbits, now, windowMin, cursorAgeMin);
            var orbitSuffix = (nTracks > 0 && nTracks !== nVisible)
                ? ' (' + nTracks + ' orbital track' + (nTracks === 1 ? '' : 's') + ')'
                : '';
            this._updateStatus(nVisible + ' pass' + (nVisible === 1 ? '' : 'es') + orbitSuffix + ' · last ' + this._hours + ' hr' + cursorSuffix);
        }
    };

    /** Count contiguous same-sensor granule runs in the visible window.
     *  GMI emits 5-min granules during a pass, SSMI/S and AMSR2 emit
     *  ~17 min granules. A single orbital pass typically lasts ~98 min
     *  with ~90 min of gap before the same satellite returns. A 20-min
     *  threshold sits comfortably above all per-sensor cadences and
     *  well below the inter-orbit gap, so it cleanly partitions
     *  granules into orbital tracks across all three sensors.
     *  Mirrors _renderAll's filters so the count reflects what's
     *  actually painted on the map. */
    MWLayer.prototype._countOrbitalTracks = function (orbits, now, windowMin, cursorAgeMin) {
        // Group visible orbits by sensor with scan_start_ms.
        var bySensor = {};
        for (var i = 0; i < orbits.length; i++) {
            var orb = orbits[i];
            var ageMin = (now - orb.scan_start_ms) / 60000;
            if (ageMin < 0 || ageMin > windowMin) continue;
            if (orb.sensor && this._sensors[orb.sensor] === false) continue;
            if (ageMin < (cursorAgeMin || 0)) continue;
            if (!orb.products[this._product]) continue;
            var s = orb.sensor || '?';
            (bySensor[s] = bySensor[s] || []).push(orb.scan_start_ms);
        }
        var TRACK_GAP_MS = 20 * 60 * 1000;
        var tracks = 0;
        Object.keys(bySensor).forEach(function (s) {
            var arr = bySensor[s].slice().sort(function (a, b) { return a - b; });
            if (!arr.length) return;
            tracks++;
            for (var k = 1; k < arr.length; k++) {
                if (arr[k] - arr[k - 1] > TRACK_GAP_MS) tracks++;
            }
        });
        return tracks;
    };

    MWLayer.prototype._addOrbit = function (orb, entry, ageMin, windowMin, highlightStorms) {
        var map = this._map;
        var opacity = _ageOpacity(ageMin, windowMin, this._minOpacity);
        var boundsList = _wrapsDateline(entry.bounds) ? _splitAtDateline(entry.bounds) : [entry.bounds];
        var parts = [];
        var popupHtml = this._popupHtml(orb, ageMin, highlightStorms);
        var isHighlighted = !!(highlightStorms && highlightStorms.length);
        var borderColor = isHighlighted ? HIGHLIGHT_COLOR : (SENSOR_COLORS[orb.sensor] || '#cbd5e1');

        // Default border styling — very subtle so dense GMI coverage
        // (~117 granules in 10 hr) doesn't look like a grid lattice.
        // The image overlay itself carries the swath shape via
        // NaN→transparent edges; the rectangle is mostly a click target.
        // Hover bumps the stroke to a readable weight, so users can
        // probe individual granules without permanent visual clutter.
        // Storm-highlighted swaths get the bold treatment regardless.
        var idleWeight  = isHighlighted ? HIGHLIGHT_WEIGHT : 0.5;
        var idleOpacity = isHighlighted ? 0.85 : Math.min(opacity, 0.25);
        var hoverWeight  = isHighlighted ? HIGHLIGHT_WEIGHT : 1.5;
        var hoverOpacity = isHighlighted ? 0.95 : Math.max(opacity, 0.85);

        for (var i = 0; i < boundsList.length; i++) {
            var b = boundsList[i];
            var img = L.imageOverlay(entry.png_url, b, {
                opacity: opacity,
                interactive: false,
                // Don't request crossOrigin — we don't sample pixels and
                // some PPS-fed buckets serve without CORS by default.
                attribution: ATTRIBUTION
            }).addTo(map);

            var hit = L.rectangle(b, {
                color: borderColor,
                weight: idleWeight,
                opacity: idleOpacity,
                fillColor: '#ffffff',
                fillOpacity: 0,
                interactive: true,
                pane: 'overlayPane'
            }).addTo(map);
            hit.bindPopup(popupHtml, { maxWidth: 320 });
            // Hover-to-emphasize. Closures capture per-rectangle styling
            // so multiple hits on the page mouseover independently.
            (function (rect, idleW, idleO, hoverW, hoverO) {
                rect.on('mouseover', function () {
                    rect.setStyle({ weight: hoverW, opacity: hoverO });
                    rect.bringToFront();
                });
                rect.on('mouseout', function () {
                    rect.setStyle({ weight: idleW, opacity: idleO });
                });
            })(hit, idleWeight, idleOpacity, hoverWeight, hoverOpacity);
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
            +     '<label class="tc-mw-product-label">Product'
            +       '<select class="tc-mw-product-select">'
            +         KNOWN_PRODUCTS.map(function (p) {
                          return '<option value="' + p.key + '"'
                              + (p.key === this._product ? ' selected' : '')
                              + '>' + _esc(p.label) + '</option>';
                      }.bind(this)).join('')
            +       '</select>'
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
            +   '<div class="tc-mw-control-row tc-mw-opacity-row" title="Raises the age-fade floor — at 100% even the oldest visible swaths fully cover the basemap; at 40% (default) older swaths fade so the IR shows through.">'
            +     '<label class="tc-mw-opacity-label">Opacity'
            +       '<span class="tc-mw-opacity-val">' + Math.round(this._minOpacity * 100) + '%</span>'
            +     '</label>'
            +     '<input type="range" class="tc-mw-opacity-slider" min="0" max="100" step="1" value="' + Math.round(this._minOpacity * 100) + '">'
            +   '</div>'
            +   '<div class="tc-mw-status"></div>'
            +   '<div class="tc-mw-schedule" data-tc-mw-schedule></div>'
            +   '<div class="tc-mw-attribution">' + _esc(POPOVER_ACK) + '</div>'
            + '</div>';
        c.appendChild(wrap);

        var btn            = wrap.querySelector('.tc-mw-toggle');
        var slider         = wrap.querySelector('.tc-mw-hours-slider');
        var hoursLbl       = wrap.querySelector('.tc-mw-hours-val');
        var status         = wrap.querySelector('.tc-mw-status');
        var productSelect  = wrap.querySelector('.tc-mw-product-select');
        // Sync the dropdown value with the constructor-resolved product
        // (covers both opts.product overrides and prefs-restored values).
        if (productSelect) productSelect.value = this._product;
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
        var opacitySlider = wrap.querySelector('.tc-mw-opacity-slider');
        var opacityLabel  = wrap.querySelector('.tc-mw-opacity-val');
        var schedule      = wrap.querySelector('[data-tc-mw-schedule]');

        this._ui = {
            container: wrap, btn: btn, slider: slider,
            hoursLabel: hoursLbl, status: status,
            productSelect: productSelect,
            sensorChecks: sensorChecks,
            sensorLabels: sensorLabels,
            legend: legend,
            cursorSlider: cursorSlider,
            cursorReadout: cursorReadout,
            playBtn: playBtn,
            liveBtn: liveBtn,
            opacitySlider: opacitySlider,
            opacityLabel: opacityLabel,
            schedule: schedule
        };
        this._updateLegend();
        this._syncCursorUI();

        var self = this;
        btn.addEventListener('click', function () { self.toggle(); });
        slider.addEventListener('input', function () { self.setHours(slider.value); });
        if (productSelect) {
            productSelect.addEventListener('change', function () {
                self.setProduct(productSelect.value);
            });
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
        if (opacitySlider) {
            opacitySlider.addEventListener('input', function () {
                self.setMinOpacity(parseInt(opacitySlider.value, 10) / 100);
            });
        }
    };

    MWLayer.prototype._updateStatus = function (msg) {
        if (this._ui && this._ui.status) this._ui.status.textContent = msg;
    };

    // Tiny inline guide that flips with the product picker. Helps
    // non-experts read the active color scheme without leaving the map.
    // Single-pol products share the 89-PCT or 37-color colormap with
    // per-product Tb ranges — the legend just relabels the bar.
    MWLayer.prototype._updateLegend = function () {
        if (!this._ui || !this._ui.legend) return;
        var html;
        // (vmin, vmax, title, cmap-class) per single-pol product —
        // matches the backend SINGLE_POL_RANGE table in mw_ingest.py.
        var SINGLE_POL_LEGEND = {
            '37v': { vmin: 180, vmax: 290, title: '37 GHz V-pol TB (K)', bar: 'tc-mw-legend-bar-37' },
            '37h': { vmin: 130, vmax: 290, title: '37 GHz H-pol TB (K)', bar: 'tc-mw-legend-bar-37' },
            '89v': { vmin: 180, vmax: 290, title: '89 GHz V-pol TB (K)', bar: 'tc-mw-legend-bar-89' },
            '89h': { vmin: 130, vmax: 290, title: '89 GHz H-pol TB (K)', bar: 'tc-mw-legend-bar-89' }
        };
        if (this._product === '89pct') {
            html =
                  '<div class="tc-mw-legend-title">89 GHz PCT (K)</div>'
                + '<div class="tc-mw-legend-bar tc-mw-legend-bar-89"></div>'
                + '<div class="tc-mw-legend-ticks">'
                +   '<span>180</span><span>220</span><span>260</span><span>290</span>'
                + '</div>';
        } else if (SINGLE_POL_LEGEND[this._product]) {
            var L = SINGLE_POL_LEGEND[this._product];
            var midA = Math.round(L.vmin + (L.vmax - L.vmin) / 3);
            var midB = Math.round(L.vmin + 2 * (L.vmax - L.vmin) / 3);
            html =
                  '<div class="tc-mw-legend-title">' + _esc(L.title) + '</div>'
                + '<div class="tc-mw-legend-bar ' + L.bar + '"></div>'
                + '<div class="tc-mw-legend-ticks">'
                +   '<span>' + L.vmin + '</span>'
                +   '<span>' + midA + '</span>'
                +   '<span>' + midB + '</span>'
                +   '<span>' + L.vmax + '</span>'
                + '</div>';
        } else {
            // 37color (default)
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

    /** Per-storm pass-schedule dashboard. For each active ATCF storm,
     *  shows the most recent pass per sensor (from the current
     *  manifest, intersected with the storm's position) + the next
     *  upcoming pass per sensor (from passes_predicted.json), with an
     *  "ETA on TC-ATLAS" annotation that adds the sensor-specific PPS
     *  NRT latency to the predicted scan time so users know when each
     *  upcoming pass will actually appear on this page. */
    MWLayer.prototype._updateScheduleSection = function () {
        if (!this._ui || !this._ui.schedule) return;
        var box = this._ui.schedule;
        // Display list = active TCs from the API + cyclogenesis
        // disturbances from the predictions payload (which the backend
        // tags with is_disturbance:true). Disturbances are rendered with
        // italic names and a "(forecast)" tag so users can tell them
        // apart from formal ATCF-tracked systems.
        var manifest = (this._manifest && this._manifest.orbits) || [];
        var pred = this._predictions && Array.isArray(this._predictions.storms)
            ? this._predictions.storms : [];
        var predByAtcf = {};
        for (var pi = 0; pi < pred.length; pi++) {
            predByAtcf[pred[pi].atcf_id] = pred[pi];
        }
        var displayList = (this._activeStorms || []).map(function (s) {
            return {
                atcf_id: s.atcf_id, name: s.name, lat: s.lat, lon: s.lon,
                vmax_kt: s.vmax_kt, is_disturbance: false
            };
        });
        var seen = {};
        for (var di = 0; di < displayList.length; di++) {
            seen[displayList[di].atcf_id] = true;
        }
        // Spatial dedup: when an FNV3 cyclogenesis disturbance ("DIST-D1")
        // is within 600 km of an already-tracked ATCF storm, they're the
        // same system — suppress the disturbance row. The atcf_id check
        // alone misses this because disturbance IDs are synthetic
        // ("DIST-D1") and never collide with real ATCF IDs ("WP992026").
        function _distKm(lat1, lon1, lat2, lon2) {
            var R = 6371;
            var rad = Math.PI / 180;
            var dLat = (lat2 - lat1) * rad;
            var dLon = (lon2 - lon1) * rad;
            var s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
            var a = s1 * s1 +
                    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * s2 * s2;
            return 2 * R * Math.asin(Math.sqrt(a));
        }
        var DEDUP_RADIUS_KM = 600;
        for (var pj = 0; pj < pred.length; pj++) {
            var pp = pred[pj];
            if (!pp.is_disturbance) continue;
            if (seen[pp.atcf_id]) continue;
            // Skip if any already-listed active TC is within DEDUP_RADIUS_KM.
            var dup = false;
            if (pp.lat != null && pp.lon != null) {
                for (var dpi = 0; dpi < displayList.length; dpi++) {
                    var ds = displayList[dpi];
                    if (ds.is_disturbance) continue;
                    if (ds.lat == null || ds.lon == null) continue;
                    if (_distKm(pp.lat, pp.lon, ds.lat, ds.lon)
                            <= DEDUP_RADIUS_KM) {
                        dup = true;
                        break;
                    }
                }
            }
            if (dup) continue;
            displayList.push({
                atcf_id: pp.atcf_id, name: pp.name,
                lat: pp.lat, lon: pp.lon,
                vmax_kt: pp.vmax_kt, is_disturbance: true,
                forecast_tau_h: pp.forecast_tau_h, frac: pp.frac
            });
        }
        if (!displayList.length) {
            box.innerHTML = '<div class="tc-mw-schedule-empty">No active TCs or developing disturbances</div>';
            return;
        }
        var now = Date.now();

        var rows = ['<div class="tc-mw-schedule-title">Pass schedule</div>'];
        for (var si = 0; si < displayList.length; si++) {
            var s = displayList[si];
            // Latest per sensor from manifest — first newest-first orbit
            // whose bounds cover the storm position.
            var latest = { GMI: null, SSMIS: null, AMSR2: null, ATMS: null };
            for (var oi = 0; oi < manifest.length; oi++) {
                var o = manifest[oi];
                if (!o.sensor || latest[o.sensor]) continue;
                if (_passCoversStorm(o, s.lat, s.lon)) {
                    latest[o.sensor] = o;
                }
            }
            // Upcoming per sensor from predictions — first future entry.
            var upcoming = { GMI: null, SSMIS: null, AMSR2: null, ATMS: null };
            var predStorm = predByAtcf[s.atcf_id];
            if (predStorm && Array.isArray(predStorm.passes)) {
                for (var ppi = 0; ppi < predStorm.passes.length; ppi++) {
                    var p = predStorm.passes[ppi];
                    if (!p.sensor || upcoming[p.sensor]) continue;
                    if (Date.parse(p.predicted_scan_start) > now) {
                        upcoming[p.sensor] = p;
                    }
                }
            }

            var stormHtml = ['<div class="tc-mw-schedule-storm'
                + (s.is_disturbance ? ' is-disturbance' : '') + '">'];
            var nameHtml = '<div class="tc-mw-schedule-storm-name">'
                + _esc(s.name || s.atcf_id);
            if (s.is_disturbance) {
                // Forecast badge + member-fraction. The atcf_id is the
                // synthetic "DIST-D1" so it's not super informative —
                // skip the dot separator + show forecast metadata instead.
                var pct = isFinite(s.frac) ? Math.round(s.frac * 100) + '%' : null;
                nameHtml += ' <span class="tc-mw-schedule-forecast-tag">forecast'
                          + (pct ? ' &middot; ' + pct : '')
                          + '</span>';
            } else {
                nameHtml += ' &middot; ' + _esc(s.atcf_id || '')
                          + (isFinite(s.vmax_kt) ? ' &middot; ' + Math.round(s.vmax_kt) + ' kt' : '');
            }
            nameHtml += '</div>';
            stormHtml.push(nameHtml);
            for (var sj = 0; sj < KNOWN_SENSORS.length; sj++) {
                var sk = KNOWN_SENSORS[sj].key;
                var sLabel = KNOWN_SENSORS[sj].label;
                var swatch = SENSOR_COLORS[sk] || '#cbd5e1';
                var latestCell = '<span class="tc-mw-schedule-cell dim">—</span>';
                if (latest[sk]) {
                    var ageMin = (now - latest[sk].scan_start_ms) / 60000;
                    latestCell = '<span class="tc-mw-schedule-cell">'
                        + _esc(_fmtCompactAgo(ageMin))
                        + '</span>';
                }
                var upcomingCell = '<span class="tc-mw-schedule-cell dim">—</span>';
                if (upcoming[sk]) {
                    var deltaMin = (Date.parse(upcoming[sk].predicted_scan_start) - now) / 60000;
                    var etaMs = Date.parse(upcoming[sk].eta_on_tcatlas);
                    var etaMin = (etaMs - now) / 60000;
                    // Predicted-pass entries beyond the baseline 24 h
                    // horizon get a "far" style — these only show up
                    // for single-satellite sensors (GMI 72 h, AMSR2
                    // 48 h) whose tropical coverage routinely misses
                    // the 24 h window. The sun-sync constellations
                    // (SSMIS, ATMS) stay capped at 24 h so they never
                    // hit this branch.
                    var isFar = deltaMin > 24 * 60;
                    var farClass = isFar ? ' far' : '';
                    var farTitle = isFar
                        ? ' (outside 24h window — sparse single-sat coverage)'
                        : '';
                    upcomingCell = '<span class="tc-mw-schedule-cell' + farClass + '" title="ETA on TC-ATLAS: '
                        + _esc(_fmtCompactIn(etaMin))
                        + ' (' + Math.round(upcoming[sk].min_distance_km) + ' km offset)'
                        + farTitle + '">'
                        + _esc(_fmtCompactIn(deltaMin))
                        + ' <span class="tc-mw-schedule-eta">&rarr;'
                        + _esc(_fmtCompactIn(etaMin)) + '</span>'
                        + '</span>';
                }
                stormHtml.push(
                    '<div class="tc-mw-schedule-row">'
                    + '<span class="tc-mw-schedule-sensor">'
                    +   '<span class="tc-mw-sensor-swatch" style="background:' + swatch + '"></span>'
                    +   _esc(sLabel)
                    + '</span>'
                    + latestCell
                    + upcomingCell
                    + '</div>'
                );
            }
            stormHtml.push('</div>');
            rows.push(stormHtml.join(''));
        }
        // Source note + freshness
        var predUpdated = this._predictions && this._predictions.updated;
        if (predUpdated) {
            var predAgeMin = (now - Date.parse(predUpdated)) / 60000;
            rows.push('<div class="tc-mw-schedule-foot">Predictions ' + _esc(_fmtCompactAgo(predAgeMin)) + ' &middot; TLEs via CelesTrak</div>');
        } else if (this._predictions === null) {
            rows.push('<div class="tc-mw-schedule-foot dim">Predictions not loaded</div>');
        }
        box.innerHTML = rows.join('');
    };

    function _fmtCompactAgo(ageMin) {
        if (ageMin < 1)  return 'just now';
        if (ageMin < 60) return Math.round(ageMin) + 'm ago';
        var h = ageMin / 60;
        if (h < 24) return h.toFixed(1) + 'h ago';
        return (h / 24).toFixed(1) + 'd ago';
    }
    function _fmtCompactIn(min) {
        if (min < 1)  return '< 1m';
        if (min < 60) return 'in ' + Math.round(min) + 'm';
        var h = min / 60;
        if (h < 24) return 'in ' + h.toFixed(1) + 'h';
        return 'in ' + (h / 24).toFixed(1) + 'd';
    }

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
