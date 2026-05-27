/*
 * sat_quick.js — Storm Satellite Quick View
 *
 * Default Storm Satellite layout: pre-rendered IR animation on a
 * Leaflet map (basemap → coastlines → graticule → IR frames →
 * storm marker), plus a compact storm-info bar above and meta bar
 * below. Matches the simplicity of cyclonicwx / Tropical Tidbits
 * for the casual case while keeping geographic context (coastlines,
 * lat/lon grid) the user expects from a research-grade viewer.
 *
 * Architecture:
 *   - Consumes the same per-frame WebP bundle the detailed viewer
 *     uses (rt-v10/bundles/frames/{atcf}.bin in GCS) — no duplicate
 *     artifact storage.
 *   - Each frame becomes an L.imageOverlay at its TRUE geographic
 *     bounds; we cycle opacity 0→1 to animate. Storm appears to
 *     move across the map (correct); coastlines + graticule stay
 *     stationary (correct).
 *   - Native scroll-zoom + pan via Leaflet.
 *
 * The full interactive viewer (satellite.js) is opt-in via
 * "Detailed Analysis →".
 */
(function () {
    'use strict';

    var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
    var GCS_BUNDLE_BASE = 'https://storage.googleapis.com/tc-atlas-ir-cache/rt-v10/bundles/frames';

    var SS_COLORS = {
        TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24',
        C2: '#fb923c', C3: '#f87171', C4: '#ef4444', C5: '#dc2626'
    };

    var MID_FRAME_MS  = 300;
    var LAST_FRAME_MS = 1800;

    // ── App state ────────────────────────────────────────────
    var _activeStorms = [];
    var _currentStormId = null;
    var _lastShearByStorm = {};
    var _activated = false;
    var _pollTimer = null;
    var POLL_INTERVAL_MS = 5 * 60 * 1000;

    // ── Leaflet state ────────────────────────────────────────
    var _map = null;
    var _frameLayers = [];          // L.imageOverlay per frame
    var _frameIdx = 0;
    var _animTimer = null;
    var _animActive = false;
    var _stormMarker = null;
    var _coastlineLayer = null;
    var _graticuleLayer = null;

    function _gcsBundleUrl(atcfId) {
        return GCS_BUNDLE_BASE + '/' + encodeURIComponent(atcfId.toUpperCase()) + '.bin';
    }
    // 10-min cadence aligns with the underlying satellite scan grid
    // (Himawari + GOES Full Disk scan every 10 min). 15-min cadence
    // mis-aligned every other frame by 5 min, causing visible storm
    // position alternation (the "NW-SE bouncing" bug). See
    // JPG_PRIMARY_INTERVAL_MIN comment in realtime_ir.js for full
    // explanation. Mobile uses 30-min for OOM headroom — 30 ⊂ 10.
    var QV_INTERVAL_MIN = (typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: coarse)').matches
        && window.matchMedia('(hover: none)').matches) ? 30 : 10;
    function _apiBundleUrl(atcfId) {
        return API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId)
            + '/ir-frames-bundle?lookback_hours=6&radius_deg=10&interval_min=' + QV_INTERVAL_MIN;
    }

    // ── DOM refs ─────────────────────────────────────────────
    var elRoot, elSelect, elCatChip, elName, elVitals, elMapDiv, elLoader,
        elEmpty, elError, elPosition, elMotion, elShear, elSat,
        elDetailedBtn;
    function _captureDom() {
        if (elRoot) return true;
        elRoot = document.getElementById('sat-quick-view');
        if (!elRoot) return false;
        elSelect = document.getElementById('qv-storm-select');
        elCatChip = document.getElementById('qv-cat');
        elName = document.getElementById('qv-name');
        elVitals = document.getElementById('qv-vitals');
        elMapDiv = document.getElementById('qv-leaflet-map');
        elLoader = document.getElementById('qv-loader');
        elEmpty = document.getElementById('qv-empty');
        elError = document.getElementById('qv-error');
        elPosition = document.getElementById('qv-position');
        elMotion = document.getElementById('qv-motion');
        elShear = document.getElementById('qv-shear');
        elSat = document.getElementById('qv-sat');
        elDetailedBtn = document.getElementById('qv-to-detailed');
        return true;
    }

    // ── UI state helpers ─────────────────────────────────────
    function _showLoader(msg) {
        if (elLoader) {
            elLoader.style.display = '';
            if (msg) elLoader.textContent = msg;
        }
        if (elError) elError.style.display = 'none';
    }
    function _hideLoader() { if (elLoader) elLoader.style.display = 'none'; }
    function _showError(msg) {
        if (elLoader) elLoader.style.display = 'none';
        if (elError) {
            elError.textContent = msg || 'Animation unavailable.';
            elError.style.display = '';
        }
    }
    function _showEmpty() {
        if (elEmpty) elEmpty.style.display = '';
        _hideLoader();
        if (elError) elError.style.display = 'none';
    }
    function _hideEmpty() { if (elEmpty) elEmpty.style.display = 'none'; }

    // ── Format helpers ───────────────────────────────────────
    function _catShort(c) { return c || '—'; }
    function _fmtLatLon(lat, lon) {
        if (lat == null || lon == null) return '—';
        return Math.abs(lat).toFixed(1) + '°' + (lat >= 0 ? 'N' : 'S') + '  '
            + Math.abs(lon).toFixed(1) + '°' + (lon >= 0 ? 'E' : 'W');
    }
    function _renderHeader(storm) {
        if (!storm) {
            elCatChip.textContent = '—'; elName.textContent = '—';
            elVitals.textContent = '—'; elPosition.textContent = '—';
            elMotion.textContent = '—'; elSat.textContent = '—';
            return;
        }
        var cat = _catShort(storm.category);
        elCatChip.textContent = cat;
        elCatChip.style.background = SS_COLORS[cat] || SS_COLORS.TD;
        elName.textContent = storm.name || storm.atcf_id || '—';
        var vmax = storm.vmax_kt != null ? (storm.vmax_kt + ' kt') : '—';
        var mslp = storm.mslp_hpa != null ? (storm.mslp_hpa + ' hPa') : '—';
        var src = storm.source ? (' · ' + storm.source) : '';
        elVitals.textContent = vmax + ' · ' + mslp + src;
        elPosition.textContent = _fmtLatLon(storm.lat, storm.lon);
        if (storm.motion_kt != null && storm.motion_deg != null) {
            elMotion.textContent = Math.round(storm.motion_kt) + ' kt @ ' + Math.round(storm.motion_deg) + '°';
        } else {
            elMotion.textContent = '—';
        }
        elSat.textContent = storm.satellite || '—';
    }

    // ── Leaflet map setup ────────────────────────────────────
    function _ensureMap() {
        if (_map) return _map;
        if (!elMapDiv || typeof L === 'undefined') return null;
        _map = L.map(elMapDiv, {
            zoomControl: true,
            attributionControl: false,
            worldCopyJump: true,
            zoomSnap: 0.5,
            zoomDelta: 0.5,
            preferCanvas: true,
        }).setView([0, 0], 5);

        // Basemap: CartoDB Voyager NO labels — clean coastlines without
        // overpowering text. Same basemap the detailed viewer uses for
        // consistency.
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png',
                    { maxZoom: 18, subdomains: 'abcd' }).addTo(_map);

        // Coastlines + admin lines layer drawn ABOVE the IR overlay so
        // the storm's geographic context stays visible through bright
        // cloud tops. Same pattern as the detailed viewer.
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
                    { maxZoom: 18, pane: 'overlayPane', opacity: 0.85 }).addTo(_map);

        // Lat/lon graticule: thin gridlines + edge labels. Spacing
        // scales with zoom so the grid is always readable.
        _addGraticule();
        return _map;
    }

    function _addGraticule() {
        if (!_map) return;
        // Simple graticule layer redrawn on moveend/zoomend.
        var gratGroup = L.layerGroup().addTo(_map);
        function _step(z) {
            if (z >= 8) return 1;
            if (z >= 6) return 2;
            if (z >= 4) return 5;
            return 10;
        }
        function _redraw() {
            gratGroup.clearLayers();
            var b = _map.getBounds();
            var z = _map.getZoom();
            var step = _step(z);
            var south = Math.floor(b.getSouth() / step) * step;
            var north = Math.ceil(b.getNorth() / step) * step;
            var west = Math.floor(b.getWest() / step) * step;
            var east = Math.ceil(b.getEast() / step) * step;
            var lineStyle = {
                color: '#94a3b8', weight: 0.5, opacity: 0.45,
                interactive: false, dashArray: '2,4',
            };
            for (var lat = south; lat <= north; lat += step) {
                L.polyline([[lat, west - 5], [lat, east + 5]], lineStyle).addTo(gratGroup);
            }
            for (var lon = west; lon <= east; lon += step) {
                L.polyline([[south - 5, lon], [north + 5, lon]], lineStyle).addTo(gratGroup);
            }
        }
        _map.on('moveend zoomend', _redraw);
        _redraw();
        _graticuleLayer = gratGroup;
    }

    function _placeStormMarker(storm) {
        if (!_map || !storm) return;
        if (_stormMarker) {
            _map.removeLayer(_stormMarker);
            _stormMarker = null;
        }
        var cat = _catShort(storm.category);
        var color = SS_COLORS[cat] || SS_COLORS.TD;
        var icon = L.divIcon({
            className: '',
            html: '<div style="width:14px;height:14px;border-radius:50%;'
                + 'background:' + color + ';border:2px solid #fff;'
                + 'box-shadow:0 0 0 1px ' + color + ', 0 0 10px rgba(0,0,0,0.6);"></div>',
            iconSize: [14, 14],
            iconAnchor: [7, 7],
        });
        _stormMarker = L.marker([storm.lat, storm.lon], { icon: icon, interactive: false }).addTo(_map);
    }

    // ── Animation lifecycle ──────────────────────────────────
    function _stopAnimation() {
        _animActive = false;
        if (_animTimer) { clearTimeout(_animTimer); _animTimer = null; }
    }
    function _disposeFrames() {
        _stopAnimation();
        if (_map) {
            for (var i = 0; i < _frameLayers.length; i++) {
                if (_frameLayers[i]) {
                    try { _map.removeLayer(_frameLayers[i]); } catch (e) {}
                    if (_frameLayers[i]._blobUrl) {
                        try { URL.revokeObjectURL(_frameLayers[i]._blobUrl); } catch (e) {}
                    }
                }
            }
        }
        _frameLayers = [];
        _frameIdx = 0;
    }
    function _showFrameOnly(idx) {
        for (var i = 0; i < _frameLayers.length; i++) {
            if (!_frameLayers[i]) continue;
            _frameLayers[i].setOpacity(i === idx ? 0.92 : 0);
        }
    }
    function _scheduleNextFrame() {
        if (!_animActive || _frameLayers.length === 0) return;
        var dwell = (_frameIdx === _frameLayers.length - 1) ? LAST_FRAME_MS : MID_FRAME_MS;
        _animTimer = setTimeout(function () {
            if (!_animActive) return;
            _frameIdx = (_frameIdx + 1) % _frameLayers.length;
            _showFrameOnly(_frameIdx);
            _scheduleNextFrame();
        }, dwell);
    }
    function _startAnimation() {
        if (_animActive || _frameLayers.length === 0) return;
        _animActive = true;
        _frameIdx = 0;
        _showFrameOnly(_frameIdx);
        _scheduleNextFrame();
    }

    // ── Bundle parsing + map population ──────────────────────
    function _loadBundleAndAnimate(stormId) {
        if (!stormId) return;
        _hideEmpty();
        _showLoader('Loading animation…');
        _disposeFrames();
        _ensureMap();

        var gcs = _gcsBundleUrl(stormId);
        var api = _apiBundleUrl(stormId);

        fetch(gcs).then(function (r) {
            if (!r.ok) throw new Error('gcs ' + r.status);
            return r.arrayBuffer();
        }).catch(function () {
            return fetch(api).then(function (r) {
                if (!r.ok) throw new Error('api ' + r.status);
                return r.arrayBuffer();
            });
        }).then(function (buf) {
            if (stormId !== _currentStormId) return;
            _populateMapFromBundle(buf, stormId);
        }).catch(function (err) {
            if (stormId !== _currentStormId) return;
            console.warn('[QuickView] bundle fetch failed:', err && err.message);
            _showError('Animation not yet available for this storm. The prewarm cycle builds new artifacts every ~5 minutes.');
        });
    }

    function _populateMapFromBundle(arrayBuffer, stormId) {
        if (!_map) return;
        try {
            var dv = new DataView(arrayBuffer);
            if (arrayBuffer.byteLength < 4) throw new Error('bundle too small');
            var headerLen = dv.getUint32(0, true);
            if (4 + headerLen > arrayBuffer.byteLength) throw new Error('header overrun');
            var header = JSON.parse(new TextDecoder('utf-8')
                .decode(new Uint8Array(arrayBuffer, 4, headerLen)));
            var binBase = 4 + headerLen;
            var mediaType = header.media_type || 'image/webp';
            var hdrFrames = header.frames || [];

            // ── Storm-relative view: place ALL frames at the LATEST
            // frame's bounds. The detailed viewer places each frame at
            // its own interpolated bounds (storm moves geographically
            // across map) — but for the Quick View, where the user
            // expects fixed frame edges, that creates visible "bouncing"
            // as cutout edges shift frame-to-frame.
            //
            // With unified bounds, the storm visually stays at the center
            // of the displayed region (it WAS at center of each cutout
            // when rendered). Cloud features around it FLOW as time
            // progresses (different cloud patterns at different
            // timestamps). Coastlines + lat/lon grid stay anchored to
            // their real geographic positions via the basemap.
            //
            // This is the "co-moving" or "storm-relative" framing — a
            // standard TC research visualization. Users who want true
            // geographic motion click "Detailed Analysis →".
            var validFrameHdrs = [];
            for (var i = 0; i < hdrFrames.length; i++) {
                if (hdrFrames[i].byte_length && !hdrFrames[i].error
                        && hdrFrames[i].bounds) {
                    validFrameHdrs.push(hdrFrames[i]);
                }
            }
            if (validFrameHdrs.length === 0) {
                _showError('No frames available for this storm yet.');
                return;
            }
            var latestHdr = validFrameHdrs[validFrameHdrs.length - 1];
            var unifiedBounds = L.latLngBounds(
                L.latLng(latestHdr.bounds[0][0], latestHdr.bounds[0][1]),
                L.latLng(latestHdr.bounds[1][0], latestHdr.bounds[1][1]));

            for (var j = 0; j < validFrameHdrs.length; j++) {
                var f = validFrameHdrs[j];
                var slice = new Uint8Array(arrayBuffer, binBase + f.byte_offset, f.byte_length);
                var blob = new Blob([slice], { type: mediaType });
                var url = URL.createObjectURL(blob);
                var overlay = L.imageOverlay(url, unifiedBounds, {
                    opacity: 0,
                    interactive: false,
                    pane: 'tilePane',  // below the labels overlay
                });
                overlay._blobUrl = url;
                overlay.addTo(_map);
                _frameLayers.push(overlay);
            }

            // Initial view: latest frame's bounds (with a touch of padding
            // so the storm isn't pressed against the edges).
            _map.fitBounds(unifiedBounds, { padding: [20, 20], animate: false });

            // Place storm marker at current advisory position
            var storm = _findStorm(stormId);
            _placeStormMarker(storm);

            _hideLoader();
            _startAnimation();
        } catch (e) {
            console.warn('[QuickView] bundle parse failed:', e.message);
            _showError('Could not parse animation data.');
        }
    }

    // ── Shear ────────────────────────────────────────────────
    function _loadShear(stormId) {
        if (!stormId) return;
        if (_lastShearByStorm[stormId]) {
            _renderShear(_lastShearByStorm[stormId]);
            return;
        }
        elShear.textContent = '…';
        fetch(API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/shear',
              { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) {
                _lastShearByStorm[stormId] = data;
                if (_currentStormId === stormId) _renderShear(data);
            })
            .catch(function () {
                if (_currentStormId === stormId) elShear.textContent = '—';
            });
    }
    function _renderShear(data) {
        if (!data || data.magnitude_kt == null) {
            elShear.textContent = '—';
            return;
        }
        elShear.textContent = Math.round(data.magnitude_kt) + ' kt'
            + (data.heading_deg != null ? ' @ ' + Math.round(data.heading_deg) + '°' : '');
    }

    // ── Active storms ────────────────────────────────────────
    function _populateStormSelect() {
        if (!elSelect) return;
        elSelect.innerHTML = '';
        if (!_activeStorms.length) {
            var opt = document.createElement('option');
            opt.value = ''; opt.textContent = 'No active storms';
            elSelect.appendChild(opt);
            elSelect.disabled = true;
            return;
        }
        elSelect.disabled = false;
        for (var i = 0; i < _activeStorms.length; i++) {
            var s = _activeStorms[i];
            var o = document.createElement('option');
            o.value = s.atcf_id;
            var cat = _catShort(s.category);
            o.textContent = (s.name || s.atcf_id) + '  ·  ' + cat
                + (s.vmax_kt != null ? '  ·  ' + s.vmax_kt + ' kt' : '')
                + '  ·  ' + (s.basin || '?');
            elSelect.appendChild(o);
        }
        if (_currentStormId) elSelect.value = _currentStormId;
    }
    function _findStorm(stormId) {
        for (var i = 0; i < _activeStorms.length; i++) {
            if (_activeStorms[i].atcf_id === stormId) return _activeStorms[i];
        }
        return null;
    }
    function _selectStorm(stormId) {
        if (!stormId || stormId === _currentStormId) return;
        _currentStormId = stormId;
        if (elSelect) elSelect.value = stormId;
        var storm = _findStorm(stormId);
        _renderHeader(storm);
        _loadBundleAndAnimate(stormId);
        _loadShear(stormId);
        _syncHash(stormId);
    }
    function _syncHash(stormId) {
        try {
            var h = '#storm=' + encodeURIComponent(stormId) + '&view=satellite';
            history.replaceState(null, '', h);
        } catch (e) {}
    }
    function _readStormFromHash() {
        var h = (window.location.hash || '').replace(/^#/, '');
        var m = h.match(/(?:^|&)storm=([A-Za-z0-9]+)/);
        return m ? m[1].toUpperCase() : null;
    }
    function _hashRequestsDetailed() {
        return /[#&]detailed=1/.test(window.location.hash || '');
    }
    function _fetchActiveStorms(cb) {
        fetch(API_BASE + '/ir-monitor/active-storms', { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (data) {
                _activeStorms = (data && data.storms) || [];
                _populateStormSelect();
                cb && cb(null);
            })
            .catch(function (err) {
                console.warn('[QuickView] active-storms fetch failed:', err.message);
                cb && cb(err);
            });
    }
    function _refreshActiveData() {
        _fetchActiveStorms(function (err) {
            if (err) return;
            if (_currentStormId) {
                var storm = _findStorm(_currentStormId);
                if (storm) {
                    _renderHeader(storm);
                    _loadBundleAndAnimate(_currentStormId);
                    delete _lastShearByStorm[_currentStormId];
                    _loadShear(_currentStormId);
                } else if (_activeStorms.length > 0) {
                    _selectStorm(_activeStorms[0].atcf_id);
                } else {
                    _showEmpty();
                }
            } else if (_activeStorms.length > 0) {
                _selectStorm(_activeStorms[0].atcf_id);
            } else {
                _showEmpty();
            }
        });
    }

    // ── Detailed Analysis switch ─────────────────────────────
    function _gotoDetailed() {
        _stopAnimation();
        var sat = document.getElementById('sat-quick-view');
        var main = document.getElementById('sat-main');
        if (sat) sat.style.display = 'none';
        if (main) {
            main.style.display = 'flex';
            if (window.activateSatelliteView) {
                try { window.activateSatelliteView(_currentStormId); }
                catch (e) { window.activateSatelliteView(); }
            }
        }
        try {
            var base = '#storm=' + (_currentStormId || '') + '&view=satellite&detailed=1';
            history.replaceState(null, '', base);
        } catch (e) {}
    }

    // ── Public activate ──────────────────────────────────────
    function activateQuickView() {
        if (!_captureDom()) return;
        if (_hashRequestsDetailed()) { _gotoDetailed(); return; }
        var main = document.getElementById('sat-main');
        if (main) main.style.display = 'none';
        elRoot.style.display = 'flex';

        // Lazy-init map after the container is visible (Leaflet needs
        // a positive-size container to compute its tile grid).
        setTimeout(function () {
            if (_map) {
                _map.invalidateSize(false);
                if (_frameLayers.length > 0 && !_animActive) _startAnimation();
            } else {
                _ensureMap();
            }
        }, 50);

        if (!_activated) {
            _activated = true;
            if (elSelect) {
                elSelect.addEventListener('change', function () {
                    if (this.value) _selectStorm(this.value);
                });
            }
            if (elDetailedBtn) {
                elDetailedBtn.addEventListener('click', _gotoDetailed);
            }
            _fetchActiveStorms(function (err) {
                if (err || _activeStorms.length === 0) {
                    _showEmpty();
                    return;
                }
                var hashStorm = _readStormFromHash();
                var pick = null;
                if (hashStorm) pick = _findStorm(hashStorm);
                if (!pick) {
                    var sorted = _activeStorms.slice().sort(function (a, b) {
                        return (b.vmax_kt || 0) - (a.vmax_kt || 0);
                    });
                    pick = sorted[0];
                }
                if (pick) _selectStorm(pick.atcf_id);
            });
            _pollTimer = setInterval(_refreshActiveData, POLL_INTERVAL_MS);
        } else {
            var hashStorm2 = _readStormFromHash();
            if (hashStorm2 && hashStorm2 !== _currentStormId) {
                _selectStorm(hashStorm2);
            }
        }
    }

    function _deactivate() { _stopAnimation(); }

    window.activateQuickView = activateQuickView;
    window.deactivateQuickView = _deactivate;
    window.deactivateDetailedView = function () {
        var main = document.getElementById('sat-main');
        if (main) main.style.display = 'none';
        var qv = document.getElementById('sat-quick-view');
        if (qv) {
            qv.style.display = 'flex';
            activateQuickView();
        }
    };
})();
