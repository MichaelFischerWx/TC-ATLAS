/* ════════════════════════════════════════════════════════════════
   vol3d.js — shared 3D isosurface volume viewer modal.

   Extracted from tc_radar_app.js so BOTH the TC-RADAR Explorer
   (explorer.html) and the Real-Time Monitor's Recon tab
   (realtime_ir.html) can render the same Plotly isosurface modal
   without dragging the whole 15k-line archive app onto the RT page.

   This is a CLASSIC (non-IIFE) script on purpose: it defines
   `_last3DJson` and the modal functions at global scope so the
   existing `window._last3DJson` swap in realtime_tdr.js
   (rtOpen3DModal) keeps working unchanged. tc_radar_app.js's
   archive-only fetch3DVolume() also calls open3DModal() from here.

   Dependencies: Plotly (global). Uses tcrNewPlot() if present
   (explorer.html theme wrapper) else falls back to Plotly.newPlot.
   The DOM contract is the #vol3DModal markup (controls vol-iso-min,
   vol-iso-max, vol-surfaces, vol-opacity, vol-caps, vol-tdr-toggle,
   vol-tilt-toggle, vol-units, vol-3d-chart) which must exist on the
   host page.
   ════════════════════════════════════════════════════════════════ */

// Shared 3D volume payload — bare `var` so it is window-scoped in a
// classic script, preserving the window._last3DJson swap contract.
var _last3DJson = null;
var _3dTiltTraceStart = -1;   // index where tilt traces begin in chart data

