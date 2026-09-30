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

    // Reopen in the view the user last picked (it refetches for this analysis).
    if (_vol3dView && _vol3dViewsAvailable()) render3DView();
    else { _vol3dView = null; render3DIsosurface(); }
    var sel = document.getElementById('vol-view');
    if (sel) sel.value = _vol3dView || '';
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

    _vol3dLastWasView = false;
    _vol3dSyncViewControls();
    _vol3dFloorTrace(xRange, yRange, zRange[0]).then(function (floor) {
        return _vol3dPlot([trace].concat(floor ? [floor] : []), layout);
    });
}

// newPlot + the overlay bookkeeping every render path shares. Base traces
// (isosurfaces, IR floor) go in the newPlot call so the tilt/sonde overlays
// appended afterwards stay a contiguous tail — toggle3DTilt hides from
// _3dTiltTraceStart to the end.
function _vol3dPlot(traces, layout) {
    return _vol3dNewPlot('vol-3d-chart', traces, layout, {
        responsive: true,
        displayModeBar: true,
        displaylogo: false,
        modeBarButtonsToRemove: ['toImage', 'resetCameraLastSave3d']
    }).then(function() {
        // Reset TDR toggle to active (isosurfaces are always visible after newPlot)
        var tdrBtn = document.getElementById('vol-tdr-toggle');
        if (tdrBtn && !tdrBtn.classList.contains('active')) tdrBtn.classList.add('active');
        _vol3dSyncViewControls();

        // Reset overlay trace state and re-add any active overlays
        _3dTiltTraceStart = -1;
        _addTiltTo3D();
        // Fire a custom event so realtime_tdr.js can re-add its overlays (sondes, tilt)
        document.dispatchEvent(new CustomEvent('vol3d-rerendered'));
    });
}

// ── Preset views ───────────────────────────────────────────────
// One-click multi-field scenes. Each layer is ONE isosurface level in a flat
// colour; each view has one strong "hero" field over faint grey context. The
// host page opts in by defining
//   window.vol3dFetchVolume(variable, {stride, radius_km, max_height_km}) -> Promise<volume json>
// and optionally window.vol3dFloorImage() -> {src, x_min_km, x_max_km, y_min_km, y_max_km}
// (satellite floor) and window.vol3dShearHeading() -> downshear heading (deg).
// Without vol3dFetchVolume the Views row stays hidden.
// Layer spec: lv = the FIXED level (SI units); pct = percentile used in Auto
// mode (null = always fixed: dBZ categories and the 34/50/64-kt radii are
// meaningful as absolute values); scale/unit/step = how the level is shown and
// typed (ζ in ×10⁻⁴ s⁻¹, wind in kt); minAbs = floor on |auto level| in display units.
var _KT = 0.514444;
var VOL3D_VIEWS = [
    { id: 'eyewall', label: 'Eyewall structure', layers: [
        { v: 'REFLECTIVITY', lv: 30, unit: 'dBZ', c: '#d9dee5', o: 0.10 },
        { v: 'REFLECTIVITY', lv: 40, unit: 'dBZ', c: '#9aa4b1', o: 0.25 },
        { v: 'REFLECTIVITY', lv: 45, unit: 'dBZ', c: '#3f4a59', o: 0.80 }] },
    { id: 'updrafts', label: 'Updrafts & downdrafts', layers: [
        { v: 'REFLECTIVITY', lv: 30, unit: 'dBZ', c: '#d9dee5', o: 0.08 },
        { v: 'W', lv: 3, pct: 0.97, sym: 'w', unit: 'm s⁻¹', step: 0.5, minAbs: 1, c: '#e0892b', o: 0.80 },
        { v: 'W', lv: -2, pct: 0.97, sym: 'w', unit: 'm s⁻¹', step: 0.5, minAbs: 1, c: '#3a6fb8', o: 0.45 }] },
    { id: 'vort', label: 'Vorticity & mesovortices', layers: [
        { v: 'REFLECTIVITY', lv: 30, unit: 'dBZ', c: '#d9dee5', o: 0.08 },
        { v: 'VORT', lv: 20e-4, pct: 0.90, sym: 'ζ', unit: '×10⁻⁴ s⁻¹', scale: 1e-4, minAbs: 5, c: '#efb3e6', o: 0.22 },
        { v: 'VORT', lv: 30e-4, pct: 0.97, sym: 'ζ', unit: '×10⁻⁴ s⁻¹', scale: 1e-4, minAbs: 5, c: '#a8127f', o: 0.85 },
        { v: 'W', lv: 3, pct: 0.95, sym: 'w', unit: 'm s⁻¹', step: 0.5, minAbs: 1, c: '#e0892b', o: 0.30 }] },
    { id: 'wind', label: 'Wind field', layers: [
        { v: 'WIND_SPEED', lv: 17.5, unit: 'kt', scale: _KT, c: '#c4d8ea', o: 0.10 },
        { v: 'WIND_SPEED', lv: 25.7, unit: 'kt', scale: _KT, c: '#f0b73e', o: 0.25 },
        { v: 'WIND_SPEED', lv: 32.9, unit: 'kt', scale: _KT, c: '#c9372f', o: 0.80 }] }
];

