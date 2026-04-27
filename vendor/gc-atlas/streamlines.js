// GC-ATLAS — static streamlines overlay.
// Seeds points uniformly on the sphere, integrates each forward on the (u, v)
// wind field using RK2, and renders each streamline as a single Line2 object
// so the shader handles mitered joins between segments — the result reads as
// one continuous curve, matching the plt.streamplot aesthetic. Thick strokes
// via LineMaterial (WebGL's built-in gl.lineWidth is clamped to 1 px).

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const N_SEEDS       = 1600;
const STEPS         = 90;
const STEP_SIZE     = 0.004;
const RADIUS        = 1.006;
const POLE_MASK     = 83;
const LINE_WIDTH    = 3.0;     // CSS pixels
const OPACITY       = 0.95;
const ARROW_LEN     = 0.028;   // arrow-head length (world units, globe radius = 1)
const ARROW_RAD     = 0.009;   // arrow-head base radius
const ARROW_EVERY_N = 22;      // place an arrow every N trace points
const MAX_ARROWS    = 7000;

const D2R = Math.PI / 180;

export class StreamlineField {
    constructor(getUV, projectFn) {
        this.getUV = getUV;
        this.project = projectFn || ((lat, lon, r) => {
            const phi = lat * D2R, lam = lon * D2R;
            return new THREE.Vector3(
                r * Math.cos(phi) * Math.sin(lam),
                r * Math.sin(phi),
                r * Math.cos(phi) * Math.cos(lam),
            );
        });

        this.object = new THREE.Group();
        this.object.frustumCulled = false;

        this.material = new LineMaterial({
            color: 0xffffff,
            linewidth: LINE_WIDTH,
            worldUnits: false,
            transparent: true,
            opacity: OPACITY,
            depthWrite: false,
            // LineMaterial's linewidth is in CSS pixels — use CSS resolution
            // (not physical) so the shader's scale factor matches.
            resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
        });

        // Arrow heads: a single InstancedMesh of tiny cones, one per
        // streamline, placed at the midpoint oriented along the flow.
        const coneGeom = new THREE.ConeGeometry(ARROW_RAD, ARROW_LEN, 5, 1);
        // Shift so the base is at the origin and the tip points +Y.
        coneGeom.translate(0, ARROW_LEN / 2, 0);
        const coneMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.95,
            depthWrite: false,
        });
        this.arrows = new THREE.InstancedMesh(coneGeom, coneMat, MAX_ARROWS);
        this.arrows.count = 0;
        this.arrows.frustumCulled = false;
        this.object.add(this.arrows);

        this.rebuild();
    }

    setVisible(v) { this.object.visible = v; }
    updateResolution(w, h) { this.material.resolution.set(w, h); }

    seedPoint() {
        while (true) {
            const u = Math.random();
            const v = Math.random();
            const phi = Math.acos(2 * v - 1);
            const lat = 90 - (phi * 180 / Math.PI);
            if (Math.abs(lat) <= POLE_MASK) {
                const lon = (u * 360) - 180;
                return [lat, lon];
            }
        }
    }

    integrate(lat, lon) {
        const trace = [[lat, lon]];
        for (let s = 0; s < STEPS; s++) {
            const uv0 = this.getUV(lat, lon);
            if (!uv0 || !Number.isFinite(uv0[0]) || !Number.isFinite(uv0[1])) break;
            const [u0, v0] = uv0;

            const halfLat = lat + v0 * STEP_SIZE * 0.5;
            const halfLon = lon + u0 * STEP_SIZE * 0.5 / Math.max(0.08, Math.cos(lat * D2R));
            const uvm = this.getUV(halfLat, halfLon);
            if (!uvm || !Number.isFinite(uvm[0]) || !Number.isFinite(uvm[1])) break;
            const [um, vm] = uvm;

            lat += vm * STEP_SIZE;
            lon += um * STEP_SIZE / Math.max(0.08, Math.cos(lat * D2R));

            if (Math.abs(lat) > POLE_MASK) break;
            if (lon > 180)       lon -= 360;
            else if (lon < -180) lon += 360;

            trace.push([lat, lon]);
        }
        return trace;
    }

    /** Split a (lat, lon) trace into contiguous sub-traces at dateline wraps. */
    splitOnDateline(trace) {
        const segments = [];
        let current = [trace[0]];
        for (let i = 1; i < trace.length; i++) {
            const [aLat, aLon] = trace[i - 1];
            const [bLat, bLon] = trace[i];
            if (Math.abs(aLon - bLon) > 180) {
                if (current.length >= 2) segments.push(current);
                current = [trace[i]];
            } else {
                current.push(trace[i]);
            }
        }
        if (current.length >= 2) segments.push(current);
        return segments;
    }

    rebuild() {
        // Dispose old Line2 geometries; keep the InstancedMesh attached.
        for (const child of this.object.children.slice()) {
            if (child === this.arrows) continue;
            if (child.geometry) child.geometry.dispose();
            this.object.remove(child);
        }

        const mat = new THREE.Matrix4();
        const q   = new THREE.Quaternion();
        const up  = new THREE.Vector3(0, 1, 0);
        const scl = new THREE.Vector3(1, 1, 1);
        const dir = new THREE.Vector3();
        let arrowIdx = 0;

        for (let s = 0; s < N_SEEDS; s++) {
            const [lat0, lon0] = this.seedPoint();
            const trace = this.integrate(lat0, lon0);
            if (trace.length < 2) continue;

            const subTraces = this.splitOnDateline(trace);
            for (const sub of subTraces) {
                const positions = [];
                for (const [lat, lon] of sub) {
                    const p = this.project(lat, lon, RADIUS);
                    positions.push(p.x, p.y, p.z);
                }
                const geom = new LineGeometry();
                geom.setPositions(positions);
                const line = new Line2(geom, this.material);
                line.computeLineDistances();
                line.frustumCulled = false;
                this.object.add(line);

                // Drop an arrow every ARROW_EVERY_N points — fast streamlines
                // (which cover more distance per step) get multiple arrows
                // along their length so the flow direction stays visible.
                for (let j = Math.floor(ARROW_EVERY_N / 2);
                     j < sub.length - 1 && arrowIdx < MAX_ARROWS;
                     j += ARROW_EVERY_N) {
                    const [aLat, aLon] = sub[j];
                    const [bLat, bLon] = sub[j + 1];
                    const pA = this.project(aLat, aLon, RADIUS + 0.003);
                    const pB = this.project(bLat, bLon, RADIUS + 0.003);
                    dir.subVectors(pB, pA);
                    if (dir.lengthSq() > 1e-8) {
                        dir.normalize();
                        q.setFromUnitVectors(up, dir);
                        mat.compose(pA, q, scl);
                        this.arrows.setMatrixAt(arrowIdx++, mat);
                    }
                }
            }
        }
        this.arrows.count = arrowIdx;
        this.arrows.instanceMatrix.needsUpdate = true;
    }

    onProjectionChanged() { this.rebuild(); }
    refresh()             { this.rebuild(); }
}
