// GC-ATLAS — cross-section panel.
// Two modes:
//   zonal:  zonal-mean over all longitudes at each latitude (the original
//           "lat × pressure" heatmap, pole-to-pole).
//   arc:    vertical section along a user-drawn great circle on the globe.
// Renders into a plain <canvas> — no D3 dependency.

import { getField, LEVELS, GRID, FIELDS } from './data.js';
import { sample } from './colormap.js';
import { gcDistanceKm, arcPathLengthKm } from './arc.js';

const LAT_TICKS = [-90, -60, -30, 0, 30, 60, 90];
const P_TICKS   = [1000, 500, 200, 100, 50, 10];

/**
 * Zonal mean — NaN-aware average at each latitude.
 * Returns { kind:'zonal', type, values, vmin, vmax, ... }.
 */
export function computeZonalMean(fieldName, month, { seasonal = false } = {}) {
    const meta = FIELDS[fieldName];
    const { nlat, nlon } = GRID;

    if (meta.type === 'sl') {
        const f = getField(fieldName, { month, seasonal });
        const zm = new Float32Array(nlat);
        let vmin = Infinity, vmax = -Infinity;
        for (let i = 0; i < nlat; i++) {
            let s = 0, n = 0;
            for (let j = 0; j < nlon; j++) {
                const v = f.values[i * nlon + j];
                if (Number.isFinite(v)) { s += v; n += 1; }
            }
            const m = n > 0 ? s / n : NaN;
            zm[i] = m;
            if (Number.isFinite(m)) {
                if (m < vmin) vmin = m;
                if (m > vmax) vmax = m;
            }
        }
        if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
        return { kind: 'zonal', type: 'sl', values: zm, vmin, vmax,
                 name: meta.name, units: meta.units };
    }

    const nlev = LEVELS.length;
    const zm = new Float32Array(nlev * nlat);
    let vmin = Infinity, vmax = -Infinity;
    for (let k = 0; k < nlev; k++) {
        const f = getField(fieldName, { month, level: LEVELS[k], seasonal });
        for (let i = 0; i < nlat; i++) {
            let s = 0, n = 0;
            for (let j = 0; j < nlon; j++) {
                const v = f.values[i * nlon + j];
                if (Number.isFinite(v)) { s += v; n += 1; }
            }
            const m = n > 0 ? s / n : NaN;
            zm[k * nlat + i] = m;
            if (Number.isFinite(m)) {
                if (m < vmin) vmin = m;
                if (m > vmax) vmax = m;
            }
        }
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
    return { kind: 'zonal', type: 'pl', values: zm, vmin, vmax,
             levels: LEVELS.slice(), name: meta.name, units: meta.units };
}

/** Sample the cross-section heatmap data at fractional panel coordinates. Used
 *  by the hover tooltip — keeps the inverse mapping in one place. */
export function samplePanel(zm, fracX, fracY) {
    if (!zm) return null;
    if (zm.kind === 'zonal') {
        const lat = -90 + fracX * 180;
        if (zm.type === 'pl') {
            const pMin = zm.levels[0];
            const pMax = zm.levels[zm.levels.length - 1];
            const p = pMin * Math.exp(fracY * Math.log(pMax / pMin));
            return { lat, p, value: sampleZonalPL(zm, lat, p) };
        }
        return { lat, value: sampleZonalSL(zm, lat) };
    }
    if (zm.kind === 'arc') {
        const sIdx = fracX * (zm.nSamples - 1);
        const j0 = Math.floor(sIdx);
        const j1 = Math.min(zm.nSamples - 1, j0 + 1);
        const fJ = sIdx - j0;
        const a = zm.arc[j0], b = zm.arc[j1];
        const lat = a.lat * (1 - fJ) + b.lat * fJ;
        // Longitude lerp across the dateline needs care; pick the closer wrap.
        let dLon = b.lon - a.lon;
        if (dLon >  180) dLon -= 360;
        if (dLon < -180) dLon += 360;
        let lon = a.lon + dLon * fJ;
        if (lon >  180) lon -= 360;
        if (lon < -180) lon += 360;
        if (zm.type === 'pl') {
            const pMin = zm.levels[0];
            const pMax = zm.levels[zm.levels.length - 1];
            const p = pMin * Math.exp(fracY * Math.log(pMax / pMin));
            return { lat, lon, p, value: sampleArcPL(zm, sIdx, p) };
        }
        return { lat, lon, value: sampleArcSL(zm, sIdx) };
    }
    return null;
}

function sampleZonalPL(zm, lat, p) {
    const { nlat } = GRID;
    const { values, levels } = zm;
    const nlev = levels.length;
    const rLat = 90 - lat;
    if (rLat < 0 || rLat > nlat - 1) return NaN;
    const i0 = Math.max(0, Math.min(nlat - 1, Math.floor(rLat)));
    const i1 = Math.max(0, Math.min(nlat - 1, i0 + 1));
    const fi = rLat - i0;
    let k0 = 0;
    while (k0 < nlev - 1 && levels[k0 + 1] < p) k0++;
    const k1 = Math.min(nlev - 1, k0 + 1);
    const fK = (k0 === k1) ? 0 : Math.log(p / levels[k0]) / Math.log(levels[k1] / levels[k0]);
    const v00 = values[k0 * nlat + i0], v01 = values[k0 * nlat + i1];
    const v10 = values[k1 * nlat + i0], v11 = values[k1 * nlat + i1];
    const vT = v00 * (1 - fi) + v01 * fi;
    const vB = v10 * (1 - fi) + v11 * fi;
    return vT * (1 - fK) + vB * fK;
}

function sampleZonalSL(zm, lat) {
    const { nlat } = GRID;
    const rLat = 90 - lat;
    if (rLat < 0 || rLat > nlat - 1) return NaN;
    const i0 = Math.max(0, Math.min(nlat - 1, Math.floor(rLat)));
    const i1 = Math.max(0, Math.min(nlat - 1, i0 + 1));
    const fi = rLat - i0;
    const v0 = zm.values[i0], v1 = zm.values[i1];
    return v0 * (1 - fi) + v1 * fi;
}

function sampleArcPL(zm, sIdx, p) {
    const { values, levels, nSamples } = zm;
    const nlev = levels.length;
    const j0 = Math.max(0, Math.min(nSamples - 1, Math.floor(sIdx)));
    const j1 = Math.min(nSamples - 1, j0 + 1);
    const fJ = sIdx - j0;
    let k0 = 0;
    while (k0 < nlev - 1 && levels[k0 + 1] < p) k0++;
    const k1 = Math.min(nlev - 1, k0 + 1);
    const fK = (k0 === k1) ? 0 : Math.log(p / levels[k0]) / Math.log(levels[k1] / levels[k0]);
    const v00 = values[k0 * nSamples + j0], v01 = values[k0 * nSamples + j1];
    const v10 = values[k1 * nSamples + j0], v11 = values[k1 * nSamples + j1];
    const vT = v00 * (1 - fJ) + v01 * fJ;
    const vB = v10 * (1 - fJ) + v11 * fJ;
    return vT * (1 - fK) + vB * fK;
}

function sampleArcSL(zm, sIdx) {
    const { values, nSamples } = zm;
    const j0 = Math.max(0, Math.min(nSamples - 1, Math.floor(sIdx)));
    const j1 = Math.min(nSamples - 1, j0 + 1);
    const fJ = sIdx - j0;
    return values[j0] * (1 - fJ) + values[j1] * fJ;
}

/** Bilinear sample of a (nlat × nlon) field at arbitrary (lat, lon). NaN-safe. */
function bilinearSample(values, lat, lon) {
    const { nlat, nlon } = GRID;
    const rLat = 90 - lat;
    const rLon = ((lon + 180) % 360 + 360) % 360;
    if (rLat < 0 || rLat > nlat - 1) return NaN;
    const i0 = Math.max(0, Math.min(nlat - 1, Math.floor(rLat)));
    const i1 = Math.max(0, Math.min(nlat - 1, i0 + 1));
    const j0 = Math.floor(rLon) % nlon;
    const j1 = (j0 + 1) % nlon;
    const fi = rLat - i0;
    const fj = rLon - Math.floor(rLon);
    const v00 = values[i0 * nlon + j0];
    const v01 = values[i0 * nlon + j1];
    const v10 = values[i1 * nlon + j0];
    const v11 = values[i1 * nlon + j1];
    // If any corner is NaN, fall back to mean of finite corners.
    const anyNaN = !Number.isFinite(v00) || !Number.isFinite(v01)
                || !Number.isFinite(v10) || !Number.isFinite(v11);
    if (anyNaN) {
        let s = 0, n = 0;
        for (const v of [v00, v01, v10, v11]) if (Number.isFinite(v)) { s += v; n += 1; }
        return n > 0 ? s / n : NaN;
    }
    const vT = v00 * (1 - fj) + v01 * fj;
    const vB = v10 * (1 - fj) + v11 * fj;
    return vT * (1 - fi) + vB * fi;
}

/**
 * Cross-section along an arc (array of { lat, lon } points).
 * Returns { kind:'arc', type, values, vmin, vmax, nSamples, arc, distanceKm, ... }.
 * For pressure-level fields, values is Float32Array(nlev × nSamples).
 * For single-level fields, values is Float32Array(nSamples).
 */
export function computeArcCrossSection(fieldName, month, arc, { seasonal = false } = {}) {
    const meta = FIELDS[fieldName];
    const nSamples = arc.length;
    if (nSamples < 2) return null;
    // Sum the actual sampled-segment lengths so curved (mid-pinned) arcs
    // report their true along-path distance on the cross-section x-axis,
    // not the endpoint-to-endpoint shortcut.
    const distanceKm = arcPathLengthKm(arc);

    if (meta.type === 'sl') {
        const f = getField(fieldName, { month, seasonal });
        const values = new Float32Array(nSamples);
        let vmin = Infinity, vmax = -Infinity;
        for (let j = 0; j < nSamples; j++) {
            const v = bilinearSample(f.values, arc[j].lat, arc[j].lon);
            values[j] = v;
            if (Number.isFinite(v)) {
                if (v < vmin) vmin = v;
                if (v > vmax) vmax = v;
            }
        }
        if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
        return { kind: 'arc', type: 'sl', values, vmin, vmax,
                 nSamples, arc, distanceKm, name: meta.name, units: meta.units };
    }

    const nlev = LEVELS.length;
    const values = new Float32Array(nlev * nSamples);
    let vmin = Infinity, vmax = -Infinity;
    for (let k = 0; k < nlev; k++) {
        const f = getField(fieldName, { month, level: LEVELS[k], seasonal });
        for (let j = 0; j < nSamples; j++) {
            const v = bilinearSample(f.values, arc[j].lat, arc[j].lon);
            values[k * nSamples + j] = v;
            if (Number.isFinite(v)) {
                if (v < vmin) vmin = v;
                if (v > vmax) vmax = v;
            }
        }
    }
    if (!Number.isFinite(vmin)) { vmin = 0; vmax = 1; }
    return { kind: 'arc', type: 'pl', values, vmin, vmax,
             nSamples, arc, distanceKm, levels: LEVELS.slice(),
             name: meta.name, units: meta.units };
}

export function renderCrossSection(canvas, zm, cmap) {
    // Retina-aware: size the canvas buffer to DPR × CSS size so text and
    // heatmap pixels stay crisp on high-density displays. All drawing ops
    // below use buffer (physical-pixel) coords, so padding and font sizes
    // scale with DPR to preserve CSS-proportion spacing.
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth  || 380;
    const cssH = canvas.clientHeight || 200;
    if (canvas.width !== cssW * DPR || canvas.height !== cssH * DPR) {
        canvas.width  = cssW * DPR;
        canvas.height = cssH * DPR;
    }
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const padL = 42 * DPR, padR = 10 * DPR, padT = 10 * DPR, padB = 26 * DPR;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // Stash DPR on the zm object so the draw fns can scale fonts + strokes.
    zm._dpr = DPR;

    if (zm.kind === 'arc') {
        if (zm.type === 'pl') drawArcHeatmap(ctx, padL, padT, plotW, plotH, zm, cmap);
        else                  drawArcLine   (ctx, padL, padT, plotW, plotH, zm);
        drawArcAxes(ctx, padL, padT, plotW, plotH, zm);
    } else {
        if (zm.type === 'pl') drawHeatmap(ctx, padL, padT, plotW, plotH, zm, cmap);
        else                  drawLine   (ctx, padL, padT, plotW, plotH, zm);
        drawAxes(ctx, padL, padT, plotW, plotH, zm);
        // EP-flux mode overlays vector arrows on top of the ∇·F shading.
        if (zm.arrows) drawEPArrows(ctx, padL, padT, plotW, plotH, zm);
    }
}

function drawArcHeatmap(ctx, x0, y0, w, h, zm, cmap) {
    const { values, vmin, vmax, levels, nSamples } = zm;
    const nlev = levels.length;
    const pMax = levels[nlev - 1];
    const pMin = levels[0];
    const logSpan = Math.log(pMax / pMin);
    const span = (vmax - vmin) || 1;
    const showContours = !!zm.showContours;
    const interval = zm.contourInterval || 0;

    const iw = Math.floor(w), ih = Math.floor(h);
    const img = ctx.createImageData(iw, ih);
    const data = img.data;
    // Cache current row + previous row's v so the contour pass can compare
    // neighbours in one pass without re-sampling.
    const prevRow = showContours && interval ? new Float32Array(iw) : null;
    if (prevRow) prevRow.fill(NaN);

    for (let py = 0; py < ih; py++) {
        const p = pMin * Math.exp((py / (ih - 1)) * logSpan);
        let k0 = 0;
        while (k0 < nlev - 1 && levels[k0 + 1] < p) k0++;
        const k1 = Math.min(nlev - 1, k0 + 1);
        const fLev = (k0 === k1) ? 0
            : Math.log(p / levels[k0]) / Math.log(levels[k1] / levels[k0]);
        let vLeft = NaN;
        for (let px = 0; px < iw; px++) {
            const sIdx = (px / (iw - 1)) * (nSamples - 1);
            const j0 = Math.floor(sIdx);
            const j1 = Math.min(nSamples - 1, j0 + 1);
            const fS = sIdx - j0;
            const v00 = values[k0 * nSamples + j0], v01 = values[k0 * nSamples + j1];
            const v10 = values[k1 * nSamples + j0], v11 = values[k1 * nSamples + j1];
            const vT = v00 * (1 - fS) + v01 * fS;
            const vB = v10 * (1 - fS) + v11 * fS;
            const v  = vT * (1 - fLev) + vB * fLev;
            const k = (py * iw + px) * 4;
            if (!Number.isFinite(v)) {
                data[k] = 18; data[k+1] = 26; data[k+2] = 22; data[k+3] = 255;
                if (prevRow) prevRow[px] = NaN;
                vLeft = NaN;
                continue;
            }
            const t = (v - vmin) / span;
            const [r, g, b] = sample(cmap, t);
            data[k]     = r * 255;
            data[k + 1] = g * 255;
            data[k + 2] = b * 255;
            data[k + 3] = 255;
            // Contour overlay: paint dark where the floor(v/interval) bucket
            // differs from the neighbour on the left or above.
            if (prevRow) {
                const kSelf = Math.floor(v / interval);
                const vUp   = prevRow[px];
                const hitX = Number.isFinite(vLeft) && Math.floor(vLeft / interval) !== kSelf;
                const hitY = Number.isFinite(vUp)   && Math.floor(vUp   / interval) !== kSelf;
                if (hitX || hitY) {
                    data[k] = 10; data[k + 1] = 18; data[k + 2] = 14;
                }
                prevRow[px] = v;
            }
            vLeft = v;
        }
    }
    ctx.putImageData(img, x0, y0);
    drawPanelGrid(ctx, x0, y0, w, h, zm);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = zm._dpr || 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
}

/** Faint gridlines inside the plot area: horizontal at pressure ticks,
 *  vertical at quarter marks along the arc / latitude. */
function drawPanelGrid(ctx, x0, y0, w, h, zm) {
    const dpr = zm._dpr || 1;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = Math.max(1, dpr * 0.75);
    ctx.beginPath();
    if (zm.type === 'pl') {
        const pMax = zm.levels[zm.levels.length - 1];
        const pMin = zm.levels[0];
        const logSpan = Math.log(pMax / pMin);
        for (const p of P_TICKS) {
            if (p < pMin || p > pMax) continue;
            const y = y0 + h * (Math.log(p / pMin) / logSpan);
            ctx.moveTo(x0, y + 0.5);
            ctx.lineTo(x0 + w, y + 0.5);
        }
    }
    // Vertical quarter marks.
    for (const t of [0.25, 0.5, 0.75]) {
        const x = Math.round(x0 + t * w) + 0.5;
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y0 + h);
    }
    ctx.stroke();
    ctx.restore();
}

