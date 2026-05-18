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
        corr: { basin: 'NA', month: 5, kind: 'raw' },
    };

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
        var points = { year: [], x: [], y: [], ace: [], storms: [] };
        var currentYear = (new Date()).getUTCFullYear();
        var currentPt = null;

        for (var i = 0; i < dates.length; i++) {
            var d = dates[i];
            var parts = d.split('-');
            var year = parseInt(parts[0], 10);
            var m = parseInt(parts[1], 10);
            if (m !== month) continue;
            var aceRec = state.ace.years[year];
            var ace = aceRec ? aceRec.ace : null;
            var storms = aceRec ? aceRec.named_storms_contrib : null;
            if (year === currentYear) {
                currentPt = { year: year, x: xs[i], y: ys[i], ace: ace, storms: storms };
                continue;
            }
            points.year.push(year);
            points.x.push(xs[i]);
            points.y.push(ys[i]);
            points.ace.push(ace);
            points.storms.push(storms);
        }
        return { points: points, current: currentPt, xKey: xKey, yKey: yKey };
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
            traces.push({
                type: 'scatter', mode: 'markers+text',
                x: [bundle.current.x], y: [bundle.current.y],
                marker: {
                    symbol: 'star', size: 22,
                    color: 'rgba(255,0,255,0.95)',
                    line: { color: '#000', width: 1.5 },
                },
                text: [String(bundle.current.year)],
                textposition: 'top right',
                textfont: { color: 'rgba(255,0,255,1)', size: 13, weight: 700 },
                hovertemplate:
                    '<b>' + bundle.current.year + '</b> (current)<br>' +
                    'X: %{x:.2f}<br>Y: %{y:.2f}<extra></extra>',
                name: String(bundle.current.year),
            });
        }

        var titleVar = (state.scatter.variable === 'anom') ? 'SST anomaly' : 'SST';
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
            margin: { l: 60, r: 10, t: 40, b: 50 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(255,255,255,0.02)',
            font: { color: '#e0e0e0', size: 11 },
            showlegend: false,
            hovermode: 'closest',
        };
        Plotly.react(el, traces, layout,
                     { responsive: true, displaylogo: false });
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
        img.onerror = function () {
            img.onerror = null;
            img.src = GCS_BASE + '/' + pngName;
        };
        cap.textContent = 'Valid ' + state.latest.valid_date +
            '  |  MDR anom ' + state.latest.indices.atl_mdr_anom.toFixed(2) + ' °C' +
            '  |  AMO anom ' + state.latest.indices.atl_amo_anom.toFixed(2) + ' °C' +
            '  |  Niño 3.4 anom ' + state.latest.indices.nino34_anom.toFixed(2) + ' °C';
    }

    // -------------------------------------------------------------------
    // Panel D — ACE × SST correlation map
    // -------------------------------------------------------------------

    function _renderCorrelation() {
        var img = document.getElementById('seasonal-corr-img');
        if (!img) return;
        var c = state.corr;
        var mm = (c.month < 10 ? '0' : '') + c.month;
        var name = 'correlations/' + c.basin + '_' + mm + '_' + c.kind + '.png';
        // Local-first, GCS fallback (same pattern as Panel A).
        img.src = LOCAL_BASE + '/' + name;
        img.onerror = function () {
            img.onerror = null;
            img.src = GCS_BASE + '/' + name;
        };
        img.alt = c.basin + ' ACE × SST correlation, month ' + c.month +
                  ', ' + c.kind;
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
        _bindScatterControls();
        _bindCorrelationControls();
        _renderCorrelation();
        _setStatus('Loading indices…');
        var p1 = _fetchData('indices_monthly.json').then(function (j) { state.indices = j; });
        var p2 = _fetchData('ace_annual.json').then(function (j) { state.ace = j; });
        var p3 = _fetchData('latest.json').then(
            function (j) { state.latest = j; },
            function () { state.latest = null; }   // optional
        );
        Promise.all([p1, p2, p3]).then(function () {
            _setStatus('');
            _renderScatter();
            _renderAnomMap();
        }).catch(function (e) {
            _setStatus('Failed to load seasonal data: ' + e.message, true);
        });
    }

    window.activateSeasonalView = _activate;
})();
