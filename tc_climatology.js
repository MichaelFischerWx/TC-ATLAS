// ════════════════════════════════════════════════════════════════
//  TC-ATLAS — TC Climatology page
//  Best-track statistics + reanalysis-globe launcher
// ════════════════════════════════════════════════════════════════
//
// This page used to live as the "Climatology" + "Environment" tabs
// inside global_archive.html. It was pulled out into its own page so:
//   1. Climatology features (basin-wide stats, RI distributions, ACE
//      drill-down, LMI, seasonal cycles) and the ERA5 reanalysis globe
//      sit at peer status with the rest of the site instead of being
//      buried two-clicks-deep inside Global Archive.
//   2. Global Archive's tabs return to per-storm content, removing the
//      conceptual mismatch where two of its tabs were basin-wide.
//
// All chart and modal code below was extracted verbatim from the
// climatology section of global_archive.js so behavior is identical
// to what users had on the old tab. Constants + state + helpers that
// previously came from the Global Archive runtime are reproduced at
// the top of this file so this page is fully self-contained.
//
// Old deep links (global_archive.html#tab=climatology / #tab=environment)
// are redirected from global_archive.js to this page.

// ── Tiny GA wrapper ─────────────────────────────────────────────
function _ga(action, params) {
    if (typeof gtag === 'function') {
        try { gtag('event', action, params || {}); } catch (e) { /* silent */ }
    }
}

// ── Data version + URLs ─────────────────────────────────────────
var DATA_VER = 'v20260408';
var STORMS_JSON  = 'ibtracs_storms.json?' + DATA_VER;
var TRACKS_MANIFEST = 'ibtracs_tracks_manifest.json?' + DATA_VER;
var TRACKS_JSON_FALLBACK = 'ibtracs_tracks.json?' + DATA_VER;

// ── Basin metadata (kept in sync with global_archive.js) ────────
var BASIN_NAMES = {
    NA: 'North Atlantic',
    EP: 'East Pacific',
    WP: 'West Pacific',
    NI: 'North Indian',
    SI: 'South Indian',
    SP: 'South Pacific',
    SA: 'South Atlantic'
};

var BASIN_COLORS = {
    NA: '#2e7dff',
    EP: '#00d4ff',
    WP: '#f87171',
    NI: '#fbbf24',
    SI: '#34d399',
    SP: '#a78bfa',
    SA: '#fb923c'
};

// ── Saffir-Simpson helpers ──────────────────────────────────────
var SS_COLORS = {
    TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24',
    C2: '#fb923c', C3: '#f87171', C4: '#ef4444', C5: '#dc2626',
    UN: '#6b7280'
};

function getIntensityColor(vmax) {
    if (!vmax) return '#6b7280';
    if (vmax < 34) return '#60a5fa';
    if (vmax < 64) return '#34d399';
    if (vmax < 83) return '#fbbf24';
    if (vmax < 96) return '#fb923c';
    if (vmax < 113) return '#f87171';
    if (vmax < 137) return '#ef4444';
    return '#dc2626';
}

function getIntensityCategory(vmax) {
    if (!vmax) return 'Unknown';
    if (vmax < 34) return 'TD';
    if (vmax < 64) return 'TS';
    if (vmax < 83) return 'Cat 1';
    if (vmax < 96) return 'Cat 2';
    if (vmax < 113) return 'Cat 3';
    if (vmax < 137) return 'Cat 4';
    return 'Cat 5';
}

function getCatKey(vmax) {
    if (!vmax) return 'UN';
    if (vmax < 34) return 'TD';
    if (vmax < 64) return 'TS';
    if (vmax < 83) return 'C1';
    if (vmax < 96) return 'C2';
    if (vmax < 113) return 'C3';
    if (vmax < 137) return 'C4';
    return 'C5';
}

// ── Plotly defaults — theme-aware ────────────────────────────
function _tcaPlotlyBase() {
    var t = (window.TCATheme && typeof window.TCATheme.plotly === 'function')
        ? window.TCATheme.plotly()
        : { paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
            font: { family: 'DM Sans, sans-serif', color: '#0f1623' },
            hoverlabel: { bgcolor: '#ffffff', bordercolor: 'rgba(15,22,35,0.15)',
                          font: { color: '#0f1623', size: 12, family: 'DM Sans' } } };
    t.margin = { l: 50, r: 20, t: 10, b: 40 };
    return t;
}
Object.defineProperty(window, 'PLOTLY_LAYOUT_BASE', {
    get: _tcaPlotlyBase, configurable: true
});
// NOTE: do NOT add `var PLOTLY_LAYOUT_BASE = window.PLOTLY_LAYOUT_BASE;` here.
// Top-level var declarations are hoisted in GlobalDeclarationInstantiation,
// which creates a non-configurable data property on window BEFORE this
// script body runs — making the Object.defineProperty above throw
// "Cannot redefine property: PLOTLY_LAYOUT_BASE" and aborting the rest of
// the file (including event-listener wiring like _bindSubnav). Bare
// `PLOTLY_LAYOUT_BASE` references below resolve to window.PLOTLY_LAYOUT_BASE
// via the global scope chain, calling the getter — same behavior, no clash.

var PLOTLY_CONFIG = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'],
    toImageButtonOptions: {
        format: 'png',
        filename: 'tc-climatology-chart',
        height: 600,
        width: 1000,
        scale: 2
    }
};

// ── State ───────────────────────────────────────────────────────
var allStorms = [];
var allTracks = {};                  // SID → track points (lazy-loaded for ACE modal)
var _tracksLoadPromise = null;
var intensityChangeData = null;
var _intensityChangePromise = null;
var climRendered = false;

// ── Toast ───────────────────────────────────────────────────────
function showToast(message) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.style.display = '';
    clearTimeout(el._timer);
    el._timer = setTimeout(function () {
        el.style.display = 'none';
    }, 3000);
}

// ── Hide / show the page chrome around modal overlays ───────────
// Same pattern as Global Archive's _hideBackgroundElements but
// targeted at this page's main + sub-nav so opening a modal doesn't
// leave clickable controls bleeding through behind it.
function _hideBackgroundElements() {
    var main = document.getElementById('tc-clim-main');
    if (main) main.style.display = 'none';
}
function _showBackgroundElements() {
    var main = document.getElementById('tc-clim-main');
    if (main) main.style.display = '';
}

// ── Lazy-load intensity_changes.json (~1.3 MB) for the RI modal ─
function _ensureIntensityChangeData() {
    if (intensityChangeData) return Promise.resolve(intensityChangeData);
    if (_intensityChangePromise) return _intensityChangePromise;
    _intensityChangePromise = fetch('intensity_changes.json?' + DATA_VER)
        .then(function (r) { if (!r.ok) throw new Error('Not found'); return r.json(); })
        .then(function (data) {
            intensityChangeData = data;
            console.log('Loaded intensity change data: ' + (data.total_episodes || 0) + ' episodes');
            return data;
        })
        .catch(function (err) {
            console.warn('Intensity change data not loaded:', err);
            _intensityChangePromise = null;
            throw err;
        });
    return _intensityChangePromise;
}

// ── Lazy-load IBTrACS tracks (~44 MB) — only the ACE modal needs them ──
// Returns a promise that resolves once allTracks is populated.
function _ensureTracksLoaded() {
    if (Object.keys(allTracks).length > 0) return Promise.resolve(allTracks);
    if (_tracksLoadPromise) return _tracksLoadPromise;
    _tracksLoadPromise = fetch(TRACKS_MANIFEST)
        .then(function (r) {
            if (!r.ok) throw new Error('No manifest');
            return r.json();
        })
        .then(function (m) {
            var chunks = m.chunks || [];
            return Promise.all(chunks.map(function (f) {
                return fetch(f + '?' + DATA_VER).then(function (r) { return r.json(); });
            }));
        })
        .then(function (chunkArr) {
            chunkArr.forEach(function (c) {
                Object.keys(c).forEach(function (sid) { allTracks[sid] = c[sid]; });
            });
            return allTracks;
        })
        .catch(function () {
            // Fall back to single-file tracks
            return fetch(TRACKS_JSON_FALLBACK)
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    Object.keys(d).forEach(function (sid) { allTracks[sid] = d[sid]; });
                    return allTracks;
                })
                .catch(function () { return allTracks; });
        });
    return _tracksLoadPromise;
}

// ════════════════════════════════════════════════════════════════
//  CHART RENDERING + MODAL HANDLERS
//  Extracted verbatim from the original climatology section of
//  global_archive.js. Behaviour is identical to what users had on
//  the old "Climatology" tab.
// ════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
//  CLIMATOLOGY TAB
// ══════════════════════════════════════════════════════════════

function renderClimatology() {
    _ga('ga_view_climatology', {});
    if (allStorms.length === 0) return;
    climRendered = true;

    // Year range
    var years = allStorms.map(function (s) { return s.year; }).filter(function (y) { return y > 0; });
    var minYear = Math.min.apply(null, years);
    var maxYear = Math.max.apply(null, years);
    document.getElementById('clim-year-range').textContent = minYear + '–' + maxYear;

    renderACEChart(minYear, maxYear);
    renderFrequencyChart(minYear, maxYear);
    renderIntensityOverview();
    renderIntensityChangeOverview();
    renderBasinPie();
    renderLMILatOverview();
}

function renderACEChart(minYear, maxYear) {
    // Compute ACE by year and basin
    var basins = Object.keys(BASIN_NAMES);
    var yearRange = [];
    for (var y = Math.max(minYear, 1950); y <= maxYear; y++) yearRange.push(y);

    var traces = basins.map(function (basin) {
        var aceByYear = yearRange.map(function (yr) {
            var ace = 0;
            allStorms.forEach(function (s) {
                if (s.year === yr && s.basin === basin) ace += (s.ace || 0);
            });
            return Math.round(ace * 10) / 10;
        });

        return {
            x: yearRange,
            y: aceByYear,
            type: 'bar',
            name: basin,
            marker: { color: BASIN_COLORS[basin] || '#6b7280' },
            hovertemplate: '<b>' + basin + ' %{x}</b><br>ACE: %{y:.1f}<extra></extra>'
        };
    });

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'stack',
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#5b6573' } },
            tickfont: { size: 9, color: '#5b6573' },
            gridcolor: 'rgba(15, 22, 35,0.22)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#5b6573' } },
            tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' },
            gridcolor: 'rgba(15, 22, 35,0.22)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.12,
            font: { size: 10, color: '#5b6573' }
        },
        margin: { l: 55, r: 10, t: 30, b: 45 }
    });

    Plotly.newPlot('clim-ace-chart', traces, layout, PLOTLY_CONFIG);

    // Click handler: open ACE drill-down modal
    document.getElementById('clim-ace-chart').on('plotly_click', function () {
        openACEModal();
    });
}

function renderFrequencyChart(minYear, maxYear) {
    var catOrder = ['TD', 'TS', 'C1', 'C2', 'C3', 'C4', 'C5'];
    var yearRange = [];
    for (var y = Math.max(minYear, 1950); y <= maxYear; y++) yearRange.push(y);

    var traces = catOrder.map(function (cat) {
        var countsByYear = yearRange.map(function (yr) {
            return allStorms.filter(function (s) {
                return s.year === yr && getCatKey(s.peak_wind_kt) === cat;
            }).length;
        });

        return {
            x: yearRange,
            y: countsByYear,
            type: 'bar',
            name: cat,
            marker: { color: SS_COLORS[cat] },
            hovertemplate: '<b>%{x}</b><br>' + cat + ': %{y}<extra></extra>'
        };
    });

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'stack',
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#5b6573' } },
            tickfont: { size: 9, color: '#5b6573' },
            gridcolor: 'rgba(15, 22, 35,0.22)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'Storm Count', font: { size: 11, color: '#5b6573' } },
            tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' },
            gridcolor: 'rgba(15, 22, 35,0.22)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.12,
            font: { size: 10, color: '#5b6573' }
        },
        margin: { l: 50, r: 10, t: 30, b: 45 }
    });

    Plotly.newPlot('clim-freq-chart', traces, layout, PLOTLY_CONFIG);
}

function renderIntensityOverview() {
    // Box plots of peak wind by basin — overview for main panel
    var basins = Object.keys(BASIN_NAMES);
    var traces = [];
    basins.forEach(function (basin) {
        var winds = allStorms
            .filter(function (s) { return s.basin === basin && s.peak_wind_kt != null && s.peak_wind_kt > 0; })
            .map(function (s) { return s.peak_wind_kt; });
        if (winds.length === 0) return;
        traces.push({
            y: winds, name: basin, type: 'box',
            marker: { color: BASIN_COLORS[basin] },
            boxmean: 'sd',
            hovertemplate: '<b>' + basin + '</b><br>%{y} kt<extra></extra>'
        });
    });
    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        yaxis: { title: { text: 'Peak Wind (kt)', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        xaxis: { tickfont: { size: 10, color: '#5b6573' } },
        showlegend: false,
        margin: { l: 50, r: 10, t: 10, b: 30 }
    });
    Plotly.newPlot('clim-hist-chart', traces, layout, PLOTLY_CONFIG);
}

function renderIntensityChangeOverview() {
    // Two overlaid histograms: ri_24h (max 24h intensification) and rw_24h (max 24h weakening)
    var riVals = allStorms.filter(function (s) { return s.ri_24h != null; }).map(function (s) { return s.ri_24h; });
    var rwVals = allStorms.filter(function (s) { return s.rw_24h != null; }).map(function (s) { return s.rw_24h; });
    var traces = [
        {
            x: riVals, type: 'histogram', name: 'Intensification',
            marker: { color: '#60a5fa', opacity: 0.7 },
            xbins: { size: 5 },
            hovertemplate: 'RI: %{x} kt/24h<br>%{y} storms<extra></extra>'
        },
        {
            x: rwVals, type: 'histogram', name: 'Weakening',
            marker: { color: '#f87171', opacity: 0.7 },
            xbins: { size: 5 },
            hovertemplate: 'RW: %{x} kt/24h<br>%{y} storms<extra></extra>'
        }
    ];
    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'overlay',
        xaxis: { title: { text: 'Max 24-h Wind Change (kt)', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'Storms', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        shapes: [
            { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: -30, x1: -30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } }
        ],
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.12, font: { size: 9, color: '#5b6573' } },
        margin: { l: 45, r: 10, t: 30, b: 45 }
    });
    Plotly.newPlot('clim-ri-chart', traces, layout, PLOTLY_CONFIG);
}

function renderLMILatOverview() {
    // Box plots of LMI latitude by basin
    var basins = Object.keys(BASIN_NAMES);
    var traces = [];
    basins.forEach(function (basin) {
        var lats = allStorms
            .filter(function (s) { return s.basin === basin && s.lmi_lat != null; })
            .map(function (s) { return Math.abs(s.lmi_lat); }); // Use absolute for SH comparison
        if (lats.length === 0) return;
        traces.push({
            y: lats, name: basin, type: 'box',
            marker: { color: BASIN_COLORS[basin] },
            boxmean: true,
            hovertemplate: '<b>' + basin + '</b><br>|Lat|: %{y:.1f}&deg;<extra></extra>'
        });
    });
    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        yaxis: { title: { text: '|Latitude| of LMI (\u00B0)', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        xaxis: { tickfont: { size: 10, color: '#5b6573' } },
        showlegend: false,
        margin: { l: 50, r: 10, t: 10, b: 30 }
    });
    Plotly.newPlot('clim-lmi-chart', traces, layout, PLOTLY_CONFIG);
}

function renderBasinPie() {
    var basinCounts = {};
    allStorms.forEach(function (s) {
        var b = s.basin || 'UN';
        basinCounts[b] = (basinCounts[b] || 0) + 1;
    });

    var labels = [];
    var values = [];
    var colors = [];
    Object.keys(BASIN_NAMES).forEach(function (b) {
        if (basinCounts[b]) {
            labels.push(BASIN_NAMES[b] + ' (' + b + ')');
            values.push(basinCounts[b]);
            colors.push(BASIN_COLORS[b] || '#6b7280');
        }
    });

    var trace = {
        labels: labels,
        values: values,
        type: 'pie',
        hole: 0.45,
        marker: { colors: colors, line: { color: '#ffffff', width: 2 } },
        textfont: { color: '#0f1623', size: 11, family: 'DM Sans' },
        textinfo: 'label+percent',
        textposition: 'outside',
        hovertemplate: '<b>%{label}</b><br>%{value} storms (%{percent})<extra></extra>'
    };

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        showlegend: false,
        margin: { l: 20, r: 20, t: 10, b: 10 }
    });

    Plotly.newPlot('clim-basin-chart', [trace], layout, PLOTLY_CONFIG);
}

// ══════════════════════════════════════════════════════════════
//  ACE DRILL-DOWN MODAL
// ══════════════════════════════════════════════════════════════

var aceModalBasins = ['ALL'];   // Active basins in ACE modal
var aceSeasonMap = null;        // Leaflet map for season track overview

window.openACEModal = function () {
    var modal = document.getElementById('ace-modal');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();

    // Reset basin chips
    aceModalBasins = ['ALL'];
    document.querySelectorAll('#ace-basin-chips .basin-chip').forEach(function (c) {
        c.classList.toggle('active', c.getAttribute('data-basin') === 'ALL');
    });

    // Hide year detail initially
    document.getElementById('ace-year-detail').style.display = 'none';

    renderACEDrillDownChart();
};

window.closeACEModal = function () {
    document.getElementById('ace-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
    // Destroy season map to free memory
    if (aceSeasonMap) {
        aceSeasonMap.remove();
        aceSeasonMap = null;
    }
};

window.toggleACEBasin = function (btn) {
    var basin = btn.getAttribute('data-basin');

    if (basin === 'ALL') {
        document.querySelectorAll('#ace-basin-chips .basin-chip').forEach(function (c) { c.classList.remove('active'); });
        btn.classList.add('active');
        aceModalBasins = ['ALL'];
    } else {
        document.querySelector('#ace-basin-chips .basin-chip[data-basin="ALL"]').classList.remove('active');
        btn.classList.toggle('active');

        aceModalBasins = [];
        document.querySelectorAll('#ace-basin-chips .basin-chip.active').forEach(function (c) {
            var b = c.getAttribute('data-basin');
            if (b !== 'ALL') aceModalBasins.push(b);
        });
        if (aceModalBasins.length === 0) {
            document.querySelector('#ace-basin-chips .basin-chip[data-basin="ALL"]').classList.add('active');
            aceModalBasins = ['ALL'];
        }
    }

    renderACEDrillDownChart();
    document.getElementById('ace-year-detail').style.display = 'none';
};

function renderACEDrillDownChart() {
    var years = allStorms.map(function (s) { return s.year; }).filter(function (y) { return y > 0; });
    var minYear = Math.max(Math.min.apply(null, years), 1950);
    var maxYear = Math.max.apply(null, years);
    var yearRange = [];
    for (var y = minYear; y <= maxYear; y++) yearRange.push(y);

    var basins = aceModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : aceModalBasins;
    var traces = [];

    basins.forEach(function (basin) {
        var aceByYear = yearRange.map(function (yr) {
            var ace = 0;
            allStorms.forEach(function (s) {
                if (s.year === yr && s.basin === basin) ace += (s.ace || 0);
            });
            return Math.round(ace * 10) / 10;
        });

        traces.push({
            x: yearRange,
            y: aceByYear,
            type: 'scatter',
            mode: 'lines',
            name: BASIN_NAMES[basin] || basin,
            line: { color: BASIN_COLORS[basin] || '#6b7280', width: 2 },
            hovertemplate: '<b>' + (BASIN_NAMES[basin] || basin) + ' %{x}</b><br>ACE: %{y:.1f}<extra></extra>'
        });
    });

    // Also add total ACE as a thicker dashed line if showing all basins
    if (aceModalBasins[0] === 'ALL') {
        var totalACE = yearRange.map(function (yr) {
            var ace = 0;
            allStorms.forEach(function (s) {
                if (s.year === yr) ace += (s.ace || 0);
            });
            return Math.round(ace * 10) / 10;
        });
        traces.push({
            x: yearRange,
            y: totalACE,
            type: 'scatter',
            mode: 'lines',
            name: 'Global Total',
            line: { color: '#5b6573', width: 2.5, dash: 'dot' },
            hovertemplate: '<b>Global %{x}</b><br>Total ACE: %{y:.1f}<extra></extra>'
        });
    }

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#5b6573' } },
            tickfont: { size: 9, color: '#5b6573' },
            gridcolor: 'rgba(15, 22, 35,0.22)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#5b6573' } },
            tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' },
            gridcolor: 'rgba(15, 22, 35,0.22)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.15,
            font: { size: 10, color: '#5b6573' }
        },
        margin: { l: 55, r: 10, t: 35, b: 45 },
        hovermode: 'x unified'
    });

    Plotly.newPlot('ace-drilldown-chart', traces, layout, PLOTLY_CONFIG);

    // Click handler for year drill-down
    var chartEl = document.getElementById('ace-drilldown-chart');
    chartEl.removeAllListeners && chartEl.removeAllListeners('plotly_click');
    chartEl.on('plotly_click', function (data) {
        if (data.points && data.points.length > 0) {
            var clickedYear = data.points[0].x;
            renderACEYearDetail(clickedYear);
        }
    });
}

