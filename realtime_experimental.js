/* realtime_experimental.js — RT Monitor "Experimental" tab.
 *
 * GHOST Stage-0/1 ML diagnostics (recon-independent Vmax/Pmin/RMW from
 * geostationary IR + SHIPS environment), produced by the TC-SWARM
 * realtime/ghost_rt pipeline hourly and published to
 * gs://tc-atlas-ir-cache/ghost-rt/. Public since 2026-07-26; the method is
 * described in a manuscript in preparation. Research guidance, NOT an
 * official forecast or analysis.
 *
 * Lazy-loaded on first tab activation (see _lazyViewMods in
 * realtime_ir.html). Public API: window.activateExperimentalView().
 */
(function () {
    'use strict';

    var GCS_BASE = 'https://storage.googleapis.com/tc-atlas-ir-cache/';
    var PREFIX = 'ghost-rt';

    var _root = null;          // #exp-main
    var _index = null;         // manifest {generated, storms:[{atcf,name}]}
    var _storm = null;         // selected ATCF id
    var _series = {};          // atcf -> frames json
    var _plotlyReq = null;
    var _showComp = true;    // ON by default: a lone GHOST curve invites
                             // over-reading; peers give honest context
    var _showShap = false;   // model-driver (SHAP) panel
    var _showVerif = false;  // manuscript verification statistics
    var GHOST_COL = '#f43f5e';   // one colour for every GHOST trace
    var COMP_STYLE = {
        'D-PRINT':       '#a855f7',
        'SATCON':        '#ec4899',
        'ADT':           '#f59e0b',
        'Dvorak (DVTS)': '#14b8a6'
    };
    var _rangeH = 48;          // visible window, hours; 0 = full lifetime
                               // (must match a RANGES entry so a button reads active)
    var RANGES = [{ h: 24, label: '24 h' }, { h: 48, label: '48 h' },
                  { h: 0,  label: 'Full lifetime' }];

    function ensurePlotly() {
        if (typeof Plotly !== 'undefined') return Promise.resolve(true);
        if (_plotlyReq) return _plotlyReq;
        _plotlyReq = new Promise(function (resolve) {
            var s = document.createElement('script');
            s.src = 'https://cdn.plot.ly/plotly-2.27.0.min.js';
            s.onload = function () { resolve(true); };
            s.onerror = function () { _plotlyReq = null; resolve(false); };
            document.head.appendChild(s);
        });
        return _plotlyReq;
    }

    function fetchJson(url) {
        return fetch(url, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    /* Verification numbers are quoted from the manuscript (Fischer, in prep).
       Held-out means the season's storms were withheld from training in every
       basin. Do NOT edit these by hand without checking the source. */
    var VERIF_HTML =
        '<div class="exp-verif-h">Preliminary verification' +
        '<span class="exp-verif-src">from the manuscript in preparation. ' +
        '&ldquo;Held out&rdquo; = the season\'s storms were withheld from ' +
        'training. Per-storm-mean unless noted.</span></div>' +

        '<div class="exp-verif-t"><table><caption>Intensity &mdash; 2025 ' +
        'Atlantic held out (13 storms, 1425 hourly frames)</caption><thead>' +
        '<tr><th>Method</th><th>Vmax RMSE</th><th>Bias</th></tr></thead><tbody>' +
        '<tr class="me"><td>GHOST</td><td>6.8 kt</td><td>+1.4 kt</td></tr>' +
        '<tr><td>D-PRINT (deep learning)</td><td>7.1 kt</td><td>&minus;3.1 kt</td></tr>' +
        '<tr><td>AiDT</td><td>7.9 kt</td><td>&minus;1.7 kt</td></tr>' +
        '<tr><td>Dvorak (DVTS)</td><td>8.4 kt</td><td>&minus;4.5 kt</td></tr>' +
        '<tr><td>ADT</td><td>9.8 kt</td><td>&minus;3.2 kt</td></tr>' +
        '</tbody></table></div>' +

        '<p class="exp-verif-note">GHOST\'s 6.8 kt carries a 95% confidence ' +
        'interval of [5.8, 8.0] kt, which contains D-PRINT\'s 7.1 kt &mdash; ' +
        'the two are <strong>statistically on par</strong>, not separated by a ' +
        'single season. GHOST\'s bias interval [&minus;0.5, +3.3] kt includes ' +
        'zero. The high-bias sits in the weak regime (about +9 kt at tropical ' +
        'depression intensity) and vanishes at major-hurricane intensity ' +
        '(&minus;0.3 kt for Vmax &ge; 96 kt), where the comparators run ' +
        'systematically low.</p>' +

        '<div class="exp-verif-t"><table><caption>Size (radius of maximum wind) ' +
        '&mdash; mean absolute error vs airborne radar</caption><thead>' +
        '<tr><th>Method</th><th>2024 held out<br>(n=146)</th>' +
        '<th>2025 held out<br>(n=76)</th></tr></thead><tbody>' +
        '<tr class="me"><td>GHOST <em>(no outer-wind input)</em></td>' +
        '<td>13.0 km</td><td>18.7 km</td></tr>' +
        '<tr><td>CK22 <em>(needs observed R34)</em></td><td>19.7 km</td><td>17.9 km</td></tr>' +
        '<tr><td>WB06 <em>(needs observed R34)</em></td><td>30.3 km</td><td>20.4 km</td></tr>' +
        '<tr><td>KZ07 <em>(needs observed R34)</em></td><td>33.2 km</td><td>34.2 km</td></tr>' +
        '</tbody></table></div>' +

        '<p class="exp-verif-note">On major hurricanes &mdash; where core size ' +
        'is best defined and matters most &mdash; GHOST\'s size error falls to ' +
        '<strong>6.5 km</strong>. A radius error costs less than it appears: ' +
        'over matched radar cases the resulting tangential-wind error has a ' +
        'median of 2.3 kt, roughly 9% of the peak wind.</p>' +

        '<div class="exp-verif-t"><table><caption>Independent cross-check &mdash; ' +
        'correlation with tail Doppler radar wind (83 coincident frames)</caption>' +
        '<thead><tr><th>Method</th><th>r vs radar</th></tr></thead><tbody>' +
        '<tr class="me"><td>GHOST</td><td>0.92</td></tr>' +
        '<tr><td>D-PRINT</td><td>0.92</td></tr>' +
        '<tr><td>AiDT</td><td>0.89</td></tr>' +
        '<tr><td>ADT</td><td>0.85</td></tr>' +
        '<tr><td><em>Best track (upper bound)</em></td><td><em>0.97</em></td></tr>' +
        '</tbody></table></div>' +

        '<p class="exp-verif-note">Radar is independent of both the satellite ' +
        'imagery and the best-track process, so this addresses the concern that ' +
        'a technique trained against the best track might only be echoing the ' +
        'satellite estimates that shaped its labels. Other results: minimum ' +
        'pressure 6.4 hPa RMSE vs 8.1 for D-PRINT (2025); East Pacific 8.3 vs ' +
        '8.5 kt pooled over three held-out seasons (49 storms); pooled ' +
        'storm-grouped cross-validation over all development seasons gives ' +
        '10.1 kt and 8.2 hPa.</p>';

    /* ---------------- main UI ---------------- */

    function renderShell() {
        var storms = (_index && _index.storms) || [];
        var gen = _index && _index.generated
            ? new Date(_index.generated) : null;
        var genStr = gen
            ? gen.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
        var html =
            '<div class="exp-inner">' +
            '<div class="exp-head">' +
            '  <div>' +
            '    <span class="exp-badge">EXPERIMENTAL</span>' +
            '    <span class="exp-title">GHOST — ML Structure Diagnostics</span>' +
            '  </div>' +
            '  <div class="exp-meta">Updated ' + genStr +
            '    · refreshes hourly · <a href="#" id="exp-refresh">reload</a></div>' +
            '</div>' +
            '<div class="exp-lede">GHOST provides <strong>independent, ' +
            'real-time estimates of tropical cyclone intensity (maximum ' +
            'sustained wind and minimum central pressure) and radius of ' +
            'maximum wind</strong> \u2014 derived from geostationary infrared ' +
            'imagery and the large-scale environment alone, with no aircraft ' +
            'reconnaissance required.</div>' +
            '<div class="exp-cite"><strong>Manuscript in preparation.</strong> ' +
            'GHOST (Geostationary-based Hurricane Objective Strength ' +
            'Technique) is an unpublished research method; this page is ' +
            'provided for scientific transparency and is <strong>not an ' +
            'official forecast or analysis</strong>. Please contact the ' +
            'author \u2014 Dr. Michael Fischer ' +
            '(<a href="mailto:mike.fischer@miami.edu">mike.fischer@miami.edu' +
            '</a>) \u2014 before citing or redistributing these estimates.</div>' +
            '<div class="exp-note">Guidance, not official analysis. ' +
            'Weak systems (TD / weak TS) have a known high-bias. The NHC ' +
            'reference is linearly interpolated between 6-hourly analyses ' +
            '(dots mark the real ones) and STOPS at the latest analysis — ' +
            'GHOST continues past it, so the most recent stretch has no ' +
            'reference to compare against yet.</div>';
        if (!storms.length) {
            html += '<div class="exp-empty">No active NHC storms right now — ' +
                'the pipeline publishes automatically when a storm forms.</div></div>';
            _root.innerHTML = html;
            bindRefresh();
            return;
        }
        html += '<div class="exp-chips" id="exp-chips">';
        storms.forEach(function (s) {
            html += '<button class="exp-chip" data-atcf="' + s.atcf + '">' +
                (s.name || s.atcf) + ' <span>' + s.atcf + '</span></button>';
        });
        html += '</div>' +
            '<div class="exp-ranges" id="exp-ranges">' +
            '<span class="exp-ranges-label">Show</span>';
        RANGES.forEach(function (r) {
            html += '<button class="exp-range' +
                (r.h === _rangeH ? ' active' : '') + '" data-h="' + r.h + '">' +
                r.label + '</button>';
        });
        html += '<span class="exp-ranges-sep"></span>' +
            '<button class="exp-range exp-comp' + (_showComp ? ' active' : '') +
            '" id="exp-comp">Operational comparators</button>' +
            '<button class="exp-range exp-shapbtn' + (_showShap ? ' active' : '') +
            '" id="exp-shap-btn">Model drivers</button>' +
            '<button class="exp-range exp-verifbtn' + (_showVerif ? ' active' : '') +
            '" id="exp-verif-btn">Verification</button>' +
            '<button class="exp-range exp-dl" id="exp-dl" ' +
            'title="Download chart as PNG" aria-label="Download chart as PNG">' +
            '&#x2913; Download</button>' +
            '</div>' +
            '<div id="exp-plot" class="exp-plot"></div>' +
            '<div id="exp-shap" class="exp-shap" style="display:none;"></div>' +
            '<div id="exp-verif" class="exp-verif" style="display:none;"></div>' +
            '<div class="exp-plan-wrap"><img id="exp-plan" class="exp-plan" ' +
            'alt="GHOST plan view"></div></div>';
        _root.innerHTML = html;
        bindRefresh();
        var chips = _root.querySelectorAll('.exp-chip');
        chips.forEach(function (c) {
            c.addEventListener('click', function () {
                selectStorm(c.getAttribute('data-atcf'));
            });
        });
        var vBtn = document.getElementById('exp-verif-btn');
        if (vBtn) vBtn.addEventListener('click', function () {
            _showVerif = !_showVerif;
            vBtn.classList.toggle('active', _showVerif);
            var box = document.getElementById('exp-verif');
            if (!box) return;
            box.style.display = _showVerif ? 'block' : 'none';
            if (_showVerif) box.innerHTML = VERIF_HTML;
        });
        var shapBtn = document.getElementById('exp-shap-btn');
        if (shapBtn) shapBtn.addEventListener('click', function () {
            _showShap = !_showShap;
            shapBtn.classList.toggle('active', _showShap);
            var box = document.getElementById('exp-shap');
            if (box) box.style.display = _showShap ? 'block' : 'none';
            if (_showShap && _storm && _series[_storm]) drawShap(_series[_storm]);
        });
        var compBtn = document.getElementById('exp-comp');
        if (compBtn) compBtn.addEventListener('click', function () {
            _showComp = !_showComp;
            compBtn.classList.toggle('active', _showComp);
            if (_storm && _series[_storm]) drawSeries(_series[_storm]);
        });
        var dlBtn = document.getElementById('exp-dl');
        if (dlBtn) dlBtn.addEventListener('click', function () {
            saveChartPng(dlBtn);
        });
        _root.querySelectorAll('.exp-range[data-h]').forEach(function (b) {
            b.addEventListener('click', function () {
                _rangeH = parseInt(b.getAttribute('data-h'), 10);
                _root.querySelectorAll('.exp-range[data-h]').forEach(
                    function (o) { o.classList.toggle('active', o === b); });
                /* Data already spans the full lifetime — a range change is a
                   pure client-side x-axis relayout, no refetch. */
                if (_storm && _series[_storm]) applyRange(_series[_storm]);
            });
        });
        var want = _storm && storms.some(function (s) { return s.atcf === _storm; })
            ? _storm : storms[0].atcf;
        selectStorm(want);
    }

    function bindRefresh() {
        var a = document.getElementById('exp-refresh');
        if (a) a.addEventListener('click', function (e) {
            e.preventDefault();
            _series = {};
            loadIndex();
        });
    }

    function selectStorm(atcf) {
        _storm = atcf;
        _root.querySelectorAll('.exp-chip').forEach(function (c) {
            c.classList.toggle('active', c.getAttribute('data-atcf') === atcf);
        });
        var img = document.getElementById('exp-plan');
        if (img) {
            img.src = GCS_BASE + PREFIX + '/ghost_' + atcf + '_plan.png?t=' +
                encodeURIComponent((_index && _index.generated) || Date.now());
        }
        var p = _series[atcf]
            ? Promise.resolve(_series[atcf])
            : fetchJson(GCS_BASE + PREFIX + '/ghost_' + atcf + '.json')
                .then(function (j) { _series[atcf] = j; return j; });
        Promise.all([p, ensurePlotly()]).then(function (res) {
            if (_storm !== atcf) return;
            drawSeries(res[0]);
            if (_showShap) drawShap(res[0]);
        }).catch(function () {
            var el = document.getElementById('exp-plot');
            if (el) el.innerHTML =
                '<div class="exp-empty">Failed to load ' + atcf + ' data.</div>';
        });
    }

    /* Chart → PNG through TCExport (the ONE save path — iOS-safe, share-
       sheet aware). Same recipe as the Seasonal panels: force an opaque
       background matching the current viewing theme (else the transparent
       paper exports as a see-through PNG), snapshot, then redraw to restore
       the live transparent styling. */
    function saveChartPng(btn) {
        var el = document.getElementById('exp-plot');
        if (!el || typeof Plotly === 'undefined' || !window.TCExport) return;
        if (!_storm || !_series[_storm]) return;
        var j = _series[_storm];
        var fr = j.frames || [];
        var stamp = fr.length
            ? fr[fr.length - 1].t.slice(0, 16).replace(/[:T-]/g, '')
            : new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '');
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var bg = dark ? '#0d1117' : '#ffffff';
        if (btn) btn.disabled = true;
        var fg = dark ? '#94a3b8' : '#475569';
        var m = JSON.parse(JSON.stringify(el.layout.margin || {}));
        m.b = (m.b || 40) + 58;          // room for the footer band
        Plotly.relayout(el, {
            paper_bgcolor: bg, plot_bgcolor: bg, margin: m,
            images: [{
                source: 'tc-atlas-favicon-96.png',   // same-origin: no canvas taint
                xref: 'paper', yref: 'paper', x: 0, y: -0.085,
                sizex: 0.055, sizey: 0.055,
                xanchor: 'left', yanchor: 'top', layer: 'above'
            }],
            annotations: [{
                xref: 'paper', yref: 'paper', x: 0.065, y: -0.085,
                xanchor: 'left', yanchor: 'top', showarrow: false,
                align: 'left',
                text: '<b>TC-ATLAS</b> &#183; tcatlas.org',
                font: { size: 12, color: fg }
            }, {
                xref: 'paper', yref: 'paper', x: 0.065, y: -0.135,
                xanchor: 'left', yanchor: 'top', showarrow: false,
                align: 'left',
                text: '<b style="color:#F47321">EXPERIMENTAL</b> &#183; GHOST is ' +
                      'an unpublished research method (manuscript in ' +
                      'preparation) &#8212; <b>not an official forecast or ' +
                      'analysis</b>.<br>Recon-independent estimates from ' +
                      'infrared imagery + reanalysis environment. Contact the ' +
                      'author before citing or redistributing.',
                font: { size: 10, color: fg }
            }]
        })
            .then(function () {
                return TCExport.savePlotly(el,
                    'TC-ATLAS_GHOST_' + _storm + '_' + stamp + '.png', {
                        format: 'png',
                        width: Math.max(el.clientWidth, 1400),
                        height: Math.max(el.clientHeight, 800),
                        scale: 2
                    });
            })
            .catch(function () {})
            .then(function () {
                if (btn) btn.disabled = false;
                // Restore the live (transparent) theme layout.
                if (_storm && _series[_storm]) drawSeries(_series[_storm]);
            });
    }

    /* Visible x-window for the current range button. Autorange y so a zoomed
       view isn't squashed by the full-lifetime extremes. */
    function applyRange(j) {
        var el = document.getElementById('exp-plot');
        var fr = (j && j.frames) || [];
        if (!el || !fr.length || typeof Plotly === 'undefined') return;
        var last = new Date(fr[fr.length - 1].t);
        var first = new Date(fr[0].t);
        var lo = _rangeH ? new Date(last.getTime() - _rangeH * 3600e3) : first;
        if (lo < first) lo = first;
        var rng = [lo.toISOString(), last.toISOString()];
        Plotly.relayout(el, {
            'xaxis.range': rng, 'xaxis2.range': rng, 'xaxis3.range': rng,
            'yaxis.autorange': true, 'yaxis2.autorange': true,
            'yaxis3.autorange': true
        });
    }

    /* Exact TreeSHAP from the producer. Explains the RAW Stage-A booster and
       the base-18 RMW model -- deliberately NOT the published values, which
       add calibration, Stage-B inertia, a causal kernel and the pinhole
       blend. The panel says so, so nobody reads it as a decomposition of the
       number on the chart above. */
    function drawShap(j) {
        var box = document.getElementById('exp-shap');
        if (!box || typeof Plotly === 'undefined') return;
        var sh = j.shap;
        if (!sh || !sh.vmax_latest) {
            box.innerHTML = '<div class="exp-empty">No driver attribution in ' +
                'this storm\'s file yet (republish to populate).</div>';
            return;
        }
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var grid = dark ? '#1e293b' : '#e2e8f0';
        var fc = dark ? '#cbd5e1' : '#334155';
        var last = (j.frames || []).slice(-1)[0];
        box.innerHTML =
            '<div class="exp-shap-head">Model drivers &mdash; ' +
            (last ? last.t.slice(0, 16).replace('T', ' ') + 'Z' : '') +
            '<span class="exp-shap-sub">exact TreeSHAP. Explains the ' +
            'intensity model\u2019s first-pass estimate (base ' +
            (sh.vmax_base || 0).toFixed(1) + ' kt) and the size model &mdash; ' +
            'not the calibrated, time-smoothed values plotted above.</span></div>' +
            '<div class="exp-shap-grid">' +
            '<div id="exp-shap-v"></div><div id="exp-shap-r"></div></div>' +
            '<div id="exp-shap-t"></div>';

        function barFig(el, rows, unit, title) {
            if (!rows || !rows.length) return;
            var r = rows.slice().reverse();
            Plotly.react(el, [{
                type: 'bar', orientation: 'h',
                x: r.map(function (d) { return d.v; }),
                y: r.map(function (d) { return d.f; }),
                marker: { color: r.map(function (d) {
                    return d.v >= 0 ? '#f43f5e' : '#2e7dff'; }) },
                hovertemplate: '%{y}: %{x:+.2f}' + unit + '<extra></extra>'
            }], {
                title: { text: title, font: { size: 12 } },
                height: 300, margin: { l: 150, r: 12, t: 30, b: 34 },
                paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
                font: { color: fc, size: 10 },
                xaxis: { zeroline: true, zerolinecolor: fc, gridcolor: grid,
                         title: { text: unit, font: { size: 10 } } },
                yaxis: { automargin: true }
            }, { displayModeBar: false, responsive: true })
              .then(function () { Plotly.Plots.resize(el); });
        }
        barFig('exp-shap-v', sh.vmax_latest, ' kt', 'Intensity drivers (kt)');
        barFig('exp-shap-r', sh.rmw_latest, ' %', 'Size (RMW) drivers (% effect)');

        if (sh.groups && j.frames) {
            var t = j.frames.map(function (f) { return f.t; });
            var col = { 'IR structure': '#f43f5e',
                        'Organization / banding': '#a855f7',
                        'Environment': '#2e7dff',
                        'Temporal (multi-frame)': '#14b8a6',
                        'Storm age': '#f59e0b' };
            var tr = Object.keys(sh.groups).map(function (g) {
                return { x: t, y: sh.groups[g], name: g, mode: 'lines',
                         line: { color: col[g] || '#94a3b8', width: 1.8 } };
            });
            Plotly.react('exp-shap-t', tr, {
                title: { text: 'Grouped contribution through the storm\'s life',
                         font: { size: 12 } },
                height: 260, margin: { l: 54, r: 12, t: 30, b: 40 },
                paper_bgcolor: 'rgba(0,0,0,0)',
                plot_bgcolor: dark ? 'rgba(15,23,42,0.55)' : 'rgba(248,250,252,0.7)',
                font: { color: fc, size: 10 }, hovermode: 'x unified',
                legend: { orientation: 'h', y: -0.22, font: { size: 10 } },
                xaxis: { gridcolor: grid },
                yaxis: { title: { text: 'kt', font: { size: 10 } },
                         gridcolor: grid, zeroline: true, zerolinecolor: fc }
            }, { displayModeBar: false, responsive: true })
              .then(function () { Plotly.Plots.resize('exp-shap-t'); });
        }
    }

    function drawSeries(j) {
        var el = document.getElementById('exp-plot');
        if (!el || typeof Plotly === 'undefined') return;
        var fr = j.frames || [];
        var t = fr.map(function (f) { return f.t; });
        function col(k) { return fr.map(function (f) {
            return (f[k] === null || f[k] === undefined) ? null : f[k];
        }); }
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var font = { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", ' +
                             'Roboto, Helvetica, Arial, sans-serif',
                     color: dark ? '#cbd5e1' : '#334155' };
        var grid = dark ? '#1e293b' : '#e2e8f0';
        var nhc = { color: dark ? '#94a3b8' : '#64748b', width: 1.4,
                    dash: 'dash' };
        var traces = [
            /* One GHOST colour across all three panels so the single legend
               entry means the same thing everywhere (the y-axis titles already
               say which quantity each panel shows). */
            { x: t, y: col('vmax_kt'), name: 'GHOST', yaxis: 'y',
              line: { color: GHOST_COL, width: 2.4 } },
            { x: t, y: col('btk_vmax_kt'), name: 'NHC best track (interp)',
              yaxis: 'y', line: nhc, connectgaps: false },
            { x: fr.filter(function (d) { return d.btk_is_fix; })
                   .map(function (d) { return d.t; }),
              y: fr.filter(function (d) { return d.btk_is_fix; })
                   .map(function (d) { return d.btk_vmax_kt; }),
              name: 'NHC analysis', yaxis: 'y', mode: 'markers',
              marker: { size: 5, color: nhc.color } },
            { x: t, y: col('pmin_hpa'), name: 'GHOST', yaxis: 'y2',
              line: { color: GHOST_COL, width: 2.4 }, showlegend: false },
            { x: t, y: col('btk_mslp_hpa'), name: 'NHC best track (interp)',
              yaxis: 'y2', line: nhc, showlegend: false, connectgaps: false },
            { x: t, y: col('rmw_km'), name: 'GHOST', yaxis: 'y3',
              line: { color: GHOST_COL, width: 2.4 }, showlegend: false },
            { x: t, y: col('btk_rmw_km'), name: 'NHC RMW', yaxis: 'y3',
              line: nhc, showlegend: false, connectgaps: false }
        ];
        var layout = {
            grid: { rows: 3, columns: 1, pattern: 'independent',
                    roworder: 'top to bottom' },
            height: 560,
            margin: { l: 58, r: 16, t: 26, b: 40 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: dark ? 'rgba(15,23,42,0.55)' : 'rgba(248,250,252,0.7)',
            font: font,
            hovermode: 'x unified',
            legend: { orientation: 'h', y: 1.06, font: { size: 11 } },
            xaxis:  { anchor: 'y',  gridcolor: grid, matches: 'x3',
                      showticklabels: false },
            xaxis2: { anchor: 'y2', gridcolor: grid, matches: 'x3',
                      showticklabels: false },
            xaxis3: { anchor: 'y3', gridcolor: grid },
            yaxis:  { title: { text: 'Vmax (kt)' },  gridcolor: grid,
                      domain: [0.70, 1.00] },
            yaxis2: { title: { text: 'Pmin (hPa)' }, gridcolor: grid,
                      domain: [0.36, 0.64] },
            yaxis3: { title: { text: 'RMW (km)' },   gridcolor: grid,
                      domain: [0.00, 0.30], rangemode: 'tozero' }
        };
        traces[3].xaxis = 'x2'; traces[4].xaxis = 'x2';
        traces[5].xaxis = 'x3'; traces[6].xaxis = 'x3';

        /* Operational satellite estimators, scored against the same target.
           Sparse + irregular (f-deck fixes are a few per day), so markers
           with connecting lines rather than a continuous curve. */
        if (_showComp && j.comparators) {
            Object.keys(j.comparators).forEach(function (name) {
                var rows = j.comparators[name] || [];
                if (!rows.length) return;
                var col = COMP_STYLE[name] || '#94a3b8';
                var many = rows.length > 60;
                /* f-deck comparators (ADT / Dvorak / SATCON) are appended on
                   the advisory cycle and can be many hours old, so a series
                   that merely ENDS early looks like a live disagreement.
                   Stamp the last update into the legend, and flag it when the
                   series is well behind the newest GHOST frame. */
                var lastT = rows[rows.length - 1].t;
                var ageH = (new Date(t[t.length - 1]) - new Date(lastT)) / 3.6e6;
                var lbl = name + ' \u00b7 ' + lastT.slice(11, 16) + 'Z' +
                          (ageH >= 2 ? ' (' + ageH.toFixed(0) + ' h old)' : '');
                traces.push({
                    x: rows.map(function (r) { return r.t; }),
                    y: rows.map(function (r) { return r.vmax_kt; }),
                    name: lbl, yaxis: 'y', xaxis: 'x',
                    mode: many ? 'lines' : 'lines+markers',
                    line: { color: col, width: 1.4 },
                    marker: { size: 5, color: col },
                    opacity: 0.9
                });
                var hasP = rows.some(function (r) {
                    return r.pmin_hpa !== undefined && r.pmin_hpa !== null; });
                if (hasP) traces.push({
                    x: rows.map(function (r) { return r.t; }),
                    y: rows.map(function (r) {
                        return (r.pmin_hpa === undefined) ? null : r.pmin_hpa; }),
                    name: lbl + ' Pmin', yaxis: 'y2', xaxis: 'x2',
                    mode: 'lines', line: { color: col, width: 1.4 },
                    opacity: 0.9, showlegend: false
                });
            });
        }
        Plotly.react(el, traces, layout, {
            responsive: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['toImage', 'lasso2d', 'select2d']
        }).then(function () { applyRange(j); });
    }

    /* ---------------- entry ---------------- */

    function loadIndex() {
        _lastLoad = Date.now();
        fetchJson(GCS_BASE + PREFIX + '/index.json').then(function (idx) {
            _index = idx;
            renderShell();
        }).catch(function () {
            _root.innerHTML = '<div class="exp-inner"><div class="exp-empty">' +
                'Could not load GHOST output right now — the hourly job may be ' +
                'mid-publish. Try again shortly.</div></div>';
        });
    }

    /* Redraw the chart when the site theme toggles (data-theme attribute). */
    new MutationObserver(function () {
        if (_storm && _series[_storm] &&
            document.getElementById('exp-plot')) {
            drawSeries(_series[_storm]);
            if (_showShap) drawShap(_series[_storm]);
        }
    }).observe(document.documentElement,
               { attributes: true, attributeFilter: ['data-theme'] });

    /* The producer republishes hourly, but a tab left open would keep showing
       whatever it fetched on first activation (series are memoized in
       _series). Re-pull while the tab is actually being looked at, and again
       whenever it regains visibility after going stale. */
    var REFRESH_MS = 10 * 60 * 1000;
    var _lastLoad = 0;

    function refreshIfStale(force) {
        if (!_root || !PREFIX) return;
        if (document.hidden) return;
        if (document.documentElement.getAttribute('data-view') !== 'experimental') return;
        if (!force && Date.now() - _lastLoad < REFRESH_MS) return;
        _series = {};
        loadIndex();
    }
    setInterval(function () { refreshIfStale(false); }, 60 * 1000);
    document.addEventListener('visibilitychange', function () {
        refreshIfStale(false);
    });

    window.activateExperimentalView = function () {
        _root = document.getElementById('exp-main');
        if (!_root) return;
        loadIndex();
    };
})();
