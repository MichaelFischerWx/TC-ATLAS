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
 *   GlobeLight.createLayer({ id, lightsTileUrl, lightsZoom }) → controller:
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
    return { sun: sun, moon: moon, date: date };
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
  var VS_BODY =
    'attribute vec2 a_pos;varying vec2 v_merc;' +
    'void main(){v_merc=a_pos;gl_Position=projectTile(a_pos);}';
  var FS =
    'precision highp float;varying vec2 v_merc;' +
    'uniform vec3 u_sun;uniform vec3 u_moon;uniform float u_moon_illum;' +
    'uniform float u_night;uniform float u_lights_on;uniform sampler2D u_lights;' +
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
    'if(u_lights_on>0.5){vec3 L=texture2D(u_lights,v_merc).rgb;' +
    'city=pow(L,vec3(1.6))*vec3(1.0,0.82,0.55)*1.25*lightsMask*u_night;}' +
    'gl_FragColor=vec4(tint+city,a);}';

  var MESH_X = 96, MESH_Y = 64;
  function worldMesh() {
    var a = [], dx = 1 / MESH_X, dy = 1 / MESH_Y;
    for (var j = 0; j < MESH_Y; j++) for (var i = 0; i < MESH_X; i++) {
      var x0 = i * dx, y0 = j * dy, x1 = x0 + dx, y1 = y0 + dy;
      a.push(x0, y0, x1, y0, x0, y1, x1, y0, x1, y1, x0, y1);
    }
    return new Float32Array(a);
  }

  function compile(gl, type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('[globeLight] shader: ' + gl.getShaderInfoLog(s));
    return s;
  }

  function createLayer(opts) {
    opts = opts || {};
    var map = null, gl = null, meshBuf = null, nVerts = 0, progs = {};
    var lightsTex = null, lightsCanvas = null, lightsReady = false, lightsLoading = false;
    var sun = [0, 0, 1], moon = [0, 0, -1], moonIllum = 0;
    var nightOn = true, lightsOn = true;
    var NIGHT_STRENGTH = (opts.nightStrength != null) ? opts.nightStrength : 0.62;

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
       'u_night', 'u_lights_on', 'u_lights'].forEach(function (n) { loc[n] = gl.getUniformLocation(p, n); });
      progs[key] = { prog: p, loc: loc };
      return progs[key];
    }

    // City lights: GIBS VIIRS 2012 night lights, one Mercator world texture
    // stitched from tiles at lightsZoom (z3 = 8×8 tiles of 256 px = 2048 px,
    // ~0.5 MB of JPEG). Power-of-two, so it gets mipmaps for the zoomed-out view.
    function loadLights() {
      if (lightsLoading || !opts.lightsTileUrl) return;
      lightsLoading = true;
      var z = opts.lightsZoom != null ? opts.lightsZoom : 3, n = 1 << z, T = 256;
      lightsCanvas = document.createElement('canvas');
      lightsCanvas.width = lightsCanvas.height = n * T;
      var ctx = lightsCanvas.getContext('2d');
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, n * T, n * T);
      var left = n * n;
      function done() {
        if (--left > 0) return;
        if (!gl) return;
        lightsTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, lightsTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, lightsCanvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.generateMipmap(gl.TEXTURE_2D);
        lightsCanvas = null; lightsReady = true;
        if (map) map.triggerRepaint();
      }
      for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) (function (x, y) {
        var img = new Image(); img.crossOrigin = 'anonymous';
        img.onload = function () { try { ctx.drawImage(img, x * T, y * T, T, T); } catch (e) {} done(); };
        img.onerror = done;
        img.src = opts.lightsTileUrl(z, x, y);
      })(x, y);
    }

    var layer = {
      id: opts.id || 'globe-light',
      type: 'custom',
      ml5: true,
      onAdd: function (m, g) {
        map = m; gl = g;
        meshBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf);
        var mesh = worldMesh(); nVerts = mesh.length / 2;
        gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
        if (lightsOn) loadLights();
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
        var useLights = lightsOn && lightsReady && lightsTex;
        gl.uniform1f(loc.u_lights_on, useLights ? 1 : 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, useLights ? lightsTex : null);
        gl.uniform1i(loc.u_lights, 0);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied
        gl.disable(gl.DEPTH_TEST);
        gl.drawArrays(gl.TRIANGLES, 0, nVerts);
      },
      onRemove: function () {
        if (!gl) return;
        if (meshBuf) gl.deleteBuffer(meshBuf);
        if (lightsTex) gl.deleteTexture(lightsTex);
        Object.keys(progs).forEach(function (k) { if (progs[k]) gl.deleteProgram(progs[k].prog); });
        progs = {}; meshBuf = null; lightsTex = null; lightsReady = false; lightsLoading = false;
        gl = null; map = null;
      }
    };

    return {
      layer: layer,
      setBodies: function (b) {
        if (!b) return;
        sun = b.sun.vec; moon = b.moon.vec; moonIllum = b.moon.illum;
        if (map) map.triggerRepaint();
      },
      setOptions: function (o) {
        if (o.night != null) nightOn = !!o.night;
        if (o.lights != null) { lightsOn = !!o.lights; if (lightsOn && gl) loadLights(); }
        if (map) map.triggerRepaint();
      },
      destroy: function () { if (map && map.getLayer(layer.id)) map.removeLayer(layer.id); }
    };
  }

  window.GlobeLight = { bodies: bodies, atmosphereLight: atmosphereLight, createLayer: createLayer };
})();