function drawArcLine(ctx, x0, y0, w, h, zm) {
    const { values, vmin, vmax, nSamples } = zm;
    const span = (vmax - vmin) || 1;
    const dpr = zm._dpr || 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = dpr;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);

    ctx.strokeStyle = '#2DBDA0';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    let started = false;
    for (let j = 0; j < nSamples; j++) {
        const v = values[j];
        if (!Number.isFinite(v)) { started = false; continue; }
        const x = x0 + (j / (nSamples - 1)) * w;
        const y = y0 + h - ((v - vmin) / span) * h;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else          ctx.lineTo(x, y);
    }
    ctx.stroke();
}

function drawArcAxes(ctx, x0, y0, w, h, zm) {
    const dpr = zm._dpr || 1;
    ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = '#AEC3B6';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = dpr;

    // Endpoint labels on the x-axis: start / middle / end (lat, lon).
    // Align flush-left / centred / flush-right so the outer labels don't
    // clip against the panel edge.
    const fmtPt = (p) => `${Math.abs(Math.round(p.lat))}°${p.lat >= 0 ? 'N' : 'S'} ${Math.round(p.lon)}°`;
    const ticks = [
        { t: 0.0, label: fmtPt(zm.arc[0]),                         align: 'left'   },
        { t: 0.5, label: fmtPt(zm.arc[Math.floor(zm.arc.length / 2)]), align: 'center' },
        { t: 1.0, label: fmtPt(zm.arc[zm.arc.length - 1]),         align: 'right'  },
    ];
    ctx.textBaseline = 'top';
    for (const { t, label, align } of ticks) {
        const x = x0 + t * w;
        ctx.beginPath();
        ctx.moveTo(x, y0 + h);
        ctx.lineTo(x, y0 + h + 3 * dpr);
        ctx.stroke();
        ctx.textAlign = align;
        ctx.fillText(label, x, y0 + h + 5 * dpr);
    }
    // (Distance intentionally omitted here — it's already in the panel title.)

    // Pressure ticks on the y-axis (pl fields only).
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#AEC3B6';
    if (zm.type === 'pl') {
        const pMax = zm.levels[zm.levels.length - 1];
        const pMin = zm.levels[0];
        const logSpan = Math.log(pMax / pMin);
        for (const p of P_TICKS) {
            if (p < pMin || p > pMax) continue;
            const y = y0 + h * (Math.log(p / pMin) / logSpan);
            ctx.beginPath();
            ctx.moveTo(x0 - 3 * dpr, y);
            ctx.lineTo(x0, y);
            ctx.stroke();
            ctx.fillText(`${p}`, x0 - 5 * dpr, y);
        }
        ctx.save();
        ctx.translate(x0 - 30 * dpr, y0 + h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText('hPa', 0, 0);
        ctx.restore();
    } else {
        // Arc 1D line — keep simple corner labels for now (arc plots are
        // bilinear samples, no panel zonal-mean). Same nice-ticks treatment
        // could go here if needed later.
        ctx.fillText(zm.vmax.toFixed(0), x0 - 5 * dpr, y0 + 4 * dpr);
        ctx.fillText(zm.vmin.toFixed(0), x0 - 5 * dpr, y0 + h - 4 * dpr);
    }
}

function drawHeatmap(ctx, x0, y0, w, h, zm, cmap) {
    const { values, vmin, vmax, levels } = zm;
    const { nlat } = GRID;
    const nlev = levels.length;
    const pMax = levels[nlev - 1];   // largest pressure = surface
    const pMin = levels[0];          // smallest pressure = stratosphere
    const logSpan = Math.log(pMax / pMin);
    const span = (vmax - vmin) || 1;
    const showContours = !!zm.showContours;
    const interval = zm.contourInterval || 0;

    const iw = Math.floor(w), ih = Math.floor(h);
    const img = ctx.createImageData(iw, ih);
    const data = img.data;
    const prevRow = showContours && interval ? new Float32Array(iw) : null;
    if (prevRow) prevRow.fill(NaN);

    // Atmospheric convention: py=0 (top of panel) → low pressure (stratosphere);
    // py=ih-1 (bottom) → high pressure (surface).
    for (let py = 0; py < ih; py++) {
        const p = pMin * Math.exp((py / (ih - 1)) * logSpan);
        // bracket p in the (ascending) levels array
        let k0 = 0;
        while (k0 < nlev - 1 && levels[k0 + 1] < p) k0++;
        const k1 = Math.min(nlev - 1, k0 + 1);
        const fLev = (k0 === k1) ? 0
            : Math.log(p / levels[k0]) / Math.log(levels[k1] / levels[k0]);

        for (let px = 0; px < iw; px++) {
            const lat = -90 + (px / (iw - 1)) * 180;
            const latIdx = 90 - lat;
            const i0 = Math.max(0, Math.min(nlat - 1, Math.floor(latIdx)));
            const i1 = Math.max(0, Math.min(nlat - 1, i0 + 1));
            const fLat = latIdx - i0;

            const v00 = values[k0 * nlat + i0];
            const v01 = values[k0 * nlat + i1];
            const v10 = values[k1 * nlat + i0];
            const v11 = values[k1 * nlat + i1];
            const vT = v00 * (1 - fLat) + v01 * fLat;
            const vB = v10 * (1 - fLat) + v11 * fLat;
            const v  = vT * (1 - fLev) + vB * fLev;

            const k = (py * iw + px) * 4;
            if (!Number.isFinite(v)) {
                data[k] = 18; data[k+1] = 26; data[k+2] = 22; data[k+3] = 255;
                if (prevRow) prevRow[px] = NaN;
                continue;
            }
            const t = (v - vmin) / span;
            const [r, g, b] = sample(cmap, t);
            data[k]     = r * 255;
            data[k + 1] = g * 255;
            data[k + 2] = b * 255;
            data[k + 3] = 255;
            if (prevRow) {
                const kSelf = Math.floor(v / interval);
                const vUp   = prevRow[px];
                // vLeft: previous pixel in same row — we can read back from data via vmin/span, but
                // cheaper to just hold a local; the neighbour-comparison cost is a few per-pixel floats.
                // We only check the up-neighbour here; one-direction detection still looks like a grid.
                const hit = Number.isFinite(vUp) && Math.floor(vUp / interval) !== kSelf;
                if (hit) {
                    data[k] = 10; data[k + 1] = 18; data[k + 2] = 14;
                }
                prevRow[px] = v;
            }
        }
    }
    ctx.putImageData(img, x0, y0);
    drawPanelGrid(ctx, x0, y0, w, h, zm);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = zm._dpr || 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
}

function drawLine(ctx, x0, y0, w, h, zm) {
    const { values, vmin, vmax } = zm;
    const { nlat } = GRID;
    const span = (vmax - vmin) || 1;
    const dpr = zm._dpr || 1;

    // Faint horizontal gridlines at "nice" tick positions.
    const ticks = niceTicks(vmin, vmax, 5);
    ctx.save();
    ctx.lineWidth = Math.max(1, dpr * 0.75);
    for (const t of ticks) {
        const y = y0 + h - ((t - vmin) / span) * h;
        if (Math.abs(t) < 1e-9) {
            // Emphasised zero reference line — solid, brighter.
            ctx.strokeStyle = 'rgba(232, 194, 106, 0.55)';   // amber
            ctx.setLineDash([]);
        } else {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
            ctx.setLineDash([3 * dpr, 3 * dpr]);
        }
        ctx.beginPath();
        ctx.moveTo(x0, y + 0.5);
        ctx.lineTo(x0 + w, y + 0.5);
        ctx.stroke();
    }
    // Vertical quarter marks (latitude grid).
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    for (const t of [0.25, 0.5, 0.75]) {
        const x = Math.round(x0 + t * w) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y0 + h);
        ctx.stroke();
    }
    ctx.restore();

    // Plot frame.
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = dpr;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);

    // Series rendering. Multi-series mode (zm.series) draws each one with its
    // own color + a small legend; single-series falls back to the emerald default.
    const series = zm.series && zm.series.length > 0
        ? zm.series
        : [{ values, color: '#2DBDA0', label: zm.name }];

    for (const s of series) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < nlat; i++) {
            const v = s.values[i];
            if (!Number.isFinite(v)) { started = false; continue; }
            const lat = 90 - i;
            const x = x0 + ((lat + 90) / 180) * w;
            const y = y0 + h - ((v - vmin) / span) * h;
            if (!started) { ctx.moveTo(x, y); started = true; }
            else          ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // Legend (only if multi-series). Top-right of plot, compact two-column
    // layout so it doesn't crowd the curves.
    if (zm.series && zm.series.length > 1) {
        const fs = 10 * dpr;
        ctx.font = `${fs}px 'JetBrains Mono', monospace`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const padPx = 8 * dpr;
        const swatch = 14 * dpr;
        const lineH  = 14 * dpr;
        // Measure widest label.
        let maxLabel = 0;
        for (const s of zm.series) maxLabel = Math.max(maxLabel, ctx.measureText(s.label).width);
        const itemW = swatch + 6 * dpr + maxLabel + padPx;
        const lx = x0 + w - itemW - padPx;
        const ly = y0 + padPx;
        // Background panel for legibility.
        ctx.fillStyle = 'rgba(6, 22, 18, 0.78)';
        ctx.fillRect(lx - 6 * dpr, ly - 6 * dpr,
                     itemW + 6 * dpr, lineH * zm.series.length + 6 * dpr);
        for (let si = 0; si < zm.series.length; si++) {
            const s = zm.series[si];
            const yy = ly + si * lineH + lineH / 2;
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 2.5 * dpr;
            ctx.beginPath();
            ctx.moveTo(lx, yy);
            ctx.lineTo(lx + swatch, yy);
            ctx.stroke();
            ctx.fillStyle = '#E6EFE9';
            ctx.fillText(s.label, lx + swatch + 6 * dpr, yy);
        }
    }

    // Stash ticks for the axis renderer to label.
    zm._yTicks = ticks;
}

