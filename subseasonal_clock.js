/* Shared phase-clock renderer for subseasonal indices (MJO RMM,
 * MJO OMI, BSISO1, BSISO2, ROMI). Consumed by:
 *   - tc_climatology.js   (TC Climatology → Subseasonal section)
 *   - realtime_ir.js      (RT Monitor → Subseasonal tab)
 *
 * Source of truth for the visual: Wheeler-Hendon (2004) phase diagram
 * with 8 sectors, ±rmax bounding circle, amplitude=1 dashed ring, and
 * a fading N-day trail terminating in a today-marker dot. PC1/PC2 are
 * used when available in the index record; otherwise the dot falls
 * back to sector-midpoint geometry scaled by amplitude (older JSON
 * snapshots before 2026-05-17).
 *
 * Public API (window.SubseasonalClock):
 *   dayKeyFromISO(iso)         → integer day key for index math
 *   computeCurrent(modeRec)    → { lastIdx, dateISO, phase, amp, active } | null
 *   regionFor(mode, phase)     → human-readable basin label
 *   render(opts)               → renders SVG + optional label spans
 *
 * opts schema for render():
 *   svg:       (required) <svg> element to fill
 *   modeRec:   (required) record from subseasonal_phases.json indices[mode]
 *   mode:      (required) 'mjo' | 'mjo_omi' | 'bsiso1' | 'bsiso2' | 'romi'
 *   trailDays: optional, default 14
 *   size:      optional, default 120 (square px)
 *   labels:    optional object of DOM elements to populate:
 *              { modeEl, dateEl, phaseEl, ampEl, statusEl }
 */
