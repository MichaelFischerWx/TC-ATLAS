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
    // forcedLatBand: pin a panel to a specific lat band regardless of
    // the user's toggle. Used for MRG / TD-type because they're
    // antisymmetric about the equator — averaging over a symmetric
    // band (10°S-10°N or 5°S-5°N) cancels the signal to zero by
    // construction. The northern lobe at 5°N-15°N is where the
    // antisymmetric variance lives.
    var BANDS = [
        { key: 'anomaly', title: 'OLR anomaly (raw)',             vlim: 40 },
        { key: 'mjo',     title: 'MJO band (30-96 d)',            vlim: 15 },
        { key: 'kelvin',  title: 'Kelvin (eastward, ~12-25 m/s)', vlim: 12 },
        { key: 'er',      title: 'Equatorial Rossby (westward, 9.7-72 d)', vlim: 8 },
        { key: 'mrg',     title: 'Mixed Rossby-Gravity (3-96 d, 5°N-15°N)', vlim: 6,
          forcedLatBand: 'boreal' },
        { key: 'td_type', title: 'TD-type disturbances (2.5-5 d, 5°N-15°N)', vlim: 5,
          forcedLatBand: 'boreal' },
    ];

    var TRAIL_DAYS = 15;

    var state = {
        initialized: false,
        indices: null,
        slabs: {},                  // { bandKey: payload }
        activeStorms: [],
        latBand: 'trop10',
        showTCOverlay: true,
        expandedBands: {},          // { bandKey: bool } — sticky per-tab session
        tcLoading: false,           // true while phase-2 recent-storms is in flight
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
            saveBtn.innerHTML = '💾';
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

            var slab = state.slabs[band.key];
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
                // Per-panel colorbar — each band has its own ± W/m² range
                // (raw anomaly ±40, MJO ±15, Kelvin ±12, ER ±8, MRG ±6,
                // TD ±5) so a shared bar wouldn't work. Compact vertical
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
                margin: { l: 60, r: 55, t: 18, b: 22 },
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
                    // Newest at top (operational convention — matches CPC,
                    // Schreck, ECMWF daily products). User glances at the
                    // page and sees today's wave state first. Original
                    // Hovmöller (1949) used time-downward; modern
                    // operational TC monitoring overwhelmingly inverts.
                    // Side effect: eastward waves (Kelvin, MJO) now tilt
                    // UP-AND-RIGHT instead of down-and-right; westward
                    // (ER) tilt UP-AND-LEFT.
                    autorange: true,
                    showgrid: false, zeroline: false,
                    tickfont: { size: 9 },
                    nticks: 7,
                },
                shapes: [],
                annotations: [{
                    // Subtle watermark so saved PNGs and screenshots
                    // carry attribution back to the source.
                    xref: 'paper', yref: 'paper',
                    x: 1, y: 0,
                    xanchor: 'right', yanchor: 'bottom',
                    text: 'TC-ATLAS',
                    showarrow: false,
                    font: { size: 8, color: 'rgba(15,23,42,0.32)',
                            family: 'DM Sans, system-ui, sans-serif' },
                    bgcolor: 'rgba(255,255,255,0.55)',
                    borderpad: 2,
                }],
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

            var config = { displayModeBar: false, responsive: true };
            Plotly.newPlot(panel, [trace].concat(overlayTraces), layout, config);
        });

        _renderBasinStrip(container, bg, fg);
        _renderActiveTCList();
    }

    /* Geographic context strip — pre-rendered tropical-band cartographic
       PNG (10°S-15°N, full longitude in Plate Carrée) as a background
       layer, with translucent basin-label callouts overlaid for
       at-a-glance context. Aligned to the same longitude axis as the
       Hovmöllers above via matching margin: { l: 60, r: 12 }. */
    function _renderBasinStrip(container, bg, fg) {
        var div = document.createElement('div');
        div.className = 'sub-hov-basin-strip';
        container.appendChild(div);

        var basins = [
            { name: 'E Pacific',  x0: -180, x1: -100 },
            { name: 'N Atlantic', x0: -100, x1:    0 },
            { name: 'Africa',     x0:    0, x1:   50 },
            { name: 'N Indian',   x0:   50, x1:  100 },
            { name: 'W Pacific',  x0:  100, x1:  180 },
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
            x: -180, y: 1,
            sizex: 360, sizey: 1,
            xanchor: 'left', yanchor: 'top',
            sizing: 'stretch', layer: 'below',
            opacity: 1,
        }];
        Plotly.newPlot(div, [{
            type: 'scatter', x: [-180, 180], y: [0.5, 0.5],
            mode: 'markers', marker: { opacity: 0 }, hoverinfo: 'skip',
        }], {
            // Right margin matches Hovmöller panels' colorbar reservation
            // so longitude axes align vertically across the stack.
            margin: { l: 60, r: 55, t: 0, b: 0 },
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
            if (lonNorm > 180) lonNorm -= 360;
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
    // TC-ATLAS watermark is baked into each Plotly layout already.
    function _renderPanelToImage(panel) {
        var rect = panel.getBoundingClientRect();
        return Plotly.toImage(panel, {
            format: 'png',
            width: Math.round(rect.width * 2),
            height: Math.round(rect.height * 2),
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
        // ~36 px tall title strip. Light background tint so the title
        // reads cleanly across light/dark Plotly panels.
        ctx.fillStyle = '#f1f5f9';
        ctx.fillRect(x, y, width, 36);
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 16px "DM Sans", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(title, x + 16, y + 18);
        return 36;
    }

    function _slugifyFilenameFragment(s) {
        return (s || 'panel').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    /** Save a single panel: title bar + Plotly image + footer. */
    function _saveSinglePanel(panel, bandTitle) {
        if (!panel || typeof Plotly === 'undefined') return;
        _ga('rt_sub_save_png_panel', { band: bandTitle });
        _renderPanelToImage(panel).then(function (img) {
            var titleH = 36, footerH = 28;
            var canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height + titleH + footerH;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            _drawPanelTitleBar(ctx, 0, 0, canvas.width, bandTitle || 'Hovmöller');
            ctx.drawImage(img, 0, titleH);
            // Footer with attribution + date
            ctx.fillStyle = '#475569';
            ctx.font = '11px "DM Sans", system-ui, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText('TC-ATLAS · ' + new Date().toISOString().slice(0, 10) + ' UTC',
                         16, titleH + img.height + footerH / 2);
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

    /** Save the whole stack: header → (title + panel) × 5 + basin strip. */
    function _saveStackAsPNG() {
        var panels = Array.from(document.querySelectorAll('.sub-hov-panel'));
        var basinStrip = document.querySelector('.sub-hov-basin-strip');
        if (!panels.length || typeof Plotly === 'undefined') return;
        var btn = document.getElementById('sub-save-png-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Rendering…'; }
        _ga('rt_sub_save_png');

        var renderPromises = panels.map(_renderPanelToImage);
        if (basinStrip) renderPromises.push(_renderPanelToImage(basinStrip));

        Promise.all(renderPromises)
            .then(function (imgs) {
                var width = Math.max.apply(null, imgs.map(function (i) { return i.width; }));
                var titleH = 36;
                var basinTitleH = 24;
                var headerH = 60;
                // Per-panel title bar above each Hovmöller (NOT the basin strip)
                var totalHeight = headerH
                    + panels.length * titleH
                    + imgs.reduce(function (s, i) { return s + i.height; }, 0)
                    + basinTitleH;     // small label above basemap strip
                var canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = totalHeight;
                var ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                // Stack-level header
                ctx.fillStyle = '#0f172a';
                ctx.font = 'bold 22px "DM Sans", system-ui, sans-serif';
                ctx.textBaseline = 'alphabetic';
                ctx.fillText('Subseasonal State — Wheeler-Kiladis OLR Hovmöllers',
                             24, 30);
                ctx.font = '13px "DM Sans", system-ui, sans-serif';
                ctx.fillStyle = '#475569';
                ctx.fillText('TC-ATLAS · '
                             + new Date().toISOString().slice(0, 10) + ' UTC',
                             24, 50);
                // Each Hovmöller panel gets its own title strip
                var y = headerH;
                imgs.forEach(function (img, i) {
                    if (i < panels.length) {
                        _drawPanelTitleBar(ctx, 0, y, canvas.width,
                                           BANDS[i] ? BANDS[i].title : 'Hovmöller');
                        y += titleH;
                    } else {
                        // Basin strip header
                        ctx.fillStyle = '#f8fafc';
                        ctx.fillRect(0, y, canvas.width, basinTitleH);
                        ctx.fillStyle = '#475569';
                        ctx.font = '11px "DM Sans", system-ui, sans-serif';
                        ctx.textBaseline = 'middle';
                        ctx.fillText('Geographic reference — 10°S to 15°N',
                                     16, y + basinTitleH / 2);
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
                if (btn) { btn.disabled = false; btn.innerHTML = '💾 Save PNG'; }
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

        // Phase 1: load indices + wave slabs in parallel. As soon as
        // these arrive (~1-2 s) the user sees the clocks + Hovmöllers,
        // without the overlay. Recent-storms fetch hits NHC + JTWC
        // deck files which can take 10+ s — we don't want it blocking
        // the operationally-useful wave view.
        Promise.all([_loadIndices(), _loadSlabs()])
            .then(function () {
                _renderClocks();
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