function renderACEYearDetail(year) {
    var detailDiv = document.getElementById('ace-year-detail');
    detailDiv.style.display = '';

    // Scroll to it
    detailDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    var basins = aceModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : aceModalBasins;

    // Get storms for this year matching basin filter
    var yearStorms = allStorms.filter(function (s) {
        return s.year === year && (aceModalBasins[0] === 'ALL' || aceModalBasins.indexOf(s.basin) !== -1);
    });

    // Sort by ACE descending
    yearStorms.sort(function (a, b) { return (b.ace || 0) - (a.ace || 0); });

    var totalACE = yearStorms.reduce(function (sum, s) { return sum + (s.ace || 0); }, 0);

    document.getElementById('ace-year-title').textContent =
        year + ' Season — ' + yearStorms.length + ' storms, ACE: ' + totalACE.toFixed(1);

    // Render season track map
    renderACESeasonMap(yearStorms);

    // Bar chart of storm ACE
    var stormNames = yearStorms.map(function (s) {
        return (s.name || 'UNNAMED') + ' (' + s.basin + ')';
    });
    var stormACE = yearStorms.map(function (s) { return Math.round((s.ace || 0) * 10) / 10; });
    var stormColors = yearStorms.map(function (s) { return getIntensityColor(s.peak_wind_kt); });

    var trace = {
        y: stormNames,
        x: stormACE,
        type: 'bar',
        orientation: 'h',
        marker: { color: stormColors },
        hovertemplate: '<b>%{y}</b><br>ACE: %{x:.1f}<extra></extra>',
        texttemplate: '%{x:.1f}',
        textposition: 'outside',
        textfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' }
    };

    var chartHeight = Math.max(250, yearStorms.length * 26 + 60);

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#5b6573' } },
            tickfont: { size: 9, color: '#5b6573', family: 'JetBrains Mono' },
            gridcolor: 'rgba(15, 22, 35,0.22)'
        },
        yaxis: {
            tickfont: { size: 10, color: '#0f1623' },
            autorange: 'reversed'
        },
        showlegend: false,
        margin: { l: 160, r: 50, t: 10, b: 40 },
        height: chartHeight
    });

    Plotly.newPlot('ace-year-chart', [trace], layout, PLOTLY_CONFIG);

    // Click handler to jump to storm detail
    document.getElementById('ace-year-chart').on('plotly_click', function (data) {
        if (data.points && data.points.length > 0) {
            var idx = data.points[0].pointIndex;
            var storm = yearStorms[idx];
            if (storm) {
                closeACEModal();
                selectedStorm = storm;
                selectStorm(storm);
                viewStormDetail();
            }
        }
    });

    // Build table
    var maxACE = Math.max.apply(null, stormACE) || 1;
    var html = '<table><thead><tr>' +
        '<th>Storm</th><th>Basin</th><th>Peak Wind</th><th>Min Pres</th><th>ACE</th><th style="width:30%;">Contribution</th>' +
        '</tr></thead><tbody>';

    yearStorms.forEach(function (s) {
        var pct = totalACE > 0 ? ((s.ace || 0) / totalACE * 100) : 0;
        var barWidth = maxACE > 0 ? ((s.ace || 0) / maxACE * 100) : 0;
        var color = getIntensityColor(s.peak_wind_kt);
        html += '<tr>' +
            '<td><span class="ace-storm-name" style="color:' + color + ';" onclick="aceJumpToStorm(\'' + s.sid + '\')">' +
            (s.name || 'UNNAMED') + '</span></td>' +
            '<td>' + s.basin + '</td>' +
            '<td class="mono">' + (s.peak_wind_kt || '—') + ' kt</td>' +
            '<td class="mono">' + (s.min_pres_hpa || '—') + ' hPa</td>' +
            '<td class="mono">' + (s.ace || 0).toFixed(1) + '</td>' +
            '<td class="ace-bar-cell"><span class="ace-bar" style="width:' + barWidth + '%;background:' + color + ';"></span> ' +
            '<span style="font-size:0.72rem;color:var(--text-dim);">' + pct.toFixed(1) + '%</span></td>' +
            '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('ace-year-table').innerHTML = html;
}

window.aceJumpToStorm = function (sid) {
    var storm = allStorms.find(function (s) { return s.sid === sid; });
    if (storm) {
        closeACEModal();
        selectedStorm = storm;
        selectStorm(storm);
        viewStormDetail();
    }
};

// ── Season Track Map ─────────────────────────────────────────

function renderACESeasonMap(yearStorms) {
    // Destroy previous instance
    if (aceSeasonMap) {
        aceSeasonMap.remove();
        aceSeasonMap = null;
    }

    var mapEl = document.getElementById('ace-season-map');
    if (!mapEl) return;

    // Collect storms that have track data
    var stormsWithTracks = yearStorms.filter(function (s) { return allTracks && allTracks[s.sid]; });
    if (stormsWithTracks.length === 0) {
        mapEl.style.display = 'none';
        return;
    }
    mapEl.style.display = '';

    // Initialize map
    aceSeasonMap = L.map('ace-season-map', {
        center: [20, -60],
        zoom: 3,
        zoomControl: true,
        worldCopyJump: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 12
    }).addTo(aceSeasonMap);

    var allLats = [];
    var allLons = [];

    // Compute median ACE for label filtering (reduce clutter in busy seasons)
    var aceValues = stormsWithTracks.map(function (s) { return s.ace || 0; }).sort(function (a, b) { return a - b; });
    var medianACE = aceValues.length > 0 ? aceValues[Math.floor(aceValues.length / 2)] : 0;
    var labelThreshold = stormsWithTracks.length > 20 ? medianACE : -1;

    stormsWithTracks.forEach(function (storm) {
        var track = allTracks[storm.sid];
        if (!track || track.length < 2) return;

        var validPts = track.filter(function (p) { return p.la && p.lo; });
        if (validPts.length < 2) return;

        // Draw intensity-colored polyline segments
        var segmentCoords = [];
        for (var i = 1; i < validPts.length; i++) {
            var p0 = validPts[i - 1];
            var p1 = validPts[i];
            var isTCPhase = _isTCNature(p1.n);
            var color = isTCPhase ? getIntensityColor(p1.w) : '#6b7280';
            var seg = L.polyline(
                [[p0.la, p0.lo], [p1.la, p1.lo]],
                { color: color, weight: isTCPhase ? 2.5 : 1, opacity: isTCPhase ? 0.85 : 0.35, dashArray: isTCPhase ? null : '4,3' }
            );
            seg._stormSid = storm.sid;
            seg.addTo(aceSeasonMap);

            // Tooltip on hover
            seg.bindTooltip(
                '<b style="color:' + getIntensityColor(storm.peak_wind_kt) + '">' +
                (storm.name || 'UNNAMED') + '</b><br>' +
                getIntensityCategory(storm.peak_wind_kt) + ' — ' + (storm.peak_wind_kt || '?') + ' kt' +
                (storm.ace ? '<br>ACE: ' + storm.ace.toFixed(1) : ''),
                { sticky: true, className: 'track-tooltip', direction: 'top', offset: [0, -8] }
            );

            // Click to jump to storm detail
            seg.on('click', (function (sid) {
                return function () { aceJumpToStorm(sid); };
            })(storm.sid));

            // Highlight on hover
            seg.on('mouseover', function () { this.setStyle({ weight: 5, opacity: 1 }); });
            seg.on('mouseout', function () { this.setStyle({ weight: 2.5, opacity: 0.85 }); });
        }

        // Collect bounds
        validPts.forEach(function (p) {
            allLats.push(p.la);
            allLons.push(p.lo);
        });

        // Add storm name label at LMI point (or midpoint)
        if ((storm.ace || 0) > labelThreshold) {
            var lmiPt = validPts.reduce(function (max, p) {
                return (p.w || 0) > (max.w || 0) ? p : max;
            }, validPts[0]);

            var labelColor = getIntensityColor(storm.peak_wind_kt);
            var icon = L.divIcon({
                className: 'ace-track-label',
                html: '<span style="color:' + labelColor + '">' + (storm.name || 'UNNAMED') + '</span>',
                iconSize: [0, 0],
                iconAnchor: [-5, 6]
            });
            L.marker([lmiPt.la, lmiPt.lo], { icon: icon, interactive: false }).addTo(aceSeasonMap);
        }

        // Genesis dot
        var gen = validPts[0];
        L.circleMarker([gen.la, gen.lo], {
            radius: 3, color: '#fff', fillColor: getIntensityColor(gen.w), fillOpacity: 0.9, weight: 1
        }).addTo(aceSeasonMap);
    });

    // Fit map bounds
    if (allLats.length > 0) {
        aceSeasonMap.fitBounds([
            [Math.min.apply(null, allLats) - 3, Math.min.apply(null, allLons) - 5],
            [Math.max.apply(null, allLats) + 3, Math.max.apply(null, allLons) + 5]
        ]);
    }
}

// ══════════════════════════════════════════════════════════════
//  INTENSITY DISTRIBUTION MODAL
// ══════════════════════════════════════════════════════════════

var intensityModalBasins = ['ALL'];

window.openIntensityModal = function () {
    document.getElementById('intensity-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    intensityModalBasins = ['ALL'];
    _resetBasinChips('intensity-basin-chips', 'ALL');
    renderIntensityModalCharts();
};
window.closeIntensityModal = function () {
    document.getElementById('intensity-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};
window.toggleIntensityBasin = function (btn) {
    intensityModalBasins = _toggleBasinChip(btn, 'intensity-basin-chips');
    renderIntensityModalCharts();
};

function renderIntensityModalCharts() {
    var basins = intensityModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : intensityModalBasins;

    // CDF chart
    var cdfTraces = [];
    basins.forEach(function (basin) {
        var winds = allStorms
            .filter(function (s) { return s.basin === basin && s.peak_wind_kt != null && s.peak_wind_kt > 0; })
            .map(function (s) { return s.peak_wind_kt; })
            .sort(function (a, b) { return a - b; });
        if (winds.length === 0) return;
        var cdf = winds.map(function (_, i) { return (i + 1) / winds.length; });
        cdfTraces.push({
            x: winds, y: cdf, type: 'scatter', mode: 'lines',
            name: BASIN_NAMES[basin],
            line: { color: BASIN_COLORS[basin], width: 2 },
            hovertemplate: '<b>' + basin + '</b><br>%{x:.0f} kt: %{y:.1%} cumulative<extra></extra>'
        });
    });
    // Add SS category reference lines
    var ssShapes = [64, 83, 96, 113, 137].map(function (kt) {
        return { type: 'line', x0: kt, x1: kt, y0: 0, y1: 1, line: { color: 'rgba(15, 22, 35,0.15)', width: 1, dash: 'dot' } };
    });
    var cdfLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Peak Wind Speed (kt)', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'Cumulative Probability', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' }, range: [0, 1] },
        shapes: ssShapes,
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.15, font: { size: 10, color: '#5b6573' } },
        margin: { l: 55, r: 10, t: 35, b: 45 }, hovermode: 'closest'
    });
    Plotly.newPlot('intensity-cdf-chart', cdfTraces, cdfLayout, PLOTLY_CONFIG);

    // Box plots
    var boxTraces = [];
    basins.forEach(function (basin) {
        var winds = allStorms
            .filter(function (s) { return s.basin === basin && s.peak_wind_kt != null && s.peak_wind_kt > 0; })
            .map(function (s) { return s.peak_wind_kt; });
        if (winds.length === 0) return;
        boxTraces.push({ y: winds, name: basin, type: 'box', marker: { color: BASIN_COLORS[basin] }, boxmean: 'sd' });
    });
    var boxLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        yaxis: { title: { text: 'Peak Wind (kt)', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        showlegend: false, margin: { l: 55, r: 10, t: 10, b: 30 }
    });
    Plotly.newPlot('intensity-box-chart', boxTraces, boxLayout, PLOTLY_CONFIG);

    // Stats table
    var html = '<table><thead><tr><th>Basin</th><th>Count</th><th>Mean</th><th>Median</th><th>P90</th><th>P99</th><th>Max</th></tr></thead><tbody>';
    basins.forEach(function (basin) {
        var winds = allStorms
            .filter(function (s) { return s.basin === basin && s.peak_wind_kt != null && s.peak_wind_kt > 0; })
            .map(function (s) { return s.peak_wind_kt; })
            .sort(function (a, b) { return a - b; });
        if (winds.length === 0) return;
        var mean = winds.reduce(function (a, b) { return a + b; }, 0) / winds.length;
        var med = winds[Math.floor(winds.length * 0.5)];
        var p90 = winds[Math.floor(winds.length * 0.9)];
        var p99 = winds[Math.floor(winds.length * 0.99)];
        html += '<tr><td style="color:' + BASIN_COLORS[basin] + '">' + BASIN_NAMES[basin] + '</td>' +
            '<td class="mono">' + winds.length + '</td><td class="mono">' + mean.toFixed(0) + '</td>' +
            '<td class="mono">' + med + '</td><td class="mono">' + p90 + '</td>' +
            '<td class="mono">' + p99 + '</td><td class="mono">' + Math.max.apply(null, winds) + '</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('intensity-stats-table').innerHTML = html;
}

// ══════════════════════════════════════════════════════════════
//  24-H INTENSITY CHANGE MODAL
// ══════════════════════════════════════════════════════════════

var riModalBasins = ['ALL'];
var riModalPeriod = 'modern'; // 'all', 'satellite', 'modern', '30yr', 'custom'

// Period definitions: [startYear, endYear]
var RI_PERIODS = {
    'all':       [0, 9999],
    'satellite': [1966, 9999],
    'modern':    [1980, 9999],
    '30yr':      [1991, 2020],
    'custom':    [1980, 2025]   // updated dynamically from inputs
};

// Helper: extract change values from intensityChangeData for a basin, filtered by period
function _riFilteredVals(basin) {
    if (!intensityChangeData || !intensityChangeData.basins || !intensityChangeData.basins[basin]) return [];
    var range = RI_PERIODS[riModalPeriod] || RI_PERIODS['modern'];
    var raw = intensityChangeData.basins[basin];
    // New format: each entry is [change, year]
    if (raw.length > 0 && Array.isArray(raw[0])) {
        var out = [];
        for (var i = 0; i < raw.length; i++) {
            var yr = raw[i][1];
            if (yr >= range[0] && yr <= range[1]) out.push(raw[i][0]);
        }
        return out;
    }
    // Legacy format: plain numbers (no year filtering possible)
    return raw;
}

// Helper: return [change, year] pairs for a basin (no period filter — used for trend analysis)
function _riAllPairs(basin) {
    if (!intensityChangeData || !intensityChangeData.basins || !intensityChangeData.basins[basin]) return [];
    var raw = intensityChangeData.basins[basin];
    if (raw.length > 0 && Array.isArray(raw[0])) return raw;
    return [];
}

function _showCustomRange(show) {
    var el = document.getElementById('ri-custom-range');
    if (el) el.style.display = show ? 'inline-flex' : 'none';
}

window.openIntensityChangeModal = function () {
    _ga('ga_open_ri_modal', {});
    document.getElementById('intensity-change-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    riModalBasins = ['ALL'];
    riModalPeriod = 'modern';
    _resetBasinChips('ri-basin-chips', 'ALL');
    // Reset period chips
    var chips = document.querySelectorAll('#ri-period-chips .basin-chip');
    chips.forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-period') === 'modern'); });
    _showCustomRange(false);
    // Lazy-load the ~1.3 MB intensity dataset on first open, then render.
    _ensureIntensityChangeData()
        .then(function () { renderRIModalCharts(); })
        .catch(function () { renderRIModalCharts(); });  // render shows empty/error gracefully
};
window.closeIntensityChangeModal = function () {
    document.getElementById('intensity-change-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};
window.toggleRIBasin = function (btn) {
    riModalBasins = _toggleBasinChip(btn, 'ri-basin-chips');
    renderRIModalCharts();
};
window.toggleRIPeriod = function (btn) {
    var chips = document.querySelectorAll('#ri-period-chips .basin-chip');
    chips.forEach(function (c) { c.classList.remove('active'); });
    btn.classList.add('active');
    riModalPeriod = btn.getAttribute('data-period');
    _showCustomRange(riModalPeriod === 'custom');
    if (riModalPeriod === 'custom') {
        // Read current input values
        var y1 = parseInt(document.getElementById('ri-year-start').value) || 1980;
        var y2 = parseInt(document.getElementById('ri-year-end').value) || 2025;
        RI_PERIODS['custom'] = [y1, y2];
    }
    renderRIModalCharts();
};
window.applyRICustomPeriod = function () {
    var y1 = parseInt(document.getElementById('ri-year-start').value) || 1980;
    var y2 = parseInt(document.getElementById('ri-year-end').value) || 2025;
    RI_PERIODS['custom'] = [Math.min(y1, y2), Math.max(y1, y2)];
    if (riModalPeriod === 'custom') renderRIModalCharts();
};

function renderRIModalCharts() {
    var basins = riModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : riModalBasins;

    // ── Histogram: all overwater 24-h intensity change episodes (pre-binned for percentiles) ──
    var BIN_SIZE = 5;
    var histTraces = [];
    basins.forEach(function (basin) {
        var vals = _riFilteredVals(basin);
        if (vals.length === 0) return;
        // Sort and bin manually so we can compute percentiles
        var sorted = vals.slice().sort(function (a, b) { return a - b; });
        var n = sorted.length;
        var binCounts = {};
        vals.forEach(function (v) {
            var b = Math.floor(v / BIN_SIZE) * BIN_SIZE;
            binCounts[b] = (binCounts[b] || 0) + 1;
        });
        // Build cumulative percentile at each bin's upper edge
        var binKeys = Object.keys(binCounts).map(Number).sort(function (a, b) { return a - b; });
        var cumul = 0;
        var binX = [], binY = [], binCustom = [];
        binKeys.forEach(function (b) {
            cumul += binCounts[b];
            var pctUpper = (cumul / n * 100).toFixed(1);
            var pctLower = ((cumul - binCounts[b]) / n * 100).toFixed(1);
            binX.push(b + BIN_SIZE / 2); // bin center
            binY.push(binCounts[b]);
            binCustom.push([b + ' to ' + (b + BIN_SIZE) + ' kt/24h', pctLower + '–' + pctUpper + ' pctl']);
        });
        histTraces.push({
            x: binX, y: binY, customdata: binCustom,
            type: 'bar', name: BASIN_NAMES[basin],
            marker: { color: BASIN_COLORS[basin], opacity: 0.65 },
            width: BIN_SIZE * 0.95,
            hovertemplate: '<b>' + basin + '</b><br>%{customdata[0]}<br>%{y} episodes (%{customdata[1]})<extra></extra>'
        });
    });
    var riShapes = [
        { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: 35, x1: 35, y0: 0, y1: 1, yref: 'paper', line: { color: '#f87171', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: 50, x1: 50, y0: 0, y1: 1, yref: 'paper', line: { color: '#dc2626', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: 65, x1: 65, y0: 0, y1: 1, yref: 'paper', line: { color: '#a855f7', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: -30, x1: -30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: -35, x1: -35, y0: 0, y1: 1, yref: 'paper', line: { color: '#f87171', width: 1.5, dash: 'dash' } }
    ];
    var riAnnotations = [
        { x: 30, y: 1.02, yref: 'paper', xanchor: 'center', text: '30kt', showarrow: false, font: { size: 9, color: '#fbbf24' } },
        { x: 35, y: 1.06, yref: 'paper', xanchor: 'center', text: '35kt', showarrow: false, font: { size: 9, color: '#f87171' } },
        { x: 50, y: 1.02, yref: 'paper', xanchor: 'center', text: '50kt', showarrow: false, font: { size: 9, color: '#dc2626' } },
        { x: 65, y: 1.06, yref: 'paper', xanchor: 'center', text: '65kt', showarrow: false, font: { size: 9, color: '#a855f7' } },
        { x: -30, y: 1.02, yref: 'paper', xanchor: 'center', text: '-30kt', showarrow: false, font: { size: 9, color: '#fbbf24' } },
        { x: -35, y: 1.06, yref: 'paper', xanchor: 'center', text: '-35kt', showarrow: false, font: { size: 9, color: '#f87171' } }
    ];
    // Episode count + period — update HTML subtitle
    var totalEpisodes = 0;
    histTraces.forEach(function (t) { totalEpisodes += t.x.length; });
    var periodRange = RI_PERIODS[riModalPeriod] || RI_PERIODS['modern'];
    var yrMin = periodRange[0] || (intensityChangeData ? intensityChangeData.year_min : '?');
    var yrMax = periodRange[1] < 9000 ? periodRange[1] : (intensityChangeData ? intensityChangeData.year_max : '?');
    var epEl = document.getElementById('ri-episode-count');
    if (epEl) epEl.textContent = '(' + totalEpisodes.toLocaleString() + ' episodes, ' + yrMin + '–' + yrMax + ')';
    var histLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        barmode: 'overlay',
        xaxis: { title: { text: '24-h Wind Change (kt)', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'Number of 24-h Episodes', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        shapes: riShapes, annotations: riAnnotations,
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#5b6573' } },
        margin: { l: 55, r: 10, t: 35, b: 45 }
    });
    Plotly.newPlot('ri-hist-chart', histTraces, histLayout, PLOTLY_CONFIG);

    // ── Exceedance CDF: probability of exceeding RI threshold (per-episode) ──
    var cdfTraces = [];
    basins.forEach(function (basin) {
        // Use only positive (intensification) episodes for the exceedance curve
        var vals = _riFilteredVals(basin).filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
        if (vals.length === 0) return;
        var exceed = vals.map(function (_, i) { return 1 - (i / vals.length); });
        cdfTraces.push({
            x: vals, y: exceed, type: 'scatter', mode: 'lines',
            name: BASIN_NAMES[basin],
            line: { color: BASIN_COLORS[basin], width: 2 },
            hovertemplate: '<b>' + basin + '</b><br>%{x} kt/24h: %{y:.1%} exceed<extra></extra>'
        });
    });
    var cdfLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Intensification Threshold (kt/24h)', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' }, range: [0, 100] },
        yaxis: { title: { text: 'Exceedance Probability', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' }, range: [0, 1] },
        shapes: [
            { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: 35, x1: 35, y0: 0, y1: 1, yref: 'paper', line: { color: '#f87171', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: 50, x1: 50, y0: 0, y1: 1, yref: 'paper', line: { color: '#dc2626', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: 65, x1: 65, y0: 0, y1: 1, yref: 'paper', line: { color: '#a855f7', width: 1.5, dash: 'dash' } }
        ],
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#5b6573' } },
        margin: { l: 55, r: 10, t: 30, b: 45 }, hovermode: 'closest'
    });
    Plotly.newPlot('ri-cdf-chart', cdfTraces, cdfLayout, PLOTLY_CONFIG);

    // Stats table — episode-based statistics, filtered by period
    var range = RI_PERIODS[riModalPeriod] || RI_PERIODS['modern'];
    var periodLabel = riModalPeriod === 'all' ? 'All Years' : riModalPeriod === 'satellite' ? '1966–Present' : riModalPeriod === '30yr' ? '1991–2020' : '1980–Present';
    var plEl = document.getElementById('ri-period-label');
    if (plEl) plEl.textContent = '';  // period shown in chips, no extra label needed
    var html = '<table><thead><tr><th>Basin</th><th>Episodes</th><th>Mean</th><th>\u226530kt</th><th>\u226535kt</th><th>\u226550kt</th><th>% RI\u226530</th><th>Max RI</th><th>\u2264-30kt</th><th>Max RW</th></tr></thead><tbody>';
    basins.forEach(function (basin) {
        var vals = _riFilteredVals(basin);
        if (vals.length === 0) return;
        var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        var ri30 = vals.filter(function (v) { return v >= 30; }).length;
        var ri35 = vals.filter(function (v) { return v >= 35; }).length;
        var ri50 = vals.filter(function (v) { return v >= 50; }).length;
        var maxRI = Math.max.apply(null, vals);
        var rw30 = vals.filter(function (v) { return v <= -30; }).length;
        var maxRW = Math.min.apply(null, vals);
        var pct = (ri30 / vals.length * 100).toFixed(1);
        html += '<tr><td style="color:' + BASIN_COLORS[basin] + '">' + BASIN_NAMES[basin] + '</td>' +
            '<td class="mono">' + vals.length.toLocaleString() + '</td><td class="mono">' + mean.toFixed(1) + '</td>' +
            '<td class="mono">' + ri30.toLocaleString() + '</td>' +
            '<td class="mono">' + ri35.toLocaleString() + '</td><td class="mono">' + ri50.toLocaleString() + '</td>' +
            '<td class="mono">' + pct + '%</td><td class="mono">+' + maxRI + '</td>' +
            '<td class="mono">' + rw30.toLocaleString() + '</td><td class="mono">' + maxRW + '</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('ri-stats-table').innerHTML = html;

    // ── RI Frequency Trend: % of episodes exceeding thresholds by 5-yr bins ──
    var BIN_YRS = 5;
    var RI_THRESHOLDS = [
        { val: 30, label: 'RI \u2265 30 kt', color: '#fbbf24' },
        { val: 35, label: 'RI \u2265 35 kt', color: '#f87171' },
        { val: 50, label: 'RI \u2265 50 kt', color: '#dc2626' },
        { val: 65, label: 'RI \u2265 65 kt', color: '#a855f7' }
    ];
    // Collect all [change, year] pairs for active basins (always use full satellite era for trend)
    var allPairs = [];
    basins.forEach(function (basin) {
        var pairs = _riAllPairs(basin);
        for (var i = 0; i < pairs.length; i++) {
            if (pairs[i][1] >= 1966) allPairs.push(pairs[i]); // satellite era only
        }
    });

    // Group by 5-yr bin
    var binMap = {};
    allPairs.forEach(function (p) {
        var yr = p[1];
        var binStart = Math.floor(yr / BIN_YRS) * BIN_YRS;
        if (!binMap[binStart]) binMap[binStart] = { total: 0, pos: 0, ri30: 0, ri35: 0, ri50: 0, ri65: 0 };
        binMap[binStart].total++;
        if (p[0] > 0) binMap[binStart].pos++;
        if (p[0] >= 30) binMap[binStart].ri30++;
        if (p[0] >= 35) binMap[binStart].ri35++;
        if (p[0] >= 50) binMap[binStart].ri50++;
        if (p[0] >= 65) binMap[binStart].ri65++;
    });

    var trendBins = Object.keys(binMap).map(Number).sort(function (a, b) { return a - b; });
    // Drop bins with very few episodes (< 50) as they produce noisy rates
    trendBins = trendBins.filter(function (b) { return binMap[b].total >= 50; });

    var trendTraces = RI_THRESHOLDS.map(function (th) {
        var key = 'ri' + th.val;
        return {
            x: trendBins.map(function (b) { return b + Math.floor(BIN_YRS / 2); }), // bin midpoint
            y: trendBins.map(function (b) { return binMap[b][key] / binMap[b].total * 100; }),
            customdata: trendBins.map(function (b) { return [binMap[b][key], binMap[b].total, b + '–' + (b + BIN_YRS - 1)]; }),
            type: 'scatter', mode: 'lines+markers',
            name: th.label,
            line: { color: th.color, width: 2 },
            marker: { size: 5, color: th.color },
            hovertemplate: '<b>' + th.label + '</b><br>%{customdata[2]}<br>%{y:.1f}% (%{customdata[0]} of %{customdata[1]})<extra></extra>'
        };
    });

    var trendLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Year', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        yaxis: { title: { text: '% of 24-h Episodes Exceeding Threshold', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' }, rangemode: 'tozero' },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#5b6573' } },
        margin: { l: 55, r: 10, t: 30, b: 45 }, hovermode: 'x unified'
    });
    Plotly.newPlot('ri-trend-chart', trendTraces, trendLayout, PLOTLY_CONFIG);

    // ── Exceedance CDF by Era: overlay curves for different periods ──
    var ERA_DEFS = [
        { label: '1966–1979', range: [1966, 1979], color: '#5b6573', dash: 'dot' },
        { label: '1980–1994', range: [1980, 1994], color: '#60a5fa', dash: 'dash' },
        { label: '1995–2009', range: [1995, 2009], color: '#34d399', dash: 'dashdot' },
        { label: '2010–2025', range: [2010, 2025], color: '#fbbf24', dash: 'solid' }
    ];

    var eraCdfTraces = [];
    ERA_DEFS.forEach(function (era) {
        // Gather positive (intensification) episodes for this era across active basins
        var eraVals = [];
        basins.forEach(function (basin) {
            var pairs = _riAllPairs(basin);
            for (var i = 0; i < pairs.length; i++) {
                if (pairs[i][1] >= era.range[0] && pairs[i][1] <= era.range[1] && pairs[i][0] > 0) {
                    eraVals.push(pairs[i][0]);
                }
            }
        });
        if (eraVals.length < 20) return; // skip eras with too few samples
        eraVals.sort(function (a, b) { return a - b; });
        var n = eraVals.length;
        eraCdfTraces.push({
            x: eraVals,
            y: eraVals.map(function (_, i) { return 1 - (i / n); }),
            type: 'scatter', mode: 'lines',
            name: era.label + ' (n=' + n.toLocaleString() + ')',
            line: { color: era.color, width: 2.5, dash: era.dash },
            hovertemplate: '<b>' + era.label + '</b><br>%{x} kt/24h: %{y:.1%} exceed<extra></extra>'
        });
    });

    var eraCdfShapes = [
        { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1, dash: 'dash' } },
        { type: 'line', x0: 50, x1: 50, y0: 0, y1: 1, yref: 'paper', line: { color: '#dc2626', width: 1, dash: 'dash' } }
    ];

    var eraCdfLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Intensification Threshold (kt/24h)', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' }, range: [0, 100] },
        yaxis: { title: { text: 'Exceedance Probability', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' }, range: [0, 0.5] },
        shapes: eraCdfShapes,
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#5b6573' } },
        margin: { l: 55, r: 10, t: 30, b: 45 }, hovermode: 'closest'
    });
    Plotly.newPlot('ri-era-cdf-chart', eraCdfTraces, eraCdfLayout, PLOTLY_CONFIG);

    // ── Era comparison stats table ──
    var eraHtml = '<table><thead><tr><th>Era</th><th>Episodes</th><th>Mean \u0394V</th><th>% \u226530</th><th>% \u226535</th><th>% \u226550</th><th>% \u226565</th><th>Max RI</th></tr></thead><tbody>';
    ERA_DEFS.forEach(function (era) {
        var eraVals = [];
        basins.forEach(function (basin) {
            var pairs = _riAllPairs(basin);
            for (var i = 0; i < pairs.length; i++) {
                if (pairs[i][1] >= era.range[0] && pairs[i][1] <= era.range[1]) eraVals.push(pairs[i][0]);
            }
        });
        if (eraVals.length < 20) return;
        var n = eraVals.length;
        var mean = eraVals.reduce(function (a, b) { return a + b; }, 0) / n;
        var ri30 = eraVals.filter(function (v) { return v >= 30; }).length;
        var ri35 = eraVals.filter(function (v) { return v >= 35; }).length;
        var ri50 = eraVals.filter(function (v) { return v >= 50; }).length;
        var ri65 = eraVals.filter(function (v) { return v >= 65; }).length;
        var maxRI = Math.max.apply(null, eraVals);
        eraHtml += '<tr><td style="color:' + era.color + '">' + era.label + '</td>' +
            '<td class="mono">' + n.toLocaleString() + '</td>' +
            '<td class="mono">' + mean.toFixed(1) + '</td>' +
            '<td class="mono">' + (ri30 / n * 100).toFixed(1) + '%</td>' +
            '<td class="mono">' + (ri35 / n * 100).toFixed(1) + '%</td>' +
            '<td class="mono">' + (ri50 / n * 100).toFixed(1) + '%</td>' +
            '<td class="mono">' + (ri65 / n * 100).toFixed(1) + '%</td>' +
            '<td class="mono">+' + maxRI + '</td></tr>';
    });
    eraHtml += '</tbody></table>';
    document.getElementById('ri-era-stats-table').innerHTML = eraHtml;
}

// ══════════════════════════════════════════════════════════════
//  SEASONAL CYCLE MODAL
// ══════════════════════════════════════════════════════════════

var seasonalModalBasins = ['ALL'];

window.openSeasonalModal = function () {
    document.getElementById('seasonal-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    seasonalModalBasins = ['ALL'];
    _resetBasinChips('seasonal-basin-chips', 'ALL');
    renderSeasonalModalChart();
};
window.closeSeasonalModal = function () {
    document.getElementById('seasonal-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};
window.toggleSeasonalBasin = function (btn) {
    seasonalModalBasins = _toggleBasinChip(btn, 'seasonal-basin-chips');
    renderSeasonalModalChart();
};

function renderSeasonalModalChart() {
    var basins = seasonalModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : seasonalModalBasins;
    var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Count storms per month per basin (use start_date month)
    // Compute mean storms per month = total / number of years in dataset
    var years = allStorms.map(function (s) { return s.year; }).filter(function (y) { return y >= 1950; });
    var nYears = Math.max(1, new Set(years).size);

    var traces = [];
    basins.forEach(function (basin) {
        var monthlyCounts = new Array(12).fill(0);
        allStorms.forEach(function (s) {
            if (s.basin !== basin || !s.start_date || s.year < 1950) return;
            var m = parseInt(s.start_date.substring(5, 7), 10) - 1;
            if (m >= 0 && m < 12) monthlyCounts[m]++;
        });
        var avgPerMonth = monthlyCounts.map(function (c) { return Math.round(c / nYears * 10) / 10; });
        traces.push({
            x: monthNames, y: avgPerMonth, type: 'scatter', mode: 'lines+markers',
            name: BASIN_NAMES[basin],
            line: { color: BASIN_COLORS[basin], width: 2.5 },
            marker: { size: 5, color: BASIN_COLORS[basin] },
            hovertemplate: '<b>' + basin + ' %{x}</b><br>%{y:.1f} storms/yr<extra></extra>'
        });
    });

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { tickfont: { size: 11, color: '#5b6573' }, gridcolor: 'rgba(15, 22, 35,0.22)' },
        yaxis: { title: { text: 'Mean Storms per Month', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.15, font: { size: 10, color: '#5b6573' } },
        margin: { l: 55, r: 10, t: 35, b: 40 }, hovermode: 'x unified'
    });
    Plotly.newPlot('seasonal-chart', traces, layout, PLOTLY_CONFIG);

    // Stats: peak month and season length per basin
    var html = '<table><thead><tr><th>Basin</th><th>Peak Month</th><th>Peak Rate</th><th>Annual Total</th><th>Active Months (>0.5/yr)</th></tr></thead><tbody>';
    basins.forEach(function (basin) {
        var monthlyCounts = new Array(12).fill(0);
        var totalCount = 0;
        allStorms.forEach(function (s) {
            if (s.basin !== basin || !s.start_date || s.year < 1950) return;
            var m = parseInt(s.start_date.substring(5, 7), 10) - 1;
            if (m >= 0 && m < 12) { monthlyCounts[m]++; totalCount++; }
        });
        var avgPerMonth = monthlyCounts.map(function (c) { return c / nYears; });
        var peakIdx = avgPerMonth.indexOf(Math.max.apply(null, avgPerMonth));
        var activeMonths = avgPerMonth.filter(function (v) { return v >= 0.5; }).length;
        html += '<tr><td style="color:' + BASIN_COLORS[basin] + '">' + BASIN_NAMES[basin] + '</td>' +
            '<td>' + monthNames[peakIdx] + '</td>' +
            '<td class="mono">' + avgPerMonth[peakIdx].toFixed(1) + '/yr</td>' +
            '<td class="mono">' + (totalCount / nYears).toFixed(1) + '/yr</td>' +
            '<td class="mono">' + activeMonths + '</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('seasonal-stats-table').innerHTML = html;
}

// ══════════════════════════════════════════════════════════════
//  LMI LATITUDE MODAL
// ══════════════════════════════════════════════════════════════

var lmiModalBasins = ['ALL'];
var lmiModalPeriod = 'modern';

// Shared period definitions (same as RI modal)
var LMI_PERIODS = {
    'all':       [0, 9999],
    'satellite': [1966, 9999],
    'modern':    [1980, 9999],
    '30yr':      [1991, 2020],
    'custom':    [1980, 2025]
};

// Helper: filter allStorms by basin + LMI period
function _lmiFilteredStorms(basin) {
    var range = LMI_PERIODS[lmiModalPeriod] || LMI_PERIODS['modern'];
    return allStorms.filter(function (s) {
        return s.basin === basin && s.year >= range[0] && s.year <= range[1];
    });
}

window.openLMILatModal = function () {
    document.getElementById('lmi-modal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    document.body.classList.add('modal-open');
    _hideBackgroundElements();
    lmiModalBasins = ['ALL'];
    lmiModalPeriod = 'modern';
    _resetBasinChips('lmi-basin-chips', 'ALL');
    var chips = document.querySelectorAll('#lmi-period-chips .basin-chip');
    chips.forEach(function (c) { c.classList.toggle('active', c.getAttribute('data-period') === 'modern'); });
    var cr = document.getElementById('lmi-custom-range');
    if (cr) cr.style.display = 'none';
    renderLMIModalCharts();
};
window.closeLMILatModal = function () {
    document.getElementById('lmi-modal').style.display = 'none';
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open');
    _showBackgroundElements();
};
window.toggleLMIBasin = function (btn) {
    lmiModalBasins = _toggleBasinChip(btn, 'lmi-basin-chips');
    renderLMIModalCharts();
};
window.toggleLMIPeriod = function (btn) {
    var chips = document.querySelectorAll('#lmi-period-chips .basin-chip');
    chips.forEach(function (c) { c.classList.remove('active'); });
    btn.classList.add('active');
    lmiModalPeriod = btn.getAttribute('data-period');
    var cr = document.getElementById('lmi-custom-range');
    if (cr) cr.style.display = lmiModalPeriod === 'custom' ? 'inline-flex' : 'none';
    if (lmiModalPeriod === 'custom') {
        var y1 = parseInt(document.getElementById('lmi-year-start').value) || 1980;
        var y2 = parseInt(document.getElementById('lmi-year-end').value) || 2025;
        LMI_PERIODS['custom'] = [Math.min(y1, y2), Math.max(y1, y2)];
    }
    renderLMIModalCharts();
};
window.applyLMICustomPeriod = function () {
    var y1 = parseInt(document.getElementById('lmi-year-start').value) || 1980;
    var y2 = parseInt(document.getElementById('lmi-year-end').value) || 2025;
    LMI_PERIODS['custom'] = [Math.min(y1, y2), Math.max(y1, y2)];
    if (lmiModalPeriod === 'custom') renderLMIModalCharts();
};

function renderLMIModalCharts() {
    var basins = lmiModalBasins[0] === 'ALL' ? Object.keys(BASIN_NAMES) : lmiModalBasins;

    // Period label
    var range = LMI_PERIODS[lmiModalPeriod] || LMI_PERIODS['modern'];
    var yrMin = range[0] || 1842;
    var yrMax = range[1] < 9000 ? range[1] : 2025;
    var totalStorms = 0;

    // Scatter: LMI latitude vs peak wind
    var scatterTraces = [];
    basins.forEach(function (basin) {
        var storms = _lmiFilteredStorms(basin).filter(function (s) {
            return s.lmi_lat != null && s.peak_wind_kt != null && s.peak_wind_kt > 0;
        });
        if (storms.length === 0) return;
        totalStorms += storms.length;
        scatterTraces.push({
            x: storms.map(function (s) { return s.peak_wind_kt; }),
            y: storms.map(function (s) { return s.lmi_lat; }),
            text: storms.map(function (s) { return (s.name || 'UNNAMED') + ' (' + s.year + ')'; }),
            type: 'scatter', mode: 'markers',
            name: BASIN_NAMES[basin],
            marker: { color: BASIN_COLORS[basin], size: 4, opacity: 0.5 },
            hovertemplate: '<b>%{text}</b><br>%{x} kt, %{y:.1f}\u00B0<extra>' + basin + '</extra>'
        });
    });
    // Update period info in header
    var piEl = document.getElementById('lmi-period-info');
    if (piEl) piEl.textContent = '(' + totalStorms.toLocaleString() + ' storms, ' + yrMin + '–' + yrMax + ')';

    var scatterLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Peak Wind (kt)', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'LMI Latitude (\u00B0)', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#5b6573' } },
        margin: { l: 55, r: 10, t: 35, b: 45 }, hovermode: 'closest'
    });
    Plotly.newPlot('lmi-scatter-chart', scatterTraces, scatterLayout, PLOTLY_CONFIG);

    // Box plots of LMI latitude
    var boxTraces = [];
    basins.forEach(function (basin) {
        var lats = _lmiFilteredStorms(basin)
            .filter(function (s) { return s.lmi_lat != null; })
            .map(function (s) { return s.lmi_lat; });
        if (lats.length === 0) return;
        boxTraces.push({ y: lats, name: basin, type: 'box', marker: { color: BASIN_COLORS[basin] }, boxmean: true });
    });
    var boxLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        yaxis: { title: { text: 'LMI Latitude (\u00B0)', font: { size: 11, color: '#5b6573' } }, gridcolor: 'rgba(15, 22, 35,0.22)', tickfont: { size: 10, color: '#5b6573', family: 'JetBrains Mono' } },
        showlegend: false, margin: { l: 55, r: 10, t: 10, b: 30 }
    });
    Plotly.newPlot('lmi-box-chart', boxTraces, boxLayout, PLOTLY_CONFIG);

    // Stats table
    var html = '<table><thead><tr><th>Basin</th><th>Count</th><th>Mean Lat</th><th>Median Lat</th><th>Min |Lat|</th><th>Max |Lat|</th></tr></thead><tbody>';
    basins.forEach(function (basin) {
        var lats = _lmiFilteredStorms(basin)
            .filter(function (s) { return s.lmi_lat != null; })
            .map(function (s) { return s.lmi_lat; })
            .sort(function (a, b) { return a - b; });
        if (lats.length === 0) return;
        var absLats = lats.map(function (l) { return Math.abs(l); });
        var mean = lats.reduce(function (a, b) { return a + b; }, 0) / lats.length;
        var med = lats[Math.floor(lats.length * 0.5)];
        html += '<tr><td style="color:' + BASIN_COLORS[basin] + '">' + BASIN_NAMES[basin] + '</td>' +
            '<td class="mono">' + lats.length.toLocaleString() + '</td><td class="mono">' + mean.toFixed(1) + '\u00B0</td>' +
            '<td class="mono">' + med.toFixed(1) + '\u00B0</td>' +
            '<td class="mono">' + Math.min.apply(null, absLats).toFixed(1) + '\u00B0</td>' +
            '<td class="mono">' + Math.max.apply(null, absLats).toFixed(1) + '\u00B0</td></tr>';
    });
    html += '</tbody></table>';
    document.getElementById('lmi-stats-table').innerHTML = html;
}

// ══════════════════════════════════════════════════════════════
//  BASIN CHIP HELPERS (shared by all modals)
// ══════════════════════════════════════════════════════════════

function _resetBasinChips(containerId, activeBasin) {
    document.querySelectorAll('#' + containerId + ' .basin-chip').forEach(function (c) {
        c.classList.toggle('active', c.getAttribute('data-basin') === activeBasin);
    });
}

function _toggleBasinChip(btn, containerId) {
    var basin = btn.getAttribute('data-basin');
    if (basin === 'ALL') {
        _resetBasinChips(containerId, 'ALL');
        return ['ALL'];
    }
    document.querySelector('#' + containerId + ' .basin-chip[data-basin="ALL"]').classList.remove('active');
    btn.classList.toggle('active');
    var selected = [];
    document.querySelectorAll('#' + containerId + ' .basin-chip.active').forEach(function (c) {
        var b = c.getAttribute('data-basin');
        if (b !== 'ALL') selected.push(b);
    });
    if (selected.length === 0) {
        _resetBasinChips(containerId, 'ALL');
        return ['ALL'];
    }
    return selected;
}

// ════════════════════════════════════════════════════════════════
//  PAGE INIT — sub-tab switching, hash routing, data load
// ════════════════════════════════════════════════════════════════

// Wrap openACEModal to also kick off the tracks load — the season map
// needs allTracks, and starting the fetch when the user opens the
// modal means tracks usually arrive before they click a year to
// drill down (the renderACESeasonMap guard handles the not-yet-loaded
// case gracefully on the first render).
var _origOpenACEModal = window.openACEModal;
window.openACEModal = function () {
    _ensureTracksLoaded();   // fire-and-forget — re-render handled below
    return _origOpenACEModal.apply(this, arguments);
};

// When tracks finish loading and the ACE modal is open with a year
// drilled down, re-render the season map so it actually paints.
function _maybeRefreshSeasonMap() {
    var modal = document.getElementById('ace-modal');
    var detail = document.getElementById('ace-year-detail');
    if (!modal || modal.style.display === 'none') return;
    if (!detail || detail.style.display === 'none') return;
    // The year is encoded in the title — easiest is to re-trigger the
    // drilldown via the chart's last clicked year. We just call
    // renderACEYearDetail again with the title-extracted year.
    var titleEl = document.getElementById('ace-year-title');
    if (!titleEl) return;
    var match = /(\d{4})/.exec(titleEl.textContent || '');
    if (!match) return;
    var year = Number(match[1]);
    if (!Number.isFinite(year)) return;
    if (typeof renderACEYearDetail === 'function') renderACEYearDetail(year);
}

// ── Sub-tab switching ───────────────────────────────────────────
var _SUBVIEWS = {
    stats:       'tc-clim-stats',
    globe:       'tc-clim-globe',
    subseasonal: 'tc-clim-subseasonal',
};
function _switchSubview(sub) {
    if (!_SUBVIEWS[sub]) sub = 'globe';
    Object.keys(_SUBVIEWS).forEach(function (k) {
        var el = document.getElementById(_SUBVIEWS[k]);
        if (el) el.hidden = (k !== sub);
    });
    document.querySelectorAll('.tc-clim-subnav-btn').forEach(function (b) {
        var active = (b.dataset.sub === sub);
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    _ga('tc_clim_subview', { sub: sub });
    // Stats charts may need a redraw if Plotly was sized while hidden.
    if (sub === 'stats' && climRendered && typeof Plotly !== 'undefined') {
        ['clim-ace-chart','clim-freq-chart','clim-hist-chart',
         'clim-ri-chart','clim-basin-chart','clim-lmi-chart'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el && el.layout) Plotly.Plots.resize(el);
        });
    }
    if (sub === 'subseasonal') {
        if (typeof _initSubseasonalOnce === 'function') _initSubseasonalOnce();
    }
}

// ── Hash routing ────────────────────────────────────────────────
// Supports:  #sub=stats   #sub=globe
//            #sub=stats&modal=ri    (auto-opens RI modal)
//            #sub=stats&modal=ace
//            #sub=stats&modal=intensity
//            #sub=stats&modal=seasonal
//            #sub=stats&modal=lmi
function _readHashParams() {
    var hash = window.location.hash || '';
    if (hash.length < 2) return {};
    var parts = hash.substring(1).split('&');
    var out = {};
    parts.forEach(function (p) {
        var kv = p.split('=');
        if (kv.length === 2) out[kv[0]] = decodeURIComponent(kv[1]);
    });
    return out;
}

function _applyHashParams(params) {
    // Default sub-view = globe. Reanalysis Globe has more capability
    // (composite builder, 14 indices, correlation, IBTrACS overlay) and
    // its featured-views gallery makes a stronger landing surface than
    // the chart grid. Stats sub-view loads on explicit #sub=stats only,
    // including the redirect from old global_archive.html?#tab=climatology.
    if (params.sub === 'stats') _switchSubview('stats');
    else if (params.sub === 'subseasonal') {
        _switchSubview('subseasonal');
        // Optional mode pre-select (e.g. RT Monitor's clock-click lands
        // on `#sub=subseasonal&mode=bsiso1` so the user sees the same
        // dial they clicked, not whatever was selected last).
        if (params.mode && ['mjo', 'mjo_omi', 'bsiso1', 'bsiso2'].indexOf(params.mode) !== -1) {
            // Defer until _initSubseasonalOnce has wired up the mode toggle
            setTimeout(function () {
                var btn = document.querySelector('#sub-mode-toggle [data-sub-mode="' + params.mode + '"]');
                if (btn) btn.click();
            }, 80);
        }
        // evoOnly=1 / evo=1 strips all chrome and auto-opens the
        // phase-evolution modal so this URL can be loaded inside an
        // iframe from the RT Monitor's Subseasonal tab. Gives users
        // the full modal experience without leaving the RT page.
        if (params.evoOnly === '1' || params.evo === '1') {
            document.documentElement.classList.add('evo-only-mode');
            setTimeout(function () {
                if (typeof window._openSubEvolutionFromHash === 'function') {
                    window._openSubEvolutionFromHash();
                }
            }, 220);
        }
    }
    else _switchSubview('globe');

    if (params.modal) {
        var openers = {
            ri:        window.openIntensityChangeModal,
            ace:       window.openACEModal,
            intensity: window.openIntensityModal,
            seasonal:  window.openSeasonalModal,
            lmi:       window.openLMILatModal,
        };
        var fn = openers[params.modal];
        if (typeof fn === 'function') {
            // Defer until charts are rendered + DOM stable, so the modal
            // overlays the painted page rather than a blank shell.
            setTimeout(fn, 50);
        }
    }
}

// ── IBTrACS storms metadata fetch ───────────────────────────────
function _loadStormsMetadata() {
    return fetch(STORMS_JSON)
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(function (data) {
            allStorms = data.storms || [];
            console.log('[TC Climatology] Loaded ' + allStorms.length + ' storms');
            return allStorms;
        });
}

// ── Wire sub-nav clicks ─────────────────────────────────────────
function _bindSubnav() {
    document.querySelectorAll('.tc-clim-subnav-btn').forEach(function (b) {
        b.addEventListener('click', function () {
            var sub = b.dataset.sub;
            _switchSubview(sub);
            // Keep the URL in sync without polluting history.
            var params = _readHashParams();
            params.sub = sub;
            // Strip any modal=… so the user doesn't get a stale auto-open
            // on next navigation.
            delete params.modal;
            var hash = Object.keys(params)
                .map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
                .join('&');
            history.replaceState(null, '', '#' + hash);
        });
    });
}

// When tracks finish loading, refresh the ACE map if the modal is
// already open and a year has been drilled down.
function _watchTracksReady() {
    if (_tracksLoadPromise) {
        _tracksLoadPromise.then(_maybeRefreshSeasonMap);
    }
}

// ════════════════════════════════════════════════════════════════
//  SUBSEASONAL MODULATION (MJO / BSISO) — Tier 1+2
//  Cross-references daily 8-phase index (data/subseasonal_phases.json)
//  with IBTrACS genesis dates (already loaded) and 6-h fixes (lazy)
//  to render: (a) a polar dial of genesis counts per phase, and
//  (b) an 8-panel grid of track-point density maps. Active days only
//  (amplitude ≥ 1). Tier 3 — ERA5 fields composited by phase — would
//  need a daily ERA5 tile pipeline and lives in a separate plan doc.
// ════════════════════════════════════════════════════════════════
var _subPhases = null;              // loaded JSON payload
var _subPhasesPromise = null;
var _subInited = false;
var _subState = {
    mode: 'mjo',                    // mjo | mjo_omi | bsiso1 | bsiso2
    basin: 'ALL',                   // ALL | NA | EP | WP | NI | SI | SP
    season: 'all',                  // all | mjjaso | ndjfma
    mapMode: 'tracks',              // tracks | genesis | ri | dw
    mapAnomaly: false,              // false → raw values, true → (phase − across-all-phases mean) per cell
    dialMetric: 'genesis',          // genesis | ace | days — what the left-hand polar dial plots
    yearMin: null,                  // inclusive lower bound (null → use mode's start year)
    yearMax: null,                  // inclusive upper bound (null → use mode's end year)
    riOverwater: true,              // RI panel: drop intervals where f0 or f1 is overland
    riTCPhaseOnly: true,            // RI panel: drop ET / DB / DS / NR start-of-interval nature
    riVmin: 35,                     // RI panel: minimum start-of-interval Vmax (kt)
    riVmax: 200,                    // RI panel: maximum start-of-interval Vmax (kt) — MPI-proximity proxy
    activeDaysByPhase: null,        // populated per (mode, season, basin scope)
};

// ── Land mask (1° packed binary, ~64 KB) ────────────────────────
// Loaded lazily on first use of the RI overwater filter. Cell index
// = row*360 + col where row = floor(89.5 - lat), col = floor(lon + 179.5).
var _landMask = null;
var _landMaskPromise = null;
function _loadLandMask() {
    if (_landMask) return Promise.resolve(_landMask);
    if (_landMaskPromise) return _landMaskPromise;
    _landMaskPromise = fetch('data/land_mask_1deg.json?' + DATA_VER)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { _landMask = d; return d; })
        .catch(function () { _landMask = null; return null; });
    return _landMaskPromise;
}
function _isLand(lat, lon) {
    if (!_landMask || lat == null || lon == null) return false;
    if (lat >= 90 || lat <= -90) return false;
    // Normalize longitude to [-180, 180)
    var ln = lon;
    while (ln >= 180) ln -= 360;
    while (ln < -180) ln += 360;
    var row = Math.floor(89.5 - lat);
    var col = Math.floor(ln + 179.5);
    if (row < 0) row = 0; else if (row > 179) row = 179;
    if (col < 0) col = 0; else if (col > 359) col = 359;
    return _landMask.mask.charCodeAt(row * 360 + col) === 49;  // '1'
}

