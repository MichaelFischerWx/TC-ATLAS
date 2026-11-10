/**
 * globe_light.js — sun, moon and night lighting for the Global Map's globe view.
 *
 * Loaded on demand the first time the globe is turned on (realtime_ir.js),
 * so the flat map never pays for it.
 *
 *   GlobeLight.bodies(date) → { sun: {lat, lon, vec}, moon: {lat, lon, vec,
 *                               illum, waxing} }      (sub-solar / sub-lunar points)
 *   GlobeLight.atmosphereLight(sunVec) → MapLibre light spec that points the
 *                               globe atmosphere's sun at sunVec
 *   GlobeLight.createLayer({ id, lightsTileUrl, lightsZoom, lightsMaxZoom }) → controller:
 *       .layer               MapLibre 5 custom layer (add with map._glAdd)
 *       .setBodies(b)        sun/moon from bodies()
 *       .setOptions({night, lights})
 *       .destroy()
 *
 * Vectors use MapLibre's globe frame: x = sin(lon)cos(lat), y = sin(lat),
 * z = cos(lon)cos(lat) — the same frame projectToSphere() builds.
 *
 * Positions: low-precision formulas (Astronomical Almanac / Meeus style):
 * sun to ~0.01°, moon to ~0.3°, far below a pixel on a whole-globe view.
 */
