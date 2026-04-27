// GC-ATLAS — sun marker + zonal-mean daylight shading.
//
// The shaded field is a MONTHLY CLIMATOLOGY, so a rotating hemispherical
// terminator would be misleading — it would imply that some longitudes are
// in perpetual daylight / darkness, when in reality Earth rotates under the
// sun every 24 h and the right pedagogical quantity is the *fraction of the
// day each latitude is sunlit averaged over the month*.
//
// So we shade zonally: the darkening at each surface point depends only on
// its geographic latitude φ and the current solar declination δ, via the
// standard polar-night / polar-day formula
//     cos h₀ = −tan φ · tan δ
// where h₀ ∈ [0, π] is the half-day hour-angle. daylight_fraction = h₀ / π.
// We darken the *winter* hemisphere only (daylight < 0.5), peaking at the
// polar night. The summer hemisphere is left untouched so the seasonal
// asymmetry reads as one-sided shading rather than a confusing gradient.
//
// The sun sprite remains as a reference marker: its height above the
// ecliptic tells you the subsolar latitude for the current month. We keep
// it on the XZ plane (a simple visual "where the sun is this month") — its
// longitude is cosmetic and doesn't interact with the zonal shading at all.

import * as THREE from 'three';

const SUN_DIST  = 5.5;   // world units — reads as "far" without leaving the frustum
const SUN_SIZE  = 0.55;
const SHADOW_R  = 1.003; // just above contours so the shading mutes everything below
const AXIAL_TILT = 23.4 * Math.PI / 180;

// World-space unit vector pointing to Earth's geographic north pole. The
// globeGroup is rotated by +AXIAL_TILT about +Z, so the local +Y pole vector
// ends up at (-sin, cos, 0) in world coords.
const AXIS_WORLD = new THREE.Vector3(
    -Math.sin(AXIAL_TILT), Math.cos(AXIAL_TILT), 0,
);

/**
 * Month ∈ [1..12]. Returns a unit vector from Earth's centre toward the sun,
 * assuming the ecliptic is the world XZ plane and Earth's axial tilt is a
 * +23.4° rotation about +Z. Dec solstice → +X, Jun solstice → −X.
 */
export function sunDirection(month) {
    const theta = month * Math.PI / 6;   // 30° per month; Dec=12 ≡ 0
    return new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
}

/**
 * Solar declination δ for a given month. Derived from sunDirection(month)
 * projected onto Earth's tilted geographic frame:
 *     sin δ = (sunDir rotated by −AXIAL_TILT about +Z).y
 *           = −sin(tilt) · cos(30°·m)
 * which peaks at ±23.4° at the solstices and passes through 0 at the
 * equinoxes, as it should.
 */
export function solarDeclination(month) {
    const theta = month * Math.PI / 6;
    return Math.asin(-Math.sin(AXIAL_TILT) * Math.cos(theta));
}

function makeSunTexture() {
    const size = 128, r = size / 2;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0.00, 'rgba(255, 244, 200, 1.00)');
    g.addColorStop(0.30, 'rgba(255, 214, 118, 0.95)');
    g.addColorStop(0.65, 'rgba(255, 170, 70,  0.35)');
    g.addColorStop(1.00, 'rgba(255, 150, 40,  0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

const TERM_VERT = /* glsl */`
    varying vec3 vNormal;
    void main() {
        vNormal = normalize(position);   // sphere at world origin → world-space normal
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

// Zonal daylight-fraction darkening. sinLat is the dot product of the surface
// normal with Earth's geographic axis (world-space) — so the shader doesn't
// care which longitude it's at, only its geographic latitude. The winter
// hemisphere darkens continuously from 0 (no effect) at the subsolar-latitude
// "daylight border" to uOpacity at polar night.
const TERM_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  uAxis;        // world-space geographic north
    uniform float uSinDec;      // sin(solar declination)
    uniform float uOpacity;
    varying vec3 vNormal;

    void main() {
        float sinLat = dot(vNormal, uAxis);
        float cosLat = sqrt(max(0.0, 1.0 - sinLat * sinLat));
        float tanLat = sinLat / max(cosLat, 1e-4);

        float sinDec = uSinDec;
        float cosDec = sqrt(max(0.0, 1.0 - sinDec * sinDec));
        float tanDec = sinDec / max(cosDec, 1e-4);

        // cos h0 = -tan φ · tan δ, clamped → polar night (0) / polar day (π).
        float cosH0 = clamp(-tanLat * tanDec, -1.0, 1.0);
        float h0    = acos(cosH0);                 // [0, π]
        float day   = h0 / 3.14159265358979;       // daylight fraction, [0, 1]

        // Darken only the winter hemisphere: map [0, 0.5] daylight → [1, 0]
        // darkness, clamped to 0 above 0.5 so the summer hemisphere is pristine.
        float darken = max(0.0, 1.0 - 2.0 * day);
        float alpha  = darken * uOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
    }
`;

export class SunLight {
    constructor() {
        this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: makeSunTexture(),
            transparent: true,
            depthWrite: false,
        }));
        this.sprite.scale.set(SUN_SIZE, SUN_SIZE, 1);
        this.sprite.renderOrder = 5;

        this.material = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            vertexShader: TERM_VERT,
            fragmentShader: TERM_FRAG,
            uniforms: {
                uAxis:    { value: AXIS_WORLD.clone() },
                uSinDec:  { value: 0.0 },
                uOpacity: { value: 0.55 },
            },
        });
        this.shadowMesh = new THREE.Mesh(
            new THREE.SphereGeometry(SHADOW_R, 96, 48),
            this.material,
        );
        this.shadowMesh.renderOrder = 3;
    }

    /** Update sun position marker + solar declination for month ∈ [1..12]. */
    update(month) {
        const dir = sunDirection(month);
        this.sprite.position.copy(dir).multiplyScalar(SUN_DIST);
        this.material.uniforms.uSinDec.value = Math.sin(solarDeclination(month));
    }

    setVisible(v) {
        this.sprite.visible = v;
        this.shadowMesh.visible = v;
    }
}