// Nature classes considered "true TC" for the TC-phase filter. ET = extratropical;
// DB/DS = disturbance; NR = not reported; MX = mixture. WV = wave (rare).
var _TC_NATURES = { TS:1, TD:1, HU:1, TC:1, SS:1, SD:1 };

// True if year y is within the active filter window. null bounds = open.
function _subYearMatch(y) {
    if (_subState.yearMin != null && y < _subState.yearMin) return false;
    if (_subState.yearMax != null && y > _subState.yearMax) return false;
    return true;
}

// ── ISO date → days since epoch (UTC), no Date allocation per call ──
function _dayKeyFromISO(iso) {
    // iso 'YYYY-MM-DD'
    var y = +iso.slice(0,4), m = +iso.slice(5,7), d = +iso.slice(8,10);
    return Date.UTC(y, m - 1, d) / 86400000;
}
function _phaseOnDay(modeRec, dayKey) {
    var startKey = modeRec._startKey;
    if (startKey == null) {
        modeRec._startKey = _dayKeyFromISO(modeRec.start_date);
        startKey = modeRec._startKey;
    }
    var idx = dayKey - startKey;
    if (idx < 0 || idx >= modeRec.phases.length) return null;
    var p = modeRec.phases[idx], a = modeRec.amplitudes[idx];
    if (p == null || a == null) return null;
    if (p < 1 || p > 8) return null;            // defensive: skip pathological phase values
    return (a >= 1.0) ? p : 0;     // 0 = quiescent, 1..8 = active phase
}