/** Pick ~n "nice" round-number ticks inside [vmin, vmax] including 0 if in range. */
function niceTicks(vmin, vmax, n = 5) {
    const span = vmax - vmin;
    if (!(span > 0)) return [vmin];
    const rough = span / Math.max(1, n - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step;
    if      (norm < 1.5) step = 1 * mag;
    else if (norm < 3)   step = 2 * mag;
    else if (norm < 7)   step = 5 * mag;
    else                 step = 10 * mag;
    const start = Math.ceil(vmin / step) * step;
    const ticks = [];
    for (let t = start; t <= vmax + 1e-9 * step; t += step) {
        // Round to suppress fp drift.
        ticks.push(Math.round(t / step) * step);
    }
    // Force-include 0 if it's in range and not already a tick.
    if (vmin <= 0 && vmax >= 0 && !ticks.some(t => Math.abs(t) < 1e-9 * step)) {
        ticks.push(0);
        ticks.sort((a, b) => a - b);
    }
    return ticks;
}

/**
 * Edmon–Hoskins–McIntyre arrows on the (lat, log-p) panel. zm.arrows holds
 * pre-balanced (dx, dy) so visual length is proportional in (φ, log p) space.
 * We rescale so the longest arrow occupies ~LONG_FRAC of the panel width.
 */
function drawEPArrows(ctx, x0, y0, w, h, zm) {
    const dpr = zm._dpr || 1;
    const { arrows, levels } = zm;
    const pMin = levels[0], pMax = levels[levels.length - 1];
    const logSpan = Math.log(pMax / pMin);
    const LONG_FRAC = 0.14;     // longest arrow ≈ 14% of plot width

    let maxLen = 0;
    for (let i = 0; i < arrows.dx.length; i++) {
        const m = Math.hypot(arrows.dx[i], arrows.dy[i]);
        if (m > maxLen) maxLen = m;
    }
    if (maxLen === 0) return;
    const targetPx = LONG_FRAC * w;
    const scale = targetPx / maxLen;

    ctx.save();
    // Dark ink with thin white halo for legibility on both pale (∇·F ≈ 0) and
    // saturated red/blue regions of the divergent colormap.
    const drawArrow = (x, y, x2, y2, lineW, headSize) => {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x2, y2);
        ctx.lineWidth = lineW;
        ctx.stroke();
        const ang = Math.atan2(y2 - y, x2 - x);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - headSize * Math.cos(ang - Math.PI / 6),
                   y2 - headSize * Math.sin(ang - Math.PI / 6));
        ctx.lineTo(x2 - headSize * Math.cos(ang + Math.PI / 6),
                   y2 - headSize * Math.sin(ang + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
    };

    const dustThresh = 2.5 * dpr;
    const lineW    = Math.max(1.4, dpr * 1.6);
    const haloW    = lineW + 2 * dpr;
    const headSize = Math.max(5, dpr * 5.5);

    for (let i = 0; i < arrows.lats.length; i++) {
        const lat = arrows.lats[i];
        const p   = arrows.pressures[i];
        const dx  = arrows.dx[i] * scale;
        const dy  = arrows.dy[i] * scale;
        if (Math.hypot(dx, dy) < dustThresh) continue;
        const x  = x0 + ((lat + 90) / 180) * w;
        const y  = y0 + h * (Math.log(p / pMin) / logSpan);
        const x2 = x + dx;
        const y2 = y + dy;
        // Halo first (white, slightly wider) for legibility.
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillStyle   = 'rgba(255, 255, 255, 0.85)';
        drawArrow(x, y, x2, y2, haloW, headSize + dpr);
        // Then dark arrow on top.
        ctx.strokeStyle = 'rgba(10, 18, 14, 0.95)';
        ctx.fillStyle   = 'rgba(10, 18, 14, 0.95)';
        drawArrow(x, y, x2, y2, lineW, headSize);
    }
    ctx.restore();
}

function drawAxes(ctx, x0, y0, w, h, zm) {
    const dpr = zm._dpr || 1;
    ctx.font = `${10 * dpr}px 'JetBrains Mono', monospace`;
    ctx.fillStyle = '#AEC3B6';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = dpr;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const lat of LAT_TICKS) {
        const x = x0 + ((lat + 90) / 180) * w;
        ctx.beginPath();
        ctx.moveTo(x, y0 + h);
        ctx.lineTo(x, y0 + h + 3 * dpr);
        ctx.stroke();
        ctx.fillText(`${lat}°`, x, y0 + h + 5 * dpr);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    if (zm.type === 'pl') {
        const pMax = zm.levels[zm.levels.length - 1];
        const pMin = zm.levels[0];
        const logSpan = Math.log(pMax / pMin);
        for (const p of P_TICKS) {
            if (p < pMin || p > pMax) continue;
            const y = y0 + h * (Math.log(p / pMin) / logSpan);
            ctx.beginPath();
            ctx.moveTo(x0 - 3 * dpr, y);
            ctx.lineTo(x0, y);
            ctx.stroke();
            ctx.fillText(`${p}`, x0 - 5 * dpr, y);
        }
        ctx.save();
        ctx.translate(x0 - 30 * dpr, y0 + h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText('hPa', 0, 0);
        ctx.restore();
    } else {
        // SL line plot — label every nice tick (computed by drawLine) with
        // the zero line emphasised in amber so divergent quantities have an
        // obvious reference baseline.
        const ticks = zm._yTicks || [zm.vmin, zm.vmax];
        const span  = (zm.vmax - zm.vmin) || 1;
        const tStep = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
        const decimals = tStep >= 10 ? 0 : tStep >= 1 ? 1 : 2;
        for (const t of ticks) {
            const y = y0 + h - ((t - zm.vmin) / span) * h;
            ctx.beginPath();
            ctx.moveTo(x0 - 3 * dpr, y);
            ctx.lineTo(x0, y);
            ctx.stroke();
            ctx.fillStyle = Math.abs(t) < 1e-9 ? '#E8C26A' : '#AEC3B6';
            ctx.fillText(t.toFixed(decimals), x0 - 5 * dpr, y);
        }
        ctx.fillStyle = '#AEC3B6';
        // Y-axis units label (rotated, on the left).
        if (zm.units) {
            ctx.save();
            ctx.translate(x0 - 32 * dpr, y0 + h / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.fillText(zm.units, 0, 0);
            ctx.restore();
        }
    }
}