// ── Level choice: Auto (per analysis) / Fixed / custom per layer ──
// Auto = the layer's percentile of |value| over same-signed valid cells in the
// displayed box between 1 and 10 km, rounded to the layer's step. Fixed keeps
// cycles and storms comparable. A typed value overrides either, per view, and
// persists in this browser.
var _vol3dLevelMode = 'auto';
var _vol3dLevelOverrides = {};          // viewId -> {layerIndex: value in display units}
var _vol3dLevelsOpen = false;
try {
    var _vlSaved = JSON.parse(localStorage.getItem('vol3d_levels_v1') || 'null');
    if (_vlSaved) { _vol3dLevelMode = _vlSaved.mode === 'fixed' ? 'fixed' : 'auto'; _vol3dLevelOverrides = _vlSaved.overrides || {}; }
} catch (e) { /* storage blocked: session defaults */ }
function _vol3dSaveLevels() {
    try { localStorage.setItem('vol3d_levels_v1', JSON.stringify({ mode: _vol3dLevelMode, overrides: _vol3dLevelOverrides })); } catch (e) {}
}

function _vol3dLayerScale(L) { return L.scale || 1; }
function _vol3dLayerStep(L) { return L.step || 1; }
function _vol3dNice(L, siVal) {
    var st = _vol3dLayerStep(L), disp = Math.round(siVal / _vol3dLayerScale(L) / st) * st;
    return disp * _vol3dLayerScale(L);
}
function _vol3dFmtLevel(L, siVal) {
    var disp = siVal / _vol3dLayerScale(L), st = _vol3dLayerStep(L);
    var num = (st < 1 ? disp.toFixed(1) : Math.round(disp).toString()).replace('-', '−');
    var sep = L.unit.charAt(0) === '×' ? '' : ' ';   // 20×10⁻⁴ s⁻¹, but 3.0 m s⁻¹
    if (L.sym) return L.sym + ' = ' + (L.sym === 'w' && disp > 0 ? '+' : '') + num + sep + L.unit;
    return num + sep + L.unit;
}
function _vol3dAutoLevel(g, L) {
    var sign = L.lv >= 0 ? 1 : -1, nxy = g.nx * g.ny, vals = [];
    for (var iz = 0; iz < g.nz; iz++) {
        if (g.zA[iz] < 1 || g.zA[iz] > 10) continue;
        for (var p = iz * nxy, e = p + nxy; p < e; p++) {
            if (!g.ok[p]) continue;
            var x = g.v[p] * sign;
            if (x > 0) vals.push(x);
        }
    }
    if (vals.length < 200) return null;              // too little echo to trust a percentile
    vals.sort(function (a, b) { return a - b; });
    var q = vals[Math.floor(L.pct * (vals.length - 1))];
    var lv = _vol3dNice(L, q);
    var minSi = (L.minAbs || 0) * _vol3dLayerScale(L);
    if (lv < minSi) lv = minSi;
    return sign * lv;
}
// -> [{val, tag}] per layer ('' fixed, 'p97' auto, 'custom' typed)
function _vol3dResolveLevels(view, grids) {
    var ov = _vol3dLevelOverrides[view.id] || {}, out = [];
    view.layers.forEach(function (L, i) {
        if (ov[i] != null && isFinite(ov[i])) { out.push({ val: ov[i] * _vol3dLayerScale(L), tag: 'custom' }); return; }
        if (_vol3dLevelMode === 'auto' && L.pct) {
            var a = _vol3dAutoLevel(grids[L.v], L);
            if (a != null) {
                // Two auto levels of one field must stay distinct (faint ⊃ hero).
                for (var j = 0; j < i; j++) {
                    if (view.layers[j].v === L.v && out[j].val === a) a += (a >= 0 ? 1 : -1) * _vol3dLayerStep(L) * _vol3dLayerScale(L);
                }
                out.push({ val: a, tag: 'p' + Math.round(L.pct * 100) }); return;
            }
        }
        out.push({ val: L.lv, tag: '' });
    });
    return out;
}

