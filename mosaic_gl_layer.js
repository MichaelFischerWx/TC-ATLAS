/*
 * mosaic_gl_layer.js — single-channel brightness-INDEX mosaic as a MapLibre GL
 * custom layer (GPU forward-LUT recolor). Renders the cost-saving "idx" tiles
 * (1-channel PNG, value = quantized Tb) by uploading each tile as a GL texture
 * and colormapping in a fragment shader via a swappable 256-px LUT texture.
 *
 * Why: serving the index instead of a baked RGBA colormap is ~-67% Cloud Run→R2
 * egress (measured) with zero data-quality loss; recolor happens on the client
 * GPU (mobile-safe, instant colormap switch, exact-Tb hover from the index).
 * MapLibre 4.7.1 has no native raster-color, and color-relief needs 5.x — this
 * custom layer is the version-agnostic path (the cyclonicwx RasterCustomLayer
 * technique) applied to our XYZ tile pyramid (viewport-only downloads, animation
 * via per-frame texture sets).
 *
 * Usage:
 *   var ml = createMosaicGLLayer({
 *     id: 'ir-idx',
 *     tileUrl: function(frame,z,x,y){ return base+'/'+frame+'/'+z+'/'+x+'/'+y+'.png'; },
 *     frames: ['202606261430', ...],   // newest-last; setFrame(i) drives animation
 *     maxZoom: 6, tileSize: 512,
 *     lut: Uint8Array(256*4),          // initial colormap (RGBA per index)
 *   });
 *   map.addLayer(ml.layer[, beforeId]);
 *   ml.setFrame(i); ml.setColormap(uint8_1024); ml.setOpacity(0..1); ml.destroy();
 *
 * No data-loading is done until the layer is added (onAdd gets the gl context).
 */