window.SubseasonalClock = (function () {
    'use strict';

    var REGIONS_MJO = {
        1: 'W Hem / Africa',
        2: 'Indian Ocean',
        3: 'Indian Ocean',
        4: 'Maritime Continent',
        5: 'Maritime Continent',
        6: 'W Pacific',
        7: 'W Pacific / W Hem',
        8: 'W Hem / Africa',
    };
    var REGIONS_BSISO = {
        1: 'Indian Ocean (suppressed convection)',
        2: 'Eastern IO',
        3: 'BoB / Maritime Continent',
        4: 'WPac / Philippines',
        5: 'WPac (enhanced convection)',
        6: 'Subtropical WPac',
        7: 'NIO / Arabian Sea',
        8: 'Africa / Indian Ocean',
    };

    function dayKeyFromISO(iso) {
        var y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
        return Date.UTC(y, m - 1, d) / 86400000;
    }

    function regionFor(mode, phase) {
        if (mode === 'mjo' || mode === 'mjo_omi' || mode === 'romi') {
            return REGIONS_MJO[phase] || 'unknown';
        }
        return REGIONS_BSISO[phase] || 'unknown';
    }

    function computeCurrent(modeRec) {
        if (!modeRec) return null;
        var phases = modeRec.phases, amps = modeRec.amplitudes;
        if (!phases || !amps) return null;
        var lastIdx = phases.length - 1;
        while (lastIdx >= 0 && (phases[lastIdx] == null || amps[lastIdx] == null)) lastIdx--;
        if (lastIdx < 0) return null;
        if (modeRec._startKey == null) modeRec._startKey = dayKeyFromISO(modeRec.start_date);
        var dateMs = (modeRec._startKey + lastIdx) * 86400000;
        var dateISO = new Date(dateMs).toISOString().slice(0, 10);
        var phase = phases[lastIdx];
        var amp = amps[lastIdx];
        return {
            lastIdx: lastIdx,
            dateISO: dateISO,
            phase: phase,
            amp: amp,
            active: amp >= 1.0,
        };
    }

    /* Theme-aware palette. Mirrors what tc_climatology.js used inline so
     * both pages stay visually consistent across light/dark. */
    function _palette() {
        var theme = (window.TCATheme && window.TCATheme.current) || 'light';
        if (theme === 'dark') {
            return {
                bgFill:     '#161b24',
                stroke:     'rgba(255,255,255,0.30)',
                labelColor: '#cbd5e1',
            };
        }
        return {
            bgFill:     '#ffffff',
            stroke:     'rgba(0,0,0,0.30)',
            labelColor: '#64748b',
        };
    }

    /* Append a GEFS forecast trajectory to the SVG `parts` array.
     * fc schema (written by build_subseasonal_overlays.py, present only on
     * the MJO/RMM record):
     *   { member, source, times:[iso..], rmm1:[..], rmm2:[..],
     *     members?: [ {rmm1:[..], rmm2:[..]}, ... ] }   // optional spread
     * rmm1[0]/rmm2[0] is the init day (≈ today's observed dot). `pcToXY`
     * maps (pc1,pc2)→{x,y}; `trail` supplies the today-marker as the anchor.
     */
    function _renderForecast(parts, fc, pcToXY, trail) {
        if (!fc || !Array.isArray(fc.rmm1) || !Array.isArray(fc.rmm2)
            || !fc.rmm1.length) return;
        var FC_COLOR = '#00e5ff';   // DeepMind cyan — distinct from the blue trail
        var anchor = (trail && trail.length) ? trail[trail.length - 1] : null;

        function pathFrom(r1, r2, startAnchor) {
            var d = '', started = false;
            if (startAnchor) {
                d = 'M' + startAnchor.x.toFixed(1) + ',' + startAnchor.y.toFixed(1);
                started = true;
            }
            var pts = [];
            for (var i = 0; i < r1.length; i++) {
                if (r1[i] == null || r2[i] == null) continue;
                var p = pcToXY(r1[i], r2[i]);
                pts.push(p);
                d += (started ? ' L' : 'M') + p.x.toFixed(1) + ',' + p.y.toFixed(1);
                started = true;
            }
            return { d: d, pts: pts };
        }

        // Per-member spread cloud (faint), drawn first so the mean sits on top.
        if (Array.isArray(fc.members)) {
            fc.members.forEach(function (mb) {
                if (!mb || !Array.isArray(mb.rmm1) || !Array.isArray(mb.rmm2)) return;
                var mp = pathFrom(mb.rmm1, mb.rmm2, anchor);
                if (mp.pts.length) {
                    parts.push('<path d="' + mp.d + '" fill="none" stroke="'
                        + FC_COLOR + '" stroke-opacity="0.16" stroke-width="0.8"/>');
                }
            });
        }

        // Ensemble-mean forecast path + nodes.
        var fm = pathFrom(fc.rmm1, fc.rmm2, anchor);
        if (!fm.pts.length) return;
        parts.push('<path d="' + fm.d + '" fill="none" stroke="' + FC_COLOR
            + '" stroke-width="1.5" stroke-dasharray="3,2"/>');
        fm.pts.forEach(function (p) {
            parts.push('<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1)
                + '" r="1.6" fill="' + FC_COLOR + '" fill-opacity="0.85"/>');
        });
        var last = fm.pts[fm.pts.length - 1];
        // Lead label: forecast days beyond init (index 0 ≈ today).
        var lead = Math.max(1, fm.pts.length - 1);
        parts.push('<text x="' + (last.x + 4).toFixed(1) + '" y="' + (last.y - 4).toFixed(1)
            + '" font-size="8" font-weight="600" fill="' + FC_COLOR + '">+'
            + lead + 'd</text>');
    }

    function _renderSVG(svg, modeRec, mode, opts) {
        if (!svg || !modeRec) return null;
        var size = opts && opts.size ? opts.size : 120;
        var trailDays = opts && opts.trailDays ? opts.trailDays : 14;
        var current = computeCurrent(modeRec);
        if (!current) { svg.innerHTML = ''; return null; }

        var phases = modeRec.phases, amps = modeRec.amplitudes;
        var hasPCs = Array.isArray(modeRec.pc1) && Array.isArray(modeRec.pc2);
        var pal = _palette();

        var W = size, H = size, cx = W / 2, cy = H / 2;
        // Bounding circle leaves a 10-px margin for phase labels.
        var R = (size / 2) - 10;
        var rmax = 3.0;

        function pcToXY(pc1v, pc2v) {
            return {
                x: cx + R * pc1v / rmax,
                y: cy - R * pc2v / rmax,
            };
        }
        function fallbackXY(phase, amp) {
            var ang = ((phase - 1) * 45 - 180 + 22.5) * Math.PI / 180;
            var rr = R * Math.min(amp / rmax, 1);
            return { x: cx + rr * Math.cos(ang), y: cy + rr * Math.sin(ang) };
        }

        // Set SVG viewBox + dims so it scales correctly regardless of caller CSS.
        svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

        var parts = [];
        parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + R
            + '" fill="' + pal.bgFill + '" stroke="' + pal.stroke + '" stroke-width="1"/>');
        var rAmp1 = R / rmax;
        parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + rAmp1
            + '" fill="none" stroke="' + pal.stroke
            + '" stroke-width="0.8" stroke-dasharray="2,2"/>');
        for (var k = 0; k < 8; k++) {
            var ang0 = (k * 45 - 180) * Math.PI / 180;
            var x2 = cx + R * Math.cos(ang0), y2 = cy + R * Math.sin(ang0);
            parts.push('<line x1="' + cx + '" y1="' + cy
                + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1)
                + '" stroke="' + pal.stroke + '" stroke-width="0.5"/>');
        }
        for (var pp = 1; pp <= 8; pp++) {
            var midAng = ((pp - 1) * 45 - 180 + 22.5) * Math.PI / 180;
            var lx = cx + (R + 7) * Math.cos(midAng);
            var ly = cy - (R + 7) * Math.sin(midAng);
            parts.push('<text x="' + lx.toFixed(1) + '" y="' + (ly + 3).toFixed(1)
                + '" text-anchor="middle" font-size="9" fill="' + pal.labelColor + '">'
                + pp + '</text>');
        }

        // Trail
        var trail = [];
        for (var d = trailDays - 1; d >= 0; d--) {
            var ix = current.lastIdx - d;
            if (ix < 0) continue;
            var phx = phases[ix], aax = amps[ix];
            if (phx == null || aax == null) continue;
            var pt;
            if (hasPCs && modeRec.pc1[ix] != null && modeRec.pc2[ix] != null) {
                pt = pcToXY(modeRec.pc1[ix], modeRec.pc2[ix]);
            } else {
                pt = fallbackXY(phx, aax);
            }
            pt.age = d; pt.amp = aax;
            trail.push(pt);
        }
        if (trail.length >= 2) {
            var path = 'M' + trail[0].x.toFixed(1) + ',' + trail[0].y.toFixed(1);
            for (var t = 1; t < trail.length; t++) {
                path += ' L' + trail[t].x.toFixed(1) + ',' + trail[t].y.toFixed(1);
            }
            parts.push('<path d="' + path
                + '" fill="none" stroke="rgba(46,125,255,0.55)" stroke-width="1.5"/>');
        }
        trail.forEach(function (ptt) {
            var op = 0.20 + 0.80 * ((trailDays - 1 - ptt.age) / Math.max(1, trailDays - 1));
            if (ptt.age === 0) {
                var todayFill = ptt.amp >= 1 ? '#ef4444' : '#94a3b8';
                parts.push('<circle cx="' + ptt.x.toFixed(1) + '" cy="' + ptt.y.toFixed(1)
                    + '" r="6" fill="rgba(239,68,68,0.18)" stroke="' + todayFill
                    + '" stroke-width="1.2"/>');
                parts.push('<circle cx="' + ptt.x.toFixed(1) + '" cy="' + ptt.y.toFixed(1)
                    + '" r="3" fill="' + todayFill + '"/>');
            } else {
                parts.push('<circle cx="' + ptt.x.toFixed(1) + '" cy="' + ptt.y.toFixed(1)
                    + '" r="1.8" fill="rgba(46,125,255,' + op.toFixed(2) + ')"/>');
            }
        });

        // GEFS forecast trajectory (RMM/MJO only — only that record carries a
        // `forecast` block). Drawn forward from the today-marker in DeepMind
        // cyan, dashed, with an optional faint per-member spread cloud behind
        // the ensemble-mean path. Anchored at the today dot so the
        // analysis-vs-observed offset (if any) is visible as the first
        // segment. Absent forecast → nothing drawn (graceful).
        _renderForecast(parts, modeRec.forecast, pcToXY, trail);

        svg.innerHTML = parts.join('');
        return current;
    }

    function render(opts) {
        opts = opts || {};
        var current = _renderSVG(opts.svg, opts.modeRec, opts.mode, opts);
        var labels = opts.labels || {};
        if (labels.modeEl && opts.modeRec) labels.modeEl.textContent = opts.modeRec.label;
        if (!current) {
            if (labels.dateEl) labels.dateEl.textContent = '(no data)';
            return null;
        }
        if (labels.dateEl)  labels.dateEl.textContent  = current.dateISO;
        if (labels.phaseEl) labels.phaseEl.textContent = String(current.phase);
        if (labels.ampEl)   labels.ampEl.textContent   = current.amp.toFixed(2);
        if (labels.statusEl) {
            var region = regionFor(opts.mode, current.phase);
            labels.statusEl.innerHTML = (current.active
                ? '✓ <strong>Active</strong>'
                : '○ Quiescent')
                + ' · ' + region + ' convective envelope';
        }
        return current;
    }

    return {
        dayKeyFromISO: dayKeyFromISO,
        computeCurrent: computeCurrent,
        regionFor: regionFor,
        render: render,
    };
})();
