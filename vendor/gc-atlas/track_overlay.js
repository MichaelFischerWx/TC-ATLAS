// TC-ATLAS — IBTrACS track overlay for the vendored GC-ATLAS climatology globe.
//
// Renders best-track polylines on the globe sphere, colored per segment by
// the Saffir-Simpson category at the segment's start point. Used by the
// "Environment" tab in Global Archive.
//
// The lines use Line2/LineMaterial (already pulled in by globe.js) so the
// pixel width is honored on every platform — raw THREE.Line ignores the
// linewidth attribute on most drivers. We render at sphere radius 1.002 with
// depthWrite disabled, mirroring the offset used by barbs.js / the graticule
// to avoid z-fighting against the textured sphere.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { latLonToVec3, greatCircleArc } from './arc.js';

const TRACK_RADIUS = 1.002;
const SEGMENT_RES = 24;          // points per segment of the great-circle arc

// Saffir-Simpson palette — must match getIntensityColor() in global_archive.js.
function intensityColor(vmaxKt) {
    if (!vmaxKt && vmaxKt !== 0) return 0x6b7280;
    if (vmaxKt < 34)  return 0x60a5fa;
    if (vmaxKt < 64)  return 0x34d399;
    if (vmaxKt < 83)  return 0xfbbf24;
    if (vmaxKt < 96)  return 0xfb923c;
    if (vmaxKt < 113) return 0xf87171;
    if (vmaxKt < 137) return 0xef4444;
    return 0xdc2626;
}

export class TrackOverlay {
    /**
     * @param {THREE.Object3D} parent  The parent to attach to. For globe view
     *   this should be `globeApp.globeGroup` so tracks inherit the axial-tilt
     *   rotation and live in the same coordinate frame as the textured sphere.
     *   Attaching to `globeApp.scene` puts the tracks in world space, which
     *   visually misregisters them with the globe.
     */
    constructor(parent) {
        this.parent = parent;
        this.group = new THREE.Group();
        this.group.name = 'tc-track-overlay';
        this.parent.add(this.group);
        this._lines = [];           // Line2 instances (kept for dispose)
        this._materials = [];       // LineMaterials (need resolution updates)
        this._resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
        // Flat list of every (sid, fix) pair currently visible on the globe,
        // populated during render(). Hover-pick walks this once instead of
        // re-iterating + re-parsing dates across the full IBTrACS dict on
        // every mousemove (which was 76k Date constructions per move in
        // climatology view — the source of the hover lag).
        this.visibleFixes = [];
    }

    setVisible(visible) {
        this.group.visible = !!visible;
    }

    /**
     * Re-render all tracks active during (year, month).
     * @param {Object} allTracks  IBTrACS dict: SID → [{t, lat, lon, w, ...}]
     * @param {number} year       4-digit year, or null for "any year"
     * @param {number} month      1..12, or null for "all months"
     */
    render(allTracks, year, month) {
        this._clear();
        this.visibleFixes.length = 0;
        if (!allTracks) {
            console.log('[TrackOverlay] no allTracks');
            return;
        }

        const sids = Object.keys(allTracks);
        let kept = 0;
        for (let i = 0; i < sids.length; i++) {
            const sid = sids[i];
            const track = allTracks[sid];
            if (!track || track.length < 2) continue;

            // Filter to fixes within the (year, month) window. For year=null
            // we accept any year. For month=null we accept any month.
            let pts;
            if (year == null && month == null) {
                pts = track;
            } else {
                pts = [];
                for (let j = 0; j < track.length; j++) {
                    const p = track[j];
                    if (!p || !p.t) continue;
                    // IBTrACS timestamps in our JSON look like
                    // "2020-09-12T04:00" — no timezone designator. Per the
                    // ISO 8601 spec / ECMA-262, JS treats unsuffixed
                    // datetime strings as LOCAL time, which would shift
                    // every fix by the user's UTC offset and could push a
                    // fix into the wrong month near boundaries. Force UTC.
                    const dt = parseUTC(p.t);
                    const y = dt.getUTCFullYear();
                    const m = dt.getUTCMonth() + 1;
                    if (year != null && y !== year) continue;
                    if (month != null && m !== month) continue;
                    pts.push(p);
                }
            }
            if (pts.length < 2) continue;
            this._addTrackLine(pts);
            kept++;
            // Cache the (sid, fix) pairs that are visible on screen so the
            // hover-tooltip in climatology_globe.js can do nearest-neighbour
            // lookup over a small flat array instead of re-filtering the
            // whole IBTrACS dict on every mousemove.
            for (let k = 0; k < pts.length; k++) {
                if (_validLatLon(pts[k])) this.visibleFixes.push({ sid, p: pts[k] });
            }
        }
        console.log('[TrackOverlay] rendered', kept, 'tracks (year:', year, 'month:', month, '),', this.visibleFixes.length, 'fixes cached');
    }