(function () {
  'use strict';

  var RAD = Math.PI / 180;
  var OBLIQ = 23.4397 * RAD;

  function daysJ2000(date) { return date.getTime() / 86400000 + 2440587.5 - 2451545.0; }
  function wrap180(d) { d = ((d + 180) % 360 + 360) % 360 - 180; return d; }
  function eclToEq(lam, beta) {   // ecliptic (rad) → {ra, dec} (rad)
    return {
      ra: Math.atan2(Math.sin(lam) * Math.cos(OBLIQ) - Math.tan(beta) * Math.sin(OBLIQ), Math.cos(lam)),
      dec: Math.asin(Math.sin(beta) * Math.cos(OBLIQ) + Math.cos(beta) * Math.sin(OBLIQ) * Math.sin(lam))
    };
  }
  function gmstDeg(d) { return 280.46061837 + 360.98564736629 * d; }
  function vecOf(lat, lon) {
    var la = lat * RAD, lo = lon * RAD;
    return [Math.sin(lo) * Math.cos(la), Math.sin(la), Math.cos(lo) * Math.cos(la)];
  }
  function subPoint(eq, d) {
    var lat = eq.dec / RAD;
    var lon = wrap180(eq.ra / RAD - gmstDeg(d));
    return { lat: lat, lon: lon, vec: vecOf(lat, lon) };
  }

  function sunEcl(d) {
    var M = (357.5291 + 0.98560028 * d) * RAD;
    var C = (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * RAD;
    return M + C + (102.9372 * RAD) + Math.PI;          // ecliptic longitude
  }
  function moonEcl(d) {
    var L = (218.316 + 13.176396 * d) * RAD;            // mean longitude
    var M = (134.963 + 13.064993 * d) * RAD;            // mean anomaly
    var F = (93.272 + 13.229350 * d) * RAD;             // argument of latitude
    return { lam: L + 6.289 * RAD * Math.sin(M), beta: 5.128 * RAD * Math.sin(F) };
  }

  function bodies(date) {
    var d = daysJ2000(date);
    var sLam = sunEcl(d), sEq = eclToEq(sLam, 0);
    var m = moonEcl(d), mEq = eclToEq(m.lam, m.beta);
    var sun = subPoint(sEq, d), moon = subPoint(mEq, d);
    // Illuminated fraction from the sun–moon elongation (geocentric; the
    // ~0.15° parallax correction is irrelevant here).
    var cosE = Math.sin(sEq.dec) * Math.sin(mEq.dec) + Math.cos(sEq.dec) * Math.cos(mEq.dec) * Math.cos(sEq.ra - mEq.ra);
    var elong = Math.acos(Math.max(-1, Math.min(1, cosE)));
    moon.illum = (1 - Math.cos(elong)) / 2;
    moon.waxing = wrap180((m.lam - sLam) / RAD) > 0;
    var gmst = ((gmstDeg(d) % 360) + 360) % 360;
    return { sun: sun, moon: moon, date: date, gmst: gmst * RAD };   // gmst: radians, turns sky (RA) into the globe frame
  }

  // MapLibre's atmosphere uses u_sun_pos = -cartesian(light.position), rotated
  // into view space when anchor is 'map' — i.e. light.position is the
  // ANTI-sun direction in the globe frame. cartesian([r, a, p]) =
  // (r cos(a+90°) sin p, r sin(a+90°) sin p, r cos p).
  function atmosphereLight(sunVec) {
    var x = -sunVec[0], y = -sunVec[1], z = -sunVec[2];
    var polar = Math.acos(Math.max(-1, Math.min(1, z))) / RAD;
    var az = Math.atan2(y, x) / RAD - 90;
    return { anchor: 'map', position: [1.15, az, polar], color: '#ffffff', intensity: 0.5 };
  }

  // ── night-side layer ─────────────────────────────────────────────────────
  // One pass over a whole-world mesh in Mercator 0..1 coordinates, drawn
  // through MapLibre's projectTile() so it sits exactly on the globe.
  // Fragment: solar elevation from the per-pixel unit vector → twilight ramp →
  // premultiplied output (rgb = night tint + city lights, a = darkening).
  // City lights come from two textures: a whole-world base and, once zoomed
  // in, a sharper 8×8-tile patch around the view (u_pb = x0, y0, 2^z, 8).
  var VS_BODY =
    'attribute vec2 a_pos;varying vec2 v_merc;' +
    'void main(){v_merc=a_pos;gl_Position=projectTile(a_pos);}';
  var FS =
    'precision highp float;varying vec2 v_merc;' +
    'uniform vec3 u_sun;uniform vec3 u_moon;uniform float u_moon_illum;' +
    'uniform float u_night;uniform float u_lights_on;uniform sampler2D u_lights;' +
    'uniform float u_patch_on;uniform sampler2D u_patch;uniform vec4 u_pb;uniform vec3 u_floor;' +
    'const float PI=3.141592653589793;' +
    'void main(){' +
    'float lon=v_merc.x*2.0*PI-PI;' +
    'float lat=2.0*atan(exp(PI-v_merc.y*2.0*PI))-0.5*PI;' +
    'vec3 n=vec3(sin(lon)*cos(lat),sin(lat),cos(lon)*cos(lat));' +
    'float mu=dot(n,u_sun);' +                                   // sin(solar elevation)
    // 0 in daylight (sun > +1°), 1 past nautical dusk (sun < -12°).
    'float dark=1.0-smoothstep(-0.2079,0.0175,mu);' +
    'float lightsMask=1.0-smoothstep(-0.1045,-0.0349,mu);' +    // lights from sun < -2°, full by -6°
    // Moonlight lifts the night side under a high, bright moon.
    'float moonUp=clamp(dot(n,u_moon)*2.0,0.0,1.0)*u_moon_illum;' +
    'float a=dark*u_night*(1.0-0.30*moonUp);' +
    'vec3 tint=mix(vec3(0.0,0.012,0.045),vec3(0.03,0.04,0.06),moonUp)*a;' +
    'vec3 city=vec3(0.0);' +
    'if(u_lights_on>0.5&&lightsMask>0.0){vec3 L=texture2D(u_lights,v_merc).rgb;' +
    'if(u_patch_on>0.5){float px=v_merc.x*u_pb.z-u_pb.x;px-=u_pb.z*floor(px/u_pb.z);' +
    'float py=v_merc.y*u_pb.z-u_pb.y;' +
    'if(px<u_pb.w&&py>=0.0&&py<u_pb.w)L=texture2D(u_patch,vec2(px,py)/u_pb.w).rgb;}' +
    // Drop the imagery's dark background (and Black Marble's faint moonlit
    // land) so only the lights add — a tile still loading can't show as a box.
    'L=max(L-u_floor,0.0);' +
    'city=pow(L,vec3(1.45))*vec3(1.0,0.82,0.55)*2.0*lightsMask*u_night;}' +
    'gl_FragColor=vec4(tint+city,a);}';

  // Dense in latitude: texture coordinates interpolate linearly across each
  // triangle while Mercator y → latitude is not linear, so tall cells would
  // shift zoomed-in lights by kilometres (~4 km at 64 rows, ~0.25 km at 256).
  var MESH_X = 96, MESH_Y = 256;
  function worldMesh() {
    var a = new Float32Array(MESH_X * MESH_Y * 12), k = 0, dx = 1 / MESH_X, dy = 1 / MESH_Y;
    for (var j = 0; j < MESH_Y; j++) for (var i = 0; i < MESH_X; i++) {
      var x0 = i * dx, y0 = j * dy, x1 = x0 + dx, y1 = y0 + dy;
      a[k++] = x0; a[k++] = y0; a[k++] = x1; a[k++] = y0; a[k++] = x0; a[k++] = y1;
      a[k++] = x1; a[k++] = y0; a[k++] = x1; a[k++] = y1; a[k++] = x0; a[k++] = y1;
    }
    return a;
  }

  function compile(gl, type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('[globeLight] shader: ' + gl.getShaderInfoLog(s));
    return s;
  }

  // Tile centre / corners → unit vectors, for "is any of this tile at night"
  // and "does it face the camera" (load order).
  function tileVecs(z, x, y) {
    var n = 1 << z, out = [];
    [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]].forEach(function (f) {
      var mx = (x + f[0]) / n, my = (y + f[1]) / n;
      var lon = mx * 360 - 180, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) / RAD;
      out.push(vecOf(lat, lon));
    });
    return out;
  }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  function createLayer(opts) {
    opts = opts || {};
    var map = null, gl = null, meshBuf = null, nVerts = 0, progs = {};
    var sun = [0, 0, 1], moon = [0, 0, -1], moonIllum = 0;
    var nightOn = true, lightsOn = true;
    var NIGHT_STRENGTH = (opts.nightStrength != null) ? opts.nightStrength : 0.62;
    var FLOOR = opts.lightsFloor || [0.045, 0.055, 0.095];
    var BG = opts.lightsBackground || 'rgb(4,5,15)';
    var BASE_Z = opts.lightsZoom != null ? opts.lightsZoom : 3;
    var MAX_Z = opts.lightsMaxZoom != null ? opts.lightsMaxZoom : 8;
    var T = 256, PATCH = 8;

    function prog(sd) {
      var key = sd.variantName || 'default';
      if (progs[key]) return progs[key];
      var p = gl.createProgram();
      gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, (sd.define || '') + '\n' + sd.vertexShaderPrelude + '\n' + VS_BODY));
      gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error('[globeLight] link: ' + gl.getProgramInfoLog(p)); progs[key] = null; return null; }
      var loc = { a_pos: gl.getAttribLocation(p, 'a_pos') };
      ['u_projection_matrix', 'u_projection_fallback_matrix', 'u_projection_tile_mercator_coords',
       'u_projection_clipping_plane', 'u_projection_transition', 'u_sun', 'u_moon', 'u_moon_illum',
       'u_night', 'u_lights_on', 'u_lights', 'u_patch_on', 'u_patch', 'u_pb', 'u_floor'].forEach(function (n) { loc[n] = gl.getUniformLocation(p, n); });
      progs[key] = { prog: p, loc: loc };
      return progs[key];
    }

    // ── tile fetching (shared by the base and the zoom patch) ──
    // GIBS intermittently rejects requests in a burst (the browser sees a CORS
    // failure; a missing 45°×41° box over the eastern US on 2026-11-10), so:
    // at most 6 in flight, retries with backoff, and a sweep for stragglers.
    // The queue is re-sorted on every pump: night-side tiles facing the camera
    // first, so the lights you can see arrive before the rest of the world.
    var queue = [], active = 0, MAX_INFLIGHT = 6, gen = 0;
    function camVec() {
      try { var c = map.getCenter(); return vecOf(c.lat, c.lng); } catch (e) { return [0, 0, 1]; }
    }
    function tileNight(z, x, y) {
      var v = tileVecs(z, x, y);
      for (var i = 0; i < v.length; i++) if (dot3(v[i], sun) < 0.05) return true;
      return false;
    }
    function rank(j) {
      if (j.rank0 == null) return 0;
      var v = tileVecs(j.z, j.x, j.y)[0];
      return j.rank0 + (tileNight(j.z, j.x, j.y) ? 0 : 100) - dot3(v, camVec()) * 10;
    }
    function fetchTile(j) {
      j.tries = 0;
      queue.push(j);
      pump();
    }
    function pump() {
      if (!queue.length || active >= MAX_INFLIGHT) return;
      queue.sort(function (a, b) { return rank(a) - rank(b); });
      while (active < MAX_INFLIGHT && queue.length) (function (j) {
        if (j.stale && j.stale()) return;
        active++; j.tries++;
        var img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = function () { active--; j.done(img); pump(); };
        img.onerror = function () {
          active--;
          if (j.tries < 4) setTimeout(function () { queue.push(j); pump(); }, 500 * Math.pow(3, j.tries - 1));   // 0.5, 1.5, 4.5 s
          else if (!j.swept) { j.swept = true; j.tries = 0; setTimeout(function () { queue.push(j); pump(); }, 20000); }
          pump();
        };
        img.src = opts.lightsTileUrl(j.z, j.x, j.y);
      })(queue.shift());
    }

    function makeTex() {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    function uploadCanvas(tex, canvas) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // MapLibre may leave these set by its own uploads.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, canvas);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    // ── base: one Mercator world texture (z3 = 8×8 tiles = 2048 px) ──
    // A quick z2 pass (16 tiles, drawn 2× into the same canvas) lands first so
    // the lights show as soon as they used to; z3 tiles then sharpen it.
    var base = null;   // {canvas, ctx, tex, ready, done3: {}, upT}
    function baseUploadSoon() {
      if (base.upT) return;
      base.upT = setTimeout(function () {
        base.upT = null;
        if (!gl) return;
        if (!base.tex) base.tex = makeTex();
        uploadCanvas(base.tex, base.canvas);
        base.ready = true;
        if (map) map.triggerRepaint();
      }, base.ready ? 600 : 150);
    }
    function loadLights() {
      if (base || !opts.lightsTileUrl) return;
      var n = 1 << BASE_Z, px = n * T;
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = px;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = BG; ctx.fillRect(0, 0, px, px);
      base = { canvas: canvas, ctx: ctx, tex: null, ready: false, done: {}, upT: null };
      var b = base, zq = BASE_Z - 1, nq = 1 << zq;
      if (zq >= 0) for (var y = 0; y < nq; y++) for (var x = 0; x < nq; x++) (function (x, y) {
        fetchTile({ z: zq, x: x, y: y, rank0: -1000, stale: function () { return b !== base; }, done: function (img) {
          if (b !== base) return;
          // Each quick tile covers 2×2 base tiles; skip any already sharp.
          for (var q = 0; q < 4; q++) {
            var cx = x * 2 + (q & 1), cy = y * 2 + (q >> 1);
            if (b.done[cx + ',' + cy]) continue;
            try { b.ctx.drawImage(img, (q & 1) * 128, (q >> 1) * 128, 128, 128, cx * T, cy * T, T, T); } catch (e) {}
          }
          baseUploadSoon();
        } });
      })(x, y);
      for (var y2 = 0; y2 < n; y2++) for (var x2 = 0; x2 < n; x2++) (function (x, y) {
        fetchTile({ z: BASE_Z, x: x, y: y, rank0: 0, stale: function () { return b !== base; }, done: function (img) {
          if (b !== base) return;
          b.done[x + ',' + y] = true;
          try { b.ctx.drawImage(img, x * T, y * T, T, T); } catch (e) {}
          baseUploadSoon();
          // A patch built before this tile landed is still showing the blur.
          if (patch) refillPatchFromBase(x, y);
        } });
      })(x2, y2);
    }

    // ── zoom patch: 8×8 tiles at the zoom that matches the screen ──
    // Re-centred around the view while the camera moves (throttled) and when
    // it settles. Night-side tiles only — daytime ones would never show.
    // A rebuilt window is filled from the sharpest pixels already in hand
    // (that tile, a cached parent or children, else the base) and uploaded in
    // the SAME task that moves the window, so the shader never pairs the new
    // position with the old image (that mismatch made lights jump or blank).
    var patch = null;   // {z, x0, y0, canvas, ctx, tex, upT, have: {}, queued: {}}
    var cache = {}, cacheKeys = [], CACHE_MAX = 192;
    function cachePut(k, img) {
      if (!cache[k]) { cacheKeys.push(k); if (cacheKeys.length > CACHE_MAX) delete cache[cacheKeys.shift()]; }
      cache[k] = img;
    }
    function patchUploadNow(p) {
      if (!gl || p !== patch) return;
      if (p.upT) { clearTimeout(p.upT); p.upT = null; }
      if (!p.tex) p.tex = makeTex();
      uploadCanvas(p.tex, p.canvas);
      p.ready = true;
      if (map) map.triggerRepaint();
    }
    function patchUploadSoon() {
      if (!patch || patch.upT) return;
      var p = patch;
      p.upT = setTimeout(function () { p.upT = null; patchUploadNow(p); }, 120);
    }
    // Best pixels for patch tile (i, j) without fetching: the tile itself,
    // else an ancestor (scaled up), else all four children (scaled down),
    // else the base. Returns true only for the tile itself (= sharp).
    function patchFill(p, i, j) {
      var nz = 1 << p.z, tx = ((p.x0 + i) % nz + nz) % nz, ty = p.y0 + j, dx = i * T, dy = j * T;
      var own = cache[p.z + '/' + tx + '/' + ty];
      if (own) { try { p.ctx.drawImage(own, dx, dy, T, T); } catch (e) {} return true; }
      for (var k = 1; p.z - k > BASE_Z && k <= 4; k++) {
        var par = cache[(p.z - k) + '/' + (tx >> k) + '/' + (ty >> k)];
        if (par) {
          var sz = T >> k, sx = (tx & ((1 << k) - 1)) * sz, sy = (ty & ((1 << k) - 1)) * sz;
          try { p.ctx.drawImage(par, sx, sy, sz, sz, dx, dy, T, T); } catch (e) {}
          return false;
        }
      }
      if (p.z < MAX_Z) {
        var kids = [], h = T / 2;
        for (var q = 0; q < 4; q++) kids.push(cache[(p.z + 1) + '/' + (tx * 2 + (q & 1)) + '/' + (ty * 2 + (q >> 1))]);
        if (kids[0] && kids[1] && kids[2] && kids[3]) {
          for (var q2 = 0; q2 < 4; q2++) try { p.ctx.drawImage(kids[q2], dx + (q2 & 1) * h, dy + (q2 >> 1) * h, h, h); } catch (e) {}
          return false;
        }
      }
      patchFromBase(p, i, j);
      return false;
    }
    // Draw base pixels into patch tile (i, j) (patch-relative).
    function patchFromBase(p, i, j) {
      var nz = 1 << p.z, tx = ((p.x0 + i) % nz + nz) % nz, ty = p.y0 + j;
      var f = (1 << BASE_Z) * T / nz;      // base px per patch tile
      try { p.ctx.drawImage(base.canvas, tx * f, ty * f, f, f, i * T, j * T, T, T); } catch (e) {}
    }
    function refillPatchFromBase(bx, by) {
      var p = patch, s = 1 << (p.z - BASE_Z), nz = 1 << p.z, hit = false;
      for (var j = 0; j < PATCH; j++) for (var i = 0; i < PATCH; i++) {
        var tx = ((p.x0 + i) % nz + nz) % nz, ty = p.y0 + j;
        if (Math.floor(tx / s) === bx && Math.floor(ty / s) === by && !p.have[i + ',' + j]) { patchFill(p, i, j); hit = true; }
      }
      if (hit) patchUploadSoon();
    }
    // A fetched tile lands in whatever window is current, if it belongs there
    // (the window may have moved while it was in flight).
    function patchPlace(z, x, y, img) {
      var p = patch;
      if (!p || p.z !== z) return;
      var nz = 1 << z, i = ((x - p.x0) % nz + nz) % nz, j = y - p.y0;
      if (i >= PATCH || j < 0 || j >= PATCH || p.have[i + ',' + j]) return;
      try { p.ctx.drawImage(img, i * T, j * T, T, T); } catch (e) {}
      p.have[i + ',' + j] = true;
      patchUploadSoon();
    }
    function wantedPatch() {
      if (!map || !base) return null;
      var z = map.getZoom(), dpr = Math.min(2, window.devicePixelRatio || 1);
      var c = map.getContainer(), W = c.clientWidth || 800, H = c.clientHeight || 600;
      // A 256-px tile at level z+1 is 1:1 with CSS pixels; lean sharper on HiDPI.
      var pz = Math.min(MAX_Z, Math.round(z + 1 + (dpr >= 1.5 ? 0.5 : 0)));
      var tileCss;
      for (;;) {
        tileCss = 512 * Math.pow(2, z - pz);
        if (pz <= BASE_Z || (Math.ceil(W / tileCss) + 1 <= PATCH && Math.ceil(H / tileCss) + 1 <= PATCH)) break;
        pz--;
      }
      if (pz <= BASE_Z) return null;
      var ctr = map.getCenter(), nz = 1 << pz;
      var mx = (ctr.lng + 180) / 360, sl = Math.sin(ctr.lat * RAD);
      var my = 0.5 - Math.log((1 + sl) / (1 - sl)) / (4 * Math.PI);
      var cx = mx * nz, cy = Math.max(0, Math.min(nz, my * nz));
      var hx = W / 2 / tileCss + 0.5, hy = H / 2 / tileCss + 0.5;
      return { z: pz, cx: cx, cy: cy, x0: Math.floor(cx - PATCH / 2), y0: Math.max(0, Math.min(nz - PATCH, Math.floor(cy - PATCH / 2))),
               vx0: Math.floor(cx - hx), vx1: Math.floor(cx + hx), vy0: Math.max(0, Math.floor(cy - hy)), vy1: Math.min(nz - 1, Math.floor(cy + hy)) };
    }
    function updatePatch() {
      if (!lightsOn || !nightOn || !gl) return;
      var w = wantedPatch();
      if (!w) { if (patch && !patch.off) { patch.off = true; if (map) map.triggerRepaint(); } return; }
      var p = patch;
      var fits = p && !p.off && p.z === w.z && w.vx0 >= p.x0 && w.vx1 < p.x0 + PATCH && w.vy0 >= p.y0 && w.vy1 < p.y0 + PATCH;
      if (!fits) {
        if (!p) {
          var cv = document.createElement('canvas'); cv.width = cv.height = PATCH * T;
          p = patch = { canvas: cv, ctx: cv.getContext('2d'), tex: null, upT: null };
        }
        p.z = w.z; p.x0 = w.x0; p.y0 = w.y0; p.have = {}; p.queued = {}; p.gen = ++gen;
        for (var j = 0; j < PATCH; j++) for (var i = 0; i < PATCH; i++) if (patchFill(p, i, j)) p.have[i + ',' + j] = true;
        // Drop queued patch tiles that fell out of the new window.
        queue = queue.filter(function (q) { return !q.patchGen || q.patchGen === p.gen; });
        p.off = false;
        patchUploadNow(p);      // new position + new pixels in the same task
      }
      // Fetch the visible (+1 tile margin), night-side tiles still missing.
      var nzz = 1 << p.z;
      for (var vy = w.vy0 - 1; vy <= w.vy1 + 1; vy++) for (var vx = w.vx0 - 1; vx <= w.vx1 + 1; vx++) {
        var ii = vx - p.x0, jj = vy - p.y0;
        if (vy < 0 || vy >= nzz || ii < 0 || jj < 0 || ii >= PATCH || jj >= PATCH || p.have[ii + ',' + jj] || p.queued[ii + ',' + jj]) continue;
        var tx = ((vx % nzz) + nzz) % nzz;
        if (!tileNight(p.z, tx, vy)) continue;
        p.queued[ii + ',' + jj] = true;
        var edge = (vx < w.vx0 || vx > w.vx1 || vy < w.vy0 || vy > w.vy1) ? 50 : 0;   // margin after visible
        (function (pp, g, z, x, y, e) {
          fetchTile({ z: z, x: x, y: y, rank0: -2000 + e, patchGen: g,
            stale: function () { return patch !== pp || pp.gen !== g; },
            done: function (img) { cachePut(z + '/' + x + '/' + y, img); patchPlace(z, x, y, img); } });
        })(p, p.gen, p.z, tx, vy, edge);
      }
    }
    // Follow the camera while it moves (so sharper tiles start loading
    // mid-zoom), and once more when it settles.
    var moveT = null, lastMoveUpd = 0;
    function onMove() {
      var now = Date.now();
      if (now - lastMoveUpd > 300) { lastMoveUpd = now; updatePatch(); }
    }
    function onMoveEnd() { clearTimeout(moveT); moveT = setTimeout(updatePatch, 60); }

    var layer = {
      id: opts.id || 'globe-light',
      type: 'custom',
      ml5: true,
      onAdd: function (m, g) {
        map = m; gl = g;
        meshBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf);
        var mesh = worldMesh(); nVerts = mesh.length / 2;
        gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
        map.on('moveend', onMoveEnd);
        map.on('move', onMove);
        if (lightsOn) { loadLights(); onMoveEnd(); }
      },
      render: function (g, arg) {
        if (!gl || !nightOn || !arg || !arg.shaderData) return;
        var pd = arg.defaultProjectionData;
        if (!(pd.projectionTransition > 0)) return;     // globe only; flat map stays untouched
        var P = prog(arg.shaderData); if (!P) return;
        var loc = P.loc;
        gl.useProgram(P.prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf);
        gl.enableVertexAttribArray(loc.a_pos);
        gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(loc.u_projection_matrix, false, pd.mainMatrix);
        gl.uniformMatrix4fv(loc.u_projection_fallback_matrix, false, pd.fallbackMatrix);
        gl.uniform4f(loc.u_projection_tile_mercator_coords, 0, 0, 1, 1);
        gl.uniform4f(loc.u_projection_clipping_plane, pd.clippingPlane[0], pd.clippingPlane[1], pd.clippingPlane[2], pd.clippingPlane[3]);
        gl.uniform1f(loc.u_projection_transition, pd.projectionTransition);
        gl.uniform3f(loc.u_sun, sun[0], sun[1], sun[2]);
        gl.uniform3f(loc.u_moon, moon[0], moon[1], moon[2]);
        gl.uniform1f(loc.u_moon_illum, moonIllum);
        gl.uniform1f(loc.u_night, NIGHT_STRENGTH);
        gl.uniform3f(loc.u_floor, FLOOR[0], FLOOR[1], FLOOR[2]);
        var useLights = !!(lightsOn && base && base.ready && base.tex);
        gl.uniform1f(loc.u_lights_on, useLights ? 1 : 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, useLights ? base.tex : null);
        gl.uniform1i(loc.u_lights, 0);
        var usePatch = !!(useLights && patch && !patch.off && patch.ready && patch.tex);
        gl.uniform1f(loc.u_patch_on, usePatch ? 1 : 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, usePatch ? patch.tex : null);
        gl.uniform1i(loc.u_patch, 1);
        if (usePatch) gl.uniform4f(loc.u_pb, patch.x0, patch.y0, 1 << patch.z, PATCH);
        gl.activeTexture(gl.TEXTURE0);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied
        gl.disable(gl.DEPTH_TEST);
        gl.drawArrays(gl.TRIANGLES, 0, nVerts);
      },
      onRemove: function () {
        if (!gl) return;
        if (map) { map.off('moveend', onMoveEnd); map.off('move', onMove); }
        clearTimeout(moveT);
        if (meshBuf) gl.deleteBuffer(meshBuf);
        if (base && base.tex) gl.deleteTexture(base.tex);
        if (patch && patch.tex) gl.deleteTexture(patch.tex);
        Object.keys(progs).forEach(function (k) { if (progs[k]) gl.deleteProgram(progs[k].prog); });
        progs = {}; meshBuf = null; base = null; patch = null; queue = [];
        gl = null; map = null;
      }
    };

    var bodiesT = null;
    return {
      layer: layer,
      setBodies: function (b) {
        if (!b) return;
        sun = b.sun.vec; moon = b.moon.vec; moonIllum = b.moon.illum;
        if (map) map.triggerRepaint();
        // The terminator moves with the loop: pick up newly dark patch tiles.
        if (patch && !bodiesT) bodiesT = setTimeout(function () { bodiesT = null; updatePatch(); }, 1500);
      },
      setOptions: function (o) {
        if (o.night != null) nightOn = !!o.night;
        if (o.lights != null) { lightsOn = !!o.lights; if (lightsOn && gl) { loadLights(); updatePatch(); } }
        if (map) map.triggerRepaint();
      },
      destroy: function () { if (map && map.getLayer(layer.id)) map.removeLayer(layer.id); }
    };
  }

  // ── sky: stars, sun, moon ─────────────────────────────────────────────────
  // Drawn FIRST (inserted before the style's background layer), so the globe
  // itself hides whatever is behind it — the sun can set behind the limb.
  // Positions go through the globe camera matrix (mainMatrix, unit = one Earth
  // radius, origin = Earth's center):
  //   stars and sun are directions (w = 0, at infinity),
  //   the moon is a real point 60.3 Earth radii out (w = 1), so its parallax
  //   against the stars is right for wherever the camera sits.
  // Sizes are true angular sizes (sun and moon ~0.53°), with a glare halo
  // around the sun so it reads at any zoom.
  var STAR_VS =
    'attribute vec3 a_star;uniform mat4 u_m;uniform float u_gmst;uniform float u_px;' +
    'varying float v_b;varying vec3 v_c;' +
    'void main(){float lon=a_star.x-u_gmst;float dec=a_star.y;' +
    'vec4 c=u_m*vec4(sin(lon)*cos(dec),sin(dec),cos(lon)*cos(dec),0.0);' +
    'if(c.w<=0.0){gl_Position=vec4(2.0,2.0,2.0,1.0);gl_PointSize=1.0;v_b=0.0;v_c=vec3(0.0);return;}' +
    'gl_Position=vec4(c.xy/c.w,0.0,1.0);' +
    'float m=a_star.z;v_b=clamp(1.15-m*0.17,0.12,1.0);' +
    'gl_PointSize=max(1.0,2.8-m*0.33)*u_px;' +
    'float h=fract(sin(a_star.x*91.7+a_star.y*13.1)*43758.5);' +
    'v_c=h<0.18?vec3(0.72,0.82,1.0):(h>0.9?vec3(1.0,0.86,0.70):vec3(1.0));}';
  var STAR_FS =
    'precision mediump float;varying float v_b;varying vec3 v_c;' +
    'void main(){float r=length(gl_PointCoord-0.5)*2.0;float a=v_b*(1.0-smoothstep(0.35,1.0,r));' +
    'gl_FragColor=vec4(v_c*a,a);}';
  // Billboard for sun and moon: a_corner in [-1,1]², u_rad = half-size in px.
  var BODY_VS =
    'attribute vec2 a_corner;uniform mat4 u_m;uniform vec4 u_pos;uniform vec3 u_toward;' +
    'uniform vec2 u_vp;uniform float u_rad;varying vec2 v_px;varying vec2 v_dir;' +
    'void main(){vec4 c=u_m*u_pos;' +
    'if(c.w<=0.0){gl_Position=vec4(2.0,2.0,2.0,1.0);v_px=vec2(0.0);v_dir=vec2(1.0,0.0);return;}' +
    'vec2 ndc=c.xy/c.w;' +
    // Screen direction toward the sun from this body (moon phase orientation).
    'vec4 q=u_m*vec4(u_pos.xyz+u_toward*5.0,u_pos.w);vec2 d=(q.xy/max(q.w,1e-6)-ndc)*u_vp;' +
    'v_dir=length(d)>1e-6?normalize(d):vec2(1.0,0.0);' +
    'v_px=a_corner*u_rad;gl_Position=vec4(ndc+v_px*2.0/u_vp,0.0,1.0);}';
  var SUN_FS =
    'precision mediump float;varying vec2 v_px;uniform float u_core;uniform float u_win;' +
    'void main(){float d=length(v_px);' +
    'float disk=1.0-smoothstep(u_core-1.0,u_core+1.0,d);' +
    'float glow=0.55*exp(-d/(u_core*2.0))+0.22*exp(-d/(u_core*7.0))+0.07*exp(-d/(u_core*22.0));' +
    'float ang=atan(v_px.y,v_px.x);' +
    'float rays=0.10*exp(-d/(u_core*12.0))*pow(abs(cos(ang*3.0)),60.0);' +
    // Fade the far glare to zero inside the billboard so its square edge never shows.
    // (u_win = the billboard half-size; a separate name because a uniform shared by
    // both stages must match precision, and the vertex stage's u_rad is highp.)
    'float win=1.0-smoothstep(u_win*0.45,u_win*0.98,d);' +
    'float I=clamp(disk+(glow+rays)*win,0.0,1.0);' +
    'vec3 col=mix(vec3(1.0,0.86,0.62),vec3(1.0,0.98,0.94),clamp(disk+glow*0.8,0.0,1.0));' +
    'gl_FragColor=vec4(col*I,I);}';
  var MOON_FS =
    'precision mediump float;varying vec2 v_px;varying vec2 v_dir;uniform float u_core;' +
    'uniform float u_cosi;uniform float u_illum;' +
    'void main(){vec2 p=v_px/u_core;float r=length(p);' +
    'float halo=0.10*u_illum*exp(-max(r-1.0,0.0)*1.6);' +
    'if(r>1.0){gl_FragColor=vec4(vec3(0.85,0.88,0.95)*halo,halo);return;}' +
    'float x=dot(p,v_dir);float y=dot(p,vec2(-v_dir.y,v_dir.x));float z=sqrt(max(0.0,1.0-r*r));' +
    'float sini=sqrt(max(0.0,1.0-u_cosi*u_cosi));' +
    'float lit=smoothstep(-0.04,0.04,x*sini+z*u_cosi);' +
    'float shade=mix(0.05,0.92*(0.75+0.25*z),lit);' +            // earthshine on the dark side, limb darkening on the lit
    'float edge=1.0-smoothstep(0.92,1.0,r);' +
    'float a=edge;gl_FragColor=vec4(vec3(0.93,0.92,0.88)*shade*a,a);}';

  function createSkyLayer(opts) {
    opts = opts || {};
    var map = null, gl = null, starBuf = null, quadBuf = null, nStars = 0, P = {};
    var b = null;

    function link(vs, fs, names) {
      var p = gl.createProgram();
      gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error('[globeSky] link: ' + gl.getProgramInfoLog(p)); return null; }
      var loc = {};
      names.forEach(function (n) {
        loc[n] = n.indexOf('a_') === 0 ? gl.getAttribLocation(p, n) : gl.getUniformLocation(p, n);
      });
      return { prog: p, loc: loc };
    }
    // Seeded random sky (same stars every visit), fixed in RA/Dec so it turns
    // with sidereal time like the sun does. ~1600 stars, mostly faint.
    function starData(n) {
      var seed = 914117, a = new Float32Array(n * 3);
      function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
      for (var i = 0; i < n; i++) {
        a[i * 3] = rnd() * 2 * Math.PI;
        a[i * 3 + 1] = Math.asin(2 * rnd() - 1);
        a[i * 3 + 2] = 0.5 + 6.0 * Math.pow(rnd(), 0.32);   // magnitude-ish, 0.5 (rare) .. 6.5
      }
      return a;
    }

    var layer = {
      id: opts.id || 'globe-sky', type: 'custom', ml5: true,
      onAdd: function (m, g) {
        map = m; gl = g;
        var stars = starData(opts.stars || 1600); nStars = stars.length / 3;
        starBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, starBuf); gl.bufferData(gl.ARRAY_BUFFER, stars, gl.STATIC_DRAW);
        quadBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
        P.star = link(STAR_VS, STAR_FS, ['a_star', 'u_m', 'u_gmst', 'u_px']);
        var bodyU = ['a_corner', 'u_m', 'u_pos', 'u_toward', 'u_vp', 'u_rad', 'u_core', 'u_win'];
        P.sun = link(BODY_VS, SUN_FS, bodyU);
        P.moon = link(BODY_VS, MOON_FS, bodyU.concat(['u_cosi', 'u_illum']));
      },
      render: function (g, arg) {
        if (!gl || !b || !arg || !arg.defaultProjectionData) return;
        var pd = arg.defaultProjectionData;
        if (!(pd.projectionTransition > 0.99)) return;   // a sky only makes sense on the globe
        var M = pd.mainMatrix, W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        var fov = ((map.transform && map.transform.fov) || 36.87) * Math.PI / 180;
        var f = (H / 2) / Math.tan(fov / 2);                 // px per radian at screen center
        var dpr = (window.devicePixelRatio || 1);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        // stars
        var S = P.star;
        if (S) {
          gl.useProgram(S.prog);
          gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
          gl.enableVertexAttribArray(S.loc.a_star);
          gl.vertexAttribPointer(S.loc.a_star, 3, gl.FLOAT, false, 0, 0);
          gl.uniformMatrix4fv(S.loc.u_m, false, M);
          gl.uniform1f(S.loc.u_gmst, b.gmst);
          gl.uniform1f(S.loc.u_px, Math.min(2, dpr));
          gl.drawArrays(gl.POINTS, 0, nStars);
          gl.disableVertexAttribArray(S.loc.a_star);
        }
        function body(Q, pos, w, core, rad, extra) {
          if (!Q) return;
          gl.useProgram(Q.prog);
          gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
          gl.enableVertexAttribArray(Q.loc.a_corner);
          gl.vertexAttribPointer(Q.loc.a_corner, 2, gl.FLOAT, false, 0, 0);
          gl.uniformMatrix4fv(Q.loc.u_m, false, M);
          gl.uniform4f(Q.loc.u_pos, pos[0], pos[1], pos[2], w);
          gl.uniform3f(Q.loc.u_toward, b.sun.vec[0], b.sun.vec[1], b.sun.vec[2]);
          gl.uniform2f(Q.loc.u_vp, W, H);
          gl.uniform1f(Q.loc.u_rad, rad);
          gl.uniform1f(Q.loc.u_core, core);
          if (Q.loc.u_win) gl.uniform1f(Q.loc.u_win, rad);
          if (extra) extra(Q.loc);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          gl.disableVertexAttribArray(Q.loc.a_corner);
        }
        // Moon: true angular radius 0.26° (min 2.5 px so a thin crescent stays findable).
        var mv = b.moon.vec, mcore = Math.max(2.5 * dpr, f * Math.tan(0.259 * RAD));
        body(P.moon, [mv[0] * 60.27, mv[1] * 60.27, mv[2] * 60.27], 1, mcore, mcore * 4, function (l) {
          gl.uniform1f(l.u_cosi, 2 * b.moon.illum - 1);
          gl.uniform1f(l.u_illum, b.moon.illum);
        });
        // Sun: true angular radius 0.267°, glare out to ~30 radii.
        var score = Math.max(3 * dpr, f * Math.tan(0.2665 * RAD));
        body(P.sun, b.sun.vec, 0, score, score * 30, null);
      },
      onRemove: function () {
        if (!gl) return;
        [starBuf, quadBuf].forEach(function (x) { if (x) gl.deleteBuffer(x); });
        Object.keys(P).forEach(function (k) { if (P[k]) gl.deleteProgram(P[k].prog); });
        P = {}; gl = null; map = null;
      }
    };
    return {
      layer: layer,
      setBodies: function (bb) { b = bb; if (map) map.triggerRepaint(); }
    };
  }

  window.GlobeLight = { bodies: bodies, atmosphereLight: atmosphereLight, createLayer: createLayer, createSkyLayer: createSkyLayer };
})();