// Daily-refreshed copy lives in GCS (see refresh_indices() in
// build_subseasonal_overlays.py — Cloud Run Job at 13:30 UTC). The
// bundled data/subseasonal_phases.json is the seed / fallback for any
// case where the GCS fetch fails (CORS hiccup, first-run-before-job,
// network outage). GCS file always has at least as much data as the
// bundled one, so prefer it.
var _SUBSEASONAL_INDICES_GCS = (
    'https://storage.googleapis.com/tc-atlas-ir-cache/subseasonal/indices/latest.json'
);

function _loadSubPhases() {
    if (_subPhases) return Promise.resolve(_subPhases);
    if (_subPhasesPromise) return _subPhasesPromise;
    var fallback = function () {
        return fetch('data/subseasonal_phases.json?' + DATA_VER)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            });
    };
    _subPhasesPromise = fetch(_SUBSEASONAL_INDICES_GCS, { cache: 'no-store' })
        .then(function (r) {
            if (!r.ok) throw new Error('GCS HTTP ' + r.status);
            return r.json();
        })
        .catch(function (err) {
            console.warn('[subseasonal] GCS load failed, falling back to bundled:', err);
            return fallback();
        })
        .then(function (d) {
            _subPhases = d;
            return d;
        })
        .catch(function (err) {
            console.warn('[subseasonal] phases load failed:', err);
            _subPhases = { indices: {} };
            return _subPhases;
        });
    return _subPhasesPromise;
}

// Return true if (basinCode) is included in current selection.
function _subBasinMatch(basin) {
    if (_subState.basin === 'ALL') return basin !== 'SA';  // SA is too sparse
    return basin === _subState.basin;
}

// Return true if calendar month m (1..12) is included in current season filter.
function _subSeasonMatch(month) {
    var s = _subState.season;
    if (s === 'all') return true;
    if (s === 'mjjaso') return month >= 5 && month <= 10;
    if (s === 'ndjfma') return month <= 4 || month >= 11;
    return true;
}

// Count active days per phase (1..8) given the current mode + season filter.
// Used as the denominator for expected-uniform genesis and as the per-phase
// day count for normalizing track density.
function _countActiveDaysPerPhase() {
    var modeRec = _subPhases && _subPhases.indices && _subPhases.indices[_subState.mode];
    if (!modeRec) return { perPhase: [0,0,0,0,0,0,0,0], total: 0 };
    if (modeRec._startKey == null) modeRec._startKey = _dayKeyFromISO(modeRec.start_date);
    var startKey = modeRec._startKey;
    var phases = modeRec.phases, amps = modeRec.amplitudes;
    var perPhase = [0,0,0,0,0,0,0,0], total = 0;
    for (var i = 0; i < phases.length; i++) {
        var p = phases[i], a = amps[i];
        if (p == null || a == null || a < 1.0) continue;
        // month + year for season + year filter — compute from index
        var d = new Date((startKey + i) * 86400000);
        if (!_subSeasonMatch(d.getUTCMonth() + 1)) continue;
        if (!_subYearMatch(d.getUTCFullYear())) continue;
        perPhase[p - 1]++;
        total++;
    }
    return { perPhase: perPhase, total: total };
}

// Cross-reference IBTrACS storm genesis with the active mode phases.
// Returns counts per phase (1..8) and the total accepted genesis count.
function _countGenesisPerPhase() {
    var modeRec = _subPhases.indices[_subState.mode];
    if (!modeRec) return { perPhase: [0,0,0,0,0,0,0,0], total: 0 };
    var startKey = modeRec._startKey != null ? modeRec._startKey : _dayKeyFromISO(modeRec.start_date);
    modeRec._startKey = startKey;
    var endKey = startKey + modeRec.phases.length - 1;
    var perPhase = [0,0,0,0,0,0,0,0], total = 0;
    for (var i = 0; i < allStorms.length; i++) {
        var s = allStorms[i];
        if (!s.start_date || !s.basin) continue;
        if (!_subBasinMatch(s.basin)) continue;
        if (!s.peak_wind_kt || s.peak_wind_kt < 34) continue;   // named storms only
        var dk = _dayKeyFromISO(s.start_date);
        if (dk < startKey || dk > endKey) continue;
        var month = +s.start_date.slice(5,7);
        if (!_subSeasonMatch(month)) continue;
        if (!_subYearMatch(+s.start_date.slice(0,4))) continue;
        var p = _phaseOnDay(modeRec, dk);
        if (!p) continue;       // null (out of range) OR 0 (inactive)
        perPhase[p - 1]++;
        total++;
    }
    return { perPhase: perPhase, total: total };
}

// ACE (Accumulated Cyclone Energy) per phase. Sums v² / 10⁴ over the
// synoptic-time fixes (00/06/12/18 UTC) of named storms (≥ 34 kt) whose
// date falls on a day of each phase. Filtering matches the other phase
// metrics: basin, season, year, mode amplitude ≥ 1. Storm fixes from
// subsynoptic times (e.g., 3-h or 1-h IBTrACS rows) are skipped so the
// classical 6-h ACE definition is preserved regardless of source spacing.
function _computeACEPerPhase() {
    var modeRec = _subPhases && _subPhases.indices[_subState.mode];
    if (!modeRec || Object.keys(allTracks).length === 0) {
        return { perPhase: [0,0,0,0,0,0,0,0], total: 0 };
    }
    if (modeRec._startKey == null) modeRec._startKey = _dayKeyFromISO(modeRec.start_date);
    var startKey = modeRec._startKey;
    var endKey   = startKey + modeRec.phases.length - 1;
    var perPhase = [0,0,0,0,0,0,0,0], total = 0;
    var sids = Object.keys(allTracks);
    for (var i = 0; i < sids.length; i++) {
        var sid = sids[i];
        var track = allTracks[sid];
        if (!track || !track.length) continue;
        var storm = _stormBySid[sid];
        if (!storm) continue;
        if (!_subBasinMatch(storm.basin)) continue;
        for (var j = 0; j < track.length; j++) {
            var f = track[j];
            if (!f.t || f.w == null || f.w < 34) continue;
            // Synoptic times only — hour ∈ {0, 6, 12, 18}. fix.t is
            // 'YYYY-MM-DDTHH:MM'; chars 11-12 are HH.
            var hh = f.t.length >= 13 ? +f.t.slice(11, 13) : 0;
            if (hh !== 0 && hh !== 6 && hh !== 12 && hh !== 18) continue;
            var iso = f.t.slice(0, 10);
            var month = +iso.slice(5, 7);
            if (!_subSeasonMatch(month)) continue;
            if (!_subYearMatch(+iso.slice(0, 4))) continue;
            var dk = _dayKeyFromISO(iso);
            if (dk < startKey || dk > endKey) continue;
            var p = _phaseOnDay(modeRec, dk);
            if (!p) continue;
            var ace = (f.w * f.w) / 10000;                 // 10⁴ kt²
            perPhase[p - 1] += ace;
            total += ace;
        }
    }
    return { perPhase: perPhase, total: total };
}

// Storm-days per phase. Counts unique (storm, calendar-day, phase) tuples
// where the storm had any synoptic fix ≥ 34 kt that day. Phase-day weight
// for activity that's NOT intensity-weighted — complements ACE.
function _computeStormDaysPerPhase() {
    var modeRec = _subPhases && _subPhases.indices[_subState.mode];
    if (!modeRec || Object.keys(allTracks).length === 0) {
        return { perPhase: [0,0,0,0,0,0,0,0], total: 0 };
    }
    if (modeRec._startKey == null) modeRec._startKey = _dayKeyFromISO(modeRec.start_date);
    var startKey = modeRec._startKey;
    var endKey   = startKey + modeRec.phases.length - 1;
    var perPhase = [0,0,0,0,0,0,0,0], total = 0;
    var sids = Object.keys(allTracks);
    for (var i = 0; i < sids.length; i++) {
        var sid = sids[i];
        var track = allTracks[sid];
        if (!track || !track.length) continue;
        var storm = _stormBySid[sid];
        if (!storm) continue;
        if (!_subBasinMatch(storm.basin)) continue;
        var seenDay = null;
        for (var j = 0; j < track.length; j++) {
            var f = track[j];
            if (!f.t || f.w == null || f.w < 34) continue;
            var iso = f.t.slice(0, 10);
            if (iso === seenDay) continue;
            seenDay = iso;                                  // count each (sid, day) once
            var month = +iso.slice(5, 7);
            if (!_subSeasonMatch(month)) continue;
            if (!_subYearMatch(+iso.slice(0, 4))) continue;
            var dk = _dayKeyFromISO(iso);
            if (dk < startKey || dk > endKey) continue;
            var p = _phaseOnDay(modeRec, dk);
            if (!p) continue;
            perPhase[p - 1]++;
            total++;
        }
    }
    return { perPhase: perPhase, total: total };
}

// 6-hourly track-point density per phase. Keyed by (5°-binned lat, lon).
// Returns array[8] of { lats:[…], lons:[…], cnts:[…] }. Coarse 5° to
// keep the Plotly trace size reasonable (36×72 = 2592 cells max per phase).
function _buildTrackDensityPerPhase() {
    var modeRec = _subPhases.indices[_subState.mode];
    if (!modeRec) return null;
    var startKey = modeRec._startKey;
    var endKey = startKey + modeRec.phases.length - 1;
    var BIN = 5;
    var grids = [];
    for (var i = 0; i < 8; i++) grids.push(new Map());
    var sids = Object.keys(allTracks);
    for (var i = 0; i < sids.length; i++) {
        var sid = sids[i];
        var track = allTracks[sid];
        if (!track || !track.length) continue;
        // basin filter: derive basin from sid suffix or look up storm meta
        var storm = _stormBySid[sid];
        if (storm) {
            if (!_subBasinMatch(storm.basin)) continue;
        }
        for (var j = 0; j < track.length; j++) {
            var fix = track[j];
            if (!fix.t || fix.la == null || fix.lo == null) continue;
            if (!fix.w || fix.w < 34) continue;   // TS-or-stronger only
            // fix.t is 'YYYY-MM-DDTHH:MM' — top 10 chars are the date
            var iso = fix.t.slice(0, 10);
            var month = +iso.slice(5, 7);
            if (!_subSeasonMatch(month)) continue;
            if (!_subYearMatch(+iso.slice(0,4))) continue;
            var dk = _dayKeyFromISO(iso);
            if (dk < startKey || dk > endKey) continue;
            var p = _phaseOnDay(modeRec, dk);
            if (!p) continue;
            var latBin = Math.floor(fix.la / BIN);
            var lonBin = Math.floor(fix.lo / BIN);
            var key = latBin + ',' + lonBin;
            var g = grids[p - 1];
            g.set(key, (g.get(key) || 0) + 1);
        }
    }
    return _gridsToArrays(grids, BIN);
}

// Genesis-point density per phase. Same 5° binning + return shape as the
// track-density variant, but seeded from storm.start_date + (genesis_lat,
// genesis_lon) — one point per storm. Doesn't need the heavy tracks file.
function _buildGenesisDensityPerPhase() {
    var modeRec = _subPhases.indices[_subState.mode];
    if (!modeRec) return null;
    var startKey = modeRec._startKey;
    var endKey = startKey + modeRec.phases.length - 1;
    var BIN = 5;
    var grids = [];
    for (var i = 0; i < 8; i++) grids.push(new Map());
    for (var i = 0; i < allStorms.length; i++) {
        var s = allStorms[i];
        if (!s.start_date || !s.basin) continue;
        if (!_subBasinMatch(s.basin)) continue;
        if (!s.peak_wind_kt || s.peak_wind_kt < 34) continue;   // named storms only
        if (s.genesis_lat == null || s.genesis_lon == null) continue;
        var month = +s.start_date.slice(5, 7);
        if (!_subSeasonMatch(month)) continue;
        if (!_subYearMatch(+s.start_date.slice(0,4))) continue;
        var dk = _dayKeyFromISO(s.start_date);
        if (dk < startKey || dk > endKey) continue;
        var p = _phaseOnDay(modeRec, dk);
        if (!p) continue;
        var latBin = Math.floor(s.genesis_lat / BIN);
        var lonBin = Math.floor(s.genesis_lon / BIN);
        var key = latBin + ',' + lonBin;
        var g = grids[p - 1];
        g.set(key, (g.get(key) || 0) + 1);
    }
    return _gridsToArrays(grids, BIN);
}

function _gridsToArrays(grids, BIN) {
    return grids.map(function (g) {
        var lats = [], lons = [], cnts = [];
        g.forEach(function (cnt, key) {
            var parts = key.split(',');
            lats.push((+parts[0]) * BIN + BIN/2);
            lons.push((+parts[1]) * BIN + BIN/2);
            cnts.push(cnt);
        });
        return { lats: lats, lons: lons, cnts: cnts };
    });
}

// Convert a per-phase density array into per-phase anomalies relative to
// the across-all-phases mean at each cell. `treatMissingAsZero`:
//   true  → count-based fields (tracks/genesis/RI): cells absent from a
//           phase contribute 0 to the cross-phase mean, so the anomaly
//           there is (0 − mean) = negative. Reflects "this phase has no
//           events at this cell while other phases do."
//   false → mean-based fields (ΔVmax): cells absent from a phase carry
//           no information; drop them from the mean and the per-phase
//           output (don't fabricate zero-anomaly cells where there were
//           no samples in the first place).
function _applyAnomalyToDensity(density, treatMissingAsZero) {
    if (!density) return density;
    var union = new Map();
    for (var p = 0; p < 8; p++) {
        var d = density[p];
        for (var i = 0; i < d.lats.length; i++) {
            var key = d.lats[i] + ',' + d.lons[i];
            var rec = union.get(key);
            if (!rec) {
                rec = { lat: d.lats[i], lon: d.lons[i], vals: new Array(8) };
                union.set(key, rec);
            }
            rec.vals[p] = d.cnts[i];
        }
    }
    var means = new Map();
    union.forEach(function (rec, key) {
        var sum = 0, n = 0;
        for (var p = 0; p < 8; p++) {
            var v = rec.vals[p];
            if (v == null || !Number.isFinite(v)) {
                if (treatMissingAsZero) { sum += 0; n++; }
            } else {
                sum += v; n++;
            }
        }
        means.set(key, n > 0 ? sum / n : 0);
    });
    var out = [];
    for (var pi = 0; pi < 8; pi++) {
        var lats = [], lons = [], cnts = [];
        union.forEach(function (rec, key) {
            var raw = rec.vals[pi];
            if (raw == null || !Number.isFinite(raw)) {
                if (!treatMissingAsZero) return;
                raw = 0;
            }
            lats.push(rec.lat);
            lons.push(rec.lon);
            cnts.push(raw - means.get(key));
        });
        out.push({ lats: lats, lons: lons, cnts: cnts });
    }
    return out;
}

