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
        anomVar: 'raw',     // Panel A: 'raw' or 'relative'
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
                font: { size: 10 }, orientation: 'h',
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
        // ERA5 monthly variables are precomputed offline (build_era5_indices.py)
        // — lazy-load the JSON the first time the user picks one. While the
        // fetch is in flight, paint a small placeholder so the panel doesn't
        // look broken.
        if (_isEra5Var(state.ts.variable) && !state.era5) {
            if (el) {
                el.innerHTML = '<div class="seasonal-panel-stub">'
                    + 'Loading ERA5 monthly indices…</div>';
            }
            return _loadEra5Indices().then(function () { _renderTimeSeries(); });
        }
        // ERA5 fields ship as monthly only — force the resolution toggle
        // to Monthly if the user lands on an ERA5 var while in Daily.
        if (_isEra5Var(state.ts.variable) && state.ts.resolution === 'daily') {
            state.ts.resolution = 'monthly';
            var sel = document.getElementById('seasonal-ts-resolution');
            if (sel) sel.value = 'monthly';
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
        var varLabel;
        if (era5Meta) {
            varLabel = era5Meta.long_name + ' (' + era5Meta.units + ')';
        } else {
            varLabel = (state.ts.variable === 'anom') ? 'SST anomaly (°C)'
                     : (state.ts.variable === 'sst_dt') ? 'detrended SST (°C)'
                     : (state.ts.variable === 'sst_rel') ? 'relative SST vs 30°S-30°N (°C)'
                     : 'SST (°C)';
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
            hoverlabel: {
                bgcolor: BRAND.hoverBg,
                bordercolor: BRAND.hoverBorder,
                font: { color: BRAND.hoverText,
                        family: 'DM Sans, system-ui, sans-serif',
                        size: 11 },
            },
            showlegend: true,
            legend: {
                font: { size: 10 }, orientation: 'h',
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
        layout.geo2 = _insetGeoLayout({ x: [0.76, 1.0], y: [0.74, 1.005] });
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
                font: { size: 10 }, orientation: 'h',
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
        layout.geo2 = _insetGeoLayout({ x: [0.005, 0.22], y: [0.78, 1.005] });
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
    var ERA5_VAR_KEYS = ['shear', 'mpi', 'rh700', 'chi200', 'vo850', 'tcwv'];
    function _isEra5Var(v) { return ERA5_VAR_KEYS.indexOf(v) !== -1; }
    var _era5Promise = null;
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

    function _renderAnomMap() {
        if (!state.latest) return;
        var img = document.getElementById('seasonal-anom-img');
        var cap = document.getElementById('seasonal-anom-caption');
        if (!img || !cap) return;
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

    function _bindAnomVarControl() {
        var sel = document.getElementById('seasonal-anom-var');
        if (!sel || sel._bound) return;
        sel._bound = true;
        sel.addEventListener('change', function () {
            state.anomVar = sel.value;
            _renderAnomMap();
            _ga('rt_seasonal_anom_var', { variable: sel.value });
        });
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
