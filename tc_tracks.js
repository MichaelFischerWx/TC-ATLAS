/* ══════════════════════════════════════════════════════════════
   TC-ATLAS best-track loader — packed IBTrACS chunks.
   ══════════════════════════════════════════════════════════════
   The track chunks are one JSON object per fix:

     ibtracs_tracks_N.json    { sid: [{t, la, lo, n, w?, p?}, ...], ... }

   ~720,000 fixes, 46 MB of JSON (6.4 MB gzipped), parsed on the main
   thread. pipeline/pack_tracks.py writes the same values as six columns
   per storm, 12.5 MB (1.6 MB gzipped):

     ibtracs_tracks_pN.json   { format, epoch, nature, tracks: { sid:
                                [dt, dla, dlo, n, w, p], ... } }

   and this file rebuilds the per-fix objects from it, so every page
   keeps reading tracks[sid][i].t / .la / .lo / .n / .w / .p as before.

     TCTracks.fetchChunk('ibtracs_tracks_0.json', 'v20261101i1')
         → Promise<{ sid: [point, ...] }>

   fetchChunk reads the packed copy of the chunk it is given and falls
   back to the per-fix chunk itself if the packed one is missing or
   unreadable. Unpacking yields to the page every few milliseconds, so
   the map stays responsive while 13,000 storms are rebuilt.
   ══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var FORMAT = 'tc-tracks-packed/1';
    var SLICE_MS = 12;      // unpack this long, then let the page breathe

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    // ibtracs_tracks_0.json → ibtracs_tracks_p0.json (pack_tracks.packed_name)
    function packedName(file) {
        return String(file).replace(/_(\d+)\.json$/, '_p$1.json');
    }

    // setTimeout is clamped to 1 s in a background tab; a message is not.
    var _yield = (function () {
        if (typeof MessageChannel === 'undefined') {
            return function (fn) { setTimeout(fn, 0); };
        }
        var ch = new MessageChannel(), queue = [];
        ch.port1.onmessage = function () { var fn = queue.shift(); if (fn) fn(); };
        return function (fn) { queue.push(fn); ch.port2.postMessage(0); };
    })();

    function unpack(packed) {
        return new Promise(function (resolve, reject) {
            if (!packed || packed.format !== FORMAT || !packed.tracks) {
                reject(new Error('unknown packed-track format'));
                return;
            }
            var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(packed.epoch || '');
            if (!m) { reject(new Error('bad packed-track epoch')); return; }
            var epochMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
            var nature = packed.nature || {};
            var tracks = packed.tracks;
            var sids = Object.keys(tracks);
            var out = {};
            // Fixes cluster on a few thousand days: format each date once.
            var dayStr = {};
            var hhmm = [];
            function dateOf(day) {
                var s = dayStr[day];
                if (s) return s;
                var d = new Date(epochMs + day * 86400000);
                s = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + 'T';
                dayStr[day] = s;
                return s;
            }
            function timeOf(min) {
                var s = hhmm[min];
                if (!s) s = hhmm[min] = pad2((min / 60) | 0) + ':' + pad2(min % 60);
                return s;
            }
            var i = 0;
            function slice() {
                try {
                    var until = Date.now() + SLICE_MS;
                    while (i < sids.length) {
                        var sid = sids[i++];
                        var c = tracks[sid];
                        var dt = c[0], dla = c[1], dlo = c[2], nat = c[3], w = c[4], p = c[5];
                        var n = dt.length, pts = new Array(n);
                        var min = 0, la = 0, lo = 0;
                        for (var k = 0; k < n; k++) {
                            min += dt[k]; la += dla[k]; lo += dlo[k];
                            var day = Math.floor(min / 1440);
                            var pt = {
                                t: dateOf(day) + timeOf(min - day * 1440),
                                la: la / 10,
                                lo: lo / 10,
                                n: nature[nat.charAt(k)]
                            };
                            if (w[k] >= 0) pt.w = w[k];
                            if (p[k] >= 0) pt.p = p[k];
                            pts[k] = pt;
                        }
                        out[sid] = pts;
                        tracks[sid] = null;     // release the columns as we go
                        if ((i & 31) === 0 && Date.now() >= until) break;
                    }
                } catch (e) { reject(e); return; }
                if (i < sids.length) _yield(slice); else resolve(out);
            }
            slice();
        });
    }

    function fetchJson(url) {
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
            return r.json();
        });
    }

    function fetchChunk(file, ver) {
        var q = ver ? '?' + ver : '';
        var packed = packedName(file);
        if (packed === file) return fetchJson(file + q);
        return fetchJson(packed + q).then(unpack).catch(function (e) {
            try { console.warn('[TC-ATLAS] packed tracks unavailable, loading ' + file + ':', e); } catch (x) {}
            return fetchJson(file + q);
        });
    }

    window.TCTracks = { fetchChunk: fetchChunk, unpack: unpack, packedName: packedName };
})();