// Spatial density of RI starting points per phase. Same 5° bins as the
// other density renderers. Reuses the RI dial's filter logic (Overwater,
// TC-phase, Vmax range) so the spatial view is consistent with the rate.
function _buildRIDensityPerPhase() {
    var modeRec = _subPhases.indices[_subState.mode];
    if (!modeRec) return null;
    var startKey = modeRec._startKey;
    var endKey = startKey + modeRec.phases.length - 1;
    var BIN = 5;
    var grids = [];
    for (var i = 0; i < 8; i++) grids.push(new Map());
    var vmin = _subState.riVmin, vmax = _subState.riVmax;
    var needOverwater = _subState.riOverwater && _landMask;
    var needTCPhase = _subState.riTCPhaseOnly;
    var sids = Object.keys(allTracks);
    for (var i = 0; i < sids.length; i++) {
        var sid = sids[i];
        var track = allTracks[sid];
        if (!track || track.length < 2) continue;
        var storm = _stormBySid[sid];
        if (!storm) continue;
        if (!_subBasinMatch(storm.basin)) continue;
        var times = new Array(track.length);
        for (var t = 0; t < track.length; t++) {
            times[t] = track[t].t ? Date.parse(track[t].t) : NaN;
        }
        var k = 0;
        for (var j = 0; j < track.length; j++) {
            var f0 = track[j];
            if (f0.w == null) continue;
            if (f0.w < vmin || f0.w > vmax) continue;
            if (!Number.isFinite(times[j])) continue;
            if (needTCPhase && !_TC_NATURES[f0.n]) continue;
            if (needOverwater && _isLand(f0.la, f0.lo)) continue;
            if (k <= j) k = j + 1;
            while (k < track.length && Number.isFinite(times[k])
                   && (times[k] - times[j]) < 21 * 3600000) k++;
            if (k >= track.length) break;
            if (!Number.isFinite(times[k])) continue;
            var dtH = (times[k] - times[j]) / 3600000;
            if (dtH > 27) continue;
            var f1 = track[k];
            if (f1.w == null) continue;
            if (needOverwater && _isLand(f1.la, f1.lo)) continue;
            var dw = f1.w - f0.w;
            if (dw < 30) continue;                          // RI threshold
            var iso = f0.t.slice(0, 10);
            var month = +iso.slice(5, 7);
            if (!_subSeasonMatch(month)) continue;
            if (!_subYearMatch(+iso.slice(0,4))) continue;
            var dk = _dayKeyFromISO(iso);
            if (dk < startKey || dk > endKey) continue;
            var p = _phaseOnDay(modeRec, dk);
            if (!p) continue;
            if (f0.la == null || f0.lo == null) continue;
            var latBin = Math.floor(f0.la / BIN);
            var lonBin = Math.floor(f0.lo / BIN);
            var key = latBin + ',' + lonBin;
            var g = grids[p - 1];
            g.set(key, (g.get(key) || 0) + 1);
        }
    }
    return _gridsToArrays(grids, BIN);
}

// Mean signed 24-h ΔVmax per 5° bin, per phase. Diverging field —
// negative cells = systematic weakening at that location in that phase,
// positive = systematic intensification. Useful for spotting "RI corridors"
// vs hostile regions. Returns same shape as the count grids but cnts[]
// holds the mean ΔVmax (kt) and an extra sample-size array gates rendering
// to cells with ≥ N intervals (poor stats are masked).
function _buildMeanDwPerPhase() {
    var modeRec = _subPhases.indices[_subState.mode];
    if (!modeRec) return null;
    var startKey = modeRec._startKey;
    var endKey = startKey + modeRec.phases.length - 1;
    var BIN = 5;
    var MIN_SAMPLES = 5;                                    // mask thin cells
    var sumGrids = []; var nGrids = [];
    for (var i = 0; i < 8; i++) {
        sumGrids.push(new Map());
        nGrids.push(new Map());
    }
    var vmin = _subState.riVmin, vmax = _subState.riVmax;
    var needOverwater = _subState.riOverwater && _landMask;
    var needTCPhase = _subState.riTCPhaseOnly;
    var sids = Object.keys(allTracks);
    for (var i = 0; i < sids.length; i++) {
        var sid = sids[i];
        var track = allTracks[sid];
        if (!track || track.length < 2) continue;
        var storm = _stormBySid[sid];
        if (!storm) continue;
        if (!_subBasinMatch(storm.basin)) continue;
        var times = new Array(track.length);
        for (var t = 0; t < track.length; t++) {
            times[t] = track[t].t ? Date.parse(track[t].t) : NaN;
        }
        var k = 0;
        for (var j = 0; j < track.length; j++) {
            var f0 = track[j];
            if (f0.w == null) continue;
            if (f0.w < vmin || f0.w > vmax) continue;
            if (!Number.isFinite(times[j])) continue;
            if (needTCPhase && !_TC_NATURES[f0.n]) continue;
            if (needOverwater && _isLand(f0.la, f0.lo)) continue;
            if (k <= j) k = j + 1;
            while (k < track.length && Number.isFinite(times[k])
                   && (times[k] - times[j]) < 21 * 3600000) k++;
            if (k >= track.length) break;
            if (!Number.isFinite(times[k])) continue;
            var dtH = (times[k] - times[j]) / 3600000;
            if (dtH > 27) continue;
            var f1 = track[k];
            if (f1.w == null) continue;
            if (needOverwater && _isLand(f1.la, f1.lo)) continue;
            var iso = f0.t.slice(0, 10);
            var month = +iso.slice(5, 7);
            if (!_subSeasonMatch(month)) continue;
            if (!_subYearMatch(+iso.slice(0,4))) continue;
            var dk = _dayKeyFromISO(iso);
            if (dk < startKey || dk > endKey) continue;
            var p = _phaseOnDay(modeRec, dk);
            if (!p) continue;
            if (f0.la == null || f0.lo == null) continue;
            var dw = f1.w - f0.w;
            var latBin = Math.floor(f0.la / BIN);
            var lonBin = Math.floor(f0.lo / BIN);
            var key = latBin + ',' + lonBin;
            sumGrids[p - 1].set(key, (sumGrids[p - 1].get(key) || 0) + dw);
            nGrids[p - 1].set(key, (nGrids[p - 1].get(key) || 0) + 1);
        }
    }
    // Build per-phase arrays of {lat, lon, meanDw, n} but mask cells with n < MIN_SAMPLES.
    return sumGrids.map(function (sg, idx) {
        var ng = nGrids[idx];
        var lats = [], lons = [], cnts = [];
        sg.forEach(function (sum, key) {
            var n = ng.get(key) || 0;
            if (n < MIN_SAMPLES) return;
            var parts = key.split(',');
            lats.push((+parts[0]) * BIN + BIN/2);
            lons.push((+parts[1]) * BIN + BIN/2);
            cnts.push(sum / n);                             // mean ΔVmax (kt)
        });
        return { lats: lats, lons: lons, cnts: cnts };
    });
}

// Compute 24-h overwater intensity-change distributions per phase.
// Returns per-phase arrays of all ΔVmax values + summary stats. The
// underlying convention follows Kaplan-DeMaria (2003): RI = ΔVmax ≥ 30 kt
// over 24h, sampled at synoptic 6-h spacing. We require the starting
// fix to be ≥ 35 kt (TS strength) so we don't pollute the rate with
// pre-genesis disturbances. Mean and RI rate are summary statistics
// per phase; the raw arrays are kept for histogram drill-in and for
// top-RI-storm lookups in the modal.
function _buildIntensityChangePerPhase() {
    var modeRec = _subPhases.indices[_subState.mode];
    if (!modeRec) return null;
    var startKey = modeRec._startKey;
    var endKey = startKey + modeRec.phases.length - 1;
    var changes = [];
    for (var i = 0; i < 8; i++) changes.push([]);          // raw ΔVmax arrays
    var hits = [0,0,0,0,0,0,0,0];                          // RI count (ΔVmax ≥ 30 kt)
    var sumDw = [0,0,0,0,0,0,0,0];                         // sum ΔVmax (for mean)
    var topRI = [[],[],[],[],[],[],[],[]];                 // {sid, name, year, dw, date, w0, w1} for the modal
    var sids = Object.keys(allTracks);
    // Synoptic spacing varies across the IBTrACS archive: modern data is
    // often at 3-h or 1-h subsynoptic intervals; older data is 6-h or
    // coarser. Per-fix timestamp lookup is the only reliable way to find
    // the 24-h-later fix. Pre-extract times once per storm (string→ms is
    // cheap but adds up across 800K+ fixes), then forward-scan.
    for (var i = 0; i < sids.length; i++) {
        var sid = sids[i];
        var track = allTracks[sid];
        if (!track || track.length < 2) continue;
        var storm = _stormBySid[sid];
        if (!storm) continue;
        if (!_subBasinMatch(storm.basin)) continue;
        var times = new Array(track.length);
        for (var t = 0; t < track.length; t++) {
            times[t] = track[t].t ? Date.parse(track[t].t) : NaN;
        }
        var k = 0;
        var vmin = _subState.riVmin, vmax = _subState.riVmax;
        var needOverwater = _subState.riOverwater && _landMask;
        var needTCPhase = _subState.riTCPhaseOnly;
        for (var j = 0; j < track.length; j++) {
            var f0 = track[j];
            if (f0.w == null) continue;
            if (f0.w < vmin || f0.w > vmax) continue;      // user-set start-Vmax window
            if (!Number.isFinite(times[j])) continue;
            if (needTCPhase && !_TC_NATURES[f0.n]) continue;
            if (needOverwater && _isLand(f0.la, f0.lo)) continue;
            // Advance k forward (never backward — fixes sorted by time)
            // to the first fix that's ≥ 21h after f0. If we walk past 27h
            // without a hit, no valid 24-h pair exists for this f0.
            if (k <= j) k = j + 1;
            while (k < track.length && Number.isFinite(times[k])
                   && (times[k] - times[j]) < 21 * 3600000) {
                k++;
            }
            if (k >= track.length) break;
            if (!Number.isFinite(times[k])) continue;
            var dtH = (times[k] - times[j]) / 3600000;
            if (dtH > 27) continue;                        // gap — skip but don't break (later f0 may fit)
            var f1 = track[k];
            if (f1.w == null) continue;
            if (needOverwater && _isLand(f1.la, f1.lo)) continue;
            var iso = f0.t.slice(0, 10);
            var month = +iso.slice(5, 7);
            if (!_subSeasonMatch(month)) continue;
            if (!_subYearMatch(+iso.slice(0,4))) continue;
            var dk = _dayKeyFromISO(iso);
            if (dk < startKey || dk > endKey) continue;
            var p = _phaseOnDay(modeRec, dk);
            if (!p) continue;
            var dw = f1.w - f0.w;
            changes[p - 1].push(dw);
            sumDw[p - 1] += dw;
            if (dw >= 30) {
                hits[p - 1]++;
                var top = topRI[p - 1];
                top.push({
                    sid: sid,
                    name: storm.name || '',
                    year: storm.year,
                    dw: dw, w0: f0.w, w1: f1.w,
                    date: iso,
                });
            }
        }
    }
    // Sort each phase's top-RI list by ΔVmax desc and trim
    var topRITrimmed = topRI.map(function (lst) {
        lst.sort(function (a, b) { return b.dw - a.dw; });
        return lst.slice(0, 8);
    });
    var nPerPhase = changes.map(function (c) { return c.length; });
    var meanDw = changes.map(function (c, i) { return c.length ? sumDw[i] / c.length : 0; });
    var riRate = changes.map(function (c, i) { return c.length ? hits[i] / c.length : 0; });
    return {
        nPerPhase: nPerPhase,
        riCount:   hits,
        riRate:    riRate,             // fraction 0..1
        meanDw:    meanDw,
        changes:   changes,            // raw arrays per phase
        topRI:     topRITrimmed,       // top-8 RI events per phase for modal
    };
}

// Build a SID → storm-meta index once (for basin filter on track fixes).
var _stormBySid = null;
function _ensureStormBySid() {
    if (_stormBySid) return;
    _stormBySid = {};
    for (var i = 0; i < allStorms.length; i++) _stormBySid[allStorms[i].sid] = allStorms[i];
}

// ── Renderers ───────────────────────────────────────────────────
function _renderActivityDial() {
    var el = document.getElementById('sub-dial-chart');
    if (!el || typeof Plotly === 'undefined') return;
    var metric = _subState.dialMetric;
    var act = _countActiveDaysPerPhase();
    var stats;
    var nameSingular;          // hover noun (singular form, used for fractional ACE too)
    var fmt;                   // value formatter for hover
    var tracksRequired = (metric !== 'genesis');  // ACE + storm-days need allTracks
    if (tracksRequired && Object.keys(allTracks).length === 0) {
        el.innerHTML = '<div style="padding:20px; opacity:0.7; font-size:0.78rem;">Loading best-track fixes…</div>';
        return;
    }
    if (metric === 'ace') {
        stats = _computeACEPerPhase();
        nameSingular = 'ACE';
        fmt = function (v) { return v.toFixed(1); };
    } else if (metric === 'days') {
        stats = _computeStormDaysPerPhase();
        nameSingular = 'Storm-days';
        fmt = function (v) { return Math.round(v).toString(); };
    } else {
        stats = _countGenesisPerPhase();
        nameSingular = 'Genesis';
        fmt = function (v) { return Math.round(v).toString(); };
    }
    var expected = act.total > 0
        ? act.perPhase.map(function (d) { return d * stats.total / act.total; })
        : [0,0,0,0,0,0,0,0];
    var labels = ['1','2','3','4','5','6','7','8'];
    var maxBar = Math.max.apply(null, stats.perPhase.concat([1]));
    var maxExp = Math.max.apply(null, expected.concat([1]));
    var rmax = Math.max(maxBar, maxExp) * 1.15;

    var ratios = stats.perPhase.map(function (c, i) {
        return expected[i] > 0 ? (c / expected[i]) : null;
    });
    var textArr = stats.perPhase.map(function (c, i) {
        var r = ratios[i];
        var rStr = (r == null) ? 'n/a' : (r >= 1 ? '+' : '') + ((r - 1) * 100).toFixed(0) + '%';
        return 'Phase ' + (i+1) + '<br>' + nameSingular + ': ' + fmt(c)
             + '<br>Expected: ' + expected[i].toFixed(1)
             + '<br>Anomaly: ' + rStr;
    });

    var traces = [
        {
            type: 'barpolar',
            r: stats.perPhase,
            theta: labels.map(function (l) { return (parseInt(l) - 1) * 45; }),
            width: Array(8).fill(40),
            marker: {
                color: stats.perPhase.map(function (c, i) {
                    var r = ratios[i];
                    if (r == null) return 'rgba(150,150,150,0.5)';
                    return r >= 1.0 ? '#ef4444' : '#60a5fa';
                }),
                line: { color: 'rgba(0,0,0,0.25)', width: 1 },
            },
            opacity: 0.85,
            hoverinfo: 'text',
            text: textArr,
            name: 'Observed ' + nameSingular.toLowerCase(),
        },
        {
            type: 'scatterpolar',
            r: expected,
            theta: labels.map(function (l) { return (parseInt(l) - 1) * 45; }),
            mode: 'lines+markers',
            line: { dash: 'dash', color: 'rgba(80,80,80,0.7)', width: 2 },
            marker: { size: 5, color: 'rgba(80,80,80,0.85)' },
            hoverinfo: 'skip',
            name: 'Expected (uniform)',
        },
    ];
    var base = _tcaPlotlyBase();
    var layout = Object.assign({}, base, {
        polar: {
            bgcolor: base.plot_bgcolor || '#0f1623',
            radialaxis: {
                range: [0, rmax],
                tickfont: { size: 10, color: base.font ? base.font.color : '#888' },
                gridcolor: 'rgba(128,128,128,0.25)',
                angle: 90, tickangle: 90,
            },
            angularaxis: {
                tickmode: 'array',
                tickvals: [0, 45, 90, 135, 180, 225, 270, 315],
                ticktext: labels,
                rotation: 90,
                direction: 'counterclockwise',
                tickfont: { size: 12, color: base.font ? base.font.color : '#888' },
                gridcolor: 'rgba(128,128,128,0.25)',
            },
        },
        showlegend: true,
        legend: { orientation: 'h', y: -0.05 },
        height: 460,
        margin: { l: 30, r: 30, t: 20, b: 90 },
    });
    delete layout.xaxis; delete layout.yaxis;
    Plotly.newPlot('sub-dial-chart', traces, layout, PLOTLY_CONFIG);

    // Dial title + help text per metric
    var titleEl = document.getElementById('sub-dial-title');
    var helpEl  = document.getElementById('sub-dial-help');
    if (titleEl) titleEl.textContent = ({
        genesis: 'TC Genesis by Phase',
        ace:     'Accumulated Cyclone Energy (ACE) by Phase',
        days:    'Storm-Days by Phase',
    })[metric];
    if (helpEl) helpEl.textContent = ({
        genesis: 'Bars show the number of named-storm genesis events whose first-fix date fell on a day of each phase (amplitude ≥ 1). Dashed ring = expected count if genesis were uniform across phases; bars outside the ring indicate enhancement, inside indicate suppression.',
        ace:     'Bars show Accumulated Cyclone Energy (Σ v² / 10⁴) over synoptic-time fixes (00/06/12/18 UTC, v ≥ 34 kt) occurring on days of each phase. ACE is intensity-weighted — a phase with fewer but stronger storms can outscore one with many weak storms. Dashed ring = expected ACE if it were uniform across phases.',
        days:    'Bars count (storm × calendar-day) pairs where the storm had any synoptic fix ≥ 34 kt that day, for days of each phase. A measure of TC persistence by phase that isn\'t intensity-weighted. Dashed ring = expected if storm-days were uniform across phases.',
    })[metric];

    // Update event count line
    var countEl = document.getElementById('sub-event-count');
    if (countEl) {
        var modeLabel = (_subPhases.indices[_subState.mode] || {}).label || _subState.mode.toUpperCase();
        var totalStr;
        if (metric === 'ace')   totalStr = stats.total.toFixed(1) + ' total ACE (10⁴ kt²)';
        else if (metric === 'days') totalStr = stats.total.toLocaleString() + ' storm-days';
        else                    totalStr = stats.total.toLocaleString() + ' named-storm genesis events';
        countEl.textContent = totalStr + ' on ' + act.total + ' active days (' + modeLabel + ')';
    }
}

function _renderIntensityDial() {
    var el = document.getElementById('sub-ri-chart');
    if (!el || typeof Plotly === 'undefined') return;
    // RI stats need the 24-h fix pairs from allTracks. If tracks haven't
    // loaded yet, show a placeholder; the panel re-renders when the
    // tracks file resolves (kicked off by _renderSubseasonal).
    if (Object.keys(allTracks).length === 0) {
        el.innerHTML = '<div style="padding:20px; opacity:0.7; font-size:0.78rem;">Loading 24-h intensity-change pairs…</div>';
        return;
    }
    var stats = _buildIntensityChangePerPhase();
    if (!stats) { el.innerHTML = ''; return; }
    var labels = ['1','2','3','4','5','6','7','8'];
    var pcts = stats.riRate.map(function (r) { return r * 100; });
    var totalRI = stats.riCount.reduce(function (a, b) { return a + b; }, 0);
    var totalN  = stats.nPerPhase.reduce(function (a, b) { return a + b; }, 0);
    var expectedPct = totalN ? (totalRI / totalN) * 100 : 0;
    var rmax = Math.max(Math.max.apply(null, pcts.concat([1])), expectedPct) * 1.2;

    var text = pcts.map(function (pct, i) {
        var anomaly = expectedPct > 0 ? (pct / expectedPct - 1) * 100 : 0;
        var sign = anomaly >= 0 ? '+' : '';
        return 'Phase ' + (i+1)
            + '<br>RI rate: ' + pct.toFixed(2) + '%'
            + '<br>(' + stats.riCount[i] + ' RI / ' + stats.nPerPhase[i] + ' intervals)'
            + '<br>Mean ΔVmax: ' + stats.meanDw[i].toFixed(2) + ' kt/24 h'
            + '<br>vs expected: ' + sign + anomaly.toFixed(0) + '%';
    });

    var traces = [
        {
            type: 'barpolar',
            r: pcts,
            theta: labels.map(function (l) { return (parseInt(l) - 1) * 45; }),
            width: Array(8).fill(40),
            marker: {
                color: pcts.map(function (pct) {
                    return pct >= expectedPct ? '#f59e0b' : '#60a5fa';
                }),
                line: { color: 'rgba(0,0,0,0.25)', width: 1 },
            },
            opacity: 0.85,
            hoverinfo: 'text',
            text: text,
            name: 'RI rate',
        },
        {
            type: 'scatterpolar',
            r: Array(8).fill(expectedPct),
            theta: labels.map(function (l) { return (parseInt(l) - 1) * 45; }),
            mode: 'lines+markers',
            line: { dash: 'dash', color: 'rgba(80,80,80,0.7)', width: 2 },
            marker: { size: 5, color: 'rgba(80,80,80,0.85)' },
            hoverinfo: 'skip',
            name: 'Expected (' + expectedPct.toFixed(1) + '%)',
        },
    ];
    var base = _tcaPlotlyBase();
    var layout = Object.assign({}, base, {
        polar: {
            bgcolor: base.plot_bgcolor || '#ffffff',
            radialaxis: {
                range: [0, rmax],
                tickfont: { size: 10, color: base.font ? base.font.color : '#888' },
                gridcolor: 'rgba(128,128,128,0.25)',
                angle: 90, tickangle: 90,
                ticksuffix: '%',
            },
            angularaxis: {
                tickmode: 'array',
                tickvals: [0, 45, 90, 135, 180, 225, 270, 315],
                ticktext: labels,
                rotation: 90,
                direction: 'counterclockwise',
                tickfont: { size: 12, color: base.font ? base.font.color : '#888' },
                gridcolor: 'rgba(128,128,128,0.25)',
            },
        },
        showlegend: true,
        legend: { orientation: 'h', y: -0.05 },
        height: 460,
        margin: { l: 30, r: 30, t: 20, b: 90 },
    });
    delete layout.xaxis; delete layout.yaxis;
    Plotly.newPlot('sub-ri-chart', traces, layout, PLOTLY_CONFIG);

    // Cache stats so the drill-in modal can pull from the same numbers.
    _subState._lastRIStats = stats;
    var hintEl = document.getElementById('sub-ri-hint');
    if (hintEl) {
        hintEl.textContent = totalN + ' overwater 24-h intervals · ' + totalRI + ' RI events';
    }
}

