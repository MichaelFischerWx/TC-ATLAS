/* recon_eye.js — SEAR "eyewall peaks" still for the Recon > Live Flight tab.
 *
 * One aircraft sortie, storm-relative, over parallax-corrected GOES IR: the
 * flight track colored by flight-level wind, a pink circle at the SEAR 10-m
 * peak of every inbound and outbound eyewall leg of every eye penetration
 * (sized by wind, labeled "155 / P1 out 18:14"), and a white + at the center.
 * A small preview sits in the top-right of the Live Flight map while a sortie
 * has eye penetrations; clicking it opens the full view. Works for live
 * missions and for storms replayed from the SEAR archive.
 *
 * Spec: the forecaster still for Polo (NOAA3, 22 Sep 2026; eye_data.py +
 * render_eye.py). Algorithm, per sortie:
 *   - radius to the moving center per ob, rolling median over 31 s;
 *   - an eye = a local minimum below 10 km within +-600 s, eyes > 600 s apart;
 *   - a penetration runs from the radius maximum after the previous eye to the
 *     radius maximum before the next eye;
 *   - inbound leg = before the eye, outbound = after, each within r <= 60 km;
 *   - leg peak = the highest SEAR 10-m estimate on that leg (from the 10-s peak).
 * Placement: each ob's offset from the time-interpolated center, drawn around
 * the center at the IR frame's time.
 *
 * Data: the flight track (lat/lon/flight-level wind, eye included) is the
 * recon feed the tab already loads. SEAR values are the publisher's 1-s scored
 * obs (<ATCF>.txt, integer kt; the 10-s JSON series takes its decimals where it
 * has the same second). The JSON alone is a fallback: at 10 s it misses leg
 * peaks between samples (Polo: 7 of 14 off by 0.2-3.9 kt).
 *
 * SEAR is an experimental research estimate, not an official product.
 */
