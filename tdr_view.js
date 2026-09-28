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

    window.TDRView = {
        NAMED_CS: NAMED_CS, csParse: csParse, csResolve: csResolve, csColor: csColor, csLUT: csLUT,
        windBarbShapes: windBarbShapes,
        findDataMax: findDataMax, findDataMin: findDataMin, isWindVariable: isWindVariable,
        maxMarkerTrace: maxMarkerTrace, maxAnnotation: maxAnnotation, tcCenterMarkerTrace: tcCenterMarkerTrace,
        overlayContours: overlayContours, hybridXAxis: hybridXAxis,
        startRubberBand: startRubberBand, stopRubberBand: stopRubberBand,
        shearCompassHTML: shearCompassHTML, intensityColor: intensityColor, intensityCategory: intensityCategory
    };
})();
