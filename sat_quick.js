/*
 * sat_quick.js — Storm Satellite Quick View
 *
 * Default Storm Satellite layout: pre-rendered IR animation +
 * minimal context bar. Matches the simplicity of cyclonicwx /
 * Tropical Tidbits — one fast-loading view, no toolbar of analytical
 * modes. The full interactive viewer (satellite.js) is opt-in via
 * "Detailed Analysis →".
 *
 * Architecture: we consume the SAME per-frame WebP bundle the
 * detailed viewer uses (gs://tc-atlas-ir-cache/rt-v10/bundles/frames/
 * {atcf}.bin), slice it into 25 blob URLs, and animate by swapping
 * <img>.src on a timer. No duplicate artifact storage, no Cloud Run
 * hop on the bundle fetch (GCS direct), and the bundle is already
 * cached by the prewarm.
 *
 * Why JS frame-swap rather than animated WebP: Pillow's animated-WebP
 * encoding produces files roughly the same size as the bundle (it
 * doesn't apply useful inter-frame compression), and the bundle is
 * already maintained for the detailed viewer. One artifact pipeline,
 * not two.
 */
(function () {
    'use strict';

    var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
    var GCS_BUNDLE_BASE = 'https://storage.googleapis.com/tc-atlas-ir-cache/rt-v10/bundles/frames';

    var SS_COLORS = {
        TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24',
        C2: '#fb923c', C3: '#f87171', C4: '#ef4444', C5: '#dc2626'
    };

    // ── Animation timing ─────────────────────────────────────
    // Each mid-loop frame holds `MID_FRAME_MS`; the most-recent
    // frame holds `LAST_FRAME_MS` (orientation pause before loop).
    var MID_FRAME_MS  = 300;     // ≈ 2× the previous default play speed
    var LAST_FRAME_MS = 1800;    // 1.8 s hold on most-recent frame

    var _activeStorms = [];
    var _currentStormId = null;
    var _lastShearByStorm = {};
    var _activated = false;
    var _pollTimer = null;
    var POLL_INTERVAL_MS = 5 * 60 * 1000;

    // ── Animation state ──────────────────────────────────────
    var _frameUrls = [];         // blob URLs in frame order
    var _frameOffsets = [];      // CSS transform offsets per frame (%, %)
    var _frameIdx = 0;
    var _animTimer = null;
    var _animActive = false;
    var _bundleArrayBuffer = null; // keep alive while blobs are in use

    function _gcsBundleUrl(atcfId) {
        return GCS_BUNDLE_BASE + '/' + encodeURIComponent(atcfId.toUpperCase()) + '.bin';
    }
    function _apiBundleUrl(atcfId) {
        return API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId)
            + '/ir-frames-bundle?lookback_hours=6&radius_deg=10&interval_min=15';
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

    // ── UI state helpers ─────────────────────────────────────
    function _showLoader(msg) {
        if (elLoader) {
            elLoader.style.display = '';
            if (msg) elLoader.textContent = msg;
        }
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

    // ── Format helpers ───────────────────────────────────────
    function _catShort(c) { return c || '—'; }
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

    // ── Animation lifecycle ──────────────────────────────────
    function _stopAnimation() {
        _animActive = false;
        if (_animTimer) {
            clearTimeout(_animTimer);
            _animTimer = null;
        }
    }
    function _disposeFrames() {
        _stopAnimation();
        for (var i = 0; i < _frameUrls.length; i++) {
            try { URL.revokeObjectURL(_frameUrls[i]); } catch (e) {}
        }
        _frameUrls = [];
        _frameOffsets = [];
        _frameIdx = 0;
        _bundleArrayBuffer = null;
        if (elAnim) elAnim.style.transform = '';
    }
    function _scheduleNextFrame() {
        if (!_animActive || _frameUrls.length === 0) return;
        // Hold the last frame longer so the user can orient themselves
        // before the loop restarts. Same convention as the detailed
        // viewer's last-frame pause + NHC/RAMMB animations.
        var dwell = (_frameIdx === _frameUrls.length - 1) ? LAST_FRAME_MS : MID_FRAME_MS;
        _animTimer = setTimeout(function () {
            if (!_animActive) return;
            _frameIdx = (_frameIdx + 1) % _frameUrls.length;
            if (elAnim) {
                elAnim.src = _frameUrls[_frameIdx];
                _applyFrameTransform(_frameIdx);
            }
            _scheduleNextFrame();
        }, dwell);
    }
    function _startAnimation() {
        if (_animActive || _frameUrls.length === 0) return;
        _animActive = true;
        // Begin on the OLDEST frame so the loop reads chronologically;
        // user sees motion forward in time. Last-frame pause is the
        // natural anchor.
        _frameIdx = 0;
        if (elAnim) {
            elAnim.src = _frameUrls[_frameIdx];
            _applyFrameTransform(_frameIdx);
        }
        _scheduleNextFrame();
    }

    // ── Bundle → frames ──────────────────────────────────────
    // Parses the [u32 LE header_length][JSON header][concat WebPs]
    // wire format produced by ir_monitor_api.py:get_storm_ir_frames_bundle
    // and pre-built by _build_and_upload_bundles in the prewarm loop.
    function _parseBundle(arrayBuffer) {
        var dv = new DataView(arrayBuffer);
        if (arrayBuffer.byteLength < 4) throw new Error('bundle too small');
        var headerLen = dv.getUint32(0, true);
        if (4 + headerLen > arrayBuffer.byteLength) throw new Error('header overrun');
        var headerJson = new TextDecoder('utf-8').decode(
            new Uint8Array(arrayBuffer, 4, headerLen));
        var header = JSON.parse(headerJson);
        var binBase = 4 + headerLen;
        var mediaType = header.media_type || 'image/webp';
        var urls = [];
        var validFrames = [];  // {frame_header, url} pairs in order
        var frames = header.frames || [];
        for (var i = 0; i < frames.length; i++) {
            var f = frames[i];
            if (!f.byte_length || f.error) continue;
            // Zero-copy view into the ArrayBuffer
            var slice = new Uint8Array(arrayBuffer, binBase + f.byte_offset, f.byte_length);
            var blob = new Blob([slice], { type: mediaType });
            var url = URL.createObjectURL(blob);
            urls.push(url);
            validFrames.push(f);
        }

        // ── Compute per-frame CSS-translate offsets ─────────────
        // Each frame's cutout is centered on the storm's INTERPOLATED
        // position at that frame's time, so consecutive frames have
        // slightly different bounds (~0.4° over 6h for a typical storm).
        // A plain <img>.src swap would show the storm "stationary" at
        // image center and the LAND visibly bouncing frame-to-frame.
        // Fix: shift each frame's <img> with `transform: translate(...)`
        // so the LATEST frame's geographic center sits at the same screen
        // position across all frames. Net visual effect: storm appears
        // to move (correct, since it does move), land stays put
        // (correct, since it doesn't).
        _frameOffsets = [];
        if (validFrames.length > 0) {
            var ref = validFrames[validFrames.length - 1];
            var refB = ref.bounds;
            if (refB && Array.isArray(refB) && refB.length >= 2) {
                var refCLat = (refB[0][0] + refB[1][0]) / 2;
                var refCLon = (refB[0][1] + refB[1][1]) / 2;
                var refSpanLat = refB[1][0] - refB[0][0];
                var refSpanLon = refB[1][1] - refB[0][1];
                for (var j = 0; j < validFrames.length; j++) {
                    var b = validFrames[j].bounds;
                    if (!b || b.length < 2) {
                        _frameOffsets.push({ tx: 0, ty: 0 });
                        continue;
                    }
                    var cLat = (b[0][0] + b[1][0]) / 2;
                    var cLon = (b[0][1] + b[1][1]) / 2;
                    // Translate as a % of the image's own dimensions.
                    // (refCLon - cLon) > 0 when ref is EAST of frame's
                    // center → ref pixel is RIGHT of image center →
                    // shift image LEFT (negative tx) so that pixel
                    // lands at container center.
                    var tx = -((refCLon - cLon) / refSpanLon) * 100;
                    // Latitude is opposite to screen y: positive
                    // (refCLat - cLat) means ref is NORTH of frame
                    // center → ref pixel is ABOVE image center →
                    // shift image DOWN (positive ty in CSS) so that
                    // pixel lands at container center.
                    var ty = ((refCLat - cLat) / refSpanLat) * 100;
                    _frameOffsets.push({ tx: tx, ty: ty });
                }
            } else {
                // No usable bounds — no compensation possible
                for (var k = 0; k < validFrames.length; k++) {
                    _frameOffsets.push({ tx: 0, ty: 0 });
                }
            }
        }
        return urls;
    }

    function _applyFrameTransform(idx) {
        if (!elAnim) return;
        var off = _frameOffsets[idx];
        if (!off || (off.tx === 0 && off.ty === 0)) {
            elAnim.style.transform = '';
        } else {
            elAnim.style.transform = 'translate(' + off.tx.toFixed(3) + '%, ' + off.ty.toFixed(3) + '%)';
        }
    }

    function _loadBundleAndAnimate(stormId) {
        if (!stormId) return;
        _hideEmpty();
        _showLoader('Loading animation…');
        _disposeFrames();

        // Try GCS direct first (prewarmed), fall back to API endpoint
        // (the latter is the live path for brand-new storms not yet in
        // the prewarm cycle).
        var gcs = _gcsBundleUrl(stormId);
        var api = _apiBundleUrl(stormId);

        fetch(gcs)
            .then(function (r) {
                if (!r.ok) throw new Error('gcs ' + r.status);
                return r.arrayBuffer();
            })
            .catch(function () {
                return fetch(api).then(function (r) {
                    if (!r.ok) throw new Error('api ' + r.status);
                    return r.arrayBuffer();
                });
            })
            .then(function (buf) {
                if (stormId !== _currentStormId) return;  // user switched storms
                _bundleArrayBuffer = buf;  // hold reference; blobs are views
                _frameUrls = _parseBundle(buf);
                if (_frameUrls.length === 0) {
                    _showError('No frames available for this storm yet.');
                    return;
                }
                // Show the most-recent frame immediately so the user sees
                // current imagery while we wait for the animation cycle
                // to start at frame 0.
                if (elAnim) {
                    var lastIdx = _frameUrls.length - 1;
                    elAnim.src = _frameUrls[lastIdx];
                    _applyFrameTransform(lastIdx);
                }
                elAnim.onload = function () {
                    _showAnim();
                    _startAnimation();
                };
                elAnim.onerror = function () {
                    _showError('Animation failed to decode.');
                };
            })
            .catch(function (err) {
                if (stormId !== _currentStormId) return;
                console.warn('[QuickView] bundle fetch failed:', err && err.message);
                _showError('Animation not yet available for this storm. The prewarm cycle builds new artifacts every ~5 minutes.');
            });
    }

    // ── Shear (small extra fetch for the meta bar) ──────────
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

    // ── Active-storms list ───────────────────────────────────
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
                    // Re-fetch bundle in case prewarm produced a newer one
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
        _stopAnimation();   // pause our timer; detailed viewer takes over
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
        if (_hashRequestsDetailed()) {
            _gotoDetailed();
            return;
        }
        var main = document.getElementById('sat-main');
        if (main) main.style.display = 'none';
        elRoot.style.display = 'flex';

        // Resume animation if we already loaded frames previously
        if (_frameUrls.length > 0 && !_animActive) {
            _startAnimation();
        }

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
            // Already initialized — pick up any hash-storm change
            var hashStorm2 = _readStormFromHash();
            if (hashStorm2 && hashStorm2 !== _currentStormId) {
                _selectStorm(hashStorm2);
            }
        }
    }

    function _deactivate() {
        // Pause when leaving the tab to free up CPU/network
        _stopAnimation();
    }

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
