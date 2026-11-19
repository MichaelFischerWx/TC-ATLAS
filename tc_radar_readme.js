/* TC-RADAR README page (tc_radar_readme.html): per-year chart, grid/center
   explainer, variable browser, copy buttons, code tabs, in-page nav state.
   Variable catalog: data/tc_radar_v4_variables.json, built from the released
   netCDF headers by bin/build_tcradar_readme_vars.py. */
(function () {
    'use strict';

    var CATALOG_URL = 'data/tc_radar_v4_variables.json?v=20261119rd1';

    // Analyses per year in v4.0 (tc_radar_metadata{,_merge}_v4.json). Years
    // absent here had no analyses.
    var YEARS = {
        swath:  {1997: 9, 2003: 18, 2004: 66, 2005: 50, 2007: 5, 2008: 93, 2009: 10, 2010: 31, 2012: 24, 2013: 13, 2014: 49, 2015: 6, 2016: 76, 2017: 68, 2018: 59, 2019: 136, 2020: 201, 2021: 107, 2022: 172, 2023: 150, 2024: 170, 2025: 127},
        merged: {1997: 3, 2003: 7, 2004: 21, 2005: 16, 2007: 3, 2008: 29, 2009: 5, 2010: 9, 2012: 6, 2013: 5, 2014: 19, 2015: 2, 2016: 21, 2017: 20, 2018: 17, 2019: 33, 2020: 57, 2021: 33, 2022: 49, 2023: 36, 2024: 46, 2025: 37}
    };
    var Y0 = 1997, Y1 = 2025;
    var SVGNS = 'http://www.w3.org/2000/svg';

    function el(tag, attrs, text) {
        var n = document.createElement(tag);
        if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
        if (text != null) n.textContent = text;
        return n;
    }
    function svg(tag, attrs) {
        var n = document.createElementNS(SVGNS, tag);
        if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
        return n;
    }
    function fmt(n) { return n.toLocaleString('en-US'); }

    // ── Copy buttons ────────────────────────────────────────────
    function copyText(text, btn, doneClass) {
        var done = function () {
            if (!btn) return;
            var cls = doneClass || 'rd-copied';
            var orig = btn.getAttribute('data-label') || btn.textContent;
            btn.setAttribute('data-label', orig);
            if (!doneClass) btn.textContent = 'Copied';
            btn.classList.add(cls);
            setTimeout(function () { if (!doneClass) btn.textContent = orig; btn.classList.remove(cls); }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () {});
        } else {
            var ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            try { document.execCommand('copy'); done(); } catch (e) { /* no clipboard */ }
            document.body.removeChild(ta);
        }
    }
    document.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-copy],[data-copy-from]');
        if (!b) return;
        var t = b.getAttribute('data-copy');
        if (t == null) {
            var src = document.getElementById(b.getAttribute('data-copy-from'));
            t = src ? src.textContent.trim() : '';
        }
        copyText(t, b);
    });

    var BIBTEX = [
        '@article{Fischer2022TCRadar,\n  author  = {Fischer, Michael S. and Reasor, Paul D. and Rogers, Robert F. and Gamache, John F.},\n  title   = {An Analysis of Tropical Cyclone Vortex and Convective Characteristics in Relation to Storm Intensity Using a Novel Airborne Doppler Radar Database},\n  journal = {Monthly Weather Review},\n  year    = {2022},\n  volume  = {150},\n  pages   = {2255--2278},\n  doi     = {10.1175/MWR-D-21-0223.1}\n}',
        '@article{Fischer2024VortexTilt,\n  author  = {Fischer, Michael S. and Reasor, Paul D. and Dunion, Jason P. and Rogers, Robert F.},\n  title   = {An Observational Analysis of the Relationship between Tropical Cyclone Vortex Tilt, Precipitation Structure, and Intensity Change},\n  journal = {Monthly Weather Review},\n  year    = {2024},\n  volume  = {152},\n  pages   = {203--225},\n  doi     = {10.1175/MWR-D-23-0089.1}\n}'
    ].join('\n\n');
    var bib = document.getElementById('rd-bibtex');
    if (bib) bib.addEventListener('click', function () { copyText(BIBTEX, bib); });

    // ── Code tabs ───────────────────────────────────────────────
    var tabs = Array.prototype.slice.call(document.querySelectorAll('.rd-tabs [role="tab"]'));
    function selectTab(t) {
        tabs.forEach(function (o) {
            var on = o === t;
            o.setAttribute('aria-selected', on ? 'true' : 'false');
            o.tabIndex = on ? 0 : -1;
            document.getElementById(o.getAttribute('aria-controls')).hidden = !on;
        });
    }
    tabs.forEach(function (t, i) {
        t.addEventListener('click', function () { selectTab(t); });
        t.addEventListener('keydown', function (e) {
            var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            var n = tabs[(i + d + tabs.length) % tabs.length];
            selectTab(n); n.focus(); e.preventDefault();
        });
    });

    // ── Per-year chart ──────────────────────────────────────────
    var chartBox = document.getElementById('rd-year-chart');
    var chartKind = 'swath';
    var tip = null;

    function drawChart() {
        if (!chartBox) return;
        var data = YEARS[chartKind];
        var years = [];
        for (var y = Y0; y <= Y1; y++) years.push(y);
        var max = 0, total = 0;
        years.forEach(function (yy) { var v = data[yy] || 0; max = Math.max(max, v); total += v; });
        var step = max > 120 ? 50 : 10;
        var top = Math.ceil(max / step) * step;

        var W = 720, H = 220, L = 34, R = 6, T = 10, B = 24;
        var pw = W - L - R, ph = H - T - B;
        var bw = pw / years.length;
        var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true' });
        var grid = svg('g', { 'class': 'rd-grid' }), axis = svg('g', { 'class': 'rd-axis' });
        for (var g = 0; g <= top; g += step) {
            var gy = T + ph - (g / top) * ph;
            grid.appendChild(svg('line', { x1: L, x2: W - R, y1: gy, y2: gy }));
            var lt = svg('text', { x: L - 6, y: gy + 3.5, 'text-anchor': 'end' }); lt.textContent = g; axis.appendChild(lt);
        }
        s.appendChild(grid);
        var bars = svg('g');
        years.forEach(function (yy, i) {
            var v = data[yy] || 0;
            var x = L + i * bw;
            if (yy % 4 === 1 || yy === Y1) {
                var xt = svg('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle' }); xt.textContent = yy; axis.appendChild(xt);
            }
            var hit = svg('rect', { 'class': 'rd-hit', x: x, y: T, width: bw, height: ph });
            var h = (v / top) * ph;
            var gap = 2, w = Math.max(bw - gap, 1), bx = x + gap / 2, by = T + ph - h, r = Math.min(4, w / 2, h);
            var bar = null;
            if (v > 0) {
                // rounded top corners, square at the baseline
                bar = svg('path', {
                    'class': 'rd-bar',
                    d: 'M' + bx + ',' + (T + ph) + 'V' + (by + r) + 'Q' + bx + ',' + by + ' ' + (bx + r) + ',' + by +
                       'H' + (bx + w - r) + 'Q' + (bx + w) + ',' + by + ' ' + (bx + w) + ',' + (by + r) + 'V' + (T + ph) + 'Z'
                });
            }
            hit.addEventListener('mouseenter', function () { showTip(yy, v, x + bw / 2, by, W); if (bar) bar.classList.add('rd-hover'); });
            hit.addEventListener('mouseleave', function () { hideTip(); if (bar) bar.classList.remove('rd-hover'); });
            bars.appendChild(hit);
            if (bar) bars.appendChild(bar);
        });
        s.appendChild(bars);
        s.appendChild(svg('line', { x1: L, x2: W - R, y1: T + ph, y2: T + ph, stroke: 'var(--border-light)' }));
        s.appendChild(axis);
        chartBox.innerHTML = '';
        chartBox.appendChild(s);
        tip = el('div', { 'class': 'rd-tip', role: 'presentation' });
        chartBox.appendChild(tip);

        var label = chartKind === 'swath' ? 'swath' : 'merged';
        document.getElementById('rd-chart-title').textContent = (chartKind === 'swath' ? 'Swath' : 'Merged') + ' analyses per year';
        var peak = years.reduce(function (a, b) { return (data[b] || 0) > (data[a] || 0) ? b : a; }, Y0);
        chartBox.setAttribute('aria-label', fmt(total) + ' ' + label + ' analyses from ' + Y0 + ' to ' + Y1 + '; the most in ' + peak + ' (' + data[peak] + ').');
        document.getElementById('rd-chart-summary').textContent = fmt(total) + ' ' + label + ' analyses; most in ' + peak + ' (' + data[peak] + '). Gaps are years without TDR analyses.';
        drawTable();
    }
    function showTip(yy, v, cx, by, W) {
        if (!tip) return;
        var scale = chartBox.clientWidth / W;
        tip.innerHTML = '';
        tip.appendChild(document.createTextNode(yy + ': '));
        tip.appendChild(el('b', null, v ? fmt(v) : 'none'));
        tip.style.left = Math.min(Math.max(cx * scale, 50), chartBox.clientWidth - 50) + 'px';
        tip.style.top = (Math.min(by, 200) * scale) + 'px';
        tip.classList.add('rd-on');
    }
    function hideTip() { if (tip) tip.classList.remove('rd-on'); }
    function drawTable() {
        var wrap = document.getElementById('rd-year-table');
        if (!wrap) return;
        var t = el('table', { 'class': 'rd-yeartable' });
        var hr = el('tr');
        ['Year', 'Swath', 'Merged'].forEach(function (h) { hr.appendChild(el('th', { scope: 'col' }, h)); });
        var th = el('thead'); th.appendChild(hr); t.appendChild(th);
        var tb = el('tbody');
        Object.keys(YEARS.swath).forEach(function (yy) {
            var tr = el('tr');
            tr.appendChild(el('td', null, yy));
            tr.appendChild(el('td', null, fmt(YEARS.swath[yy])));
            tr.appendChild(el('td', null, fmt(YEARS.merged[yy] || 0)));
            tb.appendChild(tr);
        });
        t.appendChild(tb);
        wrap.innerHTML = '';
        wrap.appendChild(t);
    }
    Array.prototype.forEach.call(document.querySelectorAll('.rd-chart-head .rd-seg button'), function (b) {
        b.addEventListener('click', function () {
            chartKind = b.getAttribute('data-kind');
            Array.prototype.forEach.call(b.parentNode.children, function (o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
            drawChart();
        });
    });
    var tableToggle = document.getElementById('rd-table-toggle');
    if (tableToggle) tableToggle.addEventListener('click', function () {
        var wrap = document.getElementById('rd-year-table');
        wrap.hidden = !wrap.hidden;
        tableToggle.setAttribute('aria-expanded', wrap.hidden ? 'false' : 'true');
        tableToggle.textContent = wrap.hidden ? 'Show as table' : 'Hide table';
    });
    drawChart();

    // ── Grid / center explainer ─────────────────────────────────
    // Side view (x-z) of a vortex tilted downtilt to the east. One grid bar
    // per level; the selected framework decides which center each bar follows.
    var FRAMES = {
        original: {
            title: 'Original analysis grid',
            prefix: ['swath_*', 'merged_*'],
            center: 'The real-time center fix used when the analysis was made (original_fix_latitude, original_fix_longitude). The grid does not move with the analyzed center.',
            coords: 'merged_latitudes, merged_longitudes (merged file); original_latitudes, original_longitudes (swath file), on the latitude and longitude dimensions',
            use: 'Placing features on the Earth and comparing with other observations, such as satellite imagery, dropsondes, and flight-level data.'
        },
        recentered: {
            title: 'Low-level recentered',
            prefix: ['recentered_*'],
            center: 'The analyzed 2-km TC center. Every level shares it, so the vortex tilt stays in the field.',
            coords: 'eastward_distance and northward_distance (km from the 2-km center, ±200 km); recentered_latitudes, recentered_longitudes',
            use: 'Storm-centered composites and azimuthal means near the surface, and structure relative to the low-level center, such as convection relative to shear and tilt.'
        },
        tilt: {
            title: 'Tilt-relative',
            prefix: ['total_recentered_*'],
            center: 'The center found at each height. Each level follows its own center, which removes the tilt.',
            coords: 'eastward_distance and northward_distance (km from each level’s center); total_recentered_latitudes, total_recentered_longitudes, which vary with height',
            use: 'Vortex structure at mid and upper levels of tilted storms, for example azimuthal means and RMW profiles that a single low-level center would smear.'
        }
    };
    var fsvg = document.getElementById('rd-frame-svg');
    var detail = document.getElementById('rd-frame-detail');
    var boxes = [];
    // geometry
    var FX = { x0: 70, x1: 420, zTop: 34, zBot: 262 };      // plot box
    var LEVELS = [2, 4, 6, 8, 10];                          // km
    var KM = 18;                                             // px per km of height
    function zpx(z) { return FX.zBot - (z / 12) * (FX.zBot - FX.zTop); }
    var C2 = 200;                                            // 2-km center x
    function cx(z) { var d = Math.max(z - 2, 0); return C2 + 1.6 * d * d + 4 * d; }   // tilt axis
    var FIXX = 166;                                          // real-time fix x
    var HALF = 48;                                           // half-width of a grid bar

    function buildDiagram() {
        if (!fsvg) return;
        var g = svg('g');
        // height axis
        g.appendChild(svg('line', { 'class': 'fd-axis', x1: FX.x0 - 30, x2: FX.x0 - 30, y1: FX.zTop, y2: FX.zBot }));
        [0, 2, 4, 6, 8, 10, 12].forEach(function (z) {
            var t = svg('text', { 'class': 'fd-text', x: FX.x0 - 36, y: zpx(z) + 4, 'text-anchor': 'end' }); t.textContent = z;
            g.appendChild(t);
        });
        var zl = svg('text', { 'class': 'fd-text', x: 4, y: 14 }); zl.textContent = 'height (km)'; g.appendChild(zl);
        // sea surface
        g.appendChild(svg('line', { 'class': 'fd-axis', x1: FX.x0 - 30, x2: FX.x1, y1: zpx(0), y2: zpx(0) }));
        // reference lines: real-time fix, 2-km center
        g.appendChild(svg('line', { 'class': 'fd-fix', x1: FIXX, x2: FIXX, y1: zpx(0), y2: FX.zTop }));
        var fl = svg('text', { 'class': 'fd-text', x: FIXX - 4, y: zpx(0) + 16, 'text-anchor': 'end' }); fl.textContent = 'real-time fix'; g.appendChild(fl);
        g.appendChild(svg('line', { 'class': 'fd-ref', x1: C2, x2: C2, y1: zpx(0), y2: FX.zTop, 'stroke-opacity': '0.45' }));
        var cl = svg('text', { 'class': 'fd-text', x: C2 + 4, y: zpx(0) + 16 }); cl.textContent = '2-km center'; g.appendChild(cl);
        // grid bars (drawn before the axis so centers sit on top)
        LEVELS.forEach(function (z) {
            var y = zpx(z);
            var box = svg('rect', { 'class': 'fd-box', x: -HALF, y: y - 7, width: 2 * HALF, height: 14, rx: 3 });
            var tick = svg('line', { 'class': 'fd-tick', x1: 0, x2: 0, y1: y - 10, y2: y + 10 });
            g.appendChild(box); g.appendChild(tick);
            boxes.push({ z: z, box: box, tick: tick });
        });
        // tilt axis and level centers
        var d = '';
        for (var z = 2; z <= 10.01; z += 0.25) d += (d ? 'L' : 'M') + cx(z).toFixed(1) + ',' + zpx(z).toFixed(1);
        g.appendChild(svg('path', { 'class': 'fd-tiltline', d: d }));
        LEVELS.forEach(function (z) { g.appendChild(svg('circle', { 'class': 'fd-center', cx: cx(z), cy: zpx(z), r: 4.5 })); });
        // above the top bar, so no grid position covers it
        var tl = svg('text', { 'class': 'fd-strong', x: 436, y: zpx(11.3), 'text-anchor': 'end' });
        tl.textContent = 'vortex center at each height';
        g.appendChild(tl);
        var cap = svg('text', { 'class': 'fd-text', x: FX.x0 - 30, y: 292 }); cap.textContent = 'Shaded bars: the analysis grid at each height; the tick marks its center.'; g.appendChild(cap);
        fsvg.appendChild(g);
    }
    function setFrame(name) {
        var f = FRAMES[name];
        boxes.forEach(function (b) {
            var x = name === 'original' ? FIXX : name === 'recentered' ? C2 : cx(b.z);
            var tr = 'translate(' + x.toFixed(1) + 'px, 0px)';
            b.box.style.transform = tr; b.tick.style.transform = tr;
        });
        Array.prototype.forEach.call(document.querySelectorAll('.rd-frame-btn'), function (b) {
            b.setAttribute('aria-pressed', b.getAttribute('data-frame') === name ? 'true' : 'false');
        });
        if (!detail) return;
        detail.innerHTML = '';
        var dl = el('dl');
        [['Variables', f.prefix.join(', ')], ['Centered on', f.center], ['Coordinates', f.coords], ['Best for', f.use]].forEach(function (p) {
            dl.appendChild(el('dt', null, p[0]));
            var dd = el('dd', null, p[1]);
            dl.appendChild(dd);
        });
        detail.appendChild(dl);
    }
    buildDiagram();
    setFrame('recentered');
    Array.prototype.forEach.call(document.querySelectorAll('.rd-frame-btn'), function (b) {
        b.addEventListener('click', function () { setFrame(b.getAttribute('data-frame')); });
    });

    // ── Variable browser ────────────────────────────────────────
    var GROUPS = [
        ['all', 'All'],
        ['original', 'Radar: original grid'],
        ['recentered', 'Radar: low-level recentered'],
        ['tilt', 'Radar: tilt-relative'],
        ['vortex', 'Vortex structure'],
        ['case', 'Case and time'],
        ['masks', 'Land masks'],
        ['ships', 'Best track and SHIPS-style'],
        ['era5', 'ERA5 environment'],
        ['dims', 'Dimensions']
    ];
    var DIM_SHORT = { num_cases: 'case', northward_distance: 'y', eastward_distance: 'x', latitude: 'lat', longitude: 'lon', ships_lag_times: 'lag' };
    var vstate = { q: '', file: 'all', group: 'all' };
    var vars = [];
    var vbody = document.getElementById('rd-vbody');
    var chipBox = document.getElementById('rd-vchips');
    var vcount = document.getElementById('rd-vcount');

    // "m s**-1" / "kg m-2" -> "m s⁻¹" / "kg m⁻²" (time units like "seconds since ..." left alone)
    var SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
    function prettyUnits(u) {
        if (!u || /since/.test(u)) return u;
        return u.replace(/\*\*/g, '').replace(/([A-Za-z])(-?\d+)(?=\s|$)/g, function (m, a, n) {
            return a + n.split('').map(function (ch) { return SUP[ch]; }).join('');
        });
    }
    function dimText(dims) { return '(' + dims.map(function (d) { return DIM_SHORT[d] || d; }).join(', ') + ')'; }
    function matches(v, ignoreGroup) {
        if (vstate.file !== 'all' && !v.files[vstate.file]) return false;
        if (!ignoreGroup && vstate.group !== 'all' && v.group !== vstate.group) return false;
        if (!vstate.q) return true;
        var hay = (v.name + ' ' + v.long_name + ' ' + v.units + ' ' + v.notes).toLowerCase();
        return vstate.q.split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
    }
    function renderChips() {
        chipBox.innerHTML = '';
        GROUPS.forEach(function (g) {
            var n = vars.filter(function (v) { return matches(v, true) && (g[0] === 'all' || v.group === g[0]); }).length;
            var b = el('button', { type: 'button', 'class': 'rd-chip', 'aria-pressed': vstate.group === g[0] ? 'true' : 'false' }, g[1]);
            b.appendChild(el('span', null, String(n)));
            b.addEventListener('click', function () { vstate.group = g[0]; renderVars(); });
            chipBox.appendChild(b);
        });
    }
    function renderVars() {
        if (!vars.length) return;
        renderChips();
        var rows = vars.filter(function (v) { return matches(v, false); });
        vcount.textContent = rows.length + ' of ' + vars.length + ' variables';
        vbody.innerHTML = '';
        if (!rows.length) {
            var tr0 = el('tr'); tr0.appendChild(el('td', { colspan: '4', 'class': 'rd-empty' }, 'No variables match. Try another word or clear the filters.'));
            vbody.appendChild(tr0); return;
        }
        var frag = document.createDocumentFragment();
        rows.forEach(function (v) {
            var tr = el('tr');
            var td1 = el('td');
            var nb = el('button', { type: 'button', 'class': 'rd-vname', title: 'Copy name' }, v.name);
            nb.addEventListener('click', function () { copyText(v.name, nb, 'rd-copied'); });
            td1.appendChild(nb);
            tr.appendChild(td1);
            var td2 = el('td');
            td2.appendChild(el('span', { 'class': 'rd-vdesc' }, v.long_name || '—'));
            if (v.notes) td2.appendChild(el('span', { 'class': 'rd-vnote' }, v.notes));
            if (v.packed) td2.appendChild(el('span', { 'class': 'rd-vnote' }, 'Stored as 16-bit integers, scale factor ' + v.packed.scale_factor + ' (unpacked on read)'));
            tr.appendChild(td2);
            // short unit strings stay on one line; stype_ships's units are a sentence
            tr.appendChild(el('td', (v.units || '').length <= 20 ? { 'class': 'rd-units' } : null, prettyUnits(v.units) || '—'));
            var td4 = el('td', { 'class': 'rd-dims' });
            var fm = v.files.merged, fs = v.files.swath;
            if (fm && fs && fm.join() === fs.join()) {
                td4.appendChild(document.createTextNode(dimText(fm)));
                if (vstate.file === 'all') { td4.appendChild(el('br')); td4.appendChild(el('span', { 'class': 'rd-tag' }, 'both files')); }
            } else {
                [['merged', fm], ['swath', fs]].forEach(function (p, i) {
                    if (!p[1] || (vstate.file !== 'all' && vstate.file !== p[0])) return;
                    if (td4.childNodes.length) td4.appendChild(el('br'));
                    td4.appendChild(el('b', null, p[0] === 'merged' ? 'Merged ' : 'Swath '));
                    td4.appendChild(document.createTextNode(dimText(p[1])));
                });
            }
            tr.appendChild(td4);
            frag.appendChild(tr);
        });
        vbody.appendChild(frag);
    }
    var search = document.getElementById('rd-vsearch');
    var qTimer = null;
    if (search) search.addEventListener('input', function () {
        clearTimeout(qTimer);
        qTimer = setTimeout(function () { vstate.q = search.value.trim().toLowerCase(); renderVars(); }, 120);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#variables .rd-seg button'), function (b) {
        b.addEventListener('click', function () {
            vstate.file = b.getAttribute('data-file');
            Array.prototype.forEach.call(b.parentNode.children, function (o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
            renderVars();
        });
    });
    fetch(CATALOG_URL).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    }).then(function (cat) {
        vars = cat.variables;
        renderVars();
    }).catch(function () {
        vbody.innerHTML = '';
        var tr = el('tr'); tr.appendChild(el('td', { colspan: '4', 'class': 'rd-empty' }, 'The variable list could not be loaded. Run ncdump -h on either file to list every variable.'));
        vbody.appendChild(tr);
    });

    // ── In-page nav: highlight the section in view ──────────────
    var links = Array.prototype.slice.call(document.querySelectorAll('.rd-toc a[href^="#"]'));
    if ('IntersectionObserver' in window && links.length) {
        var byId = {};
        links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                if (!e.isIntersecting) return;
                links.forEach(function (a) { a.classList.remove('rd-current'); });
                var a = byId[e.target.id];
                if (a) {
                    a.classList.add('rd-current');
                    var nav = a.parentNode;
                    if (nav.scrollWidth > nav.clientWidth) nav.scrollLeft = a.offsetLeft - 24;
                }
            });
        }, { rootMargin: '-45% 0px -50% 0px' });
        Object.keys(byId).forEach(function (id) { var s = document.getElementById(id); if (s) io.observe(s); });
    }
})();
