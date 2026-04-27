// GC-ATLAS — area-mean time series.
//
// Given a lat-lon bounding box + field + level, compute the cosine-latitude-
// weighted area mean across every per-year tile (1961–present, 12 months
// per year) and render a simple line chart on a 2D canvas.
//
// The engine intentionally doesn't prefetch tiles itself; it calls getField
// for every (year, month) and treats pending tiles as nulls. A caller
// triggers prefetching via prefetchField and re-renders on the onFieldLoaded
// subscribe as tiles land, so the chart fills in progressively.

import { GRID } from './data.js';

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Cosine-latitude area-weighted mean of `values` inside a lat-lon bbox.
 *  bbox.lonMin may exceed lonMax when the region wraps the dateline —
 *  ((lon + 180) % 360 + 360) % 360 - 180 normalizes to [-180, 180).
 *  Returns NaN when the box contains no finite samples. */
export function areaMean(values, nlat, nlon, lats, lons, bbox) {
    const latLo = Math.min(bbox.latMin, bbox.latMax);
    const latHi = Math.max(bbox.latMin, bbox.latMax);
    const norm = (lon) => ((lon + 180) % 360 + 360) % 360 - 180;
    const lonA = norm(bbox.lonMin);
    const lonB = norm(bbox.lonMax);
    // When lonA > lonB the user-drawn box wraps the dateline. In that case
    // a longitude is "inside" if it's ≥ lonA OR ≤ lonB.
    const wraps = lonA > lonB;
    let sum = 0, wSum = 0;
    for (let i = 0; i < nlat; i++) {
        const lat = lats[i];
        if (lat < latLo || lat > latHi) continue;
        const w = Math.cos(lat * Math.PI / 180);
        if (w <= 0) continue;
        const rowOff = i * nlon;
        for (let j = 0; j < nlon; j++) {
            const lon = norm(lons[j]);
            const inLon = wraps ? (lon >= lonA || lon <= lonB)
                                : (lon >= lonA && lon <= lonB);
            if (!inLon) continue;
            const v = values[rowOff + j];
            if (!Number.isFinite(v)) continue;
            sum += v * w;
            wSum += w;
        }
    }
    return wSum > 0 ? sum / wSum : NaN;
}

/** Build the monthly time series for the bbox across the given years.
 *  getField is the same API as data.js's (lets us reuse all the existing
 *  caching / pending-tile machinery).
 *    opts.anomaly  — subtract the same-month climatology from each value
 *    opts.period   — climatology tile tree used for the anomaly reference
 *  Series entries with null values indicate tiles still loading (or a
 *  bbox that fell entirely on land for an ocean-only field).
 *  Each entry: { year, month, value, t }  where t = year + (month − 0.5)/12. */
export function computeSeries(getField, region, opts) {
    const {
        field, level = null, coord = 'pressure', theta = 330,
        years, anomaly = false, period = 'default',
        // When true + anomaly, each year subtracts its best-match 30-yr
        // climatology (via bestClimoForYear) instead of the single fixed
        // `period`. Eliminates warming-trend bias when the series spans
        // many decades. Caller supplies the resolver so this module
        // stays decoupled from climo_windows.js.
        slidingClimo = false,
        bestClimoForYear = null,
    } = opts;
    // Cache keyed by (period, month) so best-match mode — which fetches
    // multiple climatology windows — deduplicates per window.
    const climoCache = new Map();
    const climoMean = (per, m) => {
        const key = `${per}:${m}`;
        if (climoCache.has(key)) return climoCache.get(key);
        const fc = getField(field, {
            month: m, level, coord, theta, kind: 'mean', period: per,
        });
        const v = fc.isReal
            ? areaMean(fc.values, GRID.nlat, GRID.nlon, fc.lats, fc.lons, region)
            : null;
        climoCache.set(key, v);
        return v;
    };
    const periodForYear = (y) => {
        if (slidingClimo && typeof bestClimoForYear === 'function') {
            const w = bestClimoForYear(y);
            if (w && w.id) return w.id;
        }
        return period;
    };

    const out = [];
    for (const y of years) {
        const climoPeriod = periodForYear(y);
        for (let m = 1; m <= 12; m++) {
            const f = getField(field, {
                month: m, level, coord, theta, kind: 'mean',
                period: 'per_year', year: y,
            });
            let value = null;
            if (f.isReal) {
                const v = areaMean(f.values, GRID.nlat, GRID.nlon, f.lats, f.lons, region);
                if (Number.isFinite(v)) {
                    if (anomaly) {
                        const vc = climoMean(climoPeriod, m);
                        value = (vc != null && Number.isFinite(vc)) ? (v - vc) : null;
                    } else {
                        value = v;
                    }
                }
            }
            out.push({ year: y, month: m, value, t: y + (m - 0.5) / 12 });
        }
    }
    return out;
}

function formatV(v) {
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 100)  return v.toFixed(1);
    if (a >= 10)   return v.toFixed(2);
    return v.toFixed(3);
}

/** Paint the series onto a canvas. `meta` carries field name + units +
 *  symmetric flag (forces vmin = −vmax for anomaly-style plots).
 *  Returns the plot transform so callers can implement hover readouts
 *  (tMin/tMax for x, vMin/vMax for y, plus the inset box coords). */
