/* Real-Time Monitor → Subseasonal tab.
 *
 * Pulls together three live data products onto one operational view:
 *  1. Daily MJO RMM / ROMI / BSISO1 / BSISO2 phase + amplitude (8-sector
 *     dial × 4) — same JSON the TC Climatology page uses.
 *  2. 60-day Hovmöllers (time × longitude) of OLR anomaly + four
 *     Wheeler-Kiladis-filtered wave bands (MJO, Kelvin, ER, MRG).
 *     Stacked Plotly heatmaps with synced longitude axis.
 *  3. Active TCs projected onto each Hovmöller as a vertical line at
 *     today's longitude, so users can immediately see "is this storm
 *     riding a convective envelope or wave."
 *
 * Lazy-initialized via `window.activateSubseasonalView()` invoked from
 * the page-level tab switcher in realtime_ir.html. SVG dials are
 * rendered with the shared SubseasonalClock module.
 */
(function () {
    'use strict';

    var API_BASE = 'https://api.tcatlas.org';
    var GCS_BASE = 'https://cdn.tcatlas.org/subseasonal';   // R2 (Phase 2a); kept fresh by tc-atlas-r2-mirror job
    var INDICES_URL = GCS_BASE + '/indices/latest.json';
    var INDICES_FALLBACK = 'data/subseasonal_phases.json';

    // WaveSpec names must match build_subseasonal_overlays.py.
    // forcedLatBand: pin a panel to a specific lat band regardless of
    // the user's toggle. Used for MRG / TD-type because they're
    // antisymmetric about the equator — averaging over a symmetric
    // band (10°S-10°N or 5°S-5°N) cancels the signal to zero by
    // construction. The northern lobe at 5°N-15°N is where the
    // antisymmetric variance lives.
    // vlim ≈ p98 of the panel's active lat band (trop10 for symmetric
    // bands; boreal for MRG/TD-type which are antisymmetric about the
    // equator). Older saturate-the-extremes choices (Kelvin ±12, ER ±8,
    // MRG ±6, TD ±5) clipped roughly half the strong-wave pixels because
    // they were anchored closer to p50-p75; bumping to p98 keeps the
    // colorbar useful for typical events while preserving visible
    // saturation at the rare ±2σ tails.
    var BANDS = [
        { key: 'anomaly', title: 'OLR anomaly (raw)',             vlim: 40 },
        { key: 'mjo',     title: 'MJO band (30-96 d)',            vlim: 15 },
        { key: 'kelvin',  title: 'Kelvin (eastward, ~12-25 m/s)', vlim: 22 },
        { key: 'er',      title: 'Equatorial Rossby (westward, 9.7-72 d)', vlim: 15 },
        { key: 'mrg',     title: 'Mixed Rossby-Gravity (3-96 d, 5°N-15°N)', vlim: 20,
          forcedLatBand: 'boreal' },
        { key: 'td_type', title: 'TD-type disturbances (2.5-5 d, 5°N-15°N)', vlim: 7,
          forcedLatBand: 'boreal' },
    ];

    var TRAIL_DAYS = 15;

    // First-visit default is the combined view (Peyrille-style — matches
    // the operational TC-monitoring convention and surfaces the punchline
    // in one figure). Returning users keep whatever they last picked,
    // remembered across sessions via localStorage.
    var VIEW_MODE_STORAGE_KEY = 'tcatlas-sub-viewmode';
    function _loadStoredViewMode() {
        try {
            var v = window.localStorage && localStorage.getItem(VIEW_MODE_STORAGE_KEY);
            if (v === 'stacked' || v === 'combined') return v;
        } catch (e) {}
        return 'combined';
    }
    function _storeViewMode(v) {
        try {
            if (window.localStorage) localStorage.setItem(VIEW_MODE_STORAGE_KEY, v);
        } catch (e) {}
    }

    // When loaded inside an iframe with the URL hash flag `subOnly=1`,
    // the climo page wants the page reduced to just our combined
    // Hovmöller. Force combined view + hide TC overlay so the embed
    // is a clean wave/convection figure, irrespective of whatever the
    // user's persisted localStorage view preference was.
    var SUB_ONLY = document.documentElement.classList.contains('sub-only-mode');

    var state = {
        initialized: false,
        indices: null,
        slabs: {},                  // { bandKey: payload }  (observed-only)
        fcstSlabs: {},              // { bandKey: payload }  (obs + GEFS 10-day)
        activeStorms: [],
        latBand: 'trop10',
        showTCOverlay: !SUB_ONLY,
        showForecast: true,         // GEFS 10-day Hovmöller extension toggle (default on; CPC OLR runs ~2-4 d latent, so the bridge+forecast keeps the default view current)
        expandedBands: {},          // { bandKey: bool } — sticky per-tab session
        tcLoading: false,           // true while phase-2 recent-storms is in flight
        viewMode: SUB_ONLY ? 'combined' : _loadStoredViewMode(),
        combinedSmoothDays: 5,      // OLR base smoothing in combined view: 1 (raw), 3, or 5 days
    };

    // Hovmöller plot-area horizontal margins (px). The basin reference strip
    // beneath a Hovmöller MUST reuse the same l/r so their longitude axes line
    // up pixel-for-pixel. The combined view needs a wider column than the
    // stacked panels (bigger date labels + the OLR colorbar reservation on the
    // right); the strip previously hard-coded the stacked values, so under the
    // combined view its map read wider than the Hovmöller above it.
    var COMBINED_HOV_MARGIN_LR = { l: 90, r: 90 };
    var STACKED_HOV_MARGIN_LR  = { l: 60, r: 55 };

    // Per-band contour styling for the combined view. Colors are chosen
    // for legibility on top of the BrBG OLR base (dark green ↔ tan ↔ deep
    // brown), so no green or brown hue is used: MJO black, Kelvin blue,
    // ER red, MRG magenta, TD-type cyan. Two levels per band keeps the
    // figure readable even when several modes are active.
    var COMBINED_OVERLAYS = [
        { key: 'mjo',     label: 'MJO',     color: '#000000', levels: [7, 12] },
        { key: 'kelvin',  label: 'Kelvin',  color: '#1e40af', levels: [12, 20] },
        { key: 'er',      label: 'ER',      color: '#dc2626', levels: [8, 14] },
        // MRG and TD-type are forced to the boreal lat band (5-15°N),
        // which doesn't match the symmetric base the user picked. Start
        // hidden so the figure stays focused; user can click the legend
        // to toggle them on.
        { key: 'mrg',     label: 'MRG',     color: '#c026d3', levels: [11, 17],
          latNote: '5-15°N', defaultVisible: false },
        { key: 'td_type', label: 'TD-type', color: '#0ea5e9', levels: [4, 6],
          latNote: '5-15°N', defaultVisible: false },
    ];

    // NaN-safe centered boxcar smoothing in time. `values` is a 2D
    // [time][lon] array; `halfWindow` is the half-width in timesteps
    // (so a 5-day boxcar is halfWindow = 2). Cheap — ~50 KB of float
    // ops per combined render — so we do it client-side instead of
    // shipping a separate smoothed slab.
    function _smoothInTime(values, halfWindow) {
        if (!halfWindow || halfWindow < 1 || !values || !values.length) return values;
        var nt = values.length;
        var nx = values[0].length;
        var out = new Array(nt);
        for (var t = 0; t < nt; t++) {
            var lo = Math.max(0, t - halfWindow);
            var hi = Math.min(nt - 1, t + halfWindow);
            var row = new Array(nx);
            for (var x = 0; x < nx; x++) {
                var s = 0, n = 0;
                for (var k = lo; k <= hi; k++) {
                    var v = values[k][x];
                    if (v != null && isFinite(v)) { s += v; n++; }
                }
                row[x] = n > 0 ? s / n : null;
            }
            out[t] = row;
        }
        return out;
    }

    function _ga(eventName, params) {
        try { if (typeof gtag === 'function') gtag('event', eventName, params || {}); } catch (e) {}
    }

    // Hovmöller watermark — label + canonical TC-ATLAS URL so saved PNGs
    // and screenshots carry attribution. Compact two-line block in the
    // bottom-right corner; theme-aware so it stays legible against both
    // the dark and light heatmap palettes. Font size scales for the
    // 2× export raster (live view never displays this).
    function _watermarkAnnotation() {
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var fg = isDark ? 'rgba(220,228,238,0.78)' : 'rgba(15,23,42,0.55)';
        var bg = isDark ? 'rgba(15,23,30,0.55)'   : 'rgba(255,255,255,0.65)';
        return {
            xref: 'paper', yref: 'paper',
            x: 1, y: 0,
            xanchor: 'right', yanchor: 'bottom',
            text: 'TC-ATLAS<br>tcatlas.org',
            align: 'right',
            showarrow: false,
            font: { size: 14, color: fg,
                    family: 'DM Sans, system-ui, sans-serif' },
            bgcolor: bg,
            borderpad: 4,
        };
    }

    // Plotly's font sizes are in absolute CSS pixels, so when we
    // rasterize at 2× scale the figure grows 2× but text glyph height
    // stays put — making axis ticks, legend, colorbar, and annotations
    // look ~half their on-screen relative size in the saved PNG. This
    // helper temporarily scales the relevant text attributes up by
    // `scale`, runs `work()`, and reverts in `.finally`. Returns
    // whatever `work()` resolves to.
    function _withScaledExportText(panel, scale, work) {
        if (!panel || !panel.layout || scale === 1
            || !(Plotly.relayout && Plotly.restyle)) {
            return Promise.resolve().then(function () { return work(); });
        }
        var layout = panel.layout;
        function val(obj, path, dflt) {
            var p = path.split('.'), v = obj;
            for (var i = 0; i < p.length; i++) {
                if (v == null) return dflt;
                v = v[p[i]];
            }
            return v == null ? dflt : v;
        }
        var orig = {
            fontSize:        val(layout, 'font.size', 10),
            legendFontSize:  val(layout, 'legend.font.size', 10),
            xaxisTickSize:   val(layout, 'xaxis.tickfont.size', 10),
            yaxisTickSize:   val(layout, 'yaxis.tickfont.size', 10),
        };
        var origAnns = (layout.annotations || []).map(function (a) {
            return a && a.font ? a.font.size : null;
        });
        var scaledLayout = {
            'font.size':            orig.fontSize * scale,
            'legend.font.size':     Math.round(orig.legendFontSize * scale),
            'xaxis.tickfont.size':  Math.round(orig.xaxisTickSize * scale),
            'yaxis.tickfont.size':  Math.round(orig.yaxisTickSize * scale),
        };
        var scaledAnns = (layout.annotations || []).map(function (a) {
            if (!a) return a;
            var size = (a.font && a.font.size) || 10;
            return Object.assign({}, a, {
                font: Object.assign({}, a.font || {}, { size: Math.round(size * scale) }),
            });
        });
        if (scaledAnns.length) scaledLayout.annotations = scaledAnns;

        // Colorbar fonts live on traces, not on the layout — bump via restyle.
        var traceColorbarOrig = [];
        (panel.data || []).forEach(function (t, i) {
            if (t.colorbar) {
                traceColorbarOrig.push({
                    idx: i,
                    tick: (t.colorbar.tickfont && t.colorbar.tickfont.size) || 9,
                    title: (t.colorbar.title && t.colorbar.title.font
                            && t.colorbar.title.font.size) || 8,
                });
            }
        });

        // TC track markers / connecting lines / storm-name labels also live on
        // traces, so they'd stay their on-screen pixel size on the 2× raster
        // and render half-size relative to everything else. Scale them too.
        var traceStyleOrig = [];
        (panel.data || []).forEach(function (t, i) {
            var mode = t.mode || '';
            var rec = { idx: i };
            var any = false;
            if (mode.indexOf('markers') !== -1 && t.marker
                    && typeof t.marker.size === 'number') {
                rec.markerSize = t.marker.size; any = true;
                if (t.marker.line && typeof t.marker.line.width === 'number') {
                    rec.markerLineWidth = t.marker.line.width;
                }
            }
            if (mode.indexOf('lines') !== -1 && t.line
                    && typeof t.line.width === 'number') {
                rec.lineWidth = t.line.width; any = true;
            }
            if (t.textfont && typeof t.textfont.size === 'number') {
                rec.textSize = t.textfont.size; any = true;
            }
            if (any) traceStyleOrig.push(rec);
        });

        return Plotly.relayout(panel, scaledLayout).then(function () {
            return Promise.all(traceColorbarOrig.map(function (c) {
                return Plotly.restyle(panel, {
                    'colorbar.tickfont.size': Math.round(c.tick * scale),
                    'colorbar.title.font.size': Math.round(c.title * scale),
                }, [c.idx]);
            }).concat(traceStyleOrig.map(function (c) {
                var upd = {};
                if (c.markerSize != null) upd['marker.size'] = Math.round(c.markerSize * scale);
                if (c.markerLineWidth != null) upd['marker.line.width'] = c.markerLineWidth * scale;
                if (c.lineWidth != null) upd['line.width'] = c.lineWidth * scale;
                if (c.textSize != null) upd['textfont.size'] = Math.round(c.textSize * scale);
                return Plotly.restyle(panel, upd, [c.idx]);
            })));
        }).then(function () { return work(); }).finally(function () {
            var revertLayout = {
                'font.size':            orig.fontSize,
                'legend.font.size':     orig.legendFontSize,
                'xaxis.tickfont.size':  orig.xaxisTickSize,
                'yaxis.tickfont.size':  orig.yaxisTickSize,
            };
            // Restore original annotations array exactly.
            revertLayout.annotations = (layout.annotations || []).map(function (a, i) {
                if (!a || origAnns[i] == null) return a;
                return Object.assign({}, a, {
                    font: Object.assign({}, a.font || {}, { size: origAnns[i] }),
                });
            });
            return Plotly.relayout(panel, revertLayout).then(function () {
                return Promise.all(traceColorbarOrig.map(function (c) {
                    return Plotly.restyle(panel, {
                        'colorbar.tickfont.size': c.tick,
                        'colorbar.title.font.size': c.title,
                    }, [c.idx]);
                }).concat(traceStyleOrig.map(function (c) {
                    var upd = {};
                    if (c.markerSize != null) upd['marker.size'] = c.markerSize;
                    if (c.markerLineWidth != null) upd['marker.line.width'] = c.markerLineWidth;
                    if (c.lineWidth != null) upd['line.width'] = c.lineWidth;
                    if (c.textSize != null) upd['textfont.size'] = c.textSize;
                    return Plotly.restyle(panel, upd, [c.idx]);
                })));
            }).catch(function () {});
        });
    }

    function _fetchJSON(url, opts) {
        return fetch(url, opts || { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + url);
                return r.json();
            });
    }

    function _loadIndices() {
        if (state.indices) return Promise.resolve(state.indices);
        return _fetchJSON(INDICES_URL)
            .catch(function (err) {
                console.warn('[subseasonal-rt] GCS indices failed, falling back:', err.message);
                return _fetchJSON(INDICES_FALLBACK + '?v=' + (window.__v || ''));
            })
            .then(function (d) { state.indices = d; return d; });
    }

    function _loadSlabs() {
        var promises = [];
        BANDS.forEach(function (b) {
            var url = GCS_BASE + '/' + b.key + '/hovmoller.json';
            promises.push(_fetchJSON(url)
                .then(function (slab) { state.slabs[b.key] = slab; })
                .catch(function (err) {
                    console.warn('[subseasonal-rt] Hovmöller ' + b.key + ' failed:', err.message);
                    state.slabs[b.key] = null;
                }));
            // Forecast-extended slab (obs + GEFS 10-day). Optional — older
            // pipeline runs won't have it yet, so a 404 just disables the
            // toggle rather than failing the load.
            var furl = GCS_BASE + '/' + b.key + '/hovmoller_fcst.json';
            promises.push(_fetchJSON(furl)
                .then(function (slab) { state.fcstSlabs[b.key] = slab; })
                .catch(function () { state.fcstSlabs[b.key] = null; }));
        });
        return Promise.all(promises);
    }

    // True only when the user has the toggle on AND every requested band
    // actually has a forecast slab loaded. Used to gate the toggle's
    // enabled state and the divider/shading rendering.
    function _forecastAvailable() {
        return BANDS.some(function (b) { return state.fcstSlabs[b.key]; });
    }

    // Returns the slab to render for a band: the forecast-extended one when
    // the toggle is on and it exists, otherwise the observed-only slab.
    function _activeSlab(bandKey) {
        if (state.showForecast) {
            var f = state.fcstSlabs[bandKey];
            if (f && f.lat_bands) return f;
        }
        return state.slabs[bandKey];
    }

    // Plotly shapes + annotations marking the GEFS extension on a
    // (time-on-y, reversed) Hovmöller. The tail below the last CPC OLR day
    // is NOT one uniform "forecast": when CPC runs latent, the gap between
    // the last observed day and the latest GEFS cycle is back-filled with
    // each day's own GEFS day-1 (0–24 h) field — analysis-quality, not a
    // multi-day-old forecast — and only the span from the latest cycle
    // forward is a genuine forecast. We draw the two regimes distinctly so a
    // long CPC outage doesn't read as stale guidance:
    //   • forecast_from … forecast_start  →  "GEFS analysis" (teal, gap-fill)
    //   • forecast_start … last day        →  "GEFS forecast" (blue)
    // `forecast_start` (latest GEFS cycle day) comes from the pipeline;
    // absent that (older output), we fall back to today (UTC) so the split
    // still appears. `slab` must carry n_forecast / forecast_from.
    function _forecastDecor(slab, fg) {
        var out = { shapes: [], annotations: [] };
        if (!slab || !slab.n_forecast || !slab.forecast_from) return out;
        var times = slab.times;
        var fromIdx = times.indexOf(slab.forecast_from);
        if (fromIdx <= 0) return out;
        var lastTime = times[times.length - 1];
        // Plotly reads the "YYYY-MM-DD" y values as a DATE axis, so shape /
        // annotation coordinates must be date strings (numeric indices get
        // read as ms-since-epoch and blow the autorange back to 1970).
        var gefsEdge = slab.forecast_from + 'T00:00:00';   // CPC obs ↔ GEFS
        var lastEdge = lastTime + 'T23:59:59';

        // Where the genuine forecast begins (latest GEFS cycle day). Prefer
        // the pipeline value; else today (UTC) as a close, self-updating
        // approximation on pre-field output.
        var fcStart = slab.forecast_start || new Date().toISOString().slice(0, 10);
        // A separate analysis-fill band exists only when that boundary sits
        // strictly inside the GEFS span (i.e. CPC was latent by >1 day).
        var haveBridge = fcStart > slab.forecast_from
            && fcStart <= lastTime && times.indexOf(fcStart) > fromIdx;
        var fcEdge = haveBridge ? (fcStart + 'T00:00:00') : gefsEdge;

        // ── Analysis-fill band (CPC gap bridged with GEFS day-1) ──────────
        if (haveBridge) {
            out.shapes.push({
                type: 'rect', xref: 'x', yref: 'y',
                x0: 0, x1: 360, y0: gefsEdge, y1: fcEdge,
                fillcolor: 'rgba(20,184,166,0.10)',   // teal — distinct from blue
                line: { width: 0 }, layer: 'below',
            });
            out.shapes.push({
                type: 'line', xref: 'x', yref: 'y',
                x0: 0, x1: 360, y0: gefsEdge, y1: gefsEdge,
                line: { color: fg, width: 1, dash: 'dot' }, layer: 'above',
            });
            out.annotations.push({
                xref: 'x', yref: 'y', x: 0, xanchor: 'left',
                y: gefsEdge, yanchor: 'top',
                text: 'GEFS analysis', showarrow: false,
                font: { size: 9, color: fg, family: 'DM Sans, system-ui, sans-serif' },
                bgcolor: 'rgba(20,184,166,0.18)', borderpad: 2,
            });
        }

        // ── Forecast band (latest GEFS cycle forward) ─────────────────────
        out.shapes.push({
            type: 'rect', xref: 'x', yref: 'y',
            x0: 0, x1: 360, y0: fcEdge, y1: lastEdge,
            fillcolor: 'rgba(46,125,255,0.07)', line: { width: 0 }, layer: 'below',
        });
        out.shapes.push({
            type: 'line', xref: 'x', yref: 'y',
            x0: 0, x1: 360, y0: fcEdge, y1: fcEdge,
            line: { color: fg, width: 1.2, dash: 'dot' }, layer: 'above',
        });
        // Forecast tag anchored on the RIGHT so it can't collide with the
        // left-anchored "GEFS analysis" tag when the bridge band is thin.
        var fcstLabel = slab.gefs_cycle
            ? ('GEFS forecast · ' + slab.gefs_cycle) : 'GEFS forecast';
        out.annotations.push({
            xref: 'x', yref: 'y', x: 360, xanchor: 'right',
            y: fcEdge, yanchor: 'top',
            text: fcstLabel, showarrow: false,
            font: { size: 9, color: fg, family: 'DM Sans, system-ui, sans-serif' },
            bgcolor: 'rgba(46,125,255,0.12)', borderpad: 2,
        });
        return out;
    }

    function _loadActiveStorms() {
        // Use the recent-storms endpoint so recently-dissipated TCs
        // (e.g. Sinlaku just after dissipation) remain visible on the
        // Hovmöllers — these storms are the whole point of the 60-day
        // lookback window. Falls back to active-storms if the new
        // endpoint isn't deployed yet (graceful pre-deploy).
        return _fetchJSON(API_BASE + '/ir-monitor/recent-storms?days=60')
            .then(function (data) {
                state.activeStorms = (data && data.storms) ? data.storms : [];
            })
            .catch(function (err) {
                console.warn('[subseasonal-rt] recent-storms failed:', err.message,
                             '— falling back to active-storms');
                return _fetchJSON(API_BASE + '/ir-monitor/active-storms')
                    .then(function (data) {
                        state.activeStorms = (data && data.storms) ? data.storms : [];
                    })
                    .catch(function (err2) {
                        console.warn('[subseasonal-rt] active-storms also failed:', err2.message);
                        state.activeStorms = [];
                    });
            });
    }

    /* ── Phase-evolution iframe-modal ──────────────────────────── */
    // Lazily-created overlay that embeds tc_climatology.html in
    // evoOnly mode (chrome stripped, modal auto-opened). Keeps the
    // user on the RT Monitor while delivering the full evolution
    // experience that lives on the climo page.
    function _ensureEvolutionModal() {
        var modal = document.getElementById('rt-evo-modal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'rt-evo-modal';
        modal.className = 'rt-evo-modal';
        modal.style.display = 'none';
        modal.innerHTML = '<div class="rt-evo-modal-content">'
            + '<button class="rt-evo-modal-close" type="button" '
            + 'aria-label="Close" title="Close (Esc)">×</button>'
            + '<iframe class="rt-evo-modal-iframe" '
            + 'title="Phase evolution" frameborder="0"></iframe>'
            + '</div>';
        document.body.appendChild(modal);
        modal.addEventListener('click', function (e) {
            if (e.target === modal) _closeEvolutionIframe();
        });
        modal.querySelector('.rt-evo-modal-close').addEventListener('click', _closeEvolutionIframe);
        // Esc-to-close
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && modal.style.display !== 'none') {
                _closeEvolutionIframe();
            }
        });
        return modal;
    }
    function _openEvolutionInIframe(mode) {
        var modal = _ensureEvolutionModal();
        var iframe = modal.querySelector('.rt-evo-modal-iframe');
        iframe.src = 'tc_climatology.html#sub=subseasonal&mode='
            + encodeURIComponent(mode) + '&evoOnly=1';
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }
    function _closeEvolutionIframe() {
        var modal = document.getElementById('rt-evo-modal');
        if (!modal) return;
        modal.style.display = 'none';
        // Drop the src so the next open re-fetches with a clean state
        // (avoids stale iframe layout when switching modes back to back).
        var iframe = modal.querySelector('.rt-evo-modal-iframe');
        if (iframe) iframe.src = 'about:blank';
        document.body.style.overflow = '';
        _ga('rt_sub_evo_close');
    }

    /* ── Genesis enhancement factors (per mode × basin × phase) ─── */
    // Precomputed offline by build_subseasonal_genesis_factors.py from
    // IBTrACS + subseasonal_phases.json. Tiny (~3 KB) so we just ship as
    // a static asset; refresh after each TC season.
    var GENESIS_FACTORS_URL = 'data/subseasonal_genesis_factors.json';
    var _genesisFactorsPromise = null;
    function _loadGenesisFactors() {
        if (state.genesisFactors) return Promise.resolve(state.genesisFactors);
        if (_genesisFactorsPromise) return _genesisFactorsPromise;
        _genesisFactorsPromise = _fetchJSON(GENESIS_FACTORS_URL + '?v=' + (window.__v || ''))
            .then(function (d) { state.genesisFactors = d; return d; })
            .catch(function (e) {
                console.warn('[subseasonal-rt] genesis factors fetch failed:', e.message);
                state.genesisFactors = null;
                return null;
            });
        return _genesisFactorsPromise;
    }

    // Format a per-basin enhancement value as a colored span.
    // ≥ 1.0 = enhanced (red, "warm/active"); < 1.0 = suppressed (blue,
    // "cool/inactive"). Simple threshold at 1.0 (the uniform-phase
    // expectation) so every value falls cleanly on one side instead of
    // requiring a "neutral" gray band that hides borderline modulation.
    function _formatGenesisBasin(basin, val) {
        if (val == null) return '';
        var klass = (val >= 1.0) ? 'sub-gen-up' : 'sub-gen-down';
        return '<span class="sub-gen-basin"><span class="' + klass
             + '">' + basin + ' ' + val.toFixed(2) + '×</span></span>';
    }

    // Populate the per-clock genesis-enhancement readout. Active phase
    // (amp ≥ 1) → "ATL 1.64× · EP 0.85× · WP 0.95×". Quiescent →
    // greyed "phase amp < 1 · no modulation" so the user sees the
    // affordance but knows it doesn't apply right now.
    function _renderGenesisIndicators() {
        if (!state.genesisFactors || !state.indices) return;
        var factors = state.genesisFactors.modes || {};
        // Three most-watched basins for compactness. Operational users
        // tracking other basins can read the value from a full dial
        // (Climatology page) — this is a one-line "is it favorable?" cue.
        var shownBasins = ['NA', 'EP', 'WP'];
        ['mjo', 'mjo_omi', 'bsiso1', 'bsiso2'].forEach(function (mode) {
            var el = document.querySelector(
                '.sub-clock-card[data-mode="' + mode + '"] [data-val="genesis"]');
            if (!el) return;
            var modeRec = state.indices.indices && state.indices.indices[mode];
            var modeFactors = factors[mode];
            if (!modeRec || !modeFactors) { el.innerHTML = ''; return; }
            // Today's active phase = last entry where amp ≥ 1.
            var phases = modeRec.phases || [];
            var amps   = modeRec.amplitudes || [];
            var i = phases.length - 1;
            var phase = phases[i], amp = amps[i];
            if (phase == null || amp == null || amp < 1.0) {
                el.innerHTML = '<span style="opacity:0.7;">phase amp &lt; 1 · '
                    + 'no modulation</span>';
                return;
            }
            var p = phase - 1;  // phases stored 1..8; arrays indexed 0..7
            var parts = shownBasins.map(function (b) {
                var eh = modeFactors.enhancement && modeFactors.enhancement[b];
                if (!eh) return '';
                var v = eh[p];
                if (v == null) return '';
                var label = (b === 'NA') ? 'ATL' : b;
                return _formatGenesisBasin(label, v);
            }).filter(Boolean);
            if (!parts.length) { el.innerHTML = ''; return; }
            el.innerHTML = parts.join(' <span style="opacity:0.45;">·</span> ');
        });
    }

    /* ── Phase clocks ──────────────────────────────────────────── */
    function _renderClocks() {
        if (!state.indices || !window.SubseasonalClock) return;
        ['mjo', 'mjo_omi', 'bsiso1', 'bsiso2'].forEach(function (mode) {
            var card = document.querySelector('.sub-clock-card[data-mode="' + mode + '"]');
            if (!card) return;
            var svg = card.querySelector('.sub-clock-svg');
            var modeRec = state.indices.indices && state.indices.indices[mode];
            if (!svg || !modeRec) return;
            window.SubseasonalClock.render({
                svg: svg,
                modeRec: modeRec,
                mode: mode,
                trailDays: TRAIL_DAYS,
                size: 140,
                labels: {
                    dateEl:   card.querySelector('[data-val="date"]'),
                    phaseEl:  card.querySelector('[data-val="phase"]'),
                    ampEl:    card.querySelector('[data-val="amp"]'),
                    statusEl: card.querySelector('[data-val="status"]'),
                },
            });
            // Save button — idempotent (only inject once per card).
            // Tap on mobile, click on desktop; stopPropagation so it
            // doesn't bubble to the card's "open evolution modal" handler.
            if (!card.querySelector('.sub-clock-save-btn')) {
                var sBtn = document.createElement('button');
                sBtn.type = 'button';
                sBtn.className = 'sub-clock-save-btn';
                sBtn.title = 'Save this phase diagram as PNG';
                sBtn.setAttribute('aria-label', 'Save phase diagram');
                sBtn.innerHTML = '⤓';
                sBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    _saveClockAsPNG(card, mode);
                });
                card.appendChild(sBtn);
            }
        });

        // Clicking any clock opens the full phase-evolution modal in
        // an iframe ON THIS PAGE — same modal users see on the climo
        // page (Wheeler-Hendon PC1/PC2 trajectory, lookback toggles,
        // historical-analog overlays) without forcing them to leave
        // the RT Monitor. The climo page hash router strips its chrome
        // when `evoOnly=1` is present and floats the modal alone.
        document.querySelectorAll('.sub-clock-card').forEach(function (card) {
            card.onclick = function () {
                var mode = card.getAttribute('data-mode');
                _ga('rt_sub_clock_click', { mode: mode });
                _openEvolutionInIframe(mode);
            };
        });
    }

    /* ── Per-clock PNG save ───────────────────────────────────────
       Composite: title bar (mode label + today's date) + rasterized
       SVG (the phase clock with trail) + readout (date / phase /
       amp / status / per-basin genesis modulation) + TC-ATLAS footer.
       For year-over-year overlays the user clicks through to the
       full evolution modal, where the PC chart's own save button
       captures the historical overlay. */
    function _saveClockAsPNG(card, mode) {
        if (!card) return;
        var svg = card.querySelector('.sub-clock-svg');
        if (!svg) return;
        _ga('rt_sub_save_png_clock', { mode: mode });

        var modeLabel = (card.querySelector('.sub-clock-mode') || {}).textContent || mode;
        var dateText   = (card.querySelector('[data-val="date"]')   || {}).textContent || '';
        var phaseText  = (card.querySelector('[data-val="phase"]')  || {}).textContent || '';
        var ampText    = (card.querySelector('[data-val="amp"]')    || {}).textContent || '';
        var statusText = (card.querySelector('[data-val="status"]') || {}).textContent || '';
        var genesisEl  = card.querySelector('[data-val="genesis"]');
        var genesisText = genesisEl ? (genesisEl.textContent || '').trim() : '';

        // Rasterize the SVG to a same-size canvas.  Inline the computed
        // background color of the card so the rendered PNG matches the
        // theme the user is viewing (dark vs light).
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var pageBg = isDark ? '#0f172a' : '#ffffff';
        var cardBg = isDark ? '#161b24' : '#ffffff';
        var textColor = isDark ? '#e2e8f0' : '#0f172a';
        var dimColor  = isDark ? '#94a3b8' : '#64748b';

        var SVG_PX = 140;                  // matches CSS .sub-clock-svg
        var SCALE  = 2;                    // 2× for crisp PNG
        var clone = svg.cloneNode(true);
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        clone.setAttribute('width',  String(SVG_PX));
        clone.setAttribute('height', String(SVG_PX));
        var serialized = new XMLSerializer().serializeToString(clone);
        var svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
        var svgUrl  = URL.createObjectURL(svgBlob);

        var img = new Image();
        img.onload = function () {
            // Layout (all values in CSS px, multiplied by SCALE on draw).
            var W = 360;
            var titleH = 44, padX = 18, padY = 14;
            var clockY = titleH + 6;
            var clockSize = SVG_PX;
            var clockX = (W - clockSize) / 2;
            var readoutY = clockY + clockSize + 10;
            var lineH = 18;
            // Always: mode title, date line, phase + amp, status.
            var lines = [
                'Date:  ' + dateText,
                'Phase: ' + phaseText + '   ·   Amp: ' + ampText,
                statusText || '',
            ];
            // Genesis modulation (3 basins) wraps fine on the wider card.
            if (genesisText) lines.push(genesisText);
            var bodyH = lines.length * lineH;
            var footerH = 32;
            var H = readoutY + bodyH + 14 + footerH;

            var canvas = document.createElement('canvas');
            canvas.width  = W * SCALE;
            canvas.height = H * SCALE;
            var ctx = canvas.getContext('2d');
            ctx.scale(SCALE, SCALE);

            // Background
            ctx.fillStyle = pageBg;
            ctx.fillRect(0, 0, W, H);
            // Card surface
            ctx.fillStyle = cardBg;
            ctx.fillRect(8, 8, W - 16, H - 16);

            // Title bar
            ctx.fillStyle = textColor;
            ctx.font = 'bold 15px "DM Sans", system-ui, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText(modeLabel + ' · Phase Clock', padX, titleH / 2 + 6);

            // Clock
            ctx.drawImage(img, clockX, clockY, clockSize, clockSize);

            // Readout
            ctx.font = '12px "DM Sans", system-ui, sans-serif';
            ctx.textBaseline = 'top';
            lines.forEach(function (txt, i) {
                if (!txt) return;
                ctx.fillStyle = (i === 2 || i === 3) ? dimColor : textColor;
                ctx.fillText(txt, padX, readoutY + i * lineH);
            });

            // Footer
            ctx.fillStyle = dimColor;
            ctx.font = '11px "DM Sans", system-ui, sans-serif';
            ctx.textBaseline = 'middle';
            var todayISO = new Date().toISOString().slice(0, 10);
            ctx.fillText('TC-ATLAS · ' + todayISO + ' · tcatlas.org',
                         padX, H - footerH / 2 - 4);

            canvas.toBlob(function (blob) {
                var u = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = u;
                a.download = 'tc-atlas-phaseclock-' + mode + '-' + todayISO + '.png';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(function () {
                    URL.revokeObjectURL(u);
                    URL.revokeObjectURL(svgUrl);
                }, 1000);
            }, 'image/png');
        };
        img.onerror = function () {
            URL.revokeObjectURL(svgUrl);
            console.error('[subseasonal-rt] clock SVG rasterization failed');
        };
        img.src = svgUrl;
    }

    /* ── Hovmöller stack ──────────────────────────────────────── */
    function _stackContainer() { return document.getElementById('sub-hov-stack'); }

    /* Normalize longitudes to the 0..360° convention so the Hovmöller is
       Indo-Pacific-centered (date line at the visual middle). NOAA OLR
       already arrives in 0..360, so usually this is a sort-only pass; if
       a slab ever shows up in −180..180 form we roll it forward. Pacific
       centering is what Schreck (NCICS), CPC, BoM, and Wheeler–Hendon all
       use — the MJO/Kelvin life cycle reads as one continuous east-bound
       sweep through the middle instead of being split across the seam. */
    function _normalizeLons(lons, valuesByTime) {
        var rolled = lons.slice();
        var minLon = Math.min.apply(null, rolled);
        // If min < 0 the slab is on −180..180 — shift to 0..360.
        if (minLon < 0) {
            for (var i = 0; i < rolled.length; i++) {
                if (rolled[i] < 0) rolled[i] += 360;
            }
        }
        var idx = rolled.map(function (_, i) { return i; });
        idx.sort(function (a, b) { return rolled[a] - rolled[b]; });
        var sortedLons = idx.map(function (i) { return rolled[i]; });
        var sortedValues = valuesByTime.map(function (row) {
            return idx.map(function (i) { return row[i]; });
        });
        return { lons: sortedLons, values: sortedValues };
    }

    function _renderHovmollers() {
        var container = _stackContainer();
        if (!container) return;

        // Clean prior render
        container.innerHTML = '';

        var theme = (window.TCATheme && window.TCATheme.current) || 'light';
        var isDark = theme === 'dark';
        var bg = isDark ? '#161b24' : '#ffffff';
        var fg = isDark ? '#cbd5e1' : '#0f172a';
        var axisGrid = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';

        if (state.viewMode === 'combined') {
            _renderCombinedHovmoller(container, bg, fg, axisGrid, isDark);
            _renderBasinStrip(container, bg, fg, COMBINED_HOV_MARGIN_LR);
            _renderActiveTCList();
            return;
        }

        BANDS.forEach(function (band, idx) {
            var panel = document.createElement('div');
            panel.className = 'sub-hov-panel';
            panel.id = 'sub-hov-panel-' + band.key;
            // Restore expanded state if user previously expanded this band
            if (state.expandedBands[band.key]) panel.classList.add('expanded');
            var titleDiv = document.createElement('div');
            titleDiv.className = 'sub-hov-panel-title';
            titleDiv.textContent = band.title;
            panel.appendChild(titleDiv);

            // Save-this-panel button (left of expand). Composites the
            // Plotly image with a title bar so the downloaded PNG is
            // self-labeled.
            var saveBtn = document.createElement('button');
            saveBtn.type = 'button';
            saveBtn.className = 'sub-hov-save-btn';
            saveBtn.title = 'Save this panel as PNG';
            saveBtn.setAttribute('aria-label', 'Save panel');
            saveBtn.innerHTML = '⤓';
            saveBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                _saveSinglePanel(panel, band.title);
            });
            panel.appendChild(saveBtn);

            // Expand/collapse button — lets users blow up a panel of
            // interest (e.g. the Kelvin band) so the time axis stretches
            // and individual wave packets are easier to read.
            var expandBtn = document.createElement('button');
            expandBtn.type = 'button';
            expandBtn.className = 'sub-hov-expand-btn';
            expandBtn.title = 'Expand / collapse this panel for a closer look';
            expandBtn.setAttribute('aria-label', 'Expand panel');
            expandBtn.innerHTML = state.expandedBands[band.key] ? '⤡' : '⤢';
            expandBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var isExpanded = panel.classList.toggle('expanded');
                state.expandedBands[band.key] = isExpanded;
                expandBtn.innerHTML = isExpanded ? '⤡' : '⤢';
                _ga('rt_sub_panel_expand', { band: band.key, expanded: isExpanded });
                // Plotly needs a resize cue after the height change so the
                // heatmap repaints into the new bounds rather than staying
                // cropped to the old 145px box.
                if (typeof Plotly !== 'undefined') {
                    setTimeout(function () { Plotly.Plots.resize(panel); }, 50);
                }
            });
            panel.appendChild(expandBtn);

            container.appendChild(panel);

            var slab = _activeSlab(band.key);
            var latBandKey = band.forcedLatBand || state.latBand;
            if (!slab || !slab.lat_bands || !slab.lat_bands[latBandKey]) {
                panel.innerHTML += '<div style="padding:24px;text-align:center;color:#94a3b8;font-size:0.75rem;">'
                    + 'No data for ' + band.title + '</div>';
                return;
            }
            var bandData = slab.lat_bands[latBandKey];
            var norm = _normalizeLons(slab.lons, bandData.values);
            var isLast = idx === BANDS.length - 1;

            // Heatmap: x=lon, y=time, z=value. Reverse y so newest is at
            // the bottom (Hovmöller convention).
            var trace = {
                type: 'heatmap',
                x: norm.lons,
                y: slab.times,
                z: norm.values,
                colorscale: [
                    // CPC-style BrBG: green = forced ascent / enhanced
                    // convection (negative OLR anomaly), brown = suppressed
                    // (positive). More intuitive than diverging red-blue,
                    // which conflicts with temperature / vorticity palettes
                    // used elsewhere on the site.
                    [0,     '#003c30'],    // strongly negative = enhanced convection (deep green)
                    [0.25,  '#01665e'],
                    [0.45,  '#80cdc1'],
                    [0.50,  isDark ? '#1e293b' : '#f5f5f5'],
                    [0.55,  '#dfc27d'],
                    [0.75,  '#8c510a'],
                    [1,     '#543005'],    // strongly positive = suppressed (deep brown)
                ],
                zmin: -band.vlim,
                zmax:  band.vlim,
                // Per-panel colorbar — each band has its own ± W/m² range
                // (raw anomaly ±40, MJO ±15, Kelvin ±22, ER ±15, MRG ±20,
                // TD ±7; see BANDS for derivation) so a shared bar wouldn't
                // work. Compact vertical
                // strip on the right; basin strip below carries matching
                // right-margin so the heatmap longitude axes still align.
                showscale: true,
                colorbar: {
                    x: 1.005,
                    xanchor: 'left',
                    y: 0.5,
                    yanchor: 'middle',
                    len: 0.92,
                    thickness: 8,
                    outlinewidth: 0,
                    tickvals: [-band.vlim, 0, band.vlim],
                    ticktext: ['−' + band.vlim, '0', '+' + band.vlim],
                    tickfont: { size: 8, color: fg, family: 'DM Sans, system-ui, sans-serif' },
                    title: { text: 'W/m²', side: 'top',
                             font: { size: 8, color: fg } },
                },
                hovertemplate:
                    'Lon %{x:.1f}°<br>Date %{y}<br>'
                    + band.title.split(' ')[0] + ' %{z:.1f} W/m²<extra></extra>',
            };

            var layout = {
                // Every panel reserves bottom margin for longitude ticks
                // — readers need to look up a TC's longitude on the panel
                // they're already looking at, not have to glance down to
                // the last one to read off the axis. Right margin makes
                // room for the per-panel vertical colorbar; basin strip
                // below uses the same r value to preserve x-axis alignment.
                margin: { l: STACKED_HOV_MARGIN_LR.l, r: STACKED_HOV_MARGIN_LR.r, t: 18, b: 22 },
                paper_bgcolor: bg,
                plot_bgcolor:  bg,
                font: { color: fg, size: 10, family: 'DM Sans, system-ui, sans-serif' },
                xaxis: {
                    range: [0, 360],
                    tickvals: [0, 60, 120, 180, 240, 300, 360],
                    ticktext: ['0°', '60°E', '120°E', '180°', '120°W', '60°W', '0°'],
                    showgrid: true, gridcolor: axisGrid, zeroline: false,
                    tickfont: { size: 9 },
                },
                yaxis: {
                    // Newest at BOTTOM — original Hovmöller (1949)
                    // convention, and puts "today" right next to the
                    // basin-reference map strip rendered below the
                    // stack. Eastward waves (Kelvin, MJO) tilt
                    // DOWN-AND-RIGHT (slope matches the visual sweep of
                    // a wave propagating eastward as time advances);
                    // westward (ER) tilt DOWN-AND-LEFT. Trades the
                    // CPC/Schreck "today at top" glance-first habit
                    // for tighter visual coupling between the most
                    // recent state and the geographic reference below.
                    autorange: 'reversed',
                    showgrid: false, zeroline: false,
                    tickfont: { size: 9 },
                    nticks: 7,
                },
                shapes: [],
                // Watermark is intentionally NOT baked into the live
                // layout — it would crowd the small panels. It is added
                // transiently by _renderPanelToImage at save time so
                // exported PNGs still carry attribution.
                annotations: [],
            };

            // Active-TC overlay traces: each storm's (time, lon) track
            // plotted as a curve over the Hovmöller. Lets users see at
            // a glance whether a storm rode a Kelvin / MJO envelope by
            // matching its curve slope to the wave packet slope behind
            // it. Color-coded by intensity at each fix.
            var overlayTraces = [];
            if (state.showTCOverlay && state.activeStorms.length) {
                state.activeStorms.forEach(function (s) {
                    var trackTraces = _buildTrackTraces(s, slab);
                    if (trackTraces) {
                        overlayTraces.push(trackTraces.line);
                        overlayTraces.push(trackTraces.markers);
                        overlayTraces.push(trackTraces.latest);
                    }
                });
            }

            if (state.showForecast) {
                var decor = _forecastDecor(slab, fg);
                layout.shapes = decor.shapes;
                layout.annotations = decor.annotations;
            }

            var config = { displayModeBar: false, responsive: true };
            Plotly.newPlot(panel, [trace].concat(overlayTraces), layout, config);
        });

        _renderBasinStrip(container, bg, fg, STACKED_HOV_MARGIN_LR);
        _renderActiveTCList();
    }

    // -------------------------------------------------------------------
    // Combined view — raw OLR anomaly as the shaded base, with each
    // WK-filtered band overlaid as colored contours (Peyrille-style).
    // One tall figure replaces the six stacked panels. Legend entries
    // are clickable, so users can isolate any single overlay.
    // -------------------------------------------------------------------
    function _renderCombinedHovmoller(container, bg, fg, axisGrid, isDark) {
        var anomSlab = _activeSlab('anomaly');
        if (!anomSlab || !anomSlab.lat_bands || !anomSlab.lat_bands[state.latBand]) {
            container.innerHTML = '<div style="padding:24px;text-align:center;color:#94a3b8;font-size:0.85rem;">'
                + 'No OLR anomaly data available for the combined view.</div>';
            return;
        }

        var panel = document.createElement('div');
        panel.className = 'sub-hov-combined';
        panel.id = 'sub-hov-combined-panel';

        var saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'sub-hov-save-btn';
        saveBtn.title = 'Save the combined OLR + waves Hovmöller as PNG';
        saveBtn.setAttribute('aria-label', 'Save combined Hovmöller');
        saveBtn.innerHTML = '⤓';
        saveBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _saveSinglePanel(panel, 'Combined OLR + WK Waves');
        });
        panel.appendChild(saveBtn);

        container.appendChild(panel);

        var anomBand = anomSlab.lat_bands[state.latBand];
        var anomNorm = _normalizeLons(anomSlab.lons, anomBand.values);
        // Time-smooth the base so it shares a timescale with the
        // WK-filtered contour overlays. User-selectable: 1 (raw),
        // 3, or 5 days. Wave-band contours always use raw filtered
        // amplitudes, so the toggle is purely cosmetic for the base.
        var smoothDays = state.combinedSmoothDays || 1;
        var smoothHalf = Math.floor(smoothDays / 2);
        var anomSmoothZ = smoothHalf > 0
            ? _smoothInTime(anomNorm.values, smoothHalf)
            : anomNorm.values;
        var baseName = smoothDays > 1
            ? 'OLR anomaly (' + smoothDays + '-day mean)'
            : 'OLR anomaly (raw)';

        var baseTrace = {
            type: 'heatmap',
            name: baseName,
            x: anomNorm.lons,
            y: anomSlab.times,
            z: anomSmoothZ,
            colorscale: [
                [0,     '#003c30'], [0.25, '#01665e'], [0.45, '#80cdc1'],
                [0.50,  isDark ? '#1e293b' : '#f5f5f5'],
                [0.55,  '#dfc27d'], [0.75, '#8c510a'], [1, '#543005'],
            ],
            // Bumped from ±40 → ±60 W/m² so the brown/green saturation
            // at the extremes leaves visual headroom for the wave-band
            // contour lines to read against the base shading. Most
            // tropical OLR anomalies fall in ±30 W/m², so the ±60 scale
            // keeps the dynamic range comfortable without losing
            // contrast on the dominant signal.
            zmin: -60, zmax: 60,
            showscale: true,
            colorbar: {
                x: 1.005, xanchor: 'left', y: 0.5, yanchor: 'middle',
                len: 0.92, thickness: 8, outlinewidth: 0,
                tickvals: [-60, -30, 0, 30, 60],
                ticktext: ['−60', '−30', '0', '+30', '+60'],
                tickfont: { size: 9, color: fg, family: 'DM Sans, system-ui, sans-serif' },
                title: { text: 'OLR anom<br>(W/m²)', side: 'top',
                         font: { size: 8, color: fg } },
            },
            hoverlabel: { bgcolor: bg, font: { color: fg } },
            hovertemplate: 'Lon %{x:.1f}°<br>Date %{y}<br>OLR anomaly %{z:.1f} W/m²<extra></extra>',
            showlegend: false,
        };

        // Build a contour trace per wave band. Negative levels = enhanced
        // convection (drawn solid); positive = suppressed (drawn dashed),
        // matching the operational convention for OLR-anomaly waves.
        var overlayTraces = [];
        COMBINED_OVERLAYS.forEach(function (ov) {
            var slab = _activeSlab(ov.key);
            if (!slab || !slab.lat_bands) return;
            var bandSpec = BANDS.find(function (b) { return b.key === ov.key; });
            var latBandKey = (bandSpec && bandSpec.forcedLatBand) || state.latBand;
            var lb = slab.lat_bands[latBandKey];
            if (!lb) return;
            var norm = _normalizeLons(slab.lons, lb.values);

            // Plotly contour `contours.start/end/size` only supports a
            // uniform spacing — for our 3-level scheme we emit one
            // contour trace per signed pair so each can carry its own
            // dash style. Negative = solid (enhanced convection),
            // positive = dashed (suppressed).
            // Legend label includes the actual contour magnitudes and
            // their units so the reader sees what amplitude each band's
            // lines correspond to without an extra colorbar. Off-equator
            // bands carry a `(5-15°N)` lat-band note.
            var legendName = ov.label + ' ±' + ov.levels.join(', ±')
                + ' W/m²' + (ov.latNote ? ' (' + ov.latNote + ')' : '');
            var initialVisibility = ov.defaultVisible === false ? 'legendonly' : true;
            ov.levels.forEach(function (lev, levIdx) {
                [-lev, +lev].forEach(function (signedLev) {
                    overlayTraces.push({
                        type: 'contour',
                        name: legendName,
                        legendgroup: 'ov-' + ov.key,
                        showlegend: levIdx === 0 && signedLev < 0,
                        visible: initialVisibility,
                        x: norm.lons,
                        y: slab.times,
                        z: norm.values,
                        // Uniform single-color colorscale: with
                        // contours.coloring='lines', the line color
                        // tracks the colorscale rather than line.color,
                        // so this is how we paint each band in its own
                        // color.
                        colorscale: [[0, ov.color], [1, ov.color]],
                        autocolorscale: false,
                        contours: {
                            coloring: 'lines',
                            start: signedLev, end: signedLev,
                            size: 1,
                            showlabels: false,
                        },
                        line: {
                            // Thicker than the original (1.6 + 0.8·idx)
                            // so the wave-band contour lines read clearly
                            // against the OLR base shading. Inner level
                            // 2.6 px, outer 3.6 px — visible without
                            // dominating the figure.
                            color: ov.color,
                            width: 2.6 + 1.0 * levIdx,
                            dash: signedLev < 0 ? 'solid' : 'dot',
                            smoothing: 1.0,
                        },
                        // Hide the per-trace colorbar; only the OLR
                        // shading carries one.
                        showscale: false,
                        hoverinfo: 'skip',
                    });
                });
            });
        });

        var layout = {
            // Left margin needs room for the y-axis date labels at the
            // 1.8× scaled fonts used during PNG export. "Mar 22 2026"
            // wraps to two lines so the column needs to accommodate the
            // longer of those plus the "↓ Time" annotation that sits in
            // the same margin band.
            margin: { l: COMBINED_HOV_MARGIN_LR.l, r: COMBINED_HOV_MARGIN_LR.r, t: 38, b: 36 },
            paper_bgcolor: bg, plot_bgcolor: bg,
            font: { color: fg, size: 10, family: 'DM Sans, system-ui, sans-serif' },
            xaxis: {
                range: [0, 360],
                tickvals: [0, 60, 120, 180, 240, 300, 360],
                ticktext: ['0°', '60°E', '120°E', '180°', '120°W', '60°W', '0°'],
                showgrid: true, gridcolor: axisGrid, zeroline: false,
                tickfont: { size: 10 },
            },
            yaxis: {
                // Newest at BOTTOM — same convention as the stacked
                // view, putting "today" next to the basin reference
                // strip drawn underneath.
                autorange: 'reversed',
                showgrid: false, zeroline: false,
                tickfont: { size: 10 },
                nticks: 14,
            },
            shapes: [],
            // "↓ Time" indicator anchored above the y-axis date column,
            // telling the reader the temporal axis advances downward
            // (most recent at the bottom, adjacent to the basin map).
            annotations: [{
                xref: 'paper', yref: 'paper',
                x: 0, y: 1.005,
                xanchor: 'right', yanchor: 'bottom',
                text: '↓ Time',
                showarrow: false,
                font: { size: 10, color: fg,
                        family: 'DM Sans, system-ui, sans-serif' },
            }],
            legend: {
                orientation: 'h',
                x: 0, y: 1.04, xanchor: 'left', yanchor: 'bottom',
                font: { size: 10, color: fg },
                bgcolor: 'rgba(0,0,0,0)',
            },
        };

        // Active TC overlay tracks — same as stacked view; drawn on top.
        if (state.showTCOverlay && state.activeStorms.length) {
            state.activeStorms.forEach(function (s) {
                var tt = _buildTrackTraces(s, anomSlab);
                if (tt) {
                    overlayTraces.push(tt.line);
                    overlayTraces.push(tt.markers);
                    overlayTraces.push(tt.latest);
                }
            });
        }

        if (state.showForecast) {
            var decor = _forecastDecor(anomSlab, fg);
            layout.shapes = (layout.shapes || []).concat(decor.shapes);
            layout.annotations = (layout.annotations || []).concat(decor.annotations);
        }

        var config = { displayModeBar: false, responsive: true };
        Plotly.newPlot(panel, [baseTrace].concat(overlayTraces), layout, config);

        // Small caption directly below the combined panel hinting at
        // the legend-click affordance. Outside the Plotly figure (DOM
        // sibling, not an annotation), so it never appears in saved
        // PNGs — those are static and the hint would just be noise.
        var tip = document.createElement('div');
        tip.className = 'sub-hov-combined-tip';
        tip.innerHTML = 'Tip: click a band in the legend to toggle its '
            + 'contours on or off; double-click to isolate that band.';
        container.appendChild(tip);
    }

    /* Geographic context strip — pre-rendered tropical-band cartographic
       PNG (10°S-15°N, full longitude in Plate Carrée) as a background
       layer, with translucent basin-label callouts overlaid for
       at-a-glance context. Aligned to the same longitude axis as the
       Hovmöllers above via matching margin: { l: 60, r: 12 }. */
    function _renderBasinStrip(container, bg, fg, marginLR) {
        // Match the l/r of the Hovmöller this strip sits under so the two
        // longitude axes align pixel-for-pixel. Defaults to the stacked-view
        // margins when a caller doesn't specify (back-compat).
        var mL = (marginLR && marginLR.l != null) ? marginLR.l : STACKED_HOV_MARGIN_LR.l;
        var mR = (marginLR && marginLR.r != null) ? marginLR.r : STACKED_HOV_MARGIN_LR.r;
        var div = document.createElement('div');
        div.className = 'sub-hov-basin-strip';
        container.appendChild(div);

        var basins = [
            { name: 'Africa',     x0:   0, x1:  50 },
            { name: 'N Indian',   x0:  50, x1: 100 },
            { name: 'W Pacific',  x0: 100, x1: 180 },
            { name: 'E Pacific',  x0: 180, x1: 260 },
            { name: 'N Atlantic', x0: 260, x1: 360 },
        ];
        var annotations = basins.map(function (b) {
            return {
                xref: 'x', yref: 'paper',
                x: (b.x0 + b.x1) / 2, y: 0.92,
                text: '<b>' + b.name + '</b>', showarrow: false,
                font: { size: 10, color: fg, family: 'DM Sans, system-ui, sans-serif' },
                bgcolor: 'rgba(255,255,255,0.78)',
                bordercolor: 'rgba(0,0,0,0.10)', borderwidth: 0.5,
                borderpad: 2,
            };
        });
        // Plotly images use `sizing: stretch` to span the full lon range.
        // The PNG is in Plate Carrée at 10°S-15°N to match the typical
        // Kelvin/MJO Hovmöller equatorial band of interest.
        var images = [{
            source: 'data/tropical_basemap.png',
            xref: 'x', yref: 'paper',
            x: 0, y: 1,
            sizex: 360, sizey: 1,
            xanchor: 'left', yanchor: 'top',
            sizing: 'stretch', layer: 'below',
            opacity: 1,
        }];
        Plotly.newPlot(div, [{
            type: 'scatter', x: [0, 360], y: [0.5, 0.5],
            mode: 'markers', marker: { opacity: 0 }, hoverinfo: 'skip',
        }], {
            // Right margin matches the Hovmöller above (passed in per view)
            // so longitude axes align vertically across the stack.
            margin: { l: mL, r: mR, t: 0, b: 0 },
            paper_bgcolor: bg, plot_bgcolor: bg,
            xaxis: {
                range: [0, 360],
                showticklabels: false, showgrid: false, zeroline: false,
                fixedrange: true,
            },
            yaxis: {
                range: [0, 1], showticklabels: false, showgrid: false,
                zeroline: false, fixedrange: true,
            },
            images: images, annotations: annotations,
        }, { displayModeBar: false, responsive: true });
    }

    /* Build Plotly traces for a single storm's track on a Hovmöller.
       Returns three traces: a translucent line connecting fixes, a
       marker per fix (sized + colored by intensity), and a final dot
       at the latest fix with the storm name. Returns null when the
       storm has no track data in the slab's time window. */
    function _buildTrackTraces(storm, slab) {
        var track = storm.track;
        if (!track || track.length === 0) return null;
        // Build (lon, date) pairs from the storm's track.
        var slabDates = slab.times;
        var slabStartDay = slabDates[0];
        var slabEndDay   = slabDates[slabDates.length - 1];
        var xs = [], ys = [], vmaxs = [], times = [];
        for (var i = 0; i < track.length; i++) {
            var t = track[i];
            var dayKey = t.time.slice(0, 10);
            // Skip fixes outside the slab's time range
            if (dayKey < slabStartDay || dayKey > slabEndDay) continue;
            var lonNorm = t.lon;
            // Hovmöller x-axis runs 0..360° (Indo-Pacific-centered);
            // shift western-hemisphere storms (NHC convention reports
            // lon as negative) forward by 360°.
            if (lonNorm < 0) lonNorm += 360;
            xs.push(lonNorm);
            ys.push(dayKey);
            vmaxs.push(t.vmax_kt);
            times.push(t.time);
        }
        if (xs.length === 0) return null;
        var name = storm.name || storm.atcf_id;
        var ssColor = function (v) {
            if (v == null) return '#888';
            if (v < 34)  return '#5dadec';   // TD
            if (v < 64)  return '#06d6a0';   // TS
            if (v < 83)  return '#fbbf24';   // Cat 1
            if (v < 96)  return '#f97316';   // Cat 2
            if (v < 113) return '#ef4444';   // Cat 3
            if (v < 137) return '#c026d3';   // Cat 4
            return '#7c3aed';                // Cat 5
        };
        var colors = vmaxs.map(ssColor);
        var hover = xs.map(function (_, i) {
            return name + '<br>' + times[i] + '<br>lon ' + xs[i].toFixed(1) + '°'
                + (vmaxs[i] != null ? '<br>' + vmaxs[i] + ' kt' : '');
        });
        return {
            line: {
                type: 'scatter', mode: 'lines',
                x: xs, y: ys,
                line: { color: 'rgba(15,23,42,0.55)', width: 1.5 },
                showlegend: false, hoverinfo: 'skip',
            },
            markers: {
                type: 'scatter', mode: 'markers',
                x: xs, y: ys,
                marker: {
                    size: 6, color: colors,
                    line: { color: 'rgba(15,23,42,0.85)', width: 0.8 },
                },
                text: hover, hoverinfo: 'text',
                showlegend: false,
            },
            latest: {
                type: 'scatter', mode: 'markers+text',
                x: [xs[xs.length - 1]], y: [ys[ys.length - 1]],
                marker: { size: 12, color: colors[colors.length - 1],
                          line: { color: '#0f172a', width: 1.5 } },
                text: [name], textposition: 'top right',
                textfont: { size: 9, color: '#0f172a',
                            family: 'DM Sans, system-ui, sans-serif' },
                hoverinfo: 'skip',
                showlegend: false,
            },
        };
    }

    function _renderActiveTCList() {
        var box = document.getElementById('sub-active-tc-list');
        if (!box) return;
        if (!state.showTCOverlay || !state.activeStorms.length) {
            if (state.tcLoading) {
                box.innerHTML = '<div style="font-size:0.72rem;color:var(--text-dim,#64748b);">'
                    + '<em>Loading recent TC tracks (active + recently-dissipated)…</em></div>';
            } else {
                box.innerHTML = '';
            }
            return;
        }
        var active = state.activeStorms.filter(function (s) { return s.active; });
        var dissipated = state.activeStorms.filter(function (s) { return !s.active; });
        var parts = [
            '<div style="font-size:0.75rem;color:var(--text-dim,#64748b);margin-bottom:6px;">'
            + '<strong>TCs on Hovmöller (last 60 days)</strong> · '
            + active.length + ' active, ' + dissipated.length + ' recently-dissipated · '
            + 'colored by intensity</div>',
        ];
        var rows = state.activeStorms.slice(0, 14).map(function (s) {
            var name = s.name || s.atcf_id || '(unnamed)';
            var lon = s.lon != null ? s.lon : null;
            var lat = s.lat != null ? s.lat : null;
            var vmax = s.vmax_kt;
            if (lon == null) return '';
            var lonStr = (lon > 180 ? lon - 360 : lon).toFixed(1);
            var coordStr = lonStr + '°' + (lat != null ? (', ' + lat.toFixed(1) + '°') : '');
            var stateLabel = s.active ? 'Active' : 'Dissipated';
            var stateColor = s.active ? '#16a34a' : '#94a3b8';
            return '<div class="sub-active-tc-row">'
                + '<span class="sub-active-tc-name">' + name + '</span>'
                + '<span class="sub-active-tc-coord">' + coordStr + '</span>'
                + (vmax != null ? '<span class="sub-active-tc-note">' + Math.round(vmax) + ' kt</span>' : '')
                + '<span class="sub-active-tc-note" style="color:' + stateColor + ';">' + stateLabel + '</span>'
                + '</div>';
        });
        parts.push(rows.join(''));
        box.innerHTML = parts.join('');
    }

    /* ── Save PNG ─────────────────────────────────────────────── */
    // Shared composer used by both per-panel save and "Save All".
    // Each panel renders as: title bar → Plotly image → spacer.
    // Live view skips the watermark to avoid crowding the short panels;
    // we transiently relayout the panel to inject it before rasterizing
    // and then strip it back out so the on-page render is unchanged.
    function _renderPanelToImage(panel) {
        var rect = panel.getBoundingClientRect();
        var addWatermark = panel.id && (
            panel.id.indexOf('sub-hov-panel-') === 0 ||
            panel.id === 'sub-hov-combined-panel'
        );
        function exportImage() {
            return Plotly.toImage(panel, {
                format: 'png',
                width: Math.round(rect.width * 2),
                height: Math.round(rect.height * 2),
            });
        }
        // Match the 2× toImage raster exactly so in-figure text (axis
        // ticks, legend, colorbar) renders at the same proportional size
        // as on-screen. 1.8 used to leave Plotly text 10% small relative
        // to the canvas-drawn title bar / footer (which are hardcoded at
        // 2× sizes), producing visibly tiny axis labels in the saved PNG.
        var EXPORT_FONT_SCALE = 2.0;
        return _withScaledExportText(panel, EXPORT_FONT_SCALE, function () {
            // The watermark annotation is added *after* the font scale-up,
            // so it gets its own already-large size (set in
            // _watermarkAnnotation) rather than the layout default. Keep
            // any existing annotations the layout had at relayout-time
            // (the scaled-up "today" annotation, etc.).
            if (addWatermark && typeof Plotly.relayout === 'function') {
                var existing = (panel.layout && panel.layout.annotations) || [];
                return Plotly.relayout(panel, {
                    annotations: existing.concat([_watermarkAnnotation()]),
                }).then(function () { return exportImage(); })
                  .finally(function () {
                      // Strip just the watermark — the font-scale revert
                      // happens in the outer _withScaledExportText.
                      Plotly.relayout(panel, { annotations: existing }).catch(function () {});
                  });
            }
            return exportImage();
        }).then(function (url) {
            return new Promise(function (resolve, reject) {
                var img = new Image();
                img.onload = function () { resolve(img); };
                img.onerror = reject;
                img.src = url;
            });
        });
    }

    function _drawPanelTitleBar(ctx, x, y, width, title) {
        // The composite canvas matches the 2× toImage raster, so we draw
        // text at 2× CSS pixel sizes for an even visual weight against
        // the (also-2×) Plotly figure.
        var H = 56;
        ctx.fillStyle = '#f1f5f9';
        ctx.fillRect(x, y, width, H);
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 26px "DM Sans", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(title, x + 24, y + H / 2);
        return H;
    }

    function _slugifyFilenameFragment(s) {
        return (s || 'panel').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    // Temporarily switch a Hovmöller panel to its expanded (380px)
    // layout, let Plotly re-flow into the larger box, run `work`, and
    // revert. Used by the save paths so exported PNGs are rendered at
    // the larger inspect-mode height regardless of the panel's current
    // on-screen state. No-op if the panel is already expanded.
    function _withExpandedPanel(panel, work) {
        var isBandPanel = panel && panel.id && panel.id.indexOf('sub-hov-panel-') === 0;
        if (!isBandPanel || panel.classList.contains('expanded')
            || !(Plotly.Plots && Plotly.Plots.resize)) {
            return Promise.resolve().then(function () { return work(); });
        }
        panel.classList.add('expanded');
        return Plotly.Plots.resize(panel)
            .then(function () { return work(); })
            .finally(function () {
                panel.classList.remove('expanded');
                Plotly.Plots.resize(panel).catch(function () {});
            });
    }

    /** Save a single panel: title bar + Plotly image + basin reference strip + footer. */
    function _saveSinglePanel(panel, bandTitle) {
        if (!panel || typeof Plotly === 'undefined') return;
        _ga('rt_sub_save_png_panel', { band: bandTitle });
        var basinStrip = document.querySelector('.sub-hov-basin-strip');
        // Render the band panel (expanded + watermarked) and the basin
        // strip in parallel so per-panel PNGs carry the same geographic
        // reference that the stack-save composite already shows.
        var renderPanel = _withExpandedPanel(panel, function () {
            return _renderPanelToImage(panel);
        });
        var renderBasin = basinStrip
            ? _renderPanelToImage(basinStrip).catch(function () { return null; })
            : Promise.resolve(null);
        Promise.all([renderPanel, renderBasin]).then(function (results) {
            var img = results[0];
            var basinImg = results[1];
            var titleH = 56, footerH = 44;
            var basinTitleH = basinImg ? 36 : 0;
            var basinH = basinImg ? basinImg.height : 0;
            var canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = titleH + img.height + basinTitleH + basinH + footerH;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            _drawPanelTitleBar(ctx, 0, 0, canvas.width, bandTitle || 'Hovmöller');
            ctx.drawImage(img, 0, titleH);
            var y = titleH + img.height;
            if (basinImg) {
                // Slim caption strip above the basemap, matching the
                // stack-save composite for consistency. 2× text sizes
                // for parity with the 2× toImage raster.
                ctx.fillStyle = '#f8fafc';
                ctx.fillRect(0, y, canvas.width, basinTitleH);
                ctx.fillStyle = '#475569';
                ctx.font = '18px "DM Sans", system-ui, sans-serif';
                ctx.textBaseline = 'middle';
                ctx.fillText('Geographic reference — 10°S to 15°N',
                             24, y + basinTitleH / 2);
                y += basinTitleH;
                // Scale to match the panel width if the basin strip was
                // rendered at a different pixel width (different right
                // margin etc.). Aspect ratio preserved.
                if (basinImg.width !== canvas.width) {
                    var bH = Math.round(basinImg.height * canvas.width / basinImg.width);
                    ctx.drawImage(basinImg, 0, y, canvas.width, bH);
                    y += bH;
                } else {
                    ctx.drawImage(basinImg, 0, y);
                    y += basinImg.height;
                }
            }
            // Footer with attribution + date — 2× sizes for export parity.
            ctx.fillStyle = '#475569';
            ctx.font = '18px "DM Sans", system-ui, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText('TC-ATLAS · ' + new Date().toISOString().slice(0, 10) + ' UTC',
                         24, y + footerH / 2);
            canvas.toBlob(function (blob) {
                var u = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = u;
                a.download = 'tc-atlas-subseasonal-' + _slugifyFilenameFragment(bandTitle)
                    + '-' + new Date().toISOString().slice(0, 10) + '.png';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
            }, 'image/png');
        }).catch(function (err) {
            console.error('[subseasonal-rt] per-panel save failed:', err);
        });
    }

    /** Save the whole stack: header → (title + panel) × 5 + basin strip.
     *  In combined view, defers to the single-panel save path for the
     *  one combined Hovmöller so the user always gets a useful PNG. */
    function _saveStackAsPNG() {
        if (state.viewMode === 'combined') {
            var combined = document.getElementById('sub-hov-combined-panel');
            if (combined) _saveSinglePanel(combined, 'Combined OLR + WK Waves');
            return;
        }
        var panels = Array.from(document.querySelectorAll('.sub-hov-panel'));
        var basinStrip = document.querySelector('.sub-hov-basin-strip');
        if (!panels.length || typeof Plotly === 'undefined') return;
        var btn = document.getElementById('sub-save-png-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Rendering…'; }
        _ga('rt_sub_save_png');

        // Render each band panel in its expanded (380px) layout so the
        // stitched stack matches the inspect-mode view. Basin reference
        // strip stays at its native height (it's the geographic key, not
        // a wave panel).
        var renderPromises = panels.map(function (p) {
            return _withExpandedPanel(p, function () { return _renderPanelToImage(p); });
        });
        if (basinStrip) renderPromises.push(_renderPanelToImage(basinStrip));

        Promise.all(renderPromises)
            .then(function (imgs) {
                var width = Math.max.apply(null, imgs.map(function (i) { return i.width; }));
                // 2× text sizes for parity with the 2× toImage raster.
                var titleH = 56;       // per-panel title bar height
                var basinTitleH = 36;  // basemap caption strip height
                var headerH = 96;      // composite-level header height
                var totalHeight = headerH
                    + panels.length * titleH
                    + imgs.reduce(function (s, i) { return s + i.height; }, 0)
                    + basinTitleH;
                var canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = totalHeight;
                var ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                // Stack-level header
                ctx.fillStyle = '#0f172a';
                ctx.font = 'bold 36px "DM Sans", system-ui, sans-serif';
                ctx.textBaseline = 'alphabetic';
                ctx.fillText('Subseasonal State — Wheeler-Kiladis OLR Hovmöllers',
                             36, 48);
                ctx.font = '20px "DM Sans", system-ui, sans-serif';
                ctx.fillStyle = '#475569';
                ctx.fillText('TC-ATLAS · '
                             + new Date().toISOString().slice(0, 10) + ' UTC',
                             36, 80);
                // Each Hovmöller panel gets its own title strip
                var y = headerH;
                imgs.forEach(function (img, i) {
                    if (i < panels.length) {
                        _drawPanelTitleBar(ctx, 0, y, canvas.width,
                                           BANDS[i] ? BANDS[i].title : 'Hovmöller');
                        y += titleH;
                    } else {
                        ctx.fillStyle = '#f8fafc';
                        ctx.fillRect(0, y, canvas.width, basinTitleH);
                        ctx.fillStyle = '#475569';
                        ctx.font = '18px "DM Sans", system-ui, sans-serif';
                        ctx.textBaseline = 'middle';
                        ctx.fillText('Geographic reference — 10°S to 15°N',
                                     24, y + basinTitleH / 2);
                        y += basinTitleH;
                    }
                    ctx.drawImage(img, 0, y);
                    y += img.height;
                });
                canvas.toBlob(function (blob) {
                    var u = URL.createObjectURL(blob);
                    var a = document.createElement('a');
                    a.href = u;
                    a.download = 'tc-atlas-subseasonal-'
                        + new Date().toISOString().slice(0, 10) + '.png';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
                }, 'image/png');
            })
            .catch(function (err) {
                console.error('[subseasonal-rt] save PNG failed:', err);
            })
            .finally(function () {
                if (btn) { btn.disabled = false; btn.innerHTML = '⤓ Save PNG'; }
            });
    }

    /* ── Lat-band toggle ──────────────────────────────────────── */
    function _wireControls() {
        var saveBtn = document.getElementById('sub-save-png-btn');
        if (saveBtn && !saveBtn._wired) {
            saveBtn._wired = true;
            saveBtn.addEventListener('click', _saveStackAsPNG);
        }
        var toggle = document.getElementById('sub-latband-toggle');
        if (toggle && !toggle._wired) {
            toggle._wired = true;
            toggle.addEventListener('click', function (e) {
                var btn = e.target.closest('.sub-latband-btn');
                if (!btn) return;
                var band = btn.getAttribute('data-band');
                if (!band || band === state.latBand) return;
                state.latBand = band;
                toggle.querySelectorAll('.sub-latband-btn').forEach(function (b) {
                    b.classList.toggle('active', b === btn);
                });
                _ga('rt_sub_latband', { band: band });
                _renderHovmollers();
            });
        }
        var tcToggle = document.getElementById('sub-tc-overlay-toggle');
        if (tcToggle && !tcToggle._wired) {
            tcToggle._wired = true;
            tcToggle.addEventListener('change', function () {
                state.showTCOverlay = tcToggle.checked;
                _ga('rt_sub_tc_overlay', { on: state.showTCOverlay });
                _renderHovmollers();
            });
        }
        var fcstToggle = document.getElementById('sub-forecast-toggle');
        if (fcstToggle && !fcstToggle._wired) {
            fcstToggle._wired = true;
            fcstToggle.addEventListener('change', function () {
                state.showForecast = fcstToggle.checked;
                _ga('rt_sub_forecast', { on: state.showForecast });
                _renderHovmollers();
            });
        }
        _updateForecastToggleState();
        var viewToggle = document.getElementById('sub-view-toggle');
        if (viewToggle && !viewToggle._wired) {
            viewToggle._wired = true;
            // Sync the active-button class from state on first wire-up so
            // the markup's default-active button doesn't override the
            // persisted choice loaded from localStorage.
            viewToggle.querySelectorAll('.sub-view-btn').forEach(function (b) {
                b.classList.toggle('active',
                    b.getAttribute('data-view') === state.viewMode);
            });
            viewToggle.addEventListener('click', function (e) {
                var btn = e.target.closest('.sub-view-btn');
                if (!btn) return;
                var view = btn.getAttribute('data-view');
                if (!view || view === state.viewMode) return;
                state.viewMode = view;
                _storeViewMode(view);
                viewToggle.querySelectorAll('.sub-view-btn').forEach(function (b) {
                    b.classList.toggle('active', b === btn);
                });
                _updateSmoothToggleVisibility();
                _ga('rt_sub_view_mode', { view: view });
                _renderHovmollers();
            });
        }
        var smoothToggle = document.getElementById('sub-smooth-toggle');
        if (smoothToggle && !smoothToggle._wired) {
            smoothToggle._wired = true;
            smoothToggle.addEventListener('click', function (e) {
                var btn = e.target.closest('.sub-view-btn');
                if (!btn) return;
                var days = parseInt(btn.getAttribute('data-smooth'), 10);
                if (!days || days === state.combinedSmoothDays) return;
                state.combinedSmoothDays = days;
                smoothToggle.querySelectorAll('.sub-view-btn').forEach(function (b) {
                    b.classList.toggle('active', b === btn);
                });
                _ga('rt_sub_combined_smooth', { days: days });
                if (state.viewMode === 'combined') _renderHovmollers();
            });
        }
        _updateSmoothToggleVisibility();
    }

    // The OLR-base smoothing toggle only affects the combined view, but
    // we keep it in the layout flow at all times so switching views
    // doesn't shuffle the rest of the controls bar to the right. In
    // stacked view we just dim + disable it via a `hidden-by-mode`
    // attribute that CSS hooks into.
    // Disable the GEFS forecast checkbox until at least one forecast slab
    // has loaded (older pipeline output, or a failed daily run, won't have
    // them). When disabled we also force the toggle off so a stale checked
    // state can't request data that isn't there.
    function _updateForecastToggleState() {
        var el = document.getElementById('sub-forecast-toggle');
        var lbl = document.getElementById('sub-forecast-label');
        if (!el) return;
        var avail = _forecastAvailable();
        el.disabled = !avail;
        // Reflect state in the checkbox WITHOUT clobbering state.showForecast.
        // This runs once before the forecast slabs load (avail=false) and
        // again after they arrive; zeroing state on the first pass would
        // permanently defeat the default-on intent. _activeSlab already falls
        // back to the obs slab when a forecast slab is missing, so a
        // "checked but not-yet-loaded" state can't request data that isn't
        // there. state.showForecast stays the single source of truth (the
        // markup's `checked` attr only governs the pre-JS paint).
        el.checked = avail && state.showForecast;
        if (lbl) {
            if (lbl.getAttribute('data-title-on') == null) {
                lbl.setAttribute('data-title-on', lbl.title || '');
            }
            lbl.style.opacity = avail ? '' : '0.45';
            lbl.title = avail
                ? lbl.getAttribute('data-title-on')
                : 'GEFS forecast extension not available yet for the latest run.';
        }
    }

    function _updateSmoothToggleVisibility() {
        var lbl = document.getElementById('sub-smooth-label');
        var tog = document.getElementById('sub-smooth-toggle');
        var dim = (state.viewMode !== 'combined');
        [lbl, tog].forEach(function (el) {
            if (!el) return;
            if (dim) el.setAttribute('hidden-by-mode', '');
            else el.removeAttribute('hidden-by-mode');
        });
    }

    /* ── Public entry point ───────────────────────────────────── */
    window.activateSubseasonalView = function () {
        _wireControls();
        if (state.initialized) {
            /* Re-render in case theme changed or storms refreshed since
               last activation. Cheap — just SVG + Plotly redraws. */
            _renderClocks();
            _renderGenesisIndicators();
            _renderHovmollers();
            return;
        }
        state.initialized = true;
        _ga('rt_sub_open');

        var loading = document.querySelector('#sub-hov-stack .sub-hov-loading');
        if (loading) loading.textContent = 'Loading subseasonal data…';

        // Genesis factors are static (~3 KB) so we kick the fetch off
        // in parallel with the larger Hovmöller load — by the time the
        // clocks paint, the genesis line is ready to populate.
        _loadGenesisFactors();

        // Phase 1: load indices + wave slabs in parallel. As soon as
        // these arrive (~1-2 s) the user sees the clocks + Hovmöllers,
        // without the overlay. Recent-storms fetch hits NHC + JTWC
        // deck files which can take 10+ s — we don't want it blocking
        // the operationally-useful wave view.
        Promise.all([_loadIndices(), _loadSlabs(), _loadGenesisFactors()])
            .then(function () {
                _updateForecastToggleState();
                _renderClocks();
                _renderGenesisIndicators();
                _renderHovmollers();
            })
            .catch(function (err) {
                console.error('[subseasonal-rt] phase-1 init failed:', err);
                var c = _stackContainer();
                if (c) c.innerHTML = '<div class="sub-hov-loading" style="color:#ef4444;">'
                    + 'Could not load subseasonal data. Check console for details.</div>';
            });

        // Phase 2: pull recent storms in the background and re-paint
        // the Hovmöllers (now including TC track overlays) once they
        // land. tcLoading=true so the active-TC list shows a status
        // pill even if Phase 1 finishes ahead of this fetch and would
        // otherwise blank the list.
        state.tcLoading = true;
        _loadActiveStorms().then(function () {
            state.tcLoading = false;
            // Slabs may not have arrived yet — only repaint if Phase 1
            // is done (panels exist). If Phase 1 finishes later it will
            // pick up state.activeStorms automatically.
            if (Object.keys(state.slabs).length) {
                _renderHovmollers();
            }
        });
    };

    /* React to theme flips while the tab is open */
    if (window.TCATheme && typeof window.TCATheme.onChange === 'function') {
        window.TCATheme.onChange(function () {
            if (state.initialized
                && document.getElementById('sub-main')
                && document.getElementById('sub-main').style.display !== 'none') {
                _renderHovmollers();
            }
        });
    }
})();