function vol3dSetLevelMode(m) { _vol3dLevelMode = m === 'fixed' ? 'fixed' : 'auto'; _vol3dSaveLevels(); if (_vol3dView) render3DView(); }
function vol3dSetLevel(i, val) {
    var v = parseFloat(val);
    if (!_vol3dLevelOverrides[_vol3dView]) _vol3dLevelOverrides[_vol3dView] = {};
    if (isFinite(v)) _vol3dLevelOverrides[_vol3dView][i] = v; else delete _vol3dLevelOverrides[_vol3dView][i];
    _vol3dSaveLevels(); render3DView();
}
function vol3dResetLevels() { delete _vol3dLevelOverrides[_vol3dView]; _vol3dSaveLevels(); render3DView(); }
function toggle3DLevels() {
    _vol3dLevelsOpen = !_vol3dLevelsOpen;
    var row = document.getElementById('vol-levels-row');
    if (row) row.style.display = _vol3dLevelsOpen && _vol3dView ? '' : 'none';
    var b = document.getElementById('vol-levels-btn');
    if (b) b.classList.toggle('active', _vol3dLevelsOpen);
}
function _vol3dRenderLevelsRow(view, lv) {
    var row = document.getElementById('vol-levels-row');
    if (!row) return;
    row.style.display = _vol3dLevelsOpen && _vol3dView ? '' : 'none';
    var html = '<label>Levels</label><select onchange="vol3dSetLevelMode(this.value)" style="width:auto;">' +
        '<option value="auto"' + (_vol3dLevelMode === 'auto' ? ' selected' : '') + '>Auto (per analysis)</option>' +
        '<option value="fixed"' + (_vol3dLevelMode === 'fixed' ? ' selected' : '') + '>Fixed</option></select>';
    view.layers.forEach(function (L, i) {
        var disp = lv[i].val / _vol3dLayerScale(L), st = _vol3dLayerStep(L);
        html += '<span style="display:inline-flex;align-items:center;gap:4px;margin-left:8px;">' +
            '<span style="color:' + L.c + ';font-size:13px;">■</span>' +
            '<input type="number" step="' + st + '" value="' + (st < 1 ? disp.toFixed(1) : Math.round(disp)) + '"' +
            ' onchange="vol3dSetLevel(' + i + ', this.value)" style="width:58px;' + (lv[i].tag === 'custom' ? 'border-color:#f59e0b;' : '') + '"' +
            ' title="' + (L.sym || '') + ' level (' + L.unit + ')' + (lv[i].tag && lv[i].tag !== 'custom' ? ' — auto ' + lv[i].tag : '') + '">' +
            '<span style="font-size:10px;color:#8899aa;">' + L.unit + '</span></span>';
    });
    html += '<button class="vol3d-toggle-btn" onclick="vol3dResetLevels()" title="Drop typed values for this view" style="margin-left:8px;">Reset</button>';
    row.innerHTML = html;
}

// Missing cells (sentinel) are filled with a value on the "outside" of every
// level, so a surface never traces the edge of radar coverage (a w = −2
// shell would otherwise wrap every data gap, since 0 → −9999 crosses −2).
var _VOL3D_FILL = { REFLECTIVITY: -30, W: 0, VORT: 0, WIND_SPEED: 0 };
var VOL3D_MAX_HEIGHT_KM = 12;
var VOL3D_Z_ASPECT = 0.33;      // box height / box width; exaggeration follows the domain
var _vol3dView = null;          // active preset id, or null = single-variable mode
var _vol3dViewSeq = 0;          // drops stale renders when the view changes mid-fetch
var _vol3dFloor = 'ir';         // 'ir' | 'dbz' | 'none'
var _vol3dDomain = '120';       // half-width km as a string, or 'fit' (3 × RMW)
var _vol3dDeclutter = true;     // smooth + drop small fragments
var _vol3dLastWasView = false;  // keep the user's camera only between views

function _vol3dViewsAvailable() { return typeof window.vol3dFetchVolume === 'function'; }

