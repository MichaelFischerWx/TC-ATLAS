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
    else if (params.sub === 'subseasonal') _switchSubview('subseasonal');
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
    return (a >= 1.0) ? p : 0;     // 0 = quiescent, 1..8 = active phase
}

function _loadSubPhases() {
    if (_subPhases) return Promise.resolve(_subPhases);
    if (_subPhasesPromise) return _subPhasesPromise;
    _subPhasesPromise = fetch('data/subseasonal_phases.json?' + DATA_VER)
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
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
function _renderGenesisDial() {
    var el = document.getElementById('sub-dial-chart');
    if (!el || typeof Plotly === 'undefined') return;
    var gen = _countGenesisPerPhase();
    var act = _countActiveDaysPerPhase();
    var expected = act.total > 0
        ? act.perPhase.map(function (d) { return d * gen.total / act.total; })
        : [0,0,0,0,0,0,0,0];
    var labels = ['1','2','3','4','5','6','7','8'];
    var maxBar = Math.max.apply(null, gen.perPhase.concat([1]));
    var maxExp = Math.max.apply(null, expected.concat([1]));
    var rmax = Math.max(maxBar, maxExp) * 1.15;

    // Per-phase enhancement ratio for hover.
    var ratios = gen.perPhase.map(function (c, i) {
        return expected[i] > 0 ? (c / expected[i]) : null;
    });
    var textArr = gen.perPhase.map(function (c, i) {
        var r = ratios[i];
        var rStr = (r == null) ? 'n/a' : (r >= 1 ? '+' : '') + ((r - 1) * 100).toFixed(0) + '%';
        return 'Phase ' + (i+1) + '<br>Genesis: ' + c
             + '<br>Expected: ' + expected[i].toFixed(1)
             + '<br>Anomaly: ' + rStr;
    });

    var traces = [
        {
            type: 'barpolar',
            r: gen.perPhase,
            theta: labels.map(function (l) { return (parseInt(l) - 1) * 45; }),
            width: Array(8).fill(40),
            marker: {
                color: gen.perPhase.map(function (c, i) {
                    var r = ratios[i];
                    if (r == null) return 'rgba(150,150,150,0.5)';
                    // Diverging: r<1 cool, r>1 warm
                    return r >= 1.0 ? '#ef4444' : '#60a5fa';
                }),
                line: { color: 'rgba(0,0,0,0.25)', width: 1 },
            },
            opacity: 0.85,
            hoverinfo: 'text',
            text: textArr,
            name: 'Observed genesis',
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
        margin: { l: 30, r: 30, t: 20, b: 60 },
    });
    delete layout.xaxis; delete layout.yaxis;
    Plotly.newPlot('sub-dial-chart', traces, layout, PLOTLY_CONFIG);

    // Update event count line
    var countEl = document.getElementById('sub-event-count');
    if (countEl) {
        var modeLabel = (_subPhases.indices[_subState.mode] || {}).label || _subState.mode.toUpperCase();
        countEl.textContent = gen.total + ' named-storm genesis events on ' + act.total
            + ' active days (' + modeLabel + ')';
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
        margin: { l: 30, r: 30, t: 20, b: 60 },
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
    _renderGenesisDial();
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
        });
    } else {
        _ensureStormBySid();
        _renderTrackDensity();
        _renderIntensityDial();
    }
    _renderSubseasonalSource();
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
