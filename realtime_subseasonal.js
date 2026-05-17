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

    var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
    var GCS_BASE = 'https://storage.googleapis.com/tc-atlas-ir-cache/subseasonal';
    var INDICES_URL = GCS_BASE + '/indices/latest.json';
    var INDICES_FALLBACK = 'data/subseasonal_phases.json';

    // WaveSpec names must match build_subseasonal_overlays.py.
    var BANDS = [
        { key: 'anomaly', title: 'OLR anomaly (raw)',           vlim: 40, cmap: 'RdBu' },
        { key: 'mjo',     title: 'MJO band (30-96 d)',          vlim: 15, cmap: 'RdBu' },
        { key: 'kelvin',  title: 'Kelvin (eastward, ~12-25 m/s)', vlim: 12, cmap: 'RdBu' },
        { key: 'er',      title: 'Equatorial Rossby (westward)', vlim:  8, cmap: 'RdBu' },
        { key: 'mrg',     title: 'MRG / TD-type (3-8 d)',        vlim:  8, cmap: 'RdBu' },
    ];

    var TRAIL_DAYS = 15;

    var state = {
        initialized: false,
        indices: null,
        slabs: {},                  // { bandKey: payload }
        activeStorms: [],
        latBand: 'trop10',
        showTCOverlay: true,
    };

    function _ga(eventName, params) {
        try { if (typeof gtag === 'function') gtag('event', eventName, params || {}); } catch (e) {}
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
        var promises = BANDS.map(function (b) {
            var url = GCS_BASE + '/' + b.key + '/hovmoller.json';
            return _fetchJSON(url)
                .then(function (slab) { state.slabs[b.key] = slab; })
                .catch(function (err) {
                    console.warn('[subseasonal-rt] Hovmöller ' + b.key + ' failed:', err.message);
                    state.slabs[b.key] = null;
                });
        });
        return Promise.all(promises);
    }

    function _loadActiveStorms() {
        return _fetchJSON(API_BASE + '/ir-monitor/active-storms')
            .then(function (data) {
                state.activeStorms = (data && data.storms) ? data.storms : [];
            })
            .catch(function (err) {
                console.warn('[subseasonal-rt] active-storms failed:', err.message);
                state.activeStorms = [];
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
        });

        // Clicking any clock deep-links into the climo page's Subseasonal
        // subview (which carries the full Plotly Wheeler-Hendon trajectory
        // + composite browser). The climo page's hash router reads
        // `sub=subseasonal&mode=<mode>` and switches both the subview and
        // the active mode.
        document.querySelectorAll('.sub-clock-card').forEach(function (card) {
            card.onclick = function () {
                var mode = card.getAttribute('data-mode');
                _ga('rt_sub_clock_click', { mode: mode });
                window.open(
                    'tc_climatology.html#sub=subseasonal&mode=' + mode,
                    '_blank'
                );
            };
        });
    }

    /* ── Hovmöller stack ──────────────────────────────────────── */
    function _stackContainer() { return document.getElementById('sub-hov-stack'); }

    /* Wraps longitude values from 0..360 onto -180..180 if the slab
       arrived in 0..360 convention (NOAA OLR does). Returns reordered
       (lons, values) so the chart reads naturally west-to-east with
       Greenwich roughly in the middle of the right half. */
    function _normalizeLons(lons, valuesByTime) {
        var rolled = lons.slice();
        // If max > 180 we're on 0..360. Roll so values >180 become -ish.
        var maxLon = Math.max.apply(null, rolled);
        if (maxLon <= 180.1) return { lons: rolled, values: valuesByTime };
        for (var i = 0; i < rolled.length; i++) {
            if (rolled[i] > 180) rolled[i] -= 360;
        }
        // Sort lon ascending and reorder columns to match
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

        BANDS.forEach(function (band, idx) {
            var panel = document.createElement('div');
            panel.className = 'sub-hov-panel';
            panel.id = 'sub-hov-panel-' + band.key;
            var titleDiv = document.createElement('div');
            titleDiv.className = 'sub-hov-panel-title';
            titleDiv.textContent = band.title;
            panel.appendChild(titleDiv);
            container.appendChild(panel);

            var slab = state.slabs[band.key];
            if (!slab || !slab.lat_bands || !slab.lat_bands[state.latBand]) {
                panel.innerHTML += '<div style="padding:24px;text-align:center;color:#94a3b8;font-size:0.75rem;">'
                    + 'No data for ' + band.title + '</div>';
                return;
            }
            var bandData = slab.lat_bands[state.latBand];
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
                    [0,     '#053061'],    // strongly negative = enhanced convection
                    [0.25,  '#2166ac'],
                    [0.45,  '#92c5de'],
                    [0.50,  isDark ? '#1e293b' : '#f7f7f7'],
                    [0.55,  '#fddbc7'],
                    [0.75,  '#d6604d'],
                    [1,     '#67001f'],
                ],
                zmin: -band.vlim,
                zmax:  band.vlim,
                showscale: false,
                hovertemplate:
                    'Lon %{x:.1f}°<br>Date %{y}<br>'
                    + band.title.split(' ')[0] + ' %{z:.1f} W/m²<extra></extra>',
            };

            var layout = {
                // Every panel reserves bottom margin for longitude ticks
                // — readers need to look up a TC's longitude on the panel
                // they're already looking at, not have to glance down to
                // the last one to read off the axis.
                margin: { l: 60, r: 12, t: 18, b: 22 },
                paper_bgcolor: bg,
                plot_bgcolor:  bg,
                font: { color: fg, size: 10, family: 'DM Sans, system-ui, sans-serif' },
                xaxis: {
                    range: [-180, 180],
                    tickvals: [-180, -120, -60, 0, 60, 120, 180],
                    ticktext: ['180°', '120°W', '60°W', '0°', '60°E', '120°E', '180°'],
                    showgrid: true, gridcolor: axisGrid, zeroline: false,
                    tickfont: { size: 9 },
                },
                yaxis: {
                    autorange: 'reversed',     // oldest top → newest bottom
                    showgrid: false, zeroline: false,
                    tickfont: { size: 9 },
                    // Show every ~10th day to keep readable
                    nticks: 7,
                },
                shapes: [],
                annotations: [],
            };

            // Active-TC overlay: vertical line at each storm's current lon
            if (state.showTCOverlay && state.activeStorms.length) {
                state.activeStorms.forEach(function (s) {
                    var lon = s.lon != null ? s.lon : (s.position && s.position.lon);
                    if (lon == null) return;
                    var lonNorm = lon;
                    if (lonNorm > 180) lonNorm -= 360;
                    layout.shapes.push({
                        type: 'line',
                        xref: 'x', yref: 'paper',
                        x0: lonNorm, x1: lonNorm,
                        y0: 0, y1: 1,
                        line: { color: '#ff9500', width: 1.5, dash: 'dot' },
                    });
                });
            }

            var config = { displayModeBar: false, responsive: true };
            Plotly.newPlot(panel, [trace], layout, config);
        });

        _renderBasinStrip(container, bg, fg);
        _renderActiveTCList();
    }

    /* Geographic context strip — colored bands per TC basin, aligned to
       the same longitude axis as the Hovmöllers above. Matches the
       panels' margin: { l: 60, r: 12 } exactly so the bands line up
       under the heatmap pixels they label. */
    function _renderBasinStrip(container, bg, fg) {
        var div = document.createElement('div');
        div.className = 'sub-hov-basin-strip';
        container.appendChild(div);

        var basins = [
            { name: 'E Pacific',  x0: -180, x1: -100, color: 'rgba(96,165,250,0.22)' },
            { name: 'N Atlantic', x0: -100, x1:    0, color: 'rgba(34,197,94,0.22)'  },
            { name: 'Africa',     x0:    0, x1:   50, color: 'rgba(245,158,11,0.22)' },
            { name: 'N Indian',   x0:   50, x1:  100, color: 'rgba(168,85,247,0.22)' },
            { name: 'W Pacific',  x0:  100, x1:  180, color: 'rgba(239,68,68,0.22)'  },
        ];
        var shapes = basins.map(function (b) {
            return {
                type: 'rect', xref: 'x', yref: 'paper',
                x0: b.x0, x1: b.x1, y0: 0, y1: 1,
                fillcolor: b.color, line: { width: 0 },
            };
        });
        var annotations = basins.map(function (b) {
            return {
                xref: 'x', yref: 'paper',
                x: (b.x0 + b.x1) / 2, y: 0.5,
                text: b.name, showarrow: false,
                font: { size: 11, color: fg, family: 'DM Sans, system-ui, sans-serif' },
            };
        });
        Plotly.newPlot(div, [{
            type: 'scatter', x: [-180, 180], y: [0.5, 0.5],
            mode: 'markers', marker: { opacity: 0 }, hoverinfo: 'skip',
        }], {
            margin: { l: 60, r: 12, t: 0, b: 0 },
            paper_bgcolor: bg, plot_bgcolor: bg,
            xaxis: {
                range: [-180, 180],
                showticklabels: false, showgrid: false, zeroline: false,
                fixedrange: true,
            },
            yaxis: {
                range: [0, 1], showticklabels: false, showgrid: false,
                zeroline: false, fixedrange: true,
            },
            shapes: shapes, annotations: annotations,
        }, { displayModeBar: false, responsive: true });
    }

    function _renderActiveTCList() {
        var box = document.getElementById('sub-active-tc-list');
        if (!box) return;
        if (!state.showTCOverlay || !state.activeStorms.length) {
            box.innerHTML = '';
            return;
        }
        var parts = [
            '<div style="font-size:0.75rem;color:var(--text-dim,#64748b);margin-bottom:6px;">'
            + '<strong>Active TCs on Hovmöller</strong> · vertical dotted line marks current longitude</div>',
        ];
        state.activeStorms.forEach(function (s) {
            var name = s.name || s.id || '(unnamed)';
            var lon = s.lon != null ? s.lon : (s.position && s.position.lon);
            var lat = s.lat != null ? s.lat : (s.position && s.position.lat);
            var vmax = s.vmax != null ? s.vmax : (s.intensity && s.intensity.vmax);
            if (lon == null) return;
            var lonStr = lon > 180 ? (lon - 360).toFixed(1) : lon.toFixed(1);
            var coordStr = lonStr + '°, ' + (lat != null ? lat.toFixed(1) + '°' : '—');
            parts.push(
                '<div class="sub-active-tc-row">'
                + '<span class="sub-active-tc-name">' + name + '</span>'
                + '<span class="sub-active-tc-coord">' + coordStr + '</span>'
                + (vmax != null ? '<span class="sub-active-tc-note">' + Math.round(vmax) + ' kt</span>' : '')
                + '</div>'
            );
        });
        box.innerHTML = parts.join('');
    }

    /* ── Lat-band toggle ──────────────────────────────────────── */
    function _wireControls() {
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
    }

    /* ── Public entry point ───────────────────────────────────── */
    window.activateSubseasonalView = function () {
        _wireControls();
        if (state.initialized) {
            /* Re-render in case theme changed or storms refreshed since
               last activation. Cheap — just SVG + Plotly redraws. */
            _renderClocks();
            _renderHovmollers();
            return;
        }
        state.initialized = true;
        _ga('rt_sub_open');

        var loading = document.querySelector('#sub-hov-stack .sub-hov-loading');
        if (loading) loading.textContent = 'Loading subseasonal data…';

        Promise.all([_loadIndices(), _loadSlabs(), _loadActiveStorms()])
            .then(function () {
                _renderClocks();
                _renderHovmollers();
            })
            .catch(function (err) {
                console.error('[subseasonal-rt] init failed:', err);
                var c = _stackContainer();
                if (c) c.innerHTML = '<div class="sub-hov-loading" style="color:#ef4444;">'
                    + 'Could not load subseasonal data. Check console for details.</div>';
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