function _vol3dRmwKm() {
    var tp = _last3DJson && _last3DJson.tilt_profile, rmw = null;
    if (tp && tp.rmw_km && tp.height_km) {
        var ref = tp.ref_height_km || 2, best = 1e9;
        for (var i = 0; i < tp.height_km.length; i++) {
            if (tp.rmw_km[i] != null && Math.abs(tp.height_km[i] - ref) < best) {
                best = Math.abs(tp.height_km[i] - ref); rmw = tp.rmw_km[i];
            }
        }
    }
    return rmw;
}

// Half-width shown (km) and the box actually fetched. Everything up to ±120 km
// uses the native 2-km grid from ONE ±120 km fetch (~280 KB gzipped per field),
// so zooming is a client-side crop; only ±200 km drops to the 4-km grid, where
// smoothing + declutter turn features into chunky slabs.
function _vol3dDomainKm() {
    if (_vol3dDomain === 'fit') {
        var rmw = _vol3dRmwKm();
        return Math.round(Math.max(30, Math.min(200, 3 * (rmw || 40))));
    }
    return parseFloat(_vol3dDomain) || 120;
}
function _vol3dFetchBox(d) {
    if (d <= 120) return { radius_km: 120, stride: 1, max_height_km: VOL3D_MAX_HEIGHT_KM };
    return { radius_km: 200, stride: 2, max_height_km: VOL3D_MAX_HEIGHT_KM };
}

// Crop a volume json to |x|,|y| <= d and fill sentinels -> {xA, yA, zA, v, nx, ny, nz}
function _vol3dCrop(json, d, fill) {
    var xA = json.x_axis, yA = json.y_axis, zA = json.z_axis, src = json.value, sen = json.sentinel;
    var nx0 = xA.length, ny0 = yA.length, ix = [], iy = [];
    for (var i = 0; i < nx0; i++) if (Math.abs(xA[i]) <= d) ix.push(i);
    for (var j = 0; j < ny0; j++) if (Math.abs(yA[j]) <= d) iy.push(j);
    var nx = ix.length, ny = iy.length, nz = zA.length, v = new Float32Array(nx * ny * nz), ok = new Uint8Array(nx * ny * nz), k = 0;
    for (var iz = 0; iz < nz; iz++)
        for (var a = 0; a < ny; a++)
            for (var b = 0; b < nx; b++) {
                var s = src[(iz * ny0 + iy[a]) * nx0 + ix[b]], good = !(s == null || s <= sen + 1);
                ok[k] = good ? 1 : 0;
                v[k++] = good ? s : fill;
            }
    return { xA: ix.map(function (q) { return xA[q]; }), yA: iy.map(function (q) { return yA[q]; }),
             zA: zA.slice(), v: v, ok: ok, nx: nx, ny: ny, nz: nz };
}

// One 1-2-1 pass along each axis (~Gaussian σ ≈ 0.7 cell): enough to round
// off the single-cell TDR noise that shreds raw isosurfaces.
function _vol3dSmooth(g) {
    var nx = g.nx, ny = g.ny, nz = g.nz, a = g.v, b = new Float32Array(a.length);
    function pass(src, dst, stride, n, idxOf) {
        for (var p = 0; p < src.length; p++) {
            var c = idxOf(p);
            var lo = c > 0 ? src[p - stride] : src[p], hi = c < n - 1 ? src[p + stride] : src[p];
            dst[p] = 0.25 * lo + 0.5 * src[p] + 0.25 * hi;
        }
    }
    pass(a, b, 1, nx, function (p) { return p % nx; });
    pass(b, a, nx, ny, function (p) { return Math.floor(p / nx) % ny; });
    pass(a, b, nx * ny, nz, function (p) { return Math.floor(p / (nx * ny)); });
    g.v = b;
    return g;
}

