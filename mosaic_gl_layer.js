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
  var FS =
    'precision mediump float;uniform sampler2D u_idx;uniform sampler2D u_lut;' +
    'uniform float u_opacity;varying vec2 v_uv;' +
    'void main(){float v=texture2D(u_idx,v_uv).r;' +       // R channel = idx/255 (grayscale tile)
    'if(v<0.0019)discard;' +                                // idx 0 = no-data sentinel → transparent
    'vec4 c=texture2D(u_lut,vec2((v*255.0+0.5)/256.0,0.5));' +  // exact texel center → LUT[idx], no sentinel bleed
    'float a=c.a*u_opacity;' +
    'gl_FragColor=vec4(c.rgb*a,a);}';                       // PREMULTIPLIED — MapLibre's framebuffer is

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
    var MAX_TILES = opts.maxCachedTiles || 700;   // LRU bound across frames/zooms
    var onErr = opts.onError || function (m) { try { console.error('[mosaicGL] ' + m); } catch (e) {} };

    var frames = opts.frames ? opts.frames.slice() : [];
    var active = frames.length ? frames[frames.length - 1] : null;
    var opacity = (opts.opacity != null) ? opts.opacity : 1.0;

    var map = null, gl = null, prog = null, buf = null, loc = null, lutTex = null;
    var pendingLut = opts.lut || null;       // applied on first render once gl exists
    var tiles = {};                          // key "frame|z|x|y" -> {tex, used}
    var inflight = {};                       // key -> true while Image loading
    var useClock = 0;

    function tkey(f, z, x, y) { return f + '|' + z + '|' + x + '|' + y; }

    function makeLutTex() {
      lutTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, lutTex);
      var data = pendingLut || new Uint8Array(256 * 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      // NEAREST: 256 discrete colors = exactly what v2 bakes, and (critically) no
      // interpolation toward the transparent idx-0 sentinel that washed out warm Tb.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    function loadTile(frame, z, x, y) {
      var key = tkey(frame, z, x, y);
      if (tiles[key] || inflight[key]) return;
      inflight[key] = true;
      var img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = function () {
        delete inflight[key];
        if (!gl) return;
        var tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);  // don't blur the index
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        tiles[key] = { tex: tex, used: ++useClock };
        evictIfNeeded();
        if (map) map.triggerRepaint();
      };
      img.onerror = function () { delete inflight[key]; };  // empty/missing tile — skip
      img.src = opts.tileUrl(frame, z, x, y);
    }

    function evictIfNeeded() {
      var keys = Object.keys(tiles);
      if (keys.length <= MAX_TILES) return;
      keys.sort(function (a, b) { return tiles[a].used - tiles[b].used; });
      var drop = keys.length - MAX_TILES;
      for (var i = 0; i < drop; i++) {
        var k = keys[i]; if (gl) gl.deleteTexture(tiles[k].tex); delete tiles[k];
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

    function pickZoom() {
      var z = Math.round(map.getZoom());
      return Math.max(minZoom, Math.min(maxZoom, z));
    }

    var layer = {
      id: opts.id || 'mosaic-idx',
      type: 'custom',
      onAdd: function (m, gfx) {
        map = m; gl = gfx;
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS, onErr));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS, onErr));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) onErr('link: ' + gl.getProgramInfoLog(prog));
        loc = {
          a_pos: gl.getAttribLocation(prog, 'a_pos'),
          u_matrix: gl.getUniformLocation(prog, 'u_matrix'),
          u_origin: gl.getUniformLocation(prog, 'u_origin'),
          u_scale: gl.getUniformLocation(prog, 'u_scale'),
          u_idx: gl.getUniformLocation(prog, 'u_idx'),
          u_lut: gl.getUniformLocation(prog, 'u_lut'),
          u_opacity: gl.getUniformLocation(prog, 'u_opacity')
        };
        buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
        makeLutTex();
      },
      render: function (gfx, matrix) {
        if (!prog || !active) return;
        var z = pickZoom();
        var baseZ = Math.min(z, baseMaxZoom);
        // Coarse base (gapless) first, then sparse detail (storm sectors) on top.
        var levels = (z > baseZ) ? [baseZ, z] : [baseZ];

        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(loc.a_pos);
        gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(loc.u_matrix, false, matrix);
        gl.uniform1f(loc.u_opacity, opacity);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lutTex); gl.uniform1i(loc.u_lut, 1);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);  // premultiplied (keeps fb alpha=1)
        gl.disable(gl.DEPTH_TEST);

        for (var li = 0; li < levels.length; li++) {
          var lz = levels[li], n = 1 << lz, s = 1.0 / n;
          var vis = visibleTiles(lz);
          for (var i = 0; i < vis.length; i++) loadTile(active, lz, vis[i][0], vis[i][1]);
          gl.uniform1f(loc.u_scale, s);
          for (var j = 0; j < vis.length; j++) {
            var cx = vis[j][0], cy = vis[j][1], rec = tiles[tkey(active, lz, cx, cy)];
            if (!rec) continue;                           // not loaded yet → coarser base shows through
            rec.used = ++useClock;
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rec.tex); gl.uniform1i(loc.u_idx, 0);
            // draw in the primary world + both neighbor copies (antimeridian display wrap)
            for (var k = -1; k <= 1; k++) {
              gl.uniform2f(loc.u_origin, cx * s + k, cy * s);
              gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }
          }
        }
      },
      onRemove: function () {
        if (!gl) return;
        Object.keys(tiles).forEach(function (k) { gl.deleteTexture(tiles[k].tex); });
        tiles = {}; inflight = {};
        if (lutTex) gl.deleteTexture(lutTex);
        if (buf) gl.deleteBuffer(buf);
        if (prog) gl.deleteProgram(prog);
        gl = null; map = null;
      }
    };

    return {
      layer: layer,
      setFrame: function (i) {
        if (i < 0 || i >= frames.length) return;
        active = frames[i];
        if (map) {
          // prefetch the next frame's visible tiles so playback doesn't stall
          var nf = frames[i + 1] || frames[i - 1];
          if (nf && gl) { var z = pickZoom(); visibleTiles(z).forEach(function (t) { loadTile(nf, z, t[0], t[1]); }); }
          map.triggerRepaint();
        }
      },
      setFrames: function (arr) { frames = arr.slice(); if (frames.indexOf(active) < 0) active = frames[frames.length - 1] || null; if (map) map.triggerRepaint(); },
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
      stats: function () { return { cached: Object.keys(tiles).length, inflight: Object.keys(inflight).length, frames: frames.length }; },
      destroy: function () { if (map && map.getLayer(layer.id)) map.removeLayer(layer.id); }
    };
  };
})();
