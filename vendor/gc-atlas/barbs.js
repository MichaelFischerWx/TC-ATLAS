// GC-ATLAS — wind barb overlay (standard WMO glyphs).
//
// At each sample point on a regular (lat, lon) grid we draw a meteorological
// wind barb: shaft pointing from the station toward the upwind direction,
// with feathers and pennants on the left side encoding speed.
//
//   Full feather  = 10 kt  (≈ 5.14 m/s)
//   Half feather  =  5 kt  (≈ 2.57 m/s)
//   Pennant       = 50 kt  (filled triangle)
//
// Rebuilt whenever the wind field or projection changes; cheap enough
// (~1000 barbs × 3–6 segments) to dispose and regenerate per frame of
// user input. All lines go into one LineSegments2 (screen-space-width
// anti-aliased polylines via three/addons/lines/*) and all pennants
// into one Mesh, so the whole overlay still renders in two draw calls.
// LineSegments2 replaces the older LineBasicMaterial + THREE.LineSegments
// pairing so we get real pixel-width strokes on HiDPI displays instead
// of the 1-physical-pixel look that read as "cheap" at high DPR.

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const LAT_STEP   = 8;        // degrees between barb rows
const LON_STEP   = 8;        // degrees between barb columns
const POLE_LIMIT = 82;       // clip rows near the poles (barb density diverges there)

const MS_TO_KT   = 1.94384;
const KT_PENNANT = 50;
const KT_FULL    = 10;
const KT_HALF    = 5;

// Barb geometry — retuned to match the packing density in published
// analysis charts (Tropical Tidbits, WPC, etc.). The earlier values
// gave each feather a ~40%-of-length gap after it, which read as a
// stretched-out, sparse glyph. The new spacing is closer to 20% of
// feather length so multiple feathers cluster tightly near the tail.
const L_SHAFT    = 0.060;    // world units
const L_FEATHER  = 0.024;
const L_HALF     = 0.012;
const SPACING    = 0.005;    // along-shaft gap between glyphs (was 0.011)
const PENNANT_W  = 0.010;    // base of pennant triangle along shaft

const RADIUS_SPHERE = 1.006;
const MAP_LIFT      = 0.003;

const D2R = Math.PI / 180;

export class BarbField {
    constructor(getUV, projectFn) {
        this.getUV = getUV;
        this.project = projectFn;
        this._viewMode = 'globe';

        this.object = new THREE.Group();
        this.object.frustumCulled = false;

        // Cream-tinted "print ink" colour — reads warmer than stark white
        // and sits better over the saturated regions of the colormap.
        const INK = 0xF4F0E0;
        this.lineMat = new LineMaterial({
            color: INK,
            linewidth: 1.8,           // screen-space pixels (worldUnits:false)
            worldUnits: false,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
            resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
        });
        this.pennantMat = new THREE.MeshBasicMaterial({
            color: INK, transparent: true, opacity: 0.88, depthWrite: false,
            side: THREE.DoubleSide,
        });
    }

    setVisible(v) { this.object.visible = v; }
    // Called on window resize — Line2 / LineSegments2 need current screen
    // resolution to compute their pixel-space width correctly.
    updateResolution(w, h) {
        if (this.lineMat && this.lineMat.resolution) {
            this.lineMat.resolution.set(w, h);
        }
    }
    onProjectionChanged() { this.rebuild(this._viewMode); }
    refresh()             { this.rebuild(this._viewMode); }

    rebuild(viewMode = 'globe') {
        this._viewMode = viewMode;
        this._clear();

        const segs = [];      // flat xyz*2 per line
        const tris = [];      // flat xyz*3 per triangle

        for (let lat = -POLE_LIMIT; lat <= POLE_LIMIT; lat += LAT_STEP) {
            // Thin barbs toward the poles so density stays rough-ish uniform.
            // Integer count per row so the step evenly divides 360° — without
            // this, a latitude like 16°N (rawStep ≈ 8.32°) leaves a ~2.2°
            // "leftover" near the dateline that packs an extra barb right
            // next to the one at lon=-180°. Across consecutive latitudes
            // those extras align into a visible vertical comb.
            const rawStep = Math.min(30, LON_STEP / Math.max(0.1, Math.cos(lat * D2R)));
            const nLons   = Math.max(3, Math.round(360 / rawStep));
            const lonStep = 360 / nLons;
            for (let i = 0; i < nLons; i++) {
                const lon = -180 + i * lonStep;
                const uv = this.getUV(lat, lon);
                if (!uv) continue;
                const [u, v] = uv;
                const sp = Math.sqrt(u * u + v * v);
                if (sp < 1.5) continue;   // < 3 kt, treat as calm
                this._addBarb(lat, lon, u, v, sp, segs, tris, viewMode);
            }
        }

        if (segs.length) {
            // LineSegmentsGeometry consumes a flat xyz*2-per-segment array via
            // setPositions(), same shape we built up above.
            const g = new LineSegmentsGeometry();
            g.setPositions(segs);
            const lines = new LineSegments2(g, this.lineMat);
            lines.computeLineDistances();
            lines.renderOrder = 5;
            lines.frustumCulled = false;
            this.object.add(lines);
        }
        if (tris.length) {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
            const mesh = new THREE.Mesh(g, this.pennantMat);
            mesh.renderOrder = 5;
            this.object.add(mesh);
        }
    }