// Remove connected regions (6-connectivity) of the layer's "inside" smaller
// than minCells, by pushing them to the outside value. Per layer, since w=+3
// and w=−2 have different insides.
function _vol3dDeclutterLayer(g, lv, minCells, fill) {
    var nx = g.nx, ny = g.ny, nz = g.nz, n = nx * ny * nz, v = new Float32Array(g.v);
    var inside = lv >= 0 ? function (x) { return x >= lv; } : function (x) { return x <= lv; };
    var seen = new Uint8Array(n), stack = new Int32Array(n), comp = new Int32Array(n);
    for (var s = 0; s < n; s++) {
        if (seen[s] || !inside(v[s])) continue;
        var top = 0, cn = 0; stack[top++] = s; seen[s] = 1;
        while (top) {
            var p = stack[--top]; comp[cn++] = p;
            var x = p % nx, y = Math.floor(p / nx) % ny, z = Math.floor(p / (nx * ny));
            var nb = [x > 0 ? p - 1 : -1, x < nx - 1 ? p + 1 : -1, y > 0 ? p - nx : -1,
                      y < ny - 1 ? p + nx : -1, z > 0 ? p - nx * ny : -1, z < nz - 1 ? p + nx * ny : -1];
            for (var q = 0; q < 6; q++) {
                var r = nb[q];
                if (r >= 0 && !seen[r] && inside(v[r])) { seen[r] = 1; stack[top++] = r; }
            }
        }
        if (cn < minCells) for (var c = 0; c < cn; c++) v[comp[c]] = fill;
    }
    return v;
}

function _vol3dFlat(g) {
    var n = g.nx * g.ny * g.nz, x = new Array(n), y = new Array(n), z = new Array(n), k = 0;
    for (var iz = 0; iz < g.nz; iz++)
        for (var iy = 0; iy < g.ny; iy++)
            for (var ix = 0; ix < g.nx; ix++) { x[k] = g.xA[ix]; y[k] = g.yA[iy]; z[k] = g.zA[iz]; k++; }
    return { x: x, y: y, z: z };
}

function vol3dSetView(id) {
    _vol3dView = id || null;
    var sel = document.getElementById('vol-view');
    if (sel && sel.value !== (id || '')) sel.value = id || '';
    if (!_vol3dView) { render3DIsosurface(); return; }
    render3DView();
}
function vol3dSetDomain(val) { _vol3dDomain = val; if (_vol3dView) render3DView(); }
function vol3dSetFloor(val) { _vol3dFloor = val; if (_vol3dView) render3DView(); else render3DIsosurface(); }
function toggle3DDeclutter() { _vol3dDeclutter = !_vol3dDeclutter; if (_vol3dView) render3DView(); }

