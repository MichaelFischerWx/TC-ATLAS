// GC-ATLAS — great-circle geometry helpers.
//
// Interpolates between two points on a unit sphere via spherical linear
// interpolation (slerp), used for the click-drag cross-section arc and its
// on-globe visualisation.

import * as THREE from 'three';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const EARTH_R_KM = 6371;

/** (lat, lon) in degrees → unit Vector3 matching globe's projection convention. */
export function latLonToVec3(lat, lon) {
    const phi = lat * D2R, lam = lon * D2R;
    return new THREE.Vector3(
        Math.cos(phi) * Math.sin(lam),
        Math.sin(phi),
        Math.cos(phi) * Math.cos(lam),
    );
}

/** Unit Vector3 on the sphere → { lat, lon } in degrees. */
export function vec3ToLatLon(v) {
    const n = v.length() || 1;
    return {
        lat: Math.asin(v.y / n) * R2D,
        lon: Math.atan2(v.x, v.z) * R2D,
    };
}

/** Great-circle distance between two (lat, lon) points, in km. */
export function gcDistanceKm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * D2R;
    const dLon = (lon2 - lon1) * D2R;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Interpolate n+1 points along the minor great-circle arc from (lat1, lon1)
 * to (lat2, lon2). Returns an array of { lat, lon }. For identical endpoints
 * returns a single point. Uses slerp for numerical stability on short arcs.
 */
/**
 * Linear-in-(lat, lon) interpolation between two points. Unlike the
 * great-circle arc, this traces a line that's STRAIGHT on an
 * equirectangular map projection — useful for map-view cross-sections
 * where "straight on the map" is what the user expects. Handles the
 * longitude seam by picking the shortest direction (|Δlon| ≤ 180°).
 */
export function linearLatLonArc(lat1, lon1, lat2, lon2, nSegments = 128) {
    let dlon = lon2 - lon1;
    if (dlon >  180) dlon -= 360;
    if (dlon < -180) dlon += 360;
    const out = [];
    for (let i = 0; i <= nSegments; i++) {
        const t = i / nSegments;
        out.push({
            lat: lat1 + t * (lat2 - lat1),
            lon: ((lon1 + t * dlon + 540) % 360) - 180,
        });
    }
    return out;
}

export function greatCircleArc(lat1, lon1, lat2, lon2, nSegments = 128) {
    const v1 = latLonToVec3(lat1, lon1);
    const v2 = latLonToVec3(lat2, lon2);
    const cosT = Math.max(-1, Math.min(1, v1.dot(v2)));
    const theta = Math.acos(cosT);
    const out = [];
    if (theta < 1e-6) { out.push({ lat: lat1, lon: lon1 }); return out; }
    const sinT = Math.sin(theta);
    for (let i = 0; i <= nSegments; i++) {
        const t = i / nSegments;
        const a = Math.sin((1 - t) * theta) / sinT;
        const b = Math.sin(t * theta) / sinT;
        const v = new THREE.Vector3(
            a * v1.x + b * v2.x,
            a * v1.y + b * v2.y,
            a * v1.z + b * v2.z,
        ).normalize();
        out.push(vec3ToLatLon(v));
    }
    return out;
}

/**
 * Great-circle midpoint of two (lat, lon) points — half-way between them
 * along the minor great-circle arc. Used when the cross-section arc is
 * auto-derived (mid not pinned by the user).
 */
export function greatCircleMidpoint(lat1, lon1, lat2, lon2) {
    const v = latLonToVec3(lat1, lon1).add(latLonToVec3(lat2, lon2));
    if (v.lengthSq() < 1e-12) return { lat: lat1, lon: lon1 };
    return vec3ToLatLon(v.normalize());
}

/** Linear-lat/lon midpoint — same seam-aware logic as linearLatLonArc. */
export function linearLatLonMidpoint(lat1, lon1, lat2, lon2) {
    let dlon = lon2 - lon1;
    if (dlon >  180) dlon -= 360;
    if (dlon < -180) dlon += 360;
    return {
        lat: (lat1 + lat2) / 2,
        lon: ((lon1 + dlon / 2 + 540) % 360) - 180,
    };
}

