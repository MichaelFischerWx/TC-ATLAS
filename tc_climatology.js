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

// ── Plotly defaults ─────────────────────────────────────────────
var PLOTLY_LAYOUT_BASE = {
    paper_bgcolor: '#0a1628',
    plot_bgcolor: '#0a1628',
    font: { family: 'DM Sans, sans-serif', color: '#e2e8f0' },
    margin: { l: 50, r: 20, t: 10, b: 40 },
    hoverlabel: { bgcolor: '#1f2937', font: { color: '#e5e7eb', size: 12, family: 'DM Sans' } }
};

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
            title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.12,
            font: { size: 10, color: '#8b9ec2' }
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
            title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'Storm Count', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.12,
            font: { size: 10, color: '#8b9ec2' }
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
        yaxis: { title: { text: 'Peak Wind (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        xaxis: { tickfont: { size: 10, color: '#8b9ec2' } },
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
        xaxis: { title: { text: 'Max 24-h Wind Change (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'Storms', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        shapes: [
            { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: -30, x1: -30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } }
        ],
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.12, font: { size: 9, color: '#8b9ec2' } },
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
        yaxis: { title: { text: '|Latitude| of LMI (\u00B0)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        xaxis: { tickfont: { size: 10, color: '#8b9ec2' } },
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
        marker: { colors: colors, line: { color: '#0a1628', width: 2 } },
        textfont: { color: '#e2e8f0', size: 11, family: 'DM Sans' },
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
            line: { color: '#e2e8f0', width: 2.5, dash: 'dot' },
            hovertemplate: '<b>Global %{x}</b><br>Total ACE: %{y:.1f}<extra></extra>'
        });
    }

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2' },
            gridcolor: 'rgba(255,255,255,0.04)',
            dtick: 10
        },
        yaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        showlegend: true,
        legend: {
            orientation: 'h', x: 0, y: 1.15,
            font: { size: 10, color: '#8b9ec2' }
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
        textfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }
    };

    var chartHeight = Math.max(250, yearStorms.length * 26 + 60);

    var layout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: {
            title: { text: 'ACE (10⁴ kt²)', font: { size: 11, color: '#8b9ec2' } },
            tickfont: { size: 9, color: '#8b9ec2', family: 'JetBrains Mono' },
            gridcolor: 'rgba(255,255,255,0.04)'
        },
        yaxis: {
            tickfont: { size: 10, color: '#e2e8f0' },
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

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
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
        return { type: 'line', x0: kt, x1: kt, y0: 0, y1: 1, line: { color: 'rgba(255,255,255,0.15)', width: 1, dash: 'dot' } };
    });
    var cdfLayout = Object.assign({}, PLOTLY_LAYOUT_BASE, {
        xaxis: { title: { text: 'Peak Wind Speed (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'Cumulative Probability', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 1] },
        shapes: ssShapes,
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.15, font: { size: 10, color: '#8b9ec2' } },
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
        yaxis: { title: { text: 'Peak Wind (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
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
        xaxis: { title: { text: '24-h Wind Change (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'Number of 24-h Episodes', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        shapes: riShapes, annotations: riAnnotations,
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
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
        xaxis: { title: { text: 'Intensification Threshold (kt/24h)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 100] },
        yaxis: { title: { text: 'Exceedance Probability', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 1] },
        shapes: [
            { type: 'line', x0: 30, x1: 30, y0: 0, y1: 1, yref: 'paper', line: { color: '#fbbf24', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: 35, x1: 35, y0: 0, y1: 1, yref: 'paper', line: { color: '#f87171', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: 50, x1: 50, y0: 0, y1: 1, yref: 'paper', line: { color: '#dc2626', width: 1.5, dash: 'dash' } },
            { type: 'line', x0: 65, x1: 65, y0: 0, y1: 1, yref: 'paper', line: { color: '#a855f7', width: 1.5, dash: 'dash' } }
        ],
        showlegend: true,
        legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
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
        xaxis: { title: { text: 'Year', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: '% of 24-h Episodes Exceeding Threshold', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, rangemode: 'tozero' },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
        margin: { l: 55, r: 10, t: 30, b: 45 }, hovermode: 'x unified'
    });
    Plotly.newPlot('ri-trend-chart', trendTraces, trendLayout, PLOTLY_CONFIG);

    // ── Exceedance CDF by Era: overlay curves for different periods ──
    var ERA_DEFS = [
        { label: '1966–1979', range: [1966, 1979], color: '#94a3b8', dash: 'dot' },
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
        xaxis: { title: { text: 'Intensification Threshold (kt/24h)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 100] },
        yaxis: { title: { text: 'Exceedance Probability', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' }, range: [0, 0.5] },
        shapes: eraCdfShapes,
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
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
        xaxis: { tickfont: { size: 11, color: '#8b9ec2' }, gridcolor: 'rgba(255,255,255,0.04)' },
        yaxis: { title: { text: 'Mean Storms per Month', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.15, font: { size: 10, color: '#8b9ec2' } },
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
        xaxis: { title: { text: 'Peak Wind (kt)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        yaxis: { title: { text: 'LMI Latitude (\u00B0)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { size: 10, color: '#8b9ec2' } },
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
        yaxis: { title: { text: 'LMI Latitude (\u00B0)', font: { size: 11, color: '#8b9ec2' } }, gridcolor: 'rgba(255,255,255,0.04)', tickfont: { size: 10, color: '#8b9ec2', family: 'JetBrains Mono' } },
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
function _switchSubview(sub) {
    var statsView = document.getElementById('tc-clim-stats');
    var globeView = document.getElementById('tc-clim-globe');
    if (!statsView || !globeView) return;
    var isStats = (sub !== 'globe');
    statsView.hidden = !isStats;
    globeView.hidden = isStats;
    document.querySelectorAll('.tc-clim-subnav-btn').forEach(function (b) {
        var active = (b.dataset.sub === (isStats ? 'stats' : 'globe'));
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    _ga('tc_clim_subview', { sub: isStats ? 'stats' : 'globe' });
    // Stats charts may need a redraw if Plotly was sized while hidden.
    if (isStats && climRendered && typeof Plotly !== 'undefined') {
        ['clim-ace-chart','clim-freq-chart','clim-hist-chart',
         'clim-ri-chart','clim-basin-chart','clim-lmi-chart'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el && el.layout) Plotly.Plots.resize(el);
        });
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
    if (params.sub === 'globe') _switchSubview('globe');
    else _switchSubview('stats');

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