function render3DView() {
    var view = null;
    for (var i = 0; i < VOL3D_VIEWS.length; i++) if (VOL3D_VIEWS[i].id === _vol3dView) view = VOL3D_VIEWS[i];
    if (!view || !_vol3dViewsAvailable()) return;
    var seq = ++_vol3dViewSeq, d = _vol3dDomainKm(), box = _vol3dFetchBox(d);
    var status = document.getElementById('vol-view-status');
    if (status) status.textContent = 'Loading…';
    _vol3dSyncViewControls();

    var vars = [];
    view.layers.forEach(function (L) { if (vars.indexOf(L.v) < 0) vars.push(L.v); });
    if (_vol3dFloor === 'dbz' && vars.indexOf('REFLECTIVITY') < 0) vars.push('REFLECTIVITY');
    Promise.all(vars.map(function (v) { return window.vol3dFetchVolume(v, box); })).then(function (vols) {
        if (seq !== _vol3dViewSeq) return;
        var grids = {};
        vars.forEach(function (v, i) {
            var g = _vol3dCrop(vols[i], d, _VOL3D_FILL[v] != null ? _VOL3D_FILL[v] : 0);
            grids[v] = _vol3dDeclutter ? _vol3dSmooth(g) : g;
        });
        var g0 = grids[vars[0]], flat = _vol3dFlat(g0);
        // ~20 cells on the 2-km grid ≈ 80 km³; the same volume is ~5 cells at 4 km.
        var minCells = box.stride === 1 ? 20 : 5;

        var lvls = _vol3dResolveLevels(view, grids);
        _vol3dRenderLevelsRow(view, lvls);
        var traces = view.layers.map(function (L, li) {
            var g = grids[L.v], fill = _VOL3D_FILL[L.v] != null ? _VOL3D_FILL[L.v] : 0, lv = lvls[li].val;
            var vals = _vol3dDeclutter ? _vol3dDeclutterLayer(g, lv, minCells, fill) : g.v;
            var name = _vol3dFmtLevel(L, lv);
            return {
                type: 'isosurface', x: flat.x, y: flat.y, z: flat.z, value: Array.prototype.slice.call(vals),
                isomin: lv, isomax: lv, surface: { count: 1, fill: 1.0 },
                caps: { x: { show: false }, y: { show: false }, z: { show: false } },
                colorscale: [[0, L.c], [1, L.c]], showscale: false, opacity: L.o, flatshading: false,
                name: name, hovertemplate: '<b>' + name + '</b><br>X: %{x:.0f} km  Y: %{y:.0f} km<br>Height: %{z:.1f} km<extra></extra>',
                lighting: { ambient: 0.65, diffuse: 0.7, specular: 0.12, roughness: 0.8, fresnel: 0.1 },
                lightposition: { x: 1000, y: -1000, z: 3000 }
            };
        });

        var xR = [g0.xA[0], g0.xA[g0.nx - 1]], yR = [g0.yA[0], g0.yA[g0.ny - 1]], zR = [g0.zA[0], g0.zA[g0.nz - 1]];
        var hSpan = Math.max(xR[1] - xR[0], yR[1] - yR[0]), vSpan = zR[1] - zR[0];
        var exag = VOL3D_Z_ASPECT * hSpan / vSpan;
        var meta = vols[0].case_meta || (_last3DJson && _last3DJson.case_meta) || {};
        var legend = [], anyAuto = false, anyCustom = false;
        view.layers.forEach(function (L, li) {
            var t = lvls[li].tag;
            if (t === 'custom') anyCustom = true; else if (t) anyAuto = true;
            legend.push('<span style="color:' + L.c + ';">■</span> ' + _vol3dFmtLevel(L, lvls[li].val) +
                (t && t !== 'custom' ? ' <span style="color:#9ca3af;">(' + t + ')</span>' : ''));
        });
        var lvNote = anyAuto ? 'auto levels = percentiles in this box, 1–10 km' : (_vol3dLevelMode === 'fixed' || !anyCustom ? 'fixed levels' : '');
        if (anyCustom) lvNote += (lvNote ? ', ' : '') + 'custom levels';
        var title = (meta.storm_name || '') + '  |  ' + (meta.datetime || '') + '  —  ' + view.label +
            '<br><span style="font-size:12px;">' + legend.join('   ') + '</span>' +
            '<br><span style="font-size:11px;color:#6b7280;">±' + d + ' km · ' + (box.stride === 1 ? 2 : 4) +
            '-km grid · vertical exaggeration ×' + exag.toFixed(1) + ' · ' + lvNote + (_vol3dDeclutter ? ' · smoothed, fragments < ' + minCells + ' cells removed' : '') + '</span>';
        var layout = _vol3dSceneLayout(title);
        var chartDiv = document.getElementById('vol-3d-chart');
        if (_vol3dLastWasView && chartDiv && chartDiv.layout && chartDiv.layout.scene && chartDiv.layout.scene.camera) {
            layout.scene.camera = JSON.parse(JSON.stringify(chartDiv.layout.scene.camera));
        }
        var floorP = _vol3dFloor === 'dbz'
            ? Promise.resolve(_vol3dDbzFloorTrace(_vol3dCrop(vols[vars.indexOf('REFLECTIVITY')], d, -30), zR[0]))
            : _vol3dFloorTrace(xR, yR, zR[0]);
        return floorP.then(function (floor) {
            if (seq !== _vol3dViewSeq) return;
            if (status) status.textContent = '';
            _vol3dLastWasView = true;
            return _vol3dPlot(traces.concat(floor ? [floor] : []), layout);
        });
    }).catch(function (err) {
        if (seq !== _vol3dViewSeq) return;
        if (status) status.textContent = 'Could not load view: ' + (err && err.message ? err.message : err);
    });
}

// Shared scene layout for the preset views: white backdrop, pale grid, box
// height a fixed third of its width (exaggeration is stated in the subtitle).
function _vol3dSceneLayout(title) {
    var ax = function (t) {
        return { title: { text: t, font: { color: '#5b6573', size: 11 } }, tickfont: { color: '#5b6573', size: 9 },
                 gridcolor: 'rgba(15,22,35,0.07)', showbackground: true, backgroundcolor: '#f7f8fa' };
    };
    return {
        title: { text: title, font: { color: '#0f1623', size: 15 }, y: 0.97, x: 0.5, xanchor: 'center' },
        paper_bgcolor: '#ffffff',
        scene: {
            bgcolor: '#ffffff',
            xaxis: ax('East (km)'), yaxis: ax('North (km)'), zaxis: ax('Height (km)'),
            aspectmode: 'manual', aspectratio: { x: 1, y: 1, z: VOL3D_Z_ASPECT },
            camera: _vol3dCameraFor('oblique')
        },
        margin: { l: 0, r: 0, t: 70, b: 0 },
        hoverlabel: { bgcolor: '#ffffff', font: { color: '#0f1623', size: 12 } }
    };
}