/**
 * Three-point arc — a smooth quadratic Bezier that passes through `start`,
 * `mid`, and `end` at parameter values t = 0, 0.5, 1 respectively. The
 * Bezier is C¹-continuous (no kink at the midpoint) and collapses to the
 * straight start→end arc when `mid` is the geodesic midpoint, so the
 * shape stays intuitive whether the user has pinned the middle or not.
 *
 * Math: for B(t) = (1−t)²P₀ + 2(1−t)t P₁ + t²P₂,  B(0.5) = ¼P₀ + ½P₁ + ¼P₂.
 * Solving B(0.5) = mid gives the control point P₁ = 2·mid − ½(P₀ + P₂),
 * i.e. the mid is a pass-through waypoint rather than a pull target.
 *
 * `kind = 'gc'`    — sample in 3D (unit vectors), normalize each Bezier
 *                    sample back to the sphere and convert to (lat, lon).
 *                    Degenerates to a great-circle arc when mid is on the
 *                    geodesic.
 * `kind = 'linear'` — sample the Bezier directly in (lat, lon) with the
 *                    same shortest-longitude wrap used by linearLatLonArc.
 */
export function threePointArc(start, mid, end, nSegments = 128, { kind = 'gc' } = {}) {
    const N = Math.max(2, nSegments);
    const out = [];
    if (kind === 'linear') {
        // Shortest-longitude deltas so the curve follows the ±180° seam
        // correctly — same logic as linearLatLonArc.
        let dlonM = mid.lon  - start.lon;
        let dlonE = end.lon  - start.lon;
        if (dlonM >  180) dlonM -= 360;
        if (dlonM < -180) dlonM += 360;
        if (dlonE >  180) dlonE -= 360;
        if (dlonE < -180) dlonE += 360;
        const midLonAbs = start.lon + dlonM;
        const endLonAbs = start.lon + dlonE;
        // P₁ in unwrapped (lat, lon) space.
        const p1Lat = 2 * mid.lat - 0.5 * (start.lat + end.lat);
        const p1Lon = 2 * midLonAbs - 0.5 * (start.lon + endLonAbs);
        for (let i = 0; i <= N; i++) {
            const t = i / N;
            const u = 1 - t;
            const lat = u * u * start.lat + 2 * u * t * p1Lat + t * t * end.lat;
            const lon = u * u * start.lon + 2 * u * t * p1Lon + t * t * endLonAbs;
            out.push({ lat, lon: ((lon + 540) % 360) - 180 });
        }
        return out;
    }
    // Globe / great-circle: 3D quadratic Bezier on unit vectors, then
    // normalize each sample back onto the sphere.
    const P0 = latLonToVec3(start.lat, start.lon);
    const P2 = latLonToVec3(end.lat,   end.lon);
    const M  = latLonToVec3(mid.lat,   mid.lon);
    const P1 = new THREE.Vector3(
        2 * M.x - 0.5 * (P0.x + P2.x),
        2 * M.y - 0.5 * (P0.y + P2.y),
        2 * M.z - 0.5 * (P0.z + P2.z),
    );
    const tmp = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
        const t = i / N;
        const u = 1 - t;
        const w0 = u * u, w1 = 2 * u * t, w2 = t * t;
        tmp.set(
            w0 * P0.x + w1 * P1.x + w2 * P2.x,
            w0 * P0.y + w1 * P1.y + w2 * P2.y,
            w0 * P0.z + w1 * P1.z + w2 * P2.z,
        );
        // Projecting a 3D Bezier back to the sphere via normalize() is the
        // simplest way to get a smooth sphere-embedded curve. For our
        // midpoint displacements (typically < half a hemisphere) the
        // parameterization stays well-behaved.
        if (tmp.lengthSq() < 1e-12) continue;
        tmp.normalize();
        out.push(vec3ToLatLon(tmp));
    }
    return out;
}

/** Total along-path distance of a sampled arc (km). For curved / pinned-
 *  midpoint arcs this is longer than the endpoint-to-endpoint great-circle
 *  distance — the cross-section x-axis label should reflect the actual
 *  path length, not the shortcut. */
export function arcPathLengthKm(arc) {
    let total = 0;
    for (let i = 1; i < arc.length; i++) {
        total += gcDistanceKm(arc[i - 1].lat, arc[i - 1].lon, arc[i].lat, arc[i].lon);
    }
    return total;
}