(function (root) {
    'use strict';

    var KMD = 111.32;                 // km per degree latitude
    var PINK = '#ec4899';
    var EYE_R_KM = 10, EYE_WIN_S = 600, EYE_SEP_S = 600, MED_HALF_S = 15, LEG_R_KM = 60;
    var EYE_POST_S = 120;             // live: an eye counts once 2 min of track follow it
    var EYEWALL_KT = 64;              // a sortie qualifies once a leg peak reaches hurricane force:
                                      // a tropical storm's center crossings have no eyewall to show
    var LIVE_GAP_MS = 90 * 60000;     // a sortie with an ob in the last 90 min may still be flying
    var PREVIEW_KEEP_S = 12 * 3600;   // the map preview stays up 12 h after a finished flight's last eye
    var WIND_STOPS = [[34, '#60a5fa'], [50, '#22c55e'], [64, '#eab308'], [83, '#f97316'],
                      [96, '#ef4444'], [113, '#9d174d'], [137, '#c026d3'], [9999, '#7c3aed']];
    var WIND_LABELS = ['<34', '34', '50', '64', '83', '96', '113', '137+'];
    var IR_VMIN = 190, IR_VMAX = 300;   // the still's stretch: most of the range on a cold CDO
    var IR_PTS = [[190, 0.97], [194, 0.90], [198, 0.79], [202, 0.67], [206, 0.58], [212, 0.49],
                  [222, 0.40], [240, 0.29], [265, 0.17], [300, 0.05]];
    var SATS = { 'GOES-East': -75.2, 'GOES-West': -137.2, 'Himawari': 140.7 };
    var CLOUD_TOP_KM = 12;

    // ══════════════════════════════════════════════════════════════════════
    //  core algorithm (pure; node-testable)
    // ══════════════════════════════════════════════════════════════════════

    /** Centered rolling median over |dt| <= half (s); nulls skipped; even
     *  counts average the middle pair (pandas). t ascending. */
    function rollingMedian(t, v, half) {
        var n = t.length, out = new Array(n), lo = 0, hi = 0, buf = [];
        for (var i = 0; i < n; i++) {
            while (t[lo] < t[i] - half) lo++;
            if (hi < i) hi = i;
            while (hi + 1 < n && t[hi + 1] <= t[i] + half) hi++;
            buf.length = 0;
            for (var j = lo; j <= hi; j++) if (v[j] != null && isFinite(v[j])) buf.push(v[j]);
            if (!buf.length) { out[i] = null; continue; }
            buf.sort(function (a, b) { return a - b; });
            var m = buf.length >> 1;
            out[i] = (buf.length & 1) ? buf[m] : (buf[m - 1] + buf[m]) / 2;
        }
        return out;
    }

    /** Indices of eye passages: rolling-median radius < 10 km and the lowest
     *  within +-600 s; the first of a cluster, eyes more than 600 s apart. */
    function findEyes(t, r) {
        var rr = rollingMedian(t, r, MED_HALF_S), n = t.length, eyes = [], lo = 0, hi = 0;
        for (var i = 0; i < n; i++) {
            if (rr[i] == null || !(rr[i] < EYE_R_KM)) continue;
            while (t[lo] < t[i] - EYE_WIN_S) lo++;
            if (hi < i) hi = i;
            while (hi + 1 < n && t[hi + 1] < t[i] + EYE_WIN_S) hi++;
            var mn = Infinity;
            for (var j = lo; j <= hi; j++) if (rr[j] != null && rr[j] < mn) mn = rr[j];
            if (rr[i] > mn) continue;
            if (!eyes.length || t[i] - t[eyes[eyes.length - 1]] > EYE_SEP_S) eyes.push(i);
        }
        return eyes;
    }

    function argmax(v, a, b) {   // first index of the largest non-null v[a..b)
        var best = -1, bv = -Infinity;
        for (var k = a; k < b; k++) if (v[k] != null && v[k] > bv) { bv = v[k]; best = k; }
        return best < 0 ? a : best;
    }

    /** Eye penetrations and leg peaks for one sortie.
     *  track: {t:[s], r:[km]} every ob of the sortie (eye included), ascending.
     *  sear:  {t:[s], y:[kt], r:[km]} SEAR-scored obs of the same aircraft, ascending.
     *  opt.live: the sortie may still be flying — an eye needs 2 min of track
     *  after it, and a leg whose SEAR obs stop short of its end is "so far".
     *  Returns {eyes:[t], legs:[{pen, leg:'in'|'out', i, t, kt, r, tEye, done}]}. */
    function eyewallLegs(track, sear, opt) {
        opt = opt || {};
        var T = track.t, R = track.r, n = T.length;
        var eyes = n ? findEyes(T, R) : [];
        if (opt.live && eyes.length && T[n - 1] - T[eyes[eyes.length - 1]] < EYE_POST_S) eyes.pop();
        var searEnd = sear.t.length ? sear.t[sear.t.length - 1] : -Infinity;
        var legs = [];
        for (var k = 0; k < eyes.length; k++) {
            var i = eyes[k];
            var lo = k === 0 ? 0 : argmax(R, eyes[k - 1], i);
            var hi = k === eyes.length - 1 ? n - 1 : argmax(R, i, eyes[k + 1]);
            var tLo = T[lo], tHi = T[hi], tEye = T[i];
            var tExit = null;   // the outbound leg ends where the track leaves the core
            for (var q = i; q <= hi; q++) if (R[q] != null && R[q] > LEG_R_KM) { tExit = T[q]; break; }
            if (tExit == null && k < eyes.length - 1) tExit = tHi;
            ['in', 'out'].forEach(function (leg) {
                var best = -1, bv = -Infinity;
                for (var j = 0; j < sear.t.length; j++) {
                    var tj = sear.t[j];
                    if (tj < tLo) continue;
                    if (tj > tHi) break;
                    if (leg === 'in' ? !(tj < tEye) : !(tj > tEye)) continue;
                    if (sear.r[j] == null || !(sear.r[j] <= LEG_R_KM) || sear.y[j] == null) continue;
                    if (sear.y[j] > bv) { bv = sear.y[j]; best = j; }
                }
                if (best < 0) return;
                var done = !opt.live || (leg === 'in' ? searEnd >= tEye : (tExit != null && searEnd >= tExit));
                legs.push({ pen: k + 1, leg: leg, i: best, t: sear.t[best], kt: sear.y[best], r: sear.r[best],
                            tEye: tEye, done: done });
            });
        }
        return { eyes: eyes.map(function (e) { return T[e]; }), legs: legs };
    }

    /** Center at time t (s) from fixes [{t, lat, lon}] (ascending): linear
     *  between fixes; beyond the ends, carried along the motion over the end
     *  fixes (>= 45 min of them, <= 6 h) for up to 2 h, else held. */
    function centerAt(fixes, t) {
        var n = fixes.length;
        if (!n) return null;
        if (n === 1) return { lat: fixes[0].lat, lon: fixes[0].lon };
        if (t >= fixes[0].t && t <= fixes[n - 1].t) {
            var lo = 0, hi = n - 1;
            while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (fixes[mid].t <= t) lo = mid; else hi = mid; }
            var a = fixes[lo], b = fixes[hi], w = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
            return { lat: a.lat + w * (b.lat - a.lat), lon: a.lon + w * (b.lon - a.lon) };
        }
        var after = t > fixes[n - 1].t, end = after ? fixes[n - 1] : fixes[0], other = null;
        for (var k = 0; k < n; k++) {
            var f = after ? fixes[n - 1 - k] : fixes[k];
            var span = Math.abs(end.t - f.t);
            if (span > 6 * 3600) break;
            if (span >= 45 * 60) other = f;
        }
        if (!other) return { lat: end.lat, lon: end.lon };
        var dt = Math.max(-7200, Math.min(7200, t - end.t)), s = dt / (end.t - other.t);
        return { lat: end.lat + s * (end.lat - other.lat), lon: end.lon + s * (end.lon - other.lon) };
    }

    function offsetKm(lat, lon, c) {   // storm-relative km (east, north) of a point from center c
        return { x: (lon - c.lon) * KMD * Math.cos(c.lat * Math.PI / 180), y: (lat - c.lat) * KMD };
    }

    // ══════════════════════════════════════════════════════════════════════
    //  SEAR .txt (SCORED OBSERVATIONS) parser
    // ══════════════════════════════════════════════════════════════════════

    function isoSec(s) {   // "2026-09-22T18:11:35Z" -> epoch s
        return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16), +s.slice(17, 19)) / 1000;
    }
    function num(tok) { if (tok == null || tok === '----') return null; var v = +tok; return isFinite(v) ? v : null; }

    /** {tail: {t, lat, lon, r, az, y}} from the publisher's text product. The
     *  1-s SEAR_PK is printed in whole kt; where the JSON series (decimals) has
     *  the same second, its value is used. */
    function parseSearText(text, json) {
        var at = text.indexOf('== SCORED OBSERVATIONS');
        if (at < 0) return null;
        var dec = {};
        Object.keys((json && json.aircraft) || {}).forEach(function (tail) {
            var a = json.aircraft[tail], m = dec[tail] = new Map();
            (a.t || []).forEach(function (iso, k) { if (a.yp && a.yp[k] != null) m.set(isoSec(iso), a.yp[k]); });
        });
        var out = {}, lines = text.slice(at).split('\n');
        for (var i = 2; i < lines.length; i++) {
            var ln = lines[i];
            if (ln.length < 40 || ln.charCodeAt(0) !== 50) continue;   // rows start with the year ('2')
            var p = ln.trim().split(/\s+/);
            if (p.length < 16) continue;
            var tail = p[1], t = isoSec(p[0]);
            var a = out[tail] || (out[tail] = { t: [], lat: [], lon: [], r: [], az: [], y: [], fl: [] });
            var y = num(p[14]), d = dec[tail] && dec[tail].get(t);
            a.t.push(t); a.lat.push(num(p[2])); a.lon.push(num(p[3])); a.fl.push(num(p[5]));
            a.r.push(num(p[9])); a.az.push(num(p[10])); a.y.push(d != null ? d : y);
        }
        return out;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  model: flights with eye penetrations, from what the tab has loaded
    // ══════════════════════════════════════════════════════════════════════

    function msOf(t) {
        if (t == null) return NaN;
        var s = String(t);
        return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
    }

    /** Fixes for the center track: VDMs (dated) first, then SEAR pass centers
     *  (VDM or preliminary) more than 3 min from any VDM. */
    function buildFixes(vdms, passes) {
        var fx = [];
        (vdms || []).forEach(function (v) {
            var t = msOf(v.t);
            if (!isNaN(t) && v.lat != null && v.lon != null) fx.push({ t: t / 1000, lat: +v.lat, lon: +v.lon });
        });
        (passes || []).forEach(function (p) {
            var t = msOf(p.fix_t || p.t);
            if (isNaN(t) || p.clat == null || p.clon == null) return;
            t /= 1000;
            for (var k = 0; k < fx.length; k++) if (Math.abs(fx[k].t - t) < 180) return;
            fx.push({ t: t, lat: +p.clat, lon: +p.clon });
        });
        fx.sort(function (a, b) { return a.t - b.t; });
        return fx.filter(function (f, k) { return !k || f.t !== fx[k - 1].t; });
    }

    /** SEAR obs of one aircraft between t0 and t1 (s): 1-s text rows when
     *  loaded, else the JSON's 10-s series (placement from r/az). */
    function searSeries(tail, t0, t1, obs1s, json) {
        var s = { t: [], y: [], r: [], lat: [], lon: [], az: [], src: '' }, a, k;
        if (obs1s && obs1s[tail]) {
            a = obs1s[tail]; s.src = '1s';
            for (k = 0; k < a.t.length; k++) {
                if (a.t[k] < t0 || a.t[k] > t1) continue;
                s.t.push(a.t[k]); s.y.push(a.y[k]); s.r.push(a.r[k]); s.lat.push(a.lat[k]); s.lon.push(a.lon[k]); s.az.push(a.az[k]);
            }
            return s;
        }
        a = json && json.aircraft && json.aircraft[tail];
        if (!a) return s;
        s.src = '10s';
        for (k = 0; k < (a.t || []).length; k++) {
            var t = isoSec(a.t[k]);
            if (t < t0 || t > t1) continue;
            s.t.push(t); s.y.push(a.yp ? a.yp[k] : a.y[k]); s.r.push(a.r ? a.r[k] : null);
            s.lat.push(null); s.lon.push(null); s.az.push(a.az ? a.az[k] : null);
        }
        return s;
    }

    /** Every sortie with at least one eye penetration and leg peak.
     *  opts: {aircraft, vdms, sear (payload), obs1s, nowMs, sortieKey(ac)} */
    function buildModel(opts) {
        var fixes = buildFixes(opts.vdms, opts.sear && opts.sear.passes);
        var nowS = (opts.nowMs || Date.now()) / 1000;
        var flights = [];
        if (!fixes.length) return { fixes: fixes, flights: flights };
        (opts.aircraft || []).forEach(function (ac) {
            var tr = ac.track || [];
            if (tr.length < 10) return;
            var trk = { t: [], r: [], x: [], y: [], fl: [] };
            tr.forEach(function (o) {
                var t = msOf(o.t);
                if (isNaN(t) || o.lat == null || o.lon == null || (Math.abs(o.lat) < 0.05 && Math.abs(o.lon) < 0.05)) return;
                t /= 1000;
                if (t > nowS) return;
                var c = centerAt(fixes, t), d = offsetKm(o.lat, o.lon, c);
                trk.t.push(t); trk.x.push(d.x); trk.y.push(d.y); trk.r.push(Math.hypot(d.x, d.y));
                trk.fl.push(o.peak_fl_kt != null ? o.peak_fl_kt : (o.wspd_kt != null ? o.wspd_kt : null));
            });
            if (trk.t.length < 10) return;
            var t0 = trk.t[0], t1 = trk.t[trk.t.length - 1];
            var live = nowS - t1 < LIVE_GAP_MS / 1000;
            var sear = searSeries(ac.tail, t0 - 300, Math.min(t1 + 300, nowS), opts.obs1s, opts.sear);
            if (!sear.t.length) return;
            var res = eyewallLegs(trk, sear, { live: live });
            if (!res.legs.some(function (L) { return L.kt >= EYEWALL_KT; })) return;
            res.legs.forEach(function (L) {
                var j = L.i, c = centerAt(fixes, L.t), p;
                if (sear.lat[j] != null && sear.lon[j] != null) p = offsetKm(sear.lat[j], sear.lon[j], c);
                else {
                    var az = (sear.az[j] || 0) * Math.PI / 180;
                    p = { x: L.r * Math.sin(az), y: L.r * Math.cos(az) };
                }
                L.x = p.x; L.y = p.y;
            });
            var kts = res.legs.map(function (L) { return L.kt; });
            flights.push({
                key: opts.sortieKey ? opts.sortieKey(ac) : (ac.tail + '#' + t0),
                tail: ac.tail, t0: t0, t1: t1, live: live, track: trk, eyes: res.eyes, legs: res.legs,
                src: sear.src, ktMin: Math.min.apply(null, kts), ktMax: Math.max.apply(null, kts),
                lastEye: res.eyes[res.eyes.length - 1]
            });
        });
        flights.sort(function (a, b) { return a.lastEye - b.lastEye; });
        return { fixes: fixes, flights: flights };
    }

    // ══════════════════════════════════════════════════════════════════════
    //  IR backdrop: parallax-corrected Tb grid around a center
    // ══════════════════════════════════════════════════════════════════════

    function ecef(r, lat, lon) {
        var p = lat * Math.PI / 180, l = lon * Math.PI / 180;
        return [r * Math.cos(p) * Math.cos(l), r * Math.cos(p) * Math.sin(l), r * Math.sin(p)];
    }
    /** Where a geostationary satellite at sublon puts a cloud top h km above
     *  (lat, lon) — parallax.forward, spherical Earth. */
    function parallaxForward(lat, lon, h, sublon) {
        var RE = 6371.0088, S = ecef(RE + 35786.0, 0, sublon), P = ecef(RE + h, lat, lon);
        var d = [P[0] - S[0], P[1] - S[1], P[2] - S[2]], dn = Math.hypot(d[0], d[1], d[2]);
        d = [d[0] / dn, d[1] / dn, d[2] / dn];
        var b = 2 * (S[0] * d[0] + S[1] * d[1] + S[2] * d[2]);
        var c = S[0] * S[0] + S[1] * S[1] + S[2] * S[2] - RE * RE, disc = b * b - 4 * c;
        if (disc < 0) return { lat: lat, lon: lon };
        var k = (-b - Math.sqrt(disc)) / 2, A = [S[0] + k * d[0], S[1] + k * d[1], S[2] + k * d[2]];
        return { lat: Math.asin(Math.max(-1, Math.min(1, A[2] / RE))) * 180 / Math.PI,
                 lon: Math.atan2(A[1], A[0]) * 180 / Math.PI };
    }
    function bestSat(lon) {   // the mosaic's own rule: the most nadir view
        var best = null, bc = -2;
        Object.keys(SATS).forEach(function (k) {
            var c = Math.cos((lon - SATS[k]) * Math.PI / 180);
            if (c > bc) { bc = c; best = k; }
        });
        return best;
    }

    function decodeTile(blob) {
        if (!blob) return Promise.resolve(null);
        var draw = function (img) {
            var cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
            var cx = cv.getContext('2d', { willReadFrequently: true });
            cx.drawImage(img, 0, 0, 512, 512);
            var d = cx.getImageData(0, 0, 512, 512).data, out = new Uint8Array(512 * 512);
            for (var i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j + 3] ? d[j] : 0;
            return out;
        };
        if (typeof createImageBitmap === 'function') {
            return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
                .catch(function () { return createImageBitmap(blob); })
                .then(draw).catch(function () { return null; });
        }
        return new Promise(function (res) {
            var u = URL.createObjectURL(blob), im = new Image();
            im.onload = function () { try { res(draw(im)); } catch (e) { res(null); } URL.revokeObjectURL(u); };
            im.onerror = function () { res(null); URL.revokeObjectURL(u); };
            im.src = u;
        });
    }

    /** Tb grid (N x N, row 0 = north) over a square of half-size halfKm around
     *  c, sampled nearest-neighbor from a mosaic frame at the parallax-shifted
     *  position of a 12-km cloud top. frame = kit.irFrame(...) result. */
    function sampleIR(frame, c, halfKm, N) {
        var sat = bestSat(c.lon), ap = parallaxForward(c.lat, c.lon, CLOUD_TOP_KM, SATS[sat]);
        var dLat = ap.lat - c.lat, dLon = ap.lon - c.lon, kx = KMD * Math.cos(c.lat * Math.PI / 180);
        function merc(lat, lon, S) {
            var p = lat * Math.PI / 180;
            return [(lon + 180) / 360 * S, (1 - Math.log(Math.tan(p) + 1 / Math.cos(p)) / Math.PI) / 2 * S];
        }
        function attempt(z) {
            var S = 512 * Math.pow(2, z);
            var a = merc(c.lat + dLat + halfKm / KMD, c.lon + dLon - halfKm / kx, S);
            var b = merc(c.lat + dLat - halfKm / KMD, c.lon + dLon + halfKm / kx, S);
            var tx0 = Math.floor(a[0] / 512), tx1 = Math.floor(b[0] / 512), ty0 = Math.floor(a[1] / 512), ty1 = Math.floor(b[1] / 512);
            var keys = [];
            for (var tx = tx0; tx <= tx1; tx++) for (var ty = ty0; ty <= ty1; ty++) keys.push([tx, ty]);
            return Promise.all(keys.map(function (k) { return frame.tile(z, k[0], k[1]).then(decodeTile); })).then(function (arrs) {
                if (arrs.some(function (x) { return !x; })) return null;
                var tiles = {};
                keys.forEach(function (k, i) { tiles[k[0] + '/' + k[1]] = arrs[i]; });
                var tb = new Float32Array(N * N), vmin = frame.trange[0], vmax = frame.trange[1];
                for (var py = 0; py < N; py++) {
                    var yk = halfKm - (py + 0.5) / N * 2 * halfKm;
                    for (var px = 0; px < N; px++) {
                        var xk = (px + 0.5) / N * 2 * halfKm - halfKm;
                        var m = merc(c.lat + yk / KMD + dLat, c.lon + xk / kx + dLon, S);
                        var tx = Math.floor(m[0] / 512), ty = Math.floor(m[1] / 512), t = tiles[tx + '/' + ty];
                        var idx = t ? t[Math.min(511, Math.floor(m[1] - ty * 512)) * 512 + Math.min(511, Math.floor(m[0] - tx * 512))] : 0;
                        tb[py * N + px] = idx ? vmax - idx / 255 * (vmax - vmin) : NaN;
                    }
                }
                return { tb: tb, N: N, z: z, sat: sat, shiftKm: Math.hypot(dLon * kx, dLat * KMD) };
            });
        }
        var zs = [];
        for (var z = Math.min(6, frame.zmax || 6); z >= 4; z--) zs.push(z);
        return zs.reduce(function (p, z) { return p.then(function (r) { return r || attempt(z); }); }, Promise.resolve(null));
    }

    function irGray(tb) {   // the still's tinted gray stretch
        if (!isFinite(tb)) return null;
        var g;
        if (tb <= IR_PTS[0][0]) g = IR_PTS[0][1];
        else if (tb >= IR_PTS[IR_PTS.length - 1][0]) g = IR_PTS[IR_PTS.length - 1][1];
        else for (var k = 1; k < IR_PTS.length; k++) {
            if (tb <= IR_PTS[k][0]) {
                var a = IR_PTS[k - 1], b = IR_PTS[k], w = (tb - a[0]) / (b[0] - a[0]);
                g = a[1] + w * (b[1] - a[1]); break;
            }
        }
        return [Math.round(g * 0.965 * 255), Math.round(g * 0.98 * 255), Math.round(g * 255)];
    }
    function irCanvas(ir) {
        var cv = document.createElement('canvas'); cv.width = ir.N; cv.height = ir.N;
        var cx = cv.getContext('2d'), im = cx.createImageData(ir.N, ir.N), d = im.data;
        for (var i = 0; i < ir.tb.length; i++) {
            var c = irGray(ir.tb[i]), o = i * 4;
            if (!c) { d[o] = 24; d[o + 1] = 30; d[o + 2] = 40; } else { d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; }
            d[o + 3] = 255;
        }
        cx.putImageData(im, 0, 0);
        return cv;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  drawing
    // ══════════════════════════════════════════════════════════════════════

    function windColor(v) {
        if (v == null || !isFinite(v)) return '#9ca3af';
        for (var k = 0; k < WIND_STOPS.length; k++) if (v < WIND_STOPS[k][0]) return WIND_STOPS[k][1];
        return WIND_STOPS[WIND_STOPS.length - 1][1];
    }
    function hhmm(tS) { return new Date(tS * 1000).toISOString().slice(11, 16); }
    function hhmmss(tS) { return new Date(tS * 1000).toISOString().slice(11, 19); }
    function legTag(L) { return 'P' + L.pen + ' ' + L.leg + ' ' + hhmm(L.t) + (L.done ? '' : ' so far'); }
    function boxHalfKm(f) {
        var mr = 0;
        f.legs.forEach(function (L) { mr = Math.max(mr, Math.hypot(L.x, L.y)); });
        return Math.max(47, Math.min(150, 1.3 * mr + 10));
    }
    function fontStack() {
        var s = '';
        try { s = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim(); } catch (e) {}
        return s || "'DM Sans', -apple-system, 'Segoe UI', Arial, sans-serif";
    }

    /** Draw the map square (W x W device px at ox, oy). view: {flight, c (ref
     *  center), halfKm, irCv, full (labels, grid), dpr, cssW}. */
    function drawMap(ctx, ox, oy, W, view) {
        var f = view.flight, H = view.halfKm, full = !!view.full;
        var k = Math.max(view.cssW / 1500, full ? 0 : 0.1);
        var dpr = view.dpr || 1, FS = fontStack();
        function X(x) { return ox + W / 2 + x / H * W / 2; }
        function Y(y) { return oy + W / 2 - y / H * W / 2; }
        ctx.save();
        ctx.beginPath(); ctx.rect(ox, oy, W, W); ctx.clip();
        ctx.fillStyle = '#18202c'; ctx.fillRect(ox, oy, W, W);
        if (view.irCv) {
            ctx.imageSmoothingEnabled = false;   // crisp: one block per IR pixel
            ctx.drawImage(view.irCv, ox, oy, W, W);
            ctx.imageSmoothingEnabled = true;
        }
        var c = view.c, kx = KMD * Math.cos(c.lat * Math.PI / 180);
        if (full) {   // graticule
            var step = H <= 60 ? 0.25 : (H <= 120 ? 0.5 : 1), lat0 = c.lat - H / KMD, lat1 = c.lat + H / KMD;
            var lon0 = c.lon - H / kx, lon1 = c.lon + H / kx;
            ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = Math.max(1, 0.9 * k * 1.6) * dpr;
            var gf = Math.max(10, 17 * k) * dpr;
            ctx.font = '600 ' + gf + 'px ' + FS; ctx.textBaseline = 'bottom';
            var glab = function (s, x, y, align) {
                ctx.textAlign = align;
                ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.strokeText(s, x, y);
                ctx.fillStyle = 'rgba(11,15,23,0.9)'; ctx.fillText(s, x, y);
                ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = Math.max(1, 0.9 * k * 1.6) * dpr;
            };
            for (var la = Math.ceil(lat0 / step) * step; la < lat1; la += step) {
                var yy = Y((la - c.lat) * KMD);
                ctx.beginPath(); ctx.moveTo(ox, yy); ctx.lineTo(ox + W, yy); ctx.stroke();
                glab(Math.abs(la).toFixed(2) + '°' + (la < 0 ? 'S' : 'N'), ox + 6 * dpr, yy - 2 * dpr, 'left');
            }
            for (var lo = Math.ceil(lon0 / step) * step; lo < lon1; lo += step) {
                var xx = X((lo - c.lon) * kx);
                ctx.beginPath(); ctx.moveTo(xx, oy); ctx.lineTo(xx, oy + W); ctx.stroke();
                glab(Math.abs(lo).toFixed(2) + '°' + (lo < 0 ? 'W' : 'E'), xx + 4 * dpr, oy + W - 6 * dpr, 'left');
            }
        }
        // track, storm-relative, colored by flight-level wind
        var tr = f.track, lw = (full ? Math.max(1.6, 2.7 * Math.max(k, 0.6)) : 1.3) * dpr;
        ctx.lineCap = 'round';
        for (var pass = 0; pass < 2; pass++) {
            for (var i = 0; i + 1 < tr.t.length; i++) {
                if (tr.t[i + 1] - tr.t[i] > 120 || Math.hypot(tr.x[i + 1] - tr.x[i], tr.y[i + 1] - tr.y[i]) > 15) continue;
                if (Math.max(Math.abs(tr.x[i]), Math.abs(tr.y[i])) > 1.6 * H && Math.max(Math.abs(tr.x[i + 1]), Math.abs(tr.y[i + 1])) > 1.6 * H) continue;
                ctx.beginPath(); ctx.moveTo(X(tr.x[i]), Y(tr.y[i])); ctx.lineTo(X(tr.x[i + 1]), Y(tr.y[i + 1]));
                if (pass === 0) { ctx.strokeStyle = 'rgba(5,8,15,0.5)'; ctx.lineWidth = lw * 2.07; }
                else {
                    var a = tr.fl[i], b = tr.fl[i + 1];
                    ctx.strokeStyle = windColor(a == null ? b : (b == null ? a : Math.max(a, b))); ctx.lineWidth = lw;
                }
                ctx.stroke();
            }
        }
        // center
        var cs = (full ? Math.max(9, 11 * Math.max(k, 0.6)) : 4.5) * dpr;
        ctx.lineCap = 'butt';
        [['rgba(5,8,15,0.7)', (full ? 5.5 : 3) * dpr], ['#ffffff', (full ? 3 : 1.5) * dpr]].forEach(function (s) {
            ctx.strokeStyle = s[0]; ctx.lineWidth = s[1] * (full ? Math.max(k, 0.6) : 1);
            ctx.beginPath(); ctx.moveTo(X(0) - cs, Y(0)); ctx.lineTo(X(0) + cs, Y(0));
            ctx.moveTo(X(0), Y(0) - cs); ctx.lineTo(X(0), Y(0) + cs); ctx.stroke();
        });
        // peaks: diameter 14 -> 30 px (still scale) over the flight's range
        var lo = Math.min(f.ktMin, f.ktMax - 20), hi = f.ktMax;
        function diam(kt) {
            var u = (Math.max(lo, Math.min(hi, kt)) - lo) / (hi - lo || 1);
            return full ? (14 + 16 * u) * Math.max(k, 0.55) * dpr : (5 + 4 * u) * dpr;
        }
        var pts = f.legs.map(function (L) { return { L: L, x: X(L.x), y: Y(L.y), d: diam(L.kt) }; });
        if (full) drawLabels(ctx, pts, ox, oy, W, k, dpr, FS);
        pts.slice().sort(function (a, b) { return a.L.kt - b.L.kt; }).forEach(function (p) {   // strongest on top
            ctx.beginPath(); ctx.arc(p.x, p.y, p.d / 2, 0, 2 * Math.PI);
            ctx.fillStyle = PINK; ctx.fill();
            ctx.lineWidth = (full ? 2.2 * Math.max(k, 0.55) : 1.1) * dpr; ctx.strokeStyle = '#ffffff';
            if (!p.L.done) ctx.setLineDash([3 * dpr, 2 * dpr]);
            ctx.stroke(); ctx.setLineDash([]);
        });
        if (full) {   // scale bar, bottom right
            var km = H <= 60 ? 20 : 50, sb = km / (2 * H) * W, sx = ox + W - 24 * dpr - sb, sy = oy + W - 26 * dpr;
            ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#0b0f17'; ctx.lineWidth = 1 * dpr;
            ctx.fillRect(sx, sy, sb, 5 * dpr); ctx.strokeRect(sx, sy, sb, 5 * dpr);
            ctx.font = '700 ' + Math.max(11, 17 * k) * dpr + 'px ' + FS; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
            ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.strokeText(km + ' km', sx + sb / 2, sy - 4 * dpr);
            ctx.fillStyle = '#0b0f17'; ctx.fillText(km + ' km', sx + sb / 2, sy - 4 * dpr);
        }
        ctx.restore();
    }

    /** Value + tag boxes placed radially out from each peak (farthest peaks
     *  first), clear of other boxes and peaks, with a leader line. */
    function drawLabels(ctx, pts, ox, oy, W, k, dpr, FS) {
        // Narrow maps (phones) get compact labels — value + "P1 in"; the table
        // under the map carries the times — so 14 boxes fit around a small eye.
        var compact = W / dpr < 560;
        var vf = (compact ? 11.5 : Math.max(13, 25 * k)) * dpr, tf = (compact ? 8.5 : Math.max(9.5, 13.5 * k)) * dpr;
        var pad = (compact ? 3 : Math.max(4, 9 * k)) * dpr;
        var m = compact ? 0.3 : Math.max(k, 0.42), placed = [];
        var cx0 = ox + W / 2, cy0 = oy + W / 2;
        var order = pts.map(function (p, i) { return i; })
            .sort(function (a, b) { return Math.hypot(pts[b].x - cx0, pts[b].y - cy0) - Math.hypot(pts[a].x - cx0, pts[a].y - cy0); });
        order.forEach(function (i) {
            var p = pts[i], val = String(Math.round(p.L.kt));
            var tag = compact ? 'P' + p.L.pen + ' ' + p.L.leg + (p.L.done ? '' : '\u2026') : legTag(p.L);
            ctx.font = '700 ' + vf + 'px ' + FS; var wv = ctx.measureText(val).width;
            ctx.font = '500 ' + tf + 'px ' + FS; var wt = ctx.measureText(tag).width;
            var bw = Math.max(wv, wt) + 2 * pad, bh = vf + tf + 2 * pad - 2 * dpr;
            var az = Math.atan2(p.L.x, p.L.y), sx = Math.sin(az), cy = -Math.cos(az);   // screen y grows down
            var box = null, bx0 = 0, by0 = 0, edge = 8 * dpr, gap = 16 * dpr * m;
            for (var dr = 30 * m * dpr; dr <= 330 * m * dpr; dr += 6 * m * dpr) {
                var ax = p.x + dr * sx, ay = p.y + dr * cy;
                bx0 = ax - bw / 2 + (bw / 2) * Math.max(-1, Math.min(1, sx / 0.5));
                by0 = ay - bh / 2 + (bh / 2) * Math.max(-1, Math.min(1, cy / 0.5));
                box = [bx0 - 5 * dpr, by0 - 5 * dpr, bx0 + bw + 5 * dpr, by0 + bh + 5 * dpr];
                if (box[0] < ox + edge || box[2] > ox + W - edge || box[1] < oy + edge || box[3] > oy + W - edge) { box = null; continue; }
                var hit = placed.some(function (b) { return !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]); }) ||
                          pts.some(function (q) { return box[0] - gap < q.x && q.x < box[2] + gap && box[1] - gap < q.y && q.y < box[3] + gap; });
                if (!hit) break;
            }
            if (!box) {   // nowhere clear inside the frame: nearest spot that fits
                bx0 = Math.max(ox + edge, Math.min(ox + W - edge - bw, p.x - bw / 2));
                by0 = Math.max(oy + edge, Math.min(oy + W - edge - bh, p.y + p.d));
                box = [bx0 - 5 * dpr, by0 - 5 * dpr, bx0 + bw + 5 * dpr, by0 + bh + 5 * dpr];
            }
            placed.push(box);
            // leader: peak edge -> nearest box edge
            var nx = Math.min(Math.max(p.x, bx0), bx0 + bw), ny = Math.min(Math.max(p.y, by0), by0 + bh);
            var r0 = p.d / 2 + 2 * dpr, Ld = Math.hypot(nx - p.x, ny - p.y);
            if (Ld > r0 + 2 * dpr) {
                var ux = (nx - p.x) / Ld, uy = (ny - p.y) / Ld;
                [['rgba(5,8,15,0.6)', 3.6], ['#ffffff', 1.6]].forEach(function (s) {
                    ctx.strokeStyle = s[0]; ctx.lineWidth = s[1] * Math.max(k, 0.55) * dpr;
                    ctx.beginPath(); ctx.moveTo(p.x + ux * r0, p.y + uy * r0); ctx.lineTo(nx, ny); ctx.stroke();
                });
            }
            roundRect(ctx, bx0, by0, bw, bh, 9 * m * dpr);
            ctx.fillStyle = 'rgba(8,13,23,0.92)'; ctx.fill();
            ctx.lineWidth = 2.2 * Math.max(k, 0.55) * dpr; ctx.strokeStyle = PINK;
            if (!p.L.done) ctx.setLineDash([4 * dpr, 3 * dpr]);
            ctx.stroke(); ctx.setLineDash([]);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top'; ctx.font = '700 ' + vf + 'px ' + FS; ctx.fillStyle = '#f1f5f9';
            ctx.fillText(val, bx0 + bw / 2, by0 + pad - 3 * dpr);
            ctx.textBaseline = 'bottom'; ctx.font = '500 ' + tf + 'px ' + FS; ctx.fillStyle = '#cbd5e1';
            ctx.fillText(tag, bx0 + bw / 2, by0 + bh - pad + 1 * dpr);
        });
    }
    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
    }

    // ══════════════════════════════════════════════════════════════════════
    //  UI: preview on the Live Flight map + full view
    // ══════════════════════════════════════════════════════════════════════

    var S = {
        ctx: null,            // last update() input
        model: null, flightKey: null, refIdx: null,
        textUrl: null, textKey: null, obs1s: null, textReq: null, textFailed: null,
        ir: {},               // "frameTs|lat|lon|half|N" -> Promise<ir|null>
        preview: null, modal: null, sig: ''
    };

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function tailName(t) { return (S.ctx && S.ctx.tailName) ? S.ctx.tailName(t) : t; }
    function utcSpan(a, b) {
        if (root.TCTime && TCTime.span) {
            var d = TCTime.span(a * 1000, b * 1000, { year: true });
            return d + ', ' + hhmm(a) + '–' + hhmm(b) + ' UTC';
        }
        return new Date(a * 1000).toISOString().slice(0, 10) + ' ' + hhmm(a) + '–' + hhmm(b) + ' UTC';
    }

    /** The flight to show: the Live Flight pick when it has penetrations, else
     *  the one with the latest eye. */
    function focusFlight() {
        var fl = (S.model && S.model.flights) || [];
        if (!fl.length) return null;
        if (S.flightKey) for (var i = 0; i < fl.length; i++) if (fl[i].key === S.flightKey) return fl[i];
        var sel = S.ctx && S.ctx.flightSel;
        if (sel) for (var j = 0; j < fl.length; j++) if (fl[j].key === sel) return fl[j];
        return fl[fl.length - 1];
    }
    /** Reference (IR) time: a live sortie's latest eye; a finished one's middle eye. */
    function refTime(f) {
        if (S.refIdx != null && S.refIdx < f.eyes.length) return f.eyes[S.refIdx];
        return f.live ? f.eyes[f.eyes.length - 1] : f.eyes[Math.floor((f.eyes.length - 1) / 2)];
    }
    function refIndex(f) {
        var t = refTime(f);
        return f.eyes.indexOf(t);
    }

    /** IR frame for a time: the recon-sat archive copy within 40 min, else the
     *  live mosaic frame within 40 min. Resolves {ir, frameT, center} or null. */
    function loadIR(f, tRef, halfKm, N) {
        var kit = S.ctx && S.ctx.kit;
        if (!kit || !kit.irFrame) return Promise.resolve(null);
        var rs = S.ctx.recsat, arch = null;
        if (rs && rs.frames && rs.frames.ir) {
            var best = null, bd = Infinity;
            Object.keys(rs.frames.ir).forEach(function (ts) {
                var ms = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12));
                var d = Math.abs(ms - tRef * 1000);
                if (d < bd) { bd = d; best = ts; }
            });
            if (best && bd <= 40 * 60000) arch = { root: rs.root, ts: best, zmax: rs.frames.ir[best].zmax || 6 };
        }
        var key = (arch ? 'a' + arch.ts : 'l' + Math.round(tRef / 600)) + '|' + halfKm.toFixed(1) + '|' + N + '|' + f.key;
        if (S.ir[key]) return S.ir[key];
        var p = kit.irFrame(new Date(tRef * 1000).toISOString(), arch).then(function (frame) {
            if (!frame) return null;
            var ts = frame.ts, frameT = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12)) / 1000;
            var c = centerAt(S.model.fixes, frameT);
            return sampleIR(frame, c, halfKm, N).then(function (ir) {
                return ir ? { ir: ir, cv: irCanvas(ir), frameT: frameT, c: c, archived: !!arch } : null;
            });
        }).catch(function () { return null; });
        S.ir[key] = p;
        p.then(function (r) { if (!r) delete S.ir[key]; });
        return p;
    }

    function ensureText(sear) {
        var url = sear && sear.text_url, gen = sear && sear.generated;
        if (!url) return Promise.resolve(null);
        var key = url + '|' + gen;
        if (S.textKey === key && S.obs1s) return Promise.resolve(S.obs1s);
        if (S.textKey === key && S.textReq) return S.textReq;
        if (S.textFailed === key) return Promise.resolve(null);
        S.textKey = key;
        S.textReq = fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 'g=' + encodeURIComponent(gen || ''), { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
            .then(function (txt) {
                if (S.textKey !== key) return null;
                S.obs1s = parseSearText(txt, sear); S.textReq = null;
                return S.obs1s;
            })
            .catch(function () { if (S.textKey === key) { S.textFailed = key; S.textReq = null; S.obs1s = null; } return null; });
        return S.textReq;
    }

    /** Called on every Live Flight render. ctx: {host (map container), stack
     *  (top-right column), data (recon blob, sear attached), recsat, kit,
     *  nowMs, flightSel, storm: {atcf, name}, tailName(fn), sortieKey(fn), visible} */
    function update(ctx) {
        S.ctx = ctx;
        var sear = ctx.data && ctx.data.sear;
        if (!ctx.visible || !sear || !sear.aircraft || !Object.keys(sear.aircraft).length) { hidePreview(); return; }
        var stormKey = (ctx.storm && ctx.storm.atcf) + '|' + (sear.text_url || '');
        if (S.stormKey !== stormKey) {
            S.stormKey = stormKey; S.flightKey = null; S.refIdx = null; S.ir = {};
            S.obs1s = null; S.textKey = null; S.textReq = null; S.textFailed = null;
        }
        var go = function (obs1s) {
            if (S.ctx !== ctx) return;
            S.model = buildModel({ aircraft: ctx.data.aircraft, vdms: ctx.data.vdms, sear: sear, obs1s: obs1s,
                                   nowMs: ctx.nowMs, sortieKey: ctx.sortieKey });
            var f = focusFlight();
            var msig = S.model.flights.map(function (g) {
                return g.key + ':' + g.legs.map(function (L) { return L.pen + L.leg + L.kt + (L.done ? 'd' : 'p'); }).join(',');
            }).join(';') + '|' + (f ? f.key + refTime(f) : '') + '|' + (ctx.recsat ? ctx.recsat.generated : '');
            var changed = msig !== S.msig;
            S.msig = msig;
            if (changed && S.modal && S.modal.open) renderModal();
            // The map preview is for the flight at hand: airborne, picked, or with an
            // eye in the last 12 h — not yesterday's flight before today's first eye.
            var picked = f && (f.key === S.flightKey || f.key === ctx.flightSel);
            if (!f || !(f.live || picked || (ctx.nowMs || Date.now()) / 1000 - f.lastEye <= PREVIEW_KEEP_S)) { hidePreview(); return; }
            showPreview(f);
        };
        if (!sear.text_url) { go(null); return; }
        if (S.textKey === sear.text_url + '|' + sear.generated && S.obs1s) { go(S.obs1s); return; }
        // Wait for the 1-s text before showing values (a 10-s first draw would
        // show leg peaks that then change); fall back to 10 s only if it fails.
        var probe = buildModel({ aircraft: ctx.data.aircraft, vdms: ctx.data.vdms, sear: sear, obs1s: null,
                                 nowMs: ctx.nowMs, sortieKey: ctx.sortieKey });
        if (!probe.flights.length && !S.obs1s) { hidePreview(); return; }   // no eye penetrations: nothing to fetch
        ensureText(sear).then(go);
    }

    function hidePreview() {
        if (S.preview) S.preview.btn.style.display = 'none';
        S.sig = '';
    }

    function showPreview(f) {
        var ctx = S.ctx;
        if (!S.preview || !S.preview.btn.isConnected) {
            var btn = document.createElement('button');
            btn.type = 'button'; btn.className = 'recon-eye-preview';
            btn.setAttribute('data-html2canvas-ignore', 'true');
            btn.innerHTML = '<canvas aria-hidden="true"></canvas><span class="recon-eye-pv-cap"></span>';
            ['mousedown', 'dblclick', 'wheel', 'touchstart', 'pointerdown'].forEach(function (ev) {
                btn.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true });
            });
            btn.addEventListener('click', function (e) { e.stopPropagation(); openModal(); });
            (ctx.stack || ctx.host).insertBefore(btn, (ctx.stack || ctx.host).firstChild);
            S.preview = { btn: btn, cv: btn.querySelector('canvas'), cap: btn.querySelector('.recon-eye-pv-cap') };
        }
        var P = S.preview;
        P.btn.style.display = '';
        var nIn = f.legs.length, nPen = f.eyes.length;
        P.cap.innerHTML = '<b>Eyewall peaks</b> <span class="recon-eye-exp">exp</span><br>' +
            esc(tailName(f.tail)) + ' · ' + nPen + ' eye' + (nPen === 1 ? '' : 's') + ' · max ' + Math.round(f.ktMax) + ' kt';
        P.btn.setAttribute('aria-label', 'SEAR eyewall peaks, experimental: ' + tailName(f.tail) + ', ' + nPen +
            ' eye penetrations, ' + nIn + ' eyewall crossings, ' + Math.round(f.ktMin) + ' to ' + Math.round(f.ktMax) + ' kt. Open the full view.');
        P.btn.title = 'SEAR 10-m peak on each eyewall crossing (experimental). Click for the full view.';
        var sig = S.msig + '|' + f.key + '|' + refTime(f);
        if (sig === S.sig) return;
        S.sig = sig;
        drawPreview(f);
    }

    function drawPreview(f) {
        var P = S.preview, cssW = P.cv.clientWidth || 160, dpr = Math.min(2, root.devicePixelRatio || 1);
        var W = Math.round(cssW * dpr);
        P.cv.width = W; P.cv.height = W;
        var half = boxHalfKm(f), tRef = refTime(f), myF = f.key, sig = S.sig;
        var paint = function (irr) {
            if (S.sig !== sig) return;
            var c = irr ? irr.c : centerAt(S.model.fixes, tRef);
            drawMap(P.cv.getContext('2d'), 0, 0, W, { flight: f, c: c, halfKm: half, irCv: irr && irr.cv, full: false, dpr: dpr, cssW: cssW });
        };
        paint(null);
        loadIR(f, tRef, half, 160).then(function (irr) { if (irr && myF === f.key) paint(irr); });
    }

    // ── full view ──
    function openModal() {
        if (!S.modal) buildModal();
        S.modal.open = true;
        S.modal.el.hidden = false;
        document.documentElement.classList.add('recon-eye-noscroll');
        S.modal.lastFocus = document.activeElement;
        renderModal();
        try { S.modal.el.querySelector('.recon-eye-close').focus(); } catch (e) {}
        if (S.ctx && S.ctx.track) S.ctx.track('recon_eye_open', { id: S.ctx.storm && S.ctx.storm.atcf });
    }
    function closeModal() {
        if (!S.modal) return;
        S.modal.open = false; S.modal.el.hidden = true;
        document.documentElement.classList.remove('recon-eye-noscroll');
        try { if (S.modal.lastFocus) S.modal.lastFocus.focus(); } catch (e) {}
    }
    var ICON_X = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    var ICON_DL = '<svg class="icon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';

    function buildModal() {
        var el = document.createElement('div');
        el.className = 'recon-eye-modal'; el.hidden = true;
        el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'recon-eye-title');
        el.innerHTML =
            '<div class="recon-eye-panel">' +
              '<div class="recon-eye-head">' +
                '<div class="recon-eye-hd"><h2 id="recon-eye-title" class="recon-eye-title"></h2>' +
                '<div class="recon-eye-status"></div></div>' +
                '<button type="button" class="recon-eye-close" aria-label="Close">' + ICON_X + '</button>' +
              '</div>' +
              '<div class="recon-eye-body">' +
                '<div class="recon-eye-mapwrap"><canvas class="recon-eye-canvas" role="img"></canvas>' +
                  '<div class="recon-eye-irnote" aria-live="polite"></div></div>' +
                '<div class="recon-eye-side">' +
                  '<div class="recon-eye-flights" role="group" aria-label="Flight"></div>' +
                  '<div class="recon-eye-ctrls">' +
                    '<span class="recon-eye-irstep"><button type="button" data-step="-1" aria-label="Earlier eye">◀︎</button>' +
                    '<span class="recon-eye-irtime"></span>' +
                    '<button type="button" data-step="1" aria-label="Later eye">▶︎</button></span>' +
                    '<button type="button" class="recon-eye-save">' + ICON_DL + ' Save PNG</button>' +
                  '</div>' +
                  '<div class="recon-eye-legend"></div>' +
                  '<table class="recon-eye-table"><caption>SEAR 10-m peak on each leg (kt, UTC)</caption>' +
                    '<thead><tr><th scope="col">Eye</th><th scope="col">Inbound</th><th scope="col">Outbound</th></tr></thead><tbody></tbody></table>' +
                  '<p class="recon-eye-note"></p>' +
                '</div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(el);
        el.addEventListener('click', function (e) { if (e.target === el) closeModal(); });
        el.querySelector('.recon-eye-close').addEventListener('click', closeModal);
        el.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
            if (e.key === 'Tab') {   // keep focus inside the dialog
                var fo = Array.prototype.filter.call(el.querySelectorAll('button:not([disabled])'), function (b) { return b.offsetParent; });
                if (!fo.length) return;
                if (e.shiftKey && document.activeElement === fo[0]) { e.preventDefault(); fo[fo.length - 1].focus(); }
                else if (!e.shiftKey && document.activeElement === fo[fo.length - 1]) { e.preventDefault(); fo[0].focus(); }
            }
        });
        el.querySelectorAll('.recon-eye-irstep button').forEach(function (b) {
            b.addEventListener('click', function () {
                var f = focusFlight(); if (!f) return;
                var i = refIndex(f) + (+b.getAttribute('data-step'));
                if (i < 0 || i >= f.eyes.length) return;
                S.refIdx = i; renderModal();
                if (S.preview) showPreview(f);
            });
        });
        el.querySelector('.recon-eye-save').addEventListener('click', savePng);
        var ro = (typeof ResizeObserver === 'function') ? new ResizeObserver(function () { if (S.modal && S.modal.open) drawModalMap(); }) : null;
        if (ro) ro.observe(el.querySelector('.recon-eye-mapwrap'));
        S.modal = { el: el, open: false };
    }

    function statusLine(f) {
        var nCross = f.legs.filter(function (L) { return L.done; }).length;
        return tailName(f.tail) + ' · ' + utcSpan(f.legs[0].t, f.legs[f.legs.length - 1].t) + ' · ' +
            f.eyes.length + ' eye penetration' + (f.eyes.length === 1 ? '' : 's') + ', ' +
            nCross + ' crossing' + (nCross === 1 ? '' : 's') + (f.live ? ' so far' : '') + ' · ' +
            Math.round(f.ktMin) + (f.ktMax !== f.ktMin ? '–' + Math.round(f.ktMax) : '') + ' kt';
    }
    function titleText() {
        var nm = S.ctx && S.ctx.storm && S.ctx.storm.name;
        nm = nm ? String(nm).charAt(0).toUpperCase() + String(nm).slice(1).toLowerCase() : '';
        return (nm ? nm + ' — ' : '') + 'SEAR 10-m peak on each eyewall crossing';
    }

    function renderModal() {
        var M = S.modal, el = M.el, f = focusFlight();
        el.querySelector('.recon-eye-title').innerHTML = esc(titleText()) + ' <span class="recon-eye-exp">experimental</span>';
        if (!f) {
            el.querySelector('.recon-eye-status').textContent = 'No eye penetrations in the flights loaded.';
            el.querySelector('tbody').innerHTML = '';
            var cv0 = el.querySelector('.recon-eye-canvas'); cv0.width = cv0.width;   // clear
            return;
        }
        el.querySelector('.recon-eye-status').textContent = statusLine(f);
        // flights with penetrations (several aircraft / sorties)
        var fl = S.model.flights, fb = el.querySelector('.recon-eye-flights');
        if (fl.length > 1) {
            fb.hidden = false;
            fb.innerHTML = fl.map(function (g) {
                var on = g.key === f.key;
                return '<button type="button" class="recon-eye-chip' + (on ? ' on' : '') + '" aria-pressed="' + on + '" data-key="' + esc(g.key) + '">' +
                    esc(tailName(g.tail)) + ' <span>' + esc(TCTimeShort(g.eyes[0])) + '</span></button>';
            }).join('');
            fb.querySelectorAll('button').forEach(function (b) {
                b.onclick = function () {
                    S.flightKey = b.getAttribute('data-key'); S.refIdx = null; renderModal();
                    var g = focusFlight(); if (g && S.preview) showPreview(g);
                };
            });
        } else { fb.hidden = true; fb.innerHTML = ''; }
        // IR time stepper (eye times)
        var ri = refIndex(f);
        el.querySelector('.recon-eye-irtime').textContent = 'IR at P' + (ri + 1) + ' eye';
        el.querySelector('[data-step="-1"]').disabled = ri <= 0;
        el.querySelector('[data-step="1"]').disabled = ri >= f.eyes.length - 1;
        // legend
        var narrow = (el.querySelector('.recon-eye-mapwrap').clientWidth || 600) < 560;
        el.querySelector('.recon-eye-legend').innerHTML =
            '<div class="recon-eye-lrow"><span class="recon-eye-dot"></span><span>SEAR 10-m peak on the leg (kt); size scales with wind; ' +
            (narrow ? 'tag = eye penetration and leg (times in the table)' : 'tag = eye penetration, leg, UTC') +
            (f.legs.some(function (L) { return !L.done; }) ? '; dashed = leg still being flown' : '') + '</span></div>' +
            '<div class="recon-eye-lrow"><span class="recon-eye-lab">Track: flight-level wind (kt)</span>' +
            '<span class="recon-eye-bar">' + WIND_STOPS.map(function (s, i) {
                return '<span style="background:' + s[1] + '"><i>' + WIND_LABELS[i] + '</i></span>';
            }).join('') + '</span></div>' +
            '<div class="recon-eye-lrow"><span class="recon-eye-lab">IR (\u00b0C)</span><span class="recon-eye-irwrap">' +
            '<span class="recon-eye-irbar" style="background:linear-gradient(to right,' + irStops() + ')"></span>' +
            '<span class="recon-eye-irlab"><i>-80</i><i>-60</i><i>-40</i><i>-20</i><i>0</i><i>20</i></span></span></div>';
        // table
        var rows = {};
        f.legs.forEach(function (L) { (rows[L.pen] = rows[L.pen] || {})[L.leg] = L; });
        el.querySelector('tbody').innerHTML = Object.keys(rows).map(function (p) {
            var cell = function (L) {
                return L ? '<b>' + Math.round(L.kt) + '</b> <span>' + hhmmss(L.t) + (L.done ? '' : ' (so far)') + '</span>' : '<span>—</span>';
            };
            return '<tr><th scope="row">P' + p + '</th><td>' + cell(rows[p]['in']) + '</td><td>' + cell(rows[p].out) + '</td></tr>';
        }).join('');
        el.querySelector('.recon-eye-note').textContent =
            'Each peak is the highest SEAR 10-m estimate on that leg within 60 km of the center, placed where it occurred relative to ' +
            'the moving center (VDM and SEAR fixes); the track is placed the same way. ' +
            (f.src === '10s' ? 'Values from the 10-s published series (the 1-s product was unavailable), so a peak between samples can read low. ' : '') +
            'SEAR is an experimental research estimate, not an official product.';
        drawModalMap();
    }

    function irStops() {   // CSS gradient of the IR stretch over -80..20 C
        var out = [];
        for (var c = -80; c <= 20; c += 5) {
            var g = irGray(c + 273.15);
            out.push('rgb(' + g.join(',') + ') ' + ((c + 80) / 100 * 100).toFixed(0) + '%');
        }
        return out.join(',');
    }

    function TCTimeShort(tS) {
        return (root.TCTime && TCTime.utc) ? TCTime.utc(tS * 1000) : new Date(tS * 1000).toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
    }

    function drawModalMap() {
        var M = S.modal, f = focusFlight();
        if (!M || !M.open || !f) return;
        var wrap = M.el.querySelector('.recon-eye-mapwrap'), cv = M.el.querySelector('.recon-eye-canvas');
        // side-by-side layout: the square also has to fit the window's height
        var maxH = (root.innerWidth > 860) ? Math.max(320, root.innerHeight - 180) : Infinity;
        var cssW = Math.max(200, Math.floor(Math.min(wrap.clientWidth || 600, maxH)));
        var dpr = Math.min(2, root.devicePixelRatio || 1), W = Math.round(cssW * dpr);
        cv.style.width = cssW + 'px'; cv.style.height = cssW + 'px';
        cv.width = W; cv.height = W;
        var half = boxHalfKm(f), tRef = refTime(f), note = M.el.querySelector('.recon-eye-irnote');
        cv.setAttribute('aria-label', 'Storm-relative map of ' + statusLine(f) + '. The table lists each value.');
        var token = {}; M.drawToken = token;
        var paint = function (irr) {
            if (M.drawToken !== token) return;
            var c = irr ? irr.c : centerAt(S.model.fixes, tRef);
            drawMap(cv.getContext('2d'), 0, 0, W, { flight: f, c: c, halfKm: half, irCv: irr && irr.cv, full: true, dpr: dpr, cssW: cssW });
            M.lastIR = irr;
            if (irr) {
                note.textContent = 'North up. Drawn around the ' + hhmm(irr.frameT) + ' UTC center over ' + irr.ir.sat +
                    ' IR at that time' + (irr.archived ? '' : ' (live mosaic)') + ', parallax-corrected for 12-km cloud tops.';
            } else {
                note.textContent = 'North up. Drawn around the ' + hhmm(tRef) + ' UTC center' + (M.irPending ? '; loading IR…' : '; no IR frame retained for that time.');
            }
        };
        M.irPending = true; paint(null);
        loadIR(f, tRef, half, 420).then(function (irr) { M.irPending = false; paint(irr); });
    }

    // ── Save PNG: title + one status line, the map, a one-line key ──
    function cssVar(n, d) { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d; } catch (e) { return d; } }
    function savePng() {
        var f = focusFlight(), M = S.modal;
        if (!f || !M) return;
        var Wp = 1600, MS = 1500, MX = 50, MY = 150, FS = fontStack();
        var cv = document.createElement('canvas'); cv.width = Wp; cv.height = MY + MS + 150;
        var cx = cv.getContext('2d');
        var bg = cssVar('--plot-paper', '#ffffff'), ink = cssVar('--plot-text', '#0f1623'), sub = cssVar('--plot-axis', '#5b6573');
        cx.fillStyle = bg; cx.fillRect(0, 0, cv.width, cv.height);
        cx.fillStyle = ink; cx.textBaseline = 'middle'; cx.textAlign = 'left';
        cx.font = '700 38px ' + FS; cx.fillText(titleText(), MX, 58);
        cx.font = '500 20px ' + FS; cx.fillStyle = sub;
        cx.fillText(statusLine(f) + ' · experimental, not an official product', MX, 104);
        var irr = M.lastIR, tRef = refTime(f), half = boxHalfKm(f);
        var go = function (ir2) {
            var c = ir2 ? ir2.c : centerAt(S.model.fixes, tRef);
            drawMap(cx, MX, MY, MS, { flight: f, c: c, halfKm: half, irCv: ir2 && ir2.cv, full: true, dpr: 1, cssW: MS });
            var ly = MY + MS + 40;
            cx.beginPath(); cx.arc(MX + 11, ly, 10, 0, 2 * Math.PI); cx.fillStyle = PINK; cx.fill();
            cx.lineWidth = 2; cx.strokeStyle = '#ffffff'; cx.stroke();
            cx.fillStyle = sub; cx.font = '500 17px ' + FS; cx.textBaseline = 'middle';
            cx.fillText('SEAR 10-m peak on the leg (kt) · track: flight-level wind', MX + 30, ly);
            var bx = MX + 560;
            WIND_STOPS.forEach(function (s, i) {
                cx.fillStyle = s[1]; cx.fillRect(bx + i * 46, ly - 7, 43, 14);
                cx.fillStyle = sub; cx.font = '500 13px ' + FS; cx.textAlign = 'center';
                cx.fillText(WIND_LABELS[i], bx + i * 46 + 21, ly + 20);
            });
            cx.textAlign = 'left'; cx.font = '400 15px ' + FS; cx.fillStyle = sub;
            cx.fillText('Storm-relative, north up, around the ' + hhmm(ir2 ? ir2.frameT : tRef) + ' UTC center' +
                (ir2 ? ' over ' + ir2.ir.sat + ' IR (parallax-corrected)' : '') + '. Placement: offset from the moving center.', MX, ly + 62);
            var kit = S.ctx && S.ctx.kit;
            var done = function () {
                try { if (kit && kit.watermark) kit.watermark(cx, cv.width, cv.height); } catch (e) {}
                var nm = (S.ctx.storm && (S.ctx.storm.name || S.ctx.storm.atcf)) || 'storm';
                var fn = 'TC-ATLAS_SEAR_eyewall_' + String(nm).replace(/[^A-Za-z0-9]+/g, '') + '_' + f.tail + '_' +
                    new Date(f.legs[0].t * 1000).toISOString().slice(0, 10).replace(/-/g, '') + '.png';
                if (root.TCExport) TCExport.save(cv, fn);
            };
            if (kit && kit.watermarkReady) kit.watermarkReady().then(done); else done();
        };
        // full-resolution IR for the 1500-px map (cached once loaded)
        loadIR(f, tRef, half, 700).then(function (ir2) { go(ir2 || irr); });
    }

    var api = {
        update: update, hide: hidePreview, open: openModal, close: closeModal,
        // pure pieces (tests)
        _rollingMedian: rollingMedian, _findEyes: findEyes, _eyewallLegs: eyewallLegs, _centerAt: centerAt,
        _parseSearText: parseSearText, _buildModel: buildModel, _parallaxForward: parallaxForward,
        _state: function () { return S; }
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ReconEye = api;
})(typeof window !== 'undefined' ? window : this);
