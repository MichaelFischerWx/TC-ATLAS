// GC-ATLAS — contour overlay.
// Renders anti-aliased isolines on top of the shaded field by sampling a
// Float32 DataTexture of the raw scalar and computing sub-pixel distance to
// the nearest v = k*interval level in the fragment shader (fwidth()-based AA).
//
// Two meshes, one per projection (sphere + plane), both bound to the same
// material/texture. Toggle visibility via setVisible; push new values via
// setData; change interval / emphasis level via setInterval.

import * as THREE from 'three';

const SPHERE_R = 1.0015;  // lifted slightly above the shaded globe

const VERT = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

// uEmphasis is the value to draw extra-bold (0 for divergent fields; NaN
// disables emphasis). uEmphasisOn is a flag because WebGL2 doesn't have NaN
// literals in a portable way. uUOffset matches the shaded texture's offset.x
// so lon=0 lines up between the two layers.
const FRAG = /* glsl */`
    precision highp float;
    uniform sampler2D tScalar;
    uniform float uInterval;
    uniform float uEmphasis;
    uniform float uEmphasisOn;
    uniform float uUOffset;
    uniform vec3  uInk;
    uniform float uOpacity;
    varying vec2 vUv;

    void main() {
        vec2 uv = vec2(fract(vUv.x + uUOffset), vUv.y);
        float v = texture2D(tScalar, uv).r;
        if (!(v == v)) discard;  // skip NaN

        // Regular contours at multiples of uInterval.
        float s = v / uInterval;
        float f = fract(s);
        float d = min(f, 1.0 - f);     // 0..0.5; 0 exactly on a contour
        float w = max(fwidth(s), 1e-5);
        float aa = 1.0 - smoothstep(w * 0.5, w * 1.5, d);

        // Optional emphasised line (e.g. v = 0 for divergent fields).
        float emph = 0.0;
        if (uEmphasisOn > 0.5) {
            float de = abs(v - uEmphasis);
            float we = max(fwidth(v), 1e-5);
            emph = 1.0 - smoothstep(we * 0.8, we * 2.2, de);
        }

        float alpha = max(aa * uOpacity, emph * min(uOpacity * 1.6, 1.0));
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(uInk, alpha);
    }
`;

export class ContourField {
    constructor({ nlon, nlat, mapW, mapH }) {
        this.nlon = nlon;
        this.nlat = nlat;
        this.data = new Float32Array(nlon * nlat);

        // Float R-channel texture. WebGL2 (Three.js default) supports R32F.
        this.texture = new THREE.DataTexture(
            this.data, nlon, nlat, THREE.RedFormat, THREE.FloatType,
        );
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
        this.texture.wrapS = THREE.RepeatWrapping;
        this.texture.needsUpdate = true;

        this.material = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            vertexShader: VERT,
            fragmentShader: FRAG,
            uniforms: {
                tScalar:     { value: this.texture },
                uInterval:   { value: 10.0 },
                uEmphasis:   { value: 0.0 },
                uEmphasisOn: { value: 0.0 },
                uUOffset:    { value: 0.25 },
                uInk:        { value: new THREE.Color(0x0a1712) },
                uOpacity:    { value: 0.85 },
            },
        });

        // Sphere overlay — sphere material samples with uUOffset=0.25 (matches
        // the shaded globe's texture.offset.x).
        const sphereGeom = new THREE.SphereGeometry(SPHERE_R, 192, 96);
        this.sphereMesh = new THREE.Mesh(sphereGeom, this.material);
        this.sphereMesh.renderOrder = 2;

        // Plane overlay — no u-offset needed; uses its own material clone.
        this.planeMaterial = this.material.clone();
        this.planeMaterial.uniforms.tScalar     = this.material.uniforms.tScalar;
        this.planeMaterial.uniforms.uInterval   = this.material.uniforms.uInterval;
        this.planeMaterial.uniforms.uEmphasis   = this.material.uniforms.uEmphasis;
        this.planeMaterial.uniforms.uEmphasisOn = this.material.uniforms.uEmphasisOn;
        this.planeMaterial.uniforms.uInk        = this.material.uniforms.uInk;
        this.planeMaterial.uniforms.uOpacity    = this.material.uniforms.uOpacity;
        this.planeMaterial.uniforms.uUOffset    = { value: 0.0 };

        const planeGeom = new THREE.PlaneGeometry(mapW, mapH, nlon, nlat);
        this.planeMesh = new THREE.Mesh(planeGeom, this.planeMaterial);
        this.planeMesh.position.z = 0.001;
        this.planeMesh.renderOrder = 2;
    }

    setData(values) {
        // values is a Float32Array over (nlat, nlon) in row-major, lat from 90
        // down to -90. Our DataTexture expects v=0 at the bottom of the image
        // (lat=-90 at v=0, lat=+90 at v=1), so we flip vertically.
        const { nlon, nlat } = this;
        const src = values;
        const dst = this.data;
        for (let j = 0; j < nlat; j++) {
            const srcRow = j * nlon;
            const dstRow = (nlat - 1 - j) * nlon;
            for (let i = 0; i < nlon; i++) dst[dstRow + i] = src[srcRow + i];
        }
        this.texture.needsUpdate = true;
    }

    setInterval(step)          { this.material.uniforms.uInterval.value = step; }
    setEmphasis(value, enable) {
        this.material.uniforms.uEmphasis.value   = value ?? 0.0;
        this.material.uniforms.uEmphasisOn.value = enable ? 1.0 : 0.0;
    }
    setInk(hex)    { this.material.uniforms.uInk.value.setHex(hex); }
    setOpacity(a)  { this.material.uniforms.uOpacity.value = a; }
    setVisible(v)  { this.sphereMesh.visible = this.planeMesh.visible = v; }
}