(function () {
  'use strict';

  var VS =
    'attribute vec2 a_pos;uniform mat4 u_matrix;uniform vec2 u_origin;uniform float u_scale;' +
    'varying vec2 v_uv;void main(){vec2 m=u_origin+a_pos*u_scale;' +
    'gl_Position=u_matrix*vec4(m,0.0,1.0);v_uv=vec2(a_pos.x,1.0-a_pos.y);}';
  // MapLibre 5 path: render() gets an options object instead of a matrix, and
  // the vertex position must go through MapLibre's own projectTile() (from
  // shaderData.vertexShaderPrelude) so one shader serves both flat Mercator and
  // the globe. a_pos is the same 0..1 in-tile coordinate as above, but the
  // quad is a subdivided grid so tiles curve with the sphere.
  var VS5_BODY =
    'attribute vec2 a_pos;uniform vec2 u_origin;uniform float u_scale;' +
    'varying vec2 v_uv;void main(){vec2 m=u_origin+a_pos*u_scale;' +
    'gl_Position=projectTile(m);v_uv=vec2(a_pos.x,1.0-a_pos.y);}';
  var GRID_N = 16;   // cells per tile edge on the v5 mesh (512 triangles per tile draw)
  function gridMesh(n) {
    var a = [], d = 1 / n;
    for (var j = 0; j < n; j++) for (var i = 0; i < n; i++) {
      var x0 = i * d, y0 = j * d, x1 = x0 + d, y1 = y0 + d;
      a.push(x0, y0, x1, y0, x0, y1,  x1, y0, x1, y1, x0, y1);
    }
    return new Float32Array(a);
  }
  var FS =
    'precision mediump float;uniform sampler2D u_idx;uniform sampler2D u_lut;' +
    'uniform sampler2D u_idx2;uniform sampler2D u_lut2;' +  // combo: second band (Vis idx) + its LUT
    'uniform float u_opacity;uniform float u_combo;varying vec2 v_uv;' +
    'void main(){float v=texture2D(u_idx,v_uv).r;' +       // R channel = idx/255 (grayscale tile)
    'if(u_combo<0.5){' +
    'if(v<0.0019)discard;' +                                // idx 0 = no-data sentinel → transparent
    'vec4 c=texture2D(u_lut,vec2((v*255.0+0.5)/256.0,0.5));' +  // exact texel center → LUT[idx], no sentinel bleed
    'float a=c.a*u_opacity;' +
    'gl_FragColor=vec4(c.rgb*a,a);return;}' +               // PREMULTIPLIED — MapLibre's framebuffer is
    // ── sandwich/combo path: Vis luminance × cold-top IR color ──
    // u_lut here is the ALPHA-RAMPED IR LUT (alpha 0 warm → 1 cold, rgb =
    // full IR colormap everywhere). Night/no-Vis pixels (idx2 sentinel 0,
    // or the 1x1 black fallback texture) render as plain IR colormap.
    'float v2=texture2D(u_idx2,v_uv).r;' +
    'if(v<0.0019&&v2<0.0019)discard;' +
    'vec4 c=texture2D(u_lut,vec2((v*255.0+0.5)/256.0,0.5));' +
    'vec3 rgb;' +
    'if(v2<0.0019){' +
    'if(v<0.0019)discard;' +
    'rgb=c.rgb;' +                                          // night side: plain IR colors
    '}else{' +
    'float lum=texture2D(u_lut2,vec2((v2*255.0+0.5)/256.0,0.5)).r;' +
    'float ca=(v<0.0019)?0.0:c.a;' +
    'rgb=mix(vec3(lum),c.rgb*(0.35+0.65*lum),ca);' +        // luminance-modulated cold-top color
    '}' +
    'gl_FragColor=vec4(rgb*u_opacity,u_opacity);}';

  function compile(gl, type, src, onErr) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && onErr) onErr('shader: ' + gl.getShaderInfoLog(s));
    return s;
  }

  window.createMosaicGLLayer = function (opts) {
    var tileSize = opts.tileSize || 512;
    var maxZoom = (opts.maxZoom != null) ? opts.maxZoom : 6;
    // Zoom up to which tiles cover the WHOLE globe (gapless). Above it, only sparse
    // detail (e.g. storm sectors) exists, so we draw a base at min(z, baseMaxZoom)
    // UNDER the detail — the base fills the gaps where detail tiles don't exist.
    var baseMaxZoom = (opts.baseMaxZoom != null) ? opts.baseMaxZoom : maxZoom;
    var minZoom = opts.minZoom || 0;
    var baseMaxTiles = opts.maxCachedTiles || 700;  // floor for the LRU bound
    // Grown in setFrame to fit the whole loop's viewport working set (see the
    // frame-ready gate below). Hard ceiling: 2400 LUMINANCE 512² textures ≈
    // 600 MiB GPU — beyond that, bounded memory wins over loop smoothness.
    var maxTiles = baseMaxTiles;
    var HARD_MAX_TILES = 2400;
    var onErr = opts.onError || function (m) { try { console.error('[mosaicGL] ' + m); } catch (e) {} };
    // Optional async tile source (packed-frame range reads). Resolves a Blob, or
    // null when the tile definitively doesn't exist (cached as a miss — no
    // re-request). Without it, tiles load via a plain <img> as before.
    var fetchTile = opts.fetchTile || null;
    // Optional per-frame detail cap (e.g. Vis frames with a baked z7 storm
    // sector go past z6; other frames don't) — clamps the render zoom per frame.
    var frameMaxZoom = opts.frameMaxZoom || null;
    // Optional per-frame gapless zoom (e.g. 5 for global-z5 frames): raises the
    // base level for that frame so z6+ draws z5 under the storm sectors.
    var frameBaseMaxZoom = opts.frameBaseMaxZoom || null;
    function baseZoomFor(frame, z) {
      var b = baseMaxZoom;
      if (frameBaseMaxZoom && frame) {
        var c = frameBaseMaxZoom(frame);
        if (c != null && c > b) b = c;
      }
      return Math.min(z, b);
    }
    // Combo ("sandwich") mode: a second band (Vis idx) is sampled alongside the
    // primary. pairFrame(frame) → the second band's frame id (or null = none,
    // e.g. night); tileUrl2/fetchTile2 fetch its tiles; lut2 maps its idx to
    // luminance. The primary LUT should carry a cold-only alpha ramp.
    var pairFrame = opts.pairFrame || null;
    var comboMode = !!(pairFrame && (opts.tileUrl2 || opts.fetchTile2));

    var frames = opts.frames ? opts.frames.slice() : [];
    var active = frames.length ? frames[frames.length - 1] : null;
    var opacity = (opts.opacity != null) ? opts.opacity : 1.0;

    var map = null, gl = null, prog = null, buf = null, loc = null, lutTex = null;
    var legacyLoc = null, gridBuf = null, v5Progs = {};   // v5: program per projection variant
    var lut2Tex = null, blackTex = null;     // combo: Vis LUT + 1x1 no-data fallback
    var pendingLut = opts.lut || null;       // applied on first render once gl exists
    var pendingLut2 = opts.lut2 || null;
    var tiles = {};                          // key "band|frame|z|x|y" -> {tex, used}
    var inflight = {};                       // key -> true while Image loading
    var useClock = 0;

    function tkey(f, z, x, y, band) { return (band || 0) + '|' + f + '|' + z + '|' + x + '|' + y; }

    function _lutParams() {
      // NEAREST: 256 discrete colors = exactly what v2 bakes, and (critically) no
      // interpolation toward the transparent idx-0 sentinel that washed out warm Tb.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    function makeLutTex() {
      lutTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, lutTex);
      var data = pendingLut || new Uint8Array(256 * 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      _lutParams();
      if (comboMode) {
        lut2Tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, lut2Tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                      pendingLut2 || new Uint8Array(256 * 4));
        _lutParams();
        // 1x1 idx-0 texture: bound as the second band when its tile is missing
        // (night side, not yet loaded) → shader takes the plain-IR path.
        blackTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, blackTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                      new Uint8Array([0, 0, 0, 255]));
        _lutParams();
      }
    }

    function uploadTex(key, img) {
      delete inflight[key];
      if (!gl) return;
      var tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      // LUMINANCE (1 byte/px): the tiles are grayscale and the shader reads only
      // .r — 4× less GPU memory than RGBA, which is what lets maxTiles hold a
      // whole zoomed-in loop resident.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);  // don't blur the index
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      tiles[key] = { tex: tex, used: ++useClock };
      evictIfNeeded();
      _pendingResolve(key);
      if (map) map.triggerRepaint();
      // First decoded tile of the session: the host can drop its
      // "loading imagery" placeholder now that pixels are on the way.
      if (!_firstTileFired && typeof opts.onFirstTile === 'function') {
        _firstTileFired = true;
        try { opts.onFirstTile(); } catch (e) { /* host callback — non-fatal */ }
      }
    }
    var _firstTileFired = false;

    function loadTile(frame, z, x, y, band) {
      band = band || 0;
      var key = tkey(frame, z, x, y, band);
      if (tiles[key] || inflight[key]) return;
      inflight[key] = true;
      var bandFetch = band ? (opts.fetchTile2 || null) : fetchTile;
      var bandUrl = band ? opts.tileUrl2 : opts.tileUrl;
      if (bandFetch) {
        bandFetch(frame, z, x, y).then(function (b) {
          if (b === null) {
            // Definitive miss (absent from the pack index): cache it so the
            // render loop never re-requests this tile.
            delete inflight[key];
            tiles[key] = { tex: null, used: ++useClock };
            _pendingResolve(key);
            return;
          }
          if (!b || !gl) { delete inflight[key]; return; }
          var u = URL.createObjectURL(b), img = new Image();
          img.onload = function () { uploadTex(key, img); URL.revokeObjectURL(u); };
          img.onerror = function () { delete inflight[key]; URL.revokeObjectURL(u); };
          img.src = u;
        }).catch(function () { delete inflight[key]; });
        return;
      }
      var img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = function () { uploadTex(key, img); };
      img.onerror = function () { delete inflight[key]; };  // empty/missing tile — skip
      img.src = bandUrl(frame, z, x, y);
    }

    function evictIfNeeded() {
      var keys = Object.keys(tiles);
      if (keys.length <= maxTiles) return;
      keys.sort(function (a, b) { return tiles[a].used - tiles[b].used; });
      var drop = keys.length - maxTiles;
      for (var i = 0; i < drop; i++) {
        var k = keys[i]; if (gl && tiles[k].tex) gl.deleteTexture(tiles[k].tex); delete tiles[k];
      }
    }

    // Visible canonical tile coords at zoom z from the current map bounds, with a
    // 1-tile margin. Handles antimeridian wrap by returning canonical x (mod n);
    // the renderer draws world copies so display wrap is covered.
    function visibleTiles(z) {
      var n = 1 << z, b = map.getBounds();
      var north = Math.min(85.0511, b.getNorth()), south = Math.max(-85.0511, b.getSouth());
      function ytile(lat) {
        var r = lat * Math.PI / 180;
        return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
      }
      var y0 = Math.max(0, Math.floor(ytile(north)) - 1);
      var y1 = Math.min(n - 1, Math.floor(ytile(south)) + 1);
      var west = b.getWest(), east = b.getEast();
      // span in tiles along x (can exceed n when zoomed out / wide retina viewport)
      var xwf = (west + 180) / 360 * n, xef = (east + 180) / 360 * n;
      if (xef < xwf) xef += n;                       // dateline-crossing bounds
      var x0 = Math.floor(xwf) - 1, x1 = Math.floor(xef) + 1;
      if (x1 - x0 + 1 >= n) { x0 = 0; x1 = n - 1; }   // whole world visible
      var out = [];
      for (var y = y0; y <= y1; y++)
        for (var x = x0; x <= x1; x++) {
          var cx = ((x % n) + n) % n;                 // canonical (mod n)
          out.push([cx, y]);
        }
      return out;
    }

    function pickZoom(frame) {
      var f = (frame != null) ? frame : active;
      var mz = maxZoom;
      if (frameMaxZoom && f) {
        var c = frameMaxZoom(f);
        if (c != null) mz = Math.min(mz, c);
      }
      var z = Math.round(map.getZoom());
      return Math.max(minZoom, Math.min(mz, z));
    }

    // Every tile the given frame needs for the current viewport: both pyramid
    // levels (coarse base + sharp), and the paired-Vis band in combo mode.
    // Each ref is [frame, z, x, y, band].
    function frameTileRefs(frame) {
      var z = pickZoom(frame), baseZ = baseZoomFor((frame != null) ? frame : active, z);
      var levels = (z > baseZ) ? [baseZ, z] : [baseZ];
      var pf = comboMode ? pairFrame(frame) : null;
      var out = [];
      for (var li = 0; li < levels.length; li++) {
        var vis = visibleTiles(levels[li]);
        for (var i = 0; i < vis.length; i++) {
          out.push([frame, levels[li], vis[i][0], vis[i][1], 0]);
          if (pf) out.push([pf, levels[li], vis[i][0], vis[i][1], 1]);
        }
      }
      return out;
    }

    // ── Frame-ready gate ──────────────────────────────────────────────────
    // setFrame() keeps the PREVIOUS frame on screen until every viewport tile
    // of the incoming frame is resolved (uploaded, or a cached known-miss), so
    // a swap never paints holes — the "white flash" between animation frames.
    // GATE_MS bounds the hold: an erroring/stuck tile flips the frame anyway
    // (worst case = the old behavior) rather than freezing playback.
    var GATE_MS = 400;
    var pending = null;   // { frame, keys: {tkey:1}, n, timer }
    function _clearPending() {
      if (pending && pending.timer) clearTimeout(pending.timer);
      pending = null;
    }
    function _flipPending() {
      if (!pending) return;
      active = pending.frame;
      _clearPending();
      if (map) map.triggerRepaint();
    }
    function _pendingResolve(key) {
      if (!pending || !pending.keys[key]) return;
      delete pending.keys[key];
      if (--pending.n <= 0) _flipPending();
    }

    var LOC_NAMES = ['u_matrix', 'u_origin', 'u_scale', 'u_idx', 'u_lut', 'u_opacity',
      'u_idx2', 'u_lut2', 'u_combo', 'u_projection_matrix', 'u_projection_fallback_matrix',
      'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition'];
    function _link(vsSrc) {
      var p = gl.createProgram();
      gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc, onErr));
      gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS, onErr));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { onErr('link: ' + gl.getProgramInfoLog(p)); return null; }
      var l = { a_pos: gl.getAttribLocation(p, 'a_pos') };
      LOC_NAMES.forEach(function (n) { l[n] = gl.getUniformLocation(p, n); });
      return { prog: p, loc: l };
    }
    function _legacyProgram() {
      if (!legacyLoc) legacyLoc = _link(VS);
      return legacyLoc;
    }
    function _v5Program(sd) {
      var key = sd.variantName || 'default';
      if (!(key in v5Progs)) {
        // define (e.g. "#define GLOBE") goes first so the prelude's #ifdefs see it.
        v5Progs[key] = _link((sd.define || '') + '\n' + sd.vertexShaderPrelude + '\n' + VS5_BODY);
      }
      if (!gridBuf) {
        gridBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
        gl.bufferData(gl.ARRAY_BUFFER, gridMesh(GRID_N), gl.STATIC_DRAW);
      }
      return v5Progs[key];
    }

    var layer = {
      id: opts.id || 'mosaic-idx',
      type: 'custom',
      ml5: true,   // handles MapLibre 5's render(gl, options) itself (lflet_gl skips its compat wrap)
      onAdd: function (m, gfx) {
        map = m; gl = gfx;
        // The legacy (MapLibre 4) program is built lazily on the first
        // matrix-style render, so a v5 page never compiles it.
        buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
        makeLutTex();
        // MapLibre calls onAdd on a later style pass, AFTER the caller's
        // setFrame()/setOpacity() (which saw no map and could not schedule a
        // repaint). Without this the first render -- and therefore the first
        // tile request -- waited for an unrelated repaint (a resize, a pan);
        // on the recon map that meant no IR until the phone's address bar
        // collapsed or the window changed size (2026-09-02, Lowell).
        try { m.triggerRepaint(); } catch (e) {}
      },
      render: function (gfx, arg) {
        if (!gl || !active) return;
        // MapLibre 4 passes the Mercator→clip matrix; MapLibre 5 passes an
        // options object carrying the projection prelude + its uniforms.
        var v5 = !!(arg && arg.shaderData && arg.defaultProjectionData);
        var P = v5 ? _v5Program(arg.shaderData) : _legacyProgram();
        if (!P) return;
        prog = P.prog; loc = P.loc;
        var z = pickZoom();
        var baseZ = baseZoomFor(active, z);
        // Coarse base (gapless) first, then sparse detail (storm sectors) on top.
        var levels = (z > baseZ) ? [baseZ, z] : [baseZ];
        // A frame whose base is raised (global z5) would show holes while its z5
        // tiles stream in, where the regular base (z4) used to be on screen at
        // once. So the regular base level is also painted underneath — from
        // tiles ALREADY in the cache only (never fetched), and only where a
        // visible raised-base child is still unresolved.
        var cacheOnlyZ = -1, baseVisSet = null;
        var regularZ = Math.min(z, baseMaxZoom);
        if (regularZ < baseZ && !comboMode) {
          cacheOnlyZ = regularZ;
          levels.unshift(regularZ);
          baseVisSet = {};
          var bv = visibleTiles(baseZ);
          for (var bi = 0; bi < bv.length; bi++) baseVisSet[bv[bi][0] + '/' + bv[bi][1]] = 1;
        }

        var pf = comboMode ? pairFrame(active) : null;   // paired Vis frame (null = none)

        gl.useProgram(prog);
        var nVerts = 4, mode = gl.TRIANGLE_STRIP, copies = [-1, 0, 1];
        if (v5) {
          var pd = arg.defaultProjectionData;
          gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
          nVerts = GRID_N * GRID_N * 6; mode = gl.TRIANGLES;
          gl.uniformMatrix4fv(loc.u_projection_matrix, false, pd.mainMatrix);
          gl.uniformMatrix4fv(loc.u_projection_fallback_matrix, false, pd.fallbackMatrix);
          gl.uniform4f(loc.u_projection_tile_mercator_coords, pd.tileMercatorCoords[0], pd.tileMercatorCoords[1], pd.tileMercatorCoords[2], pd.tileMercatorCoords[3]);
          gl.uniform4f(loc.u_projection_clipping_plane, pd.clippingPlane[0], pd.clippingPlane[1], pd.clippingPlane[2], pd.clippingPlane[3]);
          gl.uniform1f(loc.u_projection_transition, pd.projectionTransition);
          // On the sphere x wraps by itself (sin/cos of longitude), so the
          // neighbor world copies would land on the same spot and blend twice.
          if (pd.projectionTransition > 0) copies = [0];
        } else {
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.uniformMatrix4fv(loc.u_matrix, false, arg);
        }
        gl.enableVertexAttribArray(loc.a_pos);
        gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 0, 0);
        gl.uniform1f(loc.u_opacity, opacity);
        gl.uniform1f(loc.u_combo, comboMode ? 1.0 : 0.0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lutTex); gl.uniform1i(loc.u_lut, 1);
        if (comboMode) {
          gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, lut2Tex); gl.uniform1i(loc.u_lut2, 3);
        }
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);  // premultiplied (keeps fb alpha=1)
        gl.disable(gl.DEPTH_TEST);

        for (var li = 0; li < levels.length; li++) {
          var lz = levels[li], n = 1 << lz, s = 1.0 / n;
          var vis = visibleTiles(lz);
          var cacheOnly = (lz === cacheOnlyZ);
          for (var i = 0; i < vis.length && !cacheOnly; i++) {
            loadTile(active, lz, vis[i][0], vis[i][1]);
            if (pf) loadTile(pf, lz, vis[i][0], vis[i][1], 1);
          }
          gl.uniform1f(loc.u_scale, s);
          for (var j = 0; j < vis.length; j++) {
            var cx = vis[j][0], cy = vis[j][1], rec = tiles[tkey(active, lz, cx, cy)];
            if (rec) rec.used = ++useClock;
            if (!rec || !rec.tex) continue;               // not loaded / known-absent → coarser base shows through
            if (cacheOnly) {
              // Only while a visible child at the raised base is unresolved —
              // once they are in, the stand-in stops (no double draw).
              var d = 1 << (baseZ - lz), pending = false;
              for (var cyy = 0; cyy < d && !pending; cyy++)
                for (var cxx = 0; cxx < d && !pending; cxx++) {
                  var kx = cx * d + cxx, ky = cy * d + cyy;
                  if (baseVisSet[kx + '/' + ky] && !tiles[tkey(active, baseZ, kx, ky)]) pending = true;
                }
              if (!pending) continue;
            }
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rec.tex); gl.uniform1i(loc.u_idx, 0);
            if (comboMode) {
              var rec2 = pf ? tiles[tkey(pf, lz, cx, cy, 1)] : null;
              if (rec2) rec2.used = ++useClock;
              gl.activeTexture(gl.TEXTURE2);
              gl.bindTexture(gl.TEXTURE_2D, (rec2 && rec2.tex) ? rec2.tex : blackTex);
              gl.uniform1i(loc.u_idx2, 2);
            }
            // draw in the primary world + both neighbor copies (antimeridian display wrap)
            for (var ci = 0; ci < copies.length; ci++) {
              gl.uniform2f(loc.u_origin, cx * s + copies[ci], cy * s);
              gl.drawArrays(mode, 0, nVerts);
            }
          }
        }
      },
      onRemove: function () {
        _clearPending();
        if (!gl) return;
        Object.keys(tiles).forEach(function (k) { if (tiles[k].tex) gl.deleteTexture(tiles[k].tex); });
        tiles = {}; inflight = {};
        if (lutTex) gl.deleteTexture(lutTex);
        if (lut2Tex) gl.deleteTexture(lut2Tex);
        if (blackTex) gl.deleteTexture(blackTex);
        if (buf) gl.deleteBuffer(buf);
        if (gridBuf) gl.deleteBuffer(gridBuf);
        if (legacyLoc) gl.deleteProgram(legacyLoc.prog);
        Object.keys(v5Progs).forEach(function (k) { if (v5Progs[k]) gl.deleteProgram(v5Progs[k].prog); });
        legacyLoc = null; gridBuf = null; v5Progs = {}; prog = null;
        gl = null; map = null;
      }
    };

    return {
      layer: layer,
      setFrame: function (i) {
        if (i < 0 || i >= frames.length) return;
        var target = frames[i];
        if (!map || !gl) { _clearPending(); active = target; return; }

        var refs = frameTileRefs(target);
        // Grow the LRU bound to fit the whole loop's viewport working set —
        // with LRU + cyclic playback, a cap below the working set evicts
        // exactly the frames coming up next, so every pass re-fetched and
        // re-uploaded every tile (the flash-on-every-loop bug).
        maxTiles = Math.min(HARD_MAX_TILES,
                            Math.max(baseMaxTiles, refs.length * frames.length + 64));

        var missing = {}, n = 0;
        for (var r = 0; r < refs.length; r++) {
          var t = refs[r], key = tkey(t[0], t[1], t[2], t[3], t[4]);
          if (!tiles[key]) {
            loadTile(t[0], t[1], t[2], t[3], t[4]);
            missing[key] = 1; n++;
          }
        }
        // prefetch the following frame (both levels + combo band) so steady
        // playback stays ahead of the gate
        var nf = frames[i + 1] || frames[i - 1];
        if (nf) {
          var nrefs = frameTileRefs(nf);
          for (var p = 0; p < nrefs.length; p++) {
            loadTile(nrefs[p][0], nrefs[p][1], nrefs[p][2], nrefs[p][3], nrefs[p][4]);
          }
        }

        _clearPending();
        if (!n) { active = target; map.triggerRepaint(); return; }
        pending = { frame: target, keys: missing, n: n, timer: setTimeout(_flipPending, GATE_MS) };
      },
      setFrames: function (arr) {
        frames = arr.slice();
        if (frames.indexOf(active) < 0) active = frames[frames.length - 1] || null;
        if (pending && frames.indexOf(pending.frame) < 0) _clearPending();
        if (map) map.triggerRepaint();
      },
      setColormap: function (u8) {
        pendingLut = u8;
        if (gl && lutTex) {
          gl.bindTexture(gl.TEXTURE_2D, lutTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, u8);
          if (map) map.triggerRepaint();
        }
      },
      setOpacity: function (o) { opacity = o; if (map) map.triggerRepaint(); },
      currentFrame: function () { return active; },
      frameCount: function () { return frames.length; },
      stats: function () { return { cached: Object.keys(tiles).length, inflight: Object.keys(inflight).length, frames: frames.length, maxTiles: maxTiles, pendingTiles: pending ? pending.n : 0 }; },
      destroy: function () { if (map && map.getLayer(layer.id)) map.removeLayer(layer.id); }
    };
  };
})();