export function renderSeries(canvas, series, meta) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Size backing store to clientWidth × clientHeight (CSS pixels) × DPR.
    const cssW = canvas.clientWidth  || 520;
    const cssH = canvas.clientHeight || 230;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width  = cssW * dpr;
        canvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const padL = 56, padR = 14, padT = 10, padB = 22;
    const w = cssW - padL - padR;
    const h = cssH - padT - padB;

    const finite = series.filter(p => p.value != null && Number.isFinite(p.value));
    if (finite.length < 2) {
        ctx.fillStyle = '#8bb0a1';
        ctx.font = '12px ui-monospace, "JetBrains Mono", Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(finite.length === 0 ? 'Loading tiles…' : 'Insufficient data',
                     cssW / 2, cssH / 2);
        return null;
    }

    let tMin = Infinity, tMax = -Infinity;
    let vMin = Infinity, vMax = -Infinity;
    for (const p of finite) {
        if (p.t < tMin) tMin = p.t;
        if (p.t > tMax) tMax = p.t;
        if (p.value < vMin) vMin = p.value;
        if (p.value > vMax) vMax = p.value;
    }
    if (meta.symmetric) {
        const a = Math.max(Math.abs(vMin), Math.abs(vMax));
        vMin = -a; vMax = a;
    } else {
        const pad = (vMax - vMin || 1) * 0.06;
        vMin -= pad; vMax += pad;
    }
    const tSpan = (tMax - tMin) || 1;
    const vSpan = (vMax - vMin) || 1;
    const X = (t) => padL + (t - tMin) / tSpan * w;
    const Y = (v) => padT + (vMax - v) / vSpan * h;

    // Gridlines + axis ticks ─────────────────────────────────────────
    ctx.strokeStyle = 'rgba(139, 176, 161, 0.18)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#8bb0a1';
    ctx.font = '10px ui-monospace, Menlo, monospace';

    // Y: 5 ticks
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
        const v = vMin + (i / 4) * vSpan;
        const yy = Y(v);
        ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + w, yy); ctx.stroke();
        ctx.fillText(formatV(v), padL - 6, yy);
    }
    // X: every 10 years.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const firstTick = Math.ceil(tMin / 10) * 10;
    for (let tt = firstTick; tt <= tMax + 0.5; tt += 10) {
        const xx = X(tt);
        ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + h); ctx.stroke();
        ctx.fillText(String(tt), xx, padT + h + 4);
    }

    // Zero line (for anomaly / symmetric) ─────────────────────────
    if (meta.symmetric) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        const y0 = Y(0);
        ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(padL + w, y0); ctx.stroke();
        ctx.setLineDash([]);
    }

    // Series line ─────────────────────────────────────────────────
    ctx.strokeStyle = '#4fd1a5';
    ctx.lineWidth = 1.1;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (const p of series) {
        if (p.value == null || !Number.isFinite(p.value)) { pen = false; continue; }
        const xx = X(p.t), yy = Y(p.value);
        if (!pen) { ctx.moveTo(xx, yy); pen = true; }
        else      { ctx.lineTo(xx, yy); }
    }
    ctx.stroke();

    // Units label in top-right corner.
    if (meta.units) {
        ctx.fillStyle = '#8bb0a1';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.font = '10px ui-monospace, Menlo, monospace';
        ctx.fillText(meta.units, cssW - padR, padT - 2);
    }

    return {
        padL, padR, padT, padB, w, h, cssW, cssH,
        tMin, tMax, vMin, vMax,
    };
}

/** Given a hover context from renderSeries + a CSS-pixel mouse x,y,
 *  return the nearest series point + its plot coordinates, or null if
 *  the cursor is outside the plot area. */
export function hoverLookup(hctx, series, mx, my) {
    if (!hctx) return null;
    const { padL, padT, w, h, tMin, tMax, vMin, vMax } = hctx;
    if (mx < padL || mx > padL + w || my < padT || my > padT + h) return null;
    const t = tMin + (mx - padL) / w * (tMax - tMin);
    let best = null, bestD = Infinity;
    for (const p of series) {
        if (p.value == null || !Number.isFinite(p.value)) continue;
        const d = Math.abs(p.t - t);
        if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return null;
    const xOnPlot = padL + (best.t - tMin) / (tMax - tMin) * w;
    const yOnPlot = padT + (vMax - best.value) / (vMax - vMin) * h;
    return { point: best, xOnPlot, yOnPlot };
}

/** Human-readable bbox label: "10°S–10°N, 170°W–120°W". */
export function bboxLabel(bbox) {
    const latS = (v) => {
        const a = Math.abs(Math.round(v));
        if (a === 0) return 'Eq';
        return `${a}°${v >= 0 ? 'N' : 'S'}`;
    };
    const lonS = (v) => {
        const w = ((v + 180) % 360 + 360) % 360 - 180;
        const a = Math.abs(Math.round(w));
        if (a === 0) return '0°';
        if (a === 180) return '180°';
        return `${a}°${w >= 0 ? 'E' : 'W'}`;
    };
    const latA = Math.min(bbox.latMin, bbox.latMax);
    const latB = Math.max(bbox.latMin, bbox.latMax);
    return `${latS(latA)}–${latS(latB)}, ${lonS(bbox.lonMin)}–${lonS(bbox.lonMax)}`;
}

/** CSV download payload — year, month, value per row. */
export function seriesToCSV(series, meta) {
    const hdr = `# GC-ATLAS time series\n# field: ${meta.field}${meta.level ? ` · ${meta.level} hPa` : ''}\n# region: ${meta.region}\n# mode: ${meta.mode}\n# units: ${meta.units || ''}\nyear,month,value\n`;
    const rows = series.map(p => `${p.year},${p.month},${p.value == null ? '' : p.value}`);
    return hdr + rows.join('\n') + '\n';
}

export { MONTH_NAMES };
