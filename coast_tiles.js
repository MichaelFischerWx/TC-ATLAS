/* coast_tiles.js -- full-resolution coastlines for canvas satellite views.
 *
 * Natural Earth 10 m coastline, pre-split into 10 x 10 degree static tiles
 * (assets/coastlines/tiles10/, bin/build_coastline_tiles.py; the set the GHOST
 * page and the TC-RADAR focus view already use). A storm-scale view touches
 * 1-9 tiles, tens of KB, where the simplified whole-world file is visibly
 * chunky at a 100-km window and the full one is 9 MB.
 *
 *   TCCoastTiles.get(south, north, west, east, onReady)
 *     -> {features: [GeoJSON MultiLineString Feature, ...], key}  when every
 *        tile under the box has loaded (longitudes in [-180, 180]; callers
 *        unwrap toward their own center);
 *     -> null while tiles are still loading: the fetches start and onReady()
 *        runs once they land (pass a stable function: it is queued once
 *        however often get() asks);
 *     -> false when tiles will not serve this box (the index failed, or the
 *        box spans more than MAX_TILES tiles: a zoomed-out view gains nothing).
 *        Callers then draw their simplified copy, and may draw it meanwhile.
 *        `key` names the tile set, for callers that cache projected segments.
 *
 * A tile or index that fails to load counts as empty and is not retried, so a
 * redraw loop never refetches.
 */
(function () {
    'use strict';
    var BASE = 'assets/coastlines/tiles10/', STEP = 10, MAX_TILES = 24;
    var index = null;           // Set of existing tile names; false = unavailable
    var indexReq = null;
    var tiles = {};             // name -> Feature | null (empty/failed) | undefined (loading or never asked)
    var asked = {};             // name -> true once fetched or in flight
    var waiters = [], flushTimer = null;

    function flushSoon() {      // tiles land one by one: one redraw per burst
        if (flushTimer) return;
        flushTimer = setTimeout(function () {
            flushTimer = null;
            var w = waiters; waiters = [];
            w.forEach(function (f) { try { f(); } catch (e) { } });
        }, 30);
    }
    function wait(fn) { if (typeof fn === 'function' && waiters.indexOf(fn) < 0) waiters.push(fn); }

    function loadIndex() {
        if (indexReq) return;
        indexReq = fetch(BASE + 'index.json')
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (j) { index = new Set((j && j.tiles) || []); })
            .catch(function () { index = false; })
            .then(flushSoon);
    }
    function loadTile(nm) {
        asked[nm] = true;
        fetch(BASE + nm)
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (g) { tiles[nm] = (g && g.geometry) ? g : null; })
            .catch(function () { tiles[nm] = null; })
            .then(flushSoon);
    }

    /* Existing tiles under a lat/lon box, named by their south-west corner with
       longitude wrapped to [-180, 180); null when the box needs too many. */
    function names(s, n, w, e) {
        var s0 = Math.max(-90, Math.floor(s / STEP) * STEP), n0 = Math.min(80, Math.floor(n / STEP) * STEP);
        var w0 = Math.floor(w / STEP) * STEP, e0 = Math.floor(e / STEP) * STEP;
        if (((n0 - s0) / STEP + 1) * ((e0 - w0) / STEP + 1) > MAX_TILES) return null;
        var out = [];
        for (var la = s0; la <= n0; la += STEP) {
            for (var lo = w0; lo <= e0; lo += STEP) {
                var nm = la + '_' + ((((lo + 180) % 360) + 360) % 360 - 180) + '.json';
                if (index.has(nm) && out.indexOf(nm) < 0) out.push(nm);
            }
        }
        return out;
    }

    function get(s, n, w, e, onReady) {
        if (index === false) return false;
        if (!index) { loadIndex(); wait(onReady); return null; }
        var nms = names(s, n, w, e);
        if (!nms) return false;
        var feats = [], missing = false;
        for (var i = 0; i < nms.length; i++) {
            var nm = nms[i];
            if (!asked[nm]) loadTile(nm);
            if (!(nm in tiles)) { missing = true; continue; }
            if (tiles[nm]) feats.push(tiles[nm]);
        }
        if (missing) { wait(onReady); return null; }
        return { features: feats, key: nms.join(',') };
    }

    window.TCCoastTiles = { get: get };
})();