// Tilt-height colorscale: a magenta/purple family so the vortex-tilt column and
// its RMW rings stand out from the reflectivity/wind fields (which run
// blue→green→yellow→red) and the grey backdrop, instead of a Viridis that blended
// in. Bright at every height so low-level rings/points don't vanish.
var _VOL3D_TILT_CS = [
    [0.00, '#f9a8d4'], [0.40, '#e879f9'], [0.70, '#c026d3'], [1.00, '#86198f']
];
var _VOL3D_TILT_LINE = 'rgba(192,38,211,0.85)';
function _vol3dSampleCS(scale, t) {
    t = Math.max(0, Math.min(1, t));
    function hx(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
    for (var i = 1; i < scale.length; i++) {
        if (t <= scale[i][0]) {
            var a = scale[i - 1], b = scale[i], f = (t - a[0]) / (b[0] - a[0] || 1);
            var ca = hx(a[1]), cb = hx(b[1]);
            return 'rgb(' + Math.round(ca[0] + f * (cb[0] - ca[0])) + ',' +
                            Math.round(ca[1] + f * (cb[1] - ca[1])) + ',' +
                            Math.round(ca[2] + f * (cb[2] - ca[2])) + ')';
        }
    }
    return scale[scale.length - 1][1];
}

// Plotly.newPlot wrapper: reuse the archive theme wrapper when it's
// loaded (explorer.html), otherwise call Plotly directly (RT page).
// The 3D chart is always inside a modal, so tcrNewPlot's touch
// adjustment is a no-op for it anyway — the fallback is exact.
function _vol3dNewPlot(el, traces, layout, config) {
    if (typeof tcrNewPlot === 'function') return tcrNewPlot(el, traces, layout, config);
    return Plotly.newPlot(el, traces, layout, config);
}

function open3DModal() {
    if (!_last3DJson) return;
    var modal = document.getElementById('vol3DModal');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    var json = _last3DJson;
    var vi = json.variable;

    // Build title
    var meta = json.case_meta || {};
    var title = (meta.storm_name || '') + '  |  ' + (meta.datetime || '') +
        (meta.vmax_kt !== null && meta.vmax_kt !== undefined ? ' [' + meta.vmax_kt + ' kt]' : '') +
        '\n' + vi.display_name + '  —  3D Isosurface';

    // Set up control defaults from data range
    var isoMin = document.getElementById('vol-iso-min');
    var isoMax = document.getElementById('vol-iso-max');
    var surfs = document.getElementById('vol-surfaces');
    var opac = document.getElementById('vol-opacity');
    var capBtn = document.getElementById('vol-caps');

    // Reasonable defaults based on variable
    var dMin = vi.data_min, dMax = vi.data_max;
    var rangeMin = Math.max(vi.vmin, dMin);
    var rangeMax = Math.min(vi.vmax, dMax);
    // For diverging variables (vmin < 0), only show positive isosurfaces by default
    if (vi.vmin < 0) {
        rangeMin = Math.max(0, dMin);
    }
    // For reflectivity, start at 15 dBZ
    if (vi.key.indexOf('reflectivity') !== -1) {
        rangeMin = Math.max(15, rangeMin);
    }

    isoMin.value = rangeMin.toFixed(1);
    isoMax.value = rangeMax.toFixed(1);
    document.getElementById('vol-iso-min-val').textContent = rangeMin.toFixed(1);
    document.getElementById('vol-iso-max-val').textContent = rangeMax.toFixed(1);
    document.getElementById('vol-units').textContent = vi.units;

    render3DIsosurface();
}

function close3DModal() {
    var modal = document.getElementById('vol3DModal');
    if (!modal) return;
    modal.classList.remove('active');
    document.body.style.overflow = '';
    Plotly.purge('vol-3d-chart');
}

function render3DIsosurface() {
    var json = _last3DJson;
    if (!json) return;

    var vi = json.variable;
    var sentinel = json.sentinel;

    var isoMin = parseFloat(document.getElementById('vol-iso-min').value) || vi.vmin;
    var isoMax = parseFloat(document.getElementById('vol-iso-max').value) || vi.vmax;
    var nSurfaces = parseInt(document.getElementById('vol-surfaces').value) || 4;
    var opacity = parseFloat(document.getElementById('vol-opacity').value) || 0.3;
    var showCaps = document.getElementById('vol-caps').classList.contains('active');

    // Clamp iso range above sentinel
    if (isoMin <= sentinel + 1) isoMin = sentinel + 1;

    var meta = json.case_meta || {};
    var title = (meta.storm_name || '') + '  |  ' + (meta.datetime || '') +
        (meta.vmax_kt !== null && meta.vmax_kt !== undefined ? ' [' + meta.vmax_kt + ' kt]' : '') +
        '<br><span style="font-size:12px;">' + vi.display_name + ' (' + vi.units + ')  —  3D Isosurface</span>';

    // Handle both compact (x_axis/y_axis/z_axis) and legacy (x/y/z) formats.
    // Compact sends 1D axis vectors; we reconstruct the flattened meshgrid here.
    // Legacy sends pre-flattened meshgrid arrays directly.
    var xFlat, yFlat, zFlat;
    if (json.x_axis) {
        // Compact format: reconstruct flattened meshgrid from 1D axes
        var xA = json.x_axis, yA = json.y_axis, zA = json.z_axis;
        var shape = json.grid_shape;
        var nz = shape[0], ny = shape[1], nx = shape[2];
        var total = nz * ny * nx;
        xFlat = new Array(total);
        yFlat = new Array(total);
        zFlat = new Array(total);
        var idx = 0;
        for (var iz = 0; iz < nz; iz++) {
            for (var iy = 0; iy < ny; iy++) {
                for (var ix = 0; ix < nx; ix++) {
                    xFlat[idx] = xA[ix];
                    yFlat[idx] = yA[iy];
                    zFlat[idx] = zA[iz];
                    idx++;
                }
            }
        }
    } else {
        // Legacy format: use pre-flattened arrays directly
        xFlat = json.x;
        yFlat = json.y;
        zFlat = json.z;
    }

    var plotBg = '#ffffff';

    var trace = {
        type: 'isosurface',
        x: xFlat,
        y: yFlat,
        z: zFlat,
        value: json.value,
        isomin: isoMin,
        isomax: isoMax,
        surface: { count: nSurfaces, fill: 1.0 },
        caps: {
            x: { show: showCaps },
            y: { show: showCaps },
            z: { show: showCaps }
        },
        opacity: opacity,
        colorscale: vi.colorscale,
        cmin: isoMin,
        cmax: isoMax,
        colorbar: {
            title: { text: vi.units, font: { color: '#5b6573', size: 12 } },
            tickfont: { color: '#5b6573', size: 10 },
            thickness: 14,
            len: 0.7,
            x: 1.02
        },
        showscale: true,
        hovertemplate: '<b>' + vi.display_name + '</b>: %{value:.1f} ' + vi.units +
            '<br>X: %{x:.0f} km  Y: %{y:.0f} km<br>Height: %{z:.1f} km<extra></extra>',
        lighting: {
            ambient: 0.6,
            diffuse: 0.7,
            specular: 0.3,
            roughness: 0.6,
            fresnel: 0.3
        },
        lightposition: { x: 1000, y: 1000, z: 2000 }
    };

    // Determine axis ranges — use compact axis vectors if available (faster),
    // otherwise fall back to first/last of flattened arrays
    var gs = json.grid_shape; // [nz, ny, nx]
    var xRange, yRange, zRange;
    if (json.x_axis) {
        xRange = [json.x_axis[0], json.x_axis[json.x_axis.length - 1]];
        yRange = [json.y_axis[0], json.y_axis[json.y_axis.length - 1]];
        zRange = [json.z_axis[0], json.z_axis[json.z_axis.length - 1]];
    } else {
        xRange = [xFlat[0], xFlat[xFlat.length - 1]];
        yRange = [yFlat[0], yFlat[yFlat.length - 1]];
        zRange = [zFlat[0], zFlat[zFlat.length - 1]];
    }

    // Horizontal span (km) vs vertical span
    var hSpan = Math.max(xRange[1] - xRange[0], yRange[1] - yRange[0]);
    var vSpan = zRange[1] - zRange[0];
    var vertExag = Math.min(hSpan / vSpan * 0.25, 8); // Exaggerate vertical but cap it

    var layout = {
        title: { text: title, font: { color: '#0f1623', size: 15 }, y: 0.97, x: 0.5, xanchor: 'center' },
        paper_bgcolor: plotBg,
        scene: {
            bgcolor: plotBg,
            xaxis: {
                title: { text: 'East (km)', font: { color: '#5b6573', size: 11 } },
                tickfont: { color: '#5b6573', size: 9 },
                gridcolor: 'rgba(15, 22, 35,0.06)',
                showbackground: true,
                backgroundcolor: '#0f1419'
            },
            yaxis: {
                title: { text: 'North (km)', font: { color: '#5b6573', size: 11 } },
                tickfont: { color: '#5b6573', size: 9 },
                gridcolor: 'rgba(15, 22, 35,0.06)',
                showbackground: true,
                backgroundcolor: '#0f1419'
            },
            zaxis: {
                title: { text: 'Height (km)', font: { color: '#5b6573', size: 11 } },
                tickfont: { color: '#5b6573', size: 9 },
                gridcolor: 'rgba(15, 22, 35,0.06)',
                showbackground: true,
                backgroundcolor: '#111822'
            },
            aspectmode: 'manual',
            aspectratio: { x: 1, y: 1, z: 1 / vertExag },
            camera: {
                eye: { x: 0, y: -2.2, z: 0.8 },
                up: { x: 0, y: 0, z: 1 },
                center: { x: 0, y: 0, z: -0.1 }
            }
        },
        margin: { l: 0, r: 0, t: 50, b: 0 },
        hoverlabel: { bgcolor: '#ffffff', font: { color: '#0f1623', size: 12 } }
    };

    // Preserve camera position across re-renders (caps/iso changes)
    var chartDiv = document.getElementById('vol-3d-chart');
    var savedCamera = null;
    if (chartDiv && chartDiv.layout && chartDiv.layout.scene && chartDiv.layout.scene.camera) {
        savedCamera = JSON.parse(JSON.stringify(chartDiv.layout.scene.camera));
    }
    if (savedCamera) layout.scene.camera = savedCamera;

    _vol3dNewPlot('vol-3d-chart', [trace], layout, {
        responsive: true,
        displayModeBar: true,
        displaylogo: false,
        modeBarButtonsToRemove: ['toImage', 'resetCameraLastSave3d']
    }).then(function() {
        // Reset TDR toggle to active (trace 0 is always visible after newPlot)
        var tdrBtn = document.getElementById('vol-tdr-toggle');
        if (tdrBtn && !tdrBtn.classList.contains('active')) tdrBtn.classList.add('active');

        // Reset overlay trace state and re-add any active overlays
        _3dTiltTraceStart = -1;
        _addTiltTo3D();
        // Fire a custom event so realtime_tdr.js can re-add its overlays (sondes, tilt)
        document.dispatchEvent(new CustomEvent('vol3d-rerendered'));
    });
}

function toggle3DCaps() {
    var btn = document.getElementById('vol-caps');
    btn.classList.toggle('active');
    render3DIsosurface();
}

// ── 3D Tilt Hodograph ──────────────────────────────────────────
function _build3DTiltTraces(tiltData) {
    /**
     * Build scatter3d traces for the vortex tilt path in the 3D viewer.
     * Returns an array of Plotly trace objects:
     *   [0] connecting line  (white dotted)
     *   [1] markers at each height  (coloured by height)
     */
    if (!tiltData || !tiltData.x_km || !tiltData.x_km.length) return [];
    var rawX = tiltData.x_km, rawY = tiltData.y_km, rawZ = tiltData.height_km;
    var rawMag = tiltData.tilt_magnitude_km || [];
    var rawRmw = tiltData.rmw_km || [];
    var refH = tiltData.ref_height_km || 2.0;

    // Filter out levels where any coordinate is null/undefined
    var x = [], y = [], z = [], tiltMag = [], rmw = [];
    for (var k = 0; k < rawZ.length; k++) {
        if (rawX[k] == null || rawY[k] == null || rawZ[k] == null) continue;
        x.push(rawX[k]); y.push(rawY[k]); z.push(rawZ[k]);
        tiltMag.push(rawMag[k] != null ? rawMag[k] : null);
        rmw.push(rawRmw[k] != null ? rawRmw[k] : null);
    }
    if (z.length < 2) return [];

    // Build hover text
    var hoverText = [];
    for (var i = 0; i < z.length; i++) {
        var txt = '<b>' + z[i].toFixed(1) + ' km</b>' +
            '<br>X: ' + x[i].toFixed(1) + ' km' +
            '<br>Y: ' + y[i].toFixed(1) + ' km';
        if (tiltMag[i] !== null) txt += '<br>Tilt: ' + tiltMag[i].toFixed(1) + ' km';
        if (rmw[i] !== null) txt += '<br>RMW: ' + rmw[i].toFixed(1) + ' km';
        hoverText.push(txt);
    }

    // Marker sizes: larger at reference height
    var sizes = [];
    for (var j = 0; j < z.length; j++) {
        sizes.push(Math.abs(z[j] - refH) < 0.3 ? 7 : 4);
    }

    var lineTrace = {
        type: 'scatter3d',
        mode: 'lines',
        x: x, y: y, z: z,
        line: { color: _VOL3D_TILT_LINE, width: 3, dash: 'dot' },
        hoverinfo: 'skip',
        showlegend: false
    };

    var markerTrace = {
        type: 'scatter3d',
        mode: 'markers+text',
        x: x, y: y, z: z,
        marker: {
            size: sizes,
            color: z,
            colorscale: _VOL3D_TILT_CS,
            cmin: 0, cmax: 14,
            line: { color: 'rgba(20,0,28,0.9)', width: 1 },
            colorbar: {
                title: { text: 'Height (km)', font: { color: '#5b6573', size: 10 } },
                tickfont: { color: '#5b6573', size: 9 },
                thickness: 10, len: 0.35,
                x: 1.08, y: 0.15,
                xanchor: 'left'
            }
        },
        text: z.map(function(h) { return h.toFixed(1); }),
        textposition: 'top right',
        textfont: { size: 8, color: 'rgba(240,171,252,0.75)' },
        hovertext: hoverText,
        hoverinfo: 'text',
        hoverlabel: { bgcolor: '#ffffff', font: { color: '#0f1623', size: 11 } },
        showlegend: false
    };

    // RMW rings — one circle per height, centred on THAT height's own vortex
    // centre (so the stack leans with the tilt) and coloured by height. Mirrors
    // the archive "RMW rings at each height" figure; makes the vortex structure +
    // tilt legible at a glance versus the bare centre line.
    var ringTraces = [];
    var NTH = 48, theta = [];
    for (var ti = 0; ti <= NTH; ti++) theta.push(2 * Math.PI * ti / NTH);
    for (var ri = 0; ri < z.length; ri++) {
        if (rmw[ri] == null || !isFinite(rmw[ri]) || rmw[ri] <= 0) continue;
        var rx = [], ry = [], rz = [];
        for (var tj = 0; tj < theta.length; tj++) {
            rx.push(x[ri] + rmw[ri] * Math.cos(theta[tj]));
            ry.push(y[ri] + rmw[ri] * Math.sin(theta[tj]));
            rz.push(z[ri]);
        }
        ringTraces.push({
            type: 'scatter3d', mode: 'lines', x: rx, y: ry, z: rz,
            line: { color: _vol3dSampleCS(_VOL3D_TILT_CS, z[ri] / 14), width: 4 },
            hovertemplate: 'RMW ' + rmw[ri].toFixed(0) + ' km @ ' + z[ri].toFixed(1) + ' km<extra></extra>',
            showlegend: false
        });
    }

    return [lineTrace, markerTrace].concat(ringTraces);
}

function _addTiltTo3D() {
    var chartDiv = document.getElementById('vol-3d-chart');
    var btn = document.getElementById('vol-tilt-toggle');
    if (!_last3DJson || !_last3DJson.tilt_profile) {
        if (btn) { btn.disabled = true; btn.classList.remove('active'); }
        return;
    }
    if (btn) btn.disabled = false;

    var traces = _build3DTiltTraces(_last3DJson.tilt_profile);
    if (!traces.length) {
        if (btn) { btn.disabled = true; btn.classList.remove('active'); }
        return;
    }

    _3dTiltTraceStart = chartDiv.data.length;
    Plotly.addTraces(chartDiv, traces);
    if (btn) btn.classList.add('active');
}

function toggle3DTilt() {
    var chartDiv = document.getElementById('vol-3d-chart');
    var btn = document.getElementById('vol-tilt-toggle');
    if (!chartDiv || !chartDiv.data || _3dTiltTraceStart < 0) return;

    var isActive = btn.classList.contains('active');
    var vis = isActive ? false : true;
    var indices = [];
    for (var i = _3dTiltTraceStart; i < chartDiv.data.length; i++) {
        indices.push(i);
    }
    if (indices.length) {
        Plotly.restyle(chartDiv, { visible: vis }, indices);
    }
    btn.classList.toggle('active');
}

// ── ESC-to-close (page-agnostic; guarded so it binds once) ──────
// explorer.html's tc_radar_app.js has its own ESC handler that also
// closes the image/plot modals; this one only touches the 3D modal
// and close3DModal is idempotent, so a double-close is harmless.
if (!window.__vol3dEscBound) {
    window.__vol3dEscBound = true;
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') close3DModal();
    });
}
