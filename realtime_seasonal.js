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
        ts: { region: 'atl_mdr', variable: 'sst', history: 'all' },
        an: { year: null, month: 5, regions: 'atlantic' },
        idx: { window: '10' },
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
            // Current-year star: filled when the monthly value is
            // finalized in NOAA's product, ring-only ("star-open") when
            // it's a partial month-to-date computed from the daily file.
            // The label appended a ' (preliminary, N-day mean)' tag so
            // users know they're looking at a preliminary value.
            var prelimTag = cur.preliminary
                ? ' (preliminary, ' + (cur.n_days || '?') + '-day mean)'
                : '';
            var prelimLabel = cur.preliminary ? '✦' : '';
            traces.push({
                type: 'scatter', mode: 'markers+text',
                x: [cur.x], y: [cur.y],
                marker: {
                    symbol: cur.preliminary ? 'star-open' : 'star',
                    size: 22,
                    color: 'rgba(255,0,255,0.95)',
                    line: { color: '#000', width: 2 },
                },
                text: [String(cur.year) + (cur.preliminary ? ' (P)' : '')],
                textposition: 'top right',
                textfont: { color: 'rgba(255,0,255,1)', size: 13, weight: 700 },
                hovertemplate:
                    '<b>' + cur.year + '</b> (current' + prelimTag + ')<br>' +
                    'X: %{x:.2f}<br>Y: %{y:.2f}<extra></extra>',
                name: String(cur.year),
            });
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

        // ±1σ envelope (upper + lower bound, fill between)
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
                line: { color: 'rgba(120,170,210,0)', width: 0 },
                showlegend: false, hoverinfo: 'skip', name: '+1σ',
            });
            traces.push({
                type: 'scatter', mode: 'lines', x: months, y: lower,
                fill: 'tonexty', fillcolor: 'rgba(120,170,210,0.18)',
                line: { color: 'rgba(120,170,210,0)', width: 0 },
                showlegend: false, hoverinfo: 'skip', name: '−1σ',
            });
        }

        // Historical years (gray, thin)
        var histYears = bundle.years.filter(function (y) {
            if (y === currentYear) return false;
            if (state.ts.history === 'none') return false;
            if (state.ts.history === 'recent10') return y >= currentYear - 10;
            return true;
        });
        histYears.forEach(function (y) {
            traces.push({
                type: 'scatter', mode: 'lines', x: months, y: bundle.byYear[y],
                line: { color: 'rgba(180,180,200,0.20)', width: 1 },
                showlegend: false,
                name: String(y),
                hovertemplate: y + ' · %{x}: %{y:.2f}<extra></extra>',
            });
        });

        // Climatology mean (heavier)
        if (hasClim) {
            traces.push({
                type: 'scatter', mode: 'lines', x: months, y: bundle.climMean,
                line: { color: 'rgba(80,170,230,0.95)', width: 2.5,
                        dash: 'solid' },
                name: '1991-2020 mean',
                hovertemplate: 'Climo · %{x}: %{y:.2f}<extra></extra>',
            });
        }

        // Current year — bold colored line, marker on the final point
        // if it's a preliminary month-to-date value.
        if (bundle.byYear[currentYear]) {
            var cur = bundle.byYear[currentYear];
            var prelim = bundle.preliminaryByYear[currentYear];
            // Find prelim month indices for distinct markers
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
                line: { color: 'rgba(255,0,255,0.95)', width: 2.5 },
                marker: { size: 6, color: 'rgba(255,0,255,0.95)' },
                name: String(currentYear),
                hovertemplate: currentYear + ' · %{x}: %{y:.2f}<extra></extra>',
            });
            if (prelimMonths.length) {
                traces.push({
                    type: 'scatter', mode: 'markers',
                    x: prelimMonths, y: prelimVals,
                    marker: {
                        symbol: 'star-open', size: 16,
                        color: 'rgba(255,0,255,0.95)',
                        line: { color: '#000', width: 2 },
                    },
                    name: 'preliminary',
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
            title: { text: label + ' — Monthly ' + varLabel, font: { size: 14 } },
            xaxis: {
                title: 'Month', tickmode: 'array', tickvals: months,
                ticktext: monNames, zeroline: false,
            },
            yaxis: { title: varLabel, zeroline: state.ts.variable !== 'sst' },
            margin: { l: 60, r: 10, t: 40, b: 50 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(255,255,255,0.02)',
            font: { color: '#e0e0e0', size: 11 },
            hovermode: 'closest',
            showlegend: true,
            legend: { font: { size: 10 }, orientation: 'h',
                      yanchor: 'top', y: -0.18 },
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
        var regions = REGION_SETS[state.an.regions] || REGION_SETS.atlantic;
        var targetYear = state.an.year;
        var month = state.an.month;

        // Build per-year vector of (region anomalies) for the chosen month.
        var dateToIdx = {};
        for (var i = 0; i < idx.dates.length; i++) dateToIdx[idx.dates[i]] = i;
        var availableYears = [];
        var vectors = {};
        var preliminaryFlag = {};
        for (var k in dateToIdx) {
            var p = k.split('-');
            var y = parseInt(p[0], 10);
            var m = parseInt(p[1], 10);
            if (m !== month) continue;
            var i = dateToIdx[k];
            var vec = [];
            var anyNull = false;
            for (var r = 0; r < regions.length; r++) {
                var v = idx.values[regions[r] + '_anom'][i];
                if (v === null || v === undefined) { anyNull = true; break; }
                vec.push(v);
            }
            if (anyNull) continue;
            availableYears.push(y);
            vectors[y] = vec;
            preliminaryFlag[y] = !!(idx.preliminary && idx.preliminary[i]);
        }
        if (!availableYears.includes(targetYear)) return { years: [], rows: [] };

        var target = vectors[targetYear];
        var ranked = [];
        for (var j = 0; j < availableYears.length; j++) {
            var yy = availableYears[j];
            if (yy === targetYear) continue;
            // Euclidean distance over the region-anomaly vector.
            var sum2 = 0;
            for (var r = 0; r < regions.length; r++) {
                var diff = vectors[yy][r] - target[r];
                sum2 += diff * diff;
            }
            ranked.push({ year: yy, dist: Math.sqrt(sum2) });
        }
        ranked.sort(function (a, b) { return a.dist - b.dist; });
        return {
            years: availableYears,
            rows: ranked.slice(0, 10),
            targetYear: targetYear,
            targetPreliminary: preliminaryFlag[targetYear],
        };
    }

    function _renderAnalogs() {
        var tbody = document.getElementById('seasonal-an-tbody');
        if (!tbody) return;
        var bundle = _buildAnalogs();
        if (!bundle || !bundle.rows.length) {
            tbody.innerHTML =
                '<tr><td colspan="5" style="opacity:.6">' +
                'No analogs available for the selected target.</td></tr>';
            return;
        }
        var html = '';
        bundle.rows.forEach(function (r, i) {
            var ace = state.ace.years[r.year];
            var aceVal = ace ? ace.ace : null;
            var storms = ace ? ace.named_storms_contrib : null;
            var aceCls = (aceVal === null) ? ''
                       : (aceVal >= 175) ? ' class="an-ace-hi"'
                       : (aceVal <= 60) ? ' class="an-ace-lo"' : '';
            html += '<tr>' +
                '<td>' + (i + 1) + '</td>' +
                '<td>' + r.year + '</td>' +
                '<td>' + r.dist.toFixed(2) + '</td>' +
                '<td' + aceCls + '>' + (aceVal !== null ? aceVal.toFixed(1) : '—') + '</td>' +
                '<td>' + (storms !== null ? storms : '—') + '</td>' +
                '</tr>';
        });
        tbody.innerHTML = html;
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
        bindNum('seasonal-an-year', 'year');
        bindNum('seasonal-an-month', 'month');
        var rsel = document.getElementById('seasonal-an-regions');
        if (rsel) {
            rsel.addEventListener('change', function () {
                state.an.regions = rsel.value;
                _renderAnalogs();
            });
        }
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
                     zerolinecolor: 'rgba(255,255,255,0.18)' },
            margin: { l: 60, r: 10, t: 40, b: 60 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(255,255,255,0.02)',
            font: { color: '#e0e0e0', size: 11 },
            hovermode: 'x unified',
            legend: { font: { size: 10 }, orientation: 'h',
                      yanchor: 'top', y: -0.18 },
            shapes: [
                {type: 'line', xref: 'paper', x0: 0, x1: 1,
                 yref: 'y', y0: 0.5, y1: 0.5,
                 line: {color: 'rgba(233,85,79,0.35)', width: 1, dash: 'dot'}},
                {type: 'line', xref: 'paper', x0: 0, x1: 1,
                 yref: 'y', y0: -0.5, y1: -0.5,
                 line: {color: 'rgba(80,140,210,0.35)', width: 1, dash: 'dot'}},
            ],
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
        img.onerror = function () {
            img.onerror = null;
            img.src = GCS_BASE + '/' + pngName;
        };
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
        _bindTimeSeriesControls();
        _bindAnalogControls();
        _bindIndexControls();
        _wireCorrHover();
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
            _populateAnalogYearSelector();
            _renderScatter();
            _renderTimeSeries();
            _renderAnalogs();
            _renderIndices();
            _renderAnomMap();
        }).catch(function (e) {
            _setStatus('Failed to load seasonal data: ' + e.message, true);
        });
    }

    window.activateSeasonalView = _activate;
})();
