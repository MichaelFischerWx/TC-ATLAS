// GC-ATLAS — Lagrangian parcels on the 3D monthly-mean wind (u, v, ω).
//
// Each parcel has a 3D position (lat, lon, p). At every animation frame we
// interpolate (u, v, ω) at its location via trilinear interp (bilinear in
// lat/lon, linear in log-p) and advance the position with a simple RK2
// step corresponding to DT_HOURS hours of simulated time. Parcels are
// rendered as a trailing polyline on the globe with radius encoded by
// pressure so they visibly rise / sink in the Hadley / Ferrel circulations
// as you watch.
//
// Because our data is monthly climatology, parcels follow the MEAN 3-D
// wind — you see the overturning as time-mean streamlines, not any real
// individual air-parcel trajectory. That's the pedagogical intent: "if
// the climatology were steady, here's where a parcel released at 15°N,
// 200 hPa in July would drift."

import * as THREE from 'three';
import { cachedMonth } from './era5.js';
import { LEVELS, GRID } from './data.js';

const N_MAX      = 160;          // max concurrent parcels
const TRAIL      = 96;           // samples per parcel (≈ 24 days at 6 h/frame)
const DT_HOURS   = 6;            // simulated hours advanced per animation frame
const MAX_DAYS   = 30;           // parcels fade out after this long

const A_EARTH = 6.371e6;         // m
const R2D     = 180 / Math.PI;
const D2R     = Math.PI / 180;
// Radius range on the globe: surface parcels skim at R_SURF, stratospheric
// parcels ride up to R_TOA. Linear in 1-p/p0, so mid-troposphere (500 hPa)
// sits roughly halfway.
const R_SURF  = 1.015;
const R_TOA   = 1.16;

const POINTS_PER_DAY = 24 / DT_HOURS;      // 4 per day at 6 h
const MAX_AGE_STEPS  = MAX_DAYS * POINTS_PER_DAY;
const FADE_STEPS     = 12;                 // fade-out tail