function _renderTrackDensity() {
    var el = document.getElementById('sub-tracks-chart');
    if (!el || typeof Plotly === 'undefined') return;
    var mm = _subState.mapMode;
    var isGenesis = (mm === 'genesis');
    var isRI      = (mm === 'ri');
    var isDw      = (mm === 'dw');
    var isAnom    = !!_subState.mapAnomaly;
    var density;
    if (isGenesis) density = _buildGenesisDensityPerPhase();
    else if (isRI) density = _buildRIDensityPerPhase();
    else if (isDw) density = _buildMeanDwPerPhase();
    else           density = _buildTrackDensityPerPhase();
    if (!density) {
        el.innerHTML = '<div style="padding:20px; opacity:0.6;">'
            + ({genesis:'Genesis data', ri:'RI data', dw:'ΔVmax data'}[mm] || 'Track data')
            + ' unavailable.</div>';
        return;
    }
    if (isAnom) density = _applyAnomalyToDensity(density, !isDw);
    // Clear any leftover loading-placeholder DIV. Plotly.newPlot manages its
    // own subtree but does not remove siblings, so a stray Loading… div from
    // _renderSubseasonal's pre-load placeholder can persist after the plot
    // mounts. Purge first, then clear, then plot.
    if (typeof Plotly.purge === 'function') Plotly.purge(el);
    el.innerHTML = '';
    var base = _tcaPlotlyBase();
    var traces = [];
    // Adaptive layout: 2 rows × 4 cols at desktop width, 4 rows × 2 cols when
    // narrower. Equirectangular maps clipped to ±45° lat have a 4:1 aspect
    // ratio, so each panel's vertical space is mostly wasted unless we size
    // the height proportionally to the panel width.
    var containerW = el.offsetWidth || 1100;
    var nCols = containerW < 720 ? 2 : 4;
    var nRows = 8 / nCols;
    // Aim ~3.6:1 map aspect so the panel is mostly map with a tiny title strip.
    var panelW = (containerW - 16) / nCols;
    var mapH   = panelW / 3.6;
    var totalH = Math.round(nRows * mapH + 28 * nRows + 20);
    var layout = Object.assign({}, base, {
        height: totalH,
        margin: { l: 4, r: 4, t: 6, b: 6 },
        showlegend: false,
        annotations: [],
    });
    delete layout.xaxis; delete layout.yaxis;

    for (var p = 1; p <= 8; p++) {
        var col = (p - 1) % nCols;
        var row = Math.floor((p - 1) / nCols);
        var xDom = [col / nCols + 0.003, (col + 1) / nCols - 0.003];
        var yDom = [1 - (row + 1) / nRows + 0.02, 1 - row / nRows - 0.02];
        var geoKey = (p === 1) ? 'geo' : ('geo' + p);
        layout[geoKey] = {
            domain: { x: xDom, y: yDom },
            projection: { type: 'equirectangular' },
            showcoastlines: true,
            coastlinecolor: 'rgba(120,120,120,0.55)',
            coastlinewidth: 0.6,
            showland: true,
            landcolor: 'rgba(40,50,60,0.18)',
            showocean: true,
            oceancolor: 'rgba(0,0,0,0)',
            bgcolor: 'rgba(0,0,0,0)',
            showframe: false,
            framewidth: 0,
            lataxis: { range: [-45, 45], showgrid: false },
            lonaxis: { range: [-180, 180], showgrid: false },
        };
        // Label as in-map annotation top-left, not above (saves vertical space).
        layout.annotations.push({
            text: '<b>Phase ' + p + '</b>',
            showarrow: false,
            xref: 'paper', yref: 'paper',
            x: xDom[0] + 0.005,
            y: yDom[1] - 0.005,
            xanchor: 'left', yanchor: 'top',
            font: { size: 11, color: base.font ? base.font.color : '#fff' },
            bgcolor: 'rgba(255,255,255,0.6)',
            borderpad: 2,
        });
        var cells = density[p - 1];
        if (!cells.cnts.length) continue;
        var colorscale, color, cmin, cmax, hoverText;
        if (isAnom) {
            // Diverging palette anchored at 0. Use per-mode symmetric range
            // calibrated to the cross-panel max-abs so all 8 phases share a
            // colorbar — phase-to-phase comparisons stay honest.
            var absMax = 0;
            for (var pp = 0; pp < 8; pp++) {
                var ca = density[pp].cnts;
                for (var ii = 0; ii < ca.length; ii++) {
                    var av = Math.abs(ca[ii]);
                    if (av > absMax) absMax = av;
                }
            }
            if (absMax === 0) absMax = 1;                       // degenerate
            color = cells.cnts;
            cmin = -absMax; cmax = absMax;
            colorscale = [
                [0.00, 'rgba(30,64,175,0.95)'],
                [0.30, 'rgba(96,165,250,0.70)'],
                [0.48, 'rgba(220,220,220,0.45)'],
                [0.52, 'rgba(220,220,220,0.45)'],
                [0.70, 'rgba(251,191,36,0.80)'],
                [1.00, 'rgba(220,38,38,0.95)'],
            ];
            var unitForMode = (isDw ? ' kt/24 h' : '');
            hoverText = cells.cnts.map(function (v) {
                var sign = v >= 0 ? '+' : '';
                return sign + v.toFixed(isDw ? 1 : 2) + unitForMode + ' vs phase mean';
            });
        } else if (isDw) {
            // Diverging scale anchored at 0 kt. Range ±15 kt/24h covers
            // typical means; clamp outliers visually.
            var maxAbs = 15;
            color = cells.cnts.map(function (v) { return v; });
            cmin = -maxAbs; cmax = maxAbs;
            colorscale = [
                [0.00, 'rgba(30,64,175,0.95)'],   // strong weakening
                [0.30, 'rgba(96,165,250,0.75)'],
                [0.48, 'rgba(220,220,220,0.55)'], // near-zero
                [0.52, 'rgba(220,220,220,0.55)'],
                [0.70, 'rgba(251,191,36,0.80)'],
                [1.00, 'rgba(220,38,38,0.95)'],   // strong intensification
            ];
            hoverText = cells.cnts.map(function (v) {
                return (v >= 0 ? '+' : '') + v.toFixed(1) + ' kt/24 h (mean)';
            });
        } else {
            var max = Math.max.apply(null, cells.cnts);
            color = cells.cnts.map(function (c) { return c / max; });
            cmin = 0; cmax = 1;
            if (isGenesis) {
                colorscale = [
                    [0,    'rgba(168,139,250,0.0)'],
                    [0.15, 'rgba(168,139,250,0.65)'],
                    [0.40, 'rgba(52,211,153,0.80)'],
                    [0.70, 'rgba(251,191,36,0.88)'],
                    [1.0,  'rgba(220,38,38,0.95)'],
                ];
            } else if (isRI) {
                // Red-orange palette so RI events read as "hot spots"
                colorscale = [
                    [0,    'rgba(251,146,60,0.0)'],
                    [0.15, 'rgba(251,146,60,0.70)'],
                    [0.40, 'rgba(248,113,113,0.85)'],
                    [0.70, 'rgba(220,38,38,0.92)'],
                    [1.0,  'rgba(127,29,29,0.98)'],
                ];
            } else {
                colorscale = [
                    [0,    'rgba(96,165,250,0.0)'],
                    [0.15, 'rgba(96,165,250,0.55)'],
                    [0.40, 'rgba(251,191,36,0.75)'],
                    [0.70, 'rgba(248,113,113,0.85)'],
                    [1.0,  'rgba(220,38,38,0.95)'],
                ];
            }
            hoverText = cells.cnts.map(function (c) {
                if (isGenesis) return c + ' ' + (c === 1 ? 'genesis' : 'geneses');
                if (isRI)      return c + ' RI event' + (c === 1 ? '' : 's');
                return c + ' fix' + (c === 1 ? '' : 'es');
            });
        }
        traces.push({
            type: 'scattergeo',
            geo: (p === 1) ? 'geo' : ('geo' + p),
            mode: 'markers',
            lat: cells.lats,
            lon: cells.lons,
            marker: {
                color: color,
                colorscale: colorscale,
                cmin: cmin, cmax: cmax,
                size: 8, symbol: 'square',
                line: { width: 0 },
                showscale: false,
            },
            text: hoverText,
            hoverinfo: 'lon+lat+text',
            showlegend: false,
        });
    }
    Plotly.newPlot('sub-tracks-chart', traces, layout, PLOTLY_CONFIG);

    // Hook click → open the phase drill-in modal. Plotly's plotly_click
    // event fires per trace, not per subplot, so the trace index (one
    // trace per phase) is the natural phase indicator. Empty phases that
    // got no trace are skipped — clicking on the basemap of an empty
    // panel won't open the modal, but that's an acceptable edge.
    if (el.on) {
        el.removeAllListeners && el.removeAllListeners('plotly_click');
        el.on('plotly_click', function (ev) {
            if (!ev || !ev.points || !ev.points.length) return;
            var traceIdx = ev.points[0].curveNumber;
            // traces array order matches phases that had data; resolve to
            // the source phase via the trace's geo axis ("geo" → 1,
            // "geo2" → 2, …).
            var geoName = ev.points[0].data && ev.points[0].data.geo;
            var phase = (geoName === 'geo') ? 1 : parseInt(geoName.replace('geo', ''), 10);
            if (phase >= 1 && phase <= 8) _openPhaseModal(phase);
        });
    }
}

// ── Public re-renderer (called by UI events) ────────────────────
function _renderSubseasonal() {
    if (!_subPhases || !_subPhases.indices[_subState.mode]) return;
    _renderActivityDial();
    _updateMapPanelText();
    var isGenesis = (_subState.mapMode === 'genesis');
    var tracksEl = document.getElementById('sub-tracks-chart');
    // The RI panel and the Tracks map both need the 6-hourly fixes file.
    // The genesis dial and the genesis-density map use storm metadata
    // (already loaded). The RI panel always needs tracks, so we kick the
    // lazy load unconditionally on first visit regardless of mapMode.
    if (Object.keys(allTracks).length === 0) {
        if (tracksEl && !isGenesis) tracksEl.innerHTML =
            '<div style="padding:20px; opacity:0.7; font-size:0.78rem;">Loading 6-hourly best-track fixes (~44 MB, one-time)…</div>';
        _renderIntensityDial();      // shows its own loading placeholder
        // Render the genesis-density map immediately if that's the active
        // mapMode — it only needs storm metadata.
        if (isGenesis) {
            _ensureStormBySid();
            _renderTrackDensity();
        }
        _ensureTracksLoaded().then(function () {
            _ensureStormBySid();
            _renderTrackDensity();
            _renderIntensityDial();
            // Re-render the activity dial — ACE and storm-days metrics
            // need the tracks file that just arrived.
            if (_subState.dialMetric !== 'genesis') _renderActivityDial();
        });
    } else {
        _ensureStormBySid();
        _renderTrackDensity();
        _renderIntensityDial();
    }
    _renderSubseasonalSource();
    _renderSubseasonalNowWidget();
}

function _updateMapPanelText() {
    var titleEl = document.getElementById('sub-tracks-title');
    var helpEl  = document.getElementById('sub-tracks-help');
    var mm = _subState.mapMode;
    var isAnom = !!_subState.mapAnomaly;
    var title, help;
    if (mm === 'genesis') {
        title = 'Genesis Point Density by Phase';
        help  = 'Each panel shows where named-storm genesis events (first fix, peak ≥ 34 kt) occurred on days of that phase. One point per storm. Density is normalized per panel, so the warmest cell shows the relative concentration of genesis locations regardless of phase-day count.';
    } else if (mm === 'ri') {
        title = 'RI Event Density by Phase';
        help  = 'Each panel shows where 24-h RI events (ΔVmax ≥ 30 kt) started, on days of each phase. Uses the same Overwater / TC-phase / Vmax filters as the RI dial — hot spots reveal favored RI corridors for each phase.';
    } else if (mm === 'dw') {
        title = 'Mean 24-h ΔVmax by Phase';
        help  = 'Each panel shows the mean signed 24-h ΔVmax per 5° bin (cells with < 5 intervals are masked). Diverging colormap: blue = systematic weakening, red = systematic intensification. Reveals whether a phase tilts the intensity tendency in a region toward growth or decay.';
    } else {
        title = 'Track-Point Density by Phase';
        help  = 'Each panel shows the spatial density of 6-hourly best-track fixes (≥ 34 kt) occurring on days of that phase. Density is normalized per panel so the warmest cell in each phase shows the relative concentration regardless of phase-day count.';
    }
    if (isAnom) {
        title = 'Anomaly: ' + title.replace(' by Phase', '') + ' (vs cross-phase mean)';
        help = 'Each panel shows the per-cell anomaly: (this-phase value) − (mean across all 8 phases). Diverging colormap: red = above the cross-phase mean (this phase is enhanced at that cell), blue = below (suppressed). Color range is symmetric and shared across panels for honest phase-to-phase comparison.';
    }
    if (titleEl) titleEl.textContent = title;
    if (helpEl)  helpEl.textContent  = help;
}

// ── "Current state" phase-clock widget ─────────────────────────
// Four phase clocks (MJO RMM / ROMI / BSISO1 / BSISO2) rendered side
// by side using the shared SubseasonalClock module — same layout the
// RT Monitor's Subseasonal tab uses. Each card has a save button
// (snapshot PNG) and a click handler that opens the full phase
// evolution modal for THAT mode.
function _renderSubseasonalNowWidget() {
    if (!_subPhases || !_subPhases.indices || !window.SubseasonalClock) return;
    var modes = ['mjo', 'mjo_omi', 'bsiso1', 'bsiso2'];
    modes.forEach(function (mode) {
        var card = document.querySelector(
            '#sub-now-clock-grid .sub-clock-card[data-mode="' + mode + '"]');
        if (!card) return;
        var svg = card.querySelector('.sub-clock-svg');
        var modeRec = _subPhases.indices[mode];
        if (!svg || !modeRec) return;
        window.SubseasonalClock.render({
            svg: svg,
            modeRec: modeRec,
            mode: mode,
            trailDays: 14,
            size: 110,
            labels: {
                dateEl:   card.querySelector('[data-val="date"]'),
                phaseEl:  card.querySelector('[data-val="phase"]'),
                ampEl:    card.querySelector('[data-val="amp"]'),
                statusEl: card.querySelector('[data-val="status"]'),
            },
        });
        // Inject save button once. stopPropagation so the click
        // doesn't bubble to the card-level "open evolution modal"
        // handler.
        if (!card.querySelector('.sub-clock-save-btn')) {
            var sBtn = document.createElement('button');
            sBtn.type = 'button';
            sBtn.className = 'sub-clock-save-btn';
            sBtn.title = 'Save this phase diagram as PNG';
            sBtn.setAttribute('aria-label', 'Save phase diagram');
            sBtn.innerHTML = '⤓';
            sBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                _saveClimoClockAsPNG(card, mode);
            });
            card.appendChild(sBtn);
        }
        // Card click opens the evolution modal for THIS mode.
        card.onclick = function () {
            _subState.mode = mode;
            _openSubEvolution();
            try { if (typeof gtag === 'function') {
                gtag('event', 'tc_clim_sub_clock_click', { mode: mode });
            } } catch (e) {}
        };
    });
}

/* ── Per-clock PNG save on the climo page ─────────────────────
   Mirrors realtime_subseasonal.js:_saveClockAsPNG. Self-contained
   so the climo page doesn't need to reach into RT Monitor JS. */
function _saveClimoClockAsPNG(card, mode) {
    if (!card) return;
    var svg = card.querySelector('.sub-clock-svg');
    if (!svg) return;
    try { if (typeof gtag === 'function') {
        gtag('event', 'tc_clim_sub_save_png_clock', { mode: mode });
    } } catch (e) {}

    var modeLabel = (card.querySelector('.sub-clock-mode') || {}).textContent || mode;
    var dateText   = (card.querySelector('[data-val="date"]')   || {}).textContent || '';
    var phaseText  = (card.querySelector('[data-val="phase"]')  || {}).textContent || '';
    var ampText    = (card.querySelector('[data-val="amp"]')    || {}).textContent || '';
    var statusText = (card.querySelector('[data-val="status"]') || {}).textContent || '';

    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var pageBg = isDark ? '#0f172a' : '#ffffff';
    var cardBg = isDark ? '#161b24' : '#ffffff';
    var textColor = isDark ? '#e2e8f0' : '#0f172a';
    var dimColor  = isDark ? '#94a3b8' : '#64748b';

    var SVG_PX = 110, SCALE = 2;
    var clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width',  String(SVG_PX));
    clone.setAttribute('height', String(SVG_PX));
    var serialized = new XMLSerializer().serializeToString(clone);
    var svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
    var svgUrl  = URL.createObjectURL(svgBlob);

    var img = new Image();
    img.onload = function () {
        var W = 340, titleH = 42, padX = 18;
        var clockY = titleH + 6, clockSize = SVG_PX;
        var clockX = (W - clockSize) / 2;
        var readoutY = clockY + clockSize + 10;
        var lineH = 18;
        var lines = [
            'Date:  ' + dateText,
            'Phase: ' + phaseText + '   ·   Amp: ' + ampText,
            statusText || '',
        ];
        var bodyH = lines.length * lineH;
        var footerH = 32;
        var H = readoutY + bodyH + 14 + footerH;

        var canvas = document.createElement('canvas');
        canvas.width  = W * SCALE;
        canvas.height = H * SCALE;
        var ctx = canvas.getContext('2d');
        ctx.scale(SCALE, SCALE);

        ctx.fillStyle = pageBg;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = cardBg;
        ctx.fillRect(8, 8, W - 16, H - 16);

        ctx.fillStyle = textColor;
        ctx.font = 'bold 15px "DM Sans", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(modeLabel + ' · Phase Clock', padX, titleH / 2 + 6);

        ctx.drawImage(img, clockX, clockY, clockSize, clockSize);

        ctx.font = '12px "DM Sans", system-ui, sans-serif';
        ctx.textBaseline = 'top';
        lines.forEach(function (txt, i) {
            if (!txt) return;
            ctx.fillStyle = (i === 2) ? dimColor : textColor;
            ctx.fillText(txt, padX, readoutY + i * lineH);
        });

        ctx.fillStyle = dimColor;
        ctx.font = '11px "DM Sans", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        var todayISO = new Date().toISOString().slice(0, 10);
        ctx.fillText('TC-ATLAS · ' + todayISO + ' · michaelfischerwx.github.io/TC-ATLAS',
                     padX, H - footerH / 2 - 4);

        canvas.toBlob(function (blob) {
            var u = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = u;
            a.download = 'tc-atlas-phaseclock-' + mode + '-' + todayISO + '.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () {
                URL.revokeObjectURL(u);
                URL.revokeObjectURL(svgUrl);
            }, 1000);
        }, 'image/png');
    };
    img.onerror = function () {
        URL.revokeObjectURL(svgUrl);
        console.error('[tc-clim-sub] clock SVG rasterization failed');
    };
    img.src = svgUrl;
}

// ── Phase Evolution modal ───────────────────────────────────────
// Larger interactive Wheeler-Hendon phase diagram showing the active
// mode's PC1/PC2 trajectory over a configurable lookback window. Opens
// from clicking the small phase-clock widget. Uses PC1/PC2 directly
// from subseasonal_phases.json (added 2026-05-17 — earlier versions
// only had derived phase + amplitude).
var _subEvoWindow = 30;

// Historical overlay window, e.g. {start: '1997-03-01', end: '1997-06-30'}.
// When non-null, _renderSubEvolution draws a second trajectory on the
// same phase diagram so users can compare the recent evolution against
// an analog historical period.
var _subEvoHistorical = null;

// Quick-pick preset date ranges for the historical overlay. Tuned to
// canonical MJO / climate-mode regimes that show up repeatedly in TC
// research conversations. Easy to extend without breaking the layout.
var _SUB_EVO_HIST_PRESETS = {
    '1997-mam':  { start: '1997-03-01', end: '1997-06-30' },
    '2015-djf':  { start: '2015-11-01', end: '2016-02-29' },
    '2010-jas':  { start: '2010-07-01', end: '2010-09-30' },
    '2017-aso':  { start: '2017-08-01', end: '2017-10-31' },
};

window.closeSubEvolutionModal = function () {
    var m = document.getElementById('sub-evolution-modal');
    if (m) m.style.display = 'none';
};

// Iframe-friendly entry point used by the RT Monitor's Subseasonal tab.
// _subPhases loads async after _initSubseasonalOnce kicks off the
// fetch, so this polls until the data is ready before opening the
// modal. Gives up after ~6s — the modal silently no-ops in that case.
window._openSubEvolutionFromHash = function (attempts) {
    attempts = attempts || 0;
    if (_subPhases && _subPhases.indices && _subPhases.indices[_subState.mode]) {
        _openSubEvolution();
        return;
    }
    if (attempts > 60) return;       // ~6s ceiling
    setTimeout(function () { window._openSubEvolutionFromHash(attempts + 1); }, 100);
};

function _openSubEvolution() {
    if (!_subPhases || !_subPhases.indices[_subState.mode]) return;
    var m = document.getElementById('sub-evolution-modal');
    if (!m) return;
    // Sync the historical-overlay date inputs to the active mode's
    // coverage window each time the modal opens; keeps users from
    // picking a date the record doesn't cover (e.g. 1975 for BSISO,
    // which starts in 1981).
    var rec = _subPhases.indices[_subState.mode];
    var hs = document.getElementById('sub-evo-hist-start');
    var he = document.getElementById('sub-evo-hist-end');
    if (hs) { hs.min = rec.start_date; hs.max = rec.end_date; }
    if (he) { he.min = rec.start_date; he.max = rec.end_date; }
    if (_subEvoHistorical) {
        if (hs) hs.value = _subEvoHistorical.start;
        if (he) he.value = _subEvoHistorical.end;
    }
    m.style.display = 'flex';
    _renderSubEvolution();
    _wireSubEvoSaveButtons();
    _ga('tc_clim_sub_evolution_open', { mode: _subState.mode, window: _subEvoWindow });
}

// Build a per-window slice of (date, PC1, PC2, amp, phase) values from
// a phase-index record. `startIdx`/`endIdx` are inclusive array indices.
// Skips entries where PC1 or PC2 is null (sparse coverage at start of
// record). Returns null if no valid samples in the window.
function _buildEvoSeries(rec, startIdx, endIdx) {
    var pc1 = rec.pc1, pc2 = rec.pc2;
    var phases = rec.phases, amps = rec.amplitudes;
    if (rec._startKey == null) rec._startKey = _dayKeyFromISO(rec.start_date);
    var startKey = rec._startKey;
    var dates = [], xs = [], ys = [], amplitudes = [], phasesArr = [];
    for (var i = startIdx; i <= endIdx; i++) {
        if (pc1[i] == null || pc2[i] == null) continue;
        var dt = new Date((startKey + i) * 86400000);
        dates.push(dt.toISOString().slice(0, 10));
        xs.push(pc1[i]);
        ys.push(pc2[i]);
        amplitudes.push(amps[i]);
        phasesArr.push(phases[i]);
    }
    if (!xs.length) return null;
    return { dates: dates, xs: xs, ys: ys, amplitudes: amplitudes, phasesArr: phasesArr };
}