    _clear() {
        for (const child of this.object.children) {
            child.geometry?.dispose();
        }
        this.object.clear();
    }

    _addBarb(lat, lon, u, v, speedMps, segs, tris, viewMode) {
        const isMap = viewMode === 'map';
        const R = isMap ? 1 + MAP_LIFT : RADIUS_SPHERE;
        const P = this.project(lat, lon, R);

        // Tangent basis at (lat, lon). On the flat map the tangent plane is
        // just the XY plane; on the sphere we build it from lat/lon.
        let east, north, normal;
        if (isMap) {
            east   = new THREE.Vector3(1, 0, 0);
            north  = new THREE.Vector3(0, 1, 0);
            normal = new THREE.Vector3(0, 0, 1);
        } else {
            const phi = lat * D2R;
            const lam = lon * D2R;
            east = new THREE.Vector3(Math.cos(lam), 0, -Math.sin(lam));
            north = new THREE.Vector3(
                -Math.sin(phi) * Math.sin(lam),
                 Math.cos(phi),
                -Math.sin(phi) * Math.cos(lam),
            );
            normal = new THREE.Vector3(
                Math.cos(phi) * Math.sin(lam),
                Math.sin(phi),
                Math.cos(phi) * Math.cos(lam),
            );
        }

        // Wind direction (3D unit vector in the tangent plane).
        const wind = east.clone().multiplyScalar(u)
                    .add(north.clone().multiplyScalar(v))
                    .normalize();
        // Shaft points from the station toward the upwind direction.
        const shaft = wind.clone().negate();
        const tail = P.clone().add(shaft.clone().multiplyScalar(L_SHAFT));

        // On the map, skip barbs whose shaft would straddle the wrap seam —
        // otherwise the LineSegment would stretch clear across the viewport.
        if (isMap && Math.abs(tail.x - P.x) > 2.0) return;

        // Shaft line.
        segs.push(P.x, P.y, P.z, tail.x, tail.y, tail.z);

        // Speed decomposition.
        let kt = speedMps * MS_TO_KT;
        const nPen  = Math.floor(kt / KT_PENNANT);  kt -= nPen  * KT_PENNANT;
        const nFull = Math.floor(kt / KT_FULL);     kt -= nFull * KT_FULL;
        const nHalf = kt >= KT_HALF - 0.5 ? 1 : 0;

        // Feathers are placed on the LEFT of the shaft (viewed from the
        // station looking toward the tail, i.e. upwind) — standard NH WMO
        // convention. With our coord system that's `shaft × normal`; the
        // opposite handedness (`normal × shaft`) puts them on the wrong side.
        const left = shaft.clone().cross(normal).normalize();
        // Step back toward the station after each glyph.
        const backStep = shaft.clone().negate();  // unit vector
        let pos = tail.clone();

        // Pennants first (closest to the tail), each consuming PENNANT_W + SPACING/2 along shaft.
        for (let i = 0; i < nPen; i++) {
            const base2 = pos.clone().add(backStep.clone().multiplyScalar(PENNANT_W));
            const tip   = pos.clone().add(left.clone().multiplyScalar(L_FEATHER));
            tris.push(pos.x, pos.y, pos.z);
            tris.push(base2.x, base2.y, base2.z);
            tris.push(tip.x, tip.y, tip.z);
            pos = pos.add(backStep.clone().multiplyScalar(PENNANT_W + SPACING * 0.5));
        }
        // Full feathers.
        for (let i = 0; i < nFull; i++) {
            const tip = pos.clone().add(left.clone().multiplyScalar(L_FEATHER));
            segs.push(pos.x, pos.y, pos.z, tip.x, tip.y, tip.z);
            pos = pos.add(backStep.clone().multiplyScalar(SPACING));
        }
        // Half feather, set back slightly from the nearest full feather so it
        // doesn't overlap the previous one.
        if (nHalf) {
            if (nFull === 0) pos = pos.add(backStep.clone().multiplyScalar(SPACING));
            const tip = pos.clone().add(left.clone().multiplyScalar(L_HALF));
            segs.push(pos.x, pos.y, pos.z, tip.x, tip.y, tip.z);
        }
    }
}