    _addTrackLine(pts) {
        // Build per-vertex positions and colors. We render the full track as
        // one Line2 with per-vertex colors so segment coloring is "free" —
        // LineGeometry supports setColors() with three floats per vertex.
        //
        // IBTrACS schema (per global_archive.js): {t, la, lo, w, p, n}.
        // `la`/`lo` are latitude/longitude (NOT `lat`/`lon`); `w` is the
        // sustained wind speed in kt that drives the Saffir-Simpson color.
        const positions = [];
        const colors = [];
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            if (!_validLatLon(a) || !_validLatLon(b)) continue;
            const arc = greatCircleArc(a.la, a.lo, b.la, b.lo, SEGMENT_RES);
            const colorHex = intensityColor(a.w);
            const r = ((colorHex >> 16) & 0xff) / 255;
            const g = ((colorHex >>  8) & 0xff) / 255;
            const bl = ( colorHex        & 0xff) / 255;
            // Line2 wants every vertex except the first to be repeated
            // implicitly (it builds segments from consecutive points).
            // For our piecewise-colored polyline, the simplest approach is
            // to push every interpolated point on the arc.
            const startIdx = positions.length / 3;
            for (let k = 0; k < arc.length; k++) {
                const v = latLonToVec3(arc[k].lat, arc[k].lon).multiplyScalar(TRACK_RADIUS);
                positions.push(v.x, v.y, v.z);
                colors.push(r, g, bl);
            }
            // For the boundary between this segment and the next, the next
            // iteration pushes a fresh arc starting at b — which is the same
            // 3-D point as the current arc's last vertex. Drop the duplicate
            // by skipping the first vertex of the next arc... but that's
            // complicated to get right with the colors array. Easier: leave
            // the duplicate. Line2 handles colinear segments fine.
            void startIdx;
        }
        if (positions.length < 6) return;   // need at least 2 vertices

        const geom = new LineGeometry();
        geom.setPositions(positions);
        geom.setColors(colors);
        const mat = new LineMaterial({
            vertexColors: true,
            // Linewidth in CSS px. 1.4 was too thin to read against the
            // bright SST colormap on retina; 3.0 reads cleanly without
            // dominating the canvas.
            linewidth: 3.0,
            transparent: true,
            opacity: 0.95,
            // depthTest=true so the sphere's textured mesh occludes the
            // back-hemisphere portion of each track — without this, tracks
            // from the opposite side of the globe ghost through the front
            // and the view becomes confusing. depthWrite=false still keeps
            // tracks out of the depth buffer so the wind-particle / contour
            // overlays drawn after them don't z-fight.
            depthTest: true,
            depthWrite: false,
            resolution: this._resolution,
        });
        const line = new Line2(geom, mat);
        line.computeLineDistances();
        line.renderOrder = 5;                // draw after the sphere texture
        this.group.add(line);
        this._lines.push(line);
        this._materials.push(mat);
    }

    onResize(width, height) {
        this._resolution.set(width, height);
        for (let i = 0; i < this._materials.length; i++) {
            this._materials[i].resolution.copy(this._resolution);
        }
    }

    _clear() {
        for (let i = 0; i < this._lines.length; i++) {
            const l = this._lines[i];
            this.group.remove(l);
            if (l.geometry) l.geometry.dispose();
            if (l.material) l.material.dispose();
        }
        this._lines.length = 0;
        this._materials.length = 0;
    }

    dispose() {
        this._clear();
        if (this.group.parent) this.group.parent.remove(this.group);
    }
}

function _validLatLon(p) {
    return p && Number.isFinite(p.la) && Number.isFinite(p.lo);
}

// IBTrACS timestamps in our chunked JSON have no timezone designator
// ("2020-09-12T04:00"). ISO 8601 / ECMA-262 say bare datetime strings
// are LOCAL time, so `new Date(t).getUTCHours()` returns 4-hours-off in
// EDT and could even cross month boundaries. Force a 'Z' suffix when one
// isn't present. Numeric (unix-ms) inputs and strings that already carry
// a +HH:MM / -HH:MM / Z designator pass through untouched.
export function parseUTC(t) {
    if (t == null) return null;
    if (typeof t === 'number') return new Date(t);
    const s = String(t);
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
    return new Date(s + 'Z');
}