export class ParcelField {
    constructor() {
        // Per-parcel state. active[i] true if the parcel is alive.
        this.active   = new Uint8Array(N_MAX);
        this.lat      = new Float32Array(N_MAX);
        this.lon      = new Float32Array(N_MAX);
        this.press    = new Float32Array(N_MAX);
        this.age      = new Float32Array(N_MAX);
        // Trail storage: positions (xyz) + age-at-sample index per parcel.
        this.trail    = new Float32Array(N_MAX * TRAIL * 3);
        this.trailLen = new Uint16Array(N_MAX);

        // Geometry: LineSegments between adjacent trail points, one pass.
        const maxSegs = N_MAX * (TRAIL - 1);
        this.positions = new Float32Array(maxSegs * 2 * 3);
        this.alphas    = new Float32Array(maxSegs * 2);
        this.geom = new THREE.BufferGeometry();
        this.geom.setAttribute('position',
            new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
        this.geom.setAttribute('alpha',
            new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
        // Colour ramp via pressure encoded in alpha isn't right; let's just
        // use a single colour per pass. Amber reads well on both turbo and
        // viridis backdrops.
        this.trailMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: false,
            uniforms: { uColor: { value: new THREE.Color(0xFFD668) } },
            vertexShader: `
                attribute float alpha;
                varying float vAlpha;
                void main() {
                    vAlpha = alpha;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 uColor;
                varying float vAlpha;
                void main() { gl_FragColor = vec4(uColor, vAlpha); }
            `,
        });
        this.trailMesh = new THREE.LineSegments(this.geom, this.trailMat);
        this.trailMesh.renderOrder = 8;
        this.trailMesh.frustumCulled = false;

        // Head dots so parcels always have a visible marker even if the
        // trail is short.
        this.headPos = new Float32Array(N_MAX * 3);
        this.headAlpha = new Float32Array(N_MAX);
        this.headGeom = new THREE.BufferGeometry();
        this.headGeom.setAttribute('position',
            new THREE.BufferAttribute(this.headPos, 3).setUsage(THREE.DynamicDrawUsage));
        this.headGeom.setAttribute('alpha',
            new THREE.BufferAttribute(this.headAlpha, 1).setUsage(THREE.DynamicDrawUsage));
        const headMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: false,
            uniforms: { uColor: { value: new THREE.Color(0xFFE27A) } },
            vertexShader: `
                attribute float alpha;
                varying float vAlpha;
                void main() {
                    vAlpha = alpha;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = 5.0;
                }
            `,
            fragmentShader: `
                uniform vec3 uColor;
                varying float vAlpha;
                void main() {
                    vec2 c = gl_PointCoord - 0.5;
                    if (dot(c, c) > 0.25) discard;
                    gl_FragColor = vec4(uColor, vAlpha);
                }
            `,
        });
        this.headMesh = new THREE.Points(this.headGeom, headMat);
        this.headMesh.renderOrder = 9;
        this.headMesh.frustumCulled = false;

        this.object = new THREE.Group();
        this.object.add(this.trailMesh);
        this.object.add(this.headMesh);

        // 3D wind cache: [k][idx] = u / v / ω at LEVELS[k] for the current
        // month. Rebuilt whenever the month changes.
        this._cacheMonth = null;
        this._uCube = null;
        this._vCube = null;
        this._wCube = null;
    }

    setVisible(v) { this.object.visible = v; }

    hasActive() {
        for (let i = 0; i < N_MAX; i++) if (this.active[i]) return true;
        return false;
    }

    clear() {
        this.active.fill(0);
        this.trailLen.fill(0);
        this.headAlpha.fill(0);
        this.alphas.fill(0);
        this.geom.attributes.alpha.needsUpdate = true;
        this.headGeom.attributes.alpha.needsUpdate = true;
    }

    /** Drop a cluster of parcels at (lat0, lon0) centred on the given
     *  pressure (hPa). Returns the number actually seeded. */
    seed(lat0, lon0, pressure0 = 200, count = 12, spread = 1.5) {
        let placed = 0;
        for (let i = 0; i < N_MAX && placed < count; i++) {
            if (this.active[i]) continue;
            this.active[i] = 1;
            this.lat[i]   = lat0 + (Math.random() - 0.5) * 2 * spread;
            this.lon[i]   = lon0 + (Math.random() - 0.5) * 2 * spread;
            this.press[i] = pressure0;
            this.age[i]   = 0;
            this.trailLen[i] = 0;
            const [x, y, z] = this._project(this.lat[i], this.lon[i], this.press[i]);
            const tx = i * TRAIL * 3;
            for (let t = 0; t < TRAIL; t++) {
                this.trail[tx + t * 3]     = x;
                this.trail[tx + t * 3 + 1] = y;
                this.trail[tx + t * 3 + 2] = z;
            }
            placed += 1;
        }
        return placed;
    }

    /** Ensure the 3D wind cube is populated for the given month. Returns
     *  true when ready. */
    _ensureCube(month) {
        if (this._cacheMonth === month && this._uCube && this._vCube && this._wCube) return true;
        const U = [], V = [], W = [];
        for (const L of LEVELS) {
            const u = cachedMonth('u', month, L);
            const v = cachedMonth('v', month, L);
            const w = cachedMonth('w', month, L);
            if (!u || !v || !w) return false;
            U.push(u); V.push(v); W.push(w);
        }
        this._uCube = U;
        this._vCube = V;
        this._wCube = W;
        this._cacheMonth = month;
        return true;
    }

    /** Trilinear sample of the 3D wind at (lat, lon, p). Returns { u, v, w }
     *  or null when p is out of range or tiles aren't cached yet. */
    _sampleWind(lat, lon, p) {
        if (!this._uCube) return null;
        if (p < LEVELS[0] || p > LEVELS[LEVELS.length - 1]) return null;
        // Pressure interpolation in log-p.
        let k0 = 0;
        while (k0 < LEVELS.length - 1 && LEVELS[k0 + 1] < p) k0++;
        const k1 = Math.min(LEVELS.length - 1, k0 + 1);
        const fK = (k0 === k1) ? 0
            : Math.log(p / LEVELS[k0]) / Math.log(LEVELS[k1] / LEVELS[k0]);

        const { nlat, nlon } = GRID;
        const rLat = 90 - lat;
        const rLon = ((lon + 180) % 360 + 360) % 360;
        if (rLat < 0 || rLat > nlat - 1) return null;
        const i0 = Math.floor(rLat);
        const i1 = Math.min(nlat - 1, i0 + 1);
        const j0 = Math.floor(rLon) % nlon;
        const j1 = (j0 + 1) % nlon;
        const fi = rLat - i0;
        const fj = rLon - Math.floor(rLon);

        const sampleSlice = (slice) => {
            const a = slice[i0 * nlon + j0] * (1 - fj) + slice[i0 * nlon + j1] * fj;
            const b = slice[i1 * nlon + j0] * (1 - fj) + slice[i1 * nlon + j1] * fj;
            return a * (1 - fi) + b * fi;
        };

        const u = sampleSlice(this._uCube[k0]) * (1 - fK) + sampleSlice(this._uCube[k1]) * fK;
        const v = sampleSlice(this._vCube[k0]) * (1 - fK) + sampleSlice(this._vCube[k1]) * fK;
        const w = sampleSlice(this._wCube[k0]) * (1 - fK) + sampleSlice(this._wCube[k1]) * fK;
        if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(w)) return null;
        return { u, v, w };
    }

    /** Map (lat, lon, p) → world (x, y, z), with radius encoded by pressure. */
    _project(lat, lon, p) {
        const t = 1 - (Math.log(p / LEVELS[0]) / Math.log(LEVELS[LEVELS.length - 1] / LEVELS[0]));
        const r = R_SURF + (R_TOA - R_SURF) * Math.max(0, Math.min(1, t));
        const phi = lat * D2R;
        const lam = lon * D2R;
        return [
            r * Math.cos(phi) * Math.sin(lam),
            r * Math.sin(phi),
            r * Math.cos(phi) * Math.cos(lam),
        ];
    }

    /** One RK2 integration step on (lat, lon, p). Returns new position or
     *  null if the parcel should die (left domain or hit NaN). */
    _rk2(lat, lon, p) {
        const DT_SEC = DT_HOURS * 3600;
        const s1 = this._sampleWind(lat, lon, p);
        if (!s1) return null;
        // Half-step prediction.
        const dlat1 = s1.v / A_EARTH * R2D;
        const cosLat = Math.max(0.05, Math.cos(lat * D2R));
        const dlon1 = s1.u / (A_EARTH * cosLat) * R2D;
        const dp1   = s1.w;                              // Pa/s
        const latH = lat + 0.5 * DT_SEC * dlat1;
        const lonH = lon + 0.5 * DT_SEC * dlon1;
        const pH   = p   + 0.5 * DT_SEC * dp1 / 100;     // Pa → hPa
        const s2 = this._sampleWind(latH, lonH, pH);
        if (!s2) return null;
        const dlat2 = s2.v / A_EARTH * R2D;
        const cosLatH = Math.max(0.05, Math.cos(latH * D2R));
        const dlon2 = s2.u / (A_EARTH * cosLatH) * R2D;
        const dp2   = s2.w;
        const newLat = lat + DT_SEC * dlat2;
        const newLon = lon + DT_SEC * dlon2;
        const newP   = p   + DT_SEC * dp2 / 100;
        // Wrap lon into [-180, 180].
        const wrappedLon = ((newLon + 180) % 360 + 360) % 360 - 180;
        return { lat: newLat, lon: wrappedLon, p: newP };
    }

    /** Advance all active parcels by one DT_HOURS step. Call each frame. */
    step(month) {
        if (!this._ensureCube(month)) return;
        for (let i = 0; i < N_MAX; i++) {
            if (!this.active[i]) continue;
            const next = this._rk2(this.lat[i], this.lon[i], this.press[i]);
            if (!next || Math.abs(next.lat) > 88 || next.p < LEVELS[0] || next.p > LEVELS[LEVELS.length - 1]) {
                this.active[i] = 0;
                continue;
            }
            this.lat[i]   = next.lat;
            this.lon[i]   = next.lon;
            this.press[i] = next.p;
            this.age[i]   += 1;
            if (this.age[i] > MAX_AGE_STEPS) { this.active[i] = 0; continue; }

            // Shift trail, add new head at index 0. Detect longitude wrap so
            // the trail doesn't stretch across the globe on the seam.
            const tx = i * TRAIL * 3;
            const oldX = this.trail[tx];
            const oldY = this.trail[tx + 1];
            const oldZ = this.trail[tx + 2];
            const [x, y, z] = this._project(next.lat, next.lon, next.p);
            const dx = x - oldX, dy = y - oldY, dz = z - oldZ;
            const wrapped = dx * dx + dy * dy + dz * dz > 0.5;
            if (wrapped) {
                for (let t = 0; t < TRAIL; t++) {
                    this.trail[tx + t * 3]     = x;
                    this.trail[tx + t * 3 + 1] = y;
                    this.trail[tx + t * 3 + 2] = z;
                }
                this.trailLen[i] = 1;
            } else {
                for (let t = TRAIL - 1; t > 0; t--) {
                    this.trail[tx + t * 3]     = this.trail[tx + (t - 1) * 3];
                    this.trail[tx + t * 3 + 1] = this.trail[tx + (t - 1) * 3 + 1];
                    this.trail[tx + t * 3 + 2] = this.trail[tx + (t - 1) * 3 + 2];
                }
                this.trail[tx]     = x;
                this.trail[tx + 1] = y;
                this.trail[tx + 2] = z;
                this.trailLen[i] = Math.min(TRAIL, this.trailLen[i] + 1);
            }
        }
        this._updateGeometry();
    }

    _updateGeometry() {
        const pos = this.positions, al = this.alphas;
        const segsPerParcel = TRAIL - 1;
        pos.fill(0);
        al.fill(0);
        for (let i = 0; i < N_MAX; i++) {
            if (!this.active[i]) { this.headAlpha[i] = 0; continue; }
            const tx = i * TRAIL * 3;
            const ox = i * segsPerParcel * 6;
            const ax = i * segsPerParcel * 2;
            const len = this.trailLen[i];
            const age = this.age[i];
            // Global fade envelope as the parcel approaches death.
            let lifeFade = 1;
            if (age > MAX_AGE_STEPS - FADE_STEPS) {
                lifeFade = Math.max(0, (MAX_AGE_STEPS - age) / FADE_STEPS);
            } else if (age < 2) {
                lifeFade = age / 2;
            }
            for (let t = 0; t < segsPerParcel; t++) {
                if (t >= len - 1) break;
                const k = ox + t * 6;
                const ak = ax + t * 2;
                pos[k]     = this.trail[tx + t * 3];
                pos[k + 1] = this.trail[tx + t * 3 + 1];
                pos[k + 2] = this.trail[tx + t * 3 + 2];
                pos[k + 3] = this.trail[tx + (t + 1) * 3];
                pos[k + 4] = this.trail[tx + (t + 1) * 3 + 1];
                pos[k + 5] = this.trail[tx + (t + 1) * 3 + 2];
                const headFade  = 1 - t / segsPerParcel;
                const headFade2 = 1 - (t + 1) / segsPerParcel;
                al[ak]     = lifeFade * headFade  * 0.95;
                al[ak + 1] = lifeFade * headFade2 * 0.95;
            }
            // Head dot at index 0 of trail.
            this.headPos[i * 3]     = this.trail[tx];
            this.headPos[i * 3 + 1] = this.trail[tx + 1];
            this.headPos[i * 3 + 2] = this.trail[tx + 2];
            this.headAlpha[i] = lifeFade;
        }
        this.geom.attributes.position.needsUpdate = true;
        this.geom.attributes.alpha.needsUpdate = true;
        this.headGeom.attributes.position.needsUpdate = true;
        this.headGeom.attributes.alpha.needsUpdate = true;
    }

    /** Re-project all trail positions when the view mode or month changes
     *  (so current radius encoding stays consistent). */
    onProjectionChanged() {
        for (let i = 0; i < N_MAX; i++) {
            if (!this.active[i]) continue;
            const [x, y, z] = this._project(this.lat[i], this.lon[i], this.press[i]);
            const tx = i * TRAIL * 3;
            for (let t = 0; t < TRAIL; t++) {
                this.trail[tx + t * 3]     = x;
                this.trail[tx + t * 3 + 1] = y;
                this.trail[tx + t * 3 + 2] = z;
            }
            this.trailLen[i] = 1;
        }
        this._updateGeometry();
    }

    /** Invalidate wind cube (e.g. on month change). */
    invalidateCube() {
        this._cacheMonth = null;
        this._uCube = this._vCube = this._wCube = null;
    }
}

export const PARCEL_SEED_PRESSURE_DEFAULT = 200;
