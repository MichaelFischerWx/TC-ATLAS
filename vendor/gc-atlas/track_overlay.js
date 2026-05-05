// TC-ATLAS — IBTrACS track overlay for the vendored GC-ATLAS climatology globe.
//
// Renders best-track polylines on the globe sphere, colored per segment by
// the Saffir-Simpson category at the segment's start point. Used by the
// "Environment" tab in Global Archive.
//
// All visible tracks are merged into a single LineSegments2 with per-vertex
// colors, so the GPU draws every track in ONE draw call regardless of how
// many storms are on screen. The previous implementation built one Line2
// per storm, which meant ~hundreds of draw calls per frame on busy months
// and made orbit/zoom feel laggy on the climatology globe.
//
// We render at sphere radius 1.002 with depthWrite disabled, mirroring the
// offset used by barbs.js / the graticule to avoid z-fighting against the
// textured sphere.

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { latLonToVec3, greatCircleArc } from './arc.js';

const TRACK_RADIUS = 1.002;
// Sub-points per fix-to-fix step. IBTrACS fixes are 6-hourly (~150–500 km
// apart for typical storm speeds), short enough that a straight chord on
// the sphere is visually indistinguishable from a great-circle arc at
// globe-view zoom. SEGMENT_RES=1 → no interpolation = one GPU segment per
// fix-step. Was 24, which spent ~95% of the GPU budget on micro-arcs that
// didn't change a pixel — the dominant lag source for big composites
// (30 yr × all months ≈ 2 M segments → ~96 k segments here).
const SEGMENT_RES = 1;

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
        this._mergedLine = null;     // single LineSegments2 holding ALL tracks
        this._mergedMaterial = null; // its LineMaterial (needs resolution updates)
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
     * @param {number|number[]|null} year
     *        4-digit year, an array of 4-digit years (composite year set),
     *        or null for "any year"
     * @param {number|null} month  1..12, or null for "all months"
     */
    render(allTracks, year, month) {
        this._clear();
        this.visibleFixes.length = 0;
        if (!allTracks) {
            console.log('[TrackOverlay] no allTracks');
            return;
        }

        // Normalize year filter into a Set for O(1) lookup. Single integer
        // or array both end up here. null = no year filter.
        let yearSet = null;
        if (Array.isArray(year)) {
            if (year.length === 0) {
                console.log('[TrackOverlay] empty year-list filter — nothing to render');
                return;
            }
            yearSet = new Set(year);
        } else if (year != null) {
            yearSet = new Set([year]);
        }

        const sids = Object.keys(allTracks);
        let kept = 0;
        // Pre-allocate growable typed-array surrogates. We don't know total
        // length up front; plain arrays + Float32Array.from() at the end is
        // both simpler and fast enough.
        const allPositions = [];
        const allColors    = [];

        for (let i = 0; i < sids.length; i++) {
            const sid = sids[i];
            const track = allTracks[sid];
            if (!track || track.length < 2) continue;

            // Filter to fixes within the (year, month) window. For year=null
            // we accept any year. For month=null we accept any month.
            // Prefer the pre-computed `_y` / `_m` integers attached at load
            // time (climatology_globe.js#_annotateTracks); fall back to a
            // live parseUTC for compatibility with un-annotated callers.
            let pts;
            if (yearSet == null && month == null) {
                pts = track;
            } else {
                pts = [];
                for (let j = 0; j < track.length; j++) {
                    const p = track[j];
                    if (!p) continue;
                    let y = p._y, m = p._m;
                    if (y == null) {
                        if (!p.t) continue;
                        const dt = parseUTC(p.t);
                        y = dt.getUTCFullYear();
                        m = dt.getUTCMonth() + 1;
                    }
                    if (yearSet != null && !yearSet.has(y)) continue;
                    if (month != null && m !== month) continue;
                    pts.push(p);
                }
            }
            if (pts.length < 2) continue;
            this._appendTrackSegments(pts, allPositions, allColors);
            kept++;
            // Cache the (sid, fix) pairs that are visible on screen so the
            // hover-tooltip in climatology_globe.js can do nearest-neighbour
            // lookup over a small flat array instead of re-filtering the
            // whole IBTrACS dict on every mousemove.
            for (let k = 0; k < pts.length; k++) {
                if (_validLatLon(pts[k])) this.visibleFixes.push({ sid, p: pts[k] });
            }
        }

        if (allPositions.length >= 6) this._buildMergedLine(allPositions, allColors);
        console.log('[TrackOverlay] rendered', kept, 'tracks',
                    '(year:', year, 'month:', month, '),',
                    this.visibleFixes.length, 'fixes cached,',
                    Math.round(allPositions.length / 6), 'segments');
    }

    // Append this storm's track to the shared positions/colors arrays in
    // LineSegments2 format: each pair of consecutive vertices is an
    // independent line segment, so storm-to-storm boundaries don't get
    // spurious connecting lines.
    _appendTrackSegments(pts, positions, colors) {
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            if (!_validLatLon(a) || !_validLatLon(b)) continue;
            const arc = greatCircleArc(a.la, a.lo, b.la, b.lo, SEGMENT_RES);
            const colorHex = intensityColor(a.w);
            const r  = ((colorHex >> 16) & 0xff) / 255;
            const g  = ((colorHex >>  8) & 0xff) / 255;
            const bl = ( colorHex        & 0xff) / 255;
            // LineSegments2 wants vertex pairs: (v0,v1), (v1,v2), ... so each
            // interior vertex is duplicated. The cost is ~2× memory but only
            // 1 draw call vs N (one per storm) which dominates render time
            // on the climatology globe.
            for (let k = 0; k < arc.length - 1; k++) {
                const v0 = latLonToVec3(arc[k].lat,     arc[k].lon).multiplyScalar(TRACK_RADIUS);
                const v1 = latLonToVec3(arc[k + 1].lat, arc[k + 1].lon).multiplyScalar(TRACK_RADIUS);
                positions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z);
                colors.push(r, g, bl, r, g, bl);
            }
        }
    }

    _buildMergedLine(positions, colors) {
        const geom = new LineSegmentsGeometry();
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
        const lineSegs = new LineSegments2(geom, mat);
        lineSegs.renderOrder = 5;             // draw after the sphere texture
        this.group.add(lineSegs);
        this._mergedLine = lineSegs;
        this._mergedMaterial = mat;
    }

    onResize(width, height) {
        this._resolution.set(width, height);
        if (this._mergedMaterial) this._mergedMaterial.resolution.copy(this._resolution);
    }

    _clear() {
        if (this._mergedLine) {
            this.group.remove(this._mergedLine);
            if (this._mergedLine.geometry) this._mergedLine.geometry.dispose();
            if (this._mergedLine.material) this._mergedLine.material.dispose();
        }
        this._mergedLine = null;
        this._mergedMaterial = null;
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
