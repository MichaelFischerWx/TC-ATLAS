/* Real-Time Monitor — Seasonal tab.
 *
 * Pre-season and intra-season Atlantic SST + ACE diagnostics. Sources:
 *   - indices_monthly.json  : monthly region-mean SST (1982-present)
 *   - ace_annual.json       : annual NA basin ACE (1982-present)
 *   - latest.json           : pointer to today's anomaly PNG + indices
 *
 * Both files live in gs://tc-atlas-ir-cache/seasonal/ in production.
 * For local dev, we look in ./data/seasonal/ first.
 *
 * Phase 1 (this file): Panel C (the user's MDR×AMO scatter) is fully
 * interactive. Panels A/B/D/E/F render placeholders. Phase 2 fills the
 * rest in.
 */

(function () {
    'use strict';

    var GCS_BASE = 'https://storage.googleapis.com/tc-atlas-ir-cache/seasonal';
    var LOCAL_BASE = 'data/seasonal';

    // State, populated by the first activation
    var state = {
        indices: null,         // parsed indices_monthly.json
        ace: null,             // parsed ace_annual.json
        latest: null,          // parsed latest.json (may be null)
        activated: false,
        scatter: { x: 'atl_mdr', y: 'atl_amo', month: 5, variable: 'sst' },
        corr: { basin: 'NA', month: 5, kind: 'raw', overlayYear: '' },
        ts: { region: 'atl_mdr', variable: 'sst', history: 'all' },
        an: { year: null, month: 5, regions: 'all',
              method: 'grid_weighted', basin: 'NA', kind: 'raw' },
        idx: { window: '10' },
        anomZoom: 'global',
    };

    // Basin-zoom presets for Panel A. Each maps to a viewport in the
    // image's native lat/lon space (±60° × 100..360E). Values are
    // expressed as fractions [0..1] of the image dimensions:
    //   x_frac = (lon - 100) / 260, y_frac = (60 - lat) / 120
    var ANOM_ZOOMS = {
        global:   { x: 0,    y: 0,    w: 1,    h: 1    },
        atlantic: { x: 0.65, y: 0,    w: 0.35, h: 0.55 }, // lon 269-360, lat 6-60
        epac:     { x: 0.42, y: 0.04, w: 0.36, h: 0.50 }, // lon 209-302, lat 0-55
        wpac:     { x: 0.04, y: 0.04, w: 0.34, h: 0.50 }, // lon 109-197, lat 0-55
        enso:     { x: 0.20, y: 0.42, w: 0.55, h: 0.16 }, // lon 152-300, lat -10..10
    };

    function _applyAnomZoom() {
        var img = document.getElementById('seasonal-anom-img');
        var clip = document.getElementById('seasonal-anom-clip');
        if (!img || !clip) return;
        var z = ANOM_ZOOMS[state.anomZoom] || ANOM_ZOOMS.global;
        // The clip is the visible window; we scale the img so the
        // (z.x, z.y) corner aligns with (0,0) and the (z.w, z.h) box
        // fills the clip. img is `position: absolute` inside the clip.
        var scale = 1 / Math.min(z.w, z.h);
        // Calculate translate-to-fill: image natural size × clip size.
        // We use background-image-like positioning by setting img width
        // = clip width / z.w and height = clip height / z.h, then
        // translating left = -z.x * (clip_width / z.w) etc.
        img.style.position = 'absolute';
        img.style.left = (-z.x / z.w * 100) + '%';
        img.style.top = (-z.y / z.h * 100) + '%';
        img.style.width = (100 / z.w) + '%';
        img.style.height = (100 / z.h) + '%';
        img.style.maxWidth = 'none';
        img.style.maxHeight = 'none';
        img.style.objectFit = 'fill';
    }

    function _bindAnomZoomControl() {
        var sel = document.getElementById('seasonal-anom-zoom');
        if (!sel || sel._bound) return;
        sel._bound = true;
        sel.addEventListener('change', function () {
            state.anomZoom = sel.value;
            _applyAnomZoom();
        });
    }

    // Region lat/lon bounding boxes (mirrors the REGIONS dict in
    // build_oisst_history.py). Used by the Panel C inset map.
    // Format: [lat_s, lat_n, lon_w, lon_e], lon in 0..360.
    var REGION_BOX = {
        atl_basin:    [5.0,  30.0,  280.0, 350.0],
        atl_mdr:      [10.0, 20.0,  275.0, 340.0],
        atl_mdr_east: [10.0, 20.0,  320.0, 340.0],
        atl_amo:      [10.0, 50.0,  330.0, 340.0],
        caribbean:    [10.0, 22.0,  275.0, 300.0],
        gulf:         [20.0, 30.0,  262.0, 282.0],
        nta:          [5.0,  25.0,  305.0, 345.0],
        tsa:          [-20.0, 0.0,  330.0, 350.0],
        epac_mdr:     [10.0, 20.0,  230.0, 270.0],
        wpac_mdr:     [5.0,  20.0,  130.0, 170.0],
        nino12:       [-10.0, 0.0,  270.0, 280.0],
        nino3:        [-5.0,  5.0,  210.0, 270.0],
        nino34:       [-5.0,  5.0,  190.0, 240.0],
        nino4:        [-5.0,  5.0,  160.0, 210.0],
    };

    var REGION_SETS = {
        atlantic: ['atl_basin', 'atl_mdr', 'atl_mdr_east', 'atl_amo',
                   'caribbean', 'gulf', 'nta', 'tsa'],
        atlantic_enso: ['atl_basin', 'atl_mdr', 'atl_mdr_east', 'atl_amo',
                        'caribbean', 'gulf', 'nta', 'tsa',
                        'nino12', 'nino3', 'nino34', 'nino4'],
        all: ['atl_basin', 'atl_mdr', 'atl_mdr_east', 'atl_amo',
              'caribbean', 'gulf', 'nta', 'tsa',
              'epac_mdr', 'wpac_mdr',
              'nino12', 'nino3', 'nino34', 'nino4'],
    };

    // Sub-nav wiring: smooth-scroll to the target panel within the
    // seasonal-main scroll container (window scrolling is disabled by
    // .seasonal-main {position: fixed; overflow: auto}). Also highlights
    // the currently-visible section via IntersectionObserver.
    function _wireSubnav() {
        var nav = document.querySelector('.seasonal-subnav');
        var main = document.getElementById('seasonal-main');
        if (!nav || !main || nav._wired) return;
        nav._wired = true;

        var links = Array.from(nav.querySelectorAll('a'));
        links.forEach(function (a) {
            a.addEventListener('click', function (e) {
                e.preventDefault();
                var t = document.getElementById(a.dataset.target);
                if (!t) return;
                var navH = nav.getBoundingClientRect().height;
                var top = t.offsetTop - navH - 8;
                main.scrollTo({ top: top, behavior: 'smooth' });
            });
        });

        // Highlight whichever panel is closest to the top of the viewport.
        var byId = {};
        links.forEach(function (a) { byId[a.dataset.target] = a; });
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    links.forEach(function (a) { a.classList.remove('active'); });
                    var link = byId[entry.target.id];
                    if (link) link.classList.add('active');
                }
            });
        }, { root: main, rootMargin: '-80px 0px -70% 0px', threshold: 0 });
        links.forEach(function (a) {
            var t = document.getElementById(a.dataset.target);
            if (t) observer.observe(t);
        });
    }

    function _setStatus(msg, isError) {
        var el = document.getElementById('seasonal-status');
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('seasonal-status-error', !!isError);
    }

    function _fetchJSON(url) {
        return fetch(url, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + url);
            return r.json();
        });
    }

    // Local-first fetch with GCS fallback. The local-first pattern lets
    // the dev server (python3 -m http.server 8000) serve test data from
    // data/seasonal/ without having to upload to GCS during iteration.
    function _fetchData(name) {
        var v = window.__v || '';
        return _fetchJSON(LOCAL_BASE + '/' + name + v)
            .catch(function () {
                return _fetchJSON(GCS_BASE + '/' + name + v);
            });
    }

    // -------------------------------------------------------------------
    // Panel C — MDR × AMO scatter colored by annual ACE
    // -------------------------------------------------------------------

    function _buildScatterData() {
        if (!state.indices || !state.ace) return null;

        var idx = state.indices;
        var xKey = state.scatter.x + '_' + state.scatter.variable;
        var yKey = state.scatter.y + '_' + state.scatter.variable;
        var month = state.scatter.month;

        var xs = idx.values[xKey];
        var ys = idx.values[yKey];
        if (!xs || !ys) return null;

        var dates = idx.dates;
        var prelim = idx.preliminary || [];
        var nDays = idx.preliminary_n_days || [];
        var points = { year: [], x: [], y: [], ace: [], storms: [] };
        var currentYear = (new Date()).getUTCFullYear();
        var currentPt = null;
        var currentProj = null;

        // Mapping from base variable to its "projected" sibling. Anomaly
        // and detrended both have direct projected columns; for absolute
        // SST the column suffix differs slightly. If the value is null
        // (finalized rows have no projection), the projection is skipped.
        var projVar = (state.scatter.variable === 'sst')   ? '_sst_projected'
                    : (state.scatter.variable === 'anom')  ? '_anom_projected'
                    : '_sst_dt_projected';
        var projX = idx.values[state.scatter.x + projVar];
        var projY = idx.values[state.scatter.y + projVar];

        for (var i = 0; i < dates.length; i++) {
            var d = dates[i];
            var parts = d.split('-');
            var year = parseInt(parts[0], 10);
            var m = parseInt(parts[1], 10);
            if (m !== month) continue;
            if (xs[i] === null || ys[i] === null) continue;
            var aceRec = state.ace.years[year];
            var ace = aceRec ? aceRec.ace : null;
            var storms = aceRec ? aceRec.named_storms_contrib : null;
            if (year === currentYear) {
                currentPt = {
                    year: year, x: xs[i], y: ys[i], ace: ace, storms: storms,
                    preliminary: !!prelim[i],
                    n_days: nDays[i] || null,
                };
                // If the current-year point is preliminary and has a
                // projected sibling, capture it for a second marker.
                if (prelim[i] && projX && projY
                    && projX[i] !== null && projY[i] !== null) {
                    currentProj = {
                        year: year, x: projX[i], y: projY[i],
                        n_days: nDays[i] || null,
                    };
                }
                continue;
            }
            points.year.push(year);
            points.x.push(xs[i]);
            points.y.push(ys[i]);
            points.ace.push(ace);
            points.storms.push(storms);
        }
        return { points: points, current: currentPt, currentProj: currentProj,
                 xKey: xKey, yKey: yKey };
    }

    // TC-ATLAS brand palette (mirrors the variables in tc_radar_styles.css).
    // `text`/`textDim`/`grid` swap based on the active theme so axis labels
    // stay readable in both modes — see _refreshTheme() below.
    var BRAND = {
        orange: '#fb923c',
        orange_dim: 'rgba(251,146,60,0.18)',
        orange_line: 'rgba(251,146,60,0.95)',
        green: '#22c55e',
        green_dim: 'rgba(34,197,94,0.14)',
        green_line: 'rgba(34,197,94,0.85)',
        gray: 'rgba(140,148,160,0.18)',
        // Defaults reflect dark mode; replaced on activate + theme-change.
        text: '#e0e0e0',
        textDim: '#a0a8b3',
        grid: 'rgba(140,148,160,0.14)',
        gridZero: 'rgba(140,148,160,0.42)',
        plotBg: 'rgba(255,255,255,0.018)',
    };

    function _refreshTheme() {
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        if (isDark) {
            BRAND.text = '#e6edf5';
            BRAND.textDim = '#a0a8b3';
            BRAND.grid = 'rgba(140,148,160,0.14)';
            BRAND.gridZero = 'rgba(140,148,160,0.42)';
            BRAND.plotBg = 'rgba(255,255,255,0.018)';
        } else {
            // Light mode: axis labels need to be near-black, gridlines a bit
            // darker than dark-mode's so they're visible on white.
            BRAND.text = '#1a1f25';
            BRAND.textDim = '#475569';
            BRAND.grid = 'rgba(20,30,45,0.10)';
            BRAND.gridZero = 'rgba(20,30,45,0.35)';
            BRAND.plotBg = 'rgba(0,0,0,0.015)';
        }
    }

    // Re-render plots when the user toggles theme so the new colors apply.
    function _wireThemeReactivity() {
        if (window._seasonalThemeWired) return;
        window._seasonalThemeWired = true;
        var obs = new MutationObserver(function () {
            _refreshTheme();
            if (state.activated) {
                _renderScatter();   // triggers inset re-render too
                _renderTimeSeries();
                _renderIndices();
            }
        });
        obs.observe(document.documentElement, { attributes: true,
            attributeFilter: ['data-theme'] });
    }

    // Common watermark annotation appended to every Plotly figure so the
    // saved-as-PNG output carries attribution.
    function _watermarkAnnotations() {
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        var labelColor = isDark ? 'rgba(220,228,238,0.70)' : 'rgba(40,55,75,0.55)';
        var urlColor   = isDark ? 'rgba(220,228,238,0.45)' : 'rgba(40,55,75,0.42)';
        return [{
            xref: 'paper', yref: 'paper',
            x: 1, y: 1.02,
            xanchor: 'right', yanchor: 'bottom',
            text: 'TC-ATLAS',
            showarrow: false,
            font: { size: 9, color: labelColor,
                    family: 'DM Sans, system-ui, sans-serif' },
        }, {
            xref: 'paper', yref: 'paper',
            x: 1, y: -0.16,
            xanchor: 'right', yanchor: 'bottom',
            text: 'michaelfischerwx.github.io/TC-ATLAS',
            showarrow: false,
            font: { size: 8, color: urlColor,
                    family: 'DM Sans, system-ui, sans-serif' },
        }];
    }

    // Attach a small monochrome ⤓ button to a panel that triggers
    // Plotly's downloadImage on the named plot.
    function _addPlotSaveBtn(panelId, plotId, filenameBase) {
        var panel = document.getElementById(panelId);
        if (!panel || panel.querySelector('.seasonal-save-btn')) return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seasonal-save-btn';
        btn.title = 'Save panel as PNG';
        btn.setAttribute('aria-label', 'Save panel as PNG');
        btn.textContent = '⤓';
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var plot = document.getElementById(plotId);
            if (!plot || !window.Plotly) return;
            var now = new Date();
            var stamp = now.toISOString().slice(0, 16).replace(/[:T-]/g, '');
            window.Plotly.downloadImage(plot, {
                format: 'png',
                filename: 'TC-ATLAS_' + filenameBase + '_' + stamp,
                width: Math.max(plot.clientWidth, 1200),
                height: Math.max(plot.clientHeight, 600),
            });
        });
        panel.appendChild(btn);
    }

    var REGION_LABEL = {
        // Atlantic
        atl_basin: 'Atl. basin',
        atl_mdr: 'Atl. MDR',
        atl_mdr_east: 'Atl. East MDR',
        atl_amo: 'Atl. AMO box',
        caribbean: 'Caribbean',
        gulf: 'Gulf of Mexico',
        nta: 'N. Trop. Atlantic',
        tsa: 'S. Trop. Atlantic',
        // Pacific MDRs
        epac_mdr: 'EPac MDR',
        wpac_mdr: 'WPac MDR',
        // ENSO
        nino12: 'Niño 1+2',
        nino3: 'Niño 3',
        nino34: 'Niño 3.4',
        nino4: 'Niño 4',
    };
    var MONTH_LABEL = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function _axisTitle(key, region) {
        var label = REGION_LABEL[region] || region;
        var monLabel = MONTH_LABEL[state.scatter.month];
        if (key.endsWith('_anom')) return monLabel + ' ' + label + ' SST anomaly (°C)';
        if (key.endsWith('_sst_dt')) return monLabel + ' ' + label + ' SST detrended (°C)';
        return monLabel + ' ' + label + ' SST (°C)';
    }

    function _renderScatter() {
        var el = document.getElementById('seasonal-scatter-plot');
        if (!el) return;
        if (typeof Plotly === 'undefined') {
            el.innerHTML = '<div class="seasonal-panel-stub">Plotly not loaded.</div>';
            return;
        }
        var bundle = _buildScatterData();
        if (!bundle) {
            el.innerHTML = '<div class="seasonal-panel-stub">No data.</div>';
            return;
        }

        var hist = {
            type: 'scatter', mode: 'markers',
            x: bundle.points.x, y: bundle.points.y,
            customdata: bundle.points.year.map(function (y, i) {
                return [y, bundle.points.ace[i], bundle.points.storms[i]];
            }),
            marker: {
                size: 12,
                color: bundle.points.ace,
                colorscale: 'Jet',
                cmin: 0, cmax: 250,
                colorbar: {
                    title: { text: 'Annual ACE', side: 'right' },
                    thickness: 14, len: 0.85,
                },
                line: { color: 'rgba(20,20,20,0.6)', width: 1 },
            },
            hovertemplate:
                '<b>%{customdata[0]}</b><br>' +
                'X: %{x:.2f}<br>Y: %{y:.2f}<br>' +
                'Annual ACE: %{customdata[1]}<br>' +
                'Storms: %{customdata[2]}<extra></extra>',
            name: 'History',
        };
        var traces = [hist];

        if (bundle.current) {
            var cur = bundle.current;
            var showProj = !!bundle.currentProj;
            // Marker semantics:
            //   - Finalized current year: solid filled star (no preliminary).
            //   - Preliminary MTD: hollow star ("star-open") at the
            //     month-to-date mean — what's actually been measured.
            //   - Projected full month: solid star at the persistence-
            //     anomaly extrapolation, shown only when both differ in
            //     the chosen variable view (anomaly view collapses them
            //     onto the same point).
            traces.push({
                type: 'scatter', mode: 'markers',
                x: [cur.x], y: [cur.y],
                marker: {
                    symbol: cur.preliminary ? 'star-open' : 'star',
                    size: 22,
                    color: 'rgba(255,0,255,0.95)',
                    line: { color: '#000', width: 2 },
                },
                hovertemplate: cur.preliminary
                    ? '<b>' + cur.year + ' MTD</b> (' + (cur.n_days || '?') +
                      '-day month-to-date)<br>X: %{x:.2f}<br>Y: %{y:.2f}<extra></extra>'
                    : '<b>' + cur.year + '</b> (current)<br>' +
                      'X: %{x:.2f}<br>Y: %{y:.2f}<extra></extra>',
                showlegend: true,
                name: cur.preliminary
                    ? cur.year + ' month-to-date'
                    : String(cur.year),
            });
            if (showProj) {
                var p = bundle.currentProj;
                traces.push({
                    type: 'scatter', mode: 'markers',
                    x: [p.x], y: [p.y],
                    marker: {
                        symbol: 'star', size: 22,
                        color: 'rgba(255,0,255,0.95)',
                        line: { color: '#fff', width: 2 },
                    },
                    hovertemplate:
                        '<b>' + p.year + ' projected</b> (full-month, ' +
                        'persistence extrapolation from ' + (p.n_days || '?') +
                        '-day MTD)<br>X: %{x:.2f}<br>Y: %{y:.2f}<extra></extra>',
                    showlegend: true,
                    name: p.year + ' projected full-month',
                });
                // Connect MTD → projected with a thin dotted line so users
                // see at a glance how much extrapolation is happening.
                traces.push({
                    type: 'scatter', mode: 'lines',
                    x: [cur.x, p.x], y: [cur.y, p.y],
                    line: { color: 'rgba(255,0,255,0.55)', width: 1, dash: 'dot' },
                    hoverinfo: 'skip', showlegend: false,
                });
            }
        }

        var titleVar = (state.scatter.variable === 'anom') ? 'SST anomaly'
                     : (state.scatter.variable === 'sst_dt') ? 'detrended SST'
                     : 'SST';
        var titleX = REGION_LABEL[state.scatter.x] || state.scatter.x;
        var titleY = REGION_LABEL[state.scatter.y] || state.scatter.y;
        var layout = {
            title: {
                text: titleX + ' vs ' + titleY +
                      ' — Mean ' + MONTH_LABEL[state.scatter.month] + ' ' + titleVar +
                      ' (OISST; 1982-' + (new Date()).getUTCFullYear() + ')',
                font: { size: 14 },
            },
            xaxis: { title: _axisTitle(bundle.xKey, state.scatter.x), zeroline: false },
            yaxis: { title: _axisTitle(bundle.yKey, state.scatter.y), zeroline: false },
            margin: { l: 60, r: 10, t: 60, b: 70 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: BRAND.plotBg,
            font: { color: BRAND.text, family: 'DM Sans, system-ui, sans-serif',
                    size: 11 },
            showlegend: !!(bundle.current && bundle.current.preliminary),
            legend: {
                font: { size: 10 }, orientation: 'h',
                x: 0, y: 1.10, xanchor: 'left', yanchor: 'bottom',
                bgcolor: 'rgba(0,0,0,0)',
            },
            hovermode: 'closest',
            annotations: _watermarkAnnotations(),
        };
        // Suppress legend entries from the historical-cloud trace
        traces[0].showlegend = false;
        Plotly.react(el, traces, layout,
                     { responsive: true, displaylogo: false });
        _renderScatterInset();
    }

    // Renders a small Plotly geo inset for Panel C showing the X-axis
    // (orange) and Y-axis (green) region boxes on a world map. Plotly's
    // `scattergeo` projection handles coastlines + land shading natively
    // so the inset is self-contained — no external map data required.
    function _renderScatterInset() {
        var el = document.getElementById('seasonal-scatter-inset');
        if (!el || !window.Plotly) return;
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        // Plotly's scattergeo connects points along great-circle arcs by
        // default — a 4-corner rectangle therefore has its latitude
        // edges bow toward the equator (most visible on wide boxes like
        // Atl MDR, lon -85..-20). We side-step that by densifying each
        // latitude edge with many intermediate points at constant lat —
        // those points hug the parallel exactly. Meridian edges are
        // already great circles (they ARE meridians) so 2 points each
        // is enough.
        function boxTrace(boxArr, color, fillRGBA, label) {
            if (!boxArr) return null;
            var ls = boxArr[0], ln = boxArr[1], lw = boxArr[2], le = boxArr[3];
            // Convert 0-360 → -180..180. None of our regions cross the
            // antimeridian so a single closed polygon works.
            var conv = function (lo) { return lo > 180 ? lo - 360 : lo; };
            var lonW = conv(lw), lonE = conv(le);
            var lons = [], lats = [];
            // South edge: west → east at lat=ls (parallel, densified)
            var STEPS = 32;
            for (var i = 0; i <= STEPS; i++) {
                var f = i / STEPS;
                lons.push(lonW + f * (lonE - lonW));
                lats.push(ls);
            }
            // East edge: south → north at lon=le (meridian, straight)
            lons.push(lonE); lats.push(ln);
            // North edge: east → west at lat=ln (parallel, densified)
            for (var j = 1; j <= STEPS; j++) {
                var g = j / STEPS;
                lons.push(lonE - g * (lonE - lonW));
                lats.push(ln);
            }
            // West edge: north → south at lon=lw (meridian)
            lons.push(lonW); lats.push(ls);
            return {
                type: 'scattergeo', mode: 'lines',
                lon: lons, lat: lats,
                line: { color: color, width: 2 },
                fill: 'toself', fillcolor: fillRGBA,
                name: label, hoverinfo: 'skip',
            };
        }
        var xLabel = 'X · ' + (REGION_LABEL[state.scatter.x] || state.scatter.x);
        var yLabel = 'Y · ' + (REGION_LABEL[state.scatter.y] || state.scatter.y);
        var traces = [
            boxTrace(REGION_BOX[state.scatter.x], BRAND.orange,
                     'rgba(251,146,60,0.30)', xLabel),
            boxTrace(REGION_BOX[state.scatter.y], BRAND.green,
                     'rgba(34,197,94,0.30)', yLabel),
        ].filter(Boolean);
        var layout = {
            geo: {
                projection: { type: 'equirectangular' },
                showland: true,
                landcolor: isDark ? 'rgba(85,95,108,0.55)' : 'rgba(180,188,200,0.65)',
                showocean: true,
                oceancolor: isDark ? 'rgba(15,22,35,0.50)' : 'rgba(220,228,238,0.55)',
                showcountries: false,
                showcoastlines: true,
                coastlinecolor: isDark ? 'rgba(180,190,205,0.40)' : 'rgba(85,95,108,0.55)',
                coastlinewidth: 0.5,
                lonaxis: { showgrid: false, range: [-180, 180] },
                lataxis: { showgrid: false, range: [-65, 75] },
                bgcolor: 'rgba(0,0,0,0)',
                resolution: 110,
            },
            margin: { l: 0, r: 0, t: 0, b: 0 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            showlegend: false,
        };
        Plotly.react(el, traces, layout,
                     { responsive: true, displayModeBar: false, staticPlot: true });
    }

    // -------------------------------------------------------------------
    // Panel B — Region SST evolution time series
    // -------------------------------------------------------------------

    function _buildTimeSeriesData() {
        if (!state.indices) return null;
        var idx = state.indices;
        var key = state.ts.region + '_' + state.ts.variable;
        var vals = idx.values[key];
        if (!vals) return null;

        // Bucket monthly values by year (12 entries per year, NaN where missing).
        var byYear = {};
        var preliminaryByYear = {};
        for (var i = 0; i < idx.dates.length; i++) {
            var parts = idx.dates[i].split('-');
            var y = parseInt(parts[0], 10);
            var m = parseInt(parts[1], 10);
            if (!(y in byYear)) {
                byYear[y] = [null, null, null, null, null, null,
                             null, null, null, null, null, null];
                preliminaryByYear[y] = [false, false, false, false, false, false,
                                        false, false, false, false, false, false];
            }
            byYear[y][m - 1] = vals[i];
            preliminaryByYear[y][m - 1] = !!(idx.preliminary && idx.preliminary[i]);
        }

        // 1991-2020 climatology: per-month mean + std across years.
        var climStart = 1991, climEnd = 2020;
        var climMean = [0,0,0,0,0,0,0,0,0,0,0,0];
        var climStd  = [0,0,0,0,0,0,0,0,0,0,0,0];
        for (var mo = 0; mo < 12; mo++) {
            var arr = [];
            for (var yy = climStart; yy <= climEnd; yy++) {
                if (byYear[yy] && byYear[yy][mo] !== null
                    && !preliminaryByYear[yy][mo]) {
                    arr.push(byYear[yy][mo]);
                }
            }
            if (!arr.length) { climMean[mo] = null; climStd[mo] = null; continue; }
            var mean = arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
            var variance = arr.reduce(function (a, b) {
                return a + (b - mean) * (b - mean);
            }, 0) / arr.length;
            climMean[mo] = mean;
            climStd[mo] = Math.sqrt(variance);
        }

        var years = Object.keys(byYear).map(Number).sort(function (a, b) { return a - b; });
        return {
            byYear: byYear,
            preliminaryByYear: preliminaryByYear,
            years: years,
            climMean: climMean,
            climStd: climStd,
        };
    }

    function _renderTimeSeries() {
        var el = document.getElementById('seasonal-ts-plot');
        if (!el || typeof Plotly === 'undefined') return;
        var bundle = _buildTimeSeriesData();
        if (!bundle) {
            el.innerHTML = '<div class="seasonal-panel-stub">No data.</div>';
            return;
        }
        var months = [1,2,3,4,5,6,7,8,9,10,11,12];
        var monNames = ['Jan','Feb','Mar','Apr','May','Jun',
                        'Jul','Aug','Sep','Oct','Nov','Dec'];
        var traces = [];
        var currentYear = (new Date()).getUTCFullYear();

        // ±1σ envelope (upper + lower bound, soft green fill)
        var hasClim = bundle.climMean[0] !== null;
        if (hasClim) {
            var upper = bundle.climMean.map(function (m, i) {
                return m === null ? null : m + bundle.climStd[i];
            });
            var lower = bundle.climMean.map(function (m, i) {
                return m === null ? null : m - bundle.climStd[i];
            });
            traces.push({
                type: 'scatter', mode: 'lines', x: months, y: upper,
                line: { color: 'transparent', width: 0 },
                showlegend: false, hoverinfo: 'skip', name: '+1σ',
            });
            traces.push({
                type: 'scatter', mode: 'lines', x: months, y: lower,
                fill: 'tonexty', fillcolor: BRAND.green_dim,
                line: { color: 'transparent', width: 0 },
                showlegend: true, hoverinfo: 'skip',
                name: '1991-2020 ±1σ envelope',
            });
        }

        // Historical years (subtle gray, thin)
        var histYears = bundle.years.filter(function (y) {
            if (y === currentYear) return false;
            if (state.ts.history === 'none') return false;
            if (state.ts.history === 'recent10') return y >= currentYear - 10;
            return true;
        });
        histYears.forEach(function (y, idx) {
            traces.push({
                type: 'scatter', mode: 'lines', x: months, y: bundle.byYear[y],
                line: { color: BRAND.gray, width: 1 },
                showlegend: idx === 0,   // single legend entry for all hist
                legendgroup: 'history',
                name: 'historical years (1982-' + (currentYear - 1) + ')',
                hovertemplate: y + ' · %{x}: %{y:.2f}<extra></extra>',
            });
        });

        // Climatology mean — heavier solid line in brand green
        if (hasClim) {
            traces.push({
                type: 'scatter', mode: 'lines', x: months, y: bundle.climMean,
                line: { color: BRAND.green_line, width: 2.8 },
                name: '1991-2020 mean',
                hovertemplate: 'Climatology · %{x}: %{y:.2f}<extra></extra>',
            });
        }

        // Current year — bold brand orange line.
        if (bundle.byYear[currentYear]) {
            var cur = bundle.byYear[currentYear];
            var prelim = bundle.preliminaryByYear[currentYear];
            var prelimMonths = [], prelimVals = [];
            for (var k = 0; k < 12; k++) {
                if (prelim[k] && cur[k] !== null) {
                    prelimMonths.push(k + 1);
                    prelimVals.push(cur[k]);
                }
            }
            traces.push({
                type: 'scatter', mode: 'lines+markers',
                x: months, y: cur,
                line: { color: BRAND.orange_line, width: 3, shape: 'spline',
                        smoothing: 0.3 },
                marker: { size: 7, color: BRAND.orange,
                          line: { color: '#1a1f25', width: 1.2 } },
                name: String(currentYear) + ' (so far)',
                hovertemplate: currentYear + ' · %{x}: %{y:.2f}<extra></extra>',
            });
            if (prelimMonths.length) {
                traces.push({
                    type: 'scatter', mode: 'markers',
                    x: prelimMonths, y: prelimVals,
                    marker: {
                        symbol: 'star-open', size: 18,
                        color: BRAND.orange,
                        line: { color: BRAND.orange, width: 2.2 },
                    },
                    name: 'preliminary month-to-date',
                    hovertemplate: currentYear +
                        ' · %{x}: %{y:.2f} (preliminary)<extra></extra>',
                });
            }
        }

        var label = REGION_LABEL[state.ts.region] || state.ts.region;
        var varLabel = (state.ts.variable === 'anom') ? 'SST anomaly (°C)'
                     : (state.ts.variable === 'sst_dt') ? 'detrended SST (°C)'
                     : 'SST (°C)';
        var layout = {
            title: {
                text: label + ' — monthly ' + varLabel,
                font: { size: 15, family: 'DM Sans, system-ui, sans-serif',
                        weight: 600 },
                xanchor: 'left', x: 0.01,
            },
            xaxis: {
                title: { text: 'Month',
                         font: { size: 11, color: BRAND.textDim } },
                tickmode: 'array', tickvals: months,
                ticktext: monNames, zeroline: false,
                gridcolor: BRAND.grid,
                tickfont: { size: 11 },
            },
            yaxis: {
                title: { text: varLabel,
                         font: { size: 11, color: BRAND.textDim } },
                zeroline: state.ts.variable !== 'sst',
                zerolinecolor: BRAND.gridZero,
                gridcolor: BRAND.grid,
                tickfont: { size: 11 },
            },
            margin: { l: 64, r: 18, t: 52, b: 78 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: BRAND.plotBg,
            font: { color: BRAND.text, family: 'DM Sans, system-ui, sans-serif',
                    size: 11 },
            hovermode: 'closest',
            showlegend: true,
            legend: {
                font: { size: 10 }, orientation: 'h',
                yanchor: 'top', y: -0.18, x: 0, xanchor: 'left',
                bgcolor: 'rgba(0,0,0,0)',
            },
            annotations: _watermarkAnnotations(),
        };
        Plotly.react(el, traces, layout,
                     { responsive: true, displaylogo: false });
    }

    function _bindTimeSeriesControls() {
        var bind = function (id, key) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function () {
                state.ts[key] = el.value;
                _renderTimeSeries();
            });
        };
        bind('seasonal-ts-region', 'region');
        bind('seasonal-ts-var', 'variable');
        bind('seasonal-ts-history', 'history');
    }

    // -------------------------------------------------------------------
    // Panel E — Analog seasons by SST-anomaly distance
    // -------------------------------------------------------------------

    function _buildAnalogs() {
        if (!state.indices || !state.ace) return null;
        var idx = state.indices;
        var regions = REGION_SETS[state.an.regions] || REGION_SETS.all;
        var targetYear = state.an.year;
        var month = state.an.month;
        var kind = state.an.kind;        // 'raw' | 'detrended'
        var method = state.an.method;    // 'grid_weighted' | 'corr_weighted' | 'euclidean'
        var basin = state.an.basin;      // 'NA' | 'EP' | ...

        // --- Grid-weighted (default): use the precomputed n_year × n_year
        //     pairwise distance matrix from analog_distance_matrices.json.
        //     Each pixel's weight is sqrt(|r(SST_pixel, ACE_basin)|), so
        //     this is similarity in the actual spatial anomaly pattern
        //     restricted (by weight) to regions that historically matter
        //     for the basin's ACE. No region overlap problem.
        //     Caveat: only available for finalized years (matrix is
        //     precomputed); for the current preliminary year we fall
        //     back to the region-based correlation-weighted method.
        if (method === 'grid_weighted' && state.distance_matrices) {
            var dm = state.distance_matrices.basins[basin];
            var mEntry = dm && dm[String(month)];
            if (mEntry) {
                var idxOfYear = mEntry.years.indexOf(targetYear);
                if (idxOfYear < 0) {
                    return { years: mEntry.years, rows: [],
                             unavailableReason:
                                 'Target year ' + targetYear +
                                 ' has no finalized SST for ' + month +
                                 '; pick a finalized year (' +
                                 mEntry.years[0] + '-' +
                                 mEntry.years[mEntry.years.length - 1] +
                                 ') or switch to a region method.' };
                }
                var distRow = mEntry[kind][idxOfYear];
                var ranked = mEntry.years.map(function (y, i) {
                    return { year: y, dist: distRow[i] };
                }).filter(function (r) { return r.year !== targetYear; });
                ranked.sort(function (a, b) { return a.dist - b.dist; });
                return {
                    years: mEntry.years,
                    rows: ranked.slice(0, 10),
                    targetYear: targetYear,
                    method: 'grid_weighted',
                };
            }
            // Fall through to region method if matrix isn't loaded.
        }

        // For 'detrended' kind, use *_sst_dt for anomaly (year deviation
        // from the linear trend); for 'raw', use *_anom.
        var valSuffix = (kind === 'detrended') ? '_sst_dt' : '_anom';

        // Build per-year vector of (region values) for the chosen month.
        var availableYears = [];
        var vectors = {};
        var preliminaryFlag = {};
        for (var i = 0; i < idx.dates.length; i++) {
            var parts = idx.dates[i].split('-');
            var y = parseInt(parts[0], 10);
            var m = parseInt(parts[1], 10);
            if (m !== month) continue;
            var vec = [];
            var anyNull = false;
            for (var r = 0; r < regions.length; r++) {
                var v = idx.values[regions[r] + valSuffix][i];
                if (v === null || v === undefined) { anyNull = true; break; }
                vec.push(v);
            }
            if (anyNull) continue;
            availableYears.push(y);
            vectors[y] = vec;
            preliminaryFlag[y] = !!(idx.preliminary && idx.preliminary[i]);
        }
        if (!availableYears.includes(targetYear)) return { years: [], rows: [] };

        // Build per-region weights.
        // - Correlation-weighted: w_i = |r(SST_region_i, ACE_basin)| for the
        //   chosen basin × month × kind. Missing weights default to 0
        //   (region excluded).
        // - Euclidean: w_i = 1 / N for all regions (uniform).
        var weights = new Array(regions.length);
        if (method === 'corr_weighted' && state.region_corr) {
            var perRegion = (state.region_corr.basins[basin] || {})[String(month)] || {};
            var sumW = 0;
            for (var rr = 0; rr < regions.length; rr++) {
                var entry = perRegion[regions[rr]];
                var w = (entry && entry[kind] !== null && entry[kind] !== undefined)
                    ? Math.abs(entry[kind]) : 0;
                weights[rr] = w;
                sumW += w;
            }
            // Normalize so distance magnitudes are comparable across runs.
            if (sumW > 0) {
                for (var rr2 = 0; rr2 < regions.length; rr2++) weights[rr2] /= sumW;
            } else {
                for (var rr2 = 0; rr2 < regions.length; rr2++) weights[rr2] = 1 / regions.length;
            }
        } else {
            for (var rr3 = 0; rr3 < regions.length; rr3++) weights[rr3] = 1 / regions.length;
        }

        var target = vectors[targetYear];
        var ranked = [];
        for (var j = 0; j < availableYears.length; j++) {
            var yy = availableYears[j];
            if (yy === targetYear) continue;
            var sum2 = 0;
            for (var r = 0; r < regions.length; r++) {
                var diff = vectors[yy][r] - target[r];
                sum2 += weights[r] * diff * diff;
            }
            ranked.push({ year: yy, dist: Math.sqrt(sum2) });
        }
        ranked.sort(function (a, b) { return a.dist - b.dist; });
        return {
            years: availableYears,
            rows: ranked.slice(0, 10),
            targetYear: targetYear,
            targetPreliminary: preliminaryFlag[targetYear],
            weights: weights,
            regions: regions,
        };
    }

    function _renderAnalogs() {
        var tbody = document.getElementById('seasonal-an-tbody');
        var ace_th = document.getElementById('seasonal-an-ace-th');
        if (!tbody) return;
        var basin = state.an.basin;
        if (ace_th) ace_th.textContent = basin + ' ACE';

        // ACE source: for NA use the existing ace_annual.json (it ships
        // storm count too); for other basins use ace_basins_annual.json
        // and storms is unavailable.
        var aceLookup;
        if (basin === 'NA') {
            aceLookup = function (y) {
                var r = state.ace.years[y];
                return r ? { ace: r.ace, storms: r.named_storms_contrib } : null;
            };
        } else if (state.ace_basins) {
            var basinRec = state.ace_basins.basins[basin];
            aceLookup = function (y) {
                // JSON keys are strings; coerce.
                var v = basinRec && basinRec.years[String(y)];
                return (v !== undefined && v !== null)
                    ? { ace: v, storms: null } : null;
            };
        } else {
            aceLookup = function () { return null; };
        }

        var bundle = _buildAnalogs();
        if (!bundle || !bundle.rows.length) {
            var msg = (bundle && bundle.unavailableReason)
                ? bundle.unavailableReason
                : 'No analogs available for the selected target.';
            tbody.innerHTML =
                '<tr><td colspan="5" style="opacity:.6">' + msg + '</td></tr>';
            // Clear weights summary too
            var summary0 = document.getElementById('seasonal-an-weights-summary');
            if (summary0) summary0.innerHTML = '';
            return;
        }
        var html = '';
        bundle.rows.forEach(function (r, i) {
            var ace = aceLookup(r.year);
            var aceVal = ace ? ace.ace : null;
            var storms = ace ? ace.storms : null;
            // Basin-aware "active vs quiet" thresholds (NHC uses ACE>175 for
            // hyperactive Atlantic; other basins have different climatologies).
            var BASIN_HI = {NA: 175, EP: 200, WP: 280, NI: 60, SI: 130, SP: 130};
            var BASIN_LO = {NA: 60,  EP: 70,  WP: 175, NI: 15, SI: 60,  SP: 60};
            var aceCls = (aceVal === null) ? ''
                       : (aceVal >= (BASIN_HI[basin] || 175)) ? ' class="an-ace-hi"'
                       : (aceVal <= (BASIN_LO[basin] || 60)) ? ' class="an-ace-lo"' : '';
            html += '<tr>' +
                '<td>' + (i + 1) + '</td>' +
                '<td>' + r.year + '</td>' +
                '<td>' + r.dist.toFixed(3) + '</td>' +
                '<td' + aceCls + '>' + (aceVal !== null ? aceVal.toFixed(1) : '—') + '</td>' +
                '<td>' + (storms !== null && storms !== undefined ? storms : '—') + '</td>' +
                '</tr>';
        });
        tbody.innerHTML = html;

        // Update the "How analogs are computed" weights summary so the user
        // can see what regions/pixels are dominating the current ranking.
        var summary = document.getElementById('seasonal-an-weights-summary');
        if (summary) {
            if (state.an.method === 'grid_weighted') {
                summary.innerHTML =
                    '<strong>Pixel-weighted distance</strong> over the full ' +
                    '0.25° SST anomaly field. Each cell\'s weight = ' +
                    '|r(SST<sub>cell</sub>, ' + state.an.basin + ' ACE)| at ' +
                    'month ' + state.an.month + ' (' +
                    (state.an.kind === 'detrended' ? 'detrended' : 'raw') +
                    '). Land/NaN cells contribute zero.';
            } else if (bundle.weights) {
                var pairs = bundle.regions.map(function (r, idx) {
                    return { region: r, w: bundle.weights[idx] };
                }).filter(function (p) { return p.w > 0; });
                pairs.sort(function (a, b) { return b.w - a.w; });
                if (state.an.method === 'corr_weighted') {
                    var top = pairs.slice(0, 5).map(function (p) {
                        return (REGION_LABEL[p.region] || p.region) +
                            ' (' + (p.w * 100).toFixed(0) + '%)';
                    }).join(', ');
                    summary.innerHTML =
                        '<strong>Top regions (current weights):</strong> ' + top;
                } else {
                    summary.innerHTML =
                        '<strong>Uniform weights:</strong> ' +
                        (1 / bundle.regions.length * 100).toFixed(1) +
                        '% per region across ' + bundle.regions.length + ' regions.';
                }
            }
        }
    }

    function _populateAnalogYearSelector() {
        if (!state.indices) return;
        var sel = document.getElementById('seasonal-an-year');
        if (!sel || sel.options.length) return;
        var yearsSet = {};
        state.indices.dates.forEach(function (d) {
            yearsSet[parseInt(d.split('-')[0], 10)] = true;
        });
        var years = Object.keys(yearsSet).map(Number).sort(function (a, b) { return b - a; });
        var currentYear = (new Date()).getUTCFullYear();
        var hasCurrent = years.includes(currentYear);
        var defaultYear = hasCurrent ? currentYear : years[0];
        sel.innerHTML = years.map(function (y) {
            return '<option value="' + y + '"' +
                (y === defaultYear ? ' selected' : '') + '>' + y + '</option>';
        }).join('');
        state.an.year = defaultYear;
    }

    function _bindAnalogControls() {
        var bindNum = function (id, key) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function () {
                state.an[key] = parseInt(el.value, 10);
                _renderAnalogs();
            });
        };
        var bindStr = function (id, key) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function () {
                state.an[key] = el.value;
                _renderAnalogs();
            });
        };
        bindNum('seasonal-an-year', 'year');
        bindNum('seasonal-an-month', 'month');
        bindStr('seasonal-an-regions', 'regions');
        bindStr('seasonal-an-method', 'method');
        bindStr('seasonal-an-basin', 'basin');
        bindStr('seasonal-an-kind', 'kind');
    }

    // -------------------------------------------------------------------
    // Panel F — Climate-index dashboard (multi-trace time series)
    // -------------------------------------------------------------------

    function _renderIndices() {
        var el = document.getElementById('seasonal-idx-plot');
        if (!el || typeof Plotly === 'undefined' || !state.indices) return;
        var idx = state.indices;
        var dates = idx.dates;
        var nino34 = idx.values.nino34_anom;
        var amo = idx.values.atl_amo_anom;
        var nta = idx.values.nta_anom;
        var tsa = idx.values.tsa_anom;
        var prelim = idx.preliminary || [];

        // AMM proxy: NTA - TSA (Vimont/Kossin sign convention; positive
        // means warmer northern tropical Atlantic, favorable for
        // intensification + northward TC track displacement).
        var amm = nta.map(function (v, i) {
            if (v === null || tsa[i] === null) return null;
            return v - tsa[i];
        });

        // Window selector
        var window = state.idx.window;
        var iStart = 0;
        if (window !== 'all') {
            var nYears = parseInt(window, 10);
            var cutoff = (new Date()).getUTCFullYear() - nYears;
            for (var i = 0; i < dates.length; i++) {
                if (parseInt(dates[i].split('-')[0], 10) >= cutoff) { iStart = i; break; }
            }
        }

        var xs = dates.slice(iStart);
        var slice = function (arr) { return arr.slice(iStart); };
        // Convert YYYY-MM to YYYY-MM-15 so Plotly treats them as mid-month
        // points (cleaner alignment than YYYY-MM-01).
        var xPlot = xs.map(function (d) { return d + '-15'; });
        var prelimSlice = slice(prelim);

        // Mark preliminary points distinctly on each trace
        function styledTrace(name, color, ys, dashed) {
            var solidX = [], solidY = [], prelimX = [], prelimY = [];
            for (var i = 0; i < ys.length; i++) {
                if (prelimSlice[i]) { prelimX.push(xPlot[i]); prelimY.push(ys[i]); }
                else { solidX.push(xPlot[i]); solidY.push(ys[i]); }
            }
            var out = [{
                type: 'scatter', mode: 'lines+markers',
                x: solidX, y: solidY,
                line: { color: color, width: 2, dash: dashed ? 'dot' : 'solid' },
                marker: { size: 4, color: color },
                name: name,
                hovertemplate: name + ' · %{x|%Y-%m}: %{y:+.2f} °C<extra></extra>',
            }];
            if (prelimX.length) {
                out.push({
                    type: 'scatter', mode: 'markers',
                    x: prelimX, y: prelimY,
                    marker: {
                        symbol: 'star-open', size: 12,
                        color: color, line: { color: color, width: 2 },
                    },
                    name: name + ' (P)',
                    hovertemplate: name +
                        ' · %{x|%Y-%m}: %{y:+.2f} °C (preliminary)<extra></extra>',
                });
            }
            return out;
        }

        var traces = []
            .concat(styledTrace('Niño 3.4', '#e9554f', slice(nino34)))
            .concat(styledTrace('AMO box',  '#3a8dde', slice(amo)))
            .concat(styledTrace('AMM (NTA−TSA)', '#5db95d', amm.slice(iStart)));

        // ENSO threshold reference lines at ±0.5 °C
        var layout = {
            title: { text: 'Atlantic + Pacific climate indices', font: { size: 14 } },
            xaxis: { title: 'Date', zeroline: false },
            yaxis: { title: 'SST anomaly (°C)', zeroline: true,
                     zerolinecolor: BRAND.gridZero },
            margin: { l: 64, r: 18, t: 52, b: 80 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: BRAND.plotBg,
            font: { color: BRAND.text, family: 'DM Sans, system-ui, sans-serif',
                    size: 11 },
            hovermode: 'x unified',
            legend: { font: { size: 10 }, orientation: 'h',
                      yanchor: 'top', y: -0.18,
                      bgcolor: 'rgba(0,0,0,0)' },
            shapes: [
                {type: 'line', xref: 'paper', x0: 0, x1: 1,
                 yref: 'y', y0: 0.5, y1: 0.5,
                 line: {color: 'rgba(233,85,79,0.35)', width: 1, dash: 'dot'}},
                {type: 'line', xref: 'paper', x0: 0, x1: 1,
                 yref: 'y', y0: -0.5, y1: -0.5,
                 line: {color: 'rgba(80,140,210,0.35)', width: 1, dash: 'dot'}},
            ],
            annotations: _watermarkAnnotations(),
        };
        Plotly.react(el, traces, layout,
                     { responsive: true, displaylogo: false });
    }

    function _bindIndexControls() {
        var el = document.getElementById('seasonal-idx-window');
        if (!el) return;
        el.addEventListener('change', function () {
            state.idx.window = el.value;
            _renderIndices();
        });
    }

    // -------------------------------------------------------------------
    // Panel A — Live anomaly PNG (from latest.json)
    // -------------------------------------------------------------------

    function _renderAnomMap() {
        if (!state.latest) return;
        var img = document.getElementById('seasonal-anom-img');
        var cap = document.getElementById('seasonal-anom-caption');
        if (!img || !cap) return;
        var pngName = state.latest.anom_png;
        var url = LOCAL_BASE + '/' + pngName;
        img.src = url;
        img.onload = function () { _applyAnomZoom(); };
        img.onerror = function () {
            img.onerror = null;
            img.src = GCS_BASE + '/' + pngName;
        };
        _applyAnomZoom();
        cap.textContent = 'Valid ' + state.latest.valid_date +
            '  |  MDR anom ' + state.latest.indices.atl_mdr_anom.toFixed(2) + ' °C' +
            '  |  AMO anom ' + state.latest.indices.atl_amo_anom.toFixed(2) + ' °C' +
            '  |  Niño 3.4 anom ' + state.latest.indices.nino34_anom.toFixed(2) + ' °C';

        // Load hover sidecar (small JSON, 1° grid of anomaly °C). Fail
        // silently — without it, the map still renders, the tooltip just
        // doesn't appear.
        if (state.latest.anom_grid) {
            _fetchData(state.latest.anom_grid).then(function (g) {
                state.anom_grid = g;
                _wireAnomHover();
            }).catch(function () { state.anom_grid = null; });
        }
    }

    /* Generic map-hover wiring used by every panel that shows a 2D
     * geographic image with a lat/lon grid sidecar. `getGrid()` returns
     * the current grid (so panels with toggle-able maps can swap the
     * grid on selector change without re-binding listeners), and
     * `formatValue()` controls the readout (°C anomaly vs Pearson r etc).
     */
    function _wireMapHover(wrapId, imgId, tipId, getGrid, formatValue) {
        var wrap = document.getElementById(wrapId);
        var img = document.getElementById(imgId);
        var tip = document.getElementById(tipId);
        if (!wrap || !img || !tip) return;
        if (wrap._mapHoverBound) return;
        wrap._mapHoverBound = true;

        wrap.addEventListener('mousemove', function (e) {
            var g = getGrid();
            if (!g) { tip.classList.remove('visible'); return; }
            var r = img.getBoundingClientRect();
            var x = e.clientX - r.left;
            var y = e.clientY - r.top;
            if (x < 0 || y < 0 || x > r.width || y > r.height) {
                tip.classList.remove('visible'); return;
            }
            var lon = g.lon_min + (x / r.width) * (g.lon_max - g.lon_min);
            var lat = g.lat_max - (y / r.height) * (g.lat_max - g.lat_min);
            var i = Math.floor((lat - g.lat_min) / (g.lat_max - g.lat_min) * g.n_lat);
            var j = Math.floor((lon - g.lon_min) / (g.lon_max - g.lon_min) * g.n_lon);
            i = Math.max(0, Math.min(g.n_lat - 1, i));
            j = Math.max(0, Math.min(g.n_lon - 1, j));
            var v = g.values[i][j];
            var lonLabel = lon > 180 ? (360 - lon).toFixed(1) + '°W'
                                     : lon.toFixed(1) + '°E';
            var latLabel = (lat >= 0 ? lat.toFixed(1) + '°N'
                                     : (-lat).toFixed(1) + '°S');
            tip.textContent = latLabel + ', ' + lonLabel + '  |  ' + formatValue(v);
            var wr = wrap.getBoundingClientRect();
            tip.style.left = (e.clientX - wr.left) + 'px';
            tip.style.top = (e.clientY - wr.top) + 'px';
            tip.classList.add('visible');
        });
        wrap.addEventListener('mouseleave', function () {
            tip.classList.remove('visible');
        });
    }

    function _wireAnomHover() {
        _wireMapHover(
            'seasonal-anom-wrap', 'seasonal-anom-img', 'seasonal-anom-tooltip',
            function () { return state.anom_grid; },
            function (v) {
                return (v === null || v === undefined)
                    ? 'land / no data'
                    : (v >= 0 ? '+' : '') + v.toFixed(2) + ' °C anom';
            }
        );
    }

    // -------------------------------------------------------------------
    // Panel D — ACE × SST correlation map
    // -------------------------------------------------------------------

    function _renderCorrelation() {
        var img = document.getElementById('seasonal-corr-img');
        if (!img) return;
        var c = state.corr;
        var mm = (c.month < 10 ? '0' : '') + c.month;
        var stem = 'correlations/' + c.basin + '_' + mm + '_' + c.kind;
        var pngName = stem + '.png';
        var gridName = stem + '.grid.json';
        // Local-first, GCS fallback (same pattern as Panel A).
        img.src = LOCAL_BASE + '/' + pngName;
        img.onerror = function () {
            img.onerror = null;
            img.src = GCS_BASE + '/' + pngName;
        };
        img.alt = c.basin + ' ACE × SST correlation, month ' + c.month +
                  ', ' + c.kind;
        // Swap the hover grid; bound listener (see _wireCorrHover) reads
        // state.corr_grid each frame.
        state.corr_grid = null;
        _fetchData(gridName).then(function (g) { state.corr_grid = g; })
            .catch(function () { state.corr_grid = null; });
        _renderCorrOverlay();
    }

    // -------------------------------------------------------------------
    // Panel D — anomaly-contour overlay
    // -------------------------------------------------------------------

    // Style table for the six anomaly contour levels. To stay readable on
    // top of the BWR-shaded correlation field (which itself spans dark blue
    // → white → dark red), each contour is drawn as a thick stroke in a
    // contrasting color (black for warm, white for cool — but always with
    // a halo of the opposite color underneath, see _drawContoursOnSVG).
    var ANOM_CONTOUR_STYLE = {
        '-2.0': { color: '#000', halo: '#fff', width: 3.0 },
        '-1.0': { color: '#000', halo: '#fff', width: 2.4 },
        '-0.5': { color: '#000', halo: '#fff', width: 1.6, dash: '5 4' },
        '+0.5': { color: '#fff', halo: '#000', width: 1.6, dash: '5 4' },
        '+1.0': { color: '#fff', halo: '#000', width: 2.4 },
        '+2.0': { color: '#fff', halo: '#000', width: 3.0 },
    };

    function _renderCorrOverlay() {
        var svg = document.getElementById('seasonal-corr-overlay');
        var legend = document.getElementById('seasonal-corr-overlay-legend');
        if (!svg) return;
        // Reset
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        legend.classList.remove('visible');
        var y = state.corr.overlayYear;
        if (!y) return;

        var mm = (state.corr.month < 10 ? '0' : '') + state.corr.month;
        var name = 'anomaly_contours/' + y + '_' + mm + '.json';
        _fetchData(name).then(function (j) {
            _drawContoursOnSVG(j, svg);
            legend.innerHTML = _buildOverlayLegendHTML(y, state.corr.month);
            legend.classList.add('visible');
        }).catch(function () {
            // Missing month for the year (e.g., 2026-08 doesn't exist yet)
            legend.innerHTML = '<em>No anomaly data for ' + y + '-' + mm + '</em>';
            legend.classList.add('visible');
        });
    }

    function _drawContoursOnSVG(payload, svg) {
        if (!payload || !payload.paths) return;
        var extent = payload.extent || [100, 360, -60, 60];   // lon_min, lon_max, lat_min, lat_max
        // Use viewBox so paths are in (lat-lon) data space and scale to
        // fit the SVG box. preserveAspectRatio="none" lets the SVG
        // stretch to match the image edges.
        var lonMin = extent[0], lonMax = extent[1];
        var latMin = extent[2], latMax = extent[3];
        svg.setAttribute('viewBox',
            '0 0 ' + (lonMax - lonMin) + ' ' + (latMax - latMin));
        svg.setAttribute('preserveAspectRatio', 'none');
        var ns = 'http://www.w3.org/2000/svg';
        // Draw two passes: a halo pass (wider, opposite color) underneath
        // each contour, then the main stroke on top. This makes black
        // lines stand out from red shading and white lines stand out from
        // blue shading — the canonical met-map "highway" look.
        function _appendPath(d, color, width, dash, opacity) {
            var p = document.createElementNS(ns, 'path');
            p.setAttribute('d', d);
            p.setAttribute('fill', 'none');
            p.setAttribute('stroke', color);
            p.setAttribute('stroke-width', width / 30);   // viewBox is in deg
            p.setAttribute('stroke-linejoin', 'round');
            p.setAttribute('stroke-linecap', 'round');
            if (dash) p.setAttribute('stroke-dasharray',
                dash.split(' ').map(function (n) {
                    return (parseFloat(n) / 30).toFixed(2);
                }).join(' '));
            p.setAttribute('opacity', String(opacity));
            svg.appendChild(p);
        }
        for (var level in payload.paths) {
            var style = ANOM_CONTOUR_STYLE[level]
                || { color: '#000', halo: '#fff', width: 1.5 };
            payload.paths[level].forEach(function (path) {
                var d = '';
                for (var i = 0; i < path.length; i++) {
                    var lat = path[i][0], lon = path[i][1];
                    var x = lon - lonMin;
                    var y = latMax - lat;
                    d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2);
                }
                // Halo first (wider, lighter)
                _appendPath(d, style.halo, style.width + 1.6, style.dash, 0.75);
                // Main stroke on top
                _appendPath(d, style.color, style.width, style.dash, 1);
            });
        }
    }

    function _buildOverlayLegendHTML(year, month) {
        var monLabel = ['', 'Jan','Feb','Mar','Apr','May','Jun',
                        'Jul','Aug','Sep','Oct','Nov','Dec'][month];
        // Legend swatches use semantic red-warm / blue-cool so the sign is
        // readable independent of the on-map black/white halo styling.
        var SWATCH = {
            '-2.0': '#0a3a78', '-1.0': '#2d6db3', '-0.5': '#6da8e6',
            '+0.5': '#f4a582', '+1.0': '#c63832', '+2.0': '#7b0a18',
        };
        var rows = ['+2.0', '+1.0', '+0.5', '-0.5', '-1.0', '-2.0'].map(function (l) {
            return '<div><span class="legend-line" style="color:' + SWATCH[l] +
                '"></span>' + l + ' °C</div>';
        });
        return '<div style="font-weight:600;margin-bottom:2px">' +
            year + ' ' + monLabel + ' SST anom</div>' + rows.join('');
    }

    function _populateOverlayYears() {
        if (!state.indices) return;
        var sel = document.getElementById('seasonal-corr-overlay-year');
        if (!sel || sel.options.length) return;
        var yearsSet = {};
        state.indices.dates.forEach(function (d) {
            yearsSet[parseInt(d.split('-')[0], 10)] = true;
        });
        var years = Object.keys(yearsSet).map(Number).sort(function (a, b) { return b - a; });
        var opts = ['<option value="">— off —</option>'];
        years.forEach(function (y) { opts.push('<option value="' + y + '">' + y + '</option>'); });
        sel.innerHTML = opts.join('');
    }

    function _wireCorrHover() {
        _wireMapHover(
            'seasonal-corr-wrap', 'seasonal-corr-img', 'seasonal-corr-tooltip',
            function () { return state.corr_grid; },
            function (v) {
                return (v === null || v === undefined)
                    ? 'land / no data'
                    : 'r = ' + (v >= 0 ? '+' : '') + v.toFixed(2);
            }
        );
    }

    function _bindCorrelationControls() {
        var bind = function (id, key, parse) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function () {
                state.corr[key] = parse ? parse(el.value) : el.value;
                _renderCorrelation();
            });
        };
        bind('seasonal-corr-basin', 'basin');
        bind('seasonal-corr-month', 'month', function (v) { return parseInt(v, 10); });
        bind('seasonal-corr-kind', 'kind');
        // Overlay year: keep separate so we only redraw the SVG, not the
        // PNG (avoids re-fetching the correlation image).
        var oy = document.getElementById('seasonal-corr-overlay-year');
        if (oy) {
            oy.addEventListener('change', function () {
                state.corr.overlayYear = oy.value;
                _renderCorrOverlay();
            });
        }
    }

    // -------------------------------------------------------------------
    // Wiring
    // -------------------------------------------------------------------

    function _bindScatterControls() {
        var bind = function (id, key, parse) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function () {
                state.scatter[key] = parse ? parse(el.value) : el.value;
                _renderScatter();
            });
        };
        bind('seasonal-scatter-x', 'x');
        bind('seasonal-scatter-y', 'y');
        bind('seasonal-scatter-month', 'month', function (v) { return parseInt(v, 10); });
        bind('seasonal-scatter-var', 'variable');
    }

    function _activate() {
        if (state.activated) {
            // Re-render in case the user came back to it
            _renderScatter();
            _renderAnomMap();
            return;
        }
        state.activated = true;
        _refreshTheme();
        _wireThemeReactivity();
        _wireSubnav();
        _bindScatterControls();
        _bindCorrelationControls();
        _bindTimeSeriesControls();
        _bindAnalogControls();
        _bindIndexControls();
        _bindAnomZoomControl();
        _wireCorrHover();
        _renderCorrelation();
        _setStatus('Loading indices…');
        var p1 = _fetchData('indices_monthly.json').then(function (j) { state.indices = j; });
        var p2 = _fetchData('ace_annual.json').then(function (j) { state.ace = j; });
        var p3 = _fetchData('latest.json').then(
            function (j) { state.latest = j; },
            function () { state.latest = null; }   // optional
        );
        var p4 = _fetchData('region_ace_correlations.json').then(
            function (j) { state.region_corr = j; },
            function () { state.region_corr = null; }
        );
        var p5 = _fetchData('ace_basins_annual.json').then(
            function (j) { state.ace_basins = j; },
            function () { state.ace_basins = null; }
        );
        var p6 = _fetchData('analog_distance_matrices.json').then(
            function (j) { state.distance_matrices = j; },
            function () { state.distance_matrices = null; }
        );
        Promise.all([p1, p2, p3, p4, p5, p6]).then(function () {
            _setStatus('');
            _populateAnalogYearSelector();
            _populateOverlayYears();
            _renderScatter();
            _renderTimeSeries();
            _renderAnalogs();
            _renderIndices();
            _renderAnomMap();
            _addPlotSaveBtn('seasonal-panel-scatter', 'seasonal-scatter-plot',
                            'seasonal_scatter');
            _addPlotSaveBtn('seasonal-panel-timeseries', 'seasonal-ts-plot',
                            'seasonal_region_timeseries');
            _addPlotSaveBtn('seasonal-panel-indices', 'seasonal-idx-plot',
                            'seasonal_climate_indices');
        }).catch(function (e) {
            _setStatus('Failed to load seasonal data: ' + e.message, true);
        });
    }

    window.activateSeasonalView = _activate;
})();
