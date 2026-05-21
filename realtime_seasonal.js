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
    // Same hostname realtime_ir.js uses for /ir-monitor/* endpoints; we
    // call /seasonal/daily off it for the Daily Panel B view.
    var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';

    // Per-region cache for the Daily view. clim + trend + currentYear are
    // small enough to keep loaded for the session; the heavier region
    // all-years payload is fetched lazily and keyed by region.
    var dailyCache = {
        clim: null,            // clim_daily_1991_2020.json
        trend: null,           // trend_daily_1982_present.json
        currentYear: null,     // indices_daily_current_year.json
        regionAll: {},         // { atl_mdr: { dates, sst, anom, anom_rel } }
        regionAllInFlight: {}, // dedup concurrent fetches
    };

    // State, populated by the first activation
    var state = {
        indices: null,         // parsed indices_monthly.json
        ace: null,             // parsed ace_annual.json
        latest: null,          // parsed latest.json (may be null)
        activated: false,
        scatter: { x: 'atl_mdr', y: 'atl_amo', month: 5, variable: 'sst' },
        // Panel D defaults to 'relative' — Vecchi-Soden framing is what
        // this panel is for (TC potential-intensity literature).
        corr: { basin: 'NA', month: 5, kind: 'relative',
                stat: 'pearson', overlayYear: '' },
        // Default to Daily resolution with all-years history — Daily is
        // the more informative view for TC research (sub-monthly anomaly
        // events, ~13 extra days of detail near "now", true climatology
        // shape), and the full 1982-present gray spaghetti gives the
        // user the visual context for where this year sits across the
        // historical envelope. The all-years payload is ~70 KB gzip
        // through the /seasonal/daily API — fine within broadband
        // budget on first paint.
        ts: { region: 'atl_mdr', variable: 'sst', history: 'all',
              highlight: 'none', resolution: 'daily' },
        an: { year: null, month: 5, regions: 'all',
              method: 'grid_weighted', basin: 'NA', kind: 'relative',
              stat: 'pearson', topN: 'auto' },
        idx: { window: '10', variable: 'anom' },
        anomZoom: 'global',
        anomVar: 'raw',     // Panel A: 'raw' | 'relative' | 'shear_climo'
        // Calendar month for ERA5 climatology view. Defaults to UTC
        // "now"; user-selectable when in shear_climo mode.
        anomMonth: (new Date()).getUTCMonth() + 1,
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

    function _ga(eventName, params) {
        try { if (typeof gtag === 'function') gtag('event', eventName, params || {}); } catch (e) {}
    }

    function _bindAnomZoomControl() {
        var sel = document.getElementById('seasonal-anom-zoom');
        if (!sel || sel._bound) return;
        sel._bound = true;
        sel.addEventListener('change', function () {
            state.anomZoom = sel.value;
            _applyAnomZoom();
            _ga('rt_seasonal_anom_zoom', { zoom: sel.value });
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
                _ga('rt_seasonal_subnav', { panel: a.dataset.target });
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

    // Remove any "No data." / "Plotly not loaded." stub left behind by an
    // earlier (pre-data) render. Plotly.react reuses existing Plotly DOM
    // but doesn't touch siblings the app injected via innerHTML, so the
    // stub would otherwise float in front of the freshly drawn chart.
    function _clearStub(el) {
        if (!el) return;
        var stub = el.querySelector('.seasonal-panel-stub');
        if (stub) stub.remove();
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

        // Mapping from base variable to its "projected" sibling.
        var projVar =
              state.scatter.variable === 'sst'    ? '_sst_projected'
            : state.scatter.variable === 'anom'   ? '_anom_projected'
            : state.scatter.variable === 'sst_rel' ? '_sst_rel_projected'
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
        // Distinct blue for the user-picked highlight year on Panel B —
        // sits between the gray history band and the orange current year.
        highlight: '#3a8dde',
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
            BRAND.hoverBg = 'rgba(20,25,32,0.94)';
            BRAND.hoverBorder = 'rgba(140,148,160,0.40)';
            BRAND.hoverText = '#e6edf5';
        } else {
            // Light mode: axis labels need to be near-black, gridlines a bit
            // darker than dark-mode's so they're visible on white.
            BRAND.text = '#1a1f25';
            BRAND.textDim = '#475569';
            BRAND.grid = 'rgba(20,30,45,0.10)';
            BRAND.gridZero = 'rgba(20,30,45,0.35)';
            BRAND.plotBg = 'rgba(0,0,0,0.015)';
            BRAND.hoverBg = 'rgba(255,255,255,0.96)';
            BRAND.hoverBorder = 'rgba(20,30,45,0.20)';
            BRAND.hoverText = '#1a1f25';
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
            _ga('rt_seasonal_save_png', { panel: filenameBase });
            var now = new Date();
            var stamp = now.toISOString().slice(0, 16).replace(/[:T-]/g, '');
            // Saved PNG matches the user's current viewing theme.
            // Dark-mode users get a dark figure (often desired for
            // social/Slack sharing); light-mode users get the publication
            // look. We force an opaque paper bg for the snapshot so the
            // PNG isn't transparent (otherwise it'd composite onto
            // whatever app's background the user pastes into).
            var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            var saveOverride = isDark
                ? { paper_bgcolor: '#0d1117', plot_bgcolor: '#0d1117' }
                : { paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff' };
            window.Plotly.relayout(plot, saveOverride).then(function () {
                // scale: 2 gives ~2× the on-screen pixel density — usable
                // for both web sharing and 6-inch print at 200+ DPI.
                // Min width 1400 / height 800 ensures we never ship a
                // sub-publication-quality snapshot even from a small
                // viewport.
                window.Plotly.downloadImage(plot, {
                    format: 'png',
                    filename: 'TC-ATLAS_' + filenameBase + '_' + stamp,
                    width: Math.max(plot.clientWidth, 1400),
                    height: Math.max(plot.clientHeight, 800),
                    scale: 2,
                }).then(function () {
                    // Restore the live theme — _refreshTheme + re-render
                    // is the cleanest way to undo every override.
                    _refreshTheme();
                    _renderScatter();
                    _renderTimeSeries();
                    _renderIndices();
                });
            });
        });
        panel.appendChild(btn);
    }

    // Lazy-load html2canvas for the image/HTML panels (A, D, E). Mirrors
    // the loader in realtime_ir.js so cold first click is a single CDN
    // fetch; subsequent saves are instant.
    function _ensureHtml2canvas() {
        if (window.html2canvas) return Promise.resolve();
        if (window._html2canvasPending) return window._html2canvasPending;
        window._html2canvasPending = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('html2canvas load failed')); };
            document.head.appendChild(s);
        });
        return window._html2canvasPending;
    }

    function _stampTcAtlasWatermark(canvas, panelWidthPx) {
        var ctx = canvas.getContext('2d');
        var scale = canvas.width / Math.max(1, panelWidthPx);
        var pad = Math.round(12 * scale);
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        // Dark-on-light in light mode, light-on-dark in dark mode — same
        // semantics as the Plotly watermark annotations.
        var brand = isDark ? 'rgba(220,228,238,0.70)' : 'rgba(40,55,75,0.55)';
        var url   = isDark ? 'rgba(220,228,238,0.45)' : 'rgba(40,55,75,0.42)';
        ctx.save();
        // html2canvas leaves a non-identity transform on the context
        // (scale + translation matching the captured DOM region) — drop
        // it so our watermark coords are interpreted in raw canvas pixels.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.textAlign = 'right';
        ctx.fillStyle = brand;
        ctx.font = '600 ' + Math.round(11 * scale) +
                   'px "DM Sans", system-ui, sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText('TC-ATLAS', canvas.width - pad, pad);
        ctx.fillStyle = url;
        ctx.font = '400 ' + Math.round(9 * scale) +
                   'px "DM Sans", system-ui, sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillText('michaelfischerwx.github.io/TC-ATLAS',
                     canvas.width - pad, canvas.height - pad / 2);
        ctx.restore();
    }

    // Replace every <select> in the cloned doc with a <span> showing its
    // selected option text. html2canvas runs against this clone so the
    // live DOM is untouched. Without this, the saved PNG renders empty/
    // truncated dropdown boxes (the browser owns the value text via the
    // UA shadow tree, which html2canvas can't see).
    function _swapSelectsForCapture(clonedDoc) {
        var selects = clonedDoc.querySelectorAll('select');
        for (var i = 0; i < selects.length; i++) {
            var sel = selects[i];
            var opt = sel.options[sel.selectedIndex];
            var label = opt ? opt.textContent : '';
            var span = clonedDoc.createElement('span');
            span.textContent = label;
            // Inline styling so we don't depend on global CSS that
            // html2canvas may interpret differently. Mirrors the look
            // of the existing <select> styling on the live page.
            span.style.cssText = [
                'display:inline-block',
                'min-width:120px',
                'padding:4px 10px',
                'font-size:0.75rem',
                'font-weight:500',
                'border:1px solid rgba(140,148,160,0.35)',
                'border-radius:4px',
                'background:rgba(255,255,255,0.04)',
                'color:inherit',
                'white-space:nowrap',
                'vertical-align:middle',
            ].join(';');
            sel.parentNode.replaceChild(span, sel);
        }
    }

    // Save-button for image/HTML panels (A, D, E) — uses html2canvas to
    // rasterize the whole .seasonal-panel (minus the button itself), then
    // bakes the TC-ATLAS watermark onto the canvas. Matches the look of
    // the Plotly-panel save (B, C, F).
    function _addPanelImageSaveBtn(panelId, filenameBase) {
        var panel = document.getElementById(panelId);
        if (!panel || panel.querySelector('.seasonal-save-btn')) return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'seasonal-save-btn';
        btn.title = 'Save panel as PNG';
        btn.setAttribute('aria-label', 'Save panel as PNG');
        btn.textContent = '⤓';
        btn.setAttribute('data-html2canvas-ignore', 'true');
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            _ga('rt_seasonal_save_png', { panel: filenameBase });
            var origLabel = btn.textContent;
            btn.textContent = '…';
            btn.disabled = true;
            // Capture the saved image in the current viewing theme so a
            // dark-mode user gets a dark figure and a light-mode user
            // gets a light one. (#0d1117 mirrors the seasonal-main
            // surface in dark mode; #ffffff for the light theme.)
            var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            _ensureHtml2canvas().then(function () {
                return window.html2canvas(panel, {
                    useCORS: true,
                    allowTaint: false,
                    backgroundColor: isDark ? '#0d1117' : '#ffffff',
                    logging: false,
                    scale: 2,
                    ignoreElements: function (el) {
                        return el.classList &&
                               el.classList.contains('seasonal-save-btn');
                    },
                    // html2canvas can't render the text inside native
                    // <select> widgets — the dropdown value comes from
                    // the browser's UA shadow tree. We use the onclone
                    // hook (which mutates a forked DOM that won't touch
                    // the live page) to swap each <select> with a styled
                    // <span> containing its currently-selected option's
                    // text, so the saved PNG legibly shows the config.
                    onclone: _swapSelectsForCapture,
                });
            }).then(function (canvas) {
                _stampTcAtlasWatermark(canvas, panel.offsetWidth);
                return new Promise(function (resolve, reject) {
                    canvas.toBlob(function (blob) {
                        if (!blob) return reject(
                            new Error('Canvas produced no blob (CORS taint?)'));
                        resolve(blob);
                    }, 'image/png');
                });
            }).then(function (blob) {
                var ts = new Date().toISOString()
                    .replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = filenameBase + '_' + ts + '.png';
                document.body.appendChild(a); a.click();
                document.body.removeChild(a);
                setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
            }).catch(function (err) {
                console.error('[seasonal] save failed', err);
                alert("Couldn't save PNG: " +
                      (err && err.message ? err.message : err));
            }).then(function () {
                btn.textContent = origLabel;
                btn.disabled = false;
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
        if (key.endsWith('_sst_rel')) return monLabel + ' ' + label + ' relative SST (°C, vs 30°S-30°N)';
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
        // Plotly.react reuses existing Plotly DOM but doesn't wipe an
        // app-injected stub — clear it here before painting fresh.
        _clearStub(el);

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
                     : (state.scatter.variable === 'sst_rel') ? 'relative SST (Vecchi-Soden)'
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
            margin: { l: 60, r: 10, t: 60, b: 100 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: BRAND.plotBg,
            font: { color: BRAND.text, family: 'DM Sans, system-ui, sans-serif',
                    size: 11 },
            showlegend: !!(bundle.current && bundle.current.preliminary),
            // Legend below the plot — on narrow viewports the title wraps
            // onto a second line and would collide with a top-anchored
            // legend (matches the Panels B / F convention).
            legend: {
                font: { size: 13 }, orientation: 'h',
                x: 0, y: -0.22, xanchor: 'left', yanchor: 'top',
                bgcolor: 'rgba(0,0,0,0)',
            },
            hovermode: 'closest',
            hoverlabel: {
                bgcolor: BRAND.hoverBg,
                bordercolor: BRAND.hoverBorder,
                font: { color: BRAND.hoverText,
                        family: 'DM Sans, system-ui, sans-serif',
                        size: 11 },
            },
            annotations: _watermarkAnnotations(),
        };
        // Suppress legend entries from the historical-cloud trace
        traces[0].showlegend = false;
        // Inset map: region boxes drawn on a second `geo` subplot
        // (geo2) embedded in the top-left of the figure. Lives with
        // the scatter for PNG export + avoids modebar conflict.
        var insetTraces = _scatterInsetBuildTraces();
        var allTraces = traces.concat(insetTraces);
        layout.geo2 = _insetGeoLayout();
        Plotly.react(el, allTraces, layout,
                     { responsive: true, displaylogo: false });
    }

    // Builds the inset-map traces + geo subplot layout for Panel C.
    // The inset is now drawn inside the main scatter figure as a
    // secondary `geo` subplot pinned to the top-left corner, so it
    // (a) doesn't conflict with Plotly's modebar in the top-right,
    // (b) saves into the PNG export, and (c) avoids the wrong-side
    // fill-rendering Plotly does for scattergeo `fill: toself`
    // polygons (which made the Y-axis box look like it covered most
    // of the globe).
    function _regionBoxTrace(boxArr, color, label, geoAxis) {
        if (!boxArr) return null;
        var ls = boxArr[0], ln = boxArr[1], lw = boxArr[2], le = boxArr[3];
        var conv = function (lo) { return lo > 180 ? lo - 360 : lo; };
        var lonW = conv(lw), lonE = conv(le);
        // Densify latitude edges so the parallels don't bow under
        // great-circle interpolation. Meridian edges are 2-point.
        var STEPS = 24;
        var lons = [], lats = [];
        for (var i = 0; i <= STEPS; i++) {
            lons.push(lonW + (i / STEPS) * (lonE - lonW));
            lats.push(ls);
        }
        lons.push(lonE); lats.push(ln);
        for (var j = 1; j <= STEPS; j++) {
            lons.push(lonE - (j / STEPS) * (lonE - lonW));
            lats.push(ln);
        }
        lons.push(lonW); lats.push(ls);
        return {
            type: 'scattergeo', mode: 'lines',
            geo: geoAxis || 'geo2',
            lon: lons, lat: lats,
            line: { color: color, width: 2.5 },
            name: label, hoverinfo: 'skip',
            showlegend: false,
        };
    }

    function _scatterInsetBuildTraces() {
        var xLabel = 'X · ' + (REGION_LABEL[state.scatter.x] || state.scatter.x);
        var yLabel = 'Y · ' + (REGION_LABEL[state.scatter.y] || state.scatter.y);
        return [
            _regionBoxTrace(REGION_BOX[state.scatter.x], BRAND.orange, xLabel, 'geo2'),
            _regionBoxTrace(REGION_BOX[state.scatter.y], BRAND.green,  yLabel, 'geo2'),
        ].filter(Boolean);
    }

    function _timeSeriesInsetBuildTraces() {
        // Single-region inset for Panel B — just the selected region in
        // brand orange (matches the current-year time-series color).
        var label = REGION_LABEL[state.ts.region] || state.ts.region;
        return [
            _regionBoxTrace(REGION_BOX[state.ts.region], BRAND.orange, label, 'geo2'),
        ].filter(Boolean);
    }

    // Pick a non-overlapping inset corner for Panel B based on where the
    // current region/variable's climatological peak lives in the calendar.
    // Variables whose peak falls in late summer-autumn (SST, MPI, RH, TCWV,
    // ζ850) keep the original upper-LEFT placement so the inset sits over
    // the sparser Jan-Feb portion of the chart. Variables whose peak falls
    // in winter (shear, u200, u850) swap to upper-RIGHT so the inset sits
    // over the (low-data) summer trough months instead.
    function _pickInsetDomain() {
        var DEFAULT_LEFT  = { x: [0.005, 0.22],  y: [0.78, 1.005] };
        var DEFAULT_RIGHT = { x: [0.78,  0.995], y: [0.78, 1.005] };
        var region = state.ts.region;
        var variable = state.ts.variable;
        // Resolve which monthly climatology series to inspect. ERA5 vars
        // live in state.era5; SST vars in state.indices.
        var clim = null;
        if (_isEra5Var(variable) && state.era5) {
            var src = state.era5;
            clim = (src.values || {})[region + '_' + variable];
        } else if (state.indices && state.indices.values) {
            // Maps frontend `sst_rel` → server `anom_rel`; same for `anom`.
            var key = (variable === 'anom')     ? '_anom'
                    : (variable === 'sst_rel')  ? '_anom_rel'
                    : (variable === 'sst_dt')   ? '_anom'   // detrended uses anom climo
                    :                              '_sst';
            clim = state.indices.values[region + key];
        }
        if (!Array.isArray(clim)) return DEFAULT_LEFT;
        // Find the month (1..12) with the highest |value| — what would
        // collide with an upper-corner inset.
        var peakMo = 1, peakAbs = -1;
        for (var i = 0; i < 12; i++) {
            var v = clim[i];
            if (v == null) continue;
            var a = Math.abs(v);
            if (a > peakAbs) { peakAbs = a; peakMo = i + 1; }
        }
        // Peak Jan-Jun → place inset on the RIGHT (chart's right side is
        // the safer Jul-Dec for these variables). Peak Jul-Dec → keep
        // LEFT (safer Jan-Jun side).
        return (peakMo <= 6) ? DEFAULT_RIGHT : DEFAULT_LEFT;
    }

    function _insetGeoLayout(domain) {
        var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        // Default domain = Panel C's original top-left placement.
        var dom = domain || { x: [0.005, 0.245], y: [0.74, 1.005] };
        return {
            domain: dom,
            projection: { type: 'equirectangular' },
            showland: true,
            landcolor: isDark ? 'rgba(85,95,108,0.65)' : 'rgba(170,180,194,0.75)',
            showocean: true,
            oceancolor: isDark ? 'rgba(15,22,35,0.75)' : 'rgba(225,232,242,0.85)',
            showcountries: false,
            showcoastlines: true,
            coastlinecolor: isDark ? 'rgba(180,190,205,0.50)' : 'rgba(85,95,108,0.65)',
            coastlinewidth: 0.5,
            lonaxis: { showgrid: false, range: [-180, 180] },
            lataxis: { showgrid: false, range: [-65, 75] },
            bgcolor: isDark ? 'rgba(13,17,23,0.85)' : 'rgba(255,255,255,0.90)',
            resolution: 110,
            framecolor: 'rgba(140,148,160,0.40)',
            framewidth: 1,
        };
    }

    // -------------------------------------------------------------------
    // Panel B — Region SST evolution time series
    // -------------------------------------------------------------------

    // ERA5 path: data already in the per-year / climatology shape from
    // build_era5_indices.py. We just bucket it into the same shape
    // the renderer expects (byYear[y] = [12], climMean[12], climStd[12]).
    function _buildEra5TimeSeriesData() {
        if (!state.era5) return null;
        var e = state.era5;
        var key = state.ts.region + '_' + state.ts.variable;

        var byYear = {};
        var projByYear = {};
        var preliminaryByYear = {};
        var years = Object.keys(e.by_year || {})
            .map(Number).sort(function (a, b) { return a - b; });
        years.forEach(function (y) {
            var row = e.by_year[String(y)] && e.by_year[String(y)][key];
            if (!row) return;
            byYear[y] = row.slice();
            projByYear[y] = [null,null,null,null,null,null,null,null,null,null,null,null];
            preliminaryByYear[y] = [false,false,false,false,false,false,false,false,false,false,false,false];
        });

        var climMean = (e.values && e.values[key])
            ? e.values[key].slice() : [null,null,null,null,null,null,null,null,null,null,null,null];
        var climStd  = (e.std && e.std[key])
            ? e.std[key].slice()    : [null,null,null,null,null,null,null,null,null,null,null,null];

        return {
            byYear: byYear,
            projByYear: projByYear,
            preliminaryByYear: preliminaryByYear,
            years: years.filter(function (y) { return byYear[y]; }),
            climMean: climMean,
            climStd: climStd,
        };
    }

    function _buildTimeSeriesData() {
        // ERA5 monthly variables (MPI, DLS, RH700, χ200, ζ850, TCWV)
        // come from a separate precomputed payload; the shape is
        // different (by-year buckets + climo mean/std already split out)
        // so dispatch to a dedicated builder.
        if (_isEra5Var(state.ts.variable)) {
            return _buildEra5TimeSeriesData();
        }
        if (!state.indices) return null;
        var idx = state.indices;
        var key = state.ts.region + '_' + state.ts.variable;
        var vals = idx.values[key];
        if (!vals) return null;

        // Projected (full-month extrapolated) values share the same
        // column suffix conventions as Panel C.
        var projKey = state.ts.region + (
            state.ts.variable === 'sst' ? '_sst_projected' :
            state.ts.variable === 'anom' ? '_anom_projected' :
            state.ts.variable === 'sst_rel' ? '_sst_rel_projected' :
            '_sst_dt_projected'
        );
        var projVals = idx.values[projKey] || [];

        // Bucket monthly values by year (12 entries per year, NaN where missing).
        var byYear = {};
        var projByYear = {};
        var preliminaryByYear = {};
        for (var i = 0; i < idx.dates.length; i++) {
            var parts = idx.dates[i].split('-');
            var y = parseInt(parts[0], 10);
            var m = parseInt(parts[1], 10);
            if (!(y in byYear)) {
                byYear[y] = [null, null, null, null, null, null,
                             null, null, null, null, null, null];
                projByYear[y] = [null, null, null, null, null, null,
                                 null, null, null, null, null, null];
                preliminaryByYear[y] = [false, false, false, false, false, false,
                                        false, false, false, false, false, false];
            }
            byYear[y][m - 1] = vals[i];
            projByYear[y][m - 1] = projVals[i] !== undefined ? projVals[i] : null;
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
            projByYear: projByYear,
            preliminaryByYear: preliminaryByYear,
            years: years,
            climMean: climMean,
            climStd: climStd,
        };
    }

    // Dispatcher: monthly is the historical default; daily kicks in
    // when the user toggles the new resolution control. Daily is async
    // because the first render fetches the climatology + trend + live
    // current-year JSONs from GCS.
    //
    // Plotly.react has trouble going from the monthly 50+ traces (with
    // an inset geo2) to the daily 6 traces (also with an inset geo2):
    // it accepts the new data into `_fullData` but doesn't repaint the
    // DOM children, leaving an empty chart with the right state. Force
    // a clean purge whenever resolution changes — fast, and only fires
    // on the toggle itself (not on every region/variable change).
    function _renderTimeSeries() {
        var el = document.getElementById('seasonal-ts-plot');
        // ERA5 fields are monthly only — switch the resolution toggle
        // *before* the lazy-load decision so the post-load re-entry
        // doesn't go down the daily code path on a stale resolution.
        if (_isEra5Var(state.ts.variable) && state.ts.resolution === 'daily') {
            state.ts.resolution = 'monthly';
            var sel = document.getElementById('seasonal-ts-resolution');
            if (sel) sel.value = 'monthly';
        }
        // ERA5 monthly variables are precomputed offline (build_era5_indices.py
        // + build_era5_shear_indices.py). Lazy-load the JSON the first time
        // the user picks one. Guard the recursion with `_era5LoadAttempted`:
        // a failed load sets state.era5 = null, and without this flag we'd
        // re-trigger the load on every render attempt and lock the page
        // in an infinite loop (Chrome kills the tab after ~10 seconds).
        if (_isEra5Var(state.ts.variable) && !state.era5 && !_era5LoadAttempted) {
            _era5LoadAttempted = true;
            if (el) {
                el.innerHTML = '<div class="seasonal-panel-stub">'
                    + 'Loading ERA5 monthly indices…</div>';
            }
            return _loadEra5Indices().then(function () { _renderTimeSeries(); });
        }
        // If the ERA5 load already failed, paint a clear error stub and
        // stop. Don't try to render — the downstream _buildEra5TimeSeriesData
        // would just return null repeatedly.
        if (_isEra5Var(state.ts.variable) && !state.era5 && _era5LoadAttempted) {
            if (el) {
                el.innerHTML = '<div class="seasonal-panel-stub">'
                    + 'ERA5 monthly indices not available '
                    + '(data/indices_monthly_era5_shear.json not deployed yet).</div>';
            }
            return;
        }
        if (el && state.ts._lastResolution &&
            state.ts._lastResolution !== state.ts.resolution &&
            el.classList.contains('js-plotly-plot') &&
            typeof Plotly !== 'undefined') {
            Plotly.purge(el);
        }
        state.ts._lastResolution = state.ts.resolution;
        if (state.ts.resolution === 'daily') {
            return _renderTimeSeriesDaily();
        }
        return _renderTimeSeriesMonthly();
    }

    function _renderTimeSeriesMonthly() {
        var el = document.getElementById('seasonal-ts-plot');
        if (!el || typeof Plotly === 'undefined') return;
        var bundle = _buildTimeSeriesData();
        if (!bundle) {
            el.innerHTML = '<div class="seasonal-panel-stub">No data.</div>';
            return;
        }
        _clearStub(el);
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

        // Populate the highlight-year picker (lazily — only once data
        // exists and only when the select still has just the "None" stub).
        _populateHighlightYears(bundle.years, currentYear);

        var highlightYear = parseInt(state.ts.highlight, 10);
        var hasHighlight = !isNaN(highlightYear) && bundle.byYear[highlightYear];

        // Historical years (subtle gray, thin) — exclude current year AND
        // the user-picked highlight year (drawn separately, bolder).
        var histYears = bundle.years.filter(function (y) {
            if (y === currentYear) return false;
            if (hasHighlight && y === highlightYear) return false;
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

        // Highlighted historical year — bold blue line above the gray
        // background, below the current-year orange.
        if (hasHighlight) {
            traces.push({
                type: 'scatter', mode: 'lines+markers',
                x: months, y: bundle.byYear[highlightYear],
                line: { color: BRAND.highlight, width: 2.8 },
                marker: { size: 6, color: BRAND.highlight,
                          line: { color: '#1a1f25', width: 1 } },
                name: String(highlightYear) + ' (highlighted)',
                hovertemplate: highlightYear + ' · %{x}: %{y:.2f}<extra></extra>',
            });
        }

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
            var proj = bundle.projByYear[currentYear] || [];
            var prelim = bundle.preliminaryByYear[currentYear];
            var prelimMonths = [], prelimVals = [];
            var projMonths = [], projVals = [];
            for (var k = 0; k < 12; k++) {
                if (prelim[k] && cur[k] !== null) {
                    prelimMonths.push(k + 1);
                    prelimVals.push(cur[k]);
                }
                if (prelim[k] && proj[k] !== null && proj[k] !== undefined
                    && cur[k] !== null && Math.abs(proj[k] - cur[k]) > 0.0001) {
                    // Only show the projected marker when it diverges
                    // from MTD (anomaly view collapses them; absolute
                    // SST and detrended differ).
                    projMonths.push(k + 1);
                    projVals.push(proj[k]);
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
                        ' · %{x}: %{y:.2f} (MTD)<extra></extra>',
                });
            }
            if (projMonths.length) {
                // Filled magenta-style star at the projected full-month
                // value — matches the marker convention used on Panel C.
                traces.push({
                    type: 'scatter', mode: 'markers',
                    x: projMonths, y: projVals,
                    marker: {
                        symbol: 'star', size: 18,
                        color: BRAND.orange,
                        line: { color: '#fff', width: 2 },
                    },
                    name: 'projected full-month',
                    hovertemplate: currentYear +
                        ' · %{x}: %{y:.2f} (projected, persistence-anom extrapolation)<extra></extra>',
                });
                // Thin dotted connector MTD ↔ projected, exactly like
                // Panel C does, so the magnitude of extrapolation is
                // visible at a glance.
                for (var pm = 0; pm < projMonths.length; pm++) {
                    traces.push({
                        type: 'scatter', mode: 'lines',
                        x: [projMonths[pm], projMonths[pm]],
                        y: [prelimVals[pm] !== undefined
                              ? prelimVals[pm] : null, projVals[pm]],
                        line: { color: 'rgba(251,146,60,0.55)', width: 1, dash: 'dot' },
                        hoverinfo: 'skip', showlegend: false,
                    });
                }
            }
        }

        var label = REGION_LABEL[state.ts.region] || state.ts.region;
        var era5Meta = state.era5 && state.era5.fields
            && state.era5.fields[state.ts.variable];
        // Compact y-axis labels per ERA5 variable. The full long_name +
        // units gets too long for the axis (e.g., "Max potential intensity
        // (Bister-Emanuel) (m s⁻¹)") and crowds the plot. Keep the long
        // name in the title; use a short tag on the y-axis.
        var ERA5_Y_LABELS = {
            mpi:    'MPI (m s⁻¹)',
            rh700:  '700-hPa RH (%)',
            chi200: 'χ at 200 hPa (10⁶ m² s⁻¹)',
            vo850:  'ζ at 850 hPa (10⁻⁵ s⁻¹)',
            tcwv:   'TCWV (kg m⁻²)',
            shear:  'Deep-layer shear (m s⁻¹)',
            u200:   'u at 200 hPa (m s⁻¹)',
            u850:   'u at 850 hPa (m s⁻¹)',
        };
        var varLabel, yLabel;
        if (era5Meta) {
            varLabel = era5Meta.long_name + ' (' + era5Meta.units + ')';
            yLabel = ERA5_Y_LABELS[state.ts.variable] || varLabel;
        } else {
            varLabel = (state.ts.variable === 'anom') ? 'SST anomaly (°C)'
                     : (state.ts.variable === 'sst_dt') ? 'detrended SST (°C)'
                     : (state.ts.variable === 'sst_rel') ? 'relative SST vs 30°S-30°N (°C)'
                     : 'SST (°C)';
            yLabel = varLabel;
        }
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
                title: { text: yLabel,
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
            hoverlabel: {
                bgcolor: BRAND.hoverBg,
                bordercolor: BRAND.hoverBorder,
                font: { color: BRAND.hoverText,
                        family: 'DM Sans, system-ui, sans-serif',
                        size: 11 },
            },
            showlegend: true,
            legend: {
                font: { size: 13 }, orientation: 'h',
                yanchor: 'top', y: -0.18, x: 0, xanchor: 'left',
                bgcolor: 'rgba(0,0,0,0)',
            },
            annotations: _watermarkAnnotations(),
        };
        // Region inset — mirrors Panel C. Top-right corner so it doesn't
        // sit on top of the current-year line which usually hugs the
        // left half of the chart (Jan-Jun); also dodges the modebar
        // since the modebar is hover-only and positioned over the inset
        // anyway.
        var insetTraces = _timeSeriesInsetBuildTraces();
        var allTraces = traces.concat(insetTraces);
        // Upper-LEFT placement keeps the inset off the Aug-Nov peak
        // region that every TC-relevant variable (SST, MPI, RH700, TCWV)
        // climbs into, and matches the Daily-mode placement at line ~1747
        // for consistency across resolutions.
        layout.geo2 = _insetGeoLayout(_pickInsetDomain());
        Plotly.react(el, allTraces, layout,
                     { responsive: true, displaylogo: false });
    }

    // -------------------------------------------------------------------
    // Panel B — DAILY view (day-of-year evolution across the calendar year)
    // -------------------------------------------------------------------

    // Cumulative days in a leap year through end of previous month.
    // Jan = 0, Feb = 31, Mar = 60, ..., Dec = 335. _leapDoy(month, day) =
    // _LEAP_DOY_CUM[month - 1] + day. Matches the Python helper of the
    // same name in build_oisst_history.py.
    var _LEAP_DOY_CUM = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];

    function _leapDoy(month, day) {
        return _LEAP_DOY_CUM[month - 1] + day;
    }

    function _isLeapYear(y) {
        return (y % 4 === 0) && (y % 100 !== 0 || y % 400 === 0);
    }

    // X-axis tick anchors. First-of-month in leap-year frame; non-leap
    // years from Mar onward sit one DOY shy (handled per-trace).
    var _MONTH_TICK_LEAP = [1, 32, 61, 92, 122, 153, 183, 214, 245, 275, 306, 336];
    var _MONTH_NAMES_FULL = ['Jan','Feb','Mar','Apr','May','Jun',
                             'Jul','Aug','Sep','Oct','Nov','Dec'];

    function _doysForYear(year, dateStrs) {
        // Map a list of YYYY-MM-DD strings to the leap-year DOY axis. In
        // a non-leap year, March 1 = leap-DOY 61 (not 60), so the curve
        // simply has no point at leap-DOY 60.
        var out = new Array(dateStrs.length);
        for (var i = 0; i < dateStrs.length; i++) {
            var s = dateStrs[i];
            var m = parseInt(s.substring(5, 7), 10);
            var d = parseInt(s.substring(8, 10), 10);
            out[i] = _leapDoy(m, d);
        }
        return out;
    }

    function _fetchSeasonalDailyClim() {
        if (dailyCache.clim) return Promise.resolve(dailyCache.clim);
        return _fetchData('clim_daily_1991_2020.json').then(function (j) {
            dailyCache.clim = j;
            return j;
        });
    }

    function _fetchSeasonalDailyTrend() {
        if (dailyCache.trend) return Promise.resolve(dailyCache.trend);
        return _fetchData('trend_daily_1982_present.json').then(function (j) {
            dailyCache.trend = j;
            return j;
        });
    }

    function _fetchSeasonalDailyCurrentYear() {
        if (dailyCache.currentYear) return Promise.resolve(dailyCache.currentYear);
        return _fetchData('indices_daily_current_year.json').then(function (j) {
            dailyCache.currentYear = j;
            return j;
        });
    }

    // Per-region full-history slice. Goes through the API — the parquet
    // stays server-side. Returns the same shape regardless of region:
    // { dates: [], sst: [], anom: [], anom_rel: [] }
    function _fetchSeasonalDailyRegionAll(region) {
        if (dailyCache.regionAll[region]) {
            return Promise.resolve(dailyCache.regionAll[region]);
        }
        if (dailyCache.regionAllInFlight[region]) {
            return dailyCache.regionAllInFlight[region];
        }
        var url = API_BASE + '/ir-monitor/seasonal/daily?region=' +
                  encodeURIComponent(region) + '&year=all';
        var p = fetch(url, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
            return r.json();
        }).then(function (j) {
            dailyCache.regionAll[region] = j;
            delete dailyCache.regionAllInFlight[region];
            return j;
        }).catch(function (e) {
            delete dailyCache.regionAllInFlight[region];
            throw e;
        });
        dailyCache.regionAllInFlight[region] = p;
        return p;
    }

    // For each (region, variable, year), produce a numeric values array
    // aligned to the leap-year DOY axis (366 long). Missing days are
    // `null` so Plotly draws gaps; non-leap-year DOY-60 is always null.
    function _yearSeriesToLeapAxis(dates, values) {
        var out = new Array(366);
        for (var i = 0; i < 366; i++) out[i] = null;
        for (var k = 0; k < dates.length; k++) {
            var s = dates[k];
            var m = parseInt(s.substring(5, 7), 10);
            var d = parseInt(s.substring(8, 10), 10);
            var ld = _leapDoy(m, d);
            // Each year contributes ≤ 1 value per DOY, so direct assign.
            out[ld - 1] = (values[k] === undefined) ? null : values[k];
        }
        return out;
    }

    // Group an all-years payload (flat dates[] + var arrays) into a
    // per-year matrix: { year: { sst: [366], anom: [366], anom_rel: [366] } }.
    function _groupRegionAllByYear(payload) {
        var byYear = {};
        var dates = payload.dates || [];
        for (var i = 0; i < dates.length; i++) {
            var y = parseInt(dates[i].substring(0, 4), 10);
            if (!byYear[y]) {
                byYear[y] = { dates: [], sst: [], anom: [], anom_rel: [] };
            }
            byYear[y].dates.push(dates[i]);
            byYear[y].sst.push(payload.sst ? payload.sst[i] : null);
            byYear[y].anom.push(payload.anom ? payload.anom[i] : null);
            byYear[y].anom_rel.push(
                payload.anom_rel ? payload.anom_rel[i] : null);
        }
        var leap = {};
        Object.keys(byYear).forEach(function (yk) {
            var y = parseInt(yk, 10);
            leap[y] = {
                sst:      _yearSeriesToLeapAxis(byYear[y].dates, byYear[y].sst),
                anom:     _yearSeriesToLeapAxis(byYear[y].dates, byYear[y].anom),
                anom_rel: _yearSeriesToLeapAxis(byYear[y].dates, byYear[y].anom_rel),
            };
        });
        return { byYear: byYear, leap: leap };
    }

    // Detrended SST = sst - (slope * year + intercept), using per-DOY
    // smoothed trend coefficients. Returns a leap-axis-aligned array.
    function _detrendedLeapSeries(year, sstLeap, trendForRegion) {
        var slope = trendForRegion && trendForRegion.sst && trendForRegion.sst.slope;
        var intercept = trendForRegion && trendForRegion.sst &&
                        trendForRegion.sst.intercept;
        if (!slope || !intercept) return new Array(366).fill(null);
        var out = new Array(366);
        for (var i = 0; i < 366; i++) {
            var s = sstLeap[i];
            var sl = slope[i];
            var it = intercept[i];
            if (s === null || s === undefined ||
                sl === null || sl === undefined ||
                it === null || it === undefined) {
                out[i] = null;
            } else {
                out[i] = s - (sl * year + it);
            }
        }
        return out;
    }

    // Variable → column-name picker for the JSON payloads we fetch.
    // Note `sst_rel` in the frontend maps to `anom_rel` server-side
    // (matches the parquet schema).
    function _dailyVarKey(variable) {
        if (variable === 'sst')     return 'sst';
        if (variable === 'anom')    return 'anom';
        if (variable === 'sst_rel') return 'anom_rel';
        if (variable === 'sst_dt')  return null;   // computed client-side
        return 'sst';
    }

    function _renderTimeSeriesDaily() {
        var el = document.getElementById('seasonal-ts-plot');
        if (!el || typeof Plotly === 'undefined') return;
        // First-paint stub while the small JSONs load.
        if (!dailyCache.clim || !dailyCache.currentYear) {
            el.innerHTML =
                '<div class="seasonal-panel-stub">Loading daily climatology…</div>';
        }

        var region = state.ts.region;
        var variable = state.ts.variable;
        var wantHistory = state.ts.history !== 'none';

        var loaders = [
            _fetchSeasonalDailyClim(),
            _fetchSeasonalDailyCurrentYear(),
            _fetchSeasonalDailyTrend(),
        ];
        if (wantHistory || state.ts.highlight !== 'none') {
            loaders.push(_fetchSeasonalDailyRegionAll(region));
        }

        Promise.all(loaders).then(function (results) {
            // Re-check selections in case the user changed them while
            // the fetch was in flight; if so, defer to the newer render.
            if (state.ts.region !== region || state.ts.variable !== variable ||
                state.ts.resolution !== 'daily') {
                return;
            }
            var clim = results[0], cy = results[1], trend = results[2];
            var regionAll = (results.length >= 4)
                ? _groupRegionAllByYear(results[3]) : null;

            _drawDailyChart(el, region, variable, clim, cy, trend, regionAll);
        }).catch(function (e) {
            // Don't trample the panel if the user already switched back
            // to Monthly (or to a different region/variable) while the
            // failed fetch was in flight.
            if (state.ts.resolution !== 'daily' ||
                state.ts.region !== region ||
                state.ts.variable !== variable) {
                return;
            }
            el.innerHTML =
                '<div class="seasonal-panel-stub seasonal-status-error">' +
                'Failed to load daily data: ' + e.message + '</div>';
        });
    }

    function _drawDailyChart(el, region, variable, clim, cy, trend, regionAll) {
        _clearStub(el);
        var traces = [];
        var currentYear = (new Date()).getUTCFullYear();
        var doys = [];
        for (var i = 1; i <= 366; i++) doys.push(i);

        // Populate the highlight-year picker from the daily payload's
        // year coverage. _populateHighlightYears is the same function the
        // monthly path uses; it no-ops if already populated, so calling it
        // here is safe regardless of which mode the user enters first.
        if (regionAll && regionAll.leap) {
            var availableYears = Object.keys(regionAll.leap).map(Number);
            _populateHighlightYears(availableYears, currentYear);
        }

        var varKey = _dailyVarKey(variable);          // 'sst' | 'anom' | 'anom_rel' | null
        var isDetrended = (variable === 'sst_dt');

        // ----- Climatology envelope (±1σ around mean) -----
        var climReg = clim.values[region];
        var climMean = null, climStd = null;
        if (isDetrended) {
            // Detrended mean is identically zero by construction; std is
            // precomputed in the trend blob (per-DOY detrended std).
            var trReg = trend.values[region];
            if (trReg && trReg.sst && trReg.sst.detrended_std) {
                climMean = new Array(366).fill(0);
                climStd  = trReg.sst.detrended_std;
            }
        } else if (climReg && climReg[varKey]) {
            climMean = climReg[varKey].mean;
            climStd  = climReg[varKey].std;
        }

        var hasClim = !!(climMean && climStd);
        if (hasClim) {
            var upper = climMean.map(function (m, i) {
                if (m === null || climStd[i] === null) return null;
                return m + climStd[i];
            });
            var lower = climMean.map(function (m, i) {
                if (m === null || climStd[i] === null) return null;
                return m - climStd[i];
            });
            traces.push({
                type: 'scatter', mode: 'lines', x: doys, y: upper,
                line: { color: 'transparent', width: 0 },
                showlegend: false, hoverinfo: 'skip',
                connectgaps: true,   // bridge leap-DOY 60 in non-leap years
            });
            traces.push({
                type: 'scatter', mode: 'lines', x: doys, y: lower,
                fill: 'tonexty', fillcolor: BRAND.green_dim,
                line: { color: 'transparent', width: 0 },
                showlegend: true, hoverinfo: 'skip',
                connectgaps: true,   // bridge leap-DOY 60 in non-leap years
                name: '1991-2020 ±1σ envelope (7-day smooth)',
            });
        }

        var highlightYear = parseInt(state.ts.highlight, 10);
        var hasHighlight = !isNaN(highlightYear);

        // ----- Historical years (gray spaghetti) -----
        if (regionAll && state.ts.history !== 'none') {
            var years = Object.keys(regionAll.leap).map(Number)
                            .sort(function (a, b) { return a - b; });
            var minYear = state.ts.history === 'recent10'
                ? currentYear - 10 : -Infinity;
            var firstShown = true;
            for (var yi = 0; yi < years.length; yi++) {
                var y = years[yi];
                if (y === currentYear) continue;
                if (hasHighlight && y === highlightYear) continue;
                if (y < minYear) continue;
                var ya = regionAll.leap[y];
                var yVals;
                if (isDetrended) {
                    yVals = _detrendedLeapSeries(y, ya.sst, trend.values[region]);
                } else {
                    yVals = ya[varKey];
                }
                traces.push({
                    type: 'scatter', mode: 'lines', x: doys, y: yVals,
                    line: { color: BRAND.gray, width: 1 },
                    showlegend: firstShown,
                    legendgroup: 'history',
                    name: 'historical years (1982-' + (currentYear - 1) + ')',
                    hovertemplate: y + ' · DOY %{x}: %{y:.2f}<extra></extra>',
                    connectgaps: true,   // bridge leap-DOY 60 in non-leap years
                });
                firstShown = false;
            }
        }

        // ----- Highlight year (bold blue line) -----
        if (hasHighlight && regionAll && regionAll.leap[highlightYear]) {
            var ha = regionAll.leap[highlightYear];
            var hVals = isDetrended
                ? _detrendedLeapSeries(highlightYear, ha.sst, trend.values[region])
                : ha[varKey];
            traces.push({
                type: 'scatter', mode: 'lines', x: doys, y: hVals,
                line: { color: BRAND.highlight, width: 2.4 },
                name: String(highlightYear) + ' (highlighted)',
                hovertemplate: highlightYear +
                    ' · DOY %{x}: %{y:.2f}<extra></extra>',
                connectgaps: true,   // bridge leap-DOY 60 in non-leap years
            });
        }

        // ----- Climatology mean line -----
        if (hasClim) {
            traces.push({
                type: 'scatter', mode: 'lines', x: doys, y: climMean,
                line: { color: BRAND.green_line, width: 2.5 },
                name: '1991-2020 mean',
                hovertemplate: 'Climatology · DOY %{x}: %{y:.2f}<extra></extra>',
                connectgaps: true,   // bridge leap-DOY 60 in non-leap years
            });
        }

        // ----- Current year (orange), with preliminary tail -----
        if (cy && cy.values && cy.dates && cy.dates.length) {
            var cyDates = cy.dates;
            var cySrc;
            if (isDetrended) {
                var sstLeap = _yearSeriesToLeapAxis(cyDates,
                    cy.values[region + '_sst'] || []);
                cySrc = _detrendedLeapSeries(currentYear, sstLeap,
                                             trend.values[region]);
            } else {
                var colName = region + '_' + varKey;
                cySrc = _yearSeriesToLeapAxis(cyDates,
                    cy.values[colName] || []);
            }
            // Preliminary tail: every day within OISST's ~14-day
            // finalization window may still be revised by NOAA's
            // re-analysis. The cutoff is computed against the JSON
            // sidecar's `as_of` timestamp (not "today") so a stale
            // cron doesn't make a day that's already been finalized
            // look preliminary. Conservative by design: any day past
            // the cutoff is dotted, even if it happens to have come
            // from the final endpoint already.
            var PRELIM_LAG_DAYS = 14;
            var asOfMs = (cy && cy.as_of)
                ? Date.parse(cy.as_of)
                : Date.now();
            var cutoffMs = asOfMs - PRELIM_LAG_DAYS * 86400000;
            var cutoffD = new Date(cutoffMs);
            var cutoffDoy = _leapDoy(cutoffD.getUTCMonth() + 1,
                                     cutoffD.getUTCDate());
            var populated = [];
            for (var pi = 0; pi < 366; pi++) {
                if (cySrc[pi] !== null && cySrc[pi] !== undefined) {
                    populated.push(pi);
                }
            }
            // populated stores zero-based indices; cutoffDoy is 1-based.
            // A day is preliminary iff its leap-DOY (pi + 1) > cutoffDoy.
            var prelimDoys = populated.filter(function (pi) {
                return (pi + 1) > cutoffDoy;
            });
            var finalDoys = populated.filter(function (pi) {
                return (pi + 1) <= cutoffDoy;
            });
            var finalY = new Array(366).fill(null);
            var prelimY = new Array(366).fill(null);
            for (var fi = 0; fi < finalDoys.length; fi++) {
                finalY[finalDoys[fi]] = cySrc[finalDoys[fi]];
            }
            // Include the join point in the preliminary trace so the
            // line is visually continuous.
            var joinIdx = finalDoys.length
                ? finalDoys[finalDoys.length - 1] : -1;
            if (joinIdx >= 0) prelimY[joinIdx] = cySrc[joinIdx];
            for (var pi2 = 0; pi2 < prelimDoys.length; pi2++) {
                prelimY[prelimDoys[pi2]] = cySrc[prelimDoys[pi2]];
            }
            traces.push({
                type: 'scatter', mode: 'lines', x: doys, y: finalY,
                line: { color: BRAND.orange_line, width: 2.6 },
                name: String(currentYear) + ' (so far)',
                hovertemplate: currentYear +
                    ' · DOY %{x}: %{y:.2f}<extra></extra>',
                connectgaps: true,   // bridge leap-DOY 60 in non-leap years
            });
            if (prelimDoys.length) {
                traces.push({
                    type: 'scatter', mode: 'lines', x: doys, y: prelimY,
                    line: { color: BRAND.orange_line, width: 2.6,
                            dash: 'dot' },
                    opacity: 0.7,
                    name: 'last ~14 days (preliminary)',
                    hovertemplate: currentYear +
                        ' · DOY %{x}: %{y:.2f} (preliminary — OISST may revise)<extra></extra>',
                    connectgaps: true,   // bridge leap-DOY 60 in non-leap years
                });
            }
        }

        // ----- Layout -----
        var label = REGION_LABEL[region] || region;
        var varLabel =
              variable === 'anom'    ? 'SST anomaly (°C)'
            : variable === 'sst_dt'  ? 'detrended SST (°C)'
            : variable === 'sst_rel' ? 'relative SST vs 30°S-30°N (°C)'
            :                          'SST (°C)';
        // Tick positions: leap-frame first-of-month anchors. In a
        // non-leap year, March-onward x labels visually represent the
        // same calendar day; the leap-DOY=60 gap is invisible at the
        // chart's display resolution.
        var layout = {
            title: {
                text: label + ' — daily ' + varLabel +
                      ' (' + currentYear + ' vs 1982-' + (currentYear - 1) + ')',
                font: { size: 15, family: 'DM Sans, system-ui, sans-serif',
                        weight: 600 },
                xanchor: 'left', x: 0.01,
            },
            xaxis: {
                title: { text: 'Day of year',
                         font: { size: 11, color: BRAND.textDim } },
                tickmode: 'array',
                tickvals: _MONTH_TICK_LEAP,
                ticktext: _MONTH_NAMES_FULL,
                range: [1, 366],
                zeroline: false,
                gridcolor: BRAND.grid,
                tickfont: { size: 11 },
            },
            yaxis: {
                title: { text: varLabel,
                         font: { size: 11, color: BRAND.textDim } },
                zeroline: variable !== 'sst',
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
            hoverlabel: {
                bgcolor: BRAND.hoverBg,
                bordercolor: BRAND.hoverBorder,
                font: { color: BRAND.hoverText,
                        family: 'DM Sans, system-ui, sans-serif',
                        size: 11 },
            },
            showlegend: true,
            legend: {
                font: { size: 13 }, orientation: 'h',
                yanchor: 'top', y: -0.18, x: 0, xanchor: 'left',
                bgcolor: 'rgba(0,0,0,0)',
            },
            annotations: _watermarkAnnotations(),
        };
        var insetTraces = _timeSeriesInsetBuildTraces();
        // Daily view: 12 months of data across the chart, so the upper-
        // right corner (Aug-Oct) is exactly where late-season SST peaks
        // and warm-anomaly highlight years (e.g. 2023) cluster. Tuck the
        // inset into the upper-LEFT — early-Jan to mid-Feb is the
        // sparsest region for both `sst` (winter minimum at the bottom
        // of the chart) and the anomaly variants (most years near zero
        // and concentrated below the inset's y range).
        layout.geo2 = _insetGeoLayout(_pickInsetDomain());
        Plotly.react(el, traces.concat(insetTraces), layout,
                     { responsive: true, displaylogo: false });
    }

    function _bindTimeSeriesControls() {
        var bind = function (id, key) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function () {
                state.ts[key] = el.value;
                _renderTimeSeries();
                _ga('rt_seasonal_ts', { key: key, value: el.value });
            });
        };
        bind('seasonal-ts-region', 'region');
        bind('seasonal-ts-var', 'variable');
        bind('seasonal-ts-history', 'history');
        bind('seasonal-ts-highlight', 'highlight');
        bind('seasonal-ts-resolution', 'resolution');
    }

    function _populateHighlightYears(years, currentYear) {
        var sel = document.getElementById('seasonal-ts-highlight');
        if (!sel || sel.options.length > 1) return;
        var frag = document.createDocumentFragment();
        // Newest → oldest, exclude the current (in-progress) year.
        var sorted = years.slice().sort(function (a, b) { return b - a; });
        for (var i = 0; i < sorted.length; i++) {
            if (sorted[i] === currentYear) continue;
            var opt = document.createElement('option');
            opt.value = String(sorted[i]);
            opt.textContent = String(sorted[i]);
            frag.appendChild(opt);
        }
        sel.appendChild(frag);
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

        // Distance/weight key combines kind + stat (Pearson vs Spearman).
        var matrixKey = kind + (state.an.stat === 'spearman' ? '_spearman' : '');

        // --- Grid-weighted (default): use the precomputed n_year × n_year
        //     pairwise distance matrix from analog_distance_matrices.json.
        if (method === 'grid_weighted' && state.distance_matrices) {
            var dm = state.distance_matrices.basins[basin];
            var mEntry = dm && dm[String(month)];
            if (mEntry) {
                var idxOfYear = mEntry.years.indexOf(targetYear);
                if (idxOfYear < 0) {
                    // Fallback: when target is the LIVE preliminary year
                    // for the LIVE month, the daily cron has written a
                    // distance vector from MTD anomaly → every historical
                    // year. Use it so users see real rankings instead of
                    // "no data" the moment they pick 2026 in May.
                    var prelim = state.prelim_distances;
                    if (prelim && prelim.year === targetYear &&
                        prelim.month === month) {
                        var pBasin = prelim.basins[basin];
                        var pVec = pBasin && pBasin[matrixKey];
                        if (pVec) {
                            var pranked = Object.keys(pVec).map(function (k) {
                                return { year: parseInt(k, 10), dist: pVec[k] };
                            });
                            pranked.sort(function (a, b) { return a.dist - b.dist; });
                            return {
                                years: pranked.map(function (r) { return r.year; }).concat([targetYear]),
                                rows: pranked.slice(0, (state.an.resolvedTopN || 10)),
                                targetYear: targetYear,
                                method: 'grid_weighted',
                                preliminary: true,
                                preliminary_note:
                                    'Distances computed from this month\'s ' +
                                    'partial-month-to-date anomaly via the ' +
                                    'persistence-anomaly extrapolation. ' +
                                    'Updates daily as new days come in.',
                            };
                        }
                    }
                    return { years: mEntry.years, rows: [],
                             unavailableReason:
                                 'Target year ' + targetYear +
                                 ' has no finalized SST for ' + month +
                                 '; pick a finalized year (' +
                                 mEntry.years[0] + '-' +
                                 mEntry.years[mEntry.years.length - 1] +
                                 ') or switch to a region method.' };
                }
                var distRow = mEntry[matrixKey][idxOfYear];
                var ranked = mEntry.years.map(function (y, i) {
                    return { year: y, dist: distRow[i] };
                }).filter(function (r) { return r.year !== targetYear; });
                ranked.sort(function (a, b) { return a.dist - b.dist; });
                return {
                    years: mEntry.years,
                    rows: ranked.slice(0, (state.an.resolvedTopN || 10)),
                    targetYear: targetYear,
                    method: 'grid_weighted',
                };
            }
            // Fall through to region method if matrix isn't loaded.
        }

        // Map detrending mode → column suffix for the region-based methods.
        // 'raw'        → _anom    (anomaly vs 1991-2020 climo)
        // 'detrended'  → _sst_dt  (year deviation from linear-in-year trend)
        // 'relative'   → _sst_rel (region SST minus 30°S-30°N mean, Vecchi-Soden)
        var valSuffix = (kind === 'detrended') ? '_sst_dt'
                      : (kind === 'relative')  ? '_sst_rel'
                      : '_anom';

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
                var w = (entry && entry[matrixKey] !== null && entry[matrixKey] !== undefined)
                    ? Math.abs(entry[matrixKey]) : 0;
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
            rows: ranked.slice(0, (state.an.resolvedTopN || 10)),
            targetYear: targetYear,
            targetPreliminary: preliminaryFlag[targetYear],
            weights: weights,
            regions: regions,
        };
    }

    // ------------------------------------------------------------------
    // Leave-one-out skill for the current Panel E settings.
    //
    // For each historical year Y in the corpus:
    //   - drop Y, find its top-10 analogs using the SAME method/basin/
    //     kind/region-set the user has selected
    //   - predict Y's ACE = mean ACE of those analogs
    //   - error = predicted - actual
    // MAE / RMSE / bias of these errors describe the skill of the
    // analog-averaging method as a forecast tool at this month. Lets
    // users compare e.g. May raw vs May relative vs Aug raw and see
    // that mid-season SST patterns predict ACE much better than
    // pre-season ones.
    // ------------------------------------------------------------------
    function _computeAnalogSkill(aceLookup) {
        var basin = state.an.basin;
        var month = state.an.month;
        var kind = state.an.kind;
        var method = state.an.method;
        var topN = 10;

        // Build the list of historical years with both anomaly data
        // and basin ACE available.
        var years = [];
        var aceVec = {};
        // Source the year list from the distance-matrix when available
        // (grid_weighted), else from the indices.
        var seed = (state.distance_matrices
                    && state.distance_matrices.basins[basin]
                    && state.distance_matrices.basins[basin][String(month)])
                 || null;
        var seedYears = seed ? seed.years : null;
        if (seedYears) {
            seedYears.forEach(function (y) {
                var rec = aceLookup(y);
                if (rec && rec.ace !== null && rec.ace !== undefined) {
                    years.push(y);
                    aceVec[y] = rec.ace;
                }
            });
        }
        if (!years.length) return null;

        // Compute pairwise distance for the chosen method.
        // For grid_weighted: read the precomputed matrix row.
        // For region methods: replicate the loop in _buildAnalogs but
        // for every year (LOO is trivial — each year is the "target"
        // in turn).
        var matKey = kind + (state.an.stat === 'spearman' ? '_spearman' : '');

        function distRowGrid(yi) {
            var m = seed[matKey];
            if (!m) return null;
            return m[yi];
        }

        function distRowRegion(yi) {
            // Reproduce the region-vector and weight setup used by
            // _buildAnalogs. For LOO we recompute distances from years[yi]
            // to all other years using the SAME method/weight set.
            var regions = REGION_SETS[state.an.regions] || REGION_SETS.all;
            var valSuffix = (kind === 'detrended') ? '_sst_dt'
                          : (kind === 'relative')  ? '_sst_rel'
                          : '_anom';
            var idx = state.indices;
            // Cache vectors per year.
            if (!_cachedRegionVecs ||
                _cachedRegionVecs.month !== month ||
                _cachedRegionVecs.regions !== state.an.regions ||
                _cachedRegionVecs.kind !== kind) {
                var v = {};
                for (var i = 0; i < idx.dates.length; i++) {
                    var parts = idx.dates[i].split('-');
                    var y = parseInt(parts[0], 10);
                    var mm = parseInt(parts[1], 10);
                    if (mm !== month) continue;
                    var vec = [];
                    var anyNull = false;
                    for (var r = 0; r < regions.length; r++) {
                        var val = idx.values[regions[r] + valSuffix][i];
                        if (val === null || val === undefined) { anyNull = true; break; }
                        vec.push(val);
                    }
                    if (!anyNull) v[y] = vec;
                }
                _cachedRegionVecs = { month: month, regions: state.an.regions,
                                     kind: kind, vecs: v };
            }
            // Weights
            var ws = new Array(regions.length);
            if (method === 'corr_weighted' && state.region_corr) {
                var perRegion = (state.region_corr.basins[basin] || {})[String(month)] || {};
                var sumW = 0;
                for (var k = 0; k < regions.length; k++) {
                    var entry = perRegion[regions[k]];
                    var w = (entry && entry[matKey] !== null && entry[matKey] !== undefined)
                        ? Math.abs(entry[matKey]) : 0;
                    ws[k] = w; sumW += w;
                }
                if (sumW > 0) {
                    for (var k2 = 0; k2 < regions.length; k2++) ws[k2] /= sumW;
                } else {
                    for (var k3 = 0; k3 < regions.length; k3++) ws[k3] = 1 / regions.length;
                }
            } else {
                for (var k4 = 0; k4 < regions.length; k4++) ws[k4] = 1 / regions.length;
            }
            var Y = years[yi];
            var t = _cachedRegionVecs.vecs[Y];
            if (!t) return null;
            var out = new Array(years.length);
            for (var jj = 0; jj < years.length; jj++) {
                var Yj = years[jj];
                if (Yj === Y) { out[jj] = 0; continue; }
                var vj = _cachedRegionVecs.vecs[Yj];
                if (!vj) { out[jj] = NaN; continue; }
                var s2 = 0;
                for (var rr = 0; rr < regions.length; rr++) {
                    var d = vj[rr] - t[rr];
                    s2 += ws[rr] * d * d;
                }
                out[jj] = Math.sqrt(s2);
            }
            return out;
        }

        // Step 1: build a sorted-pairs list for each year (Y → candidate
        // analogs ranked by distance). Each pair has {year, dist} and
        // dist > 0 since the target year is filtered out.
        var sortedPairsByYear = [];
        for (var i = 0; i < years.length; i++) {
            var rowI, pairsI;
            if (method === 'grid_weighted') {
                rowI = distRowGrid(seedYears.indexOf(years[i]));
                if (!rowI) { sortedPairsByYear.push(null); continue; }
                pairsI = [];
                for (var k = 0; k < seedYears.length; k++) {
                    if (seedYears[k] === years[i]) continue;
                    if (aceVec[seedYears[k]] === undefined) continue;
                    pairsI.push({ year: seedYears[k], dist: rowI[k] });
                }
            } else {
                rowI = distRowRegion(i);
                if (!rowI) { sortedPairsByYear.push(null); continue; }
                pairsI = [];
                for (var k2 = 0; k2 < years.length; k2++) {
                    if (k2 === i) continue;
                    if (!isFinite(rowI[k2])) continue;
                    if (aceVec[years[k2]] === undefined) continue;
                    pairsI.push({ year: years[k2], dist: rowI[k2] });
                }
            }
            pairsI.sort(function (a, b) { return a.dist - b.dist; });
            sortedPairsByYear.push(pairsI);
        }

        // Step 2: sweep N from 3..20 and pick the lowest LOO MAE. This
        // gives the user an empirical answer to "is top-10 better than
        // top-5 for this combination?" — usually different across
        // basin/month/kind. Pre-sorted pairs make this cheap: O(N×Y).
        var Ns = [3, 5, 7, 10, 15, 20];
        var perN = {};
        for (var ni = 0; ni < Ns.length; ni++) {
            var nVal = Ns[ni];
            var errs = [], bias = 0;
            for (var ii = 0; ii < years.length; ii++) {
                var ps = sortedPairsByYear[ii];
                if (!ps || ps.length < nVal / 2) continue;
                var picked = ps.slice(0, nVal);
                var sumA = 0;
                for (var pi = 0; pi < picked.length; pi++) sumA += aceVec[picked[pi].year];
                var pred = sumA / picked.length;
                var err = pred - aceVec[years[ii]];
                errs.push(err);
                bias += err;
            }
            if (!errs.length) continue;
            bias = bias / errs.length;
            var abs = 0, sq = 0;
            for (var e = 0; e < errs.length; e++) {
                abs += Math.abs(errs[e]); sq += errs[e] * errs[e];
            }
            perN[nVal] = {
                n: errs.length,
                mae: abs / errs.length,
                rmse: Math.sqrt(sq / errs.length),
                bias: bias,
            };
        }
        if (!Object.keys(perN).length) return null;

        // Climatology baseline (constant: always predict the mean).
        var mean = 0, mn = 0;
        for (var kk in aceVec) { mean += aceVec[kk]; mn += 1; }
        mean = mean / mn;
        var ac = 0;
        for (var kkk in aceVec) ac += Math.abs(aceVec[kkk] - mean);
        var maeClimo = ac / mn;

        // Best N by MAE.
        var bestN = null, bestMae = Infinity;
        Ns.forEach(function (n) {
            if (perN[n] && perN[n].mae < bestMae) {
                bestN = n; bestMae = perN[n].mae;
            }
        });

        return {
            perN: perN,
            Ns: Ns,
            bestN: bestN,
            mae_climo: maeClimo,
        };
    }
    var _cachedRegionVecs = null;

    function _renderAnalogSkill(bundle, aceLookup) {
        var el = document.getElementById('seasonal-an-skill');
        if (!el) return;
        var skill = _computeAnalogSkill(aceLookup);
        if (!skill) {
            el.innerHTML = '';
            state.an.resolvedTopN = 10;
            return;
        }
        // Resolve which N the table is actually displaying.
        var chosenN = (state.an.topN === 'auto')
            ? skill.bestN
            : parseInt(state.an.topN, 10);
        state.an.resolvedTopN = chosenN;
        var chosen = skill.perN[chosenN] || skill.perN[skill.bestN];
        var ss = 1 - chosen.mae / skill.mae_climo;
        var ssCls = ss > 0.15 ? 'an-skill-good'
                  : ss > 0.0  ? 'an-skill-ok' : 'an-skill-poor';

        // Per-N comparison sparkline: show MAE at each N so the user
        // can SEE that top-3 vs top-10 vs top-20 differ.
        var bestN = skill.bestN;
        var perNHtml = skill.Ns.filter(function (n) { return skill.perN[n]; })
            .map(function (n) {
                var s = skill.perN[n];
                var pct = (1 - s.mae / skill.mae_climo) * 100;
                var mark = (n === bestN) ? '<strong>' : '';
                var emark = (n === bestN) ? '</strong>' : '';
                return mark + 'N=' + n + ': MAE ' + s.mae.toFixed(1) +
                       ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%)' +
                       emark;
            }).join(' · ');

        var bestNote = (state.an.topN === 'auto')
            ? 'Auto-selected <strong>N=' + bestN + '</strong> (lowest MAE).'
            : (chosenN === bestN
                 ? '<strong>N=' + chosenN + '</strong> is also the best LOO MAE for this combination.'
                 : 'Best LOO MAE at <strong>N=' + bestN + '</strong> (MAE ' +
                   skill.perN[bestN].mae.toFixed(1) + '). Set N to "Auto" to use it.');

        el.innerHTML =
            '<div class="' + ssCls + '">' +
            '<strong>Top-' + chosenN + ' analog forecast skill</strong> ' +
            '(leave-one-out, ' + chosen.n + ' years): ' +
            'MAE ' + chosen.mae.toFixed(1) +
            ' · RMSE ' + chosen.rmse.toFixed(1) +
            ' · bias ' + (chosen.bias >= 0 ? '+' : '') + chosen.bias.toFixed(1) +
            ' · skill-vs-climo <strong>' + (ss * 100).toFixed(0) + '%</strong> ' +
            '(climo MAE ' + skill.mae_climo.toFixed(1) + ').<br>' +
            '<span style="opacity:.8">Across N: ' + perNHtml + '</span><br>' +
            bestNote + '</div>';
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

        // Resolve N BEFORE building analogs, so the table reflects the
        // user-selected N (or the auto-best N from LOO sweep). The
        // skill function itself doesn't depend on resolvedTopN; we
        // peek at its result, set state.an.resolvedTopN, then build.
        var skillPre = _computeAnalogSkill(aceLookup);
        if (skillPre) {
            state.an.resolvedTopN = (state.an.topN === 'auto')
                ? skillPre.bestN
                : parseInt(state.an.topN, 10);
        } else {
            state.an.resolvedTopN = (state.an.topN === 'auto') ? 10
                : parseInt(state.an.topN, 10);
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
        var distAcc = 0, aceAcc = 0, stormAcc = 0;
        var aceN = 0, stormN = 0;
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
            distAcc += r.dist;
            if (aceVal !== null && aceVal !== undefined) {
                aceAcc += aceVal; aceN += 1;
            }
            if (storms !== null && storms !== undefined) {
                stormAcc += storms; stormN += 1;
            }
        });

        // Bottom "Average" row: arithmetic mean of the top-10 analogs.
        // The ACE mean is also the analog method's point forecast of
        // the target year's ACE; LOO skill below quantifies how good
        // that forecast is historically.
        if (bundle.rows.length) {
            var n = bundle.rows.length;
            var meanAce = aceN ? (aceAcc / aceN).toFixed(1) : '—';
            var meanStorms = stormN ? (stormAcc / stormN).toFixed(1) : '—';
            html += '<tr class="an-avg-row">' +
                '<td>—</td>' +
                '<td>Average (top ' + n + ')</td>' +
                '<td>' + (distAcc / n).toFixed(3) + '</td>' +
                '<td>' + meanAce + '</td>' +
                '<td>' + meanStorms + '</td>' +
                '</tr>';
        }
        tbody.innerHTML = html;

        // Disable/enable the region-set dropdown depending on method.
        // Grid-weighted uses the full 0.25° SST anomaly field, so the
        // 14-region partition isn't applicable.
        var rsel = document.getElementById('seasonal-an-regions');
        if (rsel) {
            var isGrid = (state.an.method === 'grid_weighted');
            rsel.disabled = isGrid;
            rsel.title = isGrid
                ? 'Grid-weighted method uses the full 0.25° global SST field — no region partition.'
                : 'Restrict the region-mean vector to a subset of regions.';
            var rlabel = rsel.parentElement;
            if (rlabel) rlabel.style.opacity = isGrid ? 0.4 : '';
        }

        // Compute + render leave-one-out skill so users can compare
        // analog methods on the same footing.
        _renderAnalogSkill(bundle, aceLookup);

        // Update the "How analogs are computed" weights summary so the user
        // can see what regions/pixels are dominating the current ranking.
        var summary = document.getElementById('seasonal-an-weights-summary');
        if (summary) {
            if (state.an.method === 'grid_weighted') {
                var kindLabel = (state.an.kind === 'detrended') ? 'detrended'
                              : (state.an.kind === 'relative')  ? 'relative (Vecchi-Soden)'
                              : 'raw';
                summary.innerHTML =
                    '<strong>Pixel-weighted distance</strong> over the full ' +
                    '0.25° SST anomaly field. Each cell\'s weight = ' +
                    '|r(SST<sub>cell</sub>, ' + state.an.basin + ' ACE)| at ' +
                    'month ' + state.an.month + ' (' + kindLabel +
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

    // -------------------------------------------------------------------
    // ERA5 monthly diagnostics — lazy-loaded indices file.
    //
    // build_era5_indices.py precomputes monthly region-mean MPI, DLS,
    // RH700, χ200, ζ850, and TCWV from the gc-atlas tile catalog into a
    // single JSON with the same key conventions as indices_monthly.json
    // (`{region}_{variable}`). Loaded on demand the first time the user
    // picks an ERA5 variable from Panel B's dropdown — keeps the
    // default SST page-load small.
    // -------------------------------------------------------------------
    // 'shear' is the Phase-1 daily-derived product (build_era5_shear_indices.py)
    // shipped in its own JSON. The other five variables live in the
    // monthly-derived indices_monthly_era5.json — same loader interface,
    // different file. Merged into a single in-memory `state.era5` so the
    // downstream byYear / climMean / climStd code is variable-agnostic.
    var ERA5_VAR_KEYS = ['shear', 'mpi', 'rh700', 'chi200', 'vo850', 'tcwv', 'u200', 'u850'];
    function _isEra5Var(v) { return ERA5_VAR_KEYS.indexOf(v) !== -1; }
    var _era5Promise = null;
    // Single-attempt guard: if the lazy ERA5 fetch fails (404 because
    // build_era5_shear_indices.py hasn't run on the deployed branch
    // yet, network glitch, etc.) we set this flag so subsequent
    // _renderTimeSeries calls don't retry indefinitely.
    var _era5LoadAttempted = false;
    function _mergeEra5Payload(target, src) {
        if (!src) return target;
        target = target || { fields: {}, regions: {}, values: {}, std: {}, by_year: {} };
        if (src.fields)  Object.assign(target.fields,  src.fields);
        if (src.regions) Object.assign(target.regions, src.regions);
        if (src.values)  Object.assign(target.values,  src.values);
        if (src.std)     Object.assign(target.std,     src.std);
        if (src.by_year) {
            Object.keys(src.by_year).forEach(function (y) {
                target.by_year[y] = Object.assign(target.by_year[y] || {}, src.by_year[y]);
            });
        }
        return target;
    }
    function _loadEra5Indices() {
        if (state.era5 && state.era5.values
            && Object.keys(state.era5.values).length > 0) {
            return Promise.resolve(state.era5);
        }
        if (_era5Promise) return _era5Promise;
        _era5Promise = Promise.all([
            _fetchData('indices_monthly_era5.json').catch(function () { return null; }),
            _fetchData('indices_monthly_era5_shear.json').catch(function () { return null; }),
        ]).then(function (results) {
            var merged = null;
            results.forEach(function (r) { merged = _mergeEra5Payload(merged, r); });
            // Shear payload doesn't ship a `fields` dict (single-variable
            // file); inject the metadata so the y-axis label code finds it.
            if (merged && !merged.fields.shear) {
                merged.fields.shear = {
                    units: 'm s⁻¹',
                    long_name: 'Deep-layer shear (|V₂₀₀ − V₈₅₀|, daily-derived)',
                };
            }
            state.era5 = merged;
            return merged;
        }).catch(function (err) {
            console.warn('[seasonal] ERA5 indices fetch failed:', err);
            state.era5 = null;
            return null;
        });
        return _era5Promise;
    }

    function _bindAnalogControls() {
        var bindNum = function (id, key) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function () {
                state.an[key] = parseInt(el.value, 10);
                _renderAnalogs();
                _ga('rt_seasonal_analog', { key: key, value: el.value });
            });
        };
        var bindStr = function (id, key) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function () {
                state.an[key] = el.value;
                _renderAnalogs();
                _ga('rt_seasonal_analog', { key: key, value: el.value });
            });
        };
        bindNum('seasonal-an-year', 'year');
        bindNum('seasonal-an-month', 'month');
        bindStr('seasonal-an-regions', 'regions');
        bindStr('seasonal-an-method', 'method');
        bindStr('seasonal-an-basin', 'basin');
        bindStr('seasonal-an-kind', 'kind');
        bindStr('seasonal-an-stat', 'stat');
        bindStr('seasonal-an-topn', 'topN');
    }

    // -------------------------------------------------------------------
    // Panel F — Climate-index dashboard (multi-trace time series)
    // -------------------------------------------------------------------

    // Helper: anomaly of relative SST for a region — subtract the
    // 1991-2020 month-of-year mean of `{region}_sst_rel` so we get a
    // proper "differential anomaly" comparable to anom / sst_dt.
    // Without this step, `_sst_rel` carries the seasonal cycle of
    // (region SST − tropical-mean SST), which swamps the year-to-year
    // signal users want to see on Panel F.
    function _relativeAnomalySeries(region) {
        var idx = state.indices;
        var rel = idx.values[region + '_sst_rel'];
        if (!rel) return null;
        var prelim = idx.preliminary || [];
        // Per-month 1991-2020 climo
        var climSum = [0,0,0,0,0,0,0,0,0,0,0,0];
        var climN = [0,0,0,0,0,0,0,0,0,0,0,0];
        for (var i = 0; i < idx.dates.length; i++) {
            var parts = idx.dates[i].split('-');
            var y = parseInt(parts[0], 10);
            var m = parseInt(parts[1], 10);
            if (y < 1991 || y > 2020) continue;
            if (prelim[i]) continue;
            if (rel[i] === null || rel[i] === undefined) continue;
            climSum[m - 1] += rel[i]; climN[m - 1] += 1;
        }
        var clim = climSum.map(function (s, k) {
            return climN[k] > 0 ? s / climN[k] : 0;
        });
        return rel.map(function (v, i) {
            if (v === null || v === undefined) return null;
            var m = parseInt(idx.dates[i].split('-')[1], 10);
            return v - clim[m - 1];
        });
    }

    function _renderIndices() {
        var el = document.getElementById('seasonal-idx-plot');
        if (!el || typeof Plotly === 'undefined' || !state.indices) return;
        var idx = state.indices;
        var dates = idx.dates;

        // Pick the column suffix that matches the chosen variable.
        // For "relative" we have to derive the anomaly client-side
        // because the raw `_sst_rel` column carries the seasonal cycle.
        var v = state.idx.variable;
        var nino34, amo, nta, tsa;
        if (v === 'sst_dt') {
            nino34 = idx.values.nino34_sst_dt;
            amo = idx.values.atl_amo_sst_dt;
            nta = idx.values.nta_sst_dt;
            tsa = idx.values.tsa_sst_dt;
        } else if (v === 'sst_rel') {
            nino34 = _relativeAnomalySeries('nino34');
            amo = _relativeAnomalySeries('atl_amo');
            nta = _relativeAnomalySeries('nta');
            tsa = _relativeAnomalySeries('tsa');
        } else {
            nino34 = idx.values.nino34_anom;
            amo = idx.values.atl_amo_anom;
            nta = idx.values.nta_anom;
            tsa = idx.values.tsa_anom;
        }
        var prelim = idx.preliminary || [];

        // AMM proxy: NTA - TSA (Vimont/Kossin sign convention; positive
        // means warmer northern tropical Atlantic, favorable for
        // intensification + northward TC track displacement).
        var amm = nta.map(function (val, i) {
            if (val === null || tsa[i] === null) return null;
            return val - tsa[i];
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

        var vLabel = (v === 'sst_dt') ? 'detrended (°C)'
                   : (v === 'sst_rel') ? 'relative-SST anomaly (°C, Vecchi-Soden)'
                   : 'anomaly vs 1991-2020 (°C)';
        var titleTag = (v === 'sst_dt') ? ' — detrended'
                     : (v === 'sst_rel') ? ' — relative SST'
                     : '';
        // ENSO ±0.5 °C reference lines stay regardless of mode — they're
        // useful eyeballing thresholds in any anomaly framing, even if
        // they're literally the El Niño / La Niña convention only in
        // the raw anomaly mode.
        var layout = {
            title: { text: 'Atlantic + Pacific climate indices' + titleTag,
                     font: { size: 14 } },
            xaxis: { zeroline: false },
            yaxis: { title: 'SST ' + vLabel, zeroline: true,
                     zerolinecolor: BRAND.gridZero },
            margin: { l: 64, r: 18, t: 52, b: 60 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: BRAND.plotBg,
            font: { color: BRAND.text, family: 'DM Sans, system-ui, sans-serif',
                    size: 11 },
            hovermode: 'x unified',
            // x-unified mode puts every trace's value into one tooltip;
            // Plotly's default light bg was unreadable in dark theme.
            hoverlabel: {
                bgcolor: BRAND.hoverBg,
                bordercolor: BRAND.hoverBorder,
                font: { color: BRAND.hoverText,
                        family: 'DM Sans, system-ui, sans-serif',
                        size: 11 },
            },
            legend: { font: { size: 13 }, orientation: 'h',
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

    // -------------------------------------------------------------------
    // Panel C — Seasonal Evolution animation
    //
    // Stage 1: monthly-resolution scrub through a chosen year's ERA5
    // deep-layer shear field. Raw or anomaly-vs-1991-2020 climatology.
    // IBTrACS tracks overlay coming in the next commit.
    //
    // Tile format: matches build_era5_daily_archive.py — gzip'd uint16
    // streams with per-tile (vmin, vmax) recorded in the manifest. Decoded
    // client-side via DecompressionStream + Uint16Array dequantization
    // (same pattern as vendor/gc-atlas/era5.js).
    // -------------------------------------------------------------------
    // Panel C reads the 1°-decimated mirror of the 00Z × 0.25° archive
    // (build_era5_daily_archive.py writes both prefixes). We keep this
    // URL at era5_daily/ throughout the transition so Panel C never
    // breaks during the 00Z backfill — once the new archive validates
    // against SHIPS climos, gsutil-rename era5_daily/ → era5_daily_legacy/
    // and era5_daily_1deg/ → era5_daily/ to cut over atomically (no JS
    // change needed at swap time).
    // Two archives Panel C may read from per tile:
    //   1. era5_daily_1deg/ — the NEW 00Z × 0.25°-source decimated 1° tiles
    //      from build_era5_daily_archive.py (project_era5_archive_00z).
    //   2. era5_daily/     — the LEGACY 4×-daily-mean 1° tiles. Used as
    //      a fallback while the 00Z backfill is in flight, so months
    //      that haven't been re-fetched yet still render.
    // _evoFetchFieldTile prefers (1) and falls back to (2) per (field,
    // year, month). Once the 00Z backfill completes and the rename
    // swap is performed (era5_daily → era5_daily_legacy, era5_daily_1deg
    // → era5_daily), both URLs collapse onto the same prefix and the
    // fallback is a no-op.
    var EVO_ARCHIVE_BASE_NEW    = 'https://storage.googleapis.com/tc-atlas-ir-cache/era5_daily_1deg';
    var EVO_ARCHIVE_BASE_LEGACY = 'https://storage.googleapis.com/tc-atlas-ir-cache/era5_daily';
    // 0.25° native archive — opt-in via the HD toggle. Tiles here are
    // ~70× the byte count of the 1° decimated tiles per month, so HD
    // is gated to monthly mode + non-ALL basins and decoded with a
    // viewport crop (see _evoSrcConfig / _evoDecodeTile).
    var EVO_ARCHIVE_BASE_HD     = 'https://storage.googleapis.com/tc-atlas-ir-cache/era5_daily_00z';
    var EVO_ARCHIVE_BASE = EVO_ARCHIVE_BASE_LEGACY;   // legacy alias kept for the existing module
    var EVO_CLIMO_BASE   = 'https://storage.googleapis.com/tc-atlas-ir-cache/era5_climo';
    // EVO_GRID_NY / NX / LATS / LONS describe the DECODED grid (after
    // viewport cropping in HD mode) — they're recomputed every
    // _evoRender() based on resolution + basin. The 1° defaults below
    // are the historical "global 121×360" used everywhere not in HD.
    var EVO_GRID_NY = 121;    // 60S..60N at 1° (matches archive)
    var EVO_GRID_NX = 360;    // -180..179 at 1°
    var EVO_LATS = (function () {
        var a = []; for (var lat = 60; lat >= -60; lat--) a.push(lat); return a;
    })();
    var EVO_LONS = (function () {
        var a = []; for (var lon = -180; lon < 180; lon++) a.push(lon); return a;
    })();
    // Source-grid descriptor used to decode era5_daily tiles — depends
    // on (hd, archive) but NOT on basin. The decode crop spec mediates
    // between the source grid and the (basin-cropped) EVO grid.
    function _evoSrcConfig(hd) {
        if (hd) {
            return { ny: 481, nx: 1440, latMax: 60.0, latMin: -60.0,
                     lonMin: -180.0, cellSize: 0.25 };
        }
        return { ny: 121, nx: 360, latMax: 60.0, latMin: -60.0,
                 lonMin: -180.0, cellSize: 1.0 };
    }
    // Pick the right archive base for the current (hd, source) state.
    function _evoArchiveBase(hd, source) {
        if (hd) return EVO_ARCHIVE_BASE_HD;
        return source === 'new' ? EVO_ARCHIVE_BASE_NEW : EVO_ARCHIVE_BASE_LEGACY;
    }
    // Area below which Auto-mode promotes to HD. NA basin default is
    // 120 × 50 = 6000 sq°; this puts the trigger at "user has zoomed
    // into roughly half a basin" — the scale at which 1° cells start
    // to read as visible pixel blocks instead of a smooth field.
    var _EVO_HD_AREA_THRESHOLD = 3000;   // sq° (lon × lat)
    // Returns true iff HD tiles exist for `year` in the era5_daily_00z
    // manifest. Used to gate Auto-mode silently — if HD isn't published
    // for the active year (e.g., 2024 isn't backfilled yet), we stay at
    // 1° instead of failing the fetch.
    function _evoHdAvailableFor(year) {
        var m = _evoState.manifest_hd;
        if (!m || !m.tiles) return false;
        // Quick check: any field's tile for any month of `year`.
        var prefix = 'shear/' + year + '_';
        for (var k in m.tiles) {
            if (k.indexOf(prefix) === 0) return true;
        }
        return false;
    }
    // The single source of truth for "should this render use 0.25°?".
    // Combines manual override, viewport area, and HD-tile availability.
    // GC-ATLAS monthly-only variables are always 1° (they don't have
    // 0.25° source tiles — gc-atlas's catalog is 1° everywhere).
    function _evoComputeEffectiveHd(viewport) {
        var variable = _evoState.variable || 'shear';
        if (_evoIsMonthlyOnly(variable)) return false;
        // HD + daily is allowed for non-ALL basins now — viewport
        // cropping bounds peak memory at ~550 MB even with 365 daily
        // frames at 0.25°. ALL basin in daily-HD would still blow
        // past the mobile-Safari ceiling (no crop), so we keep that
        // gate.
        if (_evoState.basin === 'ALL') return false;          // needs crop
        var mode = _evoState.hdMode || 'auto';
        if (mode === '1deg') return false;
        var year = _evoState.year;
        if (!_evoHdAvailableFor(year)) return false;
        if (mode === 'hd') return true;
        // Auto path — area-based promotion.
        if (!viewport) viewport = _evoViewForBasin(_evoState.basin);
        var area = Math.abs(viewport.x[1] - viewport.x[0])
                 * Math.abs(viewport.y[1] - viewport.y[0]);
        return area < _EVO_HD_AREA_THRESHOLD;
    }
    // Cache key for the per-(year, spatial-res, basin, temporal-res,
    // variable) frames lookup. Each independent dimension goes in so a
    // monthly-then-daily flip (or shear-then-wind200 swap) doesn't
    // return stale frames from a prior axis.
    function _evoCacheKey(year, hd, basin, temporalRes, variable) {
        return year + '@' + (hd ? 'hd' : '1deg')
             + '@' + basin
             + '@' + (temporalRes || 'monthly')
             + '@' + (variable || 'shear');
    }
    // LRU storage for decoded frames. Entries hold the heavy Float32
    // arrays; we cap at 4 entries (≈ 140 MB worst-case w/ daily HD)
    // and evict the least-recently-used on insert.
    var _EVO_FRAMES_CACHE_CAP = 4;
    function _evoFramesCacheGet(key) {
        var c = _evoState.framesCache;
        if (!c) return null;
        var entry = c.get(key);
        if (!entry) return null;
        // Touch (re-insert) to mark as most-recently-used.
        c.delete(key);
        c.set(key, entry);
        return entry;
    }
    function _evoFramesCacheSet(key, frames) {
        if (!_evoState.framesCache) _evoState.framesCache = new Map();
        var c = _evoState.framesCache;
        if (c.has(key)) c.delete(key);
        c.set(key, frames);
        while (c.size > _EVO_FRAMES_CACHE_CAP) {
            var oldestKey = c.keys().next().value;
            c.delete(oldestKey);
        }
    }
    // Compute the crop spec into the source grid for a given basin.
    // In 1° mode this just returns the full globe (rowStart=0..srcNy).
    // In HD mode we crop to the basin viewport so the decoded
    // Float32Array fits in memory (NA basin at 0.25° = ~96000 cells per
    // day vs the full ~692640 — a 7× shrink, vital for staying under
    // the mobile-Safari ~2 GB ceiling).
    function _evoCropForBasin(srcCfg, basin, hd) {
        if (!hd || basin === 'ALL') {
            return { rowStart: 0, rowEnd: srcCfg.ny,
                     colStart: 0, colEnd: srcCfg.nx };
        }
        var view = _evoViewForBasin(basin);
        // Pad the crop by 2° so barb glyphs near the viewport edge
        // (shaft length ~3.4°) still have data underneath.
        var padDeg = 2.0;
        var latHi = Math.min(srcCfg.latMax, view.y[1] + padDeg);
        var latLo = Math.max(srcCfg.latMin, view.y[0] - padDeg);
        var lonLo = view.x[0] - padDeg;
        var lonHi = view.x[1] + padDeg;
        // Clamp lon to the source's -180..180 frame — SP basin's
        // 140..220 wraps the antimeridian; we don't yet support
        // wraparound cropping, so cap at 180 and accept the visible
        // edge clipping in HD mode (1° mode covers it via the full
        // global grid).
        if (lonLo < -180) lonLo = -180;
        if (lonHi > 179.75) lonHi = 179.75;
        var rs = Math.max(0, Math.floor((srcCfg.latMax - latHi) / srcCfg.cellSize));
        var re = Math.min(srcCfg.ny,
                          Math.ceil((srcCfg.latMax - latLo) / srcCfg.cellSize) + 1);
        var cs = Math.max(0, Math.floor((lonLo - srcCfg.lonMin) / srcCfg.cellSize));
        var ce = Math.min(srcCfg.nx,
                          Math.ceil((lonHi - srcCfg.lonMin) / srcCfg.cellSize) + 1);
        return { rowStart: rs, rowEnd: re, colStart: cs, colEnd: ce };
    }
    // Re-derive EVO_GRID_NY/NX/LATS/LONS from (srcCfg, crop). Called by
    // _evoRender before any tile decode so all downstream iterators
    // (decoders, _evoMag, _evoBuildBarbs, etc.) see the cropped shape.
    function _evoApplyGridShape(srcCfg, crop) {
        EVO_GRID_NY = crop.rowEnd - crop.rowStart;
        EVO_GRID_NX = crop.colEnd - crop.colStart;
        EVO_LATS = new Array(EVO_GRID_NY);
        for (var i = 0; i < EVO_GRID_NY; i++) {
            EVO_LATS[i] = srcCfg.latMax - (crop.rowStart + i) * srcCfg.cellSize;
        }
        EVO_LONS = new Array(EVO_GRID_NX);
        for (var j = 0; j < EVO_GRID_NX; j++) {
            EVO_LONS[j] = srcCfg.lonMin + (crop.colStart + j) * srcCfg.cellSize;
        }
    }

    var _evoState = {
        manifest: null,
        manifestPromise: null,
        climoManifest: null,
        climoManifestPromise: null,
        year: null,
        variable: 'shear',
        mode: 'anomaly',         // 'anomaly' | 'raw'
        basin: 'NA',
        trackDepth: 'cumulative',
        resolution: 'monthly',   // 'monthly' (12 frames) | 'daily' (365)
        // Resolution mode (slippy-map style progressive enhancement):
        //   'auto' (default) — viewport area decides: 1° at season-
        //          scale views, 0.25° when the user zooms into a sub-
        //          basin. Map "just gets sharper" as the user zooms,
        //          matching the Google-Maps mental model.
        //   '1deg' — user forced 1° (Auto override).
        //   'hd'   — user forced 0.25° native (Auto override).
        // The legacy boolean `hd` is now derived (computed below).
        hdMode: 'auto',
        // Effective resolution after the current viewport / year /
        // variable evaluation. Refreshed every render so all the
        // downstream paths (fetch, decode, grid shape) agree.
        effectiveHd: false,
        // Frame cache keyed by `${year}@${resolution}@${basin}` so a
        // zoom-out → zoom-in round trip doesn't re-download tiles.
        // LRU capacity intentionally small (4) to keep total memory
        // bounded at ~140 MB even with HD entries.
        framesCache: null,
        srcCfg: null,           // captured in _evoRender for downstream
        crop: null,             // viewport crop into the source grid
        frames: null,            // array of {month, day?, z[NY][NX]}
        climo: null,             // {month → climo z[NY][NX]} for anomaly mode
        // Separate from `climo` because barbs need the climo wind
        // components (u200, v200, u850, v850) — not the climo of
        // |V|. Fetched from GC-ATLAS lazily when shear/wind200/wind850
        // is rendered in anomaly mode.
        windClimo: null,
        // Overlay visibility — toggle group on Panel C. Barbs default on,
        // streamlines default off, tracks default on. Barbs and
        // streamlines are mutually exclusive (turning one on flips the
        // other off). Updated via the toggle buttons in HTML.
        showTracks: true,
        // Particles are the default flow overlay — they read more
        // naturally than static barbs at most viewport scales and
        // match the TC Climatology globe's look. The mutex still
        // applies; user can flip to barbs anytime.
        showBarbs: false,
        showStreamlines: true,
        // IBTrACS overlay state — lazy-loaded chunk-1 (1977-present)
        // covers everything the era5_daily archive will ever have.
        tracks: null,
        tracksPromise: null,
        storms: null,
        stormsPromise: null,
        // Coastline polyline (one NaN-separated polyline trace under
        // the storm-track scatter). Loaded once from
        // vendor/gc-atlas/assets/coastlines/ne_50m_coastline.geojson.
        coastlines: null,
        coastlinesPromise: null,
    };

    function _evoLoadCoastlines() {
        if (_evoState.coastlines) return Promise.resolve(_evoState.coastlines);
        if (_evoState.coastlinesPromise) return _evoState.coastlinesPromise;
        _evoState.coastlinesPromise = fetch(
                'vendor/gc-atlas/assets/coastlines/ne_50m_coastline.geojson',
                { cache: 'default' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (gj) {
                if (!gj || !gj.features) {
                    _evoState.coastlines = { x: [], y: [] };
                    return _evoState.coastlines;
                }
                // Flatten 1428 features (mix of LineString and
                // MultiLineString — Europe/Africa/most large continents
                // ship as MultiLineString) into a single NaN-separated
                // polyline so Panel C carries one Plotly scatter trace.
                var xs = [], ys = [];
                function pushLine(coords) {
                    if (!coords || !coords.length) return;
                    if (xs.length) { xs.push(null); ys.push(null); }
                    for (var i = 0; i < coords.length; i++) {
                        xs.push(coords[i][0]);
                        ys.push(coords[i][1]);
                    }
                }
                gj.features.forEach(function (f) {
                    var g = f.geometry;
                    if (!g) return;
                    if (g.type === 'LineString') {
                        pushLine(g.coordinates);
                    } else if (g.type === 'MultiLineString') {
                        // coordinates: [[[lon, lat], ...], [[lon, lat], ...]]
                        for (var k = 0; k < g.coordinates.length; k++) {
                            pushLine(g.coordinates[k]);
                        }
                    }
                });
                _evoState.coastlines = { x: xs, y: ys };
                return _evoState.coastlines;
            })
            .catch(function () {
                _evoState.coastlines = { x: [], y: [] };
                return _evoState.coastlines;
            });
        return _evoState.coastlinesPromise;
    }

    // True-TC natures per user instruction: keep storms visible on the
    // map as long as they retain one of these. Drop fix once nature
    // transitions to ET, DS, DB, NR, MX, etc.
    var _EVO_TC_NATURES = { TS: 1, TD: 1, HU: 1, TC: 1, SS: 1, SD: 1 };

    // Per-basin xaxis/yaxis viewport for the seasonal-evolution map.
    // Matches the conventional TC-monitoring viewports operational
    // forecasters expect. ALL = global tropics (current default).
    var _EVO_BASIN_VIEWS = {
        ALL: { x: [-180, 180], y: [-40, 40] },
        NA:  { x: [-100,  20], y: [  0, 50] },
        EP:  { x: [-160, -80], y: [  0, 35] },
        WP:  { x: [ 100, 180], y: [  0, 45] },
        NI:  { x: [  40, 105], y: [  0, 30] },
        SI:  { x: [  30, 110], y: [-35,  0] },
        SP:  { x: [ 140, 220], y: [-35,  0] },   // wrapped — Pacific antimeridian
    };
    function _evoViewForBasin(basin) {
        return _EVO_BASIN_VIEWS[basin] || _EVO_BASIN_VIEWS.NA;
    }

    // Tune the .seasonal-evo-wrap aspect ratio to the current basin's
    // viewport so we don't leave huge whitespace bands above/below the
    // map. Plotly's xaxis.scaleanchor:'y' locks 1°-lon = 1°-lat in
    // data space, so the wrap shape just sets how much margin the
    // figure sits in. We add a small geometric pad for the colorbar
    // (~70 px) and axis labels (~30 px each side); empirically a
    // multiplier of 1.05 over (lonWidth/latHeight) lands close to
    // "data fills the wrap" without clipping the colorbar.
    function _evoApplyWrapAspect(basin) {
        var wrap = document.getElementById('seasonal-evo-wrap');
        if (!wrap) return;
        var v = _evoViewForBasin(basin);
        var lonW = Math.abs(v.x[1] - v.x[0]);
        var latH = Math.abs(v.y[1] - v.y[0]);
        if (!lonW || !latH) return;
        var ratio = (lonW / latH) * 1.05;
        // Clamp so we don't produce pathologically tall or wide boxes
        // on extreme basin choices (e.g., SP is ~80° wide × 35° tall).
        if (ratio < 1.4) ratio = 1.4;
        if (ratio > 5.0) ratio = 5.0;
        wrap.style.aspectRatio = String(ratio);
    }

    // Normalize a storm-track longitude to the [-180, 180) frame the
    // Plotly heatmap uses. IBTrACS publishes lons in 0..360 historically.
    function _evoNormLon(lon) {
        if (lon == null) return null;
        return lon > 180 ? lon - 360 : lon;
    }

    function _evoLoadStorms() {
        if (_evoState.storms) return Promise.resolve(_evoState.storms);
        if (_evoState.stormsPromise) return _evoState.stormsPromise;
        _evoState.stormsPromise = fetch('ibtracs_storms.json?' + (window.__v || ''))
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
                if (!j || !j.storms) { _evoState.storms = {}; return {}; }
                var bySid = {};
                j.storms.forEach(function (s) { bySid[s.sid] = s; });
                _evoState.storms = bySid;
                return bySid;
            })
            .catch(function () { _evoState.storms = {}; return {}; });
        return _evoState.stormsPromise;
    }

    function _evoLoadTracks() {
        // Chunk 1 (1977-present) is enough — era5_daily archive starts 1991.
        if (_evoState.tracks) return Promise.resolve(_evoState.tracks);
        if (_evoState.tracksPromise) return _evoState.tracksPromise;
        _evoState.tracksPromise = fetch('ibtracs_tracks_1.json?' + (window.__v || ''))
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
                _evoState.tracks = j || {};
                return _evoState.tracks;
            })
            .catch(function () { _evoState.tracks = {}; return {}; });
        return _evoState.tracksPromise;
    }

    // Build a scatter trace's worth of TC-track points for a given
    // frame. Accepts either a frame object {epochDay, month, day?}
    // (preferred) or a bare monthIdx int (legacy path — interprets as
    // end-of-month for that calendar month). Returns separate line,
    // marker, and named-storm label arrays. Polylines are NaN-
    // separated so a single Plotly scatter trace draws all storms.
    function _evoBuildTracksForFrame(frameOrMonth) {
        var year = _evoState.year;
        var basin = _evoState.basin;
        var depth = _evoState.trackDepth;
        var storms = _evoState.storms || {};
        var tracks = _evoState.tracks || {};
        var namedLineX = [], namedLineY = [];
        var unnamedLineX = [], unnamedLineY = [];
        var mX = [], mY = [], mC = [], mS = [], mT = [];
        var labels = [];

        // Resolve the frame to (frameTime, activeStart):
        // Daily mode: frameTime = 00Z of the displayed day (matches the
        //   00Z analysis snapshot the env field carries — was previously
        //   end-of-day, which let track lines run 18 h past the field).
        // Monthly mode: frameTime = end-of-month so tracks accumulate
        //   through the whole month (env field is a monthly mean).
        var frameTime, activeStart;
        if (frameOrMonth && typeof frameOrMonth === 'object') {
            if (frameOrMonth.day != null) {
                // Daily — clip the track end to the same 00Z timestamp
                // the env field is valid at.
                frameTime = frameOrMonth.epochDay * 86400000;
                activeStart = frameTime;       // 00Z exact
            } else {
                // Monthly — frameTime is end-of-month for cumulation;
                // activeStart is start-of-month.
                frameTime = frameOrMonth.epochDay * 86400000 + 86399000;
                activeStart = Date.UTC(year, frameOrMonth.month - 1, 1);
            }
        } else {
            // Legacy path — monthIdx int.
            var monthIdx = frameOrMonth;
            frameTime = Date.UTC(year, monthIdx, 0) + 86399000;
            activeStart = Date.UTC(year, monthIdx - 1, 1);
        }
        var trail15Start = frameTime - 15 * 86400000;

        for (var sid in storms) {
            var s = storms[sid];
            if (!s || s.year !== year) continue;
            if (basin !== 'ALL' && s.basin !== basin) continue;
            var fixes = tracks[sid];
            if (!fixes || !fixes.length) continue;
            var frameFixes = [];
            for (var i = 0; i < fixes.length; i++) {
                var f = fixes[i];
                if (!f.t || f.la == null || f.lo == null) continue;
                if (!_EVO_TC_NATURES[f.n]) continue;
                var t = Date.parse(f.t + 'Z');
                if (!Number.isFinite(t)) continue;
                if (t > frameTime) break;
                if (depth === 'trailing15' && t < trail15Start) continue;
                if (depth === 'active' && t < activeStart) continue;
                frameFixes.push(f);
            }
            if (!frameFixes.length) continue;
            var isNamed = s.name && s.name !== 'UNNAMED' && s.name !== 'NOT_NAMED';
            var lineX = isNamed ? namedLineX : unnamedLineX;
            var lineY = isNamed ? namedLineY : unnamedLineY;
            if (lineX.length) { lineX.push(null); lineY.push(null); }
            for (var k = 0; k < frameFixes.length; k++) {
                var ff = frameFixes[k];
                var lon = _evoNormLon(ff.lo);
                lineX.push(lon); lineY.push(ff.la);
                mX.push(lon); mY.push(ff.la);
                var w = ff.w;
                mC.push(_evoIntensityColor(w));
                mS.push(_evoIntensitySize(w) * (isNamed ? 1.2 : 0.75));
                mT.push((s.name || '?') + ' · ' + ff.t.slice(0, 10)
                        + (w != null ? ' · ' + Math.round(w) + ' kt' : ''));
            }
            // Label the named storm at its latest visible fix.
            if (isNamed) {
                var last = frameFixes[frameFixes.length - 1];
                labels.push({
                    x: _evoNormLon(last.lo),
                    y: last.la,
                    name: s.name,
                    cat: s.cat || '',
                });
            }
        }
        return {
            namedLineX: namedLineX, namedLineY: namedLineY,
            unnamedLineX: unnamedLineX, unnamedLineY: unnamedLineY,
            markersX: mX, markersY: mY,
            markersC: mC, markersS: mS, markersT: mT,
            labels: labels,
        };
    }

    // Saffir-Simpson + TS palette. Matches the NHC color convention
    // operational forecasters expect.
    function _evoIntensityColor(w) {
        if (w == null)        return '#94a3b8';   // unknown intensity
        if (w < 34)           return '#5eead4';   // tropical depression
        if (w < 64)           return '#22c55e';   // tropical storm
        if (w < 83)           return '#fbbf24';   // Cat 1
        if (w < 96)           return '#f97316';   // Cat 2
        if (w < 113)          return '#ef4444';   // Cat 3
        if (w < 137)          return '#dc2626';   // Cat 4
        return '#7f1d1d';                         // Cat 5
    }
    function _evoIntensitySize(w) {
        if (w == null) return 4;
        return Math.max(4, Math.min(12, 4 + (w - 30) * 0.08));
    }

    // Load BOTH manifests (new 00Z 1° and legacy 4×daily). The two are
    // merged into _evoState.manifest with a per-tile `source` field
    // pointing at whichever archive base the consumer should hit:
    //   manifest.tiles[key] = { vmin, vmax, n_days, ..., source: 'new'|'legacy' }
    // _evoState.manifest_new and .manifest_legacy keep the raw versions
    // for downstream consumers (the year picker unions both).
    // HD manifest loader — pre-fetched eagerly even when the user is
    // in 1° mode so the Auto-promotion check (_evoHdAvailableFor)
    // knows whether to escalate without an extra round-trip on the
    // user's first zoom-in. ~1 MB JSON, cached for the session.
    function _evoLoadHdManifest() {
        if (_evoState.manifest_hd) return Promise.resolve(_evoState.manifest_hd);
        if (_evoState.manifestPromise_hd) return _evoState.manifestPromise_hd;
        _evoState.manifestPromise_hd = fetch(
                EVO_ARCHIVE_BASE_HD + '/manifest.json',
                { cache: 'no-cache' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (m) {
                if (!m || !m.tiles) {
                    _evoState.manifest_hd = { metadata: {}, tiles: {} };
                    return _evoState.manifest_hd;
                }
                var out = { metadata: m.metadata || {}, tiles: {} };
                Object.keys(m.tiles).forEach(function (k) {
                    out.tiles[k] = Object.assign({}, m.tiles[k],
                                                 { source: 'hd' });
                });
                _evoState.manifest_hd = out;
                return out;
            })
            .catch(function (e) {
                _evoState.manifestPromise_hd = null;
                _evoState.manifest_hd = { metadata: {}, tiles: {} };
                return _evoState.manifest_hd;
            });
        return _evoState.manifestPromise_hd;
    }

    function _evoLoadManifest() {
        // The active "current render" manifest. In HD mode it's the
        // 0.25° catalog; in 1° mode it's the 1°-decimated + legacy
        // merge. The HD catalog is ALSO eagerly loaded by
        // _evoLoadHdManifest so the Auto-promotion path can consult
        // it without a network round-trip.
        if (_evoState.effectiveHd) {
            return _evoLoadHdManifest().then(function (m) {
                _evoState.manifest = m;
                return m;
            });
        }
        if (_evoState.manifest) return Promise.resolve(_evoState.manifest);
        if (_evoState.manifestPromise) return _evoState.manifestPromise;
        function fetchOne(base) {
            return fetch(base + '/manifest.json', { cache: 'no-cache' })
                .then(function (r) { return r.ok ? r.json() : null; })
                .catch(function () { return null; });
        }
        _evoState.manifestPromise = Promise.all([
            fetchOne(EVO_ARCHIVE_BASE_NEW),
            fetchOne(EVO_ARCHIVE_BASE_LEGACY),
        ]).then(function (results) {
            var mNew = results[0], mLegacy = results[1];
            _evoState.manifest_new    = mNew;
            _evoState.manifest_legacy = mLegacy;
            // Merge tiles: new wins, legacy fills the gaps.
            var merged = { metadata: (mNew && mNew.metadata)
                                  || (mLegacy && mLegacy.metadata) || {},
                           tiles: {} };
            var legacyTiles = (mLegacy && mLegacy.tiles) || {};
            Object.keys(legacyTiles).forEach(function (k) {
                merged.tiles[k] = Object.assign({}, legacyTiles[k],
                                                { source: 'legacy' });
            });
            var newTiles = (mNew && mNew.tiles) || {};
            Object.keys(newTiles).forEach(function (k) {
                merged.tiles[k] = Object.assign({}, newTiles[k],
                                                { source: 'new' });
            });
            _evoState.manifest = merged;
            return merged;
        });
        return _evoState.manifestPromise;
    }

    function _evoLoadClimoManifest() {
        if (_evoState.climoManifest) return Promise.resolve(_evoState.climoManifest);
        if (_evoState.climoManifestPromise) return _evoState.climoManifestPromise;
        _evoState.climoManifestPromise = fetch(EVO_CLIMO_BASE + '/manifest.json',
                                               { cache: 'no-cache' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { _evoState.climoManifest = j; return j; })
            .catch(function () { return null; });
        return _evoState.climoManifestPromise;
    }

    // Decode an era5_daily tile into a Float32Array.
    // - Without srcShape/crop: full-tile decode (legacy behavior at 1°).
    // - With srcShape={ny, nx} + crop={rowStart, rowEnd, colStart, colEnd}:
    //   decode ONLY the cropped (basin) region for each day. The output
    //   has shape (n_days * cropNy * cropNx) which is critical at 0.25°
    //   where a global month-tile is ~85 MB but a basin viewport is
    //   ~10 MB — without this crop, HD mode allocates ~4 GB across
    //   12 month × 4 field tile fetches and crashes the tab.
    function _evoDecodeTile(arrayBuffer, tileMeta, srcShape, crop) {
        var u16 = new Uint16Array(arrayBuffer);
        var range = (tileMeta.vmax - tileMeta.vmin) / 65534.0;
        if (!srcShape || !crop
                || (crop.rowStart === 0 && crop.colStart === 0
                    && crop.rowEnd === srcShape.ny
                    && crop.colEnd === srcShape.nx)) {
            // Full-tile fast path — same as the prior implementation.
            var out = new Float32Array(u16.length);
            for (var i = 0; i < u16.length; i++) {
                out[i] = u16[i] === 0xFFFF
                    ? NaN
                    : tileMeta.vmin + u16[i] * range;
            }
            return out;
        }
        // Cropped decode. Iterate day-major to match the source's
        // (day, lat, lon) ordering.
        var nDays = tileMeta.n_days
            || Math.floor(u16.length / (srcShape.ny * srcShape.nx));
        var srcStride = srcShape.ny * srcShape.nx;
        var srcNx = srcShape.nx;
        var rs = crop.rowStart, re = crop.rowEnd;
        var cs = crop.colStart, ce = crop.colEnd;
        var cropNy = re - rs;
        var cropNx = ce - cs;
        var cropStride = cropNy * cropNx;
        var outC = new Float32Array(nDays * cropStride);
        for (var d = 0; d < nDays; d++) {
            var srcBase = d * srcStride;
            var dstBase = d * cropStride;
            for (var ri = 0; ri < cropNy; ri++) {
                var srcRow = srcBase + (rs + ri) * srcNx + cs;
                var dstRow = dstBase + ri * cropNx;
                for (var ci = 0; ci < cropNx; ci++) {
                    var v = u16[srcRow + ci];
                    outC[dstRow + ci] = v === 0xFFFF
                        ? NaN
                        : tileMeta.vmin + v * range;
                }
            }
        }
        return outC;
    }

    // Generic tile fetcher for any field in era5_daily — u200, v200,
    // u850, v850, shear. Picks the new 00Z archive when that tile is
    // present in the merged manifest, otherwise falls back to legacy.
    function _evoFetchFieldTile(field, year, month) {
        var monthStr = (month < 10 ? '0' : '') + month;
        var key = field + '/' + year + '_' + monthStr;
        var meta = _evoState.manifest && _evoState.manifest.tiles[key];
        if (!meta) {
            return Promise.reject(new Error('no manifest entry for ' + key));
        }
        var base = _evoArchiveBase(_evoState.effectiveHd, meta.source);
        var url = base + '/' + field + '/' + year + '_' + monthStr + '.bin.gz';
        var srcShape = _evoState.srcCfg
            ? { ny: _evoState.srcCfg.ny, nx: _evoState.srcCfg.nx }
            : null;
        var crop = _evoState.crop || null;
        return fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
                var decompressed = r.body.pipeThrough(new DecompressionStream('gzip'));
                return new Response(decompressed).arrayBuffer();
            })
            .then(function (buf) {
                var values = _evoDecodeTile(buf, meta, srcShape, crop);
                var nDays = meta.n_days || (values.length / (EVO_GRID_NY * EVO_GRID_NX));
                return { values: values, n_days: nDays,
                         valid_dates: meta.valid_dates,
                         source: meta.source };
            });
    }
    function _evoFetchShearTile(year, month) {
        return _evoFetchFieldTile('shear', year, month);
    }

    // -------------------------------------------------------------------
    // GC-ATLAS monthly tile fetcher — used by the "Monthly ERA5" Panel C
    // variables (MPI / RH700 / χ200 / ζ850 / TCWV / u200_m / u850_m).
    // GC-ATLAS hosts a global 181×360 1°-monthly catalog at
    // gs://gc-atlas-era5/{tiles,tiles_per_year} with the same f16-gz
    // encoding the daily archive uses. We subset rows 30..150 to match
    // the EVO 60°S–60°N × 360-col grid Panel C is built around.
    // -------------------------------------------------------------------
    var EVO_GC_ATLAS_BASE = 'https://storage.googleapis.com/gc-atlas-era5';
    var _evoGcAtlasManifestP = null;
    var _evoGcAtlasPerYearManifestP = null;
    // Per-variable display config + GC-ATLAS group/name/level mapping.
    // Each entry mirrors the corresponding FIELDS row in
    // build_era5_indices.py so the Panel C surface stays in sync with
    // the Panel B time series.
    var EVO_MONTHLY_VARS = {
        mpi: {
            group: 'single_levels', name: 'mpi', level: null,
            label: 'MPI', units: 'm s⁻¹',
            zmin: 0, zmax: 100, divergent: false,
            anomZmax: 15,
            colorscale: [
                [0.0, '#053061'], [0.30, '#74add1'],
                [0.55, '#fed98e'], [0.80, '#f46d43'],
                [1.0, '#67001f'],
            ],
        },
        rh700: {
            group: 'pressure_levels', name: 'r', level: 700,
            label: '700 hPa RH', units: '%',
            zmin: 0, zmax: 100, divergent: false,
            anomZmax: 25,
            colorscale: [
                [0.0, '#8c510a'], [0.25, '#dfc27d'],
                [0.50, '#f6e8c3'], [0.75, '#80cdc1'],
                [1.0, '#01665e'],
            ],
        },
        chi200: {
            group: 'pressure_levels', name: 'chi', level: 200,
            label: 'χ at 200 hPa', units: '10⁶ m² s⁻¹',
            transform: function (v) { return v == null ? null : v / 1e6; },
            zmin: -15, zmax: 15, divergent: true,
            anomZmax: 8,
            colorscale: 'RdBu_r',
        },
        vo850: {
            group: 'pressure_levels', name: 'vo', level: 850,
            label: 'ζ at 850 hPa', units: '10⁻⁵ s⁻¹',
            transform: function (v) { return v == null ? null : v * 1e5; },
            zmin: -10, zmax: 10, divergent: true,
            anomZmax: 6,
            colorscale: 'RdBu_r',
        },
        tcwv: {
            group: 'single_levels', name: 'tcwv', level: null,
            label: 'TCWV', units: 'kg m⁻²',
            zmin: 0, zmax: 75, divergent: false,
            anomZmax: 10,
            colorscale: [
                [0.0, '#fff7bc'], [0.30, '#fec44f'],
                [0.55, '#74c476'], [0.80, '#2171b5'],
                [1.0, '#08306b'],
            ],
        },
        u200_m: {
            group: 'pressure_levels', name: 'u', level: 200,
            label: 'u at 200 hPa', units: 'm s⁻¹',
            zmin: -40, zmax: 40, divergent: true,
            anomZmax: 12,
            colorscale: 'RdBu_r',
        },
        u850_m: {
            group: 'pressure_levels', name: 'u', level: 850,
            label: 'u at 850 hPa', units: 'm s⁻¹',
            zmin: -20, zmax: 20, divergent: true,
            anomZmax: 8,
            colorscale: 'RdBu_r',
        },
        sst: {
            // ERA5 SST (monthly mean). NOT NOAA OISST — the daily
            // satellite-blended OISST product needs its own gridded
            // archive (see project memory). ERA5 SST is the IFS-blended
            // analysis SST and is fine for monthly TC-environment work.
            group: 'single_levels', name: 'sst', level: null,
            // ERA5 SST tiles are in Kelvin. Convert to °C in display.
            transform: function (v) { return v == null ? null : v - 273.15; },
            label: 'SST', units: '°C',
            zmin: 14, zmax: 32, divergent: false,
            anomZmax: 3,
            colorscale: [
                [0.0,  '#053061'], [0.20, '#2166ac'],
                [0.45, '#92c5de'], [0.60, '#fddbc7'],
                [0.80, '#f4a582'], [1.0,  '#67001f'],
            ],
        },
    };
    function _evoIsMonthlyOnly(variable) {
        return Object.prototype.hasOwnProperty.call(
            EVO_MONTHLY_VARS, variable || '');
    }

    function _evoLoadGcAtlasManifest() {
        if (_evoGcAtlasManifestP) return _evoGcAtlasManifestP;
        _evoGcAtlasManifestP = fetch(EVO_GC_ATLAS_BASE + '/tiles/manifest.json')
            .then(function (r) {
                if (!r.ok) throw new Error('GC-ATLAS climo manifest HTTP ' + r.status);
                return r.json();
            });
        return _evoGcAtlasManifestP;
    }
    function _evoLoadGcAtlasPerYearManifest() {
        if (_evoGcAtlasPerYearManifestP) return _evoGcAtlasPerYearManifestP;
        _evoGcAtlasPerYearManifestP = fetch(
            EVO_GC_ATLAS_BASE + '/tiles_per_year/manifest.json')
            .then(function (r) {
                if (!r.ok) throw new Error('GC-ATLAS per-year manifest HTTP ' + r.status);
                return r.json();
            });
        return _evoGcAtlasPerYearManifestP;
    }

    // Decode a GC-ATLAS f16-gz tile (181×360, lat 90..-90, lon -180..179)
    // and return the 121×360 60°S..60°N subset as Array<Array<number|null>>
    // so it lines up with the EVO grid + frame[].z conventions.
    function _evoDecodeGcAtlasTile(arrayBuffer, vmin, vmax, transform) {
        var u16 = new Uint16Array(arrayBuffer);
        var srcNy = 181, nx = EVO_GRID_NX;   // 360
        var range = (vmax - vmin) / 65534.0;
        // EVO grid covers lat 60..-60 → rows 30..150 in the 181-row tile.
        // Returns Array<Float32Array> with NaN for missing cells —
        // matches the era5_daily decoder's typed-array convention so
        // _evoMag / _evoSub / frameZ etc. can operate on the same
        // shape without nested-Array fallbacks.
        var out = new Array(EVO_GRID_NY);
        for (var i = 0; i < EVO_GRID_NY; i++) {
            var srcRow = i + 30;
            var row = new Float32Array(nx);
            for (var j = 0; j < nx; j++) {
                var v = u16[srcRow * nx + j];
                if (v === 0xFFFF) {
                    row[j] = NaN;
                } else {
                    var f = vmin + v * range;
                    row[j] = transform ? transform(f) : f;
                }
            }
            out[i] = row;
        }
        return out;
    }

    // Per-year monthly mean tile.
    function _evoFetchGcAtlasYearTile(spec, year, month) {
        var monthStr = (month < 10 ? '0' : '') + month;
        var levPref = spec.level == null ? '' : (spec.level + '_');
        var path = '/tiles_per_year/' + spec.group + '/' + spec.name + '/'
                 + levPref + year + '_' + monthStr + '.bin.gz';
        var tileKey = levPref + year + '_' + monthStr;
        return _evoLoadGcAtlasPerYearManifest().then(function (m) {
            var meta = m.groups && m.groups[spec.group]
                    && m.groups[spec.group][spec.name]
                    && m.groups[spec.group][spec.name].tiles
                    && m.groups[spec.group][spec.name].tiles[tileKey];
            if (!meta) throw new Error('GC-ATLAS per-year missing ' + path);
            return fetch(EVO_GC_ATLAS_BASE + path).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path);
                var decompressed = r.body.pipeThrough(new DecompressionStream('gzip'));
                return new Response(decompressed).arrayBuffer();
            }).then(function (buf) {
                return _evoDecodeGcAtlasTile(buf, meta.vmin, meta.vmax, spec.transform);
            });
        });
    }
    // 1991-2020 climatology mean tile (one per calendar month).
    function _evoFetchGcAtlasClimoTile(spec, month) {
        var monthStr = (month < 10 ? '0' : '') + month;
        var levPref = spec.level == null ? '' : (spec.level + '_');
        var path = '/tiles/' + spec.group + '/' + spec.name + '/'
                 + levPref + monthStr + '.bin.gz';
        var tileKey = levPref + monthStr;
        return _evoLoadGcAtlasManifest().then(function (m) {
            var meta = m.groups && m.groups[spec.group]
                    && m.groups[spec.group][spec.name]
                    && m.groups[spec.group][spec.name].tiles
                    && m.groups[spec.group][spec.name].tiles[tileKey];
            if (!meta) throw new Error('GC-ATLAS climo missing ' + path);
            return fetch(EVO_GC_ATLAS_BASE + path).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path);
                var decompressed = r.body.pipeThrough(new DecompressionStream('gzip'));
                return new Response(decompressed).arrayBuffer();
            }).then(function (buf) {
                return _evoDecodeGcAtlasTile(buf, meta.vmin, meta.vmax, spec.transform);
            });
        });
    }

    // Build 12 monthly frames for a GC-ATLAS-backed variable.
    function _evoFetchYearMonthlyOnly(year) {
        var variable = _evoState.variable || 'shear';
        var spec = EVO_MONTHLY_VARS[variable];
        if (!spec) {
            return Promise.reject(new Error('no GC-ATLAS spec for ' + variable));
        }
        var monthPromises = [];
        for (var month = 1; month <= 12; month++) {
            (function (mo) {
                monthPromises.push(
                    _evoFetchGcAtlasYearTile(spec, year, mo)
                        .then(function (grid) {
                            return {
                                month: mo, day: null,
                                epochDay: Date.UTC(year, mo, 0) / 86400000,
                                label: _EVO_MONTH_NAMES[mo - 1],
                                z: grid, u: null, v: null,
                            };
                        })
                        .catch(function (e) {
                            console.warn('[seasonal-evo] GC-ATLAS month skip',
                                         year, mo, variable, e.message);
                            return null;
                        }));
            })(month);
        }
        return Promise.all(monthPromises).then(function (slices) {
            return slices.filter(Boolean).sort(function (a, b) {
                return a.epochDay - b.epochDay;
            });
        });
    }

    // GC-ATLAS climo specs for u/v at 200 and 850 hPa — used by the
    // daily-archive variables (shear / wind200 / wind850) to render
    // anomalous wind barbs in anomaly mode (so the barb shows V_now
    // − V_clim instead of the raw V, which is dominated by the upper-
    // tropospheric jet and reads as a 200-mb wind regardless).
    var _EVO_WIND_CLIMO_SPECS = {
        u200: { group: 'pressure_levels', name: 'u', level: 200 },
        v200: { group: 'pressure_levels', name: 'v', level: 200 },
        u850: { group: 'pressure_levels', name: 'u', level: 850 },
        v850: { group: 'pressure_levels', name: 'v', level: 850 },
    };
    function _evoFetchWindClimoForFrames(frames) {
        // Returns Promise<{month → {u200, v200, u850, v850}}>. Cached
        // on _evoState.windClimo keyed by month. Climatology is 1991-
        // 2020 — year-independent, so the cache persists across year
        // switches (only invalidated on variable change in the bind
        // handler, since climo grid SHAPE depends on resolution).
        if (_evoState.windClimo) {
            return Promise.resolve(_evoState.windClimo);
        }
        var monthsSeen = {};
        frames.forEach(function (f) { monthsSeen[f.month] = true; });
        var pending = [];
        Object.keys(monthsSeen).forEach(function (mStr) {
            var mo = parseInt(mStr, 10);
            Object.keys(_EVO_WIND_CLIMO_SPECS).forEach(function (field) {
                pending.push(
                    _evoFetchGcAtlasClimoTile(_EVO_WIND_CLIMO_SPECS[field], mo)
                        .then(function (g) {
                            return { month: mo, field: field, grid: g };
                        })
                        .catch(function () { return null; })
                );
            });
        });
        return Promise.all(pending).then(function (results) {
            var byMonth = {};
            results.forEach(function (r) {
                if (!r || !r.grid) return;
                byMonth[r.month] = byMonth[r.month] || {};
                byMonth[r.month][r.field] = r.grid;
            });
            _evoState.windClimo = byMonth;
            return byMonth;
        });
    }

    // Build {month → climo grid} dict for a GC-ATLAS-backed variable.
    function _evoFetchGcAtlasClimoForFrames(frames) {
        var variable = _evoState.variable || 'shear';
        var spec = EVO_MONTHLY_VARS[variable];
        if (!spec) return Promise.resolve({});
        var monthsSeen = {};
        frames.forEach(function (f) { monthsSeen[f.month] = true; });
        var pending = Object.keys(monthsSeen).map(function (m) {
            var mo = parseInt(m, 10);
            return _evoFetchGcAtlasClimoTile(spec, mo)
                .then(function (g) { return { month: mo, clim: g }; })
                .catch(function (e) {
                    console.warn('[seasonal-evo] climo miss', mo, variable, e.message);
                    return { month: mo, clim: null };
                });
        });
        return Promise.all(pending).then(function (results) {
            var byMonth = {};
            results.forEach(function (r) { if (r.clim) byMonth[r.month] = r.clim; });
            return byMonth;
        });
    }

    // Monthly mean of daily shear at each grid cell. Returns
    // Array<Float32Array> (length EVO_GRID_NY, each inner row a
    // Float32Array(EVO_GRID_NX)) so each frame's storage is ~4 bytes
    // per cell instead of the ~24-byte JS Number objects nested
    // Array<Array<number|null>> used. Missing cells = NaN (Float32Array
    // supports NaN natively); arithmetic on NaN propagates so the
    // explicit null guards downstream collapsed to isNaN.
    function _evoMonthlyMean(tile) {
        var nDays = tile.n_days;
        var stride = EVO_GRID_NY * EVO_GRID_NX;
        var sum = new Float32Array(stride);
        var count = new Int32Array(stride);
        for (var d = 0; d < nDays; d++) {
            var base = d * stride;
            for (var k = 0; k < stride; k++) {
                var v = tile.values[base + k];
                if (Number.isFinite(v)) {
                    sum[k] += v;
                    count[k]++;
                }
            }
        }
        var mean = new Array(EVO_GRID_NY);
        for (var i = 0; i < EVO_GRID_NY; i++) {
            var row = new Float32Array(EVO_GRID_NX);
            for (var j = 0; j < EVO_GRID_NX; j++) {
                var idx = i * EVO_GRID_NX + j;
                row[j] = count[idx] > 0 ? sum[idx] / count[idx] : NaN;
            }
            mean[i] = row;
        }
        return mean;
    }

    // Extract one day's slice from a monthly tile as a (NY, NX) array
    // of Float32Array rows. Missing values = NaN (preserved from the
    // tile's 0xFFFF sentinel via _evoDecodeTile).
    function _evoExtractDayGrid(tile, dayIdx) {
        var stride = EVO_GRID_NY * EVO_GRID_NX;
        var base = dayIdx * stride;
        var out = new Array(EVO_GRID_NY);
        for (var i = 0; i < EVO_GRID_NY; i++) {
            // .subarray() returns a view, not a copy — frame grids and
            // tile.values share the same backing buffer for the lifetime
            // of the tile. _evoMag/_evoSub etc. only READ; they
            // allocate fresh Float32Array rows for their output.
            out[i] = tile.values.subarray(
                base + i * EVO_GRID_NX,
                base + (i + 1) * EVO_GRID_NX);
        }
        return out;
    }

    // Month abbreviations used everywhere we label a frame.
    var _EVO_MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun',
                            'Jul','Aug','Sep','Oct','Nov','Dec'];

    // Days in calendar month for any year (year-aware so Feb 28 vs 29
    // works correctly).
    function _evoDaysInMonth(year, month) {
        return new Date(Date.UTC(year, month, 0)).getUTCDate();
    }

    // ── Wind-barb rendering ──────────────────────────────────────────
    // Standard WMO convention (matches realtime_ir.js _drawWindBarb):
    // the SHAFT points UPWIND from the station — i.e., toward the
    // direction the wind is coming FROM — with feathers/pennants
    // clustered at the upwind tip. Looking from station out along the
    // shaft, feathers are on the OBSERVER'S LEFT in the NH and right
    // in the SH (Coriolis-rotated convention used by the climatology
    // globe). Pennant=50 kt, full feather=10 kt, half feather=5 kt.
    // Geometry constants mirror vendor/gc-atlas/barbs.js's published-chart
    // proportions (Tropical Tidbits / WPC style): tight glyph packing,
    // filled pennants. Sizes are in lat/lon degrees because Plotly's
    // x/y axes for Panel C are direct lat-lon (scaleanchor:'y' locks
    // 1°-x = 1°-y on screen, so degrees behave like world units).
    // Default (fallback) barb sampling — used when no viewport is
    // available yet. The live sampling adapts to the visible viewport
    // via _evoComputeBarbStep below, targeting ~12-15 glyphs per axis.
    var _EVO_BARB_LAT_STEP = 8;     // ° between barb rows
    var _EVO_BARB_LON_STEP = 8;     // ° between barb cols
    // Target ~N glyphs per axis when sampling adaptively. Sub-pixel
    // glyph density looks busy; sparser than this leaves blank regions
    // at high zoom. Clamp the step into [_EVO_STEP_MIN, _EVO_STEP_MAX]
    // so we never explode the barb count on extreme global views or
    // degenerate to a single barb on a 5°-wide pinch zoom.
    var _EVO_BARB_TARGET_PER_AXIS = 13;
    var _EVO_STREAM_TARGET_PER_AXIS = 16;
    var _EVO_STEP_MIN = 1;
    var _EVO_STEP_MAX = 12;
    function _evoComputeViewport(el) {
        // Pull live ranges off Plotly's internal layout. Falls back to
        // the basin default if the plot hasn't drawn yet.
        if (el && el._fullLayout && el._fullLayout.xaxis && el._fullLayout.yaxis) {
            var xr = el._fullLayout.xaxis.range;
            var yr = el._fullLayout.yaxis.range;
            if (xr && yr && xr.length === 2 && yr.length === 2) {
                var xMin = Math.min(xr[0], xr[1]);
                var xMax = Math.max(xr[0], xr[1]);
                var yMin = Math.min(yr[0], yr[1]);
                var yMax = Math.max(yr[0], yr[1]);
                return { x: [xMin, xMax], y: [yMin, yMax] };
            }
        }
        var v = _evoViewForBasin(_evoState.basin);
        return { x: v.x.slice(), y: v.y.slice() };
    }
    // Compute the barb / streamline sampling step in GRID-CELL units.
    // The viewport's lat/lon WIDTH (in degrees) is divided by `target`
    // glyphs-per-axis to get the desired degree spacing, then divided
    // by the live grid's cellSize (1° at 1°, 0.25° at HD) to get the
    // cell-index step the iterators consume. At HD this puts barbs
    // ~13 to a side instead of 52 to a side. The returned `lonDeg /
    // latDeg` fields surface the human-friendly degree spacing for the
    // sampling pill so it can render "9°×4°" regardless of resolution.
    function _evoComputeStep(viewport, target) {
        var lonW = Math.max(1, Math.abs(viewport.x[1] - viewport.x[0]));
        var latH = Math.max(1, Math.abs(viewport.y[1] - viewport.y[0]));
        var cellLat = (EVO_LATS && EVO_LATS.length >= 2)
            ? Math.abs(EVO_LATS[0] - EVO_LATS[1]) : 1.0;
        var cellLon = (EVO_LONS && EVO_LONS.length >= 2)
            ? Math.abs(EVO_LONS[1] - EVO_LONS[0]) : 1.0;
        var lonDeg = Math.max(cellLon, Math.round(lonW / target));
        var latDeg = Math.max(cellLat, Math.round(latH / target));
        // Clamp the human-facing degree spacing into [STEP_MIN, MAX].
        if (lonDeg < _EVO_STEP_MIN) lonDeg = _EVO_STEP_MIN;
        if (latDeg < _EVO_STEP_MIN) latDeg = _EVO_STEP_MIN;
        if (lonDeg > _EVO_STEP_MAX) lonDeg = _EVO_STEP_MAX;
        if (latDeg > _EVO_STEP_MAX) latDeg = _EVO_STEP_MAX;
        // Convert degrees → cell-index step, never below 1.
        var lonStep = Math.max(1, Math.round(lonDeg / cellLon));
        var latStep = Math.max(1, Math.round(latDeg / cellLat));
        return { latStep: latStep, lonStep: lonStep,
                 latDeg: latDeg, lonDeg: lonDeg };
    }
    // Vibrant TC-style wind palette — white at calm, sweeping through
    // green-yellow-orange-red-purple-cyan to peak. Used for raw
    // wind200, wind850, and shear heatmaps. Cyan at the top mirrors
    // the published Knaff-style intensity plot the user wanted to
    // match; the white floor keeps light winds visually subdued so
    // peak winds dominate the eye.
    var _EVO_WIND_COLORSCALE = [
        [0.00, '#ffffff'],
        [0.08, '#d4f0d8'],
        [0.18, '#7dd483'],
        [0.28, '#cfe24a'],
        [0.38, '#f4cd25'],
        [0.48, '#f5921e'],
        [0.58, '#e3401f'],
        [0.68, '#a01837'],
        [0.78, '#5c1163'],
        [0.88, '#2d2d8e'],
        [1.00, '#5fd6ff'],
    ];
    var _EVO_MS_TO_KT = 1.94384;
    var _EVO_SHAFT_DEG = 3.4;       // shaft length
    var _EVO_FEATHER_DEG = 1.4;     // perpendicular feather length
    var _EVO_HALF_DEG = 0.7;
    var _EVO_SPACING_DEG = 0.28;    // along-shaft gap between glyphs (~20% of feather)
    var _EVO_PENNANT_W_DEG = 0.56;  // pennant base along shaft

    // Build WMO barb glyphs for a u/v field on the EVO 1° grid.
    // Returns four polyline/polygon arrays:
    //   lineX, lineY  — shaft + feather strokes (NaN-separated)
    //   pennX, pennY  — filled pennant triangles (NaN-separated)
    // Two traces consume these (one stroke trace, one filled trace);
    // each is drawn twice in _evoBuildPlotlyTraces (dark halo + cream
    // ink on top) to match the Global Map's two-pass print look.
    // Streamline builder — integrates u/v from a regular seed lattice
    // via forward-Euler and emits NaN-separated polylines for a single
    // Plotly scatter trace. Mutually exclusive with the wind-barb
    // overlay (the user toggles between them). At each step we scale
    // the wind into (Δlon, Δlat) deg per step, with a cos(lat)
    // correction so trajectories don't bunch near the poles. The
    // integration stops when a parcel exits the 60°S-60°N box, hits a
    // NaN, or the cell speed falls below the calm threshold.
    var _EVO_STREAM_SEED_LAT_STEP = 6;   // ° between seeds (fallback)
    var _EVO_STREAM_SEED_LON_STEP = 6;
    var _EVO_STREAM_STEP_DEG = 0.7;      // along-trajectory step size
    var _EVO_STREAM_MAX_STEPS = 60;      // half-length each direction
    var _EVO_STREAM_MIN_KT = 3;          // calm cut-off
    function _evoBuildStreamlines(uGrid, vGrid, opts) {
        if (!uGrid || !vGrid) return { x: [], y: [] };
        opts = opts || {};
        var latStep = opts.latStep || _EVO_STREAM_SEED_LAT_STEP;
        var lonStep = opts.lonStep || _EVO_STREAM_SEED_LON_STEP;
        // Optional viewport clip — only seed inside the visible box
        // (plus a small pad so integrated polylines can drift slightly
        // outside without their seeds being culled).
        var vp = opts.viewport;
        var xMin = vp ? vp.x[0] - 4 : -Infinity;
        var xMax = vp ? vp.x[1] + 4 :  Infinity;
        var yMin = vp ? vp.y[0] - 4 : -Infinity;
        var yMax = vp ? vp.y[1] + 4 :  Infinity;
        // Use the live grid's lat/lon coverage rather than the
        // legacy hardcoded ±60° / -180..180 / 1° so HD-cropped basin
        // viewports decode correctly (their EVO_LATS / LONS span a
        // subset of the globe at 0.25°).
        var sLatMax = EVO_LATS[0];
        var sLatMin = EVO_LATS[EVO_LATS.length - 1];
        var sLonMin = EVO_LONS[0];
        var sLonMax = EVO_LONS[EVO_LONS.length - 1];
        var sCell = (EVO_LATS.length >= 2)
            ? Math.abs(EVO_LATS[0] - EVO_LATS[1]) : 1.0;
        // Detect a globe-wrapping lon span — in 1° non-HD mode the
        // longitude axis covers -180..179 so streamline integration can
        // wrap; in a cropped HD viewport it can't.
        var lonWraps = (sLonMax - sLonMin) >= 359;
        function uvAt(lon, lat) {
            if (lat > sLatMax || lat < sLatMin) return null;
            if (!lonWraps && (lon < sLonMin || lon > sLonMax)) return null;
            var iF = (sLatMax - lat) / sCell;
            var jRaw;
            if (lonWraps) {
                jRaw = ((lon - sLonMin) % 360 + 360) % 360 / sCell;
            } else {
                jRaw = (lon - sLonMin) / sCell;
            }
            var i0 = Math.floor(iF);
            var i1 = Math.min(i0 + 1, EVO_GRID_NY - 1);
            var j0 = Math.floor(jRaw);
            var j1 = lonWraps ? ((j0 + 1) % EVO_GRID_NX)
                              : Math.min(j0 + 1, EVO_GRID_NX - 1);
            if (i0 < 0 || i0 >= EVO_GRID_NY) return null;
            if (j0 < 0 || j0 >= EVO_GRID_NX) return null;
            var fi = iF - Math.floor(iF), fj = jRaw - Math.floor(jRaw);
            var u00 = uGrid[i0][j0], u01 = uGrid[i0][j1];
            var u10 = uGrid[i1][j0], u11 = uGrid[i1][j1];
            var v00 = vGrid[i0][j0], v01 = vGrid[i0][j1];
            var v10 = vGrid[i1][j0], v11 = vGrid[i1][j1];
            if (!Number.isFinite(u00) || !Number.isFinite(u01)
                || !Number.isFinite(u10) || !Number.isFinite(u11)
                || !Number.isFinite(v00) || !Number.isFinite(v01)
                || !Number.isFinite(v10) || !Number.isFinite(v11)) return null;
            var u = (1-fi)*(1-fj)*u00 + (1-fi)*fj*u01 + fi*(1-fj)*u10 + fi*fj*u11;
            var v = (1-fi)*(1-fj)*v00 + (1-fi)*fj*v01 + fi*(1-fj)*v10 + fi*fj*v11;
            var spd_kt = Math.sqrt(u*u + v*v) * _EVO_MS_TO_KT;
            if (spd_kt < _EVO_STREAM_MIN_KT) return null;
            return { u: u, v: v, mag: Math.sqrt(u*u + v*v) };
        }
        function trace(lon0, lat0, dir) {
            var pts = [[lon0, lat0]];
            var lon = lon0, lat = lat0;
            for (var s = 0; s < _EVO_STREAM_MAX_STEPS; s++) {
                var d = uvAt(lon, lat);
                if (!d) break;
                // Convert (u, v) m/s to (Δlon, Δlat) per step. Δlat /
                // Δlon * step magnitude follows the wind direction; the
                // cos(lat) factor on Δlon keeps trajectories from
                // wrapping faster near the poles.
                var cosL = Math.cos(lat * _EVO_DEG_TO_RAD);
                if (Math.abs(cosL) < 0.05) cosL = 0.05;
                var dirLon = (d.u / d.mag) / cosL;
                var dirLat = (d.v / d.mag);
                lon += dir * dirLon * _EVO_STREAM_STEP_DEG;
                lat += dir * dirLat * _EVO_STREAM_STEP_DEG;
                if (lat > 60 || lat < -60) break;
                pts.push([lon, lat]);
            }
            return pts;
        }
        var lineX = [], lineY = [];
        for (var iLat = 0; iLat < EVO_GRID_NY; iLat += latStep) {
            for (var iLon = 0; iLon < EVO_GRID_NX; iLon += lonStep) {
                var lon0 = EVO_LONS[iLon], lat0 = EVO_LATS[iLat];
                if (lon0 < xMin || lon0 > xMax || lat0 < yMin || lat0 > yMax) continue;
                if (!uvAt(lon0, lat0)) continue;
                var bw = trace(lon0, lat0, -1);
                bw.reverse();
                var fw = trace(lon0, lat0, +1).slice(1);
                var allPts = bw.concat(fw);
                if (allPts.length < 3) continue;
                if (lineX.length) { lineX.push(null); lineY.push(null); }
                for (var k = 0; k < allPts.length; k++) {
                    lineX.push(allPts[k][0]);
                    lineY.push(allPts[k][1]);
                }
            }
        }
        return { x: lineX, y: lineY };
    }

    // ── Animated particle overlay (Canvas2D) ───────────────────────
    // Replaces the static streamline polylines (formerly traces 9-10)
    // with continuously-advected particles, matching the TC Climatology
    // page's globe particle view. Particles are seeded uniformly over
    // the visible viewport, integrated forward-Euler on the current
    // frame's (u, v), and rendered as short fading trails on a Canvas2D
    // layer that sits above the Plotly heatmap. The canvas is sized +
    // positioned per Plotly's data area on every relayout.
    var _EVO_PCL_N         = 450;     // particle count
    var _EVO_PCL_TRAIL     = 8;       // history positions per particle
    var _EVO_PCL_MAX_AGE   = 140;     // frames until respawn (~4.5 s @ 30 fps)
    var _EVO_PCL_AGE_JIT   = 0.35;    // ±jitter on lifetime so deaths desync
    var _EVO_PCL_SPEED_DEG = 0.05;    // deg/frame per (m/s); tuned for 30 fps
    var _EVO_PCL_MIN_KT    = 1.5;     // calm cut-off — respawn under this
    var _EVO_PCL_FADE_IN   = 10;      // head opacity ramp from 0 on birth
    var _EVO_PCL_FADE_OUT  = 14;      // tail-end fade before death
    var _EVO_PCL_SPEED_NORM_MS = 22;  // m/s that saturates head opacity
    var _EVO_PCL_ERASE_ALPHA = 0.28;  // per-frame trail decay (higher → shorter persistence)
    var _evoParticles = {
        canvas: null, ctx: null, dpr: 1,
        // Flat per-particle arrays so we avoid the GC churn of object
        // allocations inside the hot RAF tick. lat/lon/age/lifetime are
        // primitives, trail is a packed lat/lon ring buffer.
        lat: null, lon: null, age: null, life: null,
        trailLat: null, trailLon: null, trailHead: null,
        rafId: 0, running: false,
        lastTickMs: 0,
        // Current frame's u/v grids (Array<Float32Array>). Swapped on
        // plotly_sliderchange / plotly_animated so the particles advect
        // on the displayed flow field, not a stale one.
        uGrid: null, vGrid: null,
        // Viewport ranges + per-grid coverage cached at start time so
        // uvAt doesn't have to recompute every tick.
        viewport: null,
        gridCfg: null,
    };

    function _evoParticleResize() {
        var el = document.getElementById('seasonal-evo-map');
        var c = _evoParticles.canvas;
        if (!el || !c) return;
        var rect = el.getBoundingClientRect();
        var dpr = window.devicePixelRatio || 1;
        var w = Math.max(1, Math.round(rect.width));
        var h = Math.max(1, Math.round(rect.height));
        if (c.width !== w * dpr || c.height !== h * dpr) {
            c.width  = w * dpr;
            c.height = h * dpr;
            c.style.width  = w + 'px';
            c.style.height = h + 'px';
            _evoParticles.dpr = dpr;
            _evoParticles.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            // Resize already wipes the canvas. Setting backing-buffer
            // dimensions resets pixel data to transparent, so margin
            // pixels from the prior viewport (if any) are clean.
        }
    }

    // Cached Plotly axis references. Refreshed by
    // _evoParticleCacheProjection() on every plotly_relayout (and at
    // particle start). Reading these out of Plotly's _fullLayout per
    // RAF tick burns ~108K getElementById + dict-lookup calls/sec at
    // 30 fps × 450 particles × 8 trail steps — caching drops that to
    // O(1) per relayout. The l2p closure references the live Plotly
    // axis state internally, so the cached function reflects the
    // current zoom/pan automatically without further re-caching.
    var _evoProj = {
        xa: null, ya: null,
        xOffset: 0, yOffset: 0,
        l2pX: null, l2pY: null,
    };
    function _evoParticleCacheProjection() {
        var el = document.getElementById('seasonal-evo-map');
        if (!el || !el._fullLayout) {
            _evoProj.l2pX = null;
            _evoProj.l2pY = null;
            return;
        }
        var xa = el._fullLayout.xaxis;
        var ya = el._fullLayout.yaxis;
        if (!xa || !ya || !xa.l2p) {
            _evoProj.l2pX = null;
            _evoProj.l2pY = null;
            return;
        }
        _evoProj.xa = xa;
        _evoProj.ya = ya;
        _evoProj.xOffset = xa._offset;
        _evoProj.yOffset = ya._offset;
        _evoProj.l2pX = xa.l2p;
        _evoProj.l2pY = ya.l2p;
    }
    // Single shared result object so we don't allocate {x, y} per
    // call (~3600 calls/tick × 30 fps = ~100K allocations/sec).
    var _evoProjOut = { x: 0, y: 0 };
    function _evoParticleProject(lat, lon) {
        if (!_evoProj.l2pX) return null;
        var px = _evoProj.l2pX.call(_evoProj.xa, lon);
        var py = _evoProj.l2pY.call(_evoProj.ya, lat);
        if (!isFinite(px) || !isFinite(py)) return null;
        _evoProjOut.x = _evoProj.xOffset + px;
        _evoProjOut.y = _evoProj.yOffset + py;
        return _evoProjOut;
    }

    // Spawn / respawn one particle at a random valid location inside
    // the viewport (and where the flow field is finite + non-calm).
    function _evoParticleSpawn(i, viewport) {
        var p = _evoParticles;
        var xMin = viewport.x[0], xMax = viewport.x[1];
        var yMin = viewport.y[0], yMax = viewport.y[1];
        for (var attempts = 0; attempts < 8; attempts++) {
            var lat = yMin + Math.random() * (yMax - yMin);
            var lon = xMin + Math.random() * (xMax - xMin);
            var uv = _evoParticleUvAt(lon, lat);
            if (uv && uv.spdKt >= _EVO_PCL_MIN_KT) {
                p.lat[i] = lat; p.lon[i] = lon; p.age[i] = 0;
                p.life[i] = _EVO_PCL_MAX_AGE
                    * (1 + (Math.random() - 0.5) * 2 * _EVO_PCL_AGE_JIT);
                // Pre-fill the trail with the spawn point — drawing
                // skips trail edges until age > 1 so the new particle
                // doesn't flash a zero-length segment.
                var base = i * _EVO_PCL_TRAIL;
                for (var k = 0; k < _EVO_PCL_TRAIL; k++) {
                    p.trailLat[base + k] = lat;
                    p.trailLon[base + k] = lon;
                }
                p.trailHead[i] = 0;
                return true;
            }
        }
        // No valid spot found after 8 tries — park the particle and
        // try again next frame.
        p.lat[i] = NaN; p.lon[i] = NaN;
        p.age[i] = _EVO_PCL_MAX_AGE + 1;   // will respawn on next tick
        return false;
    }

    // Bilinear (u, v) interpolation on the active grid — matches the
    // logic in _evoBuildStreamlines but reads from cached gridCfg.
    function _evoParticleUvAt(lon, lat) {
        var p = _evoParticles;
        var uGrid = p.uGrid, vGrid = p.vGrid;
        if (!uGrid || !vGrid) return null;
        var g = p.gridCfg;
        if (lat > g.latMax || lat < g.latMin) return null;
        if (!g.lonWraps && (lon < g.lonMin || lon > g.lonMax)) return null;
        var iF = (g.latMax - lat) / g.cell;
        var jRaw;
        if (g.lonWraps) {
            jRaw = ((lon - g.lonMin) % 360 + 360) % 360 / g.cell;
        } else {
            jRaw = (lon - g.lonMin) / g.cell;
        }
        var i0 = Math.floor(iF);
        var i1 = Math.min(i0 + 1, g.ny - 1);
        var j0 = Math.floor(jRaw);
        var j1 = g.lonWraps ? ((j0 + 1) % g.nx) : Math.min(j0 + 1, g.nx - 1);
        if (i0 < 0 || i0 >= g.ny || j0 < 0 || j0 >= g.nx) return null;
        var fi = iF - i0, fj = jRaw - Math.floor(jRaw);
        var u00 = uGrid[i0][j0], u01 = uGrid[i0][j1];
        var u10 = uGrid[i1][j0], u11 = uGrid[i1][j1];
        var v00 = vGrid[i0][j0], v01 = vGrid[i0][j1];
        var v10 = vGrid[i1][j0], v11 = vGrid[i1][j1];
        if (!Number.isFinite(u00) || !Number.isFinite(u01)
            || !Number.isFinite(u10) || !Number.isFinite(u11)
            || !Number.isFinite(v00) || !Number.isFinite(v01)
            || !Number.isFinite(v10) || !Number.isFinite(v11)) return null;
        var u = (1-fi)*(1-fj)*u00 + (1-fi)*fj*u01 + fi*(1-fj)*u10 + fi*fj*u11;
        var v = (1-fi)*(1-fj)*v00 + (1-fi)*fj*v01 + fi*(1-fj)*v10 + fi*fj*v11;
        var mag_ms = Math.sqrt(u*u + v*v);
        return { u: u, v: v, mag_ms: mag_ms, spdKt: mag_ms * _EVO_MS_TO_KT };
    }

    // Capture the active grid descriptor (covers HD / 1° / monthly all
    // the same way) so uvAt stays cheap.
    function _evoParticleCaptureGridCfg() {
        var ny = EVO_LATS.length, nx = EVO_LONS.length;
        var cell = (ny >= 2) ? Math.abs(EVO_LATS[0] - EVO_LATS[1]) : 1.0;
        var lonMin = EVO_LONS[0], lonMax = EVO_LONS[nx - 1];
        var lonWraps = (lonMax - lonMin) >= 359;
        return {
            ny: ny, nx: nx, cell: cell,
            latMax: EVO_LATS[0], latMin: EVO_LATS[ny - 1],
            lonMin: lonMin, lonMax: lonMax, lonWraps: lonWraps,
        };
    }

    function _evoParticleInit() {
        var p = _evoParticles;
        if (p.lat) return;       // already initialized
        p.canvas = document.getElementById('seasonal-evo-particles');
        if (!p.canvas) return;
        p.ctx = p.canvas.getContext('2d', { alpha: true });
        var n = _EVO_PCL_N;
        p.lat       = new Float32Array(n);
        p.lon       = new Float32Array(n);
        p.age       = new Float32Array(n);
        p.life      = new Float32Array(n);
        p.trailLat  = new Float32Array(n * _EVO_PCL_TRAIL);
        p.trailLon  = new Float32Array(n * _EVO_PCL_TRAIL);
        p.trailHead = new Int16Array(n);
        for (var i = 0; i < n; i++) { p.age[i] = _EVO_PCL_MAX_AGE + 1; }
        // Window-resize keeps the backing buffer aligned with the
        // Plotly data area when the user resizes the browser; the
        // RAF tick itself queries xa._offset live so positioning
        // self-corrects after Plotly's responsive relayout.
        window.addEventListener('resize', _evoParticleResize);
        // Page Visibility — pause the animation while the tab is
        // hidden so we don't burn cycles on an offscreen canvas.
        document.addEventListener('visibilitychange', function () {
            if (!_evoParticles.running) return;
            if (document.hidden) {
                cancelAnimationFrame(_evoParticles.rafId);
                _evoParticles.rafId = 0;
            } else if (!_evoParticles.rafId) {
                _evoParticles.lastTickMs = performance.now();
                _evoParticles.rafId = requestAnimationFrame(_evoParticleTick);
            }
        });
    }

    // Refresh the field grids + grid descriptor from the current frame.
    // Called when the particles start AND on every frame swap (so the
    // animation tracks slider scrubs through the year).
    function _evoParticleSyncField() {
        var p = _evoParticles;
        if (!_evoState.frames || !_evoState.overlayCtx) return;
        var idx = _evoState.currentFrameIdx || 0;
        var f = _evoState.frames[idx];
        if (!f) return;
        var uv = _evoFrameBarbUV(f, _evoState.overlayCtx);
        p.uGrid = uv.u;
        p.vGrid = uv.v;
        p.gridCfg = _evoParticleCaptureGridCfg();
        p.viewport = _evoComputeViewport(document.getElementById('seasonal-evo-map'));
    }

    function _evoParticleStart() {
        _evoParticleInit();
        var p = _evoParticles;
        if (!p.ctx) return;
        _evoParticleResize();
        _evoParticleSyncField();
        _evoParticleCacheProjection();
        if (!p.viewport || !p.uGrid) return;
        for (var i = 0; i < _EVO_PCL_N; i++) {
            _evoParticleSpawn(i, p.viewport);
        }
        p.canvas.classList.add('is-active');
        p.running = true;
        p.lastTickMs = performance.now();
        cancelAnimationFrame(p.rafId);
        p.rafId = requestAnimationFrame(_evoParticleTick);
    }

    function _evoParticleStop() {
        var p = _evoParticles;
        p.running = false;
        cancelAnimationFrame(p.rafId);
        p.rafId = 0;
        if (p.canvas) {
            p.canvas.classList.remove('is-active');
            if (p.ctx) {
                var w = p.canvas.width, h = p.canvas.height;
                p.ctx.setTransform(1, 0, 0, 1, 0, 0);
                p.ctx.clearRect(0, 0, w, h);
                p.ctx.setTransform(p.dpr, 0, 0, p.dpr, 0, 0);
            }
        }
    }

    function _evoParticleTick(timestamp) {
        var p = _evoParticles;
        if (!p.running || !p.ctx || !p.uGrid) return;
        // Frame-rate cap at ~30 fps so a 120 Hz display doesn't burn
        // 4× the work for no visual gain.
        var dt = timestamp - p.lastTickMs;
        if (dt < 28) {
            p.rafId = requestAnimationFrame(_evoParticleTick);
            return;
        }
        p.lastTickMs = timestamp;

        var ctx = p.ctx;
        var canvasW = p.canvas.width / p.dpr;
        var canvasH = p.canvas.height / p.dpr;
        // Motion-trail erase: alpha-blend a translucent panel-bg over
        // the previous frame so old trails fade out smoothly. We fade
        // only the data-area rect (where trails actually live) — the
        // margin band gets a single full clear per resize via
        // _evoParticleClearMargins. At 4K display × 30 fps that
        // shaves ~250 MP/sec of unnecessary fill work.
        var fadeRect = (_evoProj.l2pX)
            ? { x: _evoProj.xOffset, y: _evoProj.yOffset,
                w: _evoProj.xa._length, h: _evoProj.ya._length }
            : { x: 0, y: 0, w: canvasW, h: canvasH };
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0, 0, 0, ' + _EVO_PCL_ERASE_ALPHA + ')';
        ctx.fillRect(fadeRect.x, fadeRect.y, fadeRect.w, fadeRect.h);
        ctx.globalCompositeOperation = 'source-over';

        var viewport = p.viewport;
        var stepDeg = _EVO_PCL_SPEED_DEG;
        var lifeFade = _EVO_PCL_FADE_OUT;
        var birthFade = _EVO_PCL_FADE_IN;
        var speedNorm = _EVO_PCL_SPEED_NORM_MS;

        // Clip to the Plotly data area so particles that drift past
        // the axis edges don't draw on the margin. clipRect is
        // refreshed by _evoParticleCacheProjection on plotly_relayout;
        // reading it once per frame here is one struct lookup vs the
        // ~3600 _fullLayout dives the original implementation had.
        var clipRect = _evoProj.l2pX
            ? { x: _evoProj.xOffset, y: _evoProj.yOffset,
                w: _evoProj.xa._length, h: _evoProj.ya._length }
            : null;
        if (clipRect) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(clipRect.x, clipRect.y, clipRect.w, clipRect.h);
            ctx.clip();
        }

        // Batch all stroke calls into one path per "alpha bucket" so
        // ~450 particles × 7 segments stays well under 1 ms/frame.
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = 'rgba(244,240,224,0.95)';
        ctx.beginPath();
        for (var i = 0; i < _EVO_PCL_N; i++) {
            var age = p.age[i];
            var life = p.life[i];
            if (!isFinite(p.lat[i]) || age >= life) {
                _evoParticleSpawn(i, viewport);
                continue;
            }
            var lat = p.lat[i], lon = p.lon[i];
            var uv = _evoParticleUvAt(lon, lat);
            if (!uv || uv.spdKt < _EVO_PCL_MIN_KT) {
                _evoParticleSpawn(i, viewport);
                continue;
            }
            // Forward-Euler step. cos(lat) correction so Δlon scales
            // up at higher latitudes (degrees of longitude shrink as
            // we leave the equator).
            var cosL = Math.cos(lat * _EVO_DEG_TO_RAD);
            if (Math.abs(cosL) < 0.05) cosL = 0.05;
            var dLon = (uv.u / cosL) * stepDeg;
            var dLat = uv.v * stepDeg;
            var newLat = lat + dLat;
            var newLon = lon + dLon;
            if (newLat > viewport.y[1] + 4 || newLat < viewport.y[0] - 4
                || newLon > viewport.x[1] + 4 || newLon < viewport.x[0] - 4) {
                _evoParticleSpawn(i, viewport);
                continue;
            }
            // Append to trail ring buffer.
            var head = (p.trailHead[i] + 1) % _EVO_PCL_TRAIL;
            p.trailHead[i] = head;
            var tBase = i * _EVO_PCL_TRAIL;
            p.trailLat[tBase + head] = newLat;
            p.trailLon[tBase + head] = newLon;
            p.lat[i] = newLat;
            p.lon[i] = newLon;
            p.age[i] = age + 1;

            // Project + draw the trail. We walk backward from head
            // through TRAIL-1 prior positions, building short line
            // segments. _evoParticleProject returns a shared output
            // buffer to avoid per-call object allocation; save its
            // x/y as primitives BEFORE the next call mutates the
            // buffer (the trail loop would alias prev → pt otherwise).
            // Skip drawing entirely while the particle is in its very
            // first frames (age < 1) — the trail ring buffer is still
            // pre-filled with the spawn point, so segments would
            // collapse to zero length.
            if (age < 1) continue;
            var headPt = _evoParticleProject(newLat, newLon);
            if (!headPt) continue;
            var prevX = headPt.x, prevY = headPt.y;
            for (var k = 1; k < _EVO_PCL_TRAIL; k++) {
                var idx = (head - k + _EVO_PCL_TRAIL) % _EVO_PCL_TRAIL;
                var pt = _evoParticleProject(p.trailLat[tBase + idx],
                                              p.trailLon[tBase + idx]);
                if (!pt) break;
                ctx.moveTo(prevX, prevY);
                ctx.lineTo(pt.x, pt.y);
                prevX = pt.x; prevY = pt.y;
            }
        }
        ctx.stroke();
        // (Head dots removed — at 450 particles the trail strokes
        // already terminate in a 1.1 px round-cap, which reads as a
        // bright head without doubling the per-frame draw cost.)
        if (clipRect) ctx.restore();

        p.rafId = requestAnimationFrame(_evoParticleTick);
    }

    function _evoBuildBarbs(uGrid, vGrid, opts) {
        var empty = { lineX: [], lineY: [], pennX: [], pennY: [] };
        if (!uGrid || !vGrid) return empty;
        opts = opts || {};
        var latStep = opts.latStep || _EVO_BARB_LAT_STEP;
        var lonStep = opts.lonStep || _EVO_BARB_LON_STEP;
        // Optional viewport clip — skip cells outside the visible box
        // (pad by the glyph half-length so barbs near the edge still
        // draw their tail inside the viewport).
        var vp = opts.viewport;
        var xMin = vp ? vp.x[0] - _EVO_SHAFT_DEG : -Infinity;
        var xMax = vp ? vp.x[1] + _EVO_SHAFT_DEG :  Infinity;
        var yMin = vp ? vp.y[0] - _EVO_SHAFT_DEG : -Infinity;
        var yMax = vp ? vp.y[1] + _EVO_SHAFT_DEG :  Infinity;
        var lineX = [], lineY = [], pennX = [], pennY = [];
        // Skip cells below the published calm threshold (≈ 3 kt). Matches
        // the Global Map renderer in realtime_ir.js _drawWindBarb.
        var SPEED_THRESHOLD_KT = 3;
        for (var iLat = 0; iLat < EVO_GRID_NY; iLat += latStep) {
            for (var iLon = 0; iLon < EVO_GRID_NX; iLon += lonStep) {
                var lon = EVO_LONS[iLon], lat = EVO_LATS[iLat];
                if (lon < xMin || lon > xMax || lat < yMin || lat > yMax) continue;
                var uRow = uGrid[iLat], vRow = vGrid[iLat];
                if (!uRow || !vRow) continue;
                var u = uRow[iLon], v = vRow[iLon];
                if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
                var spd_kt = Math.sqrt(u * u + v * v) * _EVO_MS_TO_KT;
                if (spd_kt < SPEED_THRESHOLD_KT) continue;
                _evoAppendBarb(lineX, lineY, pennX, pennY,
                               lon, lat, u, v, spd_kt);
            }
        }
        return { lineX: lineX, lineY: lineY, pennX: pennX, pennY: pennY };
    }

    // Append one barb's strokes (shaft + feathers) and pennant triangles
    // to the destination arrays. Feathers/pennants sit on the LEFT of the
    // staff when looking downwind in the NH; per the climatology globe
    // convention we flip to the right in the SH so the glyph reads
    // correctly under coriolis-rotated rendering.
    function _evoAppendBarb(lineX, lineY, pennX, pennY,
                            lon, lat, u, v, spd_kt) {
        var mag = Math.sqrt(u * u + v * v);
        if (mag === 0) return;
        // (dx, dy) is the downwind unit vector (toward the direction
        // the wind is BLOWING). The shaft extends UPWIND from the
        // station — opposite of (dx, dy) — so the upwind unit (ux, uy)
        // is the vector we walk along when placing tip + feathers.
        var dx = u / mag, dy = v / mag;
        var ux = -dx, uy = -dy;
        // Perpendicular to the shaft. NH places feathers on the
        // observer's LEFT when looking from station outward along the
        // shaft; SH flips per the climatology-globe Coriolis convention.
        // The +1/-1 sign here mirrors realtime_ir.js _drawWindBarb.
        var sideSign = (lat < 0) ? +1 : -1;
        var px = -uy * sideSign, py = ux * sideSign;
        var tipX = lon + ux * _EVO_SHAFT_DEG;
        var tipY = lat + uy * _EVO_SHAFT_DEG;
        function seg(arrX, arrY, x1, y1, x2, y2) {
            if (arrX.length) { arrX.push(null); arrY.push(null); }
            arrX.push(x1, x2); arrY.push(y1, y2);
        }
        // Shaft.
        seg(lineX, lineY, lon, lat, tipX, tipY);
        // Round-to-5-kt glyph allocation.
        var rounded = Math.round(spd_kt / 5) * 5;
        var nPennants = Math.floor(rounded / 50);
        var rem = rounded - nPennants * 50;
        var nFull = Math.floor(rem / 10);
        var rem2 = rem - nFull * 10;
        var nHalf = (rem2 >= 5) ? 1 : 0;
        // pos = signed distance along the upwind unit (ux, uy) from
        // the station. Pennants ride closest to the upwind tip; full
        // feathers come next; a half feather (if any) is closest to the
        // station. We walk pos down toward the station between glyphs.
        var pos = _EVO_SHAFT_DEG;
        for (var p = 0; p < nPennants; p++) {
            // Filled triangle: tip-end base → apex (perpendicular out
            // by FEATHER_DEG) → behind-end base, closed.
            var baseAhead = pos;
            var baseBehind = pos - _EVO_PENNANT_W_DEG;
            var ax = lon + ux * baseAhead;
            var ay = lat + uy * baseAhead;
            var bx = lon + ux * baseAhead + px * _EVO_FEATHER_DEG;
            var by = lat + uy * baseAhead + py * _EVO_FEATHER_DEG;
            var cx = lon + ux * baseBehind;
            var cy = lat + uy * baseBehind;
            if (pennX.length) { pennX.push(null); pennY.push(null); }
            pennX.push(ax, bx, cx, ax);
            pennY.push(ay, by, cy, ay);
            pos -= _EVO_PENNANT_W_DEG + _EVO_SPACING_DEG * 0.5;
        }
        for (var f = 0; f < nFull; f++) {
            var bX = lon + ux * pos;
            var bY = lat + uy * pos;
            // Feathers angled slightly forward (toward the upwind tip)
            // so the glyph reads as a sweeping arrow rather than a "T".
            var tX = bX + px * _EVO_FEATHER_DEG + ux * (_EVO_FEATHER_DEG * 0.35);
            var tY = bY + py * _EVO_FEATHER_DEG + uy * (_EVO_FEATHER_DEG * 0.35);
            seg(lineX, lineY, bX, bY, tX, tY);
            pos -= _EVO_SPACING_DEG;
        }
        if (nHalf) {
            // If the half is the *only* glyph, set it back one notch
            // so it doesn't ride at the very tip alone (matches the
            // gc-atlas climatology globe behavior).
            if (nPennants === 0 && nFull === 0) pos -= _EVO_SPACING_DEG;
            var bhX = lon + ux * pos;
            var bhY = lat + uy * pos;
            var thX = bhX + px * _EVO_HALF_DEG + ux * (_EVO_HALF_DEG * 0.35);
            var thY = bhY + py * _EVO_HALF_DEG + uy * (_EVO_HALF_DEG * 0.35);
            seg(lineX, lineY, bhX, bhY, thX, thY);
        }
    }

    // Pull the climatology values for a calendar month from the
    // era5_climo grid sidecars. We prefer the global 360-col sidecar
    // (shear_NN.global.grid.json) which matches the daily-archive frame
    // exactly — no remapping needed. If that file isn't deployed yet
    // (older build_era5_climo_pngs.py run), fall back to the legacy
    // Pacific-centered 261-col file and roll it into the daily-tile
    // frame, accepting the lon 1..99 cutoff that introduces.
    function _evoLoadClimoForMonth(month) {
        var mm = (month < 10 ? '0' : '') + month;
        var globalUrl = EVO_CLIMO_BASE + '/shear_' + mm + '.global.grid.json';
        var pacUrl    = EVO_CLIMO_BASE + '/shear_' + mm + '.grid.json';
        // Try global first.
        return fetch(globalUrl)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (g) {
                if (g && g.values && g.n_lon === EVO_GRID_NX
                    && g.n_lat === EVO_GRID_NY) {
                    // Already in N→S × lon -180..179 frame.
                    // Convert each row to Float32Array so it matches
                    // the typed-array convention of frame/decoder
                    // outputs (cheaper memory, NaN-safe arithmetic).
                    return g.values.map(function (row) {
                        var t = new Float32Array(EVO_GRID_NX);
                        for (var k = 0; k < EVO_GRID_NX; k++) {
                            t[k] = (row[k] == null) ? NaN : row[k];
                        }
                        return t;
                    });
                }
                // Fall back to the Pacific-centered 261-col sidecar.
                return fetch(pacUrl)
                    .then(function (r2) { return r2.ok ? r2.json() : null; })
                    .then(function (p) {
                        if (!p) return null;
                        // p is south-to-north, lon_min=100, lon_max=360,
                        // n_lat=121, n_lon=261. Flip lats + roll lons into
                        // the daily-tile N→S × lon -180..179 frame.
                        var ny = p.n_lat, nx = p.n_lon;
                        var out = new Array(EVO_GRID_NY);
                        for (var i = 0; i < EVO_GRID_NY; i++) {
                            out[i] = new Float32Array(EVO_GRID_NX);
                            out[i].fill(NaN);
                        }
                        for (var iC = 0; iC < ny; iC++) {
                            var iD = 120 - iC;
                            if (iD < 0 || iD >= EVO_GRID_NY) continue;
                            for (var jC = 0; jC < nx; jC++) {
                                var jD = (280 + jC) % 360;
                                var v = p.values[iC][jC];
                                out[iD][jD] = (v == null) ? NaN : v;
                            }
                        }
                        return out;
                    });
            })
            .catch(function () { return null; });
    }

    // Pointwise vector-magnitude grid. Returns Array<Float32Array>.
    // NaN in either input propagates through Math.sqrt(NaN) → NaN, so
    // no explicit missing-value guard is needed.
    function _evoMag(aGrid, bGrid) {
        var ny = aGrid.length, nx = aGrid[0].length;
        var out = new Array(ny);
        for (var i = 0; i < ny; i++) {
            var row = new Float32Array(nx);
            var ar = aGrid[i], br = bGrid[i];
            for (var j = 0; j < nx; j++) {
                var a = ar[j], b = br[j];
                row[j] = Math.sqrt(a * a + b * b);
            }
            out[i] = row;
        }
        return out;
    }
    function _evoSub(aGrid, bGrid) {
        var ny = aGrid.length, nx = aGrid[0].length;
        var out = new Array(ny);
        for (var i = 0; i < ny; i++) {
            var row = new Float32Array(nx);
            var ar = aGrid[i], br = bGrid[i];
            for (var j = 0; j < nx; j++) {
                row[j] = ar[j] - br[j];
            }
            out[i] = row;
        }
        return out;
    }

    // Returns the u/v field-name pair the current variable depends on.
    function _evoVectorFieldsFor(variable) {
        if (variable === 'wind200') return { u: 'u200', v: 'v200', combine: 'level' };
        if (variable === 'wind850') return { u: 'u850', v: 'v850', combine: 'level' };
        // Default: shear — needs both levels.
        return { u200: 'u200', v200: 'v200', u850: 'u850', v850: 'v850', combine: 'shear' };
    }

    // ── Vorticity & divergence (daily, derived from u/v) ─────────────
    // Computed on-the-fly in the browser via centered differences on
    // the 1° lat-lon grid. We sit one cell in from each edge and wrap
    // longitudes. Spherical-earth scaling: x = a·cos(φ)·λ, y = a·φ.
    // Display units: ζ → 10⁻⁵ s⁻¹ (matches Panel B's vo850 monthly
    // product); δ → 10⁻⁶ s⁻¹.
    var _EVO_EARTH_RADIUS_M = 6.371e6;
    var _EVO_DEG_TO_RAD = Math.PI / 180;
    function _evoComputeVorticity(uGrid, vGrid) {
        var ny = uGrid.length, nx = uGrid[0].length;
        var out = new Array(ny);
        for (var i = 0; i < ny; i++) {
            out[i] = new Float32Array(nx);
            out[i].fill(NaN);
        }
        var dy = _EVO_EARTH_RADIUS_M * _EVO_DEG_TO_RAD;   // metres per 1° lat
        for (var i2 = 1; i2 < ny - 1; i2++) {
            var lat = EVO_LATS[i2];
            var cosLat = Math.cos(lat * _EVO_DEG_TO_RAD);
            if (Math.abs(cosLat) < 1e-3) continue;
            var dx = _EVO_EARTH_RADIUS_M * _EVO_DEG_TO_RAD * cosLat;
            for (var j = 0; j < nx; j++) {
                var jE = (j + 1) % nx;
                var jW = (j - 1 + nx) % nx;
                var vE = vGrid[i2][jE], vW = vGrid[i2][jW];
                // i2-1 is one row north (EVO_LATS descending), i2+1 one row south.
                var uN = uGrid[i2 - 1][j], uS = uGrid[i2 + 1][j];
                // NaN propagates through subtraction/division so the
                // explicit guard isn't needed — the resulting NaN
                // assignment is fine (Float32Array stores it natively).
                var dvdx = (vE - vW) / (2 * dx);
                var dudy = (uN - uS) / (2 * dy);
                out[i2][j] = (dvdx - dudy) * 1e5;
            }
        }
        return out;
    }
    function _evoComputeDivergence(uGrid, vGrid) {
        var ny = uGrid.length, nx = uGrid[0].length;
        var out = new Array(ny);
        for (var i = 0; i < ny; i++) {
            out[i] = new Float32Array(nx);
            out[i].fill(NaN);
        }
        var dy = _EVO_EARTH_RADIUS_M * _EVO_DEG_TO_RAD;
        for (var i2 = 1; i2 < ny - 1; i2++) {
            var lat = EVO_LATS[i2];
            var cosLat = Math.cos(lat * _EVO_DEG_TO_RAD);
            if (Math.abs(cosLat) < 1e-3) continue;
            var dx = _EVO_EARTH_RADIUS_M * _EVO_DEG_TO_RAD * cosLat;
            for (var j = 0; j < nx; j++) {
                var jE = (j + 1) % nx;
                var jW = (j - 1 + nx) % nx;
                var uE = uGrid[i2][jE], uW = uGrid[i2][jW];
                var vN = vGrid[i2 - 1][j], vS = vGrid[i2 + 1][j];
                var dudx = (uE - uW) / (2 * dx);
                var dvdy = (vN - vS) / (2 * dy);
                out[i2][j] = (dudx + dvdy) * 1e6;
            }
        }
        return out;
    }
    // Variables that derive z from u/v at a single level via the
    // helpers above. Each entry maps the picker value → which level's
    // wind tiles to fetch and which derivation to apply.
    var EVO_DERIVED_VARS = {
        vo200_d:  { level: 200, kind: 'vorticity'  },
        vo850_d:  { level: 850, kind: 'vorticity'  },
        div200_d: { level: 200, kind: 'divergence' },
        div850_d: { level: 850, kind: 'divergence' },
    };
    function _evoIsDerivedVar(variable) {
        return Object.prototype.hasOwnProperty.call(
            EVO_DERIVED_VARS, variable || '');
    }

    function _evoFetchYear(year, opts) {
        // Returns Promise<frames[]>. Frame shape:
        //   { month, day?, epochDay, label, z[NY][NX], u[NY][NX], v[NY][NX] }
        // z is the colormap background; u/v drive the barb overlay (null
        // for GC-ATLAS scalar variables — they don't carry a wind vector).
        // Per-variable derivation:
        //   shear  → z = |V200 − V850|, u/v = V200 − V850   (daily archive)
        //   wind200 → z = |V200|,        u/v = V200          (daily archive)
        //   wind850 → z = |V850|,        u/v = V850          (daily archive)
        //   mpi / rh700 / chi200 / vo850 / tcwv / u200_m / u850_m
        //                                                    (GC-ATLAS monthly)
        //
        // Optional progressive loading: opts = { priorityMonth, onPriorityReady }.
        // If priorityMonth is set, that month's tiles are fetched FIRST
        // (sequentially) before the remaining months kick off in parallel,
        // and onPriorityReady(slices) fires as soon as the priority month's
        // slices are built. This lets the caller paint the user's
        // currently-viewed month immediately on auto-HD promotion instead
        // of waiting for the full ~12-month decode.
        opts = opts || {};
        var priorityMonth   = opts.priorityMonth;
        var onPriorityReady = opts.onPriorityReady;
        var resolution = _evoState.resolution || 'monthly';
        var variable   = _evoState.variable || 'shear';
        if (_evoIsMonthlyOnly(variable)) {
            return _evoFetchYearMonthlyOnly(year);
        }
        return _evoLoadManifest().then(function (m) {
            if (!m) throw new Error('archive manifest unavailable');
            // Decide which raw u/v tiles to pull per month.
            // vo*_d / div*_d use the level's u + v tiles only.
            var derivedSpec = EVO_DERIVED_VARS[variable];
            var fields;
            if (derivedSpec) {
                fields = (derivedSpec.level === 200)
                    ? ['u200', 'v200']
                    : ['u850', 'v850'];
            } else if (variable === 'wind200') {
                fields = ['u200', 'v200'];
            } else if (variable === 'wind850') {
                fields = ['u850', 'v850'];
            } else {
                fields = ['u200', 'v200', 'u850', 'v850'];
            }
            // Per-month fetch + slice builder, factored into a helper so
            // the priority-month path can call it first and fire the
            // onPriorityReady callback for progressive rendering.
            function fetchMonth(mo) {
                var fieldFetches = fields.map(function (f) {
                    return _evoFetchFieldTile(f, year, mo)
                        .then(function (tile) { return { field: f, tile: tile }; })
                        .catch(function () { return null; });
                });
                return Promise.all(fieldFetches).then(function (results) {
                    // Bail if any required tile is missing for this month.
                    var byField = {};
                    for (var k = 0; k < results.length; k++) {
                        if (!results[k]) return [];
                        byField[results[k].field] = results[k].tile;
                    }
                    // Build per-day or per-month grids of u, v.
                    var nDays = byField[fields[0]].n_days;
                    var slices = [];   // [{ dayIdx?, monthMean?, uGrid, vGrid, zGrid }, ...]
                    function extractGrid(tile, dayIdx) {
                        return (dayIdx == null)
                            ? _evoMonthlyMean(tile)
                            : _evoExtractDayGrid(tile, dayIdx);
                    }
                    var indices = (resolution === 'daily')
                        ? Array.from({ length: nDays }, function (_, i) { return i; })
                        : [null];   // monthly mode = single mean
                    indices.forEach(function (dIdx) {
                        var uGrid, vGrid;
                        if (derivedSpec) {
                            // ζ/δ variables: pull the level u, v; the
                            // u/v stay on the frame as the level wind
                            // (so barbs read as that level's wind);
                            // z = vorticity or divergence.
                            var lvl = derivedSpec.level;
                            uGrid = extractGrid(byField['u' + lvl], dIdx);
                            vGrid = extractGrid(byField['v' + lvl], dIdx);
                        } else if (variable === 'wind200' || variable === 'wind850') {
                            var fU = (variable === 'wind200') ? 'u200' : 'u850';
                            var fV = (variable === 'wind200') ? 'v200' : 'v850';
                            uGrid = extractGrid(byField[fU], dIdx);
                            vGrid = extractGrid(byField[fV], dIdx);
                        } else {
                            // shear vector = (u200 - u850, v200 - v850).
                            var u200 = extractGrid(byField.u200, dIdx);
                            var v200 = extractGrid(byField.v200, dIdx);
                            var u850 = extractGrid(byField.u850, dIdx);
                            var v850 = extractGrid(byField.v850, dIdx);
                            uGrid = _evoSub(u200, u850);
                            vGrid = _evoSub(v200, v850);
                        }
                        var zGrid;
                        if (derivedSpec) {
                            zGrid = (derivedSpec.kind === 'vorticity')
                                ? _evoComputeVorticity(uGrid, vGrid)
                                : _evoComputeDivergence(uGrid, vGrid);
                        } else {
                            zGrid = _evoMag(uGrid, vGrid);
                        }
                        var dayNo = dIdx == null ? null : (dIdx + 1);
                        var epochDay = dayNo == null
                            ? Date.UTC(year, mo, 0) / 86400000
                            : Date.UTC(year, mo - 1, dayNo) / 86400000;
                        slices.push({
                            month: mo, day: dayNo,
                            epochDay: epochDay,
                            label: dayNo == null
                                ? _EVO_MONTH_NAMES[mo - 1]
                                : _EVO_MONTH_NAMES[mo - 1] + ' ' + dayNo,
                            z: zGrid, u: uGrid, v: vGrid,
                        });
                    });
                    return slices;
                });
            }
            var hasPriority = (typeof priorityMonth === 'number'
                            && priorityMonth >= 1 && priorityMonth <= 12);
            // Build the list of remaining months ordered by ABSOLUTE
            // calendar distance from the priority month, so that as the
            // browser drains its connection pool, the months adjacent to
            // the user's currently-viewed month decode first (the most
            // likely next-navigation targets). Without priority, we just
            // do 1..12 in calendar order.
            var remainingMonths = [];
            for (var month = 1; month <= 12; month++) {
                if (hasPriority && month === priorityMonth) continue;
                remainingMonths.push(month);
            }
            if (hasPriority) {
                remainingMonths.sort(function (a, b) {
                    return Math.abs(a - priorityMonth)
                         - Math.abs(b - priorityMonth);
                });
            }
            function fetchRest() {
                // Parallel fan-out over the remaining months. Their
                // ordering matters for browser queue behavior under
                // HTTP/2 stream prioritization (the first-pushed gets
                // a slightly earlier slot when connection limits bind).
                return Promise.all(remainingMonths.map(fetchMonth));
            }
            // Sequencing:
            //   priority month first (so it's not fighting 44+ sibling
            //     fetches for connection slots) →
            //   fire onPriorityReady so the caller can paint →
            //   then kick off the remaining months in parallel.
            // This means the user sees their current month appear as
            // soon as its tiles decode, with adjacent months filling
            // in behind it instead of all 12 fighting for bandwidth.
            if (hasPriority) {
                return fetchMonth(priorityMonth).then(function (priorSlices) {
                    if (typeof onPriorityReady === 'function') {
                        try { onPriorityReady(priorSlices); }
                        catch (e) {
                            console.warn('[seasonal-evo] onPriorityReady threw:', e);
                        }
                    }
                    return fetchRest().then(function (restChunks) {
                        var all = priorSlices ? priorSlices.slice() : [];
                        restChunks.forEach(function (c) {
                            c.forEach(function (f) { all.push(f); });
                        });
                        all.sort(function (a, b) {
                            return a.epochDay - b.epochDay;
                        });
                        return all;
                    });
                });
            }
            // Non-priority path: all months in parallel, original behavior.
            return Promise.all(remainingMonths.map(fetchMonth))
                .then(function (chunks) {
                    var all = [];
                    chunks.forEach(function (c) {
                        c.forEach(function (f) { all.push(f); });
                    });
                    all.sort(function (a, b) { return a.epochDay - b.epochDay; });
                    return all;
                });
        });
    }

    function _evoFetchClimoForFrames(frames) {
        // Fetch climo for each unique calendar month present in
        // `frames`. The 1991-2020 climatology is year-independent, so
        // the cache persists across year switches; the bind handler
        // invalidates it on variable / resolution changes (those
        // affect grid SHAPE).
        if (_evoState.climo) {
            return Promise.resolve(_evoState.climo);
        }
        var monthsSeen = {};
        frames.forEach(function (f) { monthsSeen[f.month] = true; });
        var pending = Object.keys(monthsSeen).map(function (m) {
            var mo = parseInt(m, 10);
            return _evoLoadClimoForMonth(mo).then(function (clim) {
                return { month: mo, clim: clim };
            });
        });
        return Promise.all(pending).then(function (results) {
            var byMonth = {};
            results.forEach(function (r) {
                if (r.clim) byMonth[r.month] = r.clim;
            });
            _evoState.climo = byMonth;
            return byMonth;
        });
    }

    // Resolve the barb (u, v) vectors for a frame given an overlay
    // context (built by _evoBuildPlotlyTraces and stashed on
    // _evoState.overlayCtx so live updates can call this from outside
    // the trace builder). In raw mode this is just frame.u / frame.v;
    // in anomaly mode we subtract the climo wind at the relevant
    // level(s) so the glyph reads as the anomaly of the vector — not
    // the raw V, which in the upper trop is dominated by the jet
    // regardless of season.
    function _evoFrameBarbUV(f, ctx) {
        if (!ctx) return { u: f && f.u, v: f && f.v };
        if (!ctx.modeIsAnom || ctx.isMonthly || !f || !f.u || !f.v) {
            return { u: f && f.u, v: f && f.v };
        }
        var wc = _evoState.windClimo && _evoState.windClimo[f.month];
        if (!wc || !wc.u200 || !wc.v200 || !wc.u850 || !wc.v850) {
            return { u: f.u, v: f.v };
        }
        var climU, climV;
        var variable = ctx.variable;
        if (variable === 'shear') {
            // Memoize the (u200 − u850) and (v200 − v850) climo arrays
            // per month — playback at 30 fps was burning ~21 MB/sec of
            // Float32Array allocations re-doing the subtraction every
            // frame swap. Stash on the wc object so the cache survives
            // alongside the climo's per-month entry.
            if (!wc._climU_shear) {
                wc._climU_shear = _evoSub(wc.u200, wc.u850);
                wc._climV_shear = _evoSub(wc.v200, wc.v850);
            }
            climU = wc._climU_shear;
            climV = wc._climV_shear;
        } else if (variable === 'wind200') {
            climU = wc.u200; climV = wc.v200;
        } else if (variable === 'wind850') {
            climU = wc.u850; climV = wc.v850;
        } else if (ctx.derivedSpec) {
            var lvl = ctx.derivedSpec.level;
            climU = wc['u' + lvl]; climV = wc['v' + lvl];
            if (!climU || !climV) return { u: f.u, v: f.v };
        } else {
            return { u: f.u, v: f.v };
        }
        return { u: _evoSub(f.u, climU), v: _evoSub(f.v, climV) };
    }

    // Recompute wind barbs (and streamlines if enabled) for the
    // current frame at the current viewport's sampling density, then
    // Plotly.restyle the overlay traces (indices 5-10). Cheap enough
    // to run on every frame tick + every zoom/pan; the sampling step
    // adapts via _evoComputeStep so a pinched-in Caribbean view gets
    // ~12 barbs per axis instead of the 4-5 that fixed 8°-stride
    // sampling produces. Also updates the "Sampling" pill so the user
    // sees what density they're getting.
    function _evoUpdateOverlays(el) {
        if (!el || !el._fullData || !_evoState.frames || !_evoState.overlayCtx) return;
        var idx = _evoState.currentFrameIdx || 0;
        var f = _evoState.frames[idx];
        if (!f) return;
        var viewport = _evoComputeViewport(el);
        var bStep = _evoComputeStep(viewport, _EVO_BARB_TARGET_PER_AXIS);
        var uv = _evoFrameBarbUV(f, _evoState.overlayCtx);
        var barbs = _evoState.showBarbs
            ? _evoBuildBarbs(uv.u, uv.v,
                { latStep: bStep.latStep, lonStep: bStep.lonStep, viewport: viewport })
            : { lineX: [], lineY: [], pennX: [], pennY: [] };
        // Restyle the four barb traces. Streamline traces (9, 10) are
        // permanently empty + hidden — the particle canvas owns the
        // flow visualization now.
        Plotly.restyle(el, {
            x: [barbs.lineX, barbs.lineX, barbs.pennX, barbs.pennX],
            y: [barbs.lineY, barbs.lineY, barbs.pennY, barbs.pennY],
        }, [5, 6, 7, 8]);
        // Particles, when active, advect on this frame's u/v + the
        // current viewport — keep them in sync with whatever the user
        // is viewing.
        if (_evoState.showStreamlines && _evoParticles.running) {
            _evoParticles.uGrid = uv.u;
            _evoParticles.vGrid = uv.v;
            _evoParticles.viewport = viewport;
            _evoParticles.gridCfg = _evoParticleCaptureGridCfg();
            _evoParticleResize();
            // Refresh the cached Plotly axis offsets so the RAF tick's
            // projection function picks up the new zoom/pan without
            // doing per-particle _fullLayout dives.
            _evoParticleCacheProjection();
        }
        // Update the sampling pill (lives next to the date readout).
        var pill = document.getElementById('seasonal-evo-sampling');
        if (pill) {
            // Display the human-readable degree spacing (lonDeg/latDeg)
            // rather than the cell-index step — at HD the cell step is
            // 4× larger for the same visual density, but the user
            // thinks in degrees, not cells.
            pill.textContent = bStep.lonDeg + '°×' + bStep.latDeg + '°';
            pill.title = 'Wind-barb sampling — adapts to the zoom level. '
                + 'Currently ' + bStep.lonDeg + '° lon × ' + bStep.latDeg
                + '° lat between glyphs.';
        }
    }

    function _evoBuildPlotlyTraces(frames) {
        // Returns the initial trace + frames[] for Plotly.newPlot with
        // animation. We build one heatmap trace + one combined-tracks
        // scatter trace + one combined-tracks marker trace per frame
        // so the slider can swap z arrays + track polylines cleanly.
        var variable = _evoState.variable || 'shear';
        var isWind = (variable === 'wind200' || variable === 'wind850');
        var isMonthly = _evoIsMonthlyOnly(variable);
        // Anomaly mode now works for ALL daily-archive variables —
        // shear (climo grid sidecar), derived ζ/δ (on-the-fly), AND
        // wind200/wind850 (computed from windClimo's u/v components).
        var modeIsAnom = (_evoState.mode === 'anomaly');
        var climo = modeIsAnom ? _evoState.climo : null;
        var monthNames = ['Jan','Feb','Mar','Apr','May','Jun',
                          'Jul','Aug','Sep','Oct','Nov','Dec'];

        // Anomaly mode: subtract climo per-cell. Daily frames still
        // anchor against the monthly climo for their calendar month
        // (we don't have day-of-year ERA5 climo yet — see PLAN doc).
        // Raw mode: identity.
        // For derived (ζ/δ) variables, the climo grid is computed
        // on-demand from windClimo[month].{uLLL, vLLL} using the same
        // helper that built f.z — cached per month for cheapness.
        var derivedClimo = {};
        function _derivedClimoFor(month) {
            if (!derivedSpec || !_evoState.windClimo) return null;
            if (derivedClimo[month]) return derivedClimo[month];
            var wc = _evoState.windClimo[month];
            if (!wc) return null;
            var lvl = derivedSpec.level;
            var uClim = wc['u' + lvl], vClim = wc['v' + lvl];
            if (!uClim || !vClim) return null;
            derivedClimo[month] = (derivedSpec.kind === 'vorticity')
                ? _evoComputeVorticity(uClim, vClim)
                : _evoComputeDivergence(uClim, vClim);
            return derivedClimo[month];
        }
        // Wind-magnitude climo: |V_climo| at the specified level for
        // a calendar month. Cached so playback doesn't re-mag the
        // same grid every frame swap.
        var windMagClimo = {};
        function _windMagClimoFor(month) {
            if (!isWind || !_evoState.windClimo) return null;
            if (windMagClimo[month]) return windMagClimo[month];
            var wc = _evoState.windClimo[month];
            if (!wc) return null;
            var lvl = (variable === 'wind200') ? 200 : 850;
            var u = wc['u' + lvl], v = wc['v' + lvl];
            if (!u || !v) return null;
            windMagClimo[month] = _evoMag(u, v);
            return windMagClimo[month];
        }
        function frameZ(f) {
            if (!modeIsAnom) return f.z;
            var clim;
            if (derivedSpec) {
                clim = _derivedClimoFor(f.month);
            } else if (isWind) {
                clim = _windMagClimoFor(f.month);
            } else {
                clim = climo && climo[f.month];
            }
            if (!clim) return f.z;   // fallback to raw if climo missing
            var ny = f.z.length, nx = f.z[0].length;
            var out = new Array(ny);
            for (var i = 0; i < ny; i++) {
                var row = new Float32Array(nx);
                var fr = f.z[i], cr = clim[i];
                if (!cr) { row.fill(NaN); out[i] = row; continue; }
                for (var j = 0; j < nx; j++) {
                    row[j] = fr[j] - cr[j];   // NaN propagates
                }
                out[i] = row;
            }
            return out;
        }

        // Per-variable colorbar label and raw-mode range. GC-ATLAS-backed
        // monthly variables carry their own colorscale + range in the
        // EVO_MONTHLY_VARS spec; daily-archive shear/wind speeds use the
        // hand-tuned palettes below.
        var monthlySpec = isMonthly ? EVO_MONTHLY_VARS[variable] : null;
        var derivedSpec = EVO_DERIVED_VARS[variable];
        var varLabel = monthlySpec ? monthlySpec.label
                     : derivedSpec ? (
                         (derivedSpec.kind === 'vorticity'
                            ? 'ζ at ' : 'δ at ') + derivedSpec.level + ' hPa')
                     : (variable === 'wind200') ? '200 mb wind'
                     : (variable === 'wind850') ? '850 mb wind'
                     : 'Shear';
        var varUnits = monthlySpec ? monthlySpec.units
                     : derivedSpec ? (derivedSpec.kind === 'vorticity'
                                        ? '10⁻⁵ s⁻¹' : '10⁻⁶ s⁻¹')
                     : 'm/s';
        var colorscale, zmin, zmax;
        if (modeIsAnom && isMonthly) {
            // GC-ATLAS variables get a per-variable anomaly range so the
            // diverging palette doesn't saturate (e.g., χ200 anomalies
            // swing ±5×10⁶ m² s⁻¹; RH700 anomalies ±20%).
            colorscale = 'RdBu_r';
            var anomR = monthlySpec.anomZmax || 10;
            zmin = -anomR; zmax = anomR;
        } else if (derivedSpec) {
            // ζ/δ: always diverging around 0 (raw and anomaly both
            // signed). Pick a saturation that captures synoptic-scale
            // features without saturating in the deep tropics.
            colorscale = 'RdBu_r';
            if (derivedSpec.kind === 'vorticity') {
                // Typical synoptic ζ scale: ±5 × 10⁻⁵ s⁻¹ for the
                // upper trop, ±2 × 10⁻⁵ s⁻¹ for the boundary layer
                // (low-level cyclonic eddies show up nicely there).
                var z = derivedSpec.level === 200 ? 5 : 3;
                zmin = -z; zmax = z;
            } else {
                // Divergence: roughly ±5 × 10⁻⁶ s⁻¹ for the upper trop
                // (where Hadley/Walker outflow lives), ±2 × 10⁻⁶ s⁻¹ at
                // 850 (boundary-layer convergence into ITCZ).
                var z2 = derivedSpec.level === 200 ? 5 : 2;
                zmin = -z2; zmax = z2;
            }
        } else if (modeIsAnom) {
            // Diverging around 0 — anomaly is symmetric.
            colorscale = 'RdBu_r';
            // wind200 anomalies: ±25 m/s captures jet-stream
            // displacement signals. wind850 anomalies: ±15 m/s for
            // low-level jet variability. shear anomaly: ±10 m/s
            // (typical synoptic-scale departure from climo).
            if (variable === 'wind200') {
                zmin = -25; zmax = 25;
            } else if (variable === 'wind850') {
                zmin = -15; zmax = 15;
            } else {
                zmin = -10; zmax = 10;
            }
        } else if (isMonthly) {
            colorscale = monthlySpec.colorscale;
            zmin = monthlySpec.zmin;
            zmax = monthlySpec.zmax;
        } else if (variable === 'wind200') {
            // Vibrant TC-intensity palette: white at calm, sweeping
            // through green-yellow-orange-red-purple to cyan at peak.
            // Modeled on the Knaff axisymmetric V_rot palette so the
            // colors emphasize peak winds the way TC forecasters read
            // intensity plots. Maps 0..80 m/s (~0..155 kt) so the
            // strongest jet cores hit the cyan saturation band.
            colorscale = _EVO_WIND_COLORSCALE;
            zmin = 0; zmax = 80;
        } else if (variable === 'wind850') {
            // 850-mb wind: TC-intensity palette. Upper bound bumped
            // from 30 → 50 m/s so peak Atlantic low-level jets +
            // strong TC inner-core winds reach the cyan band — at
            // 30 the palette saturated too early and the peaks
            // turned into a uniform red blob.
            colorscale = _EVO_WIND_COLORSCALE;
            zmin = 0; zmax = 50;
        } else {
            // Raw shear — TC-intensity palette over 0..30 m/s. White
            // (favorable, weak shear) → cyan (extremely sheared).
            colorscale = _EVO_WIND_COLORSCALE;
            zmin = 0; zmax = 30;
        }

        var colorbarTitle = modeIsAnom
            ? (varLabel + ' anom (' + varUnits + ')')
            : (varLabel + ' (' + varUnits + ')');
        var hoverField = modeIsAnom ? 'anom' : varLabel.toLowerCase();

        var baseTrace = {
            type: 'heatmap',
            x: EVO_LONS, y: EVO_LATS, z: frameZ(frames[0]),
            colorscale: colorscale, zmin: zmin, zmax: zmax,
            zsmooth: 'best',
            colorbar: {
                title: { text: colorbarTitle },
                thickness: 10,
            },
            hovertemplate: 'lat %{y}°, lon %{x}°<br>'
                + hoverField + ' %{z:.2f} ' + varUnits
                + '<extra></extra>',
        };

        // Build a minimal context so the live overlay-update path
        // (_evoUpdateOverlays) can derive barb/stream u/v from a frame
        // without rebuilding the entire trace spec. Stashed on
        // _evoState so frame/zoom/pan events can recompute overlays
        // for the current frame at the current viewport's sampling.
        _evoState.overlayCtx = {
            variable: variable,
            modeIsAnom: modeIsAnom,
            isMonthly: isMonthly,
            derivedSpec: derivedSpec || null,
        };
        function frameBarbUV(f) { return _evoFrameBarbUV(f, _evoState.overlayCtx); }

        var plotlyFrames = frames.map(function (f, idx) {
            var tracks = _evoBuildTracksForFrame(f);
            // Frame name uses a stable string per epoch day. Monthly
            // frames keep their month-string name (1..12) for back-compat
            // with prior slider steps; daily frames use the epoch-day
            // integer.
            var name = (f.day != null) ? 'd' + f.epochDay : String(f.month);
            // Barb (5-8) + streamline (9-10) traces are NOT swapped
            // on frame change — _evoUpdateOverlays rebuilds them with
            // viewport-aware sampling on plotly_sliderchange,
            // plotly_relayout, basin change, and toggle clicks. Baking
            // them into per-frame data would lock them to one sampling
            // density and cause inconsistency between the frame the
            // user scrubs to and the visible overlay.
            return {
                name: name,
                traces: [0, 2, 3, 4],
                data: [
                    { z: frameZ(f) },
                    { x: tracks.unnamedLineX, y: tracks.unnamedLineY },
                    { x: tracks.namedLineX,   y: tracks.namedLineY },
                    { x: tracks.markersX, y: tracks.markersY,
                      marker: { color: tracks.markersC, size: tracks.markersS,
                                line: { color: 'rgba(15,23,42,0.7)', width: 0.5 } },
                      text: tracks.markersT },
                ],
                // Storm-name labels rendered via the layout's
                // `annotations` array (Plotly's frames can swap that
                // alongside the trace data — drives the per-frame
                // "ANDREW · Cat 5" label appearing at his current
                // location).
                layout: {
                    annotations: tracks.labels.map(function (l) {
                        return {
                            x: l.x, y: l.y, xref: 'x', yref: 'y',
                            text: l.name + (l.cat ? ' · ' + l.cat : ''),
                            showarrow: false,
                            xanchor: 'left', yanchor: 'bottom',
                            xshift: 6, yshift: 4,
                            font: { size: 10, color: '#0f172a',
                                    family: 'DM Sans, system-ui, sans-serif',
                                    weight: 600 },
                            bgcolor: 'rgba(255,255,255,0.82)',
                            bordercolor: 'rgba(15,23,42,0.4)',
                            borderwidth: 0.5, borderpad: 2,
                        };
                    }),
                },
            };
        });

        // Slider step per frame. For daily mode (365 steps) we only
        // label the 1st of each month so the slider axis stays readable;
        // monthly mode labels every step.
        var sliderSteps = frames.map(function (f) {
            var name = (f.day != null) ? 'd' + f.epochDay : String(f.month);
            var stepLabel;
            if (f.day != null) {
                // Only label new months (day == 1) in daily mode.
                stepLabel = (f.day === 1) ? monthNames[f.month - 1] : '';
            } else {
                stepLabel = monthNames[f.month - 1];
            }
            return {
                label: stepLabel,
                method: 'animate',
                args: [[name], {
                    mode: 'immediate',
                    transition: { duration: 0 },
                    frame: { duration: 0, redraw: true },
                }],
            };
        });

        // Static coastline overlay — sits between the heatmap and the
        // storm tracks so countries are visible without obscuring TC
        // markers. Lazy-loaded once per session; frames skip this
        // trace via the `traces: [0, 2, 3, 4]` indexing above.
        var coastlines = _evoState.coastlines || { x: [], y: [] };
        var coastlineTrace = {
            type: 'scatter', mode: 'lines',
            x: coastlines.x, y: coastlines.y,
            line: { color: 'rgba(248,250,252,0.9)', width: 1.1 },
            hoverinfo: 'skip', showlegend: false,
            name: 'coastlines',
        };

        // Initial traces for the first frame. Two line traces (unnamed
        // muted, named bright) draw under the markers; the markers
        // carry the per-fix Saffir-Simpson color.
        var initialTracks = _evoBuildTracksForFrame(frames[0].month);
        var unnamedLineTrace = {
            type: 'scatter', mode: 'lines',
            x: initialTracks.unnamedLineX, y: initialTracks.unnamedLineY,
            line: { color: 'rgba(255,255,255,0.25)', width: 1, dash: 'dot' },
            hoverinfo: 'skip', showlegend: false,
            name: 'Unnamed system tracks',
        };
        var namedLineTrace = {
            type: 'scatter', mode: 'lines',
            x: initialTracks.namedLineX, y: initialTracks.namedLineY,
            line: { color: 'rgba(255,255,255,0.85)', width: 1.6 },
            hoverinfo: 'skip', showlegend: false,
            name: 'Named storm tracks',
        };
        var markerTrace = {
            type: 'scatter', mode: 'markers',
            x: initialTracks.markersX, y: initialTracks.markersY,
            text: initialTracks.markersT,
            marker: {
                color: initialTracks.markersC,
                size: initialTracks.markersS,
                line: { color: 'rgba(15,23,42,0.7)', width: 0.5 },
            },
            hovertemplate: '%{text}<extra></extra>',
            showlegend: false,
            name: 'TC fixes',
        };
        // Initial label annotations for frame 0.
        var initialLabels = initialTracks.labels.map(function (l) {
            return {
                x: l.x, y: l.y, xref: 'x', yref: 'y',
                text: l.name + (l.cat ? ' · ' + l.cat : ''),
                showarrow: false,
                xanchor: 'left', yanchor: 'bottom',
                xshift: 6, yshift: 4,
                font: { size: 10, color: '#0f172a',
                        family: 'DM Sans, system-ui, sans-serif',
                        weight: 600 },
                bgcolor: 'rgba(255,255,255,0.82)',
                bordercolor: 'rgba(15,23,42,0.4)',
                borderwidth: 0.5, borderpad: 2,
            };
        });

        // Wind barbs — drawn in two passes per WMO publication style:
        // a wider dark halo underneath, then a cream "print ink" stroke
        // on top. Pennants render as the same two-pass treatment via a
        // pair of filled scatter traces with fill:'toself'. Order in the
        // figure: shaft+feather halo → ink → pennant halo → pennant ink,
        // so the cream ink sits on top everywhere.
        var initialBarbUV = frameBarbUV(frames[0]);
        var initialBarbs = _evoBuildBarbs(initialBarbUV.u, initialBarbUV.v);
        var barbHalo = {
            type: 'scatter', mode: 'lines',
            x: initialBarbs.lineX, y: initialBarbs.lineY,
            line: { color: 'rgba(15,23,42,0.7)', width: 2.6 },
            hoverinfo: 'skip', showlegend: false,
            name: 'Wind barbs (halo)',
        };
        var barbInk = {
            type: 'scatter', mode: 'lines',
            x: initialBarbs.lineX, y: initialBarbs.lineY,
            line: { color: 'rgba(244,240,224,0.95)', width: 1.1 },
            hoverinfo: 'skip', showlegend: false,
            name: 'Wind barbs',
        };
        var pennantHalo = {
            type: 'scatter', mode: 'lines',
            x: initialBarbs.pennX, y: initialBarbs.pennY,
            line: { color: 'rgba(15,23,42,0.7)', width: 2.6 },
            fill: 'toself', fillcolor: 'rgba(15,23,42,0.7)',
            hoverinfo: 'skip', showlegend: false,
            name: 'Pennants (halo)',
        };
        var pennantInk = {
            type: 'scatter', mode: 'lines',
            x: initialBarbs.pennX, y: initialBarbs.pennY,
            line: { color: 'rgba(244,240,224,0.95)', width: 1.1 },
            fill: 'toself', fillcolor: 'rgba(244,240,224,0.95)',
            hoverinfo: 'skip', showlegend: false,
            name: 'Pennants',
        };

        // Streamlines (mutually exclusive with barbs). Same two-pass
        // halo + ink rendering so they read on light + dark heatmap
        // colors. We only seed-trace when the overlay is on, since
        // the integration is non-trivial per frame.
        var initialStreams = _evoState.showStreamlines
            ? _evoBuildStreamlines(initialBarbUV.u, initialBarbUV.v)
            : { x: [], y: [] };
        var streamHalo = {
            type: 'scatter', mode: 'lines',
            x: [], y: [],
            line: { color: 'rgba(15,23,42,0.55)', width: 2.4, shape: 'spline' },
            hoverinfo: 'skip', showlegend: false,
            name: 'Streamlines (halo, legacy — superseded by particle canvas)',
            visible: false,
        };
        var streamInk = {
            type: 'scatter', mode: 'lines',
            x: [], y: [],
            line: { color: 'rgba(244,240,224,0.9)', width: 1.0, shape: 'spline' },
            hoverinfo: 'skip', showlegend: false,
            name: 'Streamlines (legacy — superseded by particle canvas)',
            visible: false,
        };
        // Apply state-driven visibility to barb + track traces too.
        barbHalo.visible    = _evoState.showBarbs;
        barbInk.visible     = _evoState.showBarbs;
        pennantHalo.visible = _evoState.showBarbs;
        pennantInk.visible  = _evoState.showBarbs;
        unnamedLineTrace.visible = _evoState.showTracks;
        namedLineTrace.visible   = _evoState.showTracks;
        markerTrace.visible      = _evoState.showTracks;

        return {
            traces: [baseTrace, coastlineTrace,
                     unnamedLineTrace, namedLineTrace, markerTrace,
                     barbHalo, barbInk, pennantHalo, pennantInk,
                     streamHalo, streamInk],
            frames: plotlyFrames,
            sliderSteps: sliderSteps,
            // Strip storm labels if tracks are hidden.
            initialLabels: _evoState.showTracks ? initialLabels : [],
        };
    }

    function _evoRender() {
        var el = document.getElementById('seasonal-evo-map');
        if (!el || typeof Plotly === 'undefined') return;
        // Render-token: cancel any in-flight render when a new one
        // starts. A rapid sequence (e.g., zoom auto-HD + resolution
        // change firing within <1 s) would otherwise race — the
        // first-to-finish would consume _pendingViewport /
        // _pendingFrameEpoch, leaving the later (correct) render
        // with empty pendings + a snap to defaults.
        var myToken = (_evoState._renderToken || 0) + 1;
        _evoState._renderToken = myToken;
        // Configure the source-grid + viewport crop BEFORE any tile
        // decode. EVO_GRID_NY/NX/LATS/LONS get re-derived from
        // (resolution, basin, hd) so all downstream iterators see a
        // consistent shape. GC-ATLAS monthly variables ignore HD (they
        // ship at 1° only) and always fall back to the 1° source cfg.
        // Effective HD is computed from (hdMode, viewport, year) — see
        // _evoComputeEffectiveHd. Both _evoState.hd and .effectiveHd
        // get set so legacy hd-reading code keeps working while the
        // new viewport-driven path uses the same source of truth.
        var liveViewport = _evoComputeViewport(el);
        var hd = _evoComputeEffectiveHd(liveViewport);
        _evoState.effectiveHd = hd;
        _evoState.hd = hd;
        _evoState.srcCfg = _evoSrcConfig(hd);
        _evoState.crop = _evoCropForBasin(_evoState.srcCfg,
                                          _evoState.basin, hd);
        _evoApplyGridShape(_evoState.srcCfg, _evoState.crop);
        _evoUpdateHdButton();
        _evoUpdateResolutionChip();
        var variable = _evoState.variable || 'shear';
        var monthlySpec = EVO_MONTHLY_VARS[variable];
        var loadLabel = monthlySpec ? monthlySpec.label
                      : (variable === 'wind200') ? '200 mb wind'
                      : (variable === 'wind850') ? '850 mb wind'
                      : 'shear';
        var year = _evoState.year;
        // Fast path — cache hit. Skip the network round-trip entirely
        // when the user toggles back to a (year, resolution, basin)
        // triple they've already viewed this session.
        var cacheKey = _evoCacheKey(year, hd, _evoState.basin,
                                    _evoState.resolution, variable);
        var cachedFrames = _evoFramesCacheGet(cacheKey);
        var fieldP;
        if (cachedFrames) {
            fieldP = Promise.resolve(cachedFrames);
            // No stub — frames are already in hand.
        } else {
            el.innerHTML = '<div class="seasonal-panel-stub" style="padding:80px;'
                + 'text-align:center;">Loading ' + _evoState.year + ' '
                + loadLabel
                + (hd ? ' (HD 0.25°)' : '')
                + ' archive…</div>';
            // Progressive HD loading: when in HD mode (where the per-
            // month decode is ~2-3× heavier than 1°), paint the user's
            // currently-viewed month BEFORE the remaining months finish
            // loading. This trims the perceived wait from ~12 months'
            // worth of decode to ~1 month's worth. We scope to HD only
            // because (a) it's where the wait is long enough to matter,
            // and (b) HD already skips climo subtraction so the partial
            // draw doesn't need a parallel climo fetch.
            var fetchOpts = {};
            if (hd && !_evoIsMonthlyOnly(variable)) {
                var priorityMonth = null;
                // 1) Pending frame epoch — set by resolution-flip /
                //    auto-HD-promote handlers when the user was already
                //    viewing a specific frame.
                if (typeof _evoState._pendingFrameEpoch === 'number') {
                    var pd = new Date(_evoState._pendingFrameEpoch * 86400000);
                    priorityMonth = pd.getUTCMonth() + 1;
                } else if (_evoState.frames && _evoState.frames.length) {
                    // 2) Live current frame from the previous render.
                    var curIdx = _evoState.currentFrameIdx || 0;
                    var curF = _evoState.frames[curIdx];
                    if (curF && typeof curF.month === 'number') {
                        priorityMonth = curF.month;
                    }
                }
                if (priorityMonth != null) {
                    fetchOpts.priorityMonth = priorityMonth;
                    fetchOpts.onPriorityReady = function (priorSlices) {
                        // Bail if a newer render has started, or the
                        // user moved to a different year. Also bail if
                        // a later full-fetch already populated frames
                        // (shouldn't happen — onPriorityReady fires
                        // BEFORE the full Promise resolves — but be
                        // defensive across future refactors).
                        if (_evoState._renderToken !== myToken) return;
                        if (_evoState.year !== year) return;
                        if (!priorSlices || !priorSlices.length) return;
                        if (_evoState._progressivePartialDrawn) return;
                        _evoState._progressivePartialDrawn = true;
                        // Sort the (potentially many days of) slices
                        // by epochDay so the slider reads left-to-right.
                        var partialFrames = priorSlices.slice().sort(
                            function (a, b) { return a.epochDay - b.epochDay; });
                        _evoState.frames = partialFrames;
                        // _pendingFrameEpoch is consumed by _evoDrawPlotly's
                        // startIdx selector — keep it set so the partial
                        // draw lands on the right frame, then re-set it
                        // here so the FULL draw can land on it too.
                        var savedEpoch = _evoState._pendingFrameEpoch;
                        var savedViewport = _evoState._pendingViewport;
                        _evoDrawPlotly(el, partialFrames);
                        // _evoDrawPlotly nulls _pendingViewport; restore
                        // it for the full-frame draw that follows. The
                        // frame epoch is restored from the saved value
                        // (the partial draw consumed it).
                        if (savedEpoch != null) {
                            _evoState._pendingFrameEpoch = savedEpoch;
                        } else if (partialFrames[0]) {
                            // Stash the first partial frame's epochDay
                            // so the full draw lands back on roughly
                            // the same time. The startIdx selector will
                            // match calendar month for monthly mode.
                            _evoState._pendingFrameEpoch = partialFrames[0].epochDay;
                        }
                        if (savedViewport) {
                            _evoState._pendingViewport = {
                                x: savedViewport.x.slice(),
                                y: savedViewport.y.slice(),
                            };
                        }
                    };
                }
            }
            // Reset the partial-drawn guard for THIS render. Without
            // this, a 2nd HD render in the same session would skip its
            // own partial draw because the flag was sticky.
            _evoState._progressivePartialDrawn = false;
            fieldP = _evoFetchYear(year, fetchOpts).then(function (frames) {
                if (frames && frames.length) {
                    _evoFramesCacheSet(cacheKey, frames);
                }
                return frames;
            });
        }
        // Fan out: field tiles + climo (if anomaly mode) + IBTrACS metadata
        // + IBTrACS tracks all in parallel. Tracks are heavy (~22 MB) but
        // load once per session and stay cached for subsequent year changes.
        var stormsP = _evoLoadStorms();
        var tracksP = _evoLoadTracks();
        fieldP.then(function (frames) {
            // Superseded by a newer render? Bail without consuming the
            // pending viewport / frame-epoch state — those are intended
            // for the most-recent caller, not us.
            if (_evoState._renderToken !== myToken) return;
            if (_evoState.year !== year) return;     // user moved on
            if (!frames || !frames.length) {
                el.innerHTML = '<div class="seasonal-panel-stub" style="padding:80px;'
                    + 'text-align:center;">No archive data for ' + year + '.</div>';
                return;
            }
            _evoState.frames = frames;
            var prep = [stormsP, tracksP, _evoLoadCoastlines()];
            // HD mode + era5_daily variables: skip climo fetch. The
            // climo grid sidecar is 1° / 121×360 globe and would need
            // bilinear interpolation onto the HD-cropped 0.25° grid
            // to subtract correctly. For v1 we just render raw in HD
            // (the heatmap still shows the current shear / wind field,
            // just without the climo subtraction overlay).
            if (_evoState.mode === 'anomaly' && hd) {
                // Drop any stale climo from a previous non-HD render
                // so frameZ takes the raw path in _evoBuildPlotlyTraces.
                _evoState.climo = null;
                _evoState.windClimo = null;
            }
            var isWindVar = (_evoState.variable === 'wind200'
                          || _evoState.variable === 'wind850');
            if (_evoState.mode === 'anomaly' && !hd) {
                if (_evoIsMonthlyOnly(_evoState.variable)) {
                    // GC-ATLAS-backed variables fetch their climo from
                    // the same source.
                    prep.push(_evoFetchGcAtlasClimoForFrames(frames)
                        .then(function (c) { _evoState.climo = c; }));
                } else if (isWindVar) {
                    // Wind anomaly = |V_now| − |V_climo|. Need ONLY
                    // the wind-component climo (u, v at the relevant
                    // level); the shear-magnitude grid sidecar isn't
                    // applicable here. _windMagClimoFor in
                    // _evoBuildPlotlyTraces computes |V_climo| lazily.
                    prep.push(_evoFetchWindClimoForFrames(frames));
                } else {
                    // shear (and derived ζ/δ): need both the shear-
                    // magnitude climo grid AND the level-wind climo
                    // (the latter for the anomalous-barb vector).
                    prep.push(_evoFetchClimoForFrames(frames));
                    prep.push(_evoFetchWindClimoForFrames(frames));
                }
            }
            return Promise.all(prep).then(function () {
                if (_evoState.year !== year) return;
                _evoDrawPlotly(el, frames);
            });
        }).catch(function (e) {
            console.warn('[seasonal-evo] year fetch failed:', e);
            el.innerHTML = '<div class="seasonal-panel-stub" style="padding:80px;'
                + 'text-align:center;color:#ef4444;">Failed to load '
                + year + ': ' + e.message + '</div>';
        });
    }

    // Light re-render when basin or track-depth changes — no tile/track
    // re-fetch needed, just rebuild the scatter trace data + reapply via
    // Plotly.animate so the slider state is preserved.
    function _evoRerenderTracksOnly() {
        var el = document.getElementById('seasonal-evo-map');
        if (!el || !_evoState.frames || !el.classList.contains('js-plotly-plot')) return;
        // Re-run the trace builder against the cached frames+tracks
        // state. We can just call _evoDrawPlotly which is idempotent
        // (Plotly.newPlot replaces the existing chart).
        _evoDrawPlotly(el, _evoState.frames);
    }

    function _evoDrawPlotly(el, frames) {
        _evoApplyWrapAspect(_evoState.basin);
        var built = _evoBuildPlotlyTraces(frames);
        // Choose the initial xaxis/yaxis range. If the caller stashed
        // a _pendingViewport (e.g., auto-HD promotion preserving the
        // user's zoom), honor it. Otherwise fall back to the basin's
        // default viewport. _pendingViewport is consumed on use so
        // a subsequent basin-change render still picks the new basin
        // default.
        var initialView = _evoState._pendingViewport
            || { x: _evoViewForBasin(_evoState.basin).x.slice(),
                 y: _evoViewForBasin(_evoState.basin).y.slice() };
        _evoState._pendingViewport = null;
        var layout = {
            margin: { l: 50, r: 70, t: 10, b: 30 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            // scaleanchor locks the 1°-lon = 1°-lat aspect so the map
            // isn't horizontally squashed by the wrapping div.
            xaxis: { range: initialView.x.slice(),
                     showgrid: false,
                     title: { text: 'Longitude', font: { size: 10 } },
                     scaleanchor: 'y', scaleratio: 1, constrain: 'domain' },
            yaxis: { range: initialView.y.slice(),
                     showgrid: false,
                     title: { text: 'Latitude', font: { size: 10 } },
                     constrain: 'domain' },
            font: { family: 'DM Sans, system-ui, sans-serif', size: 11,
                    color: (document.documentElement.getAttribute('data-theme')
                            === 'dark') ? '#dfe6f0' : '#1f2937' },
            sliders: [{
                pad: { t: 30 }, len: 0.85, x: 0.05, y: -0.05,
                currentvalue: { visible: false },
                steps: built.sliderSteps,
            }],
            annotations: built.initialLabels || [],
        };
        // Clear any leftover "Loading…" stub the renderer parked here
        // before Plotly's first paint. newPlot replaces innerHTML on
        // first draw but a stub div parented to el remains visible until
        // Plotly takes over fully.
        var stub = el.querySelector('.seasonal-panel-stub');
        if (stub) stub.remove();
        Plotly.newPlot(el, built.traces, layout, {
            displayModeBar: false, responsive: true,
        }).then(function () {
            Plotly.addFrames(el, built.frames);
            // Build a name → friendly label map for the date readout.
            // Daily-mode frames have names like 'd<epochDay>'; monthly
            // have '1'..'12'. The frame's own `.label` is the human form.
            var labelByName = {};
            var indexByName = {};
            frames.forEach(function (f, i) {
                var name = (f.day != null) ? 'd' + f.epochDay : String(f.month);
                labelByName[name] = f.label;
                indexByName[name] = i;
            });
            var dateEl = document.getElementById('seasonal-evo-date');
            var dateJumpEl = document.getElementById('seasonal-evo-date-jump');
            // Set the date input's min/max to the year range so the
            // calendar widget only offers valid dates. Min = Jan 1 of
            // the active year, max = Dec 31. The "Jump" handler then
            // snaps the picked date to the nearest available frame.
            if (dateJumpEl) {
                var yr = _evoState.year;
                dateJumpEl.min = yr + '-01-01';
                dateJumpEl.max = yr + '-12-31';
            }
            // Sync the date-jump input's value to the current frame's
            // epoch day so the calendar opens on the right month.
            function _syncDateJump(frameName) {
                if (!dateJumpEl) return;
                var f = _evoState.frames
                    && _evoState.frames[indexByName[frameName] || 0];
                if (!f) return;
                var d = new Date(f.epochDay * 86400000);
                var iso = d.getUTCFullYear() + '-'
                    + String(d.getUTCMonth() + 1).padStart(2, '0') + '-'
                    + String(d.getUTCDate()).padStart(2, '0');
                if (dateJumpEl.value !== iso) dateJumpEl.value = iso;
            }
            function setDate(frameName) {
                if (dateEl) {
                    var lab = labelByName[frameName] || frameName;
                    dateEl.textContent = _evoState.year + ' · ' + lab;
                }
                _syncDateJump(frameName);
            }
            // Bind the date-jump input → find the closest frame by
            // epochDay and navigate. In monthly mode any date in a
            // month maps to that month's frame; in daily mode any
            // date maps to its calendar day (or the closest available
            // if the user picks a day outside the cached range).
            if (dateJumpEl && !dateJumpEl._evoBound) {
                dateJumpEl._evoBound = true;
                dateJumpEl.addEventListener('change', function () {
                    var parts = dateJumpEl.value.split('-');
                    if (parts.length !== 3) return;
                    var pickedYear = parseInt(parts[0], 10);
                    var pickedMonth = parseInt(parts[1], 10);  // 1-12
                    var pickedDay = parseInt(parts[2], 10);
                    var pickedEpoch = Date.UTC(pickedYear,
                        pickedMonth - 1, pickedDay) / 86400000;
                    var bestIdx = 0;
                    var bestDist = Infinity;
                    var fr = _evoState.frames || [];
                    // Monthly-mode matching: pick the frame whose
                    // CALENDAR MONTH equals the picked month. Without
                    // this, the user picks "Aug 15" and the closest-
                    // epochDay match is the Jul-end-of-month frame
                    // (epochDay = Jul 31, only 10 days from Aug 15;
                    // Aug-end-of-month at Aug 31 is 21 days away).
                    // Daily mode keeps the closest-day match.
                    var monthlyMode = fr.length > 0 && fr[0].day == null;
                    if (monthlyMode) {
                        for (var i = 0; i < fr.length; i++) {
                            if (fr[i].month === pickedMonth) {
                                bestIdx = i;
                                bestDist = 0;
                                break;
                            }
                        }
                        // Fallback to nearest-month if the exact
                        // calendar month isn't in the active frame set.
                        if (bestDist > 0) {
                            for (var i2 = 0; i2 < fr.length; i2++) {
                                var d2 = Math.abs(fr[i2].month - pickedMonth);
                                if (d2 < bestDist) {
                                    bestDist = d2; bestIdx = i2;
                                }
                            }
                        }
                    } else {
                        for (var i3 = 0; i3 < fr.length; i3++) {
                            var d3 = Math.abs(fr[i3].epochDay - pickedEpoch);
                            if (d3 < bestDist) {
                                bestDist = d3; bestIdx = i3;
                            }
                        }
                    }
                    if (fr[bestIdx]) {
                        var elMap = document.getElementById('seasonal-evo-map');
                        var f = fr[bestIdx];
                        var nm = (f.day != null)
                            ? 'd' + f.epochDay : String(f.month);
                        _evoState.currentFrameIdx = bestIdx;
                        if (elMap) {
                            Plotly.animate(elMap, [nm], {
                                mode: 'immediate',
                                transition: { duration: 0 },
                                frame: { duration: 0, redraw: true },
                            }).then(function () { _evoUpdateOverlays(elMap); });
                        }
                        // Read directly from f.label rather than the
                        // closure-captured labelByName lookup — across
                        // HD-promote re-renders the date-jump listener
                        // stays bound to the FIRST closure, so its
                        // labelByName can lag the live data. f.label
                        // is on the live _evoState.frames entry.
                        if (dateEl) {
                            dateEl.textContent = _evoState.year + ' · '
                                + (f.label || nm);
                        }
                    }
                    _ga('rt_seasonal_evo_date_jump',
                        { date: dateJumpEl.value });
                });
            }
            // Pick the initial frame. Default is frame 0, but if a
            // _pendingFrameEpoch was stashed (e.g., resolution swap),
            // snap to the frame matching the same calendar time so the
            // user keeps viewing the same point in time. For daily
            // frames we match by closest epochDay. For monthly frames
            // we match by calendar month — landing on the same month
            // is more intuitive than the closest end-of-month epoch
            // (which can snap backward by ~half a month).
            var startIdx = 0;
            if (typeof _evoState._pendingFrameEpoch === 'number') {
                var targetEpoch = _evoState._pendingFrameEpoch;
                var targetDate = new Date(targetEpoch * 86400000);
                var targetMonth = targetDate.getUTCMonth() + 1;  // 1-12
                var monthlyFrames = frames.length > 0
                    && frames[0].day == null;
                if (monthlyFrames) {
                    for (var sIdx = 0; sIdx < frames.length; sIdx++) {
                        if (frames[sIdx].month === targetMonth) {
                            startIdx = sIdx;
                            break;
                        }
                    }
                } else {
                    var bestDist = Infinity;
                    for (var sIdx2 = 0; sIdx2 < frames.length; sIdx2++) {
                        var d = Math.abs(frames[sIdx2].epochDay - targetEpoch);
                        if (d < bestDist) { bestDist = d; startIdx = sIdx2; }
                    }
                }
                _evoState._pendingFrameEpoch = null;
            }
            var firstFrame = frames[startIdx];
            var firstName = (firstFrame.day != null)
                ? 'd' + firstFrame.epochDay : String(firstFrame.month);
            setDate(firstName);
            _evoState.currentFrameIdx = startIdx;
            // If we landed on a non-zero frame, sync the slider + the
            // heatmap to that frame (the initial trace data already
            // has frame 0's z baked in — Plotly.animate swaps to the
            // right one).
            if (startIdx !== 0) {
                Plotly.animate(el, [firstName], {
                    mode: 'immediate', transition: { duration: 0 },
                    frame: { duration: 0, redraw: true },
                }).catch(function () { /* swallow — Plotly oddity */ });
            }
            // Initial pass — populate the sampling pill + resample
            // barbs/streams against the current viewport.
            _evoUpdateOverlays(el);
            // Auto-start the particle RAF if particles are the active
            // overlay (they are by default). _evoUpdateOverlays above
            // already pushed the current frame's u/v into the cache,
            // so _evoParticleStart's initial spawn loop has a valid
            // field to project against.
            if (_evoState.showStreamlines && !_evoParticles.running) {
                _evoParticleStart();
            }
            if (el.on) {
                el.on('plotly_sliderchange', function (e) {
                    var step = e && e.step;
                    var name = step && step.args && step.args[0] && step.args[0][0];
                    if (name) setDate(name);
                    if (typeof e.step.index === 'number') {
                        _evoState.currentFrameIdx = e.step.index;
                    } else if (name && indexByName[name] != null) {
                        _evoState.currentFrameIdx = indexByName[name];
                    }
                    _evoUpdateOverlays(el);
                });
                el.on('plotly_animatingframe', function (e) {
                    var name = e && e.frame && e.frame.name;
                    if (name) setDate(name);
                });
                // Zoom / pan — rebuild barb + streamline traces at the
                // new viewport's sampling density. Debounced so a
                // continuous drag doesn't fire a build every 16 ms.
                // 80 ms keeps the response feeling immediate while
                // collapsing the burst into a single restyle.
                el.on('plotly_relayout', function (ev) {
                    if (!ev) return;
                    var touched = ('xaxis.range[0]' in ev)
                        || ('xaxis.range[1]' in ev)
                        || ('yaxis.range[0]' in ev)
                        || ('yaxis.range[1]' in ev)
                        || ('xaxis.range' in ev)
                        || ('yaxis.range' in ev)
                        || ev['xaxis.autorange'] != null
                        || ev['yaxis.autorange'] != null;
                    if (!touched) return;
                    // Fast pass — barb / particle resampling at the
                    // new viewport. Debounced 80 ms so a continuous
                    // pinch doesn't fire 60 builds/sec.
                    if (_evoState._overlayDebounce) {
                        clearTimeout(_evoState._overlayDebounce);
                    }
                    _evoState._overlayDebounce = setTimeout(function () {
                        _evoState._overlayDebounce = null;
                        _evoUpdateOverlays(el);
                    }, 80);
                    // Resolution check — slippy-map style auto-
                    // promotion. Settles longer (600 ms) so a rapid
                    // zoom doesn't kick off three HD fetches; the
                    // single fetch fires once the user stops moving.
                    if (_evoState._resCheckDebounce) {
                        clearTimeout(_evoState._resCheckDebounce);
                    }
                    _evoState._resCheckDebounce = setTimeout(function () {
                        _evoState._resCheckDebounce = null;
                        _evoMaybePromoteResolution(el);
                    }, 600);
                });
                // Particle canvas sits above Plotly's SVG (z-index: 4)
                // so its trails overdraw the hover tooltip. Fade the
                // canvas while a hover is active and restore on leave
                // — the tooltip becomes immediately readable, and the
                // particle animation snaps back when the user moves on.
                el.on('plotly_hover', function () {
                    var c = _evoParticles && _evoParticles.canvas;
                    if (c) c.classList.add('hover-fade');
                });
                el.on('plotly_unhover', function () {
                    var c = _evoParticles && _evoParticles.canvas;
                    if (c) c.classList.remove('hover-fade');
                });
            }
        });
    }

    // Render the Plotly figure to a PNG URL with the animation slider +
    // play button hidden (a clean publication-style frame). Returns a
    // Promise<dataUrl>. We Plotly.relayout to drop the sliders before
    // toImage, then restore. opts.scale is the linear pixel multiplier
    // (3 for research-quality saves; 1.5 for GIF frames).
    function _evoToImageNoSlider(opts) {
        var el = document.getElementById('seasonal-evo-map');
        if (!el || !el._fullLayout) {
            return Promise.reject(new Error('plot not initialized'));
        }
        // Stash + strip the sliders block. Plotly.relayout returns a
        // promise we chain on so toImage runs after the redraw lands.
        var origSliders = el._fullLayout.sliders
            ? el._fullLayout.sliders.map(function (s) { return s; })
            : null;
        return Plotly.relayout(el, { sliders: [] })
            .then(function () { return Plotly.toImage(el, opts); })
            .then(function (url) {
                // Restore the slider — fire-and-forget; the URL is
                // already captured, no need to wait for redraw to
                // resolve before returning to the caller.
                if (origSliders) Plotly.relayout(el, { sliders: origSliders });
                return url;
            })
            .catch(function (e) {
                if (origSliders) Plotly.relayout(el, { sliders: origSliders });
                throw e;
            });
    }

    // Fixed CSS-pixel base width for saved figures — keeps mobile vs
    // desktop output identical regardless of viewport. Height is
    // computed from the current basin's lon/lat aspect so the saved
    // image matches what the user sees on screen but at consistent
    // resolution. PNG_SAVE_SCALE = 2 gives a 3600-px-wide output.
    var EVO_PNG_BASE_W = 1800;
    var EVO_PNG_SAVE_SCALE = 2;
    var EVO_GIF_BASE_W = 1200;
    function _evoSaveDimensions() {
        var view = _evoViewForBasin(_evoState.basin);
        var lonW = Math.abs(view.x[1] - view.x[0]);
        var latH = Math.abs(view.y[1] - view.y[0]);
        // Plotly's margin: l=50, r=70, t=10, b=30 (see _evoDrawPlotly)
        // — add 1.05 padding for axis labels + colorbar so the figure
        // aspect matches what the user sees on screen.
        var dataAspect = (lonW / latH) * 1.05;
        return {
            png: { width: EVO_PNG_BASE_W,
                   height: Math.round(EVO_PNG_BASE_W / Math.max(dataAspect, 1.0)) },
            gif: { width: EVO_GIF_BASE_W,
                   height: Math.round(EVO_GIF_BASE_W / Math.max(dataAspect, 1.0)) },
        };
    }

    // PNG export of the current frame — composes a small title bar
    // above + an attribution footer below the rasterized Plotly figure.
    // Output dimensions are FIXED (independent of viewport) so mobile
    // and desktop saves are identical pixel-for-pixel.
    function _evoSavePng() {
        var el = document.getElementById('seasonal-evo-map');
        if (!el || typeof Plotly === 'undefined') return;
        var dim = _evoSaveDimensions().png;
        var dateLabel = (document.getElementById('seasonal-evo-date') || {}).textContent
                        || ('' + _evoState.year);
        var variable = _evoState.variable || 'shear';
        var monthlySpec = EVO_MONTHLY_VARS[variable];
        var varDisplay = monthlySpec ? monthlySpec.label
                       : (variable === 'wind200') ? '200 mb wind'
                       : (variable === 'wind850') ? '850 mb wind'
                       : 'Deep-layer shear';
        var modeLabel = _evoState.mode === 'anomaly'
            ? (varDisplay + ' anomaly vs 1991-2020')
            : ('Raw ' + varDisplay.toLowerCase());
        _evoToImageNoSlider({
            format: 'png',
            width: dim.width,
            height: dim.height,
            scale: EVO_PNG_SAVE_SCALE,
        }).then(function (url) {
            var img = new Image();
            img.onload = function () {
                // Title + footer scale with the image width so research-
                // sized exports don't get a thin strip of text up top.
                var titleH    = Math.max(60, Math.round(img.width * 0.035));
                var footerH   = Math.max(36, Math.round(img.width * 0.022));
                var titleFont = Math.max(26, Math.round(img.width * 0.018));
                var footerFont= Math.max(16, Math.round(img.width * 0.011));
                var padLeft   = Math.max(24, Math.round(img.width * 0.013));
                var canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height + titleH + footerH;
                var ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#0f172a';
                ctx.font = 'bold ' + titleFont + 'px "DM Sans", system-ui, sans-serif';
                ctx.textBaseline = 'middle';
                ctx.fillText('Seasonal Evolution — ' + dateLabel
                             + '  ·  ' + modeLabel,
                             padLeft, titleH / 2);
                ctx.drawImage(img, 0, titleH);
                ctx.fillStyle = '#475569';
                ctx.font = footerFont + 'px "DM Sans", system-ui, sans-serif';
                ctx.fillText('TC-ATLAS · ' + new Date().toISOString().slice(0, 10) + ' UTC',
                             padLeft, titleH + img.height + footerH / 2);
                canvas.toBlob(function (blob) {
                    var u = URL.createObjectURL(blob);
                    var a = document.createElement('a');
                    a.href = u;
                    a.download = 'tc-atlas-seasonal-evo-' + _evoState.year
                        + '-' + dateLabel.replace(/[^a-zA-Z0-9]+/g, '_')
                        + '.png';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
                }, 'image/png');
            };
            img.src = url;
        }).catch(function (err) {
            console.warn('[seasonal-evo] PNG save failed:', err);
        });
    }

    // GIF export of the full animation. Walks every frame, scrubs the
    // plot to it, captures via Plotly.toImage, decodes into ImageData,
    // feeds to gifenc. Output is a Blob downloaded as .gif.
    function _evoSaveGif(buttonEl) {
        var el = document.getElementById('seasonal-evo-map');
        var frames = _evoState.frames;
        if (!el || !frames || !frames.length || typeof Plotly === 'undefined') return;
        var originalLabel = buttonEl ? buttonEl.textContent : '';
        if (buttonEl) {
            buttonEl.disabled = true;
            buttonEl.textContent = 'Rendering 0/' + frames.length + '…';
        }
        // Per-frame delay in the encoded GIF (centiseconds).
        var speed = parseInt(
            (document.getElementById('seasonal-evo-speed') || { value: '400' }).value,
            10);
        var delayCs = Math.max(4, Math.round(speed / 10));
        // GIF export uses the same FIXED CSS-pixel base as PNG so the
        // output is identical on mobile vs desktop. Width is fixed by
        // EVO_GIF_BASE_W; height comes from the basin's lon/lat aspect.
        // Smaller than PNG because GIF byte size grows quadratically and
        // 365-frame animations get large fast.
        var gifDim = _evoSaveDimensions().gif;
        var width  = gifDim.width;
        var height = gifDim.height;

        import('https://unpkg.com/gifenc@1.0.3/dist/gifenc.esm.js')
            .then(function (mod) {
                var gif = mod.GIFEncoder();

                function captureFrame(i) {
                    if (i >= frames.length) {
                        // Finalize.
                        gif.finish();
                        var bytes = gif.bytes();
                        var blob = new Blob([bytes], { type: 'image/gif' });
                        var u = URL.createObjectURL(blob);
                        var a = document.createElement('a');
                        a.href = u;
                        a.download = 'tc-atlas-seasonal-evo-' + _evoState.year + '.gif';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        setTimeout(function () { URL.revokeObjectURL(u); }, 1500);
                        if (buttonEl) {
                            buttonEl.disabled = false;
                            buttonEl.textContent = originalLabel;
                        }
                        return;
                    }
                    if (buttonEl) {
                        buttonEl.textContent = 'Rendering ' + (i + 1)
                            + '/' + frames.length + '…';
                    }
                    var name = (frames[i].day != null)
                        ? 'd' + frames[i].epochDay : String(frames[i].month);
                    Plotly.animate(el, [name], {
                        mode: 'immediate', transition: { duration: 0 },
                        frame: { duration: 0, redraw: true },
                    }).then(function () {
                        // Slider gets stripped per-frame and restored on
                        // export finish so the GIF never shows the
                        // animation chrome — pure data frames only.
                        return _evoToImageNoSlider({
                            format: 'png',
                            width: width, height: height,
                            scale: 1,
                        });
                    }).then(function (url) {
                        // Decode the PNG data URL into ImageData via off-screen canvas.
                        var img = new Image();
                        img.onload = function () {
                            var c = document.createElement('canvas');
                            c.width = width; c.height = height;
                            var cx = c.getContext('2d');
                            cx.fillStyle = '#ffffff';
                            cx.fillRect(0, 0, width, height);
                            cx.drawImage(img, 0, 0, width, height);
                            var rgba = cx.getImageData(0, 0, width, height).data;
                            var palette = mod.quantize(rgba, 256);
                            var indexed = mod.applyPalette(rgba, palette);
                            gif.writeFrame(indexed, width, height, {
                                palette: palette, delay: delayCs,
                            });
                            captureFrame(i + 1);
                        };
                        img.src = url;
                    }).catch(function (e) {
                        console.warn('[seasonal-evo] frame capture failed:', e);
                        captureFrame(i + 1);   // skip bad frame
                    });
                }
                captureFrame(0);
            })
            .catch(function (e) {
                console.warn('[seasonal-evo] gifenc load failed:', e);
                if (buttonEl) {
                    buttonEl.disabled = false;
                    buttonEl.textContent = originalLabel;
                }
            });
    }

    function _evoPopulateYearPicker() {
        var sel = document.getElementById('seasonal-evo-year');
        if (!sel || sel._populated) return;
        // Union of (a) era5_daily archive years and (b) GC-ATLAS per-year
        // years so all variable choices can find data. The two catalogs
        // overlap (1991-present today; GC-ATLAS extends back to 1961).
        Promise.all([
            _evoLoadManifest(),
            _evoLoadGcAtlasPerYearManifest().catch(function () { return null; }),
            // Eagerly pre-fetch the HD manifest so the Auto-promotion
            // path can consult it without a network round-trip on the
            // user's first zoom-in. Small (~1 MB), worth the cost.
            _evoLoadHdManifest().catch(function () { return null; }),
        ]).then(function (results) {
            var dailyM = results[0];
            var gcM    = results[1];
            var years = {};
            if (dailyM && dailyM.tiles) {
                Object.keys(dailyM.tiles).forEach(function (k) {
                    if (k.indexOf('shear/') === 0) {
                        var y = parseInt(k.split('/')[1].split('_')[0], 10);
                        if (Number.isFinite(y)) years[y] = true;
                    }
                });
            }
            if (gcM && gcM.groups && gcM.groups.single_levels
                && gcM.groups.single_levels.mpi
                && gcM.groups.single_levels.mpi.years) {
                gcM.groups.single_levels.mpi.years.forEach(function (y) {
                    if (Number.isFinite(y)) years[y] = true;
                });
            }
            if (!Object.keys(years).length) {
                sel.innerHTML = '<option>no archive</option>';
                return;
            }
            var sorted = Object.keys(years).map(Number)
                                .sort(function (a, b) { return b - a; });
            sel.innerHTML = sorted.map(function (y) {
                return '<option value="' + y + '">' + y + '</option>';
            }).join('');
            sel._populated = true;
            _evoState.year = sorted[0];
            sel.value = String(sorted[0]);
            _evoRender();
        }).catch(function (e) {
            console.warn('[seasonal-evo] year picker init failed:', e);
            sel.innerHTML = '<option>no archive</option>';
        });
    }

    // Keep the resolution-mode button label + tooltip in sync with the
    // current hdMode and the (basin, resolution, variable) gating. The
    // button cycles Auto → 1° lock → HD lock → Auto on click. Auto is
    // the default and the recommended mode — it promotes to 0.25° when
    // the viewport gets small enough that 1° starts to look chunky.
    function _evoUpdateHdButton() {
        var btn = document.getElementById('seasonal-evo-toggle-hd');
        if (!btn) return;
        var hdAllowedAtAll = _evoState.basin !== 'ALL'
            && !_evoIsMonthlyOnly(_evoState.variable);
        var mode = _evoState.hdMode || 'auto';
        // If the user's lock points at HD but the combo can't deliver
        // HD, silently drop back to Auto so the next render uses 1°.
        if (!hdAllowedAtAll && mode === 'hd') {
            mode = 'auto';
            _evoState.hdMode = 'auto';
        }
        btn.setAttribute('data-hd-mode', mode);
        btn.classList.toggle('active',
            (mode === 'hd' && hdAllowedAtAll)
            || (mode === 'auto' && _evoState.effectiveHd));
        btn.setAttribute('aria-disabled',
            (mode === 'hd' && !hdAllowedAtAll) ? 'true' : 'false');
        var labelByMode = { auto: 'Res: Auto', '1deg': 'Res: 1°', hd: 'Res: HD' };
        btn.textContent = labelByMode[mode] || 'Res: Auto';
        var reasons = [];
        if (_evoState.basin === 'ALL') reasons.push('basin = ALL');
        if (_evoIsMonthlyOnly(_evoState.variable))
            reasons.push('variable ships at 1°');
        var hdAvailForYear = _evoHdAvailableFor(_evoState.year);
        var modeBlurb;
        if (mode === 'auto') {
            modeBlurb = 'Auto-selects 0.25° when you zoom in past '
                + '~3000 sq° of viewport; otherwise stays at 1°. '
                + 'Click to lock to 1°.';
        } else if (mode === '1deg') {
            modeBlurb = 'Locked at 1° (no auto-upgrade). '
                + 'Click to lock at HD.';
        } else {
            modeBlurb = 'Locked at 0.25° native HD '
                + '(era5_daily_00z). Click to return to Auto.';
        }
        if (!hdAllowedAtAll) {
            btn.title = 'HD unavailable: ' + reasons.join(', ') + '. '
                + 'The Auto / 1° / HD cycle stays effective at 1°.';
        } else if (!hdAvailForYear && (mode === 'auto' || mode === 'hd')) {
            btn.title = modeBlurb
                + '\nHD tiles for ' + _evoState.year + ' are not yet '
                + 'in era5_daily_00z (backfill stops at 2010); render '
                + 'falls back to 1°.';
        } else {
            btn.title = modeBlurb;
        }
    }

    // After the viewport settles post-zoom/pan, evaluate whether the
    // effective resolution should change. If yes, fire a re-render
    // (which will hit the per-(year, resolution, basin) frame cache
    // on the second visit, so the zoom-out → zoom-in round-trip is
    // instant after the first HD load).
    //
    // The visible "Loading…" stub still appears on the very first HD
    // promotion for a given year — that's a deliberate trade-off in
    // this phase. A future polish pass could background-fetch + swap
    // (no stub) using Plotly.restyle on the heatmap z; for now the
    // cache keeps it from being painful on repeat zooms.
    function _evoMaybePromoteResolution(el) {
        if (!el || !el._fullLayout) return;
        if (!_evoState.frames) return;        // no data loaded yet
        var viewport = _evoComputeViewport(el);
        var wantedHd = _evoComputeEffectiveHd(viewport);
        if (wantedHd === _evoState.effectiveHd) {
            // No change — just keep the chip in sync (the viewport
            // moved within the same band) and bail.
            _evoUpdateResolutionChip();
            return;
        }
        // Resolution flip needed. Burn the climo cache (its grid
        // shape is tied to the old resolution) but keep the active
        // frames as-is — _evoRender will pull from the per-(year,
        // res, basin) cache for the new resolution if available.
        _evoState.climo = null;
        _evoState.windClimo = null;
        // Preserve the user's zoom AND the currently-viewed frame
        // across the resolution swap. Without these, _evoDrawPlotly
        // snaps back to (basin default viewport, Jan 1) every time
        // auto-HD fires — defeating both "I just zoomed in" and
        // "I'm looking at Aug 28 of the season" intents.
        _evoState._pendingViewport = {
            x: viewport.x.slice(),
            y: viewport.y.slice(),
        };
        // Read the live slider position as the authoritative current
        // frame — _evoState.currentFrameIdx can lag behind for
        // programmatic Plotly.animate calls (pre-existing quirk).
        var sliderActive = el._fullLayout
            && el._fullLayout.sliders
            && el._fullLayout.sliders[0]
            && el._fullLayout.sliders[0].active;
        var curIdx = (typeof sliderActive === 'number')
            ? sliderActive
            : (_evoState.currentFrameIdx || 0);
        var curFrame = _evoState.frames && _evoState.frames[curIdx];
        if (curFrame && typeof curFrame.epochDay === 'number') {
            _evoState._pendingFrameEpoch = curFrame.epochDay;
        }
        // Cancel any pending 80 ms overlay refresh — _evoRender's
        // newPlot will fully replace the figure's overlay state, so
        // the queued restyle would just be wasted work overwritten
        // moments later.
        if (_evoState._overlayDebounce) {
            clearTimeout(_evoState._overlayDebounce);
            _evoState._overlayDebounce = null;
        }
        _evoRender();
    }

    // Live data-resolution indicator next to the date / sampling pill.
    // Reads e.g. "1° auto", "0.25° auto", "1° locked", "HD locked".
    // Color tint flips when HD is effective so the user can see the
    // resolution change at a glance after a zoom.
    function _evoUpdateResolutionChip() {
        var chip = document.getElementById('seasonal-evo-resolution-chip');
        if (!chip) return;
        var mode = _evoState.hdMode || 'auto';
        var hd = !!_evoState.effectiveHd;
        var label;
        if (mode === 'auto') {
            label = hd ? '0.25° auto' : '1° auto';
        } else if (mode === '1deg') {
            label = '1° locked';
        } else {
            label = hd ? '0.25° locked' : '1° (HD unavail.)';
        }
        chip.textContent = label;
        chip.setAttribute('data-resolution', hd ? 'hd' : '1deg');
    }

    function _evoBindControls() {
        var bind = function (id, key, parse) {
            var el = document.getElementById(id);
            if (!el || el._evoBound) return;
            el._evoBound = true;
            el.addEventListener('change', function () {
                _evoState[key] = parse ? parse(el.value) : el.value;
                if (key === 'year' || key === 'variable' || key === 'resolution') {
                    // Preserve the user's currently-viewed date +
                    // viewport across the re-render so a swap of any
                    // axis (year → year, shear → wind850, monthly →
                    // daily) lands on the same calendar position +
                    // map domain instead of snapping back to Jan 1 +
                    // the basin default. _pendingFrameEpoch / _pendingViewport
                    // are consumed by _evoDrawPlotly's newPlot.then once
                    // the new frame set lands.
                    //
                    // Originally only resolution flips preserved state;
                    // user feedback: "Basically keep the domain and
                    // date at all changes". The downstream startIdx
                    // selector handles monthly↔daily epoch matching by
                    // falling back to calendar-month equality, so the
                    // same stash works across all three axes.
                    if (_evoState.frames) {
                        var curIdx = _evoState.currentFrameIdx || 0;
                        var curMap = document.getElementById('seasonal-evo-map');
                        if (curMap && curMap._fullLayout
                                && curMap._fullLayout.sliders
                                && typeof curMap._fullLayout.sliders[0].active === 'number') {
                            curIdx = curMap._fullLayout.sliders[0].active;
                        }
                        var curFrame = _evoState.frames[curIdx];
                        if (curFrame && typeof curFrame.epochDay === 'number') {
                            _evoState._pendingFrameEpoch = curFrame.epochDay;
                        }
                        var vp = _evoComputeViewport(curMap);
                        if (vp) {
                            _evoState._pendingViewport = {
                                x: vp.x.slice(),
                                y: vp.y.slice(),
                            };
                        }
                    }
                    // Year/var/resolution change needs fresh frame build.
                    // Resolution flip reshapes 12 → 365 frames (or back),
                    // so we go through the full _evoRender path. Variable
                    // change also invalidates the climo cache (the climo
                    // is variable-specific). GC-ATLAS monthly-only
                    // variables snap the resolution selector to monthly
                    // and disable the picker; flipping back to a daily-
                    // archive variable restores the user's last choice.
                    _evoState.frames = null;
                    if (key === 'variable') {
                        _evoState.climo = null;
                        _evoState.windClimo = null;
                        var resSel = document.getElementById('seasonal-evo-resolution');
                        if (_evoIsMonthlyOnly(_evoState.variable)) {
                            if (resSel) {
                                _evoState._lastResolution = _evoState.resolution || 'monthly';
                                resSel.value = 'monthly';
                                resSel.disabled = true;
                            }
                            _evoState.resolution = 'monthly';
                        } else if (resSel && resSel.disabled) {
                            resSel.disabled = false;
                            if (_evoState._lastResolution) {
                                resSel.value = _evoState._lastResolution;
                                _evoState.resolution = _evoState._lastResolution;
                            }
                        }
                        // Wind variables read more naturally in RAW
                        // mode — the absolute wind speed (m/s, 0..80)
                        // with the white→cyan TC palette is what
                        // forecasters actually want to see. Anomaly
                        // mode still works for wind (computes
                        // |V_now| − |V_climo|), but raw is the better
                        // default landing. Only auto-flip the mode if
                        // the user hasn't already explicitly chosen a
                        // mode this session (so we don't fight a
                        // power user who wants anomaly).
                        if ((_evoState.variable === 'wind200'
                                || _evoState.variable === 'wind850')
                                && _evoState.mode === 'anomaly'
                                && !_evoState._userPickedMode) {
                            _evoState.mode = 'raw';
                            var modeSel = document.getElementById('seasonal-evo-mode');
                            if (modeSel) modeSel.value = 'raw';
                        }
                    }
                    _evoUpdateHdButton();
                    _evoRender();
                } else if (key === 'mode') {
                    // User explicitly picked a mode — suppress the
                    // wind-variable auto-flip-to-raw on subsequent
                    // variable changes this session.
                    _evoState._userPickedMode = true;
                    // Anomaly needs the right climo cached. The
                    // initial render only fetches climo when mode is
                    // already anomaly — flipping raw → anomaly later
                    // would otherwise leave frameZ falling through to
                    // raw silently. Detect when we need a climo we
                    // don't have and force a full re-render (which
                    // walks the proper prep promise chain). The
                    // (year, hd, basin, daily/monthly, variable) cache
                    // means the field tiles themselves are cache-hit
                    // and the full render is ~1 sec, not 15.
                    var isWindNow = (_evoState.variable === 'wind200'
                                  || _evoState.variable === 'wind850');
                    var requiredClimo = isWindNow
                        ? _evoState.windClimo
                        : _evoState.climo;
                    var needsFullRender = _evoState.mode === 'anomaly'
                        && _evoState.frames
                        && !_evoIsMonthlyOnly(_evoState.variable)
                        && !_evoState.effectiveHd
                        && !requiredClimo;
                    if (needsFullRender) {
                        _evoState._pendingFrameEpoch
                            = _evoState.frames[_evoState.currentFrameIdx || 0]
                            && _evoState.frames[_evoState.currentFrameIdx || 0].epochDay;
                        _evoState._pendingViewport = _evoComputeViewport(
                            document.getElementById('seasonal-evo-map'));
                        _evoRender();
                    } else {
                        _evoRerenderTracksOnly();
                    }
                } else if (key === 'basin') {
                    // Pan/zoom the map AND rebuild track filter. Also
                    // retune the wrap's aspect ratio so the new basin's
                    // viewport fills the box without huge whitespace
                    // bands above/below.
                    var view = _evoViewForBasin(_evoState.basin);
                    _evoApplyWrapAspect(_evoState.basin);
                    // ALL basin must disable HD (no viewport crop → mem
                    // ceiling crash).
                    if (_evoState.basin === 'ALL' && _evoState.hd) {
                        _evoState.hd = false;
                    }
                    _evoUpdateHdButton();
                    // In HD mode the crop region depends on the basin
                    // viewport, so we need a full _evoRender to re-crop
                    // and re-fetch tiles. In 1° mode the basin change
                    // is just a viewport relayout — much cheaper.
                    if (_evoState.hd) {
                        _evoState.frames = null;
                        _evoRender();
                    } else {
                        var mapEl = document.getElementById('seasonal-evo-map');
                        if (mapEl && mapEl.classList.contains('js-plotly-plot')) {
                            Plotly.relayout(mapEl, {
                                'xaxis.range': view.x.slice(),
                                'yaxis.range': view.y.slice(),
                            }).then(function () { _evoRerenderTracksOnly(); });
                        } else {
                            _evoRerenderTracksOnly();
                        }
                    }
                } else if (key === 'trackDepth') {
                    _evoRerenderTracksOnly();
                }
                _ga('rt_seasonal_evo', { key: key, value: el.value });
            });
        };
        bind('seasonal-evo-year', 'year', function (v) { return parseInt(v, 10); });
        bind('seasonal-evo-var',  'variable');
        bind('seasonal-evo-mode', 'mode');
        bind('seasonal-evo-basin', 'basin');
        bind('seasonal-evo-track-depth', 'trackDepth');
        bind('seasonal-evo-resolution', 'resolution');
        // HD toggle — opt-in 0.25° native era5_daily_00z source with
        // viewport-cropped decode. Gated to monthly + non-ALL because
        // those guards keep the cropped Float32Array small enough to
        // live in browser memory.
        var hdBtn = document.getElementById('seasonal-evo-toggle-hd');
        if (hdBtn && !hdBtn._evoBound) {
            hdBtn._evoBound = true;
            hdBtn.addEventListener('click', function () {
                if (hdBtn.getAttribute('aria-disabled') === 'true') return;
                // Cycle Auto → 1° lock → HD lock → Auto. The Auto
                // setting drives the slippy-map style progressive-
                // enhancement: viewport area decides the resolution
                // automatically (see _evoComputeEffectiveHd).
                var cur = _evoState.hdMode || 'auto';
                var next = (cur === 'auto') ? '1deg'
                         : (cur === '1deg') ? 'hd'
                         :                    'auto';
                _evoState.hdMode = next;
                // Invalidate climo / windClimo: if the next render
                // ends up at a different effective HD than the cache
                // was built for, the climo grid shape would mismatch.
                _evoState.climo = null;
                _evoState.windClimo = null;
                _evoUpdateHdButton();
                _evoRender();
                _ga('rt_seasonal_evo_hd', { hdMode: next });
            });
        }
        _evoUpdateHdButton();
        _evoUpdateResolutionChip();
        // Save PNG of the current frame — simplest export path,
        // a single Plotly.toImage call on the live figure.
        var savePng = document.getElementById('seasonal-evo-save-png');
        if (savePng && !savePng._evoBound) {
            savePng._evoBound = true;
            savePng.addEventListener('click', function () {
                _evoSavePng();
                _ga('rt_seasonal_evo_save_png');
            });
        }
        // Save GIF — iterates every frame, captures each, encodes via
        // gifenc. Heavy work, gated behind a "Rendering…" button state.
        var saveGif = document.getElementById('seasonal-evo-save-gif');
        if (saveGif && !saveGif._evoBound) {
            saveGif._evoBound = true;
            saveGif.addEventListener('click', function () {
                _evoSaveGif(saveGif);
                _ga('rt_seasonal_evo_save_gif');
            });
        }
        // Play / pause + keyboard controls.
        var play = document.getElementById('seasonal-evo-play');
        function togglePlay() {
            var el = document.getElementById('seasonal-evo-map');
            if (!el || !_evoState.frames || !_evoState.frames.length) return;
            _evoState.playing = !_evoState.playing;
            if (play) play.textContent = _evoState.playing ? '⏸' : '▶';
            if (_evoState.playing) {
                var speed = parseInt(
                    document.getElementById('seasonal-evo-speed').value, 10);
                // Resume from the user's currently-selected frame, not
                // from frame 0. Plotly.animate(el, null, …) walks the
                // figure's frames in their stored order starting at the
                // beginning; passing an explicit name list lets us
                // rotate the playback to begin at currentFrameIdx and
                // wrap around through the end of the year. Without this,
                // play always snaps back to Jan which is jarring when
                // the user has scrubbed to a peak-season frame.
                var n = _evoState.frames.length;
                var idx = _evoState.currentFrameIdx || 0;
                if (idx < 0 || idx >= n) idx = 0;
                var order = new Array(n);
                for (var k = 0; k < n; k++) {
                    var f = _evoState.frames[(idx + k) % n];
                    order[k] = (f.day != null) ? 'd' + f.epochDay : String(f.month);
                }
                Plotly.animate(el, order, {
                    frame: { duration: speed, redraw: true },
                    transition: { duration: 0 },
                    mode: 'immediate',
                });
            } else {
                Plotly.animate(el, [null], { mode: 'next' });
            }
        }
        function gotoFrame(idx) {
            var el = document.getElementById('seasonal-evo-map');
            if (!el || !_evoState.frames || !_evoState.frames.length) return;
            var n = _evoState.frames.length;
            idx = ((idx % n) + n) % n;     // wrap
            _evoState.currentFrameIdx = idx;   // stash for our own bookkeeping
            var f = _evoState.frames[idx];
            var name = (f.day != null) ? 'd' + f.epochDay : String(f.month);
            // If we're playing, pause first.
            if (_evoState.playing) {
                _evoState.playing = false;
                if (play) play.textContent = '▶';
                Plotly.animate(el, [null], { mode: 'next' });
            }
            // Plotly.animate auto-syncs the slider's active step when
            // the named frame matches a slider-step args[0][0]. No
            // explicit relayout needed (and one would race the
            // animate, leaving the slider moved but data stale).
            Plotly.animate(el, [name], {
                mode: 'immediate', transition: { duration: 0 },
                frame: { duration: 0, redraw: true },
            }).then(function () {
                // Plotly's frame swap doesn't fire plotly_sliderchange
                // for programmatic animate calls (arrow keys / step
                // buttons), so barbs + particles would desync from
                // the displayed frame. Manually re-sync.
                _evoUpdateOverlays(el);
            });
        }
        function currentFrameIndex() {
            // We bookkeep _evoState.currentFrameIdx on every gotoFrame()
            // (Plotly.animate alone doesn't update the slider's active
            // step). Fall back to the slider's `active` value if the
            // user dragged the slider directly.
            if (typeof _evoState.currentFrameIdx === 'number') {
                return _evoState.currentFrameIdx;
            }
            var el = document.getElementById('seasonal-evo-map');
            if (!el || !el._fullLayout || !el._fullLayout.sliders) return 0;
            var s = el._fullLayout.sliders[0];
            return s && typeof s.active === 'number' ? s.active : 0;
        }
        if (play && !play._evoBound) {
            play._evoBound = true;
            play.addEventListener('click', togglePlay);
        }
        // Step jump (one month) — skip 30 frames in daily mode (close
        // enough to a calendar month) or 1 frame in monthly mode.
        function stepMonth(direction) {
            var frames = _evoState.frames;
            if (!frames || !frames.length) return;
            var cur = currentFrameIndex();
            var jump = (frames[0].day != null) ? 30 : 1;
            gotoFrame(cur + direction * jump);
        }
        var stepBindings = [
            { id: 'seasonal-evo-step-day-back',    handler: function () {
                gotoFrame(currentFrameIndex() - 1);
            }},
            { id: 'seasonal-evo-step-day-fwd',     handler: function () {
                gotoFrame(currentFrameIndex() + 1);
            }},
            { id: 'seasonal-evo-step-month-back',  handler: function () {
                stepMonth(-1);
            }},
            { id: 'seasonal-evo-step-month-fwd',   handler: function () {
                stepMonth(+1);
            }},
        ];
        stepBindings.forEach(function (b) {
            var btn = document.getElementById(b.id);
            if (btn && !btn._evoBound) {
                btn._evoBound = true;
                btn.addEventListener('click', b.handler);
            }
        });
        // Overlay toggles. Tracks toggles 3 traces + the storm-name
        // annotations layout block; barbs toggles 4 traces; streamlines
        // toggles 2 traces. Barbs ↔ streamlines are mutually exclusive
        // (turning one on flips the other off); both can be off.
        function applyOverlayState() {
            var el = document.getElementById('seasonal-evo-map');
            if (!el || !el._fullData) return;
            // visible flips per trace index.
            Plotly.restyle(el,
                { visible: _evoState.showTracks }, [2, 3, 4]);
            Plotly.restyle(el,
                { visible: _evoState.showBarbs }, [5, 6, 7, 8]);
            // Static streamline traces (9, 10) are permanently hidden
            // now — the animated particle canvas (#seasonal-evo-
            // particles) replaces them. Driven by _evoParticleStart /
            // _evoParticleStop from the toggle click handler below.
            Plotly.restyle(el, { visible: false }, [9, 10]);
            // Re-flow annotations: storm names follow the tracks toggle.
            // Off → clear. On → rebuild from the current frame so the
            // labels reappear immediately (instead of waiting for the
            // next frame swap, which on a paused slider never comes).
            // Slider's `active` is the authoritative current-frame
            // index — _evoState.currentFrameIdx can lag behind because
            // Plotly.animate doesn't always fire plotly_animatingframe
            // for programmatic calls (pre-existing quirk).
            if (!_evoState.showTracks) {
                Plotly.relayout(el, { annotations: [] });
            } else if (_evoState.frames) {
                var sliderActive = el._fullLayout
                    && el._fullLayout.sliders
                    && el._fullLayout.sliders[0]
                    && el._fullLayout.sliders[0].active;
                var fIdx = (typeof sliderActive === 'number')
                    ? sliderActive
                    : (_evoState.currentFrameIdx || 0);
                var f = _evoState.frames[fIdx];
                if (f) {
                    var tracks = _evoBuildTracksForFrame(f);
                    var anns = (tracks.labels || []).map(function (l) {
                        return {
                            x: l.x, y: l.y, xref: 'x', yref: 'y',
                            text: l.name + (l.cat ? ' · ' + l.cat : ''),
                            showarrow: false,
                            xanchor: 'left', yanchor: 'bottom',
                            xshift: 6, yshift: 4,
                            font: { size: 10, color: '#0f172a',
                                    family: 'DM Sans, system-ui, sans-serif',
                                    weight: 600 },
                            bgcolor: 'rgba(255,255,255,0.82)',
                            bordercolor: 'rgba(15,23,42,0.4)',
                            borderwidth: 0.5, borderpad: 2,
                        };
                    });
                    Plotly.relayout(el, { annotations: anns });
                }
            }
            // Update the button active classes.
            ['tracks','barbs','streams'].forEach(function (k) {
                var btn = document.getElementById('seasonal-evo-toggle-' + k);
                var state = (k === 'tracks') ? _evoState.showTracks
                          : (k === 'barbs')  ? _evoState.showBarbs
                          :                    _evoState.showStreamlines;
                if (btn) btn.classList.toggle('active', !!state);
            });
        }
        var toggleBindings = [
            { id: 'seasonal-evo-toggle-tracks',  key: 'showTracks' },
            { id: 'seasonal-evo-toggle-barbs',   key: 'showBarbs',
              mutex: 'showStreamlines' },
            { id: 'seasonal-evo-toggle-streams', key: 'showStreamlines',
              mutex: 'showBarbs' },
        ];
        toggleBindings.forEach(function (b) {
            var btn = document.getElementById(b.id);
            if (!btn || btn._evoBound) return;
            btn._evoBound = true;
            btn.addEventListener('click', function () {
                _evoState[b.key] = !_evoState[b.key];
                if (b.mutex && _evoState[b.key]) {
                    _evoState[b.mutex] = false;
                }
                applyOverlayState();
                // Barb data lives outside frame swaps now — recompute
                // when toggling on (so the data populates at the
                // current viewport's sampling) or off (drop arrays
                // to release memory). Streamlines now drive an
                // animated particle field instead of static traces.
                if (b.key === 'showBarbs') {
                    var mapEl = document.getElementById('seasonal-evo-map');
                    _evoUpdateOverlays(mapEl);
                }
                if (b.key === 'showStreamlines') {
                    // Mutex with barbs: turning particles ON drops the
                    // barb overlay; turning them OFF stops the RAF +
                    // clears the canvas. The trace-5..10 visibility
                    // toggle was already handled in applyOverlayState
                    // above; here we just drive the canvas animation.
                    if (_evoState.showStreamlines) {
                        _evoParticleStart();
                    } else {
                        _evoParticleStop();
                    }
                    if (_evoState.showStreamlines === false) {
                        // Drop the barb-trace's stale data so the
                        // hidden traces don't hold pre-toggle state.
                        var mapEl2 = document.getElementById('seasonal-evo-map');
                        _evoUpdateOverlays(mapEl2);
                    }
                }
            });
        });
        // Keyboard controls — bind once at document level. Active only
        // when the user is focused on Panel C (no <input> / <textarea>
        // in focus) and the map is in the viewport. ← / → step a frame,
        // Space toggles play, Home / End jump to first / last frame.
        if (!document._evoKbBound) {
            document._evoKbBound = true;
            document.addEventListener('keydown', function (ev) {
                // Skip while user is typing somewhere.
                var t = ev.target;
                if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
                          || t.tagName === 'SELECT' || t.isContentEditable)) {
                    return;
                }
                var mapEl = document.getElementById('seasonal-evo-map');
                if (!mapEl || !mapEl.classList.contains('js-plotly-plot')) return;
                // Only consume keystrokes when Panel C is visible.
                var r = mapEl.getBoundingClientRect();
                var inView = r.bottom > 0 && r.top < window.innerHeight;
                if (!inView) return;
                if (ev.key === 'ArrowLeft') {
                    gotoFrame(currentFrameIndex() - 1);
                    ev.preventDefault();
                } else if (ev.key === 'ArrowRight') {
                    gotoFrame(currentFrameIndex() + 1);
                    ev.preventDefault();
                } else if (ev.key === ' ' || ev.code === 'Space') {
                    togglePlay();
                    ev.preventDefault();
                } else if (ev.key === 'Home') {
                    gotoFrame(0);
                    ev.preventDefault();
                } else if (ev.key === 'End') {
                    gotoFrame(_evoState.frames ? _evoState.frames.length - 1 : 0);
                    ev.preventDefault();
                }
            });
        }
    }

    function _bindIndexControls() {
        var bindOne = function (id, key) {
            var el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', function () {
                state.idx[key] = el.value;
                _renderIndices();
                _ga('rt_seasonal_idx', { key: key, value: el.value });
            });
        };
        bindOne('seasonal-idx-window', 'window');
        bindOne('seasonal-idx-var', 'variable');
    }

    // -------------------------------------------------------------------
    // Panel A — Live anomaly PNG (from latest.json)
    // -------------------------------------------------------------------

    // Legend below Panel A's image. We swap labels + gradient depending
    // on what's being shown: SST anomaly (°C, RdBu_r ±3) vs. shear
    // climatology (m/s, RdYlBu_r 0→30 with center at 12). Reads from
    // the static SST defaults baked into the HTML/CSS, or from the
    // climo manifest's colorbar spec for Atmosphere mode.
    function _applyAnomLegend(mode) {
        var legend = document.querySelector('.seasonal-anom-legend');
        var bar    = document.querySelector('.seasonal-anom-bar');
        if (!legend || !bar) return;
        var spans = legend.querySelectorAll('span:not(.seasonal-anom-bar)');
        if (mode === 'shear') {
            // Match build_era5_climo_pngs.py's RdYlBu_r-style stops
            // centered at 12 m/s.
            bar.style.background = 'linear-gradient(to right, '
                + '#313695 0%, #74add1 25%, #fed98e 50%, '
                + '#f46d43 70%, #a50026 100%)';
            if (spans.length >= 2) {
                spans[0].textContent = '0 m/s';
                spans[1].textContent = '30 m/s';
            }
            legend.setAttribute('data-mode', 'shear');
        } else if (mode === 'shear_anom') {
            // Diverging RdBu_r centered at 0 kt — matches build_env_overlays
            // build_shear_anomaly's LayerSpec (vmin=-30, vmax=+30 kt).
            // Blue = below-normal shear (favorable for TCs); red =
            // above-normal (suppressive).
            bar.style.background = 'linear-gradient(to right, '
                + '#2166ac 0%, #67a9cf 25%, #f7f7f7 50%, '
                + '#ef8a62 75%, #b2182b 100%)';
            if (spans.length >= 2) {
                spans[0].textContent = '−30 kt';
                spans[1].textContent = '+30 kt';
            }
            legend.setAttribute('data-mode', 'shear_anom');
        } else {
            // Reset to the SST defaults (matches the CSS rule + HTML).
            bar.style.background = '';
            if (spans.length >= 2) {
                spans[0].textContent = '−3 °C';
                spans[1].textContent = '+3 °C';
            }
            legend.removeAttribute('data-mode');
        }
    }

    function _renderAnomMap() {
        var img = document.getElementById('seasonal-anom-img');
        var cap = document.getElementById('seasonal-anom-caption');
        if (!img || !cap) return;
        // Atmosphere paths: "shear_anom" = current GFS-derived shear
        // minus the ERA5 1991-2020 monthly climo (the SST-parity view
        // — both panels now anchored to the same 1991-2020 baseline).
        // "shear_climo" = the long-term climo mean for the current
        // calendar month (kept as a secondary "what's normal?" view).
        if (state.anomVar === 'shear_anom') {
            _renderShearAnomMap(img, cap);
            return;
        }
        if (state.anomVar === 'shear_climo') {
            _renderShearClimoMap(img, cap);
            return;
        }
        // SST family — restore the legend to °C labels + RdBu_r gradient
        // and hide the Month selector (SST is "today", not a specific
        // calendar month).
        _applyAnomLegend('sst');
        _setAnomMonthVisible(false);
        if (!state.latest) return;
        var isRel = state.anomVar === 'relative';
        var pngName = isRel
            ? (state.latest.anom_png_relative || state.latest.anom_png)
            : state.latest.anom_png;
        var gridName = isRel
            ? (state.latest.anom_grid_relative || state.latest.anom_grid)
            : state.latest.anom_grid;
        img.src = LOCAL_BASE + '/' + pngName;
        img.onload = function () { _applyAnomZoom(); };
        img.onerror = function () {
            img.onerror = null;
            img.src = GCS_BASE + '/' + pngName;
        };
        _applyAnomZoom();

        var mdrVal = isRel && state.latest.indices.atl_mdr_anom_rel !== undefined
                   ? state.latest.indices.atl_mdr_anom_rel
                   : state.latest.indices.atl_mdr_anom;
        var modeTag = isRel ? '(relative)' : '';
        cap.textContent = 'Valid ' + state.latest.valid_date +
            '  ' + modeTag +
            '  |  MDR anom ' + (mdrVal !== undefined ? mdrVal.toFixed(2) : '?') + ' °C' +
            '  |  AMO anom ' + state.latest.indices.atl_amo_anom.toFixed(2) + ' °C' +
            '  |  Niño 3.4 anom ' + state.latest.indices.nino34_anom.toFixed(2) + ' °C';

        // Load hover sidecar (small JSON, 1° grid of anomaly °C). Fail
        // silently — without it, the map still renders, the tooltip just
        // doesn't appear.
        if (gridName) {
            _fetchData(gridName).then(function (g) {
                state.anom_grid = g;
                _wireAnomHover();
            }).catch(function () { state.anom_grid = null; });
        }
    }

    // ── Atmosphere path: ERA5 shear climatology PNG + region-mean
    //    caption. The PNG / grid sidecar / region-mean caption file are
    //    all written by build_era5_climo_pngs.py once the daily-archive
    //    backfill (build_era5_daily_archive.py) has completed. Before
    //    they exist we render a graceful "pending" placeholder so the
    //    panel is honest about the data-source state.
    var ERA5_CLIMO_BASE = 'https://storage.googleapis.com/tc-atlas-ir-cache/era5_climo';
    var _shearClimoManifestPromise = null;
    function _loadShearClimoManifest() {
        if (state.shearClimoManifest) return Promise.resolve(state.shearClimoManifest);
        if (_shearClimoManifestPromise) return _shearClimoManifestPromise;
        _shearClimoManifestPromise = fetch(ERA5_CLIMO_BASE + '/manifest.json',
                                           { cache: 'no-cache' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { state.shearClimoManifest = j; return j; })
            .catch(function () { state.shearClimoManifest = null; return null; });
        return _shearClimoManifestPromise;
    }
    // ── Atmosphere path: current GFS-derived shear anomaly vs ERA5
    //    1991-2020 climo. Produced every 6 h by build_env_overlays.py
    //    (build_shear_anomaly) and uploaded to
    //    env/shear_anom_200_850/{equirect.png, equirect.grid.json,
    //    metadata.json}. The equirect.png is an un-warped colored RGBA
    //    that mirrors the existing era5_climo PNG schema so this panel
    //    can display it flat without Mercator distortion.
    var ENV_OVERLAY_BASE = 'https://storage.googleapis.com/tc-atlas-ir-cache/env';
    function _renderShearAnomMap(img, cap) {
        var pngUrl  = ENV_OVERLAY_BASE + '/shear_anom_200_850/equirect.png';
        var gridUrl = ENV_OVERLAY_BASE + '/shear_anom_200_850/equirect.grid.json';
        var metaUrl = ENV_OVERLAY_BASE + '/shear_anom_200_850/metadata.json';

        cap.textContent = 'Loading current GFS shear anomaly…';
        _applyAnomLegend('shear_anom');
        // The "Month" selector is for selecting which calendar-month
        // climo to view — only meaningful in the static-climo mode.
        // For the live anomaly we always anchor to the cycle's valid
        // month, so hide the picker here.
        _setAnomMonthVisible(false);
        // Drop any leftover grid from the prior mode so the hover
        // formatter doesn't show stale °C / m/s values while the kt
        // anomaly grid loads. The fetch below repopulates on success.
        state.anom_grid = null;

        // Cache-bust by appending the current minute so a freshly-built
        // cycle replaces the stale image immediately. Cycles land every
        // 6h with f000..f012 — the equirect.png clobbers each cycle.
        var bust = '?ts=' + Math.floor(Date.now() / 60000);
        img.style.opacity = '';
        img.src = pngUrl + bust;
        img.onload = function () { _applyAnomZoom(); };
        img.onerror = function () {
            img.onerror = null;
            img.removeAttribute('src');
            img.style.opacity = '0';
            cap.innerHTML = '<em>Current shear-anomaly PNG not yet '
                + 'published. After build_env_overlays.py runs at the '
                + 'next GFS cycle, this map will show the latest 200-850 '
                + 'hPa shear anomaly vs the ERA5 1991-2020 climo.</em>';
        };
        _applyAnomZoom();

        // Hover sidecar — same JSON schema as era5_climo/shear_MM.grid.json
        // so the existing _wireAnomHover code-path works unchanged.
        fetch(gridUrl + bust).then(function (r) { return r.ok ? r.json() : null; })
            .then(function (g) {
                state.anom_grid = g;
                _wireAnomHover();
            }).catch(function () { state.anom_grid = null; });

        // Caption: pull the cycle's valid_time from the metadata.json
        // upload_layer wrote, fall back to the grid's valid_time if the
        // env-overlay metadata fetch fails.
        fetch(metaUrl + bust).then(function (r) { return r.ok ? r.json() : null; })
            .then(function (m) {
                var validIso = (m && m.valid_time)
                    || (state.anom_grid && state.anom_grid.valid_time)
                    || null;
                var validLabel = validIso
                    ? validIso.replace('T', ' ').replace(/:\d{2}(?:\.\d+)?Z?$/, 'Z')
                    : 'latest cycle';
                cap.textContent = 'Current 200-850 hPa shear anomaly '
                    + '(GFS analysis − ERA5 1991-2020 climo)'
                    + '  |  Valid ' + validLabel;
            }).catch(function () {
                cap.textContent = 'Current 200-850 hPa shear anomaly '
                    + '(GFS analysis − ERA5 1991-2020 climo)';
            });
    }

    function _renderShearClimoMap(img, cap) {
        var monthNow = state.anomMonth || ((new Date()).getUTCMonth() + 1);
        var mm = (monthNow < 10 ? '0' : '') + monthNow;
        var pngUrl  = ERA5_CLIMO_BASE + '/shear_' + mm + '.png';
        var gridUrl = ERA5_CLIMO_BASE + '/shear_' + mm + '.grid.json';

        cap.textContent = 'Loading ERA5 climatology…';
        _applyAnomLegend('shear');
        _setAnomMonthVisible(true);

        _loadShearClimoManifest().then(function (manifest) {
            var months = manifest && manifest.months_rendered;
            if (!months || months.indexOf(monthNow) === -1) {
                // Climatology PNGs not yet generated — show a placeholder.
                // Hide the img to avoid a broken-image icon.
                img.removeAttribute('src');
                img.style.opacity = '0';
                cap.innerHTML = '<em>ERA5 deep-layer shear climatology for the '
                    + 'current calendar month is not yet published. '
                    + 'After the daily-archive backfill completes, run '
                    + '<code>python build_era5_climo_pngs.py</code> to '
                    + 'render the 12 monthly PNGs.</em>';
                return;
            }
            img.style.opacity = '';
            img.src = pngUrl;
            img.onload = function () { _applyAnomZoom(); };
            img.onerror = function () {
                img.onerror = null;
                cap.textContent = 'Failed to load ' + pngUrl;
            };
            _applyAnomZoom();
            // Hover sidecar — same wiring pattern as the SST anomaly grid.
            fetch(gridUrl).then(function (r) { return r.ok ? r.json() : null; })
                .then(function (g) {
                    state.anom_grid = g;
                    _wireAnomHover();
                }).catch(function () { state.anom_grid = null; });
            // Caption: regional climatological shear values.
            var rm = manifest.region_means || {};
            var atlMdr = (rm.atl_mdr || [])[monthNow - 1];
            var epacMdr = (rm.epac_mdr || [])[monthNow - 1];
            var wpacMdr = (rm.wpac_mdr || [])[monthNow - 1];
            var monthNames = ['Jan','Feb','Mar','Apr','May','Jun',
                              'Jul','Aug','Sep','Oct','Nov','Dec'];
            cap.textContent = monthNames[monthNow - 1] + ' climatology '
                + '(ERA5 1991-2020, mean of daily |V₂₀₀ − V₈₅₀|)'
                + (atlMdr  != null ? '  |  ATL MDR '  + atlMdr.toFixed(1)  + ' m/s' : '')
                + (epacMdr != null ? '  |  EPAC MDR ' + epacMdr.toFixed(1) + ' m/s' : '')
                + (wpacMdr != null ? '  |  WPAC MDR ' + wpacMdr.toFixed(1) + ' m/s' : '');
        });
    }

    function _bindAnomVarControl() {
        var sel = document.getElementById('seasonal-anom-var');
        if (!sel || sel._bound) return;
        sel._bound = true;
        sel.addEventListener('change', function () {
            state.anomVar = sel.value;
            _renderAnomMap();
            _ga('rt_seasonal_anom_var', { variable: sel.value });
        });
        // Month selector — only active in Atmosphere (shear_climo) mode.
        var msel = document.getElementById('seasonal-anom-month');
        if (msel && !msel._bound) {
            msel._bound = true;
            msel.value = String(state.anomMonth);
            msel.addEventListener('change', function () {
                state.anomMonth = parseInt(msel.value, 10);
                _renderAnomMap();
                _ga('rt_seasonal_anom_month', { month: state.anomMonth });
            });
        }
    }

    // Toggle the Month selector visibility (CSS display) — shown only
    // when Panel A is in Atmosphere (shear_climo) mode.
    function _setAnomMonthVisible(show) {
        var lbl = document.getElementById('seasonal-anom-month-label');
        if (lbl) lbl.style.display = show ? '' : 'none';
    }

    /* Generic map-hover wiring used by every panel that shows a 2D
     * geographic image with a lat/lon grid sidecar. `getGrid()` returns
     * the current grid (so panels with toggle-able maps can swap the
     * grid on selector change without re-binding listeners), and
     * `formatValue()` controls the readout (°C anomaly vs Pearson r etc).
     */
    function _wireMapHover(wrapId, imgId, tipId, getGrid, formatValue,
                           getAuxGrid, formatAux) {
        var wrap = document.getElementById(wrapId);
        var img = document.getElementById(imgId);
        var tip = document.getElementById(tipId);
        if (!wrap || !img || !tip) return;
        if (wrap._mapHoverBound) return;
        wrap._mapHoverBound = true;

        function _readCell(g, lat, lon) {
            // Returns the value (or null) at (lat, lon) in grid `g`.
            var i = Math.floor((lat - g.lat_min) / (g.lat_max - g.lat_min) * g.n_lat);
            var j = Math.floor((lon - g.lon_min) / (g.lon_max - g.lon_min) * g.n_lon);
            i = Math.max(0, Math.min(g.n_lat - 1, i));
            j = Math.max(0, Math.min(g.n_lon - 1, j));
            return g.values[i][j];
        }

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
            var v = _readCell(g, lat, lon);
            var lonLabel = lon > 180 ? (360 - lon).toFixed(1) + '°W'
                                     : lon.toFixed(1) + '°E';
            var latLabel = (lat >= 0 ? lat.toFixed(1) + '°N'
                                     : (-lat).toFixed(1) + '°S');
            var line = latLabel + ', ' + lonLabel + '  |  ' + formatValue(v);
            // Optional second value (e.g., year-anomaly on Panel D when
            // an overlay year is active).
            var auxGrid = getAuxGrid ? getAuxGrid() : null;
            if (auxGrid) {
                line += '  |  ' + formatAux(_readCell(auxGrid, lat, lon));
            }
            tip.textContent = line;
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
                // Per-mode formatter — _wireMapHover binds the formatter
                // closure once, but `state.anomVar` is read fresh on each
                // mousemove so the units flip with the variable selector.
                if (state.anomVar === 'shear_climo') {
                    return (v === null || v === undefined)
                        ? 'no data'
                        : v.toFixed(1) + ' m/s shear';
                }
                if (state.anomVar === 'shear_anom') {
                    return (v === null || v === undefined)
                        ? 'no data'
                        : (v >= 0 ? '+' : '') + v.toFixed(1) + ' kt anom';
                }
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
        // Compose the file key — Spearman files carry an extra
        // `_spearman` suffix; Pearson keeps the original (no suffix).
        var kindKey = c.kind + (c.stat === 'spearman' ? '_spearman' : '');
        var stem = 'correlations/' + c.basin + '_' + mm + '_' + kindKey;
        var pngName = stem + '.png';
        var gridName = stem + '.grid.json';
        img.src = LOCAL_BASE + '/' + pngName;
        img.onerror = function () {
            img.onerror = null;
            img.src = GCS_BASE + '/' + pngName;
        };
        img.alt = c.basin + ' ACE × SST ' +
                  (c.stat === 'spearman' ? 'Spearman ρ' : 'Pearson r') +
                  ', month ' + c.month + ', ' + c.kind;
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
    // Saturated, env-overlay-style contour palette. Each contour is
    // drawn as a thick saturated stroke (cool blues for negative,
    // warm reds for positive) over a wider opposite-color halo for
    // contrast against the BWR-shaded correlation field. ±0.5 levels
    // dropped — they were noise; ±1 and ±2 carry the signal.
    var ANOM_CONTOUR_STYLE = {
        '-2.0': { color: '#08306b', halo: '#fff', width: 6.5 },
        '-1.0': { color: '#3a78c2', halo: '#fff', width: 5.0 },
        '+1.0': { color: '#cf2222', halo: '#fff', width: 5.0 },
        '+2.0': { color: '#67000d', halo: '#fff', width: 6.5 },
    };

    function _renderCorrOverlay() {
        var svg = document.getElementById('seasonal-corr-overlay');
        var legend = document.getElementById('seasonal-corr-overlay-legend');
        if (!svg) return;
        // Reset
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        legend.classList.remove('visible');
        // Clear the cached year-anomaly grid so hover stops showing
        // stale numbers between toggles.
        state.corr_anom_grid = null;
        var y = state.corr.overlayYear;
        if (!y) return;

        var mm = (state.corr.month < 10 ? '0' : '') + state.corr.month;
        var name = 'anomaly_contours/' + y + '_' + mm + '.json';
        _fetchData(name).then(function (j) {
            _drawContoursOnSVG(j, svg);
            legend.innerHTML = _buildOverlayLegendHTML(y, state.corr.month);
            legend.classList.add('visible');
            // Cache the embedded anomaly grid so the hover handler can
            // show the year's anomaly value at the cursor alongside r.
            state.corr_anom_grid = j.grid || null;
        }).catch(function () {
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
            // Only render the levels we have explicit styles for —
            // drops ±0.5 which were too noisy to be readable.
            var style = ANOM_CONTOUR_STYLE[level];
            if (!style) continue;
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
        var rows = ['+2.0', '+1.0', '-1.0', '-2.0'].map(function (l) {
            var s = ANOM_CONTOUR_STYLE[l];
            return '<div><span class="legend-line" style="color:' + s.color +
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
        var statLabel = function () {
            return state.corr.stat === 'spearman' ? 'ρ' : 'r';
        };
        _wireMapHover(
            'seasonal-corr-wrap', 'seasonal-corr-img', 'seasonal-corr-tooltip',
            function () { return state.corr_grid; },
            function (v) {
                return (v === null || v === undefined)
                    ? 'land / no data'
                    : statLabel() + ' = ' + (v >= 0 ? '+' : '') + v.toFixed(2);
            },
            // Second value: the selected overlay-year SST anomaly at the
            // cursor. Only present when overlayYear is set.
            function () { return state.corr_anom_grid; },
            function (v) {
                if (v === null || v === undefined) return 'land / no data';
                var year = state.corr.overlayYear || '?';
                return year + ' anom ' +
                    (v >= 0 ? '+' : '') + v.toFixed(2) + ' °C';
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
                _ga('rt_seasonal_corr', { key: key, value: String(el.value) });
            });
        };
        bind('seasonal-corr-basin', 'basin');
        bind('seasonal-corr-month', 'month', function (v) { return parseInt(v, 10); });
        bind('seasonal-corr-kind', 'kind');
        bind('seasonal-corr-stat', 'stat');
        var oy = document.getElementById('seasonal-corr-overlay-year');
        if (oy) {
            oy.addEventListener('change', function () {
                state.corr.overlayYear = oy.value;
                _renderCorrOverlay();
                _ga('rt_seasonal_corr', { key: 'overlayYear', value: oy.value });
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
                _ga('rt_seasonal_scatter', { key: key, value: String(el.value) });
            });
        };
        bind('seasonal-scatter-x', 'x');
        bind('seasonal-scatter-y', 'y');
        bind('seasonal-scatter-month', 'month', function (v) { return parseInt(v, 10); });
        bind('seasonal-scatter-var', 'variable');
    }

    function _activate() {
        if (state.activated) {
            _ga('rt_seasonal_open', { first: 0 });
            _renderScatter();
            _renderAnomMap();
            return;
        }
        state.activated = true;
        _ga('rt_seasonal_open', { first: 1 });
        _refreshTheme();
        _wireThemeReactivity();
        _wireSubnav();
        _bindScatterControls();
        _bindCorrelationControls();
        _bindTimeSeriesControls();
        _bindAnalogControls();
        _bindIndexControls();
        _bindAnomZoomControl();
        _bindAnomVarControl();
        _wireCorrHover();
        _renderCorrelation();
        // New Panel C — seasonal evolution animation. Self-contained:
        // pulls its own manifests + tiles, populates the year picker
        // from what's actually in the era5_daily archive on GCS.
        _evoBindControls();
        _evoPopulateYearPicker();
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
        // Optional preliminary-year distance vector. If present, the
        // grid-weighted analog method can produce real rankings for
        // the current year on the current month instead of "no data".
        var p7 = _fetchData('analog_preliminary_distances.json').then(
            function (j) { state.prelim_distances = j; },
            function () { state.prelim_distances = null; }
        );
        Promise.all([p1, p2, p3, p4, p5, p6, p7]).then(function () {
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
            _addPanelImageSaveBtn('seasonal-panel-anom-map',
                                  'seasonal_live_anomaly');
            _addPanelImageSaveBtn('seasonal-panel-correlation',
                                  'seasonal_correlation_map');
            _addPanelImageSaveBtn('seasonal-panel-analogs',
                                  'seasonal_analog_seasons');
        }).catch(function (e) {
            _setStatus('Failed to load seasonal data: ' + e.message, true);
        });
    }

    window.activateSeasonalView = _activate;
})();
