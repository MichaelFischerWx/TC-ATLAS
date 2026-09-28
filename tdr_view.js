/* tdr_view.js — shared TDR analysis view code (window.TDRView).
 *
 * ONE implementation of the tail-Doppler-radar view pieces used by both
 *   explorer.html    (TC-RADAR archive; tc_radar_app.js)
 *   realtime_ir.html (Recon → Tail Doppler Radar; realtime_tdr.js)
 * The real-time tab began as a hand port of the explorer and the copies drifted
 * (2026-09-28 consolidation). Everything here is page-agnostic: no element ids,
 * no page state — callers pass what a function needs. Load it BEFORE either
 * page script (explorer.html: defer, before tc_radar_app.js; realtime_ir.html:
 * first entry of _lazyViewMods.recon).
 */
(function () {
    'use strict';

    // ── Colormaps ────────────────────────────────────────────────────────
    // Named Plotly scales the canvas drape can reproduce; anything else that
    // arrives as a name falls back to Viridis (arrays pass through).
    var NAMED_CS = {
        Viridis: [[0,'rgb(68,1,84)'],[0.25,'rgb(59,82,139)'],[0.5,'rgb(33,145,140)'],[0.75,'rgb(94,201,98)'],[1,'rgb(253,231,37)']],
        Jet: [[0,'rgb(0,0,131)'],[0.125,'rgb(0,60,170)'],[0.375,'rgb(5,255,255)'],[0.625,'rgb(255,255,0)'],[0.875,'rgb(250,0,0)'],[1,'rgb(128,0,0)']],
        RdBu: [[0,'rgb(5,10,172)'],[0.35,'rgb(106,137,247)'],[0.5,'rgb(190,190,190)'],[0.6,'rgb(220,170,132)'],[0.7,'rgb(230,145,90)'],[1,'rgb(178,10,28)']],
        Portland: [[0,'rgb(12,51,131)'],[0.25,'rgb(10,136,186)'],[0.5,'rgb(242,211,56)'],[0.75,'rgb(242,143,56)'],[1,'rgb(217,30,30)']],
        Hot: [[0,'rgb(0,0,0)'],[0.3,'rgb(230,0,0)'],[0.6,'rgb(255,210,0)'],[1,'rgb(255,255,255)']],
        Greys: [[0,'rgb(0,0,0)'],[1,'rgb(255,255,255)']]
    };
    function csParse(s) {
        s = String(s).trim();
        var m = /rgba?\(([^)]+)\)/.exec(s);
        if (m) { var p = m[1].split(',').map(parseFloat); return [p[0] || 0, p[1] || 0, p[2] || 0]; }
        if (s[0] === '#') { var h = s.slice(1); if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
            return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; }
        return [128, 128, 128];
    }
    function csResolve(cs) {
        if (Array.isArray(cs)) return cs;
        if (typeof cs === 'string' && NAMED_CS[cs]) return NAMED_CS[cs];
        return NAMED_CS.Viridis;
    }
    /** One color for one value (linear interpolation between stops). */
    function csColor(cs, vmin, vmax, val) {
        var stops = csResolve(cs);
        var f = (vmax === vmin) ? 0 : (val - vmin) / (vmax - vmin);
        f = Math.max(0, Math.min(1, f));
        for (var i = 0; i < stops.length - 1; i++) {
            if (f >= stops[i][0] && f <= stops[i+1][0]) {
                var t = (stops[i+1][0] === stops[i][0]) ? 0 : (f - stops[i][0]) / (stops[i+1][0] - stops[i][0]);
                var a = csParse(stops[i][1]), b = csParse(stops[i+1][1]);
                return [Math.round(a[0]+t*(b[0]-a[0])), Math.round(a[1]+t*(b[1]-a[1])), Math.round(a[2]+t*(b[2]-a[2]))];
            }
        }
        return csParse(stops[stops.length - 1][1]);
    }
    /** 256-entry RGB lookup table (Uint8Array, 768) — build once per draw, not per cell. */
    function csLUT(cs) {
        var stops = csResolve(cs), lut = new Uint8Array(256 * 3), k = 0;
        for (var i = 0; i < 256; i++) {
            var f = i / 255;
            while (k < stops.length - 2 && f > stops[k + 1][0]) k++;
            var a = stops[k], b = stops[k + 1] || stops[k];
            var t = (b[0] === a[0]) ? 0 : Math.max(0, Math.min(1, (f - a[0]) / (b[0] - a[0])));
            var ca = csParse(a[1]), cb = csParse(b[1]);
            lut[i*3] = Math.round(ca[0] + t * (cb[0] - ca[0]));
            lut[i*3+1] = Math.round(ca[1] + t * (cb[1] - ca[1]));
            lut[i*3+2] = Math.round(ca[2] + t * (cb[2] - ca[2]));
        }
        return lut;
    }

    // ── Plan-view wind barbs ─────────────────────────────────────────────
    // Standard meteorological barbs on a Cartesian (km) grid, as Plotly line
    // shapes (the map drape reprojects the same shapes). Staff points INTO the
    // wind, feathers on the left; half = 5 kt, full = 10 kt, pennant = 50 kt.
    // barbData = { u:[[]], v:[[]], x:[], y:[], units:'m/s', type }
    // axRanges = { xMin, xMax, yMin, yMax }
    function windBarbShapes(barbData, axRanges) {
        var shapes = [];
        if (!barbData || !barbData.u || !barbData.v) return shapes;
        var uGrid = barbData.u, vGrid = barbData.v, xCoords = barbData.x, yCoords = barbData.y;
        var span = Math.max(axRanges.xMax - axRanges.xMin, axRanges.yMax - axRanges.yMin);
        if (span <= 0) return shapes;
        var staffLen = span * 0.04;              // ~4% of the axis span, in km
        var barbFrac = 0.38, gapFrac = 0.12;     // feather length / spacing (x staff)
        var flagWFrac = 0.38, flagHFrac = 0.18;  // 50-kt pennant width / height
        var lineColor = 'rgba(0,0,0,0.8)', lineWidth = 1.4;
        function mkLine(x0, y0, x1, y1) {
            return { type: 'line', xref: 'x', yref: 'y', x0: x0, y0: y0, x1: x1, y1: y1, line: { color: lineColor, width: lineWidth } };
        }
        for (var yi = 0; yi < uGrid.length; yi++) {
            for (var xi = 0; xi < uGrid[yi].length; xi++) {
                var uMs = uGrid[yi][xi], vMs = vGrid[yi][xi];
                if (uMs === null || vMs === null) continue;
                var spdKt = Math.sqrt(uMs * uMs + vMs * vMs) * 1.944;
                if (spdKt < 2.5) continue;       // calm
                var xBase = xCoords[xi], yBase = yCoords[yi];
                var dirRad = Math.atan2(-uMs, -vMs);   // direction the wind comes FROM
                var sinD = Math.sin(dirRad), cosD = Math.cos(dirRad);
                var xTip = xBase + staffLen * sinD, yTip = yBase + staffLen * cosD;
                shapes.push(mkLine(xBase, yBase, xTip, yTip));
                var remaining = Math.round(spdKt / 5) * 5;
                var nFlags = Math.floor(remaining / 50); remaining -= nFlags * 50;
                var nFull = Math.floor(remaining / 10); remaining -= nFull * 10;
                var nHalf = Math.floor(remaining / 5);
                var perpX = cosD, perpY = -sinD;       // left of the staff
                var barbLen = staffLen * barbFrac, barbGap = staffLen * gapFrac;
                var flagW = staffLen * flagWFrac, flagH = staffLen * flagHFrac;
                var featherPos = 0, frac, k;
                for (k = 0; k < nFlags; k++) {
                    frac = featherPos / staffLen;
                    var fx = xTip - (xTip - xBase) * frac, fy = yTip - (yTip - yBase) * frac;
                    var frac2 = (featherPos + flagH) / staffLen;
                    var fx2 = xTip - (xTip - xBase) * frac2, fy2 = yTip - (yTip - yBase) * frac2;
                    var midFrac = (featherPos + flagH * 0.5) / staffLen;
                    var outX = xTip - (xTip - xBase) * midFrac + flagW * perpX;
                    var outY = yTip - (yTip - yBase) * midFrac + flagW * perpY;
                    shapes.push(mkLine(fx, fy, outX, outY));
                    shapes.push(mkLine(outX, outY, fx2, fy2));
                    featherPos += flagH + barbGap * 0.3;
                }
                for (k = 0; k < nFull; k++) {
                    frac = featherPos / staffLen;
                    var bx = xTip - (xTip - xBase) * frac, by = yTip - (yTip - yBase) * frac;
                    shapes.push(mkLine(bx, by, bx + barbLen * perpX, by + barbLen * perpY));
                    featherPos += barbGap;
                }
                for (k = 0; k < nHalf; k++) {
                    frac = featherPos / staffLen;
                    var hx = xTip - (xTip - xBase) * frac, hy = yTip - (yTip - yBase) * frac;
                    shapes.push(mkLine(hx, hy, hx + barbLen * 0.55 * perpX, hy + barbLen * 0.55 * perpY));
                    featherPos += barbGap;
                }
            }
        }
        return shapes;
    }

    // ── Max / min / center markers ───────────────────────────────────────
    function findDataMax(zData, xCoords, yCoords) {
        var maxVal = -Infinity, maxI = 0, maxJ = 0;
        for (var i = 0; i < zData.length; i++) {
            if (!zData[i]) continue;
            for (var j = 0; j < zData[i].length; j++) {
                var v = zData[i][j];
                if (v !== null && v !== undefined && isFinite(v) && v > maxVal) { maxVal = v; maxI = i; maxJ = j; }
            }
        }
        if (!isFinite(maxVal)) return null;
        return { value: maxVal, x: xCoords[maxJ], y: yCoords[maxI] };
    }
    function findDataMin(zData, xCoords, yCoords) {
        var minVal = Infinity, minI = 0, minJ = 0;
        for (var i = 0; i < zData.length; i++) {
            if (!zData[i]) continue;
            for (var j = 0; j < zData[i].length; j++) {
                var v = zData[i][j];
                if (v !== null && v !== undefined && isFinite(v) && v < minVal) { minVal = v; minI = i; minJ = j; }
            }
        }
        if (!isFinite(minVal)) return null;
        return { value: minVal, x: xCoords[minJ], y: yCoords[minI] };
    }
    function isWindVariable(varName) {
        return !!varName && varName.toLowerCase().indexOf('wind') !== -1;
    }
    function maxMarkerTrace(maxInfo, units) {
        if (!maxInfo) return null;
        return {
            x: [maxInfo.x], y: [maxInfo.y], type: 'scatter', mode: 'markers',
            marker: { symbol: 'x', size: 10, color: 'white', line: { color: 'rgba(0,0,0,0.6)', width: 1.5 } },
            hoverinfo: 'text',
            hovertext: ['Max: ' + maxInfo.value.toFixed(2) + ' ' + units + '\n@ (' + maxInfo.x.toFixed(0) + ', ' + maxInfo.y.toFixed(0) + ')'],
            showlegend: false
        };
    }
    /** 'Max: …' label, top-left of the paper (clear of the centered title,
     *  the top-right modebar and the x-axis ticks). */
    function maxAnnotation(maxInfo, units, xLabel, yLabel, fontSize) {
        if (!maxInfo) return null;
        return {
            text: '<b>Max:</b> ' + maxInfo.value.toFixed(2) + ' ' + units +
                  '  @  ' + xLabel + '=' + maxInfo.x.toFixed(0) + ', ' + yLabel + '=' + (Math.abs(maxInfo.y) < 100 ? maxInfo.y.toFixed(1) : maxInfo.y.toFixed(0)),
            xref: 'paper', yref: 'paper', x: 0.01, y: 0.99, xanchor: 'left', yanchor: 'top', showarrow: false,
            font: { color: '#0f1623', size: fontSize || 9, family: 'DM Sans, sans-serif' },
            bgcolor: 'rgba(255,255,255,0.85)', borderpad: 3, bordercolor: 'rgba(15, 22, 35,0.15)', borderwidth: 1
        };
    }
    /** Cross at the storm-relative origin; hover gives the center lat/lon.
     *  `extra` merges extra trace fields (e.g. {_isMW:true}). */
    function tcCenterMarkerTrace(lat, lon, extra) {
        if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return null;
        var posStr = Math.abs(lat).toFixed(3) + '°' + (lat >= 0 ? 'N' : 'S') + ', ' +
                     Math.abs(lon).toFixed(3) + '°' + (lon >= 0 ? 'E' : 'W');
        var trace = {
            x: [0], y: [0], type: 'scatter', mode: 'markers',
            marker: { symbol: 'cross', size: 14, color: '#ffffff', line: { color: '#000000', width: 1 } },
            hovertemplate: '<b>TC Center</b><br>Lat/Lon: ' + posStr + '<extra></extra>',
            showlegend: false, name: 'TC Center'
        };
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) trace[k] = extra[k];
        return trace;
    }

    // ── Contour overlay (second variable as line contours) ───────────────
    // interval: user value (NaN / <= 0 → auto, ~10 levels over the data range).
    function overlayContours(json, x, y, isCS, interval) {
        if (!json.overlay) return [];
        var ov = json.overlay, ovData = isCS ? ov.cross_section : ov.data;
        if (!ovData) return [];
        try {
            if (isNaN(interval) || interval <= 0) {
                var flat = ovData.flat().filter(function (v) { return v !== null && !isNaN(v); });
                if (flat.length === 0) return [];
                var mn = Infinity, mx = -Infinity;
                for (var i = 0; i < flat.length; i++) { if (flat[i] < mn) mn = flat[i]; if (flat[i] > mx) mx = flat[i]; }
                interval = parseFloat(((mx - mn) / 10).toPrecision(1));
                if (!isFinite(interval) || interval <= 0) interval = (mx - mn) / 10 || 1;
            }
            var base = { z: ovData, x: isCS ? json.distance_km : x, y: isCS ? json.height_km : y, type: 'contour',
                showscale: false, hoverongaps: false,
                contours: { coloring: 'none', showlabels: true, labelfont: { size: 9, color: 'rgba(15, 22, 35,0.8)' } } };
            var hov = '<b>' + ov.display_name + '</b>: %{z:.2f} ' + ov.units + '<extra>contour</extra>';
            var traces = [];
            if (ov.vmax > interval) traces.push(Object.assign({}, base, { contours: Object.assign({}, base.contours, { start: interval, end: ov.vmax, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'solid' }, hovertemplate: hov, name: ov.display_name + ' (+)', showlegend: false }));
            if (ov.vmin < -interval) traces.push(Object.assign({}, base, { contours: Object.assign({}, base.contours, { start: ov.vmin, end: -interval, size: interval }), line: { color: 'rgba(0,0,0,0.7)', width: 1.2, dash: 'dash' }, hovertemplate: hov, name: ov.display_name + ' (−)', showlegend: false }));
            return traces;
        } catch (e) { console.warn('Contour overlay error:', e); return []; }
    }

    /** Line contours of an arbitrary 2-D overlay field (az-mean / quadrant
     *  panels carry the overlay under a different key than plan / CS). */
    function contourTraces(ov, ovData, x, y, interval) {
        if (!ov || !ovData) return [];
        return overlayContours({ overlay: Object.assign({}, ov, { data: ovData }) }, x, y, false, interval);
    }

    // ── Plan view (storm-relative x/y km) ────────────────────────────────
    function hasAnyData(z) {
        if (!z) return false;
        for (var i = 0; i < z.length; i++) {
            var r = z[i]; if (!r) continue;
            for (var j = 0; j < r.length; j++) { var v = r[j]; if (v !== null && v !== undefined && !isNaN(v)) return true; }
        }
        return false;
    }
    // o = { z, x, y, varInfo, colorscale, zmin, zmax, title, hasOverlay,
    //       rmw: { r, cx, cy } (dashed circle, km), barbs, overlayTraces, windMarker }
    // Returns { heatmap, overlayTraces, maxTraces, barbShapes, layout (panel, with
    // title), baseLayout (no title — the fullscreen view adds its own), config }.
    function planFigure(o) {
        var vi = o.varInfo;
        var heatmap = { z: o.z, x: o.x, y: o.y, type: 'heatmap', colorscale: o.colorscale, zmin: o.zmin, zmax: o.zmax,
            colorbar: { title: { text: vi.units, font: { color: '#5b6573', size: 10 } }, tickfont: { color: '#5b6573', size: 9 }, thickness: 12, len: 0.85 },
            hovertemplate: '<b>' + vi.display_name + '</b>: %{z:.2f} ' + vi.units + '<br>X: %{x:.0f} km<br>Y: %{y:.0f} km<extra></extra>',
            hoverongaps: false };
        var shapes = [];
        if (o.rmw && o.rmw.r && !isNaN(o.rmw.r)) {
            var cx = o.rmw.cx || 0, cy = o.rmw.cy || 0, r = o.rmw.r;
            shapes.push({ type: 'circle', xref: 'x', yref: 'y', x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r, line: { color: 'white', width: 1.5, dash: 'dash' } });
        }
        var barbShapes = o.barbs ? windBarbShapes(o.barbs, { xMin: o.x[0], xMax: o.x[o.x.length - 1], yMin: o.y[0], yMax: o.y[o.y.length - 1] }) : [];
        var ax = function (t, extra) { return Object.assign({ title: { text: t, font: { color: '#5b6573', size: 10 } }, tickfont: { color: '#5b6573', size: 9 }, gridcolor: 'rgba(15, 22, 35,0.22)', zeroline: false, range: [-250, 250] }, extra || {}); };
        var baseLayout = { paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
            xaxis: ax('Eastward distance (km)', { scaleanchor: 'y' }), yaxis: ax('Northward distance (km)'),
            shapes: shapes.concat(barbShapes), annotations: [],
            hoverlabel: { bgcolor: '#ffffff', font: { color: '#0f1623', size: 12 } }, showlegend: false };
        var maxTraces = [], mi = findDataMax(o.z, o.x, o.y);
        if (mi) {
            baseLayout.annotations.push(maxAnnotation(mi, vi.units, 'X', 'Y', 9));
            if (o.windMarker) maxTraces.push(maxMarkerTrace(mi, vi.units));
        }
        var layout = Object.assign({}, baseLayout, {
            title: { text: o.title, font: { color: '#0f1623', size: 11 }, y: 0.965, x: 0.5, xanchor: 'center', yanchor: 'top' },
            margin: { l: 52, r: 16, t: o.hasOverlay ? 90 : 78, b: 44 },
            shapes: baseLayout.shapes.slice(), annotations: baseLayout.annotations.slice()
        });
        return { heatmap: heatmap, overlayTraces: o.overlayTraces || [], maxTraces: maxTraces, barbShapes: barbShapes,
                 layout: layout, baseLayout: baseLayout,
                 config: { responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toggleSpikelines'], displaylogo: false } };
    }
    /** Two-line plan-view title. frameTag: e.g. ' · storm-relative'. */
    function planTitle(stormLine, varInfo, levelKm, json, frameTag) {
        var lvl = varInfo.key === 'sear_10m' ? '10 m' : (levelKm != null ? levelKm.toFixed(1) + ' km' : '');
        return stormLine + '<br>' + varInfo.display_name + ' @ ' + lvl + (frameTag || '') + sectionTitleOverlay(json);
    }
    // Strip above the panes: shear/motion compass + 'Cat 3 100 kt · RMW · Tilt'.
    // o = { vmax, rmw, tilt, sddc (downshear), shdc, motionDir, motionSpd, sddcDisplay }
    function metaStripHTML(o) {
        var compass = shearCompassHTML(o.sddc, o.shdc, o.motionDir, o.motionSpd, o.sddcDisplay);
        var parts = [];
        if (o.vmax) parts.push('<span style="color:' + intensityColor(o.vmax) + ';">' + intensityCategory(o.vmax) + '</span> ' + o.vmax + ' kt');
        if (o.rmw != null) parts.push('RMW ' + o.rmw + ' km');
        if (o.tilt != null) parts.push('Tilt ' + o.tilt + ' km');
        var text = parts.length ? '<span class="meta-text">' + parts.join('  &middot;  ') + '</span>' : '';
        return (compass || text) ? '<div class="dual-panel-strip">' + compass + text + '</div>' : '';
    }
    /** Plan view (left) + azimuthal-mean placeholder (right). ids: prefix ''
     *  (explorer) or 'rt-'; onExpand/onToggle/onSave are global function names. */
    function dualPanelHTML(p, o) {
        var btn = 'position:absolute;top:6px;z-index:10;background:rgba(15, 22, 35,0.08);border:none;color:#5b6573;width:28px;height:28px;border-radius:5px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;';
        var hov = ' onmouseover="this.style.background=\'rgba(15, 22, 35,0.2)\'" onmouseout="this.style.background=\'rgba(15, 22, 35,0.08)\'"';
        return '<div class="dual-panel-wrap" id="' + p + 'dual-panel-wrap">' +
            '<div class="dual-pane" id="' + p + 'dual-pane-left">' +
                '<div class="dual-pane-label">Plan View</div>' +
                '<div class="dual-pane-inner" style="position:relative;">' +
                    '<div id="' + p + 'plotly-chart" style="width:100%;height:100%;min-height:360px;"></div>' +
                    '<button onclick="' + o.onExpand + '()" title="Expand to fullscreen" style="' + btn + 'left:6px;font-size:16px;"' + hov + '>⛶</button>' +
                    (o.onSave ? '<button onclick="' + o.onSave + '()" title="Download this plan view as a PNG (branded)" style="' + btn + 'right:6px;font-size:15px;"' + hov + '><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>' : '') +
                '</div>' +
            '</div>' +
            '<div class="dual-pane-divider" title="Toggle azimuthal mean panel" onclick="' + o.onToggle + '()"></div>' +
            '<div class="dual-pane" id="' + p + 'dual-pane-right">' +
                '<div class="dual-pane-label">Azimuthal Mean</div>' +
                '<div class="dual-pane-inner" id="' + p + 'dual-az-container">' +
                    '<div class="az-pane-placeholder" id="' + p + 'dual-az-placeholder">Generating azimuthal mean…</div>' +
                '</div>' +
            '</div>' +
        '</div>' +
        '<div id="' + p + 'plan-hint" style="font-size:11px;color:var(--slate);text-align:center;margin-top:4px;">Hover for values · scroll to zoom · drag to pan · ⛶ expand</div>';
    }
    function noDataHTML(stormName, varName, levelKm) {
        return '<div class="explorer-status info" style="padding:18px 16px;text-align:center;line-height:1.5;">' +
            '<div style="font-size:1.05rem;font-weight:600;color:var(--text-strong, #0f1623);margin-bottom:6px;">No radar data available</div>' +
            '<div style="font-size:0.85rem;color:var(--slate);">' + (stormName || 'this case') + ' has no valid samples for <strong>' +
            (varName || 'the selected variable') + '</strong>' + (levelKm != null ? ' at ' + levelKm.toFixed(1) + ' km' : '') + '.<br>' +
            'Try a different height level, variable, or case.</div></div>';
    }

    // ── Radius/distance × height section figure ──────────────────────────
    // Shared by the cross-section and azimuthal-mean panels on both pages.
    // o = { z, x, y, varInfo, colorscale, zmin, zmax, title, xTitle,
    //       size: 'small' | 'dual' | 'full', maxLabels: ['R','Z'],
    //       windMarker: bool, overlayTraces, rmwX (vertical dashed line),
    //       inset: {shapes, annotations}, margin }
    // Returns { traces, layout }.
    var SECTION_FONTS = {
        small: { title: 10, axis: 9, tick: 8, cbar: 9, cbarTick: 8, hover: 11, max: 8, cbw: 10, ty: 0.96 },
        dual:  { title: 11, axis: 10, tick: 9, cbar: 10, cbarTick: 9, hover: 11, max: 9, cbw: 12, ty: 0.94 },
        full:  { title: 13, axis: 12, tick: 10, cbar: 12, cbarTick: 10, hover: 13, max: 10, cbw: 14, ty: 0.93 }
    };
    function sectionFigure(o) {
        var f = SECTION_FONTS[o.size || 'small'], vi = o.varInfo, isX = o.xTitle || 'Radius (km)';
        var xl = (o.maxLabels || ['R', 'Z']);
        var heatmap = { z: o.z, x: o.x, y: o.y, type: 'heatmap', colorscale: o.colorscale,
            zmin: o.zmin != null ? o.zmin : vi.vmin, zmax: o.zmax != null ? o.zmax : vi.vmax,
            colorbar: { title: { text: vi.units, font: { color: '#5b6573', size: f.cbar } }, tickfont: { color: '#5b6573', size: f.cbarTick }, thickness: f.cbw, len: 0.85 },
            hovertemplate: '<b>' + vi.display_name + '</b>: %{z:.2f} ' + vi.units + '<br>' + (xl[0] === 'R' ? 'Radius' : 'Distance') + ': %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>',
            hoverongaps: false };
        var ax = function (t) { return { title: { text: t, font: { color: '#5b6573', size: f.axis } }, tickfont: { color: '#5b6573', size: f.tick }, gridcolor: 'rgba(15, 22, 35,0.22)', zeroline: false }; };
        var layout = {
            title: { text: o.title, font: { color: '#0f1623', size: f.title }, y: f.ty, x: 0.5, xanchor: 'center', yanchor: 'top' },
            paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
            xaxis: ax(isX), yaxis: ax('Height (km)'),
            margin: o.margin || { l: 45, r: 12, t: 44, b: 38 },
            shapes: [], annotations: [],
            hoverlabel: { bgcolor: '#ffffff', font: { color: '#0f1623', size: f.hover } },
            showlegend: false
        };
        if (o.rmwX && !isNaN(o.rmwX)) layout.shapes.push({ type: 'line', xref: 'x', yref: 'paper', x0: o.rmwX, x1: o.rmwX, y0: 0, y1: 1, line: { color: 'white', width: 1.5, dash: 'dash' } });
        var traces = [heatmap].concat(o.overlayTraces || []);
        var mi = findDataMax(o.z, o.x, o.y);
        if (mi) {
            layout.annotations.push(maxAnnotation(mi, vi.units, xl[0], xl[1], f.max));
            if (o.windMarker) traces.push(maxMarkerTrace(mi, vi.units));
        }
        if (o.inset) {
            layout.annotations = layout.annotations.concat(o.inset.annotations || []);
            layout.shapes = layout.shapes.concat(o.inset.shapes || []);
        }
        return { traces: traces, layout: layout };
    }
    function sectionTitleOverlay(json) {
        return json.overlay ? '<br><span style="font-size:0.85em;color:#9ca3af;">Contours: ' + json.overlay.display_name + ' (' + json.overlay.units + ')</span>' : '';
    }

    // ── Shear / motion insets for Plotly panels ─────────────────────────
    // Compact direction label (cross-section / azimuthal-mean panels).
    function shearInsetCS(sddc, isFullsize, shdc) {
        if (sddc === null || sddc === undefined || sddc === 9999) return { shapes: [], annotations: [] };
        var txt = '<b>Shear: ' + sddc.toFixed(0) + '°' +
            ((shdc !== null && shdc !== undefined && shdc !== 9999) ? ' (' + shdc.toFixed(0) + ' kt)' : '') + '</b>';
        return { shapes: [], annotations: [{ text: txt, xref: 'paper', yref: 'paper', x: 0.01, y: 1.0,
            xanchor: 'left', yanchor: 'bottom', showarrow: false,
            font: { color: '#f59e0b', size: isFullsize ? 10 : 8, family: 'JetBrains Mono, monospace' },
            bgcolor: 'rgba(10,22,40,0.8)', borderpad: 2, bordercolor: 'rgba(245,158,11,0.3)', borderwidth: 1 }] };
    }
    // Arrow compass (downshear + heading) in paper coords, top-left.
    function shearInset(sddc, isFullsize, shdc, motionDir, motionSpd) {
        var hasShear = (sddc !== null && sddc !== undefined && sddc !== 9999);
        var hasMotion = (motionDir !== null && motionDir !== undefined && motionDir !== 9999);
        if (!hasShear && !hasMotion) return { shapes: [], annotations: [] };
        var cx = isFullsize ? 0.09 : 0.12, cy = 0.92, r = isFullsize ? 0.060 : 0.075;
        var arrowLen = r * 0.85, dotR = r * 0.07, lw = 2.5, fsL = isFullsize ? 12 : 10, labelGap = isFullsize ? 0.038 : 0.032;
        var shapes = [
            { type: 'circle', xref: 'paper', yref: 'paper', x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r,
              fillcolor: 'rgba(10,22,40,0.80)', line: { color: 'rgba(15, 22, 35,0.15)', width: 1 } },
            { type: 'circle', xref: 'paper', yref: 'paper', x0: cx - dotR, y0: cy - dotR, x1: cx + dotR, y1: cy + dotR,
              fillcolor: 'rgba(15, 22, 35,0.4)', line: { width: 0 } }
        ];
        var annotations = [];
        function arrow(theta, color) {
            var adx = arrowLen * Math.cos(theta), ady = arrowLen * Math.sin(theta);
            shapes.push({ type: 'line', xref: 'paper', yref: 'paper', x0: cx - adx * 0.25, y0: cy - ady * 0.25, x1: cx + adx, y1: cy + ady, line: { color: color, width: lw } });
            var hl = arrowLen * 0.32, ha = 25 * Math.PI / 180, tx = cx + adx, ty = cy + ady;
            shapes.push({ type: 'line', xref: 'paper', yref: 'paper', x0: tx, y0: ty, x1: tx + hl * Math.cos(theta + Math.PI - ha), y1: ty + hl * Math.sin(theta + Math.PI - ha), line: { color: color, width: lw } });
            shapes.push({ type: 'line', xref: 'paper', yref: 'paper', x0: tx, y0: ty, x1: tx + hl * Math.cos(theta + Math.PI + ha), y1: ty + hl * Math.sin(theta + Math.PI + ha), line: { color: color, width: lw } });
        }
        if (hasShear) arrow((90 - sddc) * Math.PI / 180, '#f59e0b');
        if (hasMotion) arrow((90 - motionDir) * Math.PI / 180, '#22d3ee');
        if (hasShear) {
            var shrTxt = '<b>Shear</b>  ';
            if (shdc !== null && shdc !== undefined && shdc !== 9999) shrTxt += shdc.toFixed(0) + ' kt / ';
            shrTxt += sddc.toFixed(0) + '°';
            annotations.push({ text: shrTxt, xref: 'paper', yref: 'paper', x: cx, y: cy + r + labelGap, showarrow: false,
                font: { color: '#f59e0b', size: fsL, family: 'JetBrains Mono, monospace' }, bgcolor: 'rgba(10,22,40,0.7)', borderpad: 2 });
        }
        if (hasMotion) {
            var motTxt = '<b>Motion</b>  ';
            if (motionSpd !== null && motionSpd !== undefined && motionSpd !== 9999) motTxt += motionSpd.toFixed(0) + ' kt / ';
            motTxt += motionDir.toFixed(0) + '°';
            annotations.push({ text: motTxt, xref: 'paper', yref: 'paper', x: cx, y: hasShear ? cy - r - labelGap : cy + r + labelGap, showarrow: false,
                font: { color: '#22d3ee', size: fsL, family: 'JetBrains Mono, monospace' }, bgcolor: 'rgba(10,22,40,0.7)', borderpad: 2 });
        }
        return { shapes: shapes, annotations: annotations };
    }

    /** Theme-aware Plotly gridline color (TCATheme --plot-grid). */
    function themeGrid() {
        try { var v = window.TCATheme && window.TCATheme.readVar('--plot-grid'); if (v) return v; } catch (e) {}
        return 'rgba(15,22,35,0.08)';
    }

    // ── CFAD (contoured frequency by altitude diagram) ───────────────────
    // o = { fullsize, subtitle (string after the storm name) }. json._logScale → log10.
    var CFAD_CS = [[0, 'rgba(10,10,30,0)'], [0.01, '#1a1a4e'], [0.05, '#2d1b69'], [0.10, '#4a0e7f'], [0.20, '#7b2a8e'],
                   [0.35, '#b84e8e'], [0.50, '#e0735e'], [0.70, '#f5a623'], [0.85, '#f5d76e'], [1.0, '#fafafa']];
    function cfadFigure(json, o) {
        o = o || {};
        var vi = json.variable, meta = json.case_meta || {}, useLog = !!json._logScale, normLabel = json.norm_label;
        var z = useLog ? json.cfad.map(function (row) { return row.map(function (v) { return v > 0 ? Math.log10(v) : null; }); }) : json.cfad;
        var title = (meta.storm_name || '') + (o.subtitle || '') + '<br>CFAD: ' + vi.display_name + ' (' + vi.units + ')' + (useLog ? ' [log scale]' : '');
        var head = '<b>' + vi.display_name + ':</b> %{x:.2f} ' + vi.units + '<br><b>Height:</b> %{y:.1f} km<br>';
        var trace = { z: z, x: json.bin_centers, y: json.height_km, type: 'heatmap', colorscale: CFAD_CS,
            colorbar: { title: { text: useLog ? 'log₁₀(' + normLabel + ')' : normLabel, font: { color: '#5b6573', size: 11 } },
                        tickfont: { color: '#5b6573', size: 10 }, thickness: 12, len: 0.7 },
            hoverongaps: false,
            hovertemplate: head + (useLog ? '<b>log₁₀(Freq):</b> %{z:.2f}' : '<b>Freq:</b> %{z:.2f}' + (json.normalise === 'raw' ? '' : '%')) + '<extra></extra>' };
        var g = themeGrid();
        var layout = {
            title: { text: title, font: { color: '#0f1623', size: o.fullsize ? 15 : 13 }, x: 0.5 },
            xaxis: { title: { text: vi.display_name + ' (' + vi.units + ')', font: { color: '#5b6573', size: 12 } }, color: '#5b6573', gridcolor: g, zeroline: true, zerolinecolor: g },
            yaxis: { title: { text: 'Height (km)', font: { color: '#5b6573', size: 12 } }, color: '#5b6573', gridcolor: g },
            paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: '#ffffff',
            margin: o.fullsize ? { t: 50, b: 50, l: 55, r: 20 } : { t: 50, b: 45, l: 50, r: 10 },
            font: { family: 'JetBrains Mono, monospace' }
        };
        return { traces: [trace], layout: layout };
    }

    // ── Z* anomaly on the hybrid R_H axis (Fischer et al. 2025) ─────────
    // d = { anomaly, r_h_axis, n_inner, height_km, colorscale? }
    // o = { title (null = none, header lives in the page), fullsize, citation, margin }
    var ANOM_CS = [[0.0, 'rgb(5,48,97)'], [0.1, 'rgb(33,102,172)'], [0.2, 'rgb(67,147,195)'], [0.3, 'rgb(146,197,222)'],
                   [0.4, 'rgb(209,229,240)'], [0.5, 'rgb(247,247,247)'], [0.6, 'rgb(253,219,199)'], [0.7, 'rgb(244,165,130)'],
                   [0.8, 'rgb(214,96,77)'], [0.9, 'rgb(178,24,43)'], [1.0, 'rgb(103,0,31)']];
    var FISCHER_2025 = { text: 'Fischer et al. (2025, MWR) | doi:10.1175/MWR-D-24-0118.1', xref: 'paper', yref: 'paper',
        x: 1.0, y: -0.01, xanchor: 'right', yanchor: 'top', showarrow: false, font: { color: 'rgba(150,150,150,0.5)', size: 8 } };
    function anomalyFigure(d, o) {
        o = o || {};
        var f = o.fullsize ? { title: 13, axis: 12, tick: 10, cbar: 12, cbarTick: 10 } : { title: 10, axis: 9, tick: 8, cbar: 9, cbarTick: 8 };
        var rH = d.r_h_axis, nInner = d.n_inner, xIdx = [];
        for (var i = 0; i < rH.length; i++) xIdx.push(i);
        var ticks = hybridXAxis(rH, nInner);
        var trace = { z: d.anomaly, x: xIdx, y: d.height_km, type: 'heatmap',
            colorscale: d.colorscale || ANOM_CS, zmin: -3, zmax: 3, zmid: 0,
            colorbar: { title: { text: 'σ', font: { color: '#5b6573', size: f.cbar } }, tickfont: { color: '#5b6573', size: f.cbarTick },
                        thickness: o.fullsize ? 14 : 10, len: 0.85, tickvals: [-3, -2, -1, 0, 1, 2, 3] },
            hoverongaps: false,
            hovertemplate: '<b>Z*</b>: %{z:.2f}σ<br>Rₕ: %{customdata}<br>Height: %{y:.1f} km<extra></extra>',
            customdata: d.height_km.map(function () {
                return rH.map(function (v, idx) { return idx < nInner ? (v.toFixed(2) + ' R/RMW') : ('+' + v.toFixed(0) + ' km'); });
            }) };
        var ax = function (t) { return { title: { text: t, font: { color: '#5b6573', size: f.axis } }, tickfont: { color: '#5b6573', size: f.tick }, gridcolor: 'rgba(15, 22, 35,0.22)', zeroline: false }; };
        var layout = {
            paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
            xaxis: Object.assign(ax('Rₕ (inner: R/RMW | outer: RMW + km)'), { tickvals: ticks.tickvals, ticktext: ticks.ticktext }),
            yaxis: Object.assign(ax('Height (km)'), { range: [0, 15] }),
            shapes: nInner > 0 ? [{ type: 'line', xref: 'x', yref: 'paper', x0: nInner, x1: nInner, y0: 0, y1: 1, line: { color: 'rgba(15, 22, 35,0.5)', width: 1.5, dash: 'dash' } }] : [],
            margin: o.margin || (o.title ? (o.fullsize ? { l: 55, r: 24, t: 112, b: 46 } : { l: 45, r: 12, t: 78, b: 38 }) : { l: 45, r: 12, t: 8, b: 40 }),
            annotations: o.citation ? [FISCHER_2025] : [],
            hoverlabel: { bgcolor: '#ffffff', font: { color: '#0f1623', size: 11 } },
            showlegend: false
        };
        if (o.title) layout.title = { text: o.title, font: { color: '#0f1623', size: f.title }, y: o.fullsize ? 0.93 : 0.96, x: 0.5, xanchor: 'center', yanchor: 'top' };
        return { traces: [trace], layout: layout };
    }

    // ── Shear-relative quadrant means (4 panels, downshear to the right) ─
    // json = { quadrant_means:{USL,DSL,USR,DSR:{data}}, radius_km, height_km, overlay? }
    // o = { varInfo, colorscale, zmin, zmax, rmw, sddc (downshear heading), title,
    //       fullsize, contourInterval }
    function quadrantFigure(json, o) {
        var vi = o.varInfo, fs = !!o.fullsize, R = json.radius_km, H = json.height_km;
        var f = fs ? { title: 14, axis: 11, tick: 10, cbar: 11, cbarTick: 10, hover: 12, panel: 12 }
                   : { title: 11, axis: 9, tick: 8, cbar: 9, cbarTick: 8, hover: 10, panel: 10 };
        var zmin = o.zmin != null ? o.zmin : vi.vmin, zmax = o.zmax != null ? o.zmax : vi.vmax;
        // USL top-left, DSL top-right, USR bottom-left, DSR bottom-right (westerly-shear view)
        var panels = [{ key: 'USL', label: 'Upshear Left', row: 0, col: 0 }, { key: 'DSL', label: 'Downshear Left', row: 0, col: 1 },
                      { key: 'USR', label: 'Upshear Right', row: 1, col: 0 }, { key: 'DSR', label: 'Downshear Right', row: 1, col: 1 }];
        var quadColors = { DSL: '#f59e0b', DSR: '#f59e0b', USL: '#60a5fa', USR: '#60a5fa' };
        var gap = fs ? 0.08 : 0.10, cbarW = 0.04, leftM = 0.06, rightM = 0.02 + cbarW + 0.02;
        var topM = fs ? 0.10 : 0.12, botM = 0.06;
        var pw = (1 - leftM - rightM - gap) / 2, ph = (1 - topM - botM - gap) / 2;
        var traces = [], annotations = [], shapes = [];
        var layout = {
            paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
            margin: fs ? { l: 55, r: 70, t: 100, b: 50 } : { l: 45, r: 55, t: 84, b: 42 },
            showlegend: false, hoverlabel: { bgcolor: '#ffffff', font: { color: '#0f1623', size: f.hover } }
        };
        var ov = json.overlay, interval = o.contourInterval;
        panels.forEach(function (p, i) {
            var sfx = i === 0 ? '' : String(i + 1);
            var x0 = leftM + p.col * (pw + gap), x1 = x0 + pw;
            var yTop = 1 - topM - p.row * ph - p.row * gap, yBot = yTop - ph;
            layout['xaxis' + sfx] = { domain: [x0, x1], anchor: 'y' + sfx, tickfont: { color: '#5b6573', size: f.tick }, gridcolor: 'rgba(15, 22, 35,0.22)', zeroline: false,
                title: p.row === 1 ? { text: 'Radius (km)', font: { color: '#5b6573', size: f.axis } } : undefined };
            layout['yaxis' + sfx] = { domain: [yBot, yTop], anchor: 'x' + sfx, tickfont: { color: '#5b6573', size: f.tick }, gridcolor: 'rgba(15, 22, 35,0.22)', zeroline: false,
                title: p.col === 0 ? { text: 'Height (km)', font: { color: '#5b6573', size: f.axis } } : undefined };
            var q = json.quadrant_means[p.key];
            if (!q || !q.data) return;
            var showCbar = (i === 1);
            traces.push({ z: q.data, x: R, y: H, type: 'heatmap', colorscale: o.colorscale, zmin: zmin, zmax: zmax,
                xaxis: 'x' + sfx, yaxis: 'y' + sfx, showscale: showCbar,
                colorbar: showCbar ? { title: { text: vi.units, font: { color: '#5b6573', size: f.cbar } }, tickfont: { color: '#5b6573', size: f.cbarTick },
                                       thickness: fs ? 14 : 10, len: 0.85, x: 1.02, y: 0.5 } : undefined,
                hovertemplate: '<b>' + p.label + '</b><br>' + vi.display_name + ': %{z:.2f} ' + vi.units + '<br>Radius: %{x:.0f} km<br>Height: %{y:.1f} km<extra></extra>',
                hoverongaps: false });
            annotations.push({ text: '<b>' + p.label + '</b>', xref: 'paper', yref: 'paper', x: (x0 + x1) / 2, y: yTop + 0.005,
                xanchor: 'center', yanchor: 'bottom', showarrow: false,
                font: { color: quadColors[p.key], size: f.panel, family: 'JetBrains Mono, monospace' }, bgcolor: 'rgba(10,22,40,0.7)', borderpad: 2 });
            if (o.rmw && !isNaN(o.rmw)) shapes.push({ type: 'line', xref: 'x' + sfx, yref: 'y' + sfx, x0: o.rmw, x1: o.rmw,
                y0: H[0], y1: H[H.length - 1], line: { color: 'white', width: 1, dash: 'dash' } });
            var ovQ = ov && ov.quadrant_means && ov.quadrant_means[p.key];
            if (ovQ && ovQ.data) {
                contourTraces(ov, ovQ.data, R, H, interval).forEach(function (t) {
                    t.xaxis = 'x' + sfx; t.yaxis = 'y' + sfx; t.line.width = 1; t.contours.labelfont = { size: 8, color: 'rgba(15, 22, 35,0.7)' };
                    traces.push(t);
                });
            }
        });
        // Downshear arrow in the gap between the panels
        var sddc = o.sddc;
        if (sddc !== null && sddc !== undefined && sddc !== 9999) {
            var icx = leftM + pw + gap / 2, icy = botM + ph + gap / 2, ir = Math.min(gap, 0.06) * 0.55;
            var th = (90 - sddc) * Math.PI / 180, al = ir * 0.8, adx = al * Math.cos(th), ady = al * Math.sin(th);
            shapes.push({ type: 'circle', xref: 'paper', yref: 'paper', x0: icx - ir, y0: icy - ir, x1: icx + ir, y1: icy + ir,
                fillcolor: 'rgba(10,22,40,0.9)', line: { color: 'rgba(245,158,11,0.4)', width: 1.5 } });
            shapes.push({ type: 'line', xref: 'paper', yref: 'paper', x0: icx - adx * 0.3, y0: icy - ady * 0.3, x1: icx + adx, y1: icy + ady, line: { color: '#f59e0b', width: 2.5 } });
            var hl = al * 0.35, ha = 25 * Math.PI / 180, tx = icx + adx, ty = icy + ady;
            shapes.push({ type: 'line', xref: 'paper', yref: 'paper', x0: tx, y0: ty, x1: tx + hl * Math.cos(th + Math.PI - ha), y1: ty + hl * Math.sin(th + Math.PI - ha), line: { color: '#f59e0b', width: 2.5 } });
            shapes.push({ type: 'line', xref: 'paper', yref: 'paper', x0: tx, y0: ty, x1: tx + hl * Math.cos(th + Math.PI + ha), y1: ty + hl * Math.sin(th + Math.PI + ha), line: { color: '#f59e0b', width: 2.5 } });
            annotations.push({ text: 'DS', xref: 'paper', yref: 'paper', x: icx + adx * 1.6, y: icy + ady * 1.6, showarrow: false,
                font: { color: '#f59e0b', size: fs ? 9 : 7, family: 'JetBrains Mono,monospace' } });
        }
        layout.title = { text: o.title, font: { color: '#0f1623', size: f.title }, y: fs ? 0.99 : 0.965, x: 0.5, xanchor: 'center', yanchor: fs ? 'auto' : 'top' };
        layout.shapes = shapes; layout.annotations = annotations;
        return { traces: traces, layout: layout };
    }

    // ── R/RMW hybrid radius axis (inner bins in R*, outer in km past the RMW) ──
    function hybridXAxis(rHAxis, nInner) {
        var tickvals = [], ticktext = [];
        for (var i = 0; i < rHAxis.length; i++) {
            if (i < nInner) {
                var val = rHAxis[i];
                if (Math.abs(val % 0.2) < 0.03) { tickvals.push(i); ticktext.push(val.toFixed(1)); }
            } else if (i === nInner) {
                tickvals.push(i); ticktext.push('RMW');
            } else {
                var km = rHAxis[i], target = Math.round(km / 20) * 20;
                if (target > 0 && Math.abs(km - target) < 2.0) {
                    var lbl = '+' + target;
                    if (ticktext.length === 0 || ticktext[ticktext.length - 1] !== lbl) { tickvals.push(i); ticktext.push(lbl); }
                }
            }
        }
        return { tickvals: tickvals, ticktext: ticktext };
    }

    // ── Cross-section rubber band (dashed line from point A to the cursor) ──
    // Returns the mousemove handler; pass it to stopRubberBand to clean up.
    function startRubberBand(plotDiv, pxA, pyA, svgId) {
        var NS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(NS, 'svg');
        svg.id = svgId;
        svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:5;';
        var line = document.createElementNS(NS, 'line');
        line.setAttribute('stroke', '#ef4444'); line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-dasharray', '6,4');
        line.setAttribute('x1', pxA); line.setAttribute('y1', pyA);
        svg.appendChild(line);
        var circle = document.createElementNS(NS, 'circle');
        circle.setAttribute('r', '4'); circle.setAttribute('fill', 'rgba(239,68,68,0.5)');
        circle.setAttribute('stroke', 'white'); circle.setAttribute('stroke-width', '1');
        svg.appendChild(circle);
        plotDiv.parentElement.style.position = 'relative';
        plotDiv.parentElement.appendChild(svg);
        var handler = function (e) {
            var rect = plotDiv.getBoundingClientRect();
            line.setAttribute('x2', e.clientX - rect.left); line.setAttribute('y2', e.clientY - rect.top);
            circle.setAttribute('cx', e.clientX - rect.left); circle.setAttribute('cy', e.clientY - rect.top);
        };
        plotDiv.addEventListener('mousemove', handler);
        return handler;
    }
    function stopRubberBand(plotDiv, svgId, handler) {
        var svg = document.getElementById(svgId);
        if (svg) svg.remove();
        if (handler && plotDiv) plotDiv.removeEventListener('mousemove', handler);
    }

    // ── Shear / motion compass (HTML strip above the plan view) ──────────
    // sddc: arrow direction (DOWNSHEAR, deg); shdc: shear kt; motionDir/Spd:
    // heading (deg) / kt; sddcDisplay: optional value for the text label.
    function shearCompassHTML(sddc, shdc, motionDir, motionSpd, sddcDisplay) {
        var hasShear = (sddc !== null && sddc !== undefined && sddc !== 9999);
        var hasMotion = (motionDir !== null && motionDir !== undefined && motionDir !== 9999);
        if (!hasShear && !hasMotion) return '';
        var size = 50, cx = size / 2, cy = size / 2, r = 18, arrowR = 15;
        var svg = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" style="vertical-align:middle;">';
        svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="rgba(10,22,40,0.8)" stroke="rgba(15, 22, 35,0.2)" stroke-width="1"/>';
        svg += '<circle cx="' + cx + '" cy="' + cy + '" r="2" fill="rgba(15, 22, 35,0.5)"/>';
        function drawArrow(dirDeg, color) {
            var rad = (90 - dirDeg) * Math.PI / 180;
            var tipX = cx + arrowR * Math.cos(rad), tipY = cy - arrowR * Math.sin(rad);
            var baseX = cx - arrowR * 0.2 * Math.cos(rad), baseY = cy + arrowR * 0.2 * Math.sin(rad);
            var hl = 5, ha = 28 * Math.PI / 180, aRad = Math.atan2(-(tipY - baseY), tipX - baseX);
            var h1x = tipX - hl * Math.cos(aRad - ha), h1y = tipY + hl * Math.sin(aRad - ha);
            var h2x = tipX - hl * Math.cos(aRad + ha), h2y = tipY + hl * Math.sin(aRad + ha);
            function ln(x1, y1, x2, y2) {
                return '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="' + color + '" stroke-width="2" stroke-linecap="round"/>';
            }
            svg += ln(baseX, baseY, tipX, tipY) + ln(tipX, tipY, h1x, h1y) + ln(tipX, tipY, h2x, h2y);
        }
        if (hasShear) drawArrow(sddc, '#f59e0b');
        if (hasMotion) drawArrow(motionDir, '#22d3ee');
        svg += '</svg>';
        var labels = '<span class="compass-labels">';
        if (hasShear) {
            var shrStr = 'Shear';
            if (shdc !== null && shdc !== undefined && shdc !== 9999) shrStr += ' ' + shdc.toFixed(0) + ' kt';
            var displayDir = (sddcDisplay !== null && sddcDisplay !== undefined) ? sddcDisplay : sddc;
            shrStr += ' / ' + (typeof displayDir === 'number' ? displayDir.toFixed(0) : displayDir) + '°';
            labels += '<span class="shear-lbl">' + shrStr + '</span>';
        }
        if (hasMotion) {
            var motStr = 'Motion';
            if (motionSpd !== null && motionSpd !== undefined && motionSpd !== 9999) motStr += ' ' + motionSpd.toFixed(0) + ' kt';
            motStr += ' / ' + motionDir.toFixed(0) + '°';
            labels += '<span class="motion-lbl">' + motStr + '</span>';
        }
        labels += '</span>';
        return '<span class="shear-compass">' + svg + labels + '</span>';
    }

    // ── Saffir-Simpson helpers ───────────────────────────────────────────
    function intensityColor(vmax) {
        if (!vmax) return '#6b7280'; if (vmax < 34) return '#60a5fa'; if (vmax < 64) return '#34d399';
        if (vmax < 83) return '#fbbf24'; if (vmax < 96) return '#fb923c'; if (vmax < 113) return '#f87171';
        if (vmax < 137) return '#ef4444'; return '#dc2626';
    }
    function intensityCategory(vmax) {
        if (!vmax) return 'Unknown'; if (vmax < 34) return 'TD'; if (vmax < 64) return 'TS';
        if (vmax < 83) return 'Cat 1'; if (vmax < 96) return 'Cat 2'; if (vmax < 113) return 'Cat 3';
        if (vmax < 137) return 'Cat 4'; return 'Cat 5';
    }

    // ── Map drape: the plan-view field on the geographic map ─────────────
    // One instance per page. The page owns WHEN to drape (focus mode, pills,
    // two-panel layout); the drape owns HOW: 1 px/cell canvas → imageOverlay
    // in its own pane, RMW ring, vector barbs (white halo under dark ink), hover
    // readout, editable colorbar, km↔lat/lon. Works on the lflet_gl facade and
    // on real Leaflet (explorer ?gl=0).
    //
    // p (the plan record): { z, x, y, vmin, vmax, colorscale, units, display_name,
    //   level_km, rmw_km, rmw_cx, rmw_cy (ring center, km; default 0), barbs,
    //   center_lat, center_lon }
    //
    // opts: {
    //   map: fn() → map (required)
    //   prefix: 'rt' | 'tcr' — pane names + localStorage key
    //   fieldVisible: fn() → bool (default true; false = opacity 0, barbs/ring hidden)
    //   barbsVisible: fn() → bool (default true)
    //   colorbar: { host: fn() → el, id (container), cls (inner class prefix), className, opacity: bool,
    //               onRange(vmin, vmax), onReset(), onShow(), onHide() }
    //   onDraw(p), onOff()   — page extras (center marker, storm grid, IR frame)
    // }
    function createDrape(opts) {
        var prefix = opts.prefix || 'tdr';
        var storeKey = prefix + '_radar_opacity';
        var st = { p: null, on: false, overlay: null, ring: null, halo: null, ink: null, tip: null,
                   hoverMap: null, opacity: 1.0, rangeTimer: null };
        try { var o = parseFloat(localStorage.getItem(storeKey)); if (o >= 0 && o <= 1) st.opacity = o; } catch (e) {}
        function M() { return opts.map(); }
        function fieldVisible() { return opts.fieldVisible ? !!opts.fieldVisible() : true; }
        function barbsVisible() { return opts.barbsVisible ? !!opts.barbsVisible() : true; }
        // Image overlays sit at z 350 and vectors at 400 on the GL facade; real
        // Leaflet keeps images in overlayPane (400), so go just above that there.
        function zBase() { return window.LFLET_GL ? 380 : 405; }
        function pane(name, z) {
            var m = M();
            try { var el = m.getPane(name) || m.createPane(name); el.style.zIndex = z; el.style.pointerEvents = 'none'; } catch (e) {}
            return name;
        }
        function rm(layer) { if (layer) { try { M().removeLayer(layer); } catch (e) {} } }

        // Storm-relative km ↔ lat/lon (WGS84 degree lengths at the center).
        function kmPerDeg(p) { return { lat: 110.574, lon: 111.320 * (Math.cos(p.center_lat * Math.PI / 180) || 1) }; }
        function latLngFromKm(x, y, p) { p = p || st.p; var k = kmPerDeg(p); return [p.center_lat + y / k.lat, p.center_lon + x / k.lon]; }
        function kmFromLatLng(ll, p) {
            p = p || st.p; if (!p || p.center_lat == null) return null;
            var k = kmPerDeg(p);
            return { x: (ll.lng - p.center_lon) * k.lon, y: (ll.lat - p.center_lat) * k.lat };
        }
        // x/y are cell centers: pad half a cell so each pixel sits on its cell.
        function bounds(p) {
            p = p || st.p;
            var k = kmPerDeg(p), nx = p.x.length, ny = p.y.length;
            var hx = nx > 1 ? (p.x[nx-1] - p.x[0]) / (nx - 1) / 2 : 0;
            var hy = ny > 1 ? (p.y[ny-1] - p.y[0]) / (ny - 1) / 2 : 0;
            return L.latLngBounds(
                [p.center_lat + (p.y[0] - hy) / k.lat, p.center_lon + (p.x[0] - hx) / k.lon],
                [p.center_lat + (p.y[ny-1] + hy) / k.lat, p.center_lon + (p.x[nx-1] + hx) / k.lon]);
        }

        function paintCanvas(p) {
            var rows = p.z.length, cols = p.z[0].length;
            var cv = document.createElement('canvas'); cv.width = cols; cv.height = rows;
            var ctx = cv.getContext('2d'), im = ctx.createImageData(cols, rows), d = im.data;
            var lut = csLUT(p.colorscale), span = (p.vmax - p.vmin) || 1;
            for (var r = 0; r < rows; r++) {
                var zr = p.z[rows - 1 - r];   // canvas top = north = last data row
                if (!zr) continue;
                for (var c = 0; c < cols; c++) {
                    var v = zr[c];
                    if (v == null || isNaN(v)) continue;   // alpha 0 → the IR shows through
                    var li = Math.max(0, Math.min(255, Math.round((v - p.vmin) / span * 255))) * 3;
                    var pi = (r * cols + c) * 4;
                    d[pi] = lut[li]; d[pi+1] = lut[li+1]; d[pi+2] = lut[li+2]; d[pi+3] = 255;
                }
            }
            ctx.putImageData(im, 0, 0);
            return cv.toDataURL('image/png');
        }

        function draw(p) {
            if (p) st.p = p;
            p = st.p;
            var m = M();
            if (!m || !p || !p.z || !p.z.length || p.center_lat == null) return;
            st.on = true;
            var url = paintCanvas(p), b = bounds(p), op = fieldVisible() ? st.opacity : 0;
            // Update in place on re-renders: no flicker, no remove/add churn
            // against the GL style queue.
            if (st.overlay && st.overlay.setUrl && st.overlay.setBounds) {
                st.overlay.setUrl(url); st.overlay.setBounds(b); st.overlay.setOpacity(op);
            } else {
                rm(st.overlay);
                st.overlay = L.imageOverlay(url, b, { opacity: op, interactive: false, crisp: true,
                    pane: pane(prefix + 'DrapePane', zBase()) }).addTo(m);
            }
            var hasRmw = p.rmw_km && !isNaN(p.rmw_km);
            if (!hasRmw) { rm(st.ring); st.ring = null; }
            else {
                var rc = latLngFromKm(p.rmw_cx || 0, p.rmw_cy || 0, p);
                if (st.ring) { st.ring.setLatLng(rc); st.ring.setRadius(p.rmw_km * 1000); }
                else st.ring = L.circle(rc, { radius: p.rmw_km * 1000, color: '#fff', weight: 1.5,
                    dashArray: '5 5', fill: false, interactive: false }).addTo(m);
                try { st.ring.setStyle({ opacity: fieldVisible() ? 1 : 0 }); } catch (e) {}
            }
            if (st.hoverMap !== m) {
                m.on('mousemove', hover); m.on('mouseout', hideTip);
                st.hoverMap = m;
            }
            drawBarbs();
            colorbar();
            if (opts.onDraw) opts.onDraw(p);
        }

        // Barbs as VECTOR lines (constant screen width, antialiased at every
        // zoom); same glyphs as the plan view, projected to lon/lat.
        function removeBarbs() { rm(st.halo); rm(st.ink); st.halo = st.ink = null; }
        function drawBarbs() {
            var p = st.p;
            if (!st.on || !p || !p.barbs || !barbsVisible() || !fieldVisible() || p.center_lat == null) { removeBarbs(); return; }
            var shapes = windBarbShapes(p.barbs, { xMin: p.x[0], xMax: p.x[p.x.length - 1], yMin: p.y[0], yMax: p.y[p.y.length - 1] });
            var lines = [];
            for (var i = 0; i < shapes.length; i++) {
                var sh = shapes[i]; if (sh.type !== 'line') continue;
                var a = latLngFromKm(sh.x0, sh.y0, p), c = latLngFromKm(sh.x1, sh.y1, p);
                lines.push([[a[1], a[0]], [c[1], c[0]]]);   // GeoJSON is [lon, lat]
            }
            if (!lines.length) { removeBarbs(); return; }
            var fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
                geometry: { type: 'MultiLineString', coordinates: lines } }] };
            if (st.halo && st.ink) {
                st.halo.clearLayers(); st.halo.addData(fc);
                st.ink.clearLayers(); st.ink.addData(fc);
                return;
            }
            removeBarbs();
            var z = zBase() + 8;
            st.halo = L.geoJSON(fc, { pane: pane(prefix + 'BarbHaloPane', z), interactive: false,
                style: { color: '#ffffff', weight: 3.6, opacity: 0.85 } }).addTo(M());
            st.ink = L.geoJSON(fc, { pane: pane(prefix + 'BarbInkPane', z + 2), interactive: false,
                style: { color: '#0b1220', weight: 1.5, opacity: 1 } }).addTo(M());
        }

        function hover(e) {
            var p = st.p;
            if (!st.on || !p || !fieldVisible() || (opts.hoverSuppressed && opts.hoverSuppressed())) { hideTip(); return; }
            var km = kmFromLatLng(e.latlng, p); if (!km) return;
            var ci = Math.round((km.x - p.x[0]) / (p.x[p.x.length-1] - p.x[0]) * (p.x.length - 1));
            var ri = Math.round((km.y - p.y[0]) / (p.y[p.y.length-1] - p.y[0]) * (p.y.length - 1));
            if (ci < 0 || ci >= p.x.length || ri < 0 || ri >= p.y.length) { hideTip(); return; }
            var v = p.z[ri] ? p.z[ri][ci] : null;
            if (v == null || isNaN(v)) { hideTip(); return; }
            if (!st.tip) {
                st.tip = document.createElement('div');
                st.tip.style.cssText = 'position:fixed;z-index:1300;pointer-events:none;background:rgba(15,22,35,0.92);' +
                    'color:#fff;font:600 11px/1.3 "DM Sans",sans-serif;padding:3px 7px;border-radius:4px;white-space:nowrap;';
                document.body.appendChild(st.tip);
            }
            st.tip.textContent = v.toFixed(1) + ' ' + p.units + '  ·  ' + Math.round(km.x) + ', ' + Math.round(km.y) + ' km';
            var oe = e.originalEvent || {};
            st.tip.style.left = ((oe.clientX || 0) + 14) + 'px'; st.tip.style.top = ((oe.clientY || 0) - 6) + 'px';
            st.tip.style.display = 'block';
        }
        function hideTip() { if (st.tip) st.tip.style.display = 'none'; }

        // Colorbar with EDITABLE min/max (typing rescales the field live).
        function fmt(v) { return (v == null || isNaN(v)) ? '' : String(Math.round(v * 100) / 100); }
        function colorbar() {
            var cb = opts.colorbar, p = st.p;
            if (!cb || !p) return;
            var host = cb.host(); if (!host) return;
            var id = cb.id, cls = cb.cls || id, el = document.getElementById(id);
            if (!el) {
                el = document.createElement('div');
                el.id = id; el.className = cb.className || id;
                el.innerHTML =
                    '<div class="' + cls + '-title"><span data-k="name"></span> <span data-k="units"></span></div>' +
                    '<div class="' + cls + '-row">' +
                        '<input type="number" data-k="min" step="any" aria-label="Color range minimum" title="Minimum of the color range — type to rescale">' +
                        '<div class="' + cls + '-grad" data-k="grad"></div>' +
                        '<input type="number" data-k="max" step="any" aria-label="Color range maximum" title="Maximum of the color range — type to rescale">' +
                    '</div>' +
                    '<div class="' + cls + '-foot"><span data-k="level"></span>' +
                        (cb.opacity ? '<span class="' + cls + '-op" title="Opacity of the radar field on the map"><input type="range" data-k="op" min="0" max="100" aria-label="Radar field opacity"><span data-k="opv"></span></span>' : '') +
                        '<button class="' + cls + '-reset" data-k="reset" title="Restore the variable\'s default range">reset</button></div>';
                host.appendChild(el);
                // Keep map drags / clicks from firing through the colorbar.
                ['mousedown', 'click', 'dblclick', 'wheel', 'touchstart'].forEach(function (ev) {
                    el.addEventListener(ev, function (e) { e.stopPropagation(); });
                });
                var q = function (k) { return el.querySelector('[data-k="' + k + '"]'); };
                var onRange = function () {
                    clearTimeout(st.rangeTimer);
                    st.rangeTimer = setTimeout(function () {
                        var mn = parseFloat(q('min').value), mx = parseFloat(q('max').value);
                        if (isNaN(mn) || isNaN(mx) || mn >= mx) return;
                        if (cb.onRange) cb.onRange(mn, mx);
                    }, 120);
                };
                q('min').addEventListener('input', onRange); q('max').addEventListener('input', onRange);
                q('reset').addEventListener('click', function () { if (cb.onReset) cb.onReset(); });
                if (cb.opacity) q('op').addEventListener('input', function () { setOpacity(this.value / 100); });
            }
            var g = function (k) { return el.querySelector('[data-k="' + k + '"]'); };
            var lut = csLUT(p.colorscale), stops = [];
            for (var k = 0; k <= 24; k++) { var i = Math.round(k / 24 * 255) * 3; stops.push('rgb(' + lut[i] + ',' + lut[i+1] + ',' + lut[i+2] + ')'); }
            g('grad').style.background = 'linear-gradient(to right, ' + stops.join(', ') + ')';
            g('name').textContent = p.display_name || '';
            g('units').textContent = p.units ? '(' + p.units + ')' : '';
            g('level').textContent = p.level_km != null ? (p.level_km < 0.05 ? '10 m' : p.level_km.toFixed(1) + ' km') : '';
            if (document.activeElement !== g('min')) g('min').value = fmt(p.vmin);
            if (document.activeElement !== g('max')) g('max').value = fmt(p.vmax);
            if (cb.opacity) {
                if (document.activeElement !== g('op')) g('op').value = Math.round(st.opacity * 100);
                g('opv').textContent = Math.round(st.opacity * 100) + '%';
            }
            el.style.display = 'block';
            if (cb.onShow) cb.onShow();
        }
        function hideColorbar() {
            var cb = opts.colorbar; if (!cb) return;
            var el = document.getElementById(cb.id); if (el) el.style.display = 'none';
            if (cb.onHide) cb.onHide();
        }

        function setOpacity(v) {
            st.opacity = Math.max(0, Math.min(1, parseFloat(v) || 0));
            try { localStorage.setItem(storeKey, String(st.opacity)); } catch (e) {}
            applyVisibility();
            var cb = opts.colorbar, el = cb && document.getElementById(cb.id);
            var opv = el && el.querySelector('[data-k="opv"]'); if (opv) opv.textContent = Math.round(st.opacity * 100) + '%';
        }
        /** Re-apply the field / ring / barb visibility (after fieldVisible() changed).
         *  `dimTo` temporarily caps the field opacity (e.g. under a 3-D volume). */
        function applyVisibility(dimTo) {
            var op = fieldVisible() ? (dimTo != null ? Math.min(st.opacity, dimTo) : st.opacity) : 0;
            if (st.overlay) { try { st.overlay.setOpacity(op); } catch (e) {} }
            if (st.ring) { try { st.ring.setStyle({ opacity: fieldVisible() ? 1 : 0 }); } catch (e) {} }
            drawBarbs();
        }
        /** Update part of the plan record (colormap / range) and redraw if on. */
        function restyle(ch) {
            if (!st.p) return;
            for (var k in ch) if (ch[k] != null) st.p[k] = ch[k];
            if (st.on) draw();
        }
        function off() {
            st.on = false;
            rm(st.overlay); rm(st.ring); st.overlay = st.ring = null;
            removeBarbs(); hideTip(); hideColorbar();
            if (opts.onOff) opts.onOff();
        }
        /** Frame the field; the map is often mid-reflow, so fit twice. */
        function frame() {
            if (!st.p) return;
            function fit() { try { var m = M(); m.invalidateSize(); m.fitBounds(bounds(st.p), { padding: [30, 30] }); } catch (e) {} }
            fit(); setTimeout(fit, 450);
        }

        return {
            draw: draw, off: off, frame: frame, restyle: restyle, redrawBarbs: drawBarbs,
            setOpacity: setOpacity, applyVisibility: applyVisibility,
            bounds: bounds, kmFromLatLng: kmFromLatLng, latLngFromKm: latLngFromKm, hideTip: hideTip,
            isOn: function () { return st.on; }, plan: function () { return st.p; },
            opacity: function () { return st.opacity; }, hasOverlay: function () { return !!st.overlay; }
        };
    }

    window.TDRView = {
        NAMED_CS: NAMED_CS, csParse: csParse, csResolve: csResolve, csColor: csColor, csLUT: csLUT,
        windBarbShapes: windBarbShapes,
        findDataMax: findDataMax, findDataMin: findDataMin, isWindVariable: isWindVariable,
        maxMarkerTrace: maxMarkerTrace, maxAnnotation: maxAnnotation, tcCenterMarkerTrace: tcCenterMarkerTrace,
        overlayContours: overlayContours, contourTraces: contourTraces, hybridXAxis: hybridXAxis,
        sectionFigure: sectionFigure, sectionTitleOverlay: sectionTitleOverlay,
        hasAnyData: hasAnyData, planFigure: planFigure, planTitle: planTitle, metaStripHTML: metaStripHTML,
        dualPanelHTML: dualPanelHTML, noDataHTML: noDataHTML,
        shearInset: shearInset, shearInsetCS: shearInsetCS, themeGrid: themeGrid, cfadFigure: cfadFigure,
        anomalyFigure: anomalyFigure, FISCHER_2025: FISCHER_2025, quadrantFigure: quadrantFigure,
        startRubberBand: startRubberBand, stopRubberBand: stopRubberBand,
        shearCompassHTML: shearCompassHTML, intensityColor: intensityColor, intensityCategory: intensityCategory,
        createDrape: createDrape
    };
})();