function _renderSubEvolution() {
    var rec = _subPhases.indices[_subState.mode];
    if (!rec || !rec.pc1) return;                              // older JSON without PC1/PC2
    var titleEl = document.getElementById('sub-evolution-title');
    var subEl   = document.getElementById('sub-evolution-sub');
    var pcEl    = document.getElementById('sub-evolution-pc-chart');
    var ampEl   = document.getElementById('sub-evolution-amp-chart');
    if (!titleEl || !pcEl || !ampEl || typeof Plotly === 'undefined') return;

    // Find last non-null index, then walk back lookback days
    var phases = rec.phases;
    var lastIdx = phases.length - 1;
    while (lastIdx >= 0 && phases[lastIdx] == null) lastIdx--;
    if (lastIdx < 0) return;
    var startIdx = Math.max(0, lastIdx - _subEvoWindow + 1);
    if (rec._startKey == null) rec._startKey = _dayKeyFromISO(rec.start_date);

    var recent = _buildEvoSeries(rec, startIdx, lastIdx);
    if (!recent) return;
    var dates = recent.dates, xs = recent.xs, ys = recent.ys;
    var amplitudes = recent.amplitudes, phasesArr = recent.phasesArr;

    // Historical overlay (optional). Date inputs are clamped to the
    // record's coverage; out-of-range silently degrades to "no overlay".
    var hist = null;
    if (_subEvoHistorical && _subEvoHistorical.start && _subEvoHistorical.end) {
        var hStartKey = _dayKeyFromISO(_subEvoHistorical.start);
        var hEndKey   = _dayKeyFromISO(_subEvoHistorical.end);
        var hStartIdx = hStartKey - rec._startKey;
        var hEndIdx   = hEndKey   - rec._startKey;
        // Clamp to in-range; reject if the user picked end < start.
        hStartIdx = Math.max(0, hStartIdx);
        hEndIdx   = Math.min(phases.length - 1, hEndIdx);
        if (hEndIdx >= hStartIdx) {
            hist = _buildEvoSeries(rec, hStartIdx, hEndIdx);
        }
    }

    titleEl.textContent = rec.label + ' · Phase Evolution';
    var subText = 'Last ' + xs.length + ' days · '
        + dates[0] + ' to ' + dates[dates.length - 1]
        + ' · current phase ' + phasesArr[phasesArr.length - 1]
        + ' (amp ' + amplitudes[amplitudes.length - 1].toFixed(2) + ')';
    if (hist) {
        subText += '<br><span style="color:#f59e0b;">Historical overlay:</span> '
                + hist.xs.length + ' days · '
                + hist.dates[0] + ' to ' + hist.dates[hist.dates.length - 1];
    }
    subEl.innerHTML = subText;

    // ── Phase diagram (PC1, PC2) ──
    var base = _tcaPlotlyBase();
    // Expand rmax to enclose both recent and historical extrema so the
    // diagram doesn't clip the analog window.
    var extrema = xs.map(Math.abs).concat(ys.map(Math.abs));
    if (hist) extrema = extrema.concat(hist.xs.map(Math.abs)).concat(hist.ys.map(Math.abs));
    var rmax = Math.max(3.5, Math.max.apply(null, extrema) * 1.1);

    // Annotations: phase numbers + region labels in each sector
    var modeStr = _subState.mode;
    var regions = (modeStr === 'mjo' || modeStr === 'mjo_omi') ? {
        1: 'W Hem / Africa', 2: 'Indian Ocean', 3: 'Indian Ocean',
        4: 'Maritime Continent', 5: 'Maritime Continent', 6: 'W Pacific',
        7: 'W Pacific / W Hem', 8: 'W Hem',
    } : {
        1: 'Indian Ocean', 2: 'Eastern IO', 3: 'BoB / Maritime',
        4: 'WPac / Philippines', 5: 'WPac', 6: 'Subtropical WPac',
        7: 'NIO / Arabian', 8: 'Africa / IO',
    };
    var annotations = [];
    var sectorR = rmax * 0.86;
    for (var p = 1; p <= 8; p++) {
        var ang = ((p - 1) * 45 - 180 + 22.5) * Math.PI / 180;
        annotations.push({
            x: sectorR * Math.cos(ang),
            y: sectorR * Math.sin(ang),
            xref: 'x', yref: 'y',
            text: '<b>' + p + '</b><br><span style="font-size:0.75em; opacity:0.6;">'
                + regions[p] + '</span>',
            showarrow: false,
            font: { size: 13, color: base.font ? base.font.color : '#475569' },
            opacity: 0.7,
            align: 'center',
        });
    }

    // Sector dividers + unit circle as shapes (drawn behind traces)
    var shapes = [];
    for (var sp = 0; sp < 8; sp++) {
        var a = (sp * 45 - 180) * Math.PI / 180;
        shapes.push({
            type: 'line',
            x0: 0, y0: 0,
            x1: rmax * Math.cos(a), y1: rmax * Math.sin(a),
            line: { color: 'rgba(120,120,120,0.35)', width: 0.6 },
            layer: 'below',
        });
    }
    // Unit circle (amp=1)
    shapes.push({
        type: 'circle', xref: 'x', yref: 'y',
        x0: -1, y0: -1, x1: 1, y1: 1,
        line: { color: 'rgba(120,120,120,0.6)', width: 1, dash: 'dash' },
        layer: 'below',
    });
    // Bounding box (rmax circle)
    shapes.push({
        type: 'circle', xref: 'x', yref: 'y',
        x0: -rmax, y0: -rmax, x1: rmax, y1: rmax,
        line: { color: 'rgba(120,120,120,0.45)', width: 0.6 },
        layer: 'below',
    });

    // Color by recency: oldest = light gray, newest = saturated red
    var n = xs.length;
    var colors = xs.map(function (_, i) {
        return i / Math.max(1, n - 1);                 // 0..1
    });
    var hoverText = xs.map(function (_, i) {
        var sign = amplitudes[i] >= 1 ? '✓ active' : '○ quiescent';
        return dates[i]
            + '<br>Phase ' + phasesArr[i]
            + '<br>PC1=' + xs[i].toFixed(2) + ', PC2=' + ys[i].toFixed(2)
            + '<br>amp=' + amplitudes[i].toFixed(2) + ' (' + sign + ')';
    });

    var trace_line = {
        type: 'scatter', mode: 'lines',
        x: xs, y: ys,
        line: { color: 'rgba(46,125,255,0.55)', width: 2 },
        hoverinfo: 'skip',
        name: 'Track',
    };
    var trace_markers = {
        type: 'scatter', mode: 'markers',
        x: xs, y: ys,
        marker: {
            size: xs.map(function (_, i) { return i === n - 1 ? 14 : 8; }),
            color: colors,
            colorscale: [
                [0,    'rgba(200,210,220,0.85)'],
                [0.6,  'rgba(96,165,250,0.95)'],
                [1.0,  'rgba(220,38,38,1.0)'],
            ],
            line: { color: '#0f172a', width: 1 },
            showscale: false,
        },
        text: hoverText,
        hoverinfo: 'text',
        name: 'Daily PCs',
    };
    var trace_today = {
        type: 'scatter', mode: 'markers+text',
        x: [xs[n - 1]], y: [ys[n - 1]],
        marker: { size: 18, color: 'rgba(220,38,38,0.05)', line: { color: '#dc2626', width: 2.5 } },
        text: ['TODAY'],
        textposition: 'top center',
        textfont: { size: 10, color: '#dc2626' },
        hoverinfo: 'skip',
        showlegend: false,
    };

    // ── Historical analog traces (amber → magenta gradient) ──
    // Visually distinct from the recent series' blue→red palette so
    // overlapping segments stay legible. The amber line is drawn below
    // the recent line to keep "today" the visual focus.
    var trace_hist_line = null, trace_hist_markers = null, trace_hist_start = null;
    if (hist) {
        var hn = hist.xs.length;
        var hColors = hist.xs.map(function (_, i) { return i / Math.max(1, hn - 1); });
        var hHover = hist.xs.map(function (_, i) {
            var sign = hist.amplitudes[i] >= 1 ? '✓ active' : '○ quiescent';
            return '[historical] ' + hist.dates[i]
                + '<br>Phase ' + hist.phasesArr[i]
                + '<br>PC1=' + hist.xs[i].toFixed(2) + ', PC2=' + hist.ys[i].toFixed(2)
                + '<br>amp=' + hist.amplitudes[i].toFixed(2) + ' (' + sign + ')';
        });
        trace_hist_line = {
            type: 'scatter', mode: 'lines',
            x: hist.xs, y: hist.ys,
            line: { color: 'rgba(245,158,11,0.55)', width: 2, dash: 'dot' },
            hoverinfo: 'skip',
            name: 'Historical track',
        };
        trace_hist_markers = {
            type: 'scatter', mode: 'markers',
            x: hist.xs, y: hist.ys,
            marker: {
                size: 7,
                color: hColors,
                colorscale: [
                    [0,    'rgba(254,243,199,0.85)'],   // pale amber
                    [0.6,  'rgba(245,158,11,0.95)'],    // amber
                    [1.0,  'rgba(168,85,247,1.0)'],     // purple
                ],
                line: { color: '#1e1b4b', width: 1 },
                symbol: 'diamond',
                showscale: false,
            },
            text: hHover,
            hoverinfo: 'text',
            name: 'Historical PCs',
        };
        trace_hist_start = {
            type: 'scatter', mode: 'markers+text',
            x: [hist.xs[0]], y: [hist.ys[0]],
            marker: { size: 14, color: 'rgba(245,158,11,0.0)',
                      line: { color: '#f59e0b', width: 2 }, symbol: 'diamond' },
            text: [hist.dates[0].slice(0, 7)],
            textposition: 'bottom center',
            textfont: { size: 9, color: '#f59e0b' },
            hoverinfo: 'skip',
            showlegend: false,
        };
    }
    var layout = Object.assign({}, base, {
        xaxis: {
            title: 'PC1 (eastward propagation →)',
            range: [-rmax, rmax],
            zeroline: true, zerolinecolor: 'rgba(0,0,0,0.4)',
            gridcolor: 'rgba(200,200,200,0.3)',
            constrain: 'domain',
        },
        yaxis: {
            title: 'PC2',
            range: [-rmax, rmax],
            zeroline: true, zerolinecolor: 'rgba(0,0,0,0.4)',
            gridcolor: 'rgba(200,200,200,0.3)',
            scaleanchor: 'x', scaleratio: 1,
        },
        shapes: shapes,
        annotations: annotations,
        showlegend: false,
        height: 480,
        margin: { l: 60, r: 30, t: 10, b: 50 },
    });
    // Draw recent line + markers first (under), then historical (over
    // them), then TODAY marker on the very top. Click-drill is wired to
    // the recent "Daily PCs" trace only; historical markers are
    // informational hover-only.
    var pcTraces = [trace_line, trace_markers];
    if (hist) pcTraces.push(trace_hist_line, trace_hist_markers, trace_hist_start);
    pcTraces.push(trace_today);
    Plotly.newPlot('sub-evolution-pc-chart', pcTraces, layout, PLOTLY_CONFIG);

    // Click → drill the matching phase modal. The recent "Daily PCs"
    // trace is the second one (curveNumber === 1); ignore clicks on
    // historical markers since drilling a phase composite from an
    // analog year is conceptually different from drilling the
    // climatology of that phase.
    var pcChart = document.getElementById('sub-evolution-pc-chart');
    if (pcChart && pcChart.on) {
        pcChart.removeAllListeners && pcChart.removeAllListeners('plotly_click');
        pcChart.on('plotly_click', function (ev) {
            if (!ev || !ev.points || !ev.points.length) return;
            var pt = ev.points[0];
            if (pt.curveNumber !== 1) return;             // only recent markers
            var idx = pt.pointIndex;
            if (typeof idx !== 'number') return;
            var phase = phasesArr[idx];
            if (phase >= 1 && phase <= 8) {
                window.closeSubEvolutionModal();
                _openPhaseModal(phase);
            }
        });
    }

    // ── Amplitude time series ──
    // When a historical overlay is active we switch the x-axis to a
    // day-index (Day 0 = start of each window) so the two series line
    // up directly; that's the natural visualization for analog
    // comparison. Otherwise we keep the calendar-date x-axis (which is
    // the better default for the standalone "recent evolution" view).
    var ampLayout = Object.assign({}, base, {
        height: 220,
        margin: { l: 50, r: 30, t: 10, b: 40 },
        xaxis: {
            title: hist ? 'Days from window start' : '',
            tickfont: { size: 10 },
        },
        yaxis: { title: 'Amplitude', rangemode: 'tozero' },
        shapes: [{
            type: 'line', xref: 'paper', yref: 'y',
            x0: 0, x1: 1, y0: 1, y1: 1,
            line: { color: '#dc2626', width: 1.2, dash: 'dash' },
        }],
        annotations: [{
            x: 0.99, y: 1.05, xref: 'paper', yref: 'y',
            text: 'active threshold', showarrow: false,
            font: { size: 9, color: '#dc2626' },
            xanchor: 'right',
        }],
        showlegend: !!hist,
        legend: { orientation: 'h', y: -0.15, font: { size: 10 } },
    });
    var ampX = hist
        ? amplitudes.map(function (_, i) { return i; })
        : dates;
    var ampTrace = {
        type: 'scatter', mode: 'lines+markers',
        x: ampX, y: amplitudes,
        line: { color: 'rgba(46,125,255,0.7)', width: 2 },
        marker: {
            size: 6,
            color: amplitudes.map(function (a) { return a >= 1 ? '#ef4444' : '#94a3b8'; }),
            line: { color: '#0f172a', width: 0.5 },
        },
        text: dates.map(function (d, i) {
            return d + '<br>amp ' + amplitudes[i].toFixed(2) + ' · phase ' + phasesArr[i];
        }),
        hoverinfo: 'text',
        name: 'Recent (' + dates[0] + ' → ' + dates[dates.length - 1] + ')',
    };
    var ampTraces = [ampTrace];
    if (hist) {
        ampTraces.push({
            type: 'scatter', mode: 'lines+markers',
            x: hist.amplitudes.map(function (_, i) { return i; }),
            y: hist.amplitudes,
            line: { color: 'rgba(245,158,11,0.85)', width: 2, dash: 'dot' },
            marker: {
                size: 6, symbol: 'diamond',
                color: hist.amplitudes.map(function (a) {
                    return a >= 1 ? '#f59e0b' : '#cbd5e1';
                }),
                line: { color: '#1e1b4b', width: 0.5 },
            },
            text: hist.dates.map(function (d, i) {
                return d + '<br>amp ' + hist.amplitudes[i].toFixed(2)
                     + ' · phase ' + hist.phasesArr[i];
            }),
            hoverinfo: 'text',
            name: 'Historical (' + hist.dates[0] + ' → ' + hist.dates[hist.dates.length - 1] + ')',
        });
    }
    Plotly.newPlot('sub-evolution-amp-chart', ampTraces, ampLayout, PLOTLY_CONFIG);
}

/* ── Phase-evolution PNG saves ─────────────────────────────────
   The PC and amplitude charts in the Phase Evolution modal each
   get a Save PNG button. We rasterize the live Plotly state — so
   if the user has applied a historical year overlay, the saved
   PNG includes both the recent trace and the analog trace exactly
   as displayed. Output is composited with a title bar (mode +
   window + overlay note) and a TC-ATLAS footer for attribution. */
function _slugSubPhase(s) {
    return (s || 'panel').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function _subEvoSubtitleText() {
    // Recover the same descriptive line shown above the chart so
    // the saved PNG carries the same date range / overlay context
    // without having to recompute it.
    var subEl = document.getElementById('sub-evolution-sub');
    if (!subEl) return '';
    // innerHTML uses a <br> for the overlay line; collapse to " — ".
    var html = subEl.innerHTML || '';
    var tmp = document.createElement('div');
    tmp.innerHTML = html.replace(/<br\s*\/?>/gi, ' — ');
    return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
}

function _saveSubEvoChart(chartId, chartLabel, btnId) {
    var chart = document.getElementById(chartId);
    if (!chart || typeof Plotly === 'undefined') return;
    var btn = btnId ? document.getElementById(btnId) : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Rendering…'; }

    try { if (typeof gtag === 'function') {
        gtag('event', 'tc_clim_sub_evo_save_png',
             { chart: chartId, mode: _subState && _subState.mode });
    } } catch (e) {}

    var rec = (_subPhases && _subPhases.indices[_subState.mode]) || {};
    var modeLabel = rec.label || (_subState && _subState.mode) || 'Subseasonal';
    var subtitle  = _subEvoSubtitleText();

    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var pageBg = isDark ? '#0f172a' : '#ffffff';
    var textColor = isDark ? '#e2e8f0' : '#0f172a';
    var dimColor  = isDark ? '#94a3b8' : '#475569';

    var rect = chart.getBoundingClientRect();
    var SCALE = 2;
    var pngWidth  = Math.max(800, Math.round(rect.width * SCALE));
    var pngHeight = Math.max(360, Math.round(rect.height * SCALE));

    Plotly.toImage(chart, {
        format: 'png',
        width:  pngWidth,
        height: pngHeight,
    }).then(function (url) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = reject;
            img.src = url;
        });
    }).then(function (img) {
        var titleH = 64, subH = subtitle ? 36 : 0, footerH = 40;
        var canvas = document.createElement('canvas');
        canvas.width  = img.width;
        canvas.height = titleH + subH + img.height + footerH;
        var ctx = canvas.getContext('2d');

        ctx.fillStyle = pageBg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Title bar — 2× sizes for parity with the 2× Plotly raster.
        ctx.fillStyle = textColor;
        ctx.font = 'bold 26px "DM Sans", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(modeLabel + ' · ' + chartLabel, 32, titleH / 2);

        if (subtitle) {
            ctx.fillStyle = dimColor;
            ctx.font = '18px "DM Sans", system-ui, sans-serif';
            ctx.fillText(subtitle, 32, titleH + subH / 2);
        }

        ctx.drawImage(img, 0, titleH + subH);

        ctx.fillStyle = dimColor;
        ctx.font = '18px "DM Sans", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        var todayISO = new Date().toISOString().slice(0, 10);
        ctx.fillText('TC-ATLAS · ' + todayISO
                     + ' · michaelfischerwx.github.io/TC-ATLAS',
                     32, canvas.height - footerH / 2);

        canvas.toBlob(function (blob) {
            var u = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = u;
            a.download = 'tc-atlas-' + _slugSubPhase(modeLabel) + '-'
                + _slugSubPhase(chartLabel) + '-' + todayISO + '.png';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
        }, 'image/png');
    }).catch(function (err) {
        console.error('[sub-evo] save PNG failed:', err);
    }).finally(function () {
        if (btn) { btn.disabled = false; btn.innerHTML = '⤓ Save PNG'; }
    });
}

function _wireSubEvoSaveButtons() {
    var pcBtn  = document.getElementById('sub-evo-pc-save-btn');
    var ampBtn = document.getElementById('sub-evo-amp-save-btn');
    if (pcBtn && !pcBtn._wired) {
        pcBtn._wired = true;
        pcBtn.addEventListener('click', function () {
            _saveSubEvoChart('sub-evolution-pc-chart',
                             'Phase diagram (PC1, PC2)',
                             'sub-evo-pc-save-btn');
        });
    }
    if (ampBtn && !ampBtn._wired) {
        ampBtn._wired = true;
        ampBtn.addEventListener('click', function () {
            _saveSubEvoChart('sub-evolution-amp-chart',
                             'Amplitude time series',
                             'sub-evo-amp-save-btn');
        });
    }
}

function _renderSubseasonalSource() {
    var el = document.getElementById('sub-source');
    var inlineEl = document.getElementById('sub-phase-source-inline');
    if (!_subPhases) return;
    var rec = _subPhases.indices[_subState.mode];
    if (!rec) { if (el) el.textContent = ''; return; }
    function link(href, txt) {
        if (!href) return txt;
        return '<a href="' + _escapeHtml(href) + '" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline;">' + _escapeHtml(txt) + ' ↗</a>';
    }
    // Inline (top of section): short attribution that updates on mode change.
    if (inlineEl) {
        inlineEl.innerHTML = rec.label + ' from '
            + link(rec.provider_url || rec.source, rec.provider)
            + ' (' + rec.start_date.slice(0,4) + '–' + rec.end_date.slice(0,4) + ')';
    }
    // Footer (bottom of section): full attribution with paper + raw data link.
    if (el) {
        el.innerHTML =
            '<strong>Phase index:</strong> ' + link(rec.provider_url || rec.source, rec.provider)
            + ' · ' + link(rec.source, 'raw data')
            + ' · ' + link(rec.paper_url, rec.paper)
            + '. Coverage: ' + rec.start_date + ' to ' + rec.end_date + '.'
            + '<br><strong>Best-track activity:</strong> '
            + link('https://www.ncei.noaa.gov/products/international-best-track-archive', 'IBTrACS v04 (NOAA NCEI)')
            + '. Genesis = first fix of each named storm (peak ≥ 34 kt). Track density = 6-hourly fixes ≥ 34 kt. '
            + 'RI = Kaplan &amp; DeMaria (2003) threshold of ΔVmax ≥ 30 kt / 24 h, with user-controllable start-Vmax range, '
            + 'overwater-only (1° Natural Earth land mask), and TC-phase filters.';
    }
}

function _escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Phase drill-in modal ────────────────────────────────────────
// Opened by clicking a phase tile in the 8-panel map. Shows a larger
// single-panel map for that phase, summary stats, top-RI storm list,
// and a histogram of 24-h intensity changes.
window.closePhaseModal = function () {
    var m = document.getElementById('phase-modal');
    if (m) m.style.display = 'none';
};

function _openPhaseModal(phase) {
    var m = document.getElementById('phase-modal');
    if (!m) return;
    m.style.display = 'flex';
    _renderPhaseModal(phase);
    _ga('tc_clim_sub_phase_drill', { mode: _subState.mode, phase: phase });
}

function _renderPhaseModal(phase) {
    var modeRec = _subPhases.indices[_subState.mode];
    if (!modeRec) return;
    var modeLabel = modeRec.label;
    var basinLabel = _subState.basin === 'ALL' ? 'all basins (excl. S. Atlantic)' : (BASIN_NAMES[_subState.basin] || _subState.basin);
    var seasonLabel = ({all:'all months', mjjaso:'May–Oct', ndjfma:'Nov–Apr'})[_subState.season];

    document.getElementById('phase-modal-title').textContent =
        modeLabel + ' · Phase ' + phase;
    document.getElementById('phase-modal-sub').textContent =
        'Filtered to ' + basinLabel + ', ' + seasonLabel + '. '
        + 'Active days only (amplitude ≥ 1). Coverage: ' + modeRec.start_date + ' to ' + modeRec.end_date + '.';
    var mmEl = document.getElementById('phase-modal-mapmode');
    if (mmEl) mmEl.textContent = ({
        genesis: '— genesis points',
        ri:      '— RI event starts',
        dw:      '— mean ΔVmax per 5° bin',
    })[_subState.mapMode] || '— 6-h track fixes';

    _renderPhaseModalMap(phase);
    _renderPhaseModalStats(phase);
    _renderPhaseModalTopRI(phase);
    _renderPhaseModalHistogram(phase);
}

