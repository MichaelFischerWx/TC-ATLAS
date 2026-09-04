/* tc_dm_analytics.js — pure, DOM-free analytics over DeepMind WeatherLab
 * ensemble payloads (the shapes served by /ir-monitor/storm/{id}/weatherlab
 * and /weatherlab-ensemble). Everything here runs client-side on data the
 * page already fetched, so it adds no backend cost.
 *
 *   members  = { "<sample>": { points: [ { tau, lat, lon, wind, pres,
 *                 rmw_km, r34_ne_km, r34_se_km, r34_sw_km, r34_nw_km,
 *                 r50_*_km, r64_*_km, r34_mean_km, ... } ] } }
 *
 * Exposed as window.TCDM (browser) and module.exports (node, for tests).
 *
 * Products:
 *   windProbGrid       — P(≥34/50/64 kt) on a lat/lon grid within a horizon
 *   pointProbabilities — P(≥34/50/64) + TS-wind arrival-time samples at a point
 *   trackEllipses      — 50 % / 90 % bivariate-normal track ellipses per lead
 *   survival           — fraction of members still carrying the system per lead
 *   riProbability      — P(ΔV24 ≥ 30 kt) per lead, and cumulative "by lead"
 *   landfall           — per-member first landfall (needs a land-mask sampler)
 *   compareModels      — FNV3 vs WN3 mean separation / intensity / spread by lead
 *   vsForecast         — DeepMind ensemble vs an official/consensus track by lead
 *   loadLandMask       — 0.1° global land mask PNG → isLand(lat, lon)
 *   rasterizeMercator  — grid → Web-Mercator-warped PNG data URL(s) for L.imageOverlay
 *
 * These are experimental research diagnostics. Nothing here is an official
 * forecast; UI that shows them must point users to NHC / JTWC / their
 * national meteorological service for official guidance.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.TCDM = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var R_EARTH = 6371.0;
    var D2R = Math.PI / 180;

    // ── geometry ───────────────────────────────────────────────────────────
    function haversineKm(lat1, lon1, lat2, lon2) {
        var dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
              + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R)
              * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
    }
    // Initial bearing from (lat1,lon1) to (lat2,lon2), degrees clockwise from N.
    function bearingDeg(lat1, lon1, lat2, lon2) {
        var φ1 = lat1 * D2R, φ2 = lat2 * D2R, dλ = (lon2 - lon1) * D2R;
        var y = Math.sin(dλ) * Math.cos(φ2);
        var x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
        var b = Math.atan2(y, x) / D2R;
        return (b + 360) % 360;
    }
    function quadrantOf(bearing) {
        if (bearing < 90) return 'ne';
        if (bearing < 180) return 'se';
        if (bearing < 270) return 'sw';
        return 'nw';
    }
    // Unwrap a longitude so it is within 180° of `ref`.
    function unwrapLon(lon, ref) {
        while (lon - ref > 180) lon -= 360;
        while (lon - ref < -180) lon += 360;
        return lon;
    }
    function wrapLon(lon) {
        while (lon > 180) lon -= 360;
        while (lon < -180) lon += 360;
        return lon;
    }

    // "YYYYMMDDHH" → ms since epoch (UTC). null when unparsable.
    function initToMs(init) {
        var s = String(init || '');
        if (s.length < 10) return null;
        var ms = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10));
        return isNaN(ms) ? null : ms;
    }
    // Hours from init A to init B (positive when B is later).
    function initOffsetH(initA, initB) {
        var a = initToMs(initA), b = initToMs(initB);
        return (a == null || b == null) ? 0 : Math.round((b - a) / 3600000);
    }

    // ── member access ──────────────────────────────────────────────────────
    function memberKeys(members) { return Object.keys(members || {}); }

    // Sorted, unwrapped, tau-filtered point list for one member. Longitudes are
    // unwrapped relative to the first point so interpolation never jumps 360°.
    function memberTrack(m, maxTau) {
        var pts = (m && m.points || []).filter(function (p) {
            return p && p.lat != null && p.lon != null && p.tau != null
                && (maxTau == null || p.tau <= maxTau);
        }).slice().sort(function (a, b) { return a.tau - b.tau; });
        if (!pts.length) return pts;
        var ref = pts[0].lon, out = [];
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            var q = {}; for (var k in p) q[k] = p[k];
            q.lon = unwrapLon(p.lon, ref); ref = q.lon;
            out.push(q);
        }
        return out;
    }
    var QUADS = ['ne', 'se', 'sw', 'nw'];
    function radiiAt(p, thresh) {
        var out = {}, any = false;
        for (var i = 0; i < 4; i++) {
            var v = p['r' + thresh + '_' + QUADS[i] + '_km'];
            v = (v == null || !(v > 0)) ? 0 : +v;
            out[QUADS[i]] = v; if (v > 0) any = true;
        }
        out.any = any;
        return out;
    }
    function lerp(a, b, f) { return a + (b - a) * f; }
    // Linear interpolation of position + radii between two points.
    function interpPoint(a, b, f, thresh) {
        var ra = radiiAt(a, thresh), rb = radiiAt(b, thresh);
        var r = { any: ra.any || rb.any };
        for (var i = 0; i < 4; i++) r[QUADS[i]] = lerp(ra[QUADS[i]], rb[QUADS[i]], f);
        return {
            tau: lerp(a.tau, b.tau, f),
            lat: lerp(a.lat, b.lat, f),
            lon: lerp(a.lon, b.lon, f),
            wind: (a.wind != null && b.wind != null) ? lerp(a.wind, b.wind, f)
                  : (a.wind != null ? a.wind : b.wind),
            r: r,
        };
    }
    // Walk a member track at `stepH` resolution, calling fn(sample) per step.
    function walkTrack(track, stepH, thresh, fn) {
        if (!track.length) return;
        if (track.length === 1) { fn(interpPoint(track[0], track[0], 0, thresh)); return; }
        for (var i = 0; i < track.length - 1; i++) {
            var a = track[i], b = track[i + 1];
            var span = b.tau - a.tau; if (!(span > 0)) continue;
            var n = Math.max(1, Math.round(span / stepH));
            for (var s = 0; s < n; s++) {
                if (fn(interpPoint(a, b, s / n, thresh)) === false) return;
            }
        }
        if (fn(interpPoint(track[track.length - 1], track[track.length - 1], 0, thresh)) === false) return;
    }
    // Is (lat, lon) inside the wind footprint of a sample (quadrant radii)?
    function inFootprint(sample, lat, lon) {
        var r = sample.r; if (!r.any) return false;
        var rmax = Math.max(r.ne, r.se, r.sw, r.nw);
        // Cheap reject: lat gap alone exceeds the largest radius.
        if (Math.abs(lat - sample.lat) * 111.2 > rmax) return false;
        var d = haversineKm(sample.lat, sample.lon, lat, lon);
        if (d > rmax) return false;
        var q = quadrantOf(bearingDeg(sample.lat, sample.lon, lat, lon));
        return d <= r[q];
    }

    // ── 1. wind-speed probability grid ────────────────────────────────────
    // opts: { thresh: 34|50|64, maxTau: 120, cellDeg: 0.2, stepH: 2, padDeg: 1 }
    // Returns { lat0 (north edge), lon0 (west edge, unwrapped), dLat, dLon, nx, ny,
    //           prob: Float32Array (row 0 = north), n, thresh, maxTau, lonRef }
    function windProbGrid(members, opts) {
        opts = opts || {};
        var thresh = opts.thresh || 34, maxTau = opts.maxTau != null ? opts.maxTau : 120;
        var cell = opts.cellDeg || 0.2, stepH = opts.stepH || 2, pad = opts.padDeg != null ? opts.padDeg : 1;
        var keys = memberKeys(members);
        var tracks = [], lonRef = null;
        var minLat = 90, maxLat = -90, minLon = 1e9, maxLon = -1e9, maxR = 0;
        for (var i = 0; i < keys.length; i++) {
            var t = memberTrack(members[keys[i]], maxTau);
            if (!t.length) { tracks.push(null); continue; }
            if (lonRef == null) lonRef = t[0].lon;
            // Re-anchor every member to the same reference so grids agree.
            var shift = unwrapLon(t[0].lon, lonRef) - t[0].lon;
            if (shift) for (var j = 0; j < t.length; j++) t[j].lon += shift;
            tracks.push(t);
            for (var k = 0; k < t.length; k++) {
                var p = t[k];
                var r = radiiAt(p, thresh);
                if (!r.any) continue;
                var rm = Math.max(r.ne, r.se, r.sw, r.nw); if (rm > maxR) maxR = rm;
                if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
                if (p.lon < minLon) minLon = p.lon; if (p.lon > maxLon) maxLon = p.lon;
            }
        }
        if (minLat > maxLat) return null;   // no member ever reaches the threshold
        var rDeg = maxR / 111.2 + pad;
        var cosMid = Math.max(0.2, Math.cos((minLat + maxLat) / 2 * D2R));
        var south = Math.max(-85, Math.floor((minLat - rDeg) / cell) * cell);
        var north = Math.min(85, Math.ceil((maxLat + rDeg) / cell) * cell);
        var west = Math.floor((minLon - rDeg / cosMid) / cell) * cell;
        var east = Math.ceil((maxLon + rDeg / cosMid) / cell) * cell;
        var nx = Math.max(1, Math.round((east - west) / cell));
        var ny = Math.max(1, Math.round((north - south) / cell));
        if (nx * ny > 4e6) return null;   // pathological; caller can coarsen
        var counts = new Uint16Array(nx * ny);
        var hit = new Uint8Array(nx * ny);
        var n = 0;
        for (var mi = 0; mi < tracks.length; mi++) {
            var tr = tracks[mi]; if (!tr) continue;
            n++;
            hit.fill(0);
            walkTrack(tr, stepH, thresh, function (s) {
                var r = s.r; if (!r.any) return;
                var rmax = Math.max(r.ne, r.se, r.sw, r.nw);
                var dLatDeg = rmax / 111.2;
                var dLonDeg = rmax / (111.2 * Math.max(0.2, Math.cos(s.lat * D2R)));
                var r0 = Math.max(0, Math.floor((north - (s.lat + dLatDeg)) / cell));
                var r1 = Math.min(ny - 1, Math.ceil((north - (s.lat - dLatDeg)) / cell));
                var c0 = Math.max(0, Math.floor((s.lon - dLonDeg - west) / cell));
                var c1 = Math.min(nx - 1, Math.ceil((s.lon + dLonDeg - west) / cell));
                for (var rr = r0; rr <= r1; rr++) {
                    var clat = north - (rr + 0.5) * cell;
                    for (var cc = c0; cc <= c1; cc++) {
                        var idx = rr * nx + cc;
                        if (hit[idx]) continue;
                        var clon = west + (cc + 0.5) * cell;
                        if (inFootprint(s, clat, clon)) hit[idx] = 1;
                    }
                }
            });
            for (var q = 0; q < hit.length; q++) if (hit[q]) counts[q]++;
        }
        var prob = new Float32Array(nx * ny);
        var maxP = 0;
        for (var z = 0; z < prob.length; z++) { prob[z] = n ? counts[z] / n : 0; if (prob[z] > maxP) maxP = prob[z]; }
        return { lat0: north, lon0: west, dLat: cell, dLon: cell, nx: nx, ny: ny,
                 prob: prob, n: n, thresh: thresh, maxTau: maxTau, maxProb: maxP, lonRef: lonRef };
    }
    // Sample a grid at (lat, lon) → probability (0..1) or null when outside.
    function gridSample(g, lat, lon) {
        if (!g) return null;
        var ul = unwrapLon(lon, g.lon0 + g.nx * g.dLon / 2);
        var c = Math.floor((ul - g.lon0) / g.dLon), r = Math.floor((g.lat0 - lat) / g.dLat);
        if (c < 0 || c >= g.nx || r < 0 || r >= g.ny) return null;
        return g.prob[r * g.nx + c];
    }

    // ── 2. point probabilities + arrival times ────────────────────────────
    // Returns { n, p34, p50, p64, arrival34: [tau,...], arrival50, arrival64,
    //           nearest: { tau, km } (closest approach of the ensemble mean, if given) }
    function pointProbabilities(members, lat, lon, opts) {
        opts = opts || {};
        var maxTau = opts.maxTau != null ? opts.maxTau : 168, stepH = opts.stepH || 1;
        var keys = memberKeys(members);
        var out = { n: 0, p34: 0, p50: 0, p64: 0, arrival34: [], arrival50: [], arrival64: [], maxTau: maxTau };
        var threshes = [34, 50, 64];
        for (var i = 0; i < keys.length; i++) {
            var tr = memberTrack(members[keys[i]], maxTau);
            if (!tr.length) continue;
            out.n++;
            var ref = tr[0].lon, plon = unwrapLon(lon, ref);
            for (var ti = 0; ti < 3; ti++) {
                var th = threshes[ti], first = null;
                walkTrack(tr, stepH, th, function (s) {
                    if (inFootprint(s, lat, plon)) { first = s.tau; return false; }
                });
                if (first != null) {
                    out['p' + th]++;
                    out['arrival' + th].push(Math.round(first));
                }
            }
        }
        if (out.n) { out.p34 /= out.n; out.p50 /= out.n; out.p64 /= out.n; }
        if (opts.mean && opts.mean.points) {
            var best = null;
            var mp = opts.mean.points;
            for (var k = 0; k < mp.length; k++) {
                if (mp[k].lat == null || mp[k].tau > maxTau) continue;
                var d = haversineKm(mp[k].lat, mp[k].lon, lat, lon);
                if (!best || d < best.km) best = { tau: mp[k].tau, km: d };
            }
            out.nearest = best;
        }
        return out;
    }

    // ── 3. track ellipses ─────────────────────────────────────────────────
    // Bivariate-normal ellipses of member positions at each lead. Returns
    // [{ tau, n, lat, lon, poly50: [[lat,lon]...], poly90, sigmaKm: [major, minor] }]
    function trackEllipses(members, taus, opts) {
        opts = opts || {};
        var minN = opts.minN || 5, nPts = opts.nPts || 48;
        var keys = memberKeys(members);
        var byTau = {};
        var lonRef = null;
        for (var i = 0; i < keys.length; i++) {
            var pts = members[keys[i]].points || [];
            for (var j = 0; j < pts.length; j++) {
                var p = pts[j];
                if (p.lat == null || p.lon == null) continue;
                if (lonRef == null) lonRef = p.lon;
                (byTau[p.tau] = byTau[p.tau] || []).push([p.lat, unwrapLon(p.lon, lonRef)]);
            }
        }
        var out = [];
        for (var t = 0; t < taus.length; t++) {
            var tau = taus[t], arr = byTau[tau];
            if (!arr || arr.length < minN) continue;
            var n = arr.length, mLat = 0, mLon = 0;
            for (var a = 0; a < n; a++) { mLat += arr[a][0]; mLon += arr[a][1]; }
            mLat /= n; mLon /= n;
            var kx = 111.2 * Math.cos(mLat * D2R), ky = 111.2;
            var sxx = 0, syy = 0, sxy = 0;
            for (var b = 0; b < n; b++) {
                var dx = (arr[b][1] - mLon) * kx, dy = (arr[b][0] - mLat) * ky;
                sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
            }
            sxx /= (n - 1); syy /= (n - 1); sxy /= (n - 1);
            // Eigen-decomposition of the 2×2 covariance.
            var tr2 = (sxx + syy) / 2, det = sxx * syy - sxy * sxy;
            var disc = Math.sqrt(Math.max(0, tr2 * tr2 - det));
            var l1 = tr2 + disc, l2 = Math.max(1e-6, tr2 - disc);
            var ang = Math.atan2(l1 - sxx, sxy || 1e-9);   // major-axis angle (radians)
            if (!sxy && sxx >= syy) ang = 0;
            var s1 = Math.sqrt(l1), s2 = Math.sqrt(l2);
            function ring(kScale) {
                var poly = [];
                for (var q = 0; q <= nPts; q++) {
                    var th = 2 * Math.PI * q / nPts;
                    var ex = kScale * s1 * Math.cos(th), ey = kScale * s2 * Math.sin(th);
                    var x = ex * Math.cos(ang) - ey * Math.sin(ang);
                    var y = ex * Math.sin(ang) + ey * Math.cos(ang);
                    poly.push([mLat + y / ky, wrapLon(mLon + x / kx)]);
                }
                return poly;
            }
            // χ² (2 dof): 50 % → 1.386, 90 % → 4.605
            out.push({ tau: tau, n: n, lat: mLat, lon: wrapLon(mLon),
                       poly50: ring(Math.sqrt(1.386)), poly90: ring(Math.sqrt(4.605)),
                       sigmaKm: [s1, s2] });
        }
        return out;
    }

    // ── 4. survival ───────────────────────────────────────────────────────
    // Fraction of members that still carry the system (a point with a wind
    // value) at each lead. Returns { taus, frac, counts, n }.
    function survival(members, taus) {
        var keys = memberKeys(members), n = keys.length;
        var counts = taus.map(function () { return 0; });
        var idx = {}; taus.forEach(function (t, i) { idx[t] = i; });
        for (var i = 0; i < n; i++) {
            var pts = members[keys[i]].points || [];
            var seen = {};
            for (var j = 0; j < pts.length; j++) {
                var p = pts[j];
                if (p.wind == null || idx[p.tau] == null || seen[p.tau]) continue;
                seen[p.tau] = 1; counts[idx[p.tau]]++;
            }
        }
        return { taus: taus, counts: counts, n: n,
                 frac: counts.map(function (c) { return n ? c / n : 0; }) };
    }

    // ── 5. rapid-intensification probability ──────────────────────────────
    // dist = /weatherlab-ensemble payload: { lead_times_h, intensity_change_24h:
    //   { "<tau>": { dv: [per member...] } }, n_members }. Member order is
    // consistent across taus, so "any RI by lead T" is a per-index scan.
    // Returns { taus, pAt (P(ΔV24≥thresh) ending at tau), pBy (cumulative), n, thresh }
    function riProbability(dist, opts) {
        opts = opts || {};
        var thresh = opts.thresh || 30;
        var ch = (dist && dist.intensity_change_24h) || {};
        var taus = Object.keys(ch).map(Number).sort(function (a, b) { return a - b; });
        var n = dist && dist.n_members || 0;
        var ever = null;
        var pAt = [], pBy = [];
        for (var i = 0; i < taus.length; i++) {
            var dv = ch[String(taus[i])].dv || [];
            if (!ever) ever = new Uint8Array(dv.length);
            var hit = 0, alive = 0, cum = 0;
            for (var m = 0; m < dv.length; m++) {
                if (dv[m] != null) { alive++; if (dv[m] >= thresh) { hit++; ever[m] = 1; } }
                if (ever[m]) cum++;
            }
            var denom = n || dv.length || 1;
            pAt.push(hit / denom); pBy.push(cum / denom);
        }
        return { taus: taus, pAt: pAt, pBy: pBy, n: n, thresh: thresh };
    }

    // ── 6. landfall ───────────────────────────────────────────────────────
    // isLand(lat, lon) → boolean. Per member: the first water→land crossing at
    // 1-h resolution (a system already inland at +0 h must go back to sea
    // before it can "make landfall"). Returns
    //   { n, events: [{ member, tau, lat, lon, wind }], pAny, pBy: { "72": p, ... },
    //     taus: [], winds: [], byCat: { TD: k, TS: k, C1..C5 } }
    function landfall(members, isLand, opts) {
        opts = opts || {};
        var maxTau = opts.maxTau != null ? opts.maxTau : 360, stepH = opts.stepH || 1;
        var horizons = opts.horizons || [48, 72, 120, 168];
        var keys = memberKeys(members);
        var out = { n: 0, events: [], taus: [], winds: [], pAny: 0, pBy: {}, byCat: {} };
        for (var i = 0; i < keys.length; i++) {
            var tr = memberTrack(members[keys[i]], maxTau);
            if (!tr.length) continue;
            out.n++;
            var wasLand = null, ev = null;
            walkTrack(tr, stepH, 34, function (s) {
                var land = !!isLand(s.lat, wrapLon(s.lon));
                if (wasLand === false && land) {
                    ev = { member: keys[i], tau: Math.round(s.tau), lat: s.lat, lon: wrapLon(s.lon),
                           wind: s.wind != null ? Math.round(s.wind) : null };
                    return false;
                }
                wasLand = land;
            });
            if (ev) {
                out.events.push(ev); out.taus.push(ev.tau);
                if (ev.wind != null) out.winds.push(ev.wind);
                var cat = catOf(ev.wind);
                out.byCat[cat] = (out.byCat[cat] || 0) + 1;
            }
        }
        if (out.n) {
            out.pAny = out.events.length / out.n;
            for (var h = 0; h < horizons.length; h++) {
                var H = horizons[h], c = 0;
                for (var e = 0; e < out.events.length; e++) if (out.events[e].tau <= H) c++;
                out.pBy[String(H)] = c / out.n;
            }
        }
        return out;
    }
    function catOf(w) {
        if (w == null) return 'NA';
        if (w < 34) return 'TD'; if (w < 64) return 'TS'; if (w < 83) return 'C1';
        if (w < 96) return 'C2'; if (w < 113) return 'C3'; if (w < 137) return 'C4';
        return 'C5';
    }

    // ── 7. model comparison ───────────────────────────────────────────────
    // a, b = /weatherlab payloads ({ members, ensemble_mean, ... }). Per lead:
    // separation of the two ensemble means, mean Vmax difference, each
    // ensemble's spread (mean member distance from its own mean), and
    // P(≥64 kt) for each. Returns { taus, rows: [{ tau, sepKm, dirDeg, vA, vB,
    //   spreadA, spreadB, p64A, p64B, nA, nB }], summary }.
    function ensembleStats(payload, tau) {
        var members = payload && payload.members || {}, keys = memberKeys(members);
        var lats = [], lons = [], winds = [], lonRef = null;
        for (var i = 0; i < keys.length; i++) {
            var pts = members[keys[i]].points || [];
            for (var j = 0; j < pts.length; j++) {
                var p = pts[j];
                if (p.tau !== tau || p.lat == null) continue;
                if (lonRef == null) lonRef = p.lon;
                lats.push(p.lat); lons.push(unwrapLon(p.lon, lonRef));
                if (p.wind != null) winds.push(p.wind);
                break;
            }
        }
        var n = lats.length; if (!n) return null;
        var mLat = 0, mLon = 0; for (var a = 0; a < n; a++) { mLat += lats[a]; mLon += lons[a]; }
        mLat /= n; mLon /= n;
        var spread = 0; for (var b = 0; b < n; b++) spread += haversineKm(mLat, mLon, lats[b], lons[b]);
        spread /= n;
        var vMean = null, p64 = null;
        if (winds.length) {
            vMean = 0; var c64 = 0;
            for (var w = 0; w < winds.length; w++) { vMean += winds[w]; if (winds[w] >= 64) c64++; }
            vMean /= winds.length; p64 = c64 / winds.length;
        }
        // Prefer the published ensemble mean position when present.
        var em = payload.ensemble_mean && payload.ensemble_mean.points || [];
        for (var e = 0; e < em.length; e++) {
            if (em[e].tau === tau && em[e].lat != null) { mLat = em[e].lat; mLon = em[e].lon; if (em[e].wind != null) vMean = em[e].wind; break; }
        }
        return { n: n, lat: mLat, lon: wrapLon(mLon), vMean: vMean, spreadKm: spread, p64: p64,
                 alive: n / Math.max(1, keys.length) };
    }
    // Runs may come from different cycles (WN3 publishes on its own clock),
    // so leads are aligned by VALID time: `tau` is the lead from the LATER of
    // the two inits, and the earlier run is sampled at tau + its head start.
    function compareModels(a, b, taus) {
        var rows = [];
        var offAB = initOffsetH(a && a.init_time, b && b.init_time);   // + when b later
        var offA = Math.max(0, offAB), offB = Math.max(0, -offAB);
        var refInit = offAB >= 0 ? (b && b.init_time) : (a && a.init_time);
        for (var i = 0; i < taus.length; i++) {
            var tau = taus[i], sa = ensembleStats(a, tau + offA), sb = ensembleStats(b, tau + offB);
            if (!sa || !sb) continue;
            rows.push({
                tau: tau, tauA: tau + offA, tauB: tau + offB,
                sepKm: haversineKm(sa.lat, sa.lon, sb.lat, sb.lon),
                dirDeg: bearingDeg(sa.lat, sa.lon, sb.lat, sb.lon),   // A → B
                vA: sa.vMean, vB: sb.vMean,
                spreadA: sa.spreadKm, spreadB: sb.spreadKm,
                p64A: sa.p64, p64B: sb.p64,
                aliveA: sa.alive, aliveB: sb.alive,
                nA: sa.n, nB: sb.n,
            });
        }
        var summary = null;
        if (rows.length) {
            var maxSep = rows.reduce(function (m, r) { return r.sepKm > m.sepKm ? r : m; }, rows[0]);
            var maxDv = rows.reduce(function (m, r) {
                var d = (r.vA != null && r.vB != null) ? Math.abs(r.vA - r.vB) : -1;
                var dm = (m.vA != null && m.vB != null) ? Math.abs(m.vA - m.vB) : -1;
                return d > dm ? r : m; }, rows[0]);
            summary = { maxSepTau: maxSep.tau, maxSepKm: maxSep.sepKm,
                        maxDvTau: maxDv.tau, maxDv: (maxDv.vA != null && maxDv.vB != null) ? maxDv.vB - maxDv.vA : null };
        }
        return { taus: taus, rows: rows, summary: summary, refInit: refInit,
                 offsetA: offA, offsetB: offB, initA: a && a.init_time, initB: b && b.init_time };
    }

    // ── 8. ensemble vs an official / consensus forecast ───────────────────
    // fc = { points: [{ tau, lat, lon, wind }] } (a-deck shape). Per lead present
    // in fc: DM mean separation from it, member cross-track split (fraction of
    // members left/right of the official position looking along its motion),
    // Vmax percentiles vs the official value.
    // opts.fcInit = the forecast's init ("YYYYMMDDHH"); the ensemble is sampled
    // at the matching VALID time (its own tau = fc tau + init head start).
    function vsForecast(dm, fc, opts) {
        opts = opts || {};
        var off = initOffsetH(dm && dm.init_time, opts.fcInit || (dm && dm.init_time));   // + when fc later
        var pts = (fc && fc.points || []).filter(function (p) { return p.lat != null && p.tau > 0; });
        // a-deck rows repeat per radius line; dedupe by tau.
        var seen = {}, uniq = [];
        for (var i = 0; i < pts.length; i++) { if (!seen[pts[i].tau]) { seen[pts[i].tau] = 1; uniq.push(pts[i]); } }
        uniq.sort(function (a, b) { return a.tau - b.tau; });
        var members = dm && dm.members || {}, keys = memberKeys(members);
        var rows = [];
        for (var u = 0; u < uniq.length; u++) {
            var f = uniq[u], tau = f.tau, dmTau = tau + off;
            if (dmTau < 0) continue;
            var st = ensembleStats(dm, dmTau); if (!st) continue;
            var winds = [], nLeft = 0, nRight = 0, nTot = 0;
            // Motion direction of the official track at this tau.
            var prev = uniq[u - 1] || null, next = uniq[u + 1] || null;
            var hdg = null;
            if (prev && next) hdg = bearingDeg(prev.lat, prev.lon, next.lat, next.lon);
            else if (prev) hdg = bearingDeg(prev.lat, prev.lon, f.lat, f.lon);
            else if (next) hdg = bearingDeg(f.lat, f.lon, next.lat, next.lon);
            for (var m = 0; m < keys.length; m++) {
                var mp = members[keys[m]].points || [];
                for (var j = 0; j < mp.length; j++) {
                    var p = mp[j]; if (p.tau !== dmTau || p.lat == null) continue;
                    if (p.wind != null) winds.push(p.wind);
                    if (hdg != null) {
                        var br = bearingDeg(f.lat, f.lon, p.lat, p.lon);
                        var rel = ((br - hdg) + 540) % 360 - 180;   // -180..180, + = right of motion
                        nTot++; if (rel > 0) nRight++; else nLeft++;
                    }
                    break;
                }
            }
            winds.sort(function (a, b) { return a - b; });
            function pct(q) { return winds.length ? winds[Math.min(winds.length - 1, Math.floor(q * (winds.length - 1)))] : null; }
            rows.push({
                tau: tau, dmTau: dmTau, fcLat: f.lat, fcLon: f.lon, fcWind: f.wind != null ? f.wind : null,
                dmLat: st.lat, dmLon: st.lon, dmWind: st.vMean,
                sepKm: haversineKm(f.lat, f.lon, st.lat, st.lon),
                dirDeg: bearingDeg(f.lat, f.lon, st.lat, st.lon),   // official → DM mean
                p10: pct(0.10), p50: pct(0.50), p90: pct(0.90),
                fracRight: nTot ? nRight / nTot : null, fracLeft: nTot ? nLeft / nTot : null,
                n: st.n,
            });
        }
        return { rows: rows, tech: fc && fc.tech, name: fc && fc.name, offsetH: off,
                 fcInit: opts.fcInit || null, dmInit: dm && dm.init_time || null };
    }

    // ── 9. land mask ──────────────────────────────────────────────────────
    // url → Promise<isLand(lat, lon)>. The PNG is a global equirectangular
    // 1-bit image (row 0 = 90°N, col 0 = 180°W), white = land.
    function loadLandMask(url) {
        return new Promise(function (resolve, reject) {
            if (typeof Image === 'undefined') { reject(new Error('no DOM')); return; }
            var im = new Image();
            im.crossOrigin = 'anonymous';
            im.onload = function () {
                try {
                    var w = im.naturalWidth, h = im.naturalHeight;
                    var c = document.createElement('canvas'); c.width = w; c.height = h;
                    var ctx = c.getContext('2d', { willReadFrequently: true });
                    ctx.drawImage(im, 0, 0);
                    var d = ctx.getImageData(0, 0, w, h).data;
                    var mask = new Uint8Array(w * h);
                    for (var i = 0; i < w * h; i++) mask[i] = d[i * 4] > 127 ? 1 : 0;
                    var fn = function (lat, lon) {
                        var x = Math.floor((wrapLon(lon) + 180) / 360 * w);
                        var y = Math.floor((90 - lat) / 180 * h);
                        if (x < 0) x = 0; if (x >= w) x = w - 1; if (y < 0) y = 0; if (y >= h) y = h - 1;
                        return mask[y * w + x] === 1;
                    };
                    fn.width = w; fn.height = h;
                    resolve(fn);
                } catch (e) { reject(e); }
            };
            im.onerror = function () { reject(new Error('land mask load failed')); };
            im.src = url;
        });
    }

    // ── 10. Mercator rasterization for L.imageOverlay ─────────────────────
    // grid → [{ url, bounds: [[s,w],[n,e]] }] (two parts if the grid spans the
    // antimeridian). colorFn(p) → [r,g,b,a] (a 0..255), null/0-alpha = clear.
    // The PNG rows are spaced in Web Mercator so the overlay lands at the
    // right latitude (an equirectangular image stretched over a Mercator map
    // is displaced everywhere but the equator).
    function rasterizeMercator(g, colorFn, opts) {
        opts = opts || {};
        if (!g || typeof document === 'undefined') return [];
        var pxPerCell = opts.pxPerCell || 4;
        var south = g.lat0 - g.ny * g.dLat, north = g.lat0;
        var west = g.lon0, east = g.lon0 + g.nx * g.dLon;
        function merc(lat) { return Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2)); }
        var mS = merc(Math.max(-85, south)), mN = merc(Math.min(85, north));
        var H = Math.max(1, Math.round(g.ny * pxPerCell * (mN - mS) / ((north - south) * D2R)));
        H = Math.min(H, 4096);
        // Split at the antimeridian in unwrapped-lon space.
        var parts = [];
        var wrapAt = null;
        for (var k = -720; k <= 720; k += 360) { if (west < k + 180 && east > k + 180) { wrapAt = k + 180; break; } }
        if (wrapAt == null) parts.push([west, east]); else parts.push([west, wrapAt], [wrapAt, east]);
        var out = [];
        for (var pi = 0; pi < parts.length; pi++) {
            var pw = parts[pi][0], pe = parts[pi][1];
            var c0 = Math.round((pw - west) / g.dLon), c1 = Math.round((pe - west) / g.dLon);
            var W = Math.max(1, Math.min(4096, (c1 - c0) * pxPerCell));
            var canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
            var ctx = canvas.getContext('2d');
            var img = ctx.createImageData(W, H), d = img.data;
            for (var y = 0; y < H; y++) {
                // pixel row centre → Mercator y → lat → grid row
                var my = mN - (y + 0.5) / H * (mN - mS);
                var lat = (2 * Math.atan(Math.exp(my)) - Math.PI / 2) / D2R;
                var r = Math.floor((north - lat) / g.dLat); if (r < 0) r = 0; if (r >= g.ny) r = g.ny - 1;
                // Bilinear interpolation between cell centres so the overlay
                // reads as a smooth field rather than 0.2° blocks.
                var fy = (north - lat) / g.dLat - 0.5;
                var ry0 = Math.max(0, Math.min(g.ny - 1, Math.floor(fy))), ry1 = Math.min(g.ny - 1, ry0 + 1);
                var wy = Math.max(0, Math.min(1, fy - ry0));
                for (var x = 0; x < W; x++) {
                    var fx = (c0 * pxPerCell + x + 0.5) / pxPerCell - 0.5;
                    var cx0 = Math.max(0, Math.min(g.nx - 1, Math.floor(fx))), cx1 = Math.min(g.nx - 1, cx0 + 1);
                    var wx = Math.max(0, Math.min(1, fx - cx0));
                    var v = opts.bilinear === false ? g.prob[r * g.nx + Math.min(g.nx - 1, c0 + Math.floor(x / pxPerCell))]
                        : (g.prob[ry0 * g.nx + cx0] * (1 - wx) + g.prob[ry0 * g.nx + cx1] * wx) * (1 - wy)
                          + (g.prob[ry1 * g.nx + cx0] * (1 - wx) + g.prob[ry1 * g.nx + cx1] * wx) * wy;
                    var rgba = colorFn(v);
                    var o = (y * W + x) * 4;
                    if (!rgba || !rgba[3]) { d[o + 3] = 0; continue; }
                    d[o] = rgba[0]; d[o + 1] = rgba[1]; d[o + 2] = rgba[2]; d[o + 3] = rgba[3];
                }
            }
            ctx.putImageData(img, 0, 0);
            out.push({ url: canvas.toDataURL('image/png'),
                       bounds: [[south, wrapLon(pw) === -180 && pw !== west ? -180 : wrapLon(pw)],
                                [north, wrapLon(pe) === -180 ? 180 : wrapLon(pe)]] });
        }
        return out;
    }

    // ── 11. binary-mask boundary tracing → smooth rings ───────────────────
    // mask: Uint8Array (row-major, row 0 = north) on a grid {lat0, lon0, dLat,
    // dLon, nx, ny}. Returns rings of [lat, lon] (grid's unwrapped-lon frame),
    // outer boundaries only (holes dropped), Chaikin-smoothed so the 0.1–0.2°
    // cell steps read as the smooth Chavas-style swath outlines rather than
    // staircases. Region cells are traced clockwise in screen (y-down)
    // space; inner (hole) rings come out with the opposite signed area.
    function boundaryRings(mask, g, opts) {
        opts = opts || {};
        var nx = g.nx, ny = g.ny, smooth = opts.smooth != null ? opts.smooth : 2;
        var minCells = opts.minCells || 6;
        function inside(r, c) { return r >= 0 && r < ny && c >= 0 && c < nx && mask[r * nx + c] === 1; }
        // Directed boundary edges keyed by start corner "x,y".
        var out = {};
        function addEdge(x0, y0, x1, y1) { var k = x0 + ',' + y0; (out[k] = out[k] || []).push([x1, y1]); }
        for (var r = 0; r < ny; r++) for (var c = 0; c < nx; c++) {
            if (mask[r * nx + c] !== 1) continue;
            if (!inside(r - 1, c)) addEdge(c, r, c + 1, r);           // top: L→R
            if (!inside(r, c + 1)) addEdge(c + 1, r, c + 1, r + 1);   // right: T→B
            if (!inside(r + 1, c)) addEdge(c + 1, r + 1, c, r + 1);   // bottom: R→L
            if (!inside(r, c - 1)) addEdge(c, r + 1, c, r);           // left: B→T
        }
        var rings = [];
        var keys = Object.keys(out);
        for (var ki = 0; ki < keys.length; ki++) {
            var k = keys[ki];
            while (out[k] && out[k].length) {
                var start = k.split(',').map(Number), cur = start, ring = [start];
                var guard = 0;
                while (guard++ < 1e6) {
                    var ck = cur[0] + ',' + cur[1], lst = out[ck];
                    if (!lst || !lst.length) break;
                    var nxt = lst.pop();
                    if (nxt[0] === start[0] && nxt[1] === start[1]) break;
                    ring.push(nxt); cur = nxt;
                }
                if (ring.length >= 4) rings.push(ring);
            }
        }
        var result = [];
        for (var ri = 0; ri < rings.length; ri++) {
            var rg = rings[ri];
            // Signed area in grid units (y-down). A single cell traces
            // TL→TR→BR→BL, which makes this sum NEGATIVE for outer rings;
            // holes (traced the other way round) come out positive.
            var area = 0;
            for (var i = 0; i < rg.length; i++) {
                var a = rg[i], b = rg[(i + 1) % rg.length];
                area += (b[0] - a[0]) * (b[1] + a[1]);
            }
            if (area >= 0) continue;                 // hole
            if (Math.abs(area) / 2 < minCells) continue;   // speck
            var pts = rg;
            for (var it = 0; it < smooth; it++) pts = chaikinClosed(pts);
            // Keep rings light for the renderers (Plotly/GL): uniform decimation.
            var maxPts = opts.maxPts || 700;
            if (pts.length > maxPts) {
                var stepK = pts.length / maxPts, dec = [];
                for (var di = 0; di < pts.length; di += stepK) dec.push(pts[Math.floor(di)]);
                pts = dec;
            }
            result.push(pts.map(function (p) { return [g.lat0 - p[1] * g.dLat, g.lon0 + p[0] * g.dLon]; }));
        }
        return result;
    }
    function chaikinClosed(pts) {
        var out = [], n = pts.length;
        for (var i = 0; i < n; i++) {
            var p = pts[i], q = pts[(i + 1) % n];
            out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]]);
            out.push([0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
        }
        return out;
    }
    // Filled-contour rings of a probability grid at ascending `levels`
    // (fractions). Draw low→high so higher levels paint on top.
    function probContours(g, levels, opts) {
        opts = opts || {};
        var out = [];
        if (!g) return out;
        // Bilinearly upsample the grid first so the iso-lines follow the
        // field between cell centres instead of stepping cell by cell.
        var up = opts.upsample || 3;
        var gg = up > 1 ? upsampleGrid(g, up) : g;
        for (var li = 0; li < levels.length; li++) {
            var mask = new Uint8Array(gg.nx * gg.ny);
            for (var i = 0; i < mask.length; i++) mask[i] = gg.prob[i] >= levels[li] ? 1 : 0;
            out.push({ level: levels[li], rings: boundaryRings(mask, gg, { smooth: opts.smooth != null ? opts.smooth : 3,
                                                                          minCells: (opts.minCells || 4) * up * up, maxPts: opts.maxPts }) });
        }
        return out;
    }
    function upsampleGrid(g, k) {
        var nx = g.nx * k, ny = g.ny * k, prob = new Float32Array(nx * ny);
        for (var y = 0; y < ny; y++) {
            var fy = (y + 0.5) / k - 0.5, r0 = Math.max(0, Math.min(g.ny - 1, Math.floor(fy))), r1 = Math.min(g.ny - 1, r0 + 1), wy = Math.max(0, Math.min(1, fy - r0));
            for (var x = 0; x < nx; x++) {
                var fx = (x + 0.5) / k - 0.5, c0 = Math.max(0, Math.min(g.nx - 1, Math.floor(fx))), c1 = Math.min(g.nx - 1, c0 + 1), wx = Math.max(0, Math.min(1, fx - c0));
                prob[y * nx + x] = (g.prob[r0 * g.nx + c0] * (1 - wx) + g.prob[r0 * g.nx + c1] * wx) * (1 - wy)
                                 + (g.prob[r1 * g.nx + c0] * (1 - wx) + g.prob[r1 * g.nx + c1] * wx) * wy;
            }
        }
        return { lat0: g.lat0, lon0: g.lon0, dLat: g.dLat / k, dLon: g.dLon / k, nx: nx, ny: ny, prob: prob };
    }

    // ── 12. track swath — union of position ellipses along the forecast ───
    // Bivariate-normal 50 % or 90 % ellipses at every 6-h lead, interpolated
    // hourly between leads so fast movers leave no gaps, rasterized on a fine
    // grid and traced into a single smooth outline (the ensemble analogue of
    // the Chavas lifetime wind swath). Returns { rings, level, taus }.
    function trackSwath(members, opts) {
        opts = opts || {};
        var level = opts.level || 0.9, maxTau = opts.maxTau != null ? opts.maxTau : 120;
        var cell = opts.cellDeg || 0.1, stepH = opts.stepH || 1;
        var kScale = Math.sqrt(level >= 0.9 ? 4.605 : level >= 0.68 ? 2.279 : 1.386);
        var tauSet = {};
        var keys = memberKeys(members);
        for (var i = 0; i < keys.length; i++) {
            var pts = members[keys[i]].points || [];
            for (var j = 0; j < pts.length; j++) if (pts[j].tau <= maxTau) tauSet[pts[j].tau] = 1;
        }
        var taus = Object.keys(tauSet).map(Number).sort(function (a, b) { return a - b; });
        var ells = trackEllipses(members, taus, { minN: opts.minN || 5, nPts: 8 });
        if (ells.length < 1) return { rings: [], level: level, taus: taus };
        // Unwrap ellipse centres into one frame.
        var ref = ells[0].lon;
        for (var e = 0; e < ells.length; e++) { ells[e].ulon = unwrapLon(ells[e].lon, ref); ref = ells[e].ulon; }
        // Ellipse frame: angle of the major axis from trackEllipses is
        // implicit in poly50; recover axis angle from sigma orientation by
        // refitting: use the 50 % ring's farthest point as the major axis.
        function axisAngle(el) {
            var best = 0, bd = -1, kx = 111.2 * Math.cos(el.lat * D2R);
            for (var q = 0; q < el.poly50.length; q++) {
                var dx = unwrapLon(el.poly50[q][1], el.lon) - el.lon, dy = el.poly50[q][0] - el.lat;
                var d = (dx * kx) * (dx * kx) + (dy * 111.2) * (dy * 111.2);
                if (d > bd) { bd = d; best = Math.atan2(dy * 111.2, dx * kx); }
            }
            return best;
        }
        var samples = [];
        for (var a = 0; a < ells.length; a++) {
            var E = ells[a]; E.ang = axisAngle(E);
            if (a === 0) samples.push({ lat: E.lat, lon: E.ulon, s1: E.sigmaKm[0], s2: E.sigmaKm[1], ang: E.ang });
            else {
                var P = ells[a - 1], nSub = Math.max(1, Math.round((E.tau - P.tau) / stepH));
                var dAng = E.ang - P.ang; while (dAng > Math.PI / 2) dAng -= Math.PI; while (dAng < -Math.PI / 2) dAng += Math.PI;
                for (var sIdx = 1; sIdx <= nSub; sIdx++) {
                    var f = sIdx / nSub;
                    samples.push({ lat: lerp(P.lat, E.lat, f), lon: lerp(P.ulon, E.ulon, f),
                                   s1: lerp(P.sigmaKm[0], E.sigmaKm[0], f), s2: lerp(P.sigmaKm[1], E.sigmaKm[1], f),
                                   ang: P.ang + dAng * f });
                }
            }
        }
        // Grid extent from sample bounding boxes.
        var minLat = 90, maxLat = -90, minLon = 1e9, maxLon = -1e9;
        for (var s0 = 0; s0 < samples.length; s0++) {
            var sm = samples[s0], rDeg = kScale * sm.s1 / 111.2, rLon = rDeg / Math.max(0.2, Math.cos(sm.lat * D2R));
            minLat = Math.min(minLat, sm.lat - rDeg); maxLat = Math.max(maxLat, sm.lat + rDeg);
            minLon = Math.min(minLon, sm.lon - rLon); maxLon = Math.max(maxLon, sm.lon + rLon);
        }
        var g = { lat0: Math.min(85, Math.ceil((maxLat + cell) / cell) * cell), lon0: Math.floor((minLon - cell) / cell) * cell,
                  dLat: cell, dLon: cell };
        g.ny = Math.max(1, Math.round((g.lat0 - Math.max(-85, Math.floor((minLat - cell) / cell) * cell)) / cell));
        g.nx = Math.max(1, Math.round((Math.ceil((maxLon + cell) / cell) * cell - g.lon0) / cell));
        if (g.nx * g.ny > 6e6) return { rings: [], level: level, taus: taus };
        var mask = new Uint8Array(g.nx * g.ny);
        for (var si = 0; si < samples.length; si++) {
            var S = samples[si], kx = 111.2 * Math.cos(S.lat * D2R), ky = 111.2;
            var A = kScale * S.s1, Bm = kScale * Math.max(S.s2, 3), ca = Math.cos(S.ang), sa = Math.sin(S.ang);
            var rDegS = A / ky, rLonS = A / kx;
            var r0 = Math.max(0, Math.floor((g.lat0 - (S.lat + rDegS)) / cell)), r1 = Math.min(g.ny - 1, Math.ceil((g.lat0 - (S.lat - rDegS)) / cell));
            var c0 = Math.max(0, Math.floor((S.lon - rLonS - g.lon0) / cell)), c1 = Math.min(g.nx - 1, Math.ceil((S.lon + rLonS - g.lon0) / cell));
            for (var rr = r0; rr <= r1; rr++) {
                var dy = ((g.lat0 - (rr + 0.5) * cell) - S.lat) * ky;
                for (var cc = c0; cc <= c1; cc++) {
                    var idx = rr * g.nx + cc; if (mask[idx]) continue;
                    var dx = ((g.lon0 + (cc + 0.5) * cell) - S.lon) * kx;
                    var u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
                    if ((u * u) / (A * A) + (v * v) / (Bm * Bm) <= 1) mask[idx] = 1;
                }
            }
        }
        return { rings: boundaryRings(mask, g, { smooth: 3, minCells: 10 }), level: level, taus: taus, grid: g };
    }

    // ── 13. composite several probability grids (max) into one ────────────
    function compositeGrids(grids) {
        grids = (grids || []).filter(Boolean);
        if (!grids.length) return null;
        if (grids.length === 1) return grids[0];
        var cell = grids[0].dLat, refLon = grids[0].lon0 + grids[0].nx * cell / 2;
        var shifted = grids.map(function (g) {
            var c = g.lon0 + g.nx * g.dLon / 2, u = unwrapLon(c, refLon);
            return { g: g, shift: u - c };
        });
        var north = -90, south = 90, west = 1e9, east = -1e9;
        shifted.forEach(function (sg) {
            var g = sg.g;
            north = Math.max(north, g.lat0); south = Math.min(south, g.lat0 - g.ny * g.dLat);
            west = Math.min(west, g.lon0 + sg.shift); east = Math.max(east, g.lon0 + g.nx * g.dLon + sg.shift);
        });
        var nx = Math.round((east - west) / cell), ny = Math.round((north - south) / cell);
        if (nx * ny > 6e6) return null;
        var prob = new Float32Array(nx * ny), maxP = 0;
        shifted.forEach(function (sg) {
            var g = sg.g, rOff = Math.round((north - g.lat0) / cell), cOff = Math.round((g.lon0 + sg.shift - west) / cell);
            var scale = g.dLat / cell;
            for (var r = 0; r < g.ny; r++) for (var c = 0; c < g.nx; c++) {
                var v = g.prob[r * g.nx + c]; if (!(v > 0)) continue;
                var R = rOff + Math.round(r * scale), C = cOff + Math.round(c * scale);
                if (R < 0 || R >= ny || C < 0 || C >= nx) continue;
                var i = R * nx + C; if (v > prob[i]) prob[i] = v; if (v > maxP) maxP = v;
            }
        });
        return { lat0: north, lon0: west, dLat: cell, dLon: cell, nx: nx, ny: ny, prob: prob, maxProb: maxP,
                 n: grids[0].n, thresh: grids[0].thresh, maxTau: grids[0].maxTau, lonRef: refLon };
    }

    // ── 14. RI probability straight from paired members ───────────────────
    // (For the Global Map popup, where only the 50/64-member payload exists.)
    function riFromMembers(members, opts) {
        var keys = memberKeys(members), series = [];
        var tauSet = {};
        for (var i = 0; i < keys.length; i++) {
            var m = {}, pts = members[keys[i]].points || [];
            for (var j = 0; j < pts.length; j++) if (pts[j].wind != null) { m[pts[j].tau] = pts[j].wind; tauSet[pts[j].tau] = 1; }
            series.push(m);
        }
        var taus = Object.keys(tauSet).map(Number).sort(function (a, b) { return a - b; });
        var ch = {};
        for (var t = 0; t < taus.length; t++) {
            var tau = taus[t]; if (!tauSet[tau - 24]) continue;
            ch[String(tau)] = { dv: series.map(function (m) {
                return (m[tau] != null && m[tau - 24] != null) ? m[tau] - m[tau - 24] : null; }) };
        }
        return riProbability({ intensity_change_24h: ch, n_members: keys.length }, opts);
    }

    // Compact percentile helper for the UI.
    function percentiles(arr, qs) {
        var s = (arr || []).slice().sort(function (a, b) { return a - b; });
        return qs.map(function (q) {
            if (!s.length) return null;
            return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
        });
    }

    return {
        haversineKm: haversineKm, bearingDeg: bearingDeg, wrapLon: wrapLon, unwrapLon: unwrapLon,
        initToMs: initToMs, initOffsetH: initOffsetH,
        memberTrack: memberTrack,
        windProbGrid: windProbGrid, gridSample: gridSample,
        pointProbabilities: pointProbabilities,
        trackEllipses: trackEllipses,
        survival: survival,
        riProbability: riProbability,
        landfall: landfall, catOf: catOf,
        compareModels: compareModels, ensembleStats: ensembleStats,
        vsForecast: vsForecast,
        loadLandMask: loadLandMask,
        rasterizeMercator: rasterizeMercator,
        boundaryRings: boundaryRings, probContours: probContours, trackSwath: trackSwath,
        compositeGrids: compositeGrids, riFromMembers: riFromMembers,
        percentiles: percentiles,
    };
}));