// ── Camera presets ─────────────────────────────────────────────
function _vol3dCameraFor(id) {
    var up = { x: 0, y: 0, z: 1 }, center = { x: 0, y: 0, z: -0.1 };
    if (id === 'top') return { eye: { x: 0, y: -0.01, z: 1.7 }, up: { x: 0, y: 1, z: 0 }, center: { x: 0, y: 0, z: 0 } };
    if (id === 'south') return { eye: { x: 0, y: -1.6, z: 0.25 }, up: up, center: center };
    if (id === 'shear') {
        // Stand UPSHEAR looking downshear: SHIPS SDDC is the heading the shear
        // vector points TO (met. convention, 0 = north, 90 = east).
        var h = typeof window.vol3dShearHeading === 'function' ? window.vol3dShearHeading() : null;
        if (h == null || !isFinite(h)) return null;
        var r = h * Math.PI / 180;
        return { eye: { x: -1.5 * Math.sin(r), y: -1.5 * Math.cos(r), z: 0.45 }, up: up, center: center };
    }
    return { eye: { x: 1.0, y: -1.05, z: 0.6 }, up: up, center: center };   // oblique
}

function vol3dCamera(id) {
    var cam = _vol3dCameraFor(id);
    var chartDiv = document.getElementById('vol-3d-chart');
    if (!cam || !chartDiv || !chartDiv.data) return;
    Plotly.relayout(chartDiv, { 'scene.camera': cam });
}

// ── Floors ─────────────────────────────────────────────────────
// Plotly 3-D has no image textures, but mesh3d takes per-vertex colours, so a
// floor is a flat grid mesh. Both floors are deliberately quiet (lightened,
// mostly desaturated) — context under the storm, not a competing colour field.
function _vol3dGridMesh(xs, ys, z0, cols) {
    var nx = xs.length, ny = ys.length, X = [], Y = [], Z = [], I = [], J = [], K = [];
    for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) { X.push(xs[i]); Y.push(ys[j]); Z.push(z0); }
    for (var jj = 0; jj < ny - 1; jj++) for (var ii = 0; ii < nx - 1; ii++) {
        var a = jj * nx + ii, b = a + 1, c = a + nx, e = c + 1;
        I.push(a, a); J.push(b, e); K.push(e, c);
    }
    return { type: 'mesh3d', x: X, y: Y, z: Z, i: I, j: J, k: K, vertexcolor: cols, flatshading: true, opacity: 1,
             lighting: { ambient: 1, diffuse: 0, specular: 0, roughness: 1, fresnel: 0 },
             hoverinfo: 'skip', showscale: false, name: 'floor' };
}
function _vol3dQuiet(r, g, b) {
    var l = 0.299 * r + 0.587 * g + 0.114 * b, s = 0.35, w = 0.35;   // keep 35 % saturation, lift 35 % to white
    r = l + (r - l) * s; g = l + (g - l) * s; b = l + (b - l) * s;
    return 'rgb(' + Math.round(r + (255 - r) * w) + ',' + Math.round(g + (255 - g) * w) + ',' + Math.round(b + (255 - b) * w) + ')';
}

// Reflectivity footprint: column-max dBZ in the lowest 3 km, in greys.
function _vol3dDbzFloorTrace(g, z0) {
    var cols = [], nxy = g.nx * g.ny, kmax = 0;
    while (kmax < g.nz - 1 && g.zA[kmax + 1] <= 3) kmax++;
    for (var p = 0; p < nxy; p++) {
        var m = -99;
        for (var k = 0; k <= kmax; k++) m = Math.max(m, g.v[k * nxy + p]);
        cols.push(m >= 45 ? '#8d96a3' : m >= 40 ? '#adb5bf' : m >= 30 ? '#cdd2d9' : m >= 20 ? '#e3e6ea' : '#f4f5f7');
    }
    return _vol3dGridMesh(g.xA, g.yA, z0 - 0.02, cols);
}

