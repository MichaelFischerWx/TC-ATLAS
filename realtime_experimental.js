/* realtime_experimental.js — RT Monitor "Experimental" tab.
 *
 * GHOST Stage-0/1 ML diagnostics (recon-independent Vmax/Pmin/RMW from
 * geostationary IR + SHIPS environment), produced by the TC-SWARM
 * realtime/ghost_rt pipeline every 30 min and published to a GCS prefix
 * derived from the access password: "ghost-rt-" + sha1(password)[:10].
 * Wrong password → prefix doesn't exist → 404. Light gate by design:
 * unpublished research guidance, not operational products.
 *
 * Lazy-loaded on first tab activation (see _lazyViewMods in
 * realtime_ir.html). Public API: window.activateExperimentalView().
 */
(function () {
    'use strict';

    var GCS_BASE = 'https://storage.googleapis.com/tc-atlas-ir-cache/';
    var SS_KEY = 'ghostRtPrefix';

    var _root = null;          // #exp-main
    var _prefix = null;        // validated "ghost-rt-xxxxxxxxxx"
    var _index = null;         // manifest {generated, storms:[{atcf,name}]}
    var _storm = null;         // selected ATCF id
    var _series = {};          // atcf -> frames json
    var _plotlyReq = null;
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

    function sha1Hex(text) {
        var buf = new TextEncoder().encode(text);
        return crypto.subtle.digest('SHA-1', buf).then(function (d) {
            return Array.prototype.map.call(new Uint8Array(d), function (b) {
                return ('0' + b.toString(16)).slice(-2);
            }).join('');
        });
    }

    function fetchJson(url) {
        return fetch(url, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    /* ---------------- gate ---------------- */

    function renderGate(msg) {
        _root.innerHTML =
            '<div class="exp-inner"><div class="exp-gate">' +
            '  <div class="exp-badge">EXPERIMENTAL</div>' +
            '  <h2>GHOST — ML Structure Diagnostics</h2>' +
            '  <p>Recon-independent tropical cyclone intensity, pressure, and ' +
            '     RMW estimated from geostationary IR + large-scale environment. ' +
            '     Unpublished research product — access is limited while the ' +
            '     manuscript is in review.</p>' +
            '  <div class="exp-gate-row">' +
            '    <input type="password" id="exp-pw" placeholder="Access password" ' +
            '           autocomplete="off">' +
            '    <button id="exp-pw-go">Enter</button>' +
            '  </div>' +
            (msg ? '<div class="exp-gate-err">' + msg + '</div>' : '') +
            '</div></div>';
        var input = document.getElementById('exp-pw');
        var go = document.getElementById('exp-pw-go');
        function submit() { tryPassword(input.value.trim()); }
        go.addEventListener('click', submit);
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') submit();
        });
        input.focus();
    }

    function tryPassword(pw) {
        if (!pw) return;
        sha1Hex(pw).then(function (hex) {
            var prefix = 'ghost-rt-' + hex.slice(0, 10);
            return fetchJson(GCS_BASE + prefix + '/index.json').then(function (idx) {
                _prefix = prefix;
                _index = idx;
                try { sessionStorage.setItem(SS_KEY, prefix); } catch (e) {}
                renderShell();
            });
        }).catch(function () {
            renderGate('Incorrect password (or no data published yet).');
        });
    }

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
            '<div class="exp-note">Recon-independent estimates from ' +
            'geostationary IR + SHIPS-type environment (GHOST Stage-0 intensity ' +
            '/ pressure, Stage-1 RMW). Guidance, not official analysis. ' +
            'Weak systems (TD / weak TS) are known to read high; NHC working ' +
            'best-track comparisons are themselves operational estimates.</div>';
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
        html += '</div>' +
            '<div id="exp-plot" class="exp-plot"></div>' +
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
        _root.querySelectorAll('.exp-range').forEach(function (b) {
            b.addEventListener('click', function () {
                _rangeH = parseInt(b.getAttribute('data-h'), 10);
                _root.querySelectorAll('.exp-range').forEach(function (o) {
                    o.classList.toggle('active', o === b);
                });
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
            img.src = GCS_BASE + _prefix + '/ghost_' + atcf + '_plan.png?t=' +
                encodeURIComponent((_index && _index.generated) || Date.now());
        }
        var p = _series[atcf]
            ? Promise.resolve(_series[atcf])
            : fetchJson(GCS_BASE + _prefix + '/ghost_' + atcf + '.json')
                .then(function (j) { _series[atcf] = j; return j; });
        Promise.all([p, ensurePlotly()]).then(function (res) {
            if (_storm === atcf) drawSeries(res[0]);
        }).catch(function () {
            var el = document.getElementById('exp-plot');
            if (el) el.innerHTML =
                '<div class="exp-empty">Failed to load ' + atcf + ' data.</div>';
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
            { x: t, y: col('vmax_kt'), name: 'GHOST Vmax', yaxis: 'y',
              line: { color: '#f43f5e', width: 2.4 } },
            { x: t, y: col('btk_vmax_kt'), name: 'NHC working BT', yaxis: 'y',
              line: nhc },
            { x: t, y: col('pmin_hpa'), name: 'GHOST Pmin', yaxis: 'y2',
              line: { color: '#2e7dff', width: 2.4 }, showlegend: false },
            { x: t, y: col('btk_mslp_hpa'), name: 'NHC working BT', yaxis: 'y2',
              line: nhc, showlegend: false },
            { x: t, y: col('rmw_km'), name: 'GHOST RMW', yaxis: 'y3',
              line: { color: '#34d399', width: 2.4 }, showlegend: false },
            { x: t, y: col('btk_rmw_km'), name: 'NHC RMW', yaxis: 'y3',
              line: nhc, showlegend: false }
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
        traces[2].xaxis = 'x2'; traces[3].xaxis = 'x2';
        traces[4].xaxis = 'x3'; traces[5].xaxis = 'x3';
        Plotly.react(el, traces, layout, {
            responsive: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['toImage', 'lasso2d', 'select2d']
        }).then(function () { applyRange(j); });
    }

    /* ---------------- entry ---------------- */

    function loadIndex() {
        _lastLoad = Date.now();
        fetchJson(GCS_BASE + _prefix + '/index.json').then(function (idx) {
            _index = idx;
            renderShell();
        }).catch(function () {
            try { sessionStorage.removeItem(SS_KEY); } catch (e) {}
            _prefix = null;
            renderGate('Session expired — re-enter the password.');
        });
    }

    /* Redraw the chart when the site theme toggles (data-theme attribute). */
    new MutationObserver(function () {
        if (_storm && _series[_storm] &&
            document.getElementById('exp-plot')) {
            drawSeries(_series[_storm]);
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
        if (!_root || !_prefix) return;
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
        if (!_prefix) {
            try { _prefix = sessionStorage.getItem(SS_KEY); } catch (e) {}
        }
        if (_prefix) loadIndex();
        else renderGate('');
    };
})();
