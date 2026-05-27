/*
 * sat_quick.js — Storm Satellite Quick View
 *
 * The default Storm Satellite layout: a pre-rendered animated WebP
 * (built by the prewarm in ir_monitor_api.py:_build_animation_webp)
 * + a minimal context bar above and meta bar below. Loads from GCS
 * direct in ~200-400 ms — matching the simplicity and speed of
 * cyclonicwx / Tropical Tidbits.
 *
 * The full interactive viewer (satellite.js) remains available via
 * the "Detailed Analysis" button. We deliberately keep this IIFE
 * tiny and independent — no heavy dependencies, no init waterfall,
 * no canvas / Leaflet setup. Just <img>, fetch, render.
 */
(function () {
    'use strict';

    var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
    var GCS_ANIM_BASE = 'https://storage.googleapis.com/tc-atlas-ir-cache/rt-v10/animations';

    var SS_COLORS = {
        TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24',
        C2: '#fb923c', C3: '#f87171', C4: '#ef4444', C5: '#dc2626'
    };

    var _activeStorms = [];          // list from /ir-monitor/active-storms
    var _currentStormId = null;
    var _lastShearByStorm = {};      // per-storm cache (small, ~1 hour relevance)
    var _activated = false;          // first activation triggers fetch
    var _pollTimer = null;
    var POLL_INTERVAL_MS = 5 * 60 * 1000;  // align with active-storms TTL

    function _gcsAnimUrl(atcfId) {
        return GCS_ANIM_BASE + '/' + encodeURIComponent(atcfId.toUpperCase()) + '.webp';
    }

    // ── DOM refs (lazy) ──────────────────────────────────────
    var elRoot, elSelect, elCatChip, elName, elVitals, elAnim, elLoader,
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
        elAnim = document.getElementById('qv-animation');
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

    function _showLoader() {
        if (elLoader) elLoader.style.display = '';
        if (elError) elError.style.display = 'none';
        if (elAnim) elAnim.classList.remove('loaded');
    }
    function _showAnim() {
        if (elLoader) elLoader.style.display = 'none';
        if (elError) elError.style.display = 'none';
        if (elAnim) elAnim.classList.add('loaded');
    }
    function _showError(msg) {
        if (elLoader) elLoader.style.display = 'none';
        if (elError) {
            elError.textContent = msg || 'Animation unavailable.';
            elError.style.display = '';
        }
        if (elAnim) elAnim.classList.remove('loaded');
    }
    function _showEmpty() {
        if (elEmpty) elEmpty.style.display = '';
        if (elLoader) elLoader.style.display = 'none';
        if (elError) elError.style.display = 'none';
        if (elAnim) elAnim.classList.remove('loaded');
    }
    function _hideEmpty() {
        if (elEmpty) elEmpty.style.display = 'none';
    }

    // ── Render helpers ─────────────────────────────────────────
    function _categoryShort(c) {
        if (!c) return '—';
        if (c === 'TS' || c === 'TD' || /^C[0-5]$/.test(c)) return c;
        return c;
    }
    function _fmtLatLon(lat, lon) {
        if (lat == null || lon == null) return '—';
        return Math.abs(lat).toFixed(1) + '°' + (lat >= 0 ? 'N' : 'S') + '  '
            + Math.abs(lon).toFixed(1) + '°' + (lon >= 0 ? 'E' : 'W');
    }
    function _renderHeader(storm) {
        if (!storm) {
            elCatChip.textContent = '—';
            elName.textContent = '—';
            elVitals.textContent = '—';
            elPosition.textContent = '—';
            elMotion.textContent = '—';
            elSat.textContent = '—';
            return;
        }
        var cat = _categoryShort(storm.category);
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

    // ── Animation load ─────────────────────────────────────────
    // Sets <img>.src to the GCS direct URL. Browser fetches the
    // animated WebP and starts looping automatically (no JS loop
    // needed — the format handles its own timing). On 404 / decode
    // failure we show an error message; prewarm probably hasn't
    // run yet (new storm) or the bucket is having a moment.
    function _loadAnimation(stormId) {
        if (!stormId || !elAnim) return;
        _hideEmpty();
        _showLoader();
        // Use a bust param so polled refreshes pick up newer animation
        // builds after prewarm. The blob itself sets Cache-Control:
        // max-age=300; the bust just makes the URL unique per cycle.
        var bust = Math.floor(Date.now() / (5 * 60 * 1000));  // changes every 5 min
        var url = _gcsAnimUrl(stormId) + '?v=' + bust;
        elAnim.onload = function () { _showAnim(); };
        elAnim.onerror = function () {
            _showError('Animation not yet available for this storm. The prewarm cycle builds new artifacts every ~5 minutes.');
        };
        elAnim.src = url;
    }

    function _loadShear(stormId) {
        if (!stormId) return;
        // Tiny per-session cache so flipping back and forth doesn't
        // re-fetch. /shear is ~1-hour-relevant data.
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

    // ── Active-storms list ─────────────────────────────────────
    function _populateStormSelect() {
        if (!elSelect) return;
        elSelect.innerHTML = '';
        if (!_activeStorms.length) {
            var opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No active storms';
            elSelect.appendChild(opt);
            elSelect.disabled = true;
            return;
        }
        elSelect.disabled = false;
        for (var i = 0; i < _activeStorms.length; i++) {
            var s = _activeStorms[i];
            var o = document.createElement('option');
            o.value = s.atcf_id;
            var cat = _categoryShort(s.category);
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
        _loadAnimation(stormId);
        _loadShear(stormId);
        _syncHash(stormId);
    }

    function _syncHash(stormId) {
        // Preserve "satellite" view + add storm= param. Existing
        // realtime_ir.html hash parser respects storm=XX&view=satellite.
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
        // Polled refresh — re-pull active storms (positions may have
        // updated). Reload current storm's header + shear; the
        // animation auto-refreshes via the bust param on _loadAnimation,
        // so we re-call that too.
        _fetchActiveStorms(function (err) {
            if (err) return;
            if (_currentStormId) {
                var storm = _findStorm(_currentStormId);
                if (storm) {
                    _renderHeader(storm);
                    _loadAnimation(_currentStormId);
                    // Re-pull shear in case it changed
                    delete _lastShearByStorm[_currentStormId];
                    _loadShear(_currentStormId);
                } else {
                    // Storm dropped from active list — pick first available
                    if (_activeStorms.length > 0) {
                        _selectStorm(_activeStorms[0].atcf_id);
                    } else {
                        _showEmpty();
                    }
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
        var sat = document.getElementById('sat-quick-view');
        var main = document.getElementById('sat-main');
        if (sat) sat.style.display = 'none';
        if (main) {
            main.style.display = 'flex';
            if (window.activateSatelliteView) {
                // Pass the current storm so the detailed viewer
                // picks up where the quick view left off (it has
                // its own storm picker but defaults to first).
                try { window.activateSatelliteView(_currentStormId); }
                catch (e) { window.activateSatelliteView(); }
            }
        }
        // Update URL so the user can refresh into detailed mode.
        try {
            var base = '#storm=' + (_currentStormId || '') + '&view=satellite&detailed=1';
            history.replaceState(null, '', base);
        } catch (e) {}
    }

    function _hashRequestsDetailed() {
        return /[#&]detailed=1/.test(window.location.hash || '');
    }

    // ── Public activate ─────────────────────────────────────
    function activateQuickView() {
        if (!_captureDom()) return;
        // If the hash explicitly requests detailed mode, fall through
        // immediately — the user bookmarked the deep view.
        if (_hashRequestsDetailed()) {
            _gotoDetailed();
            return;
        }
        // Hide detailed in case it was previously shown
        var main = document.getElementById('sat-main');
        if (main) main.style.display = 'none';
        elRoot.style.display = 'flex';

        if (!_activated) {
            _activated = true;
            // Wire up controls (idempotent — only runs on first activate)
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
                // Honor #storm= in URL if it matches an active storm,
                // otherwise pick the strongest active.
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
            // Polled refresh — keep header + animation fresh.
            _pollTimer = setInterval(_refreshActiveData, POLL_INTERVAL_MS);
        } else {
            // Already loaded — pick up any hash-storm change
            var hashStorm2 = _readStormFromHash();
            if (hashStorm2 && hashStorm2 !== _currentStormId) {
                _selectStorm(hashStorm2);
            }
        }
    }

    // Expose for realtime_ir.html's switchIRView dispatcher
    window.activateQuickView = activateQuickView;

    // From the detailed viewer's back-to-quick handler (added in Stage 2.2)
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
