/* ════════════════════════════════════════════════════════════════════
   tc_vol_gl.js — TC-RADAR 3D volume rendered ON the MapLibre map.

   Draws isosurfaces of the /volume payload (compact format: value flattened
   as [nz][ny][nx], 1-D x_axis/y_axis (km from center), z_axis (km height))
   as lit triangle meshes in a MapLibre custom 3-D layer, in geographic
   position over the IR/basemap, with the map tilted. Companion to the
   Plotly modal in vol3d.js (which stays as the storm-relative fallback).

   Pipeline, all client-side:
     value grid → marching tetrahedra (6 tets/cube) at each iso level →
     positions (Mercator units, relative to a local origin so float32 has
     precision at 4-km cells) + normals (trilinear gradient of the field)
     → one VBO per surface → drawn back-to-front with alpha.

   Public API (window.TCVolGL):
     show(map, json, opts)   opts: {iso:[..] | null, exag, tilt, opacity, colorFor(v)→[r,g,b]}
     update(opts)            re-mesh / re-style with new options
     hide()                  remove layer, restore pitch, close card
     isOn()
   Requires window.maplibregl and a facade map (map._gl).
   ════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var LAYER_ID = 'tc-vol3d';
    var state = { map: null, gl: null, json: null, opts: null, meshes: [], layer: null, on: false,
                  origin: null, meterUnits: 1, prevPitch: 0, prevBearing: 0 };

    // ── Tetrahedra decomposition of a cube (Bourke corner numbering: 0..3 go
    // around the bottom face, 4..7 around the top, so corner 6 is opposite
    // corner 0 and the six tets share the 0–6 diagonal and tile the cube).
    var TETS = [[0,5,1,6],[0,1,2,6],[0,2,3,6],[0,3,7,6],[0,7,4,6],[0,4,5,6]];
    var CORNER = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];

    function buildMesh(json, iso, geo) {
        var shape = json.grid_shape, nz = shape[0], ny = shape[1], nx = shape[2];
        var val = json.value, sent = json.sentinel;
        var xA = json.x_axis, yA = json.y_axis, zA = json.z_axis;
        var pos = [], nrm = [];
        // No-data (sentinel/null) cells read as a value far below any iso level,
        // like Plotly's isosurface does, so shells CLOSE at the coverage edge
        // instead of leaving open ribbons where cubes were skipped.
        var vi = json.variable || {};
        var FLOOR = (vi.vmin != null ? vi.vmin : 0) - 10 * Math.max(1, Math.abs((vi.vmax != null ? vi.vmax : 1) - (vi.vmin != null ? vi.vmin : 0)));
        function V(i, j, k) { var v = val[(k * ny + j) * nx + i]; return (v === null || v === undefined || v === sent || v !== v) ? FLOOR : v; }
        function valid(v) { return v !== FLOOR; }
        // Gradient (central differences, in index space) for smooth normals.
        function grad(i, j, k, out) {
            var i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1);
            var j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1);
            var k0 = Math.max(0, k - 1), k1 = Math.min(nz - 1, k + 1);
            var c0 = V(i, j, k);
            var a = V(i1, j, k), b = V(i0, j, k); out[0] = (valid(a) && valid(b)) ? (a - b) : valid(a) ? 2 * (a - c0) : valid(b) ? 2 * (c0 - b) : 0;
            a = V(i, j1, k); b = V(i, j0, k); out[1] = (valid(a) && valid(b)) ? (a - b) : valid(a) ? 2 * (a - c0) : valid(b) ? 2 * (c0 - b) : 0;
            a = V(i, j, k1); b = V(i, j, k0); out[2] = (valid(a) && valid(b)) ? (a - b) : valid(a) ? 2 * (a - c0) : valid(b) ? 2 * (c0 - b) : 0;
        }
        var g0 = [0, 0, 0], g1 = [0, 0, 0];
        var cv = new Float64Array(8), cp = new Array(8);
        function edgePoint(ca, cb, out) {
            var va = cv[ca], vb = cv[cb], t = (vb === va) ? 0.5 : (iso - va) / (vb - va);
            if (va === FLOOR) t = Math.min(t, 0.98); else if (vb === FLOOR) t = Math.max(t, 0.02);   // keep the wall within the boundary cell
            t = Math.max(0, Math.min(1, t));
            var A = cp[ca], B = cp[cb];
            var ii = A[0] + t * (B[0] - A[0]), jj = A[1] + t * (B[1] - A[1]), kk = A[2] + t * (B[2] - A[2]);
            // position in Mercator units relative to origin
            var mx = geo.mx(ii), my = geo.my(jj), mz = geo.mz(kk);
            grad(A[0], A[1], A[2], g0); grad(B[0], B[1], B[2], g1);
            var gx = g0[0] + t * (g1[0] - g0[0]), gy = g0[1] + t * (g1[1] - g0[1]), gz = g0[2] + t * (g1[2] - g0[2]);
            // index-space gradient → mercator-space (scale by cell size), point outward (toward lower values)
            gx /= geo.dx; gy /= geo.dy; gz /= geo.dz;
            var L = Math.hypot(gx, gy, gz) || 1;
            out.p = [mx, my, mz]; out.n = [-gx / L, -gy / L, -gz / L];
        }
        var e0 = {}, e1 = {}, e2 = {}, e3 = {};
        function tri(a, b, c) { pos.push(a.p[0], a.p[1], a.p[2], b.p[0], b.p[1], b.p[2], c.p[0], c.p[1], c.p[2]);
                                 nrm.push(a.n[0], a.n[1], a.n[2], b.n[0], b.n[1], b.n[2], c.n[0], c.n[1], c.n[2]); }
        for (var k = 0; k < nz - 1; k++) for (var j = 0; j < ny - 1; j++) for (var i = 0; i < nx - 1; i++) {
            var anyData = false;
            for (var c = 0; c < 8; c++) {
                var ci = i + CORNER[c][0], cj = j + CORNER[c][1], ck = k + CORNER[c][2];
                var v = V(ci, cj, ck);
                if (valid(v)) anyData = true;
                cv[c] = v; cp[c] = [ci, cj, ck];
            }
            if (!anyData) continue;
            // quick reject: all above or all below
            var above = 0; for (c = 0; c < 8; c++) if (cv[c] >= iso) above++;
            if (above === 0 || above === 8) continue;
            for (var t = 0; t < 6; t++) {
                var T = TETS[t];
                var m = (cv[T[0]] >= iso ? 1 : 0) | (cv[T[1]] >= iso ? 2 : 0) | (cv[T[2]] >= iso ? 4 : 0) | (cv[T[3]] >= iso ? 8 : 0);
                if (m === 0 || m === 15) continue;
                var A = T[0], B = T[1], C = T[2], D = T[3];
                switch (m) {
                    case 1: case 14: edgePoint(A, B, e0); edgePoint(A, C, e1); edgePoint(A, D, e2); if (m === 1) tri(e0, e1, e2); else tri(e0, e2, e1); break;
                    case 2: case 13: edgePoint(B, A, e0); edgePoint(B, D, e1); edgePoint(B, C, e2); if (m === 2) tri(e0, e1, e2); else tri(e0, e2, e1); break;
                    case 4: case 11: edgePoint(C, A, e0); edgePoint(C, B, e1); edgePoint(C, D, e2); if (m === 4) tri(e0, e1, e2); else tri(e0, e2, e1); break;
                    case 8: case 7:  edgePoint(D, A, e0); edgePoint(D, C, e1); edgePoint(D, B, e2); if (m === 8) tri(e0, e1, e2); else tri(e0, e2, e1); break;
                    case 3: case 12: edgePoint(A, C, e0); edgePoint(A, D, e1); edgePoint(B, D, e2); edgePoint(B, C, e3);
                        if (m === 3) { tri(e0, e1, e2); tri(e0, e2, e3); } else { tri(e0, e2, e1); tri(e0, e3, e2); } break;
                    case 5: case 10: edgePoint(A, B, e0); edgePoint(A, D, e1); edgePoint(C, D, e2); edgePoint(C, B, e3);
                        if (m === 5) { tri(e0, e2, e1); tri(e0, e3, e2); } else { tri(e0, e1, e2); tri(e0, e2, e3); } break;
                    case 6: case 9:  edgePoint(A, B, e0); edgePoint(A, C, e1); edgePoint(D, C, e2); edgePoint(D, B, e3);
                        if (m === 6) { tri(e0, e1, e2); tri(e0, e2, e3); } else { tri(e0, e2, e1); tri(e0, e3, e2); } break;
                }
            }
        }
        var P = new Float32Array(pos), bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (var q = 0; q < P.length; q += 3) {
            if (P[q] < bb[0]) bb[0] = P[q]; if (P[q] > bb[3]) bb[3] = P[q];
            if (P[q+1] < bb[1]) bb[1] = P[q+1]; if (P[q+1] > bb[4]) bb[4] = P[q+1];
            if (P[q+2] < bb[2]) bb[2] = P[q+2]; if (P[q+2] > bb[5]) bb[5] = P[q+2];
        }
        return { pos: P, nrm: new Float32Array(nrm), n: pos.length / 3, iso: iso, bbox: bb };
    }

    // ── Hover readout: ray-cast the cursor against the shells ──
    // Ray from the free camera through the cursor's ground point, in the mesh's
    // local Mercator frame with z un-exaggerated; Möller–Trumbore per triangle
    // after a slab test on each shell's bounding box. ~100k triangles ≈ a few ms.
    function rayBox(o, d, bb) {
        var tmin = -Infinity, tmax = Infinity;
        for (var a = 0; a < 3; a++) {
            if (Math.abs(d[a]) < 1e-20) { if (o[a] < bb[a] || o[a] > bb[a+3]) return false; continue; }
            var t1 = (bb[a] - o[a]) / d[a], t2 = (bb[a+3] - o[a]) / d[a];
            if (t1 > t2) { var tt = t1; t1 = t2; t2 = tt; }
            tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
            if (tmin > tmax) return false;
        }
        return tmax >= 0;
    }
    function rayMesh(o, d, m) {
        if (!rayBox(o, d, m.bbox)) return Infinity;
        var P = m.pos, best = Infinity, EPS = 1e-12;
        for (var i = 0; i < P.length; i += 9) {
            var ax = P[i], ay = P[i+1], az = P[i+2];
            var e1x = P[i+3]-ax, e1y = P[i+4]-ay, e1z = P[i+5]-az;
            var e2x = P[i+6]-ax, e2y = P[i+7]-ay, e2z = P[i+8]-az;
            var px = d[1]*e2z - d[2]*e2y, py = d[2]*e2x - d[0]*e2z, pz = d[0]*e2y - d[1]*e2x;
            var det = e1x*px + e1y*py + e1z*pz;
            if (det > -EPS && det < EPS) continue;
            var inv = 1 / det, tx = o[0]-ax, ty = o[1]-ay, tz = o[2]-az;
            var u = (tx*px + ty*py + tz*pz) * inv; if (u < 0 || u > 1) continue;
            var qx = ty*e1z - tz*e1y, qy = tz*e1x - tx*e1z, qz = tx*e1y - ty*e1x;
            var v = (d[0]*qx + d[1]*qy + d[2]*qz) * inv; if (v < 0 || u + v > 1) continue;
            var t = (e2x*qx + e2y*qy + e2z*qz) * inv;
            if (t > 0 && t < best) best = t;
        }
        return best;
    }
    var _tip = null, _hoverPending = false, _lastEvt = null;
    function tipEl() {
        if (_tip) return _tip;
        _tip = document.createElement('div'); _tip.id = 'vol-gl-tip';
        _tip.style.cssText = 'position:fixed;z-index:1300;pointer-events:none;display:none;background:rgba(15,22,35,0.92);color:#fff;' +
            'font:600 11px/1.35 "DM Sans",sans-serif;padding:4px 8px;border-radius:5px;white-space:nowrap;border:1px solid rgba(255,255,255,0.15);';
        document.body.appendChild(_tip); return _tip;
    }
    function hideTip() { if (_tip) _tip.style.display = 'none'; }
    function syncCam() {
        if (!state.on) return;
        var gl = state.map._gl, b = Math.round(gl.getBearing()), p = Math.round(gl.getPitch());
        var bs = document.getElementById('vol-gl-bear'), bv = document.getElementById('vol-gl-bear-val');
        var ts = document.getElementById('vol-gl-tilt'), tv = document.getElementById('vol-gl-tilt-val');
        if (bs) bs.value = b; if (bv) bv.textContent = b + '°';
        if (ts) ts.value = p; if (tv) tv.textContent = p + '°';
        state.opts.tilt = p;
    }
    function onMove(e) { _lastEvt = e; if (_hoverPending) return; _hoverPending = true; requestAnimationFrame(doHover); }
    function doHover() {
        _hoverPending = false;
        var e = _lastEvt; if (!e || !state.on || !state.meshes.length) { hideTip(); return; }
        var gl = state.map._gl, MC = maplibregl.MercatorCoordinate;
        // Camera position: MapLibre 4.x exposes it on the transform ({lngLat, altitude});
        // 5.x also has getFreeCameraOptions(). Try both.
        var cam = null;
        try { if (gl.getFreeCameraOptions) cam = gl.getFreeCameraOptions().position; } catch (err) {}
        if (!cam) { try { var cp = gl.transform.getCameraPosition(); cam = MC.fromLngLat(cp.lngLat, cp.altitude); } catch (err2) {} }
        if (!cam) { hideTip(); return; }
        var ground = MC.fromLngLat(gl.unproject(e.point), 0);
        var ex = state.opts.exag, O = state.origin;
        var o = [cam.x - O.x, cam.y - O.y, cam.z / ex];
        var d = [ground.x - cam.x, ground.y - cam.y, (0 - cam.z) / ex];
        var best = Infinity, hitIso = null;
        state.meshes.forEach(function (m) { var t = rayMesh(o, d, m); if (t < best) { best = t; hitIso = m.iso; } });
        if (!isFinite(best)) { hideTip(); return; }
        var hx = o[0] + best * d[0], hy = o[1] + best * d[1], hz = (o[2] + best * d[2]);   // hz in un-exaggerated mercator z
        var hKm = hz / state.meterUnits / 1000;
        var ll = new MC(hx + O.x, hy + O.y, 0).toLngLat();
        var cosLat = Math.cos(state.opts.centerLat * Math.PI / 180) || 1;
        var xKm = (ll.lng - state.opts.centerLon) * 111.0 * cosLat, yKm = (ll.lat - state.opts.centerLat) * 111.0;
        var vi = state.json.variable || {};
        var tip = tipEl();
        tip.innerHTML = '<b>' + hitIso + ' ' + (vi.units || '') + '</b> shell &middot; z = ' + hKm.toFixed(1) + ' km<br>' +
            '<span style="opacity:.8">r = ' + Math.round(Math.hypot(xKm, yKm)) + ' km &middot; x ' + Math.round(xKm) + ', y ' + Math.round(yKm) + ' km</span>';
        var oe = e.originalEvent || {};
        tip.style.left = ((oe.clientX || 0) + 14) + 'px'; tip.style.top = ((oe.clientY || 0) - 8) + 'px';
        tip.style.display = 'block';
    }

    // ── Geographic mapping: km offsets → Mercator units about the origin ──
    function makeGeo(json, clat, clon) {
        var xA = json.x_axis, yA = json.y_axis, zA = json.z_axis;
        var cosLat = Math.cos(clat * Math.PI / 180) || 1;
        var MC = maplibregl.MercatorCoordinate;
        var origin = MC.fromLngLat([clon, clat], 0);
        var mUnits = origin.meterInMercatorCoordinateUnits();
        var mx = new Float64Array(xA.length), my = new Float64Array(yA.length), mz = new Float64Array(zA.length);
        for (var i = 0; i < xA.length; i++) mx[i] = MC.fromLngLat([clon + xA[i] / (111.0 * cosLat), clat], 0).x - origin.x;
        for (var j = 0; j < yA.length; j++) my[j] = MC.fromLngLat([clon, clat + yA[j] / 111.0], 0).y - origin.y;
        for (var k = 0; k < zA.length; k++) mz[k] = zA[k] * 1000 * mUnits;   // exaggeration applied in shader
        function interp(arr, f) { var i0 = Math.floor(f), i1 = Math.min(arr.length - 1, i0 + 1), t = f - i0; return arr[i0] + t * (arr[i1] - arr[i0]); }
        return {
            origin: origin, meterUnits: mUnits,
            mx: function (f) { return interp(mx, f); }, my: function (f) { return interp(my, f); }, mz: function (f) { return interp(mz, f); },
            dx: Math.abs(mx[1] - mx[0]) || 1, dy: Math.abs(my[1] - my[0]) || 1, dz: Math.abs(mz[1] - mz[0]) || 1
        };
    }

    // ── Custom layer ──
    var VS = [
        'attribute vec3 aPos; attribute vec3 aNrm;',
        'uniform mat4 uMatrix; uniform vec3 uOrigin; uniform float uExag;',
        'varying vec3 vNrm; varying float vDepth;',
        'void main(){',
        '  vec3 p = vec3(aPos.x + uOrigin.x, aPos.y + uOrigin.y, aPos.z * uExag);',
        '  gl_Position = uMatrix * vec4(p, 1.0);',
        '  vNrm = normalize(vec3(aNrm.x, aNrm.y, aNrm.z / max(uExag, 0.001)));',
        '  vDepth = gl_Position.w;',
        '}'].join('\n');
    var FS = [
        'precision mediump float;',
        'uniform vec4 uColor; uniform vec3 uLight;',
        'varying vec3 vNrm; varying float vDepth;',
        'void main(){',
        '  vec3 n = normalize(vNrm);',
        '  float diff = abs(dot(n, normalize(uLight)));',
        '  float spec = pow(max(dot(n, normalize(uLight + vec3(0.0,0.0,1.0))), 0.0), 24.0) * 0.25;',
        '  vec3 c = uColor.rgb * (0.35 + 0.65 * diff) + spec;',
        '  gl_FragColor = vec4(c, uColor.a);',
        '}'].join('\n');

    function makeLayer() {
        var prog = null, uMatrix, uOrigin, uExag, uColor, uLight, aPos, aNrm;
        return {
            id: LAYER_ID, type: 'custom', renderingMode: '3d',
            onAdd: function (map, gl) {
                function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
                    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('[tc_vol_gl] shader', gl.getShaderInfoLog(s)); return s; }
                prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
                uMatrix = gl.getUniformLocation(prog, 'uMatrix'); uOrigin = gl.getUniformLocation(prog, 'uOrigin'); uExag = gl.getUniformLocation(prog, 'uExag');
                uColor = gl.getUniformLocation(prog, 'uColor'); uLight = gl.getUniformLocation(prog, 'uLight');
                aPos = gl.getAttribLocation(prog, 'aPos'); aNrm = gl.getAttribLocation(prog, 'aNrm');
                state.gl = gl; uploadAll(gl);
            },
            onRemove: function (map, gl) { state.meshes.forEach(function (m) { if (m.vboP) { gl.deleteBuffer(m.vboP); gl.deleteBuffer(m.vboN); m.vboP = m.vboN = null; } }); },
            render: function (gl, matrix) {
                if (!prog || !state.meshes.length) return;
                var mat = matrix && matrix.defaultProjectionData ? matrix.defaultProjectionData.mainMatrix : matrix;   // v5 passes an options object
                gl.useProgram(prog);
                gl.uniformMatrix4fv(uMatrix, false, mat);
                gl.uniform3f(uOrigin, state.origin.x, state.origin.y, 0);
                gl.uniform1f(uExag, state.opts.exag);
                gl.uniform3f(uLight, -0.4, 0.5, 0.75);
                gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
                gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.disable(gl.CULL_FACE);   // tet winding is not guaranteed consistent; lighting uses |n·l| so both faces shade alike
                // inner (high iso) surfaces first, more opaque; outer last, more transparent
                var ms = state.meshes.slice().sort(function (a, b) { return b.iso - a.iso; });
                var n = ms.length;
                ms.forEach(function (m, idx) {
                    if (!m.vboP || !m.n) return;
                    var c = m.color;
                    var alpha = n === 1 ? state.opts.opacity : state.opts.opacity * (1 - 0.55 * idx / (n - 1));
                    gl.uniform4f(uColor, c[0] / 255, c[1] / 255, c[2] / 255, alpha);
                    gl.bindBuffer(gl.ARRAY_BUFFER, m.vboP); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
                    gl.bindBuffer(gl.ARRAY_BUFFER, m.vboN); gl.enableVertexAttribArray(aNrm); gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0);
                    gl.depthMask(idx === 0);   // only the innermost surface writes depth; outer shells blend over it
                    gl.drawArrays(gl.TRIANGLES, 0, m.n);
                });
                gl.depthMask(true);
            }
        };
    }
    function uploadAll(gl) {
        state.meshes.forEach(function (m) {
            if (m.vboP) { gl.deleteBuffer(m.vboP); gl.deleteBuffer(m.vboN); }
            m.vboP = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, m.vboP); gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW);
            m.vboN = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, m.vboN); gl.bufferData(gl.ARRAY_BUFFER, m.nrm, gl.STATIC_DRAW);
        });
    }

    // Standard thresholds by variable family (what a radar meteorologist would
    // pick), keyed by shell count; fall back to fractions of the data range.
    var STD_ISOS = {
        reflectivity: { 1: [30], 2: [20, 40], 3: [20, 35, 50] },       // dBZ
        wind:         { 1: [40], 2: [30, 50], 3: [25, 40, 55] },       // m/s (tangential / total / earth-rel speed)
        radial:       { 1: [10], 2: [5, 15], 3: [5, 10, 20] },         // m/s
        upward:       { 1: [2], 2: [1, 3], 3: [1, 3, 5] }              // m/s
    };
    function isoFamily(key) {
        key = String(key || '');
        if (/reflectivity/.test(key)) return 'reflectivity';
        if (/upward|vertical/.test(key)) return 'upward';
        if (/radial/.test(key)) return 'radial';
        if (/tangential|wind_speed/.test(key)) return 'wind';
        return null;
    }
    function defaultIsos(json, count) {
        var vi = json.variable || {};
        var fam = isoFamily(vi.key);
        var dmax = (vi.data_max != null) ? vi.data_max : vi.vmax;
        if (fam && STD_ISOS[fam][count]) {
            // keep only levels the data actually reaches
            var std = STD_ISOS[fam][count].filter(function (v) { return dmax == null || v < dmax; });
            if (std.length) return std;
        }
        var lo = vi.vmin != null ? vi.vmin : 0, top = dmax != null ? dmax : (vi.vmax != null ? vi.vmax : 1);
        var isos = [];
        for (var i = 1; i <= count; i++) isos.push(lo + (top - lo) * (0.45 + 0.35 * (i - 1) / Math.max(1, count - 1)));
        return isos.map(function (v) { return Math.round(v * 10) / 10; });
    }

    function remesh() {
        var json = state.json, o = state.opts;
        var meta = json.case_meta || {};
        var clat = o.centerLat, clon = o.centerLon;
        var geo = makeGeo(json, clat, clon);
        state.origin = geo.origin; state.meterUnits = geo.meterUnits;
        var isos = (o.iso && o.iso.length) ? o.iso : defaultIsos(json, o.surfaces || 2);
        state.meshes = isos.map(function (iso) {
            var m = buildMesh(json, iso, geo);
            m.color = o.colorFor ? o.colorFor(iso) : [255, 160, 40];
            return m;
        });
        if (state.gl) uploadAll(state.gl);
        try { state.map._gl.triggerRepaint(); } catch (e) {}
        return isos;
    }

    // ── Control card ──
    function card(isos) {
        var el = document.getElementById('vol-gl-card');
        var host = document.getElementById('map-container');
        if (!host) return;
        if (!el) { el = document.createElement('div'); el.id = 'vol-gl-card'; el.className = 'vol-gl-card'; host.appendChild(el); }
        var vi = state.json.variable || {}, lo = vi.vmin != null ? vi.vmin : 0, hi = vi.data_max != null ? vi.data_max : (vi.vmax != null ? vi.vmax : 1);
        var step = (hi - lo) > 50 ? 1 : 0.5;
        el.innerHTML =
            '<div class="vol-gl-row vol-gl-head"><span class="vol-gl-title">3D ' + (vi.display_name || 'volume') + '</span>' +
              '<button class="vol-gl-x" onclick="TCVolGL.hide()" title="Close 3D view">×</button></div>' +
            '<div class="vol-gl-row"><label>Iso ' + (vi.units ? '(' + vi.units + ')' : '') + '</label>' +
              '<input type="range" id="vol-gl-iso" min="' + lo + '" max="' + hi + '" step="' + step + '" value="' + isos[0] + '" oninput="TCVolGL.update({isoBase: parseFloat(this.value)})">' +
              '<span id="vol-gl-iso-val">' + isos.map(function (v) { return v; }).join(' / ') + '</span></div>' +
            '<div class="vol-gl-row"><label>Shells</label>' +
              '<select id="vol-gl-shells" onchange="TCVolGL.update({surfaces: parseInt(this.value)})">' + [1, 2, 3].map(function (n) { return '<option value="' + n + '"' + (n === (state.opts.surfaces || 1) ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select>' +
              '<label>Opacity</label><input type="range" id="vol-gl-op" min="0.2" max="1" step="0.05" value="' + state.opts.opacity + '" oninput="TCVolGL.update({opacity: parseFloat(this.value)})"></div>' +
            '<div class="vol-gl-row"><label>Height ×</label>' +
              '<input type="range" id="vol-gl-exag" min="2" max="40" step="1" value="' + state.opts.exag + '" oninput="TCVolGL.update({exag: parseFloat(this.value)})"><span id="vol-gl-exag-val">' + state.opts.exag + '×</span></div>' +
            '<div class="vol-gl-row"><label>Tilt</label><input type="range" id="vol-gl-tilt" min="0" max="75" step="1" value="' + state.opts.tilt + '" oninput="TCVolGL.update({tilt: parseFloat(this.value)})"><span id="vol-gl-tilt-val">' + state.opts.tilt + '°</span>' +
              '<label>Rotate</label><input type="range" id="vol-gl-bear" min="-180" max="180" step="1" value="' + Math.round(state.map._gl.getBearing()) + '" oninput="TCVolGL.update({bearing: parseFloat(this.value)})"><span id="vol-gl-bear-val">' + Math.round(state.map._gl.getBearing()) + '°</span></div>' +
            '<div class="vol-gl-row vol-gl-foot"><span>Mouse: right-drag or Ctrl+drag rotates &middot; scroll zooms &middot; hover a shell for height. Touch: two-finger twist rotates.</span></div>' +
            '<div class="vol-gl-row vol-gl-foot"><span>Sliders above set tilt and rotation exactly.</span>' +
              '<button class="vol-gl-link" onclick="if (typeof open3DModal===\'function\') open3DModal();">Open storm-relative 3D</button></div>';
    }

    var api = {
        isOn: function () { return state.on; },
        show: function (map, json, opts) {
            if (!window.maplibregl || !map || !map._gl) return false;
            if (state.on) api.hide();
            state.map = map; state.json = json;
            state.opts = Object.assign({ exag: 6, tilt: 55, opacity: 0.9, surfaces: 1, iso: null }, opts || {});
            var gl = map._gl;
            state.prevPitch = gl.getPitch(); state.prevBearing = gl.getBearing();
            try { gl.dragRotate.enable(); gl.touchZoomRotate.enableRotation(); } catch (e) {}
            var isos = remesh();
            state.layer = makeLayer();
            try { gl.addLayer(state.layer); } catch (e) { console.error('[tc_vol_gl] addLayer', e); return false; }
            state.on = true;
            card(isos);
            gl.on('mousemove', onMove); gl.on('mouseout', hideTip);
            gl.on('rotate', syncCam); gl.on('pitch', syncCam);
            gl.easeTo({ pitch: state.opts.tilt, duration: 600 });
            document.body.classList.add('vol-gl-on');
            if (typeof state.opts.onShow === 'function') { try { state.opts.onShow(); } catch (e) {} }
            return true;
        },
        update: function (o) {
            if (!state.on) return;
            var needMesh = false;
            if (o.isoBase != null) {
                var n = state.opts.surfaces || 1, vi = state.json.variable || {}, hi = vi.data_max != null ? vi.data_max : vi.vmax;
                var isos = [];
                for (var i = 0; i < n; i++) isos.push(Math.round((o.isoBase + (hi - o.isoBase) * 0.5 * i / Math.max(1, n - 1)) * 10) / 10);
                state.opts.iso = isos; needMesh = true;
            }
            if (o.surfaces != null) { var ss = document.getElementById('vol-gl-shells'); if (ss && String(ss.value) !== String(o.surfaces)) ss.value = String(o.surfaces); }
            if (o.surfaces != null) { state.opts.surfaces = o.surfaces; state.opts.iso = null; needMesh = true; }
            if (o.opacity != null) state.opts.opacity = o.opacity;
            if (o.exag != null) { state.opts.exag = o.exag; var ev = document.getElementById('vol-gl-exag-val'); if (ev) ev.textContent = o.exag + '×'; }
            if (o.tilt != null) { state.opts.tilt = o.tilt; var tv = document.getElementById('vol-gl-tilt-val'); if (tv) tv.textContent = o.tilt + '°'; try { state.map._gl.easeTo({ pitch: o.tilt, duration: 300 }); } catch (e) {} }
            if (o.bearing != null) { var bv = document.getElementById('vol-gl-bear-val'); if (bv) bv.textContent = o.bearing + '°'; try { state.map._gl.easeTo({ bearing: o.bearing, duration: 300 }); } catch (e) {} }
            if (needMesh) { var isos2 = remesh(); var iv = document.getElementById('vol-gl-iso-val'); if (iv) iv.textContent = isos2.join(' / ');
                var isl = document.getElementById('vol-gl-iso'); if (isl && o.surfaces != null) isl.value = isos2[0]; }
            try { state.map._gl.triggerRepaint(); } catch (e) {}
        },
        hide: function () {
            if (!state.on) return;
            var gl = state.map._gl;
            try { if (gl.getLayer(LAYER_ID)) gl.removeLayer(LAYER_ID); } catch (e) {}
            try { gl.easeTo({ pitch: 0, bearing: 0, duration: 500 }); gl.dragRotate.disable(); gl.touchZoomRotate.disableRotation(); } catch (e) {}
            var el = document.getElementById('vol-gl-card'); if (el) el.remove();
            try { gl.off('mousemove', onMove); gl.off('mouseout', hideTip); gl.off('rotate', syncCam); gl.off('pitch', syncCam); } catch (e) {}
            hideTip();
            document.body.classList.remove('vol-gl-on');
            if (state.opts && typeof state.opts.onHide === 'function') { try { state.opts.onHide(); } catch (e) {} }
            state.on = false; state.meshes = []; state.layer = null;
        }
    };
    window.TCVolGL = api;
})();