var _vol3dFloorCache = { key: null, trace: null };
function _vol3dFloorTrace(xR, yR, z0) {
    var f = (_vol3dFloor !== 'none' && typeof window.vol3dFloorImage === 'function') ? window.vol3dFloorImage() : null;
    if (!f || !f.src) return Promise.resolve(null);
    var key = f.src.length + ':' + f.src.slice(-64) + ':' + xR + ':' + yR + ':' + z0;
    if (_vol3dFloorCache.key === key) return Promise.resolve(_vol3dFloorCache.trace);
    return new Promise(function (resolve) {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onerror = function () { resolve(null); };
        img.onload = function () {
            try {
                var cv = document.createElement('canvas');
                cv.width = img.naturalWidth; cv.height = img.naturalHeight;
                var ctx = cv.getContext('2d');
                ctx.drawImage(img, 0, 0);
                var px = ctx.getImageData(0, 0, cv.width, cv.height).data;
                var N = 110, xs = [], ys = [], cols = [];
                for (var i = 0; i < N; i++) xs.push(xR[0] + (xR[1] - xR[0]) * i / (N - 1));
                for (var j = 0; j < N; j++) ys.push(yR[0] + (yR[1] - yR[0]) * j / (N - 1));
                for (var jy = 0; jy < N; jy++) {
                    for (var ix = 0; ix < N; ix++) {
                        var u = (xs[ix] - f.x_min_km) / (f.x_max_km - f.x_min_km);
                        var v = (f.y_max_km - ys[jy]) / (f.y_max_km - f.y_min_km);
                        var col = '#f4f5f7';
                        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
                            var p = (Math.min(cv.height - 1, Math.floor(v * cv.height)) * cv.width +
                                     Math.min(cv.width - 1, Math.floor(u * cv.width))) * 4;
                            if (px[p + 3] > 0) col = _vol3dQuiet(px[p], px[p + 1], px[p + 2]);
                        }
                        cols.push(col);
                    }
                }
                var trace = _vol3dGridMesh(xs, ys, z0 - 0.02, cols);
                _vol3dFloorCache = { key: key, trace: trace };
                resolve(trace);
            } catch (e) { resolve(null); }   // tainted canvas etc. — just no floor
        };
        img.src = f.src;
    });
}

// Views row state; the single-variable controls are inert while a view is up.
function _vol3dSyncViewControls() {
    var row = document.getElementById('vol-views-row');
    if (row) row.style.display = _vol3dViewsAvailable() ? '' : 'none';
    var hasIR = typeof window.vol3dFloorImage === 'function' && !!window.vol3dFloorImage();
    var floorSel = document.getElementById('vol-floor');
    if (floorSel) {
        floorSel.value = _vol3dFloor;
        var dbzOpt = floorSel.querySelector('option[value="dbz"]');
        if (dbzOpt) dbzOpt.disabled = !_vol3dView;      // needs the view's reflectivity fetch
        var irOpt = floorSel.querySelector('option[value="ir"]');
        if (irOpt) irOpt.disabled = !hasIR;
    }
    var domSel = document.getElementById('vol-domain');
    if (domSel) { domSel.value = _vol3dDomain; domSel.disabled = !_vol3dView; }
    var dcl = document.getElementById('vol-declutter');
    if (dcl) { dcl.classList.toggle('active', _vol3dDeclutter); dcl.disabled = !_vol3dView; }
    var lvBtn = document.getElementById('vol-levels-btn');
    if (lvBtn) { lvBtn.disabled = !_vol3dView; lvBtn.classList.toggle('active', _vol3dLevelsOpen && !!_vol3dView); }
    var lvRow = document.getElementById('vol-levels-row');
    if (lvRow && !_vol3dView) lvRow.style.display = 'none';
    var shearBtn = document.getElementById('vol-cam-shear');
    if (shearBtn) shearBtn.disabled = !_vol3dCameraFor('shear');
    ['vol-iso-min', 'vol-iso-max', 'vol-surfaces', 'vol-opacity', 'vol-caps'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.disabled = !!_vol3dView;
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
    // Preset views keep the vortex axis + centre markers only: at a large RMW
    // the rings cover the whole core and fight the vorticity magentas.
    if (_vol3dView) {
        traces = traces.slice(0, 2);
        if (traces[1]) {
            traces[1].text = traces[1].z.map(function (h) {
                return Math.abs(h - 2) < 0.01 ? '2-km centre' : Math.abs(h - 6) < 0.01 ? '6-km centre' : '';
            });
            traces[1].textfont = { size: 10, color: '#4b5563' };
            traces[1].marker.showscale = false;
            delete traces[1].marker.colorbar;
        }
    }
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