function _renderPhaseModalMap(phase) {
    var el = document.getElementById('phase-modal-map');
    if (!el || typeof Plotly === 'undefined') return;
    var mm = _subState.mapMode;
    var isAnom = !!_subState.mapAnomaly;
    var density;
    if (mm === 'genesis') density = _buildGenesisDensityPerPhase();
    else if (mm === 'ri') density = _buildRIDensityPerPhase();
    else if (mm === 'dw') density = _buildMeanDwPerPhase();
    else                  density = _buildTrackDensityPerPhase();
    if (!density) { el.innerHTML = '<div style="padding:20px; opacity:0.6;">No data.</div>'; return; }
    if (isAnom) density = _applyAnomalyToDensity(density, mm !== 'dw');
    var cells = density[phase - 1];
    if (typeof Plotly.purge === 'function') Plotly.purge(el);
    el.innerHTML = '';
    if (!cells || !cells.cnts.length) {
        var noun = ({genesis:'genesis events', ri:'RI events', dw:'24-h intervals with ≥ 5 samples'})[mm] || 'track fixes';
        el.innerHTML = '<div style="padding:20px; opacity:0.6;">No '
            + noun + ' in this phase for the current filter.</div>';
        return;
    }
    var base = _tcaPlotlyBase();
    var colorscale, color, cmin, cmax, hoverText;
    if (isAnom) {
        var absMax = 0;
        for (var pp = 0; pp < 8; pp++) {
            var ca = density[pp].cnts;
            for (var ii = 0; ii < ca.length; ii++) {
                var av = Math.abs(ca[ii]);
                if (av > absMax) absMax = av;
            }
        }
        if (absMax === 0) absMax = 1;
        color = cells.cnts;
        cmin = -absMax; cmax = absMax;
        colorscale = [
            [0.00, 'rgba(30,64,175,0.95)'],
            [0.30, 'rgba(96,165,250,0.70)'],
            [0.48, 'rgba(220,220,220,0.45)'],
            [0.52, 'rgba(220,220,220,0.45)'],
            [0.70, 'rgba(251,191,36,0.80)'],
            [1.00, 'rgba(220,38,38,0.95)'],
        ];
        var unit = (mm === 'dw' ? ' kt/24 h' : '');
        hoverText = cells.cnts.map(function (v) {
            return (v >= 0 ? '+' : '') + v.toFixed(mm === 'dw' ? 1 : 2) + unit + ' vs phase mean';
        });
    } else if (mm === 'dw') {
        var maxAbs = 15;
        color = cells.cnts;
        cmin = -maxAbs; cmax = maxAbs;
        colorscale = [
            [0.00, 'rgba(30,64,175,0.95)'],
            [0.30, 'rgba(96,165,250,0.75)'],
            [0.48, 'rgba(220,220,220,0.55)'],
            [0.52, 'rgba(220,220,220,0.55)'],
            [0.70, 'rgba(251,191,36,0.80)'],
            [1.00, 'rgba(220,38,38,0.95)'],
        ];
        hoverText = cells.cnts.map(function (v) {
            return (v >= 0 ? '+' : '') + v.toFixed(1) + ' kt/24 h (mean)';
        });
    } else {
        var max = Math.max.apply(null, cells.cnts);
        color = cells.cnts.map(function (c) { return c / max; });
        cmin = 0; cmax = 1;
        if (mm === 'genesis') colorscale = [
            [0,    'rgba(168,139,250,0.0)'],
            [0.15, 'rgba(168,139,250,0.65)'],
            [0.40, 'rgba(52,211,153,0.80)'],
            [0.70, 'rgba(251,191,36,0.88)'],
            [1.0,  'rgba(220,38,38,0.95)'],
        ];
        else if (mm === 'ri') colorscale = [
            [0,    'rgba(251,146,60,0.0)'],
            [0.15, 'rgba(251,146,60,0.70)'],
            [0.40, 'rgba(248,113,113,0.85)'],
            [0.70, 'rgba(220,38,38,0.92)'],
            [1.0,  'rgba(127,29,29,0.98)'],
        ];
        else colorscale = [
            [0,    'rgba(96,165,250,0.0)'],
            [0.15, 'rgba(96,165,250,0.55)'],
            [0.40, 'rgba(251,191,36,0.75)'],
            [0.70, 'rgba(248,113,113,0.85)'],
            [1.0,  'rgba(220,38,38,0.95)'],
        ];
        hoverText = cells.cnts.map(function (c) {
            if (mm === 'genesis') return c + ' ' + (c === 1 ? 'genesis' : 'geneses');
            if (mm === 'ri')      return c + ' RI event' + (c === 1 ? '' : 's');
            return c + ' fix' + (c === 1 ? '' : 'es');
        });
    }
    var trace = {
        type: 'scattergeo',
        mode: 'markers',
        lat: cells.lats,
        lon: cells.lons,
        marker: {
            color: color,
            colorscale: colorscale,
            cmin: cmin, cmax: cmax,
            size: 14, symbol: 'square',
            line: { width: 0 }, showscale: false,
        },
        text: hoverText,
        hoverinfo: 'lon+lat+text',
    };
    var layout = Object.assign({}, base, {
        height: 380,
        margin: { l: 0, r: 0, t: 0, b: 0 },
        showlegend: false,
        geo: {
            projection: { type: 'equirectangular' },
            showcoastlines: true,
            coastlinecolor: 'rgba(120,120,120,0.75)',
            coastlinewidth: 0.8,
            showland: true,
            landcolor: 'rgba(40,50,60,0.22)',
            showocean: true, oceancolor: 'rgba(0,0,0,0)',
            bgcolor: 'rgba(0,0,0,0)', showframe: false,
            lataxis: { range: [-50, 50], showgrid: false },
            lonaxis: { range: [-180, 180], showgrid: false },
        },
    });
    delete layout.xaxis; delete layout.yaxis;
    Plotly.newPlot('phase-modal-map', [trace], layout, PLOTLY_CONFIG);
}

function _renderPhaseModalStats(phase) {
    var el = document.getElementById('phase-modal-stats');
    if (!el) return;
    // Genesis count for this phase
    var gen = _countGenesisPerPhase();
    var act = _countActiveDaysPerPhase();
    var stats = _subState._lastRIStats || (Object.keys(allTracks).length > 0
        ? _buildIntensityChangePerPhase()
        : null);
    var idx = phase - 1;
    var genesisCount = gen.perPhase[idx];
    var activeDays = act.perPhase[idx];
    var nIntervals = stats ? stats.nPerPhase[idx] : null;
    var riCount = stats ? stats.riCount[idx] : null;
    var riRatePct = stats ? (stats.riRate[idx] * 100) : null;
    var meanDw = stats ? stats.meanDw[idx] : null;

    function tile(label, value, unit) {
        return '<div style="background: var(--surface, #f7f7f7); border:1px solid var(--border, rgba(0,0,0,0.08));'
            + 'border-radius:6px; padding:8px 10px;">'
            + '<div style="font-size:0.66rem; opacity:0.7; text-transform:uppercase; letter-spacing:0.04em;">' + label + '</div>'
            + '<div style="font-size:1.15rem; font-weight:600; margin-top:2px;">' + value
            + (unit ? '<span style="font-size:0.72rem; opacity:0.7; margin-left:4px;">' + unit + '</span>' : '')
            + '</div></div>';
    }
    var html = '';
    html += tile('Active days', activeDays.toLocaleString(), 'days (amp ≥ 1)');
    html += tile('Genesis events', genesisCount.toLocaleString(), '');
    if (stats) {
        html += tile('24-h intervals', nIntervals.toLocaleString(), '');
        html += tile('RI events', riCount.toLocaleString(), '≥ 30 kt/24 h');
        html += tile('RI rate', riRatePct.toFixed(2) + '%', '');
        html += tile('Mean ΔVmax', (meanDw >= 0 ? '+' : '') + meanDw.toFixed(2), 'kt/24 h');
    } else {
        html += tile('Intensity change', '—', 'tracks loading…');
    }
    el.innerHTML = html;
}

function _renderPhaseModalTopRI(phase) {
    var el = document.getElementById('phase-modal-topri');
    if (!el) return;
    var stats = _subState._lastRIStats;
    if (!stats) { el.innerHTML = '<div style="opacity:0.6; padding:8px;">Tracks loading…</div>'; return; }
    var list = stats.topRI[phase - 1] || [];
    if (!list.length) { el.innerHTML = '<div style="opacity:0.6; padding:8px;">No RI episodes in this phase.</div>'; return; }
    var rows = list.map(function (e) {
        return '<tr>'
            + '<td>' + (e.name || '(unnamed)') + ' (' + e.year + ')</td>'
            + '<td>' + e.date + '</td>'
            + '<td style="text-align:right;">+' + e.dw + ' kt</td>'
            + '<td style="text-align:right; opacity:0.7;">' + e.w0 + ' → ' + e.w1 + ' kt</td>'
            + '</tr>';
    }).join('');
    el.innerHTML = '<table style="width:100%; border-collapse:collapse; font-size:0.78rem;">'
        + '<thead><tr style="text-align:left; opacity:0.7; border-bottom:1px solid var(--border, rgba(0,0,0,0.08));">'
        + '<th style="padding:4px 8px;">Storm</th>'
        + '<th style="padding:4px 8px;">Start of 24-h interval</th>'
        + '<th style="padding:4px 8px; text-align:right;">ΔVmax</th>'
        + '<th style="padding:4px 8px; text-align:right;">Wind</th>'
        + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function _renderPhaseModalHistogram(phase) {
    var el = document.getElementById('phase-modal-hist');
    if (!el || typeof Plotly === 'undefined') return;
    var stats = _subState._lastRIStats;
    if (!stats) { el.innerHTML = ''; return; }
    var arr = stats.changes[phase - 1] || [];
    if (!arr.length) { el.innerHTML = '<div style="opacity:0.6; padding:8px;">No intervals.</div>'; return; }
    var trace = {
        type: 'histogram',
        x: arr,
        xbins: { start: -60, end: 80, size: 5 },
        marker: { color: '#2e7dff' },
        opacity: 0.85,
        name: 'ΔVmax distribution',
        hovertemplate: 'ΔVmax %{x} kt<br>n=%{y}<extra></extra>',
    };
    // Vertical RI threshold line at +30 kt.
    var base = _tcaPlotlyBase();
    var layout = Object.assign({}, base, {
        height: 260,
        margin: { l: 50, r: 20, t: 10, b: 40 },
        xaxis: { title: '24-h ΔVmax (kt)', zeroline: true, zerolinecolor: 'rgba(0,0,0,0.4)' },
        yaxis: { title: 'count' },
        shapes: [{
            type: 'line', xref: 'x', yref: 'paper',
            x0: 30, x1: 30, y0: 0, y1: 1,
            line: { color: '#ef4444', width: 2, dash: 'dash' },
        }],
        annotations: [{
            x: 30, y: 1, xref: 'x', yref: 'paper',
            text: 'RI threshold (+30 kt)', showarrow: false,
            xanchor: 'left', yanchor: 'top',
            font: { color: '#ef4444', size: 10 },
            bgcolor: 'rgba(255,255,255,0.7)', borderpad: 2,
        }],
        showlegend: false,
    });
    Plotly.newPlot('phase-modal-hist', [trace], layout, PLOTLY_CONFIG);
}

// ── Init (called once on first switch to the subseasonal subview) ──
function _initSubseasonalOnce() {
    if (_subInited) {
        // Subsequent visits: just resize / refresh.
        if (typeof Plotly !== 'undefined') {
            var d = document.getElementById('sub-dial-chart');
            var t = document.getElementById('sub-tracks-chart');
            if (d && d.layout) Plotly.Plots.resize(d);
            if (t && t.layout) Plotly.Plots.resize(t);
        }
        return;
    }
    _subInited = true;

    // Wire mode toggle
    document.querySelectorAll('#sub-mode-toggle button').forEach(function (b) {
        b.addEventListener('click', function () {
            _subState.mode = b.dataset.subMode;
            document.querySelectorAll('#sub-mode-toggle button').forEach(function (x) {
                x.classList.toggle('active', x === b);
            });
            _syncYearInputBounds();
            _ga('tc_clim_sub_mode', { mode: _subState.mode });
            _renderSubseasonal();
        });
    });
    // Wire basin chips
    document.querySelectorAll('#sub-basin-chips .basin-chip').forEach(function (c) {
        c.addEventListener('click', function () {
            _subState.basin = c.dataset.basin;
            document.querySelectorAll('#sub-basin-chips .basin-chip').forEach(function (x) {
                x.classList.toggle('active', x === c);
            });
            _renderSubseasonal();
        });
    });
    // Wire season toggle
    document.querySelectorAll('#sub-season-toggle button').forEach(function (b) {
        b.addEventListener('click', function () {
            _subState.season = b.dataset.subSeason;
            document.querySelectorAll('#sub-season-toggle button').forEach(function (x) {
                x.classList.toggle('active', x === b);
            });
            _renderSubseasonal();
        });
    });
    // Wire map-content toggle (Tracks ↔ Genesis ↔ RI ↔ Mean ΔVmax)
    document.querySelectorAll('#sub-mapmode-toggle button').forEach(function (b) {
        b.addEventListener('click', function () {
            _subState.mapMode = b.dataset.subMapmode;
            document.querySelectorAll('#sub-mapmode-toggle button').forEach(function (x) {
                x.classList.toggle('active', x === b);
            });
            _ga('tc_clim_sub_mapmode', { mapMode: _subState.mapMode });
            _renderSubseasonal();
        });
    });
    // Wire dial-metric toggle (Genesis count / ACE / Storm-days)
    document.querySelectorAll('#sub-dial-metric-toggle button').forEach(function (b) {
        b.addEventListener('click', function () {
            _subState.dialMetric = b.dataset.subDialMetric;
            document.querySelectorAll('#sub-dial-metric-toggle button').forEach(function (x) {
                x.classList.toggle('active', x === b);
            });
            _ga('tc_clim_sub_dialmetric', { metric: _subState.dialMetric });
            _renderActivityDial();
        });
    });
    // Wire anomaly-display checkbox
    var anomEl = document.getElementById('sub-mapanom');
    if (anomEl) anomEl.addEventListener('change', function () {
        _subState.mapAnomaly = !!anomEl.checked;
        _ga('tc_clim_sub_mapanom', { anomaly: _subState.mapAnomaly });
        _renderSubseasonal();
    });
    // Wire year-range inputs. Re-render is debounced so dragging a number
    // spinner doesn't fire a full RI-stats pass on every tick.
    var yrStart = document.getElementById('sub-year-start');
    var yrEnd   = document.getElementById('sub-year-end');
    var yrReset = document.getElementById('sub-year-reset');
    var yearDebounce = null;
    function onYearChange() {
        if (yearDebounce) clearTimeout(yearDebounce);
        yearDebounce = setTimeout(function () {
            var s = yrStart && yrStart.value !== '' ? +yrStart.value : null;
            var e = yrEnd   && yrEnd.value   !== '' ? +yrEnd.value   : null;
            _subState.yearMin = (Number.isFinite(s) && s >= 1851) ? s : null;
            _subState.yearMax = (Number.isFinite(e) && e >= 1851) ? e : null;
            _ga('tc_clim_sub_year', { yearMin: _subState.yearMin, yearMax: _subState.yearMax });
            _renderSubseasonal();
        }, 350);
    }
    if (yrStart) yrStart.addEventListener('input', onYearChange);
    if (yrEnd)   yrEnd.addEventListener('input', onYearChange);
    if (yrReset) yrReset.addEventListener('click', function () {
        if (yrStart) yrStart.value = '';
        if (yrEnd)   yrEnd.value   = '';
        _subState.yearMin = null;
        _subState.yearMax = null;
        _renderSubseasonal();
    });

    // Each phase-clock card's click handler is wired inside
    // _renderSubseasonalNowWidget (it needs the per-card mode to
    // know which mode to open the evolution modal for).
    // Lookback-window toggle in the evolution modal
    document.querySelectorAll('#sub-evolution-window-toggle button').forEach(function (b) {
        b.addEventListener('click', function () {
            _subEvoWindow = +b.dataset.subEvoWindow;
            document.querySelectorAll('#sub-evolution-window-toggle button').forEach(function (x) {
                x.classList.toggle('active', x === b);
            });
            _renderSubEvolution();
        });
    });

    // ── Historical-overlay controls (date pickers + presets) ────────
    var histStart  = document.getElementById('sub-evo-hist-start');
    var histEnd    = document.getElementById('sub-evo-hist-end');
    var histApply  = document.getElementById('sub-evo-hist-apply');
    var histClear  = document.getElementById('sub-evo-hist-clear');
    var histStatus = document.getElementById('sub-evo-hist-status');
    var histPresets = document.querySelectorAll('#sub-evo-hist-presets button');

    function _applyHistorical() {
        if (!histStart || !histEnd) return;
        var s = histStart.value, e = histEnd.value;
        if (!s || !e) {
            if (histStatus) histStatus.textContent = 'Pick a start and end date.';
            return;
        }
        if (s > e) { var t = s; s = e; e = t; }
        var rec = _subPhases && _subPhases.indices[_subState.mode];
        if (rec && (e < rec.start_date || s > rec.end_date)) {
            if (histStatus) histStatus.textContent =
                'Out of range for ' + rec.label + ' (' + rec.start_date + ' to ' + rec.end_date + ').';
            return;
        }
        _subEvoHistorical = { start: s, end: e };
        if (histStatus) histStatus.textContent = '';
        _renderSubEvolution();
        _ga('tc_clim_sub_evolution_historical', { mode: _subState.mode, start: s, end: e });
    }

    if (histApply) histApply.addEventListener('click', _applyHistorical);
    if (histClear) histClear.addEventListener('click', function () {
        _subEvoHistorical = null;
        if (histStart) histStart.value = '';
        if (histEnd)   histEnd.value   = '';
        if (histStatus) histStatus.textContent = '';
        document.querySelectorAll('#sub-evo-hist-presets button.active').forEach(function (b) {
            b.classList.remove('active');
        });
        _renderSubEvolution();
    });
    histPresets.forEach(function (b) {
        b.addEventListener('click', function () {
            var key = b.dataset.histPreset;
            var range = _SUB_EVO_HIST_PRESETS[key];
            if (!range) return;
            if (histStart) histStart.value = range.start;
            if (histEnd)   histEnd.value   = range.end;
            histPresets.forEach(function (x) { x.classList.toggle('active', x === b); });
            _applyHistorical();
        });
    });

    // ── "Same dates from year YYYY" quick-compare ────────────────────
    // Takes the calendar month/day of the current recent window and
    // remaps it to the user-picked year. Handles year-crossing windows
    // (e.g. the last 90 d in March, which reaches back to December of
    // the prior year) by carrying the same +1 year offset between the
    // start and end dates.
    var histYearInput = document.getElementById('sub-evo-hist-year');
    var histYearApply = document.getElementById('sub-evo-hist-year-apply');
    function _applySameDatesFromYear() {
        if (!_subPhases) return;
        var rec = _subPhases.indices[_subState.mode];
        if (!rec || !rec.phases) return;
        var y = histYearInput && parseInt(histYearInput.value, 10);
        if (!Number.isFinite(y)) {
            if (histStatus) histStatus.textContent = 'Enter a 4-digit year.';
            return;
        }
        // Reproduce _renderSubEvolution's "recent window" slice math so
        // the calendar dates here match exactly what the diagram is
        // drawing (don't trust the visible labels — the modal may not
        // have rendered yet on a cold open).
        if (rec._startKey == null) rec._startKey = _dayKeyFromISO(rec.start_date);
        var lastIdx = rec.phases.length - 1;
        while (lastIdx >= 0 && rec.phases[lastIdx] == null) lastIdx--;
        if (lastIdx < 0) return;
        var startIdx = Math.max(0, lastIdx - _subEvoWindow + 1);
        var recentStart = new Date((rec._startKey + startIdx) * 86400000);
        var recentEnd   = new Date((rec._startKey + lastIdx)   * 86400000);
        var startY = recentStart.getUTCFullYear();
        var endY   = recentEnd.getUTCFullYear();
        // Preserve any year-crossing offset (endY - startY) when
        // remapping into the historical year.
        var hStartY = y;
        var hEndY   = y + (endY - startY);
        function fmtMD(d) {
            return ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-'
                 + ('0' + d.getUTCDate()).slice(-2);
        }
        var s = hStartY + '-' + fmtMD(recentStart);
        var e = hEndY   + '-' + fmtMD(recentEnd);
        if (s < rec.start_date || e > rec.end_date) {
            if (histStatus) histStatus.textContent =
                'Year out of range for ' + rec.label
                + ' (' + rec.start_date.slice(0,4)
                + '–' + rec.end_date.slice(0,4) + ').';
            return;
        }
        if (histStart) histStart.value = s;
        if (histEnd)   histEnd.value   = e;
        // Deactivate any preset highlight — this is its own analog.
        document.querySelectorAll('#sub-evo-hist-presets button.active').forEach(function (b) {
            b.classList.remove('active');
        });
        _applyHistorical();
    }
    if (histYearApply) histYearApply.addEventListener('click', _applySameDatesFromYear);
    if (histYearInput) histYearInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') _applySameDatesFromYear();
    });

    // Wire RI methodology controls (overwater / TC-phase / Vmax range)
    var riOver  = document.getElementById('sub-ri-overwater');
    var riTC    = document.getElementById('sub-ri-tcphase');
    var riVmin  = document.getElementById('sub-ri-vmin');
    var riVmax  = document.getElementById('sub-ri-vmax');
    var riReset = document.getElementById('sub-ri-reset');
    var riDebounce = null;
    function readRIControls() {
        if (riOver) _subState.riOverwater = !!riOver.checked;
        if (riTC)   _subState.riTCPhaseOnly = !!riTC.checked;
        var lo = riVmin && riVmin.value !== '' ? +riVmin.value : 35;
        var hi = riVmax && riVmax.value !== '' ? +riVmax.value : 200;
        if (!Number.isFinite(lo) || lo < 0) lo = 35;
        if (!Number.isFinite(hi) || hi > 250) hi = 200;
        if (hi < lo) { var t = lo; lo = hi; hi = t; }
        _subState.riVmin = lo;
        _subState.riVmax = hi;
    }
    function onRIChange() {
        readRIControls();
        // Overwater needs the land mask. If not loaded yet, fetch and re-render.
        if (_subState.riOverwater && !_landMask) {
            _loadLandMask().then(function () {
                if (riDebounce) clearTimeout(riDebounce);
                _renderIntensityDial();
            });
        }
        if (riDebounce) clearTimeout(riDebounce);
        riDebounce = setTimeout(function () {
            _renderIntensityDial();
        }, 200);
    }
    if (riOver) riOver.addEventListener('change', onRIChange);
    if (riTC)   riTC.addEventListener('change', onRIChange);
    if (riVmin) riVmin.addEventListener('input', onRIChange);
    if (riVmax) riVmax.addEventListener('input', onRIChange);
    if (riReset) riReset.addEventListener('click', function () {
        if (riOver) riOver.checked = true;
        if (riTC)   riTC.checked   = true;
        if (riVmin) riVmin.value   = '';
        if (riVmax) riVmax.value   = '';
        readRIControls();
        _renderIntensityDial();
    });

    // Storm metadata may still be loading on first visit — wait for it.
    var ready = (allStorms.length > 0)
        ? Promise.resolve()
        : _loadStormsMetadata();
    // Land mask fetched in parallel (small, ~64 KB). RI panel re-renders
    // once it arrives if Overwater is checked.
    Promise.all([ready, _loadSubPhases(), _loadLandMask()]).then(function () {
        _ensureStormBySid();
        _syncYearInputBounds();
        _renderSubseasonal();
    });
}

// Update the year-range inputs' placeholder + min/max attributes so they
// match the active mode's coverage. Doesn't clear user-entered values —
// the filter functions clamp on read.
function _syncYearInputBounds() {
    var rec = _subPhases && _subPhases.indices[_subState.mode];
    if (!rec) return;
    var yMin = +rec.start_date.slice(0, 4);
    var yMax = +rec.end_date.slice(0, 4);
    ['sub-year-start','sub-year-end'].forEach(function (id, i) {
        var el = document.getElementById(id);
        if (!el) return;
        el.min = String(yMin);
        el.max = String(yMax);
        el.placeholder = String(i === 0 ? yMin : yMax);
    });
}

// ── Page init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
    _ga('tc_clim_page_load');
    _bindSubnav();

    var params = _readHashParams();

    _loadStormsMetadata()
        .then(function () {
            renderClimatology();
            _applyHashParams(params);
            _watchTracksReady();
        })
        .catch(function (err) {
            console.error('[TC Climatology] Failed to load storms:', err);
            var rangeEl = document.getElementById('clim-year-range');
            if (rangeEl) rangeEl.textContent = 'failed to load';
            // Still apply the hash so deep-link to globe sub-view works
            // even if storm metadata is offline.
            _applyHashParams(params);
        });

    // Keep hash → view in sync if the user navigates back/forward
    window.addEventListener('hashchange', function () {
        _applyHashParams(_readHashParams());
    });
});
