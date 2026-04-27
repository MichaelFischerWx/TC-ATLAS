// GC-ATLAS — orbit view ("viewer from space", Level 3).
// Heliocentric scene: central sun at origin, a dashed ecliptic ring, and a
// mini-Earth that orbits the sun as the month advances. Earth's rotation
// axis stays FIXED in world space (always tilted 23.4° toward -X), so as it
// orbits the direction to the sun relative to its axis swings through the
// full ±23.4° seasonal range — that's the pedagogical payoff, a direct
// visual of why solstices and equinoxes work the way they do.
//
// Composition:
//   orbitGroup
//     sunGlow            (wide additive halo sprite)
//     sunDisk            (bright limb-darkened disk sprite)
//     eclipticLine       (dashed ring in the XZ plane)
//     orbitArrow         (emerald cone tangent to the ring)
//     solsticeDots/labels (at Dec/Mar/Jun/Sep orbital positions)
//     monthTicks         (stubs at the 8 non-solstice months)
//     subsolarMarker     (tiny warm sprite pinned to Earth's sun-facing side)
//     earthPivot         (translated each frame to the orbital position)
//       earthTiltGroup   (fixed 23.4° tilt about +Z)
//         axisLine       (amber stick through the poles)
//         latCircleLines (equator + tropics + polar circles)
//         earthSpinGroup (diurnal rotation about local +Y)
//           earthMesh    (sphere with the shaded canvas texture)
//           terminator   (slightly larger sphere with day/night shader)

import * as THREE from 'three';

const AXIAL_TILT   = 23.4 * Math.PI / 180;
const ORBIT_RADIUS = 3.0;
const EARTH_R      = 0.22;
const SUN_R        = 0.42;            // diameter of the bright disk
const GLOW_R       = SUN_R * 5.2;     // outer soft halo reach
const AXIS_LEN     = EARTH_R * 1.7;   // stub out past each pole
const DASH_N       = 96;              // segments around the dashed ring
const MONTH_RAD    = Math.PI / 6;     // 30° per month

function makeSunTexture(size = 256) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const r = size / 2;
    // Radial gradient with limb darkening: white-hot core → yellow → amber →
    // faint orange → transparent. Alpha tapers off so the disk has a soft
    // edge rather than a hard circle on a dark background.
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0.00, 'rgba(255, 253, 240, 1.00)');
    g.addColorStop(0.22, 'rgba(255, 240, 170, 1.00)');
    g.addColorStop(0.45, 'rgba(255, 205, 100, 0.95)');
    g.addColorStop(0.62, 'rgba(255, 155, 60,  0.70)');
    g.addColorStop(0.80, 'rgba(255, 110, 40,  0.28)');
    g.addColorStop(0.92, 'rgba(255, 80,  30,  0.08)');
    g.addColorStop(1.00, 'rgba(255, 70,  30,  0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function makeTextSprite(text, { color = '#F4FAF7', fontSize = 26 } = {}) {
    const W = 256, H = 72;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.font = `600 ${fontSize}px "DM Sans", "Inter", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(6, 14, 11, 0.92)';
    ctx.strokeText(text, W / 2, H / 2);
    ctx.fillStyle = color;
    ctx.fillText(text, W / 2, H / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
    }));
}

// Thin latitude circle in the mini-Earth's local frame; used for tropics,
// polar circles, and the equator.
function latCircleLine(lat, { color, opacity, radiusMul = 1.002 }) {
    const phi = lat * Math.PI / 180;
    const R   = EARTH_R * radiusMul;
    const y   = R * Math.sin(phi);
    const r   = R * Math.cos(phi);
    const pts = [];
    for (let i = 0; i <= 128; i++) {
        const th = (i / 128) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    return new THREE.Line(geom, mat);
}

function makeGlowTexture(size = 512) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const r = size / 2;
    // Wide, soft halo — deliberately warm and low-alpha so additive blending
    // on a dark scene produces a gentle lift rather than an olive tint.
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0.00, 'rgba(255, 190, 110, 0.32)');
    g.addColorStop(0.18, 'rgba(255, 150, 70,  0.18)');
    g.addColorStop(0.40, 'rgba(255, 110, 40,  0.07)');
    g.addColorStop(0.70, 'rgba(255, 80,  30,  0.02)');
    g.addColorStop(1.00, 'rgba(255, 60,  30,  0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function sunDirectionFromEarth(month) {
    const theta = month * MONTH_RAD;
    return new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta));
}

// Heliocentric Earth position = -sunDirection * R (the sun is at origin).
function earthOrbitPosition(month) {
    return sunDirectionFromEarth(month).multiplyScalar(-ORBIT_RADIUS);
}

const TERM_VERT = /* glsl */`
    varying vec3 vWorldNormal;
    void main() {
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const TERM_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  uSunDir;
    uniform float uOpacity;
    varying vec3 vWorldNormal;
    void main() {
        float d = dot(vWorldNormal, uSunDir);
        float night = smoothstep(0.10, -0.08, d);
        if (night < 0.01) discard;
        gl_FragColor = vec4(0.0, 0.0, 0.0, night * uOpacity);
    }
`;

export class OrbitScene {
    constructor(getEarthTexture) {
        this.getEarthTexture = getEarthTexture;
        this.group = new THREE.Group();
        this.group.visible = false;

        // ── Sun ────────────────────────────────────────────────────────
        // The sun is built from layered camera-facing sprites: a soft wide
        // halo underneath (additive), then the bright disk with limb
        // darkening on top. Two sprites beats a sphere + ring here because
        // real suns read as luminous disks from any viewing angle, and the
        // additive halo composites cleanly against the dark background.
        this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: makeGlowTexture(),
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        this.sunGlow.scale.set(GLOW_R * 2, GLOW_R * 2, 1);
        this.group.add(this.sunGlow);

        this.sunDisk = new THREE.Sprite(new THREE.SpriteMaterial({
            map: makeSunTexture(),
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        this.sunDisk.scale.set(SUN_R * 2.4, SUN_R * 2.4, 1);
        this.sunDisk.renderOrder = 1;
        this.group.add(this.sunDisk);

        // ── Ecliptic ring (dashed) ─────────────────────────────────────
        const ringPts = [];
        for (let i = 0; i <= DASH_N; i++) {
            const th = (i / DASH_N) * Math.PI * 2;
            ringPts.push(new THREE.Vector3(
                Math.cos(th) * ORBIT_RADIUS, 0, Math.sin(th) * ORBIT_RADIUS,
            ));
        }
        const ringGeom = new THREE.BufferGeometry().setFromPoints(ringPts);
        const ringMat = new THREE.LineDashedMaterial({
            color: 0x7FB8B5, dashSize: 0.12, gapSize: 0.10,
            transparent: true, opacity: 0.65,
        });
        this.ring = new THREE.Line(ringGeom, ringMat);
        this.ring.computeLineDistances();  // required for dashed rendering
        this.group.add(this.ring);

        // ── Orbital direction arrow — cone tangent to the ring at m=9 (Sep),
        // pointing along −X (tangent direction at that orbital position).
        const arrowGeom = new THREE.ConeGeometry(0.10, 0.34, 14);
        arrowGeom.translate(0, 0.17, 0);
        const arrowMat = new THREE.MeshBasicMaterial({ color: 0x2DBDA0 });
        this.orbitArrow = new THREE.Mesh(arrowGeom, arrowMat);
        this.orbitArrow.position.set(0, 0, ORBIT_RADIUS);
        this.orbitArrow.rotation.set(0, 0, Math.PI / 2);
        this.group.add(this.orbitArrow);

        // ── Solstice / equinox markers on the ring ─────────────────────
        const markers = [
            { month: 12, label: 'Dec solstice', color: 0xE8C26A, tone: '#E8C26A' },
            { month:  3, label: 'Mar equinox',  color: 0x8BB0A1, tone: '#A8C9BB' },
            { month:  6, label: 'Jun solstice', color: 0xE8C26A, tone: '#E8C26A' },
            { month:  9, label: 'Sep equinox',  color: 0x8BB0A1, tone: '#A8C9BB' },
        ];
        for (const m of markers) {
            const pos = earthOrbitPosition(m.month);
            const dot = new THREE.Mesh(
                new THREE.SphereGeometry(0.055, 16, 12),
                new THREE.MeshBasicMaterial({ color: m.color }),
            );
            dot.position.copy(pos);
            this.group.add(dot);
            const text = makeTextSprite(m.label, { color: m.tone });
            // Push label outward along the radial so it doesn't overlap Earth.
            const outward = pos.clone().normalize().multiplyScalar(0.45);
            text.position.copy(pos).add(outward);
            text.scale.set(0.70, 0.22, 1);
            text.renderOrder = 6;
            this.group.add(text);
        }
        // Minor ticks on the other 8 months — small radial stubs for rhythm.
        for (let mm = 1; mm <= 12; mm++) {
            if (mm % 3 === 0 || mm === 12) continue;
            const p0 = earthOrbitPosition(mm);
            const outward = p0.clone().normalize();
            const p1 = p0.clone().add(outward.multiplyScalar(0.10));
            const geom = new THREE.BufferGeometry().setFromPoints([p0, p1]);
            const mat = new THREE.LineBasicMaterial({
                color: 0x7FB8B5, transparent: true, opacity: 0.55,
            });
            this.group.add(new THREE.Line(geom, mat));
        }

        // ── Mini-Earth hierarchy ───────────────────────────────────────
        this.earthPivot     = new THREE.Group();
        this.earthTiltGroup = new THREE.Group();
        this.earthSpinGroup = new THREE.Group();
        this.earthTiltGroup.rotation.z = AXIAL_TILT;
        this.earthPivot.add(this.earthTiltGroup);
        this.earthTiltGroup.add(this.earthSpinGroup);
        this.group.add(this.earthPivot);

        const earthGeom = new THREE.SphereGeometry(EARTH_R, 96, 48);
        // The passed-in texture already has offset.x = 0.25 (sphere
        // alignment) and the correct wrap/colour-space set by globe.js.
        this.earthMat = new THREE.MeshBasicMaterial({
            map: this.getEarthTexture(),
        });
        this.earthMesh = new THREE.Mesh(earthGeom, this.earthMat);
        this.earthSpinGroup.add(this.earthMesh);

        // Terminator on the mini-Earth: slightly larger translucent shell,
        // attached to the SPIN group so it rotates with the Earth surface —
        // but the shader does a world-space dot product so the dark side
        // always faces away from the sun regardless of spin angle.
        this.termMaterial = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            vertexShader: TERM_VERT,
            fragmentShader: TERM_FRAG,
            uniforms: {
                uSunDir:  { value: new THREE.Vector3(1, 0, 0) },
                uOpacity: { value: 0.55 },
            },
        });
        this.terminator = new THREE.Mesh(
            new THREE.SphereGeometry(EARTH_R * 1.003, 64, 32),
            this.termMaterial,
        );
        this.terminator.renderOrder = 3;
        this.earthSpinGroup.add(this.terminator);

        // Visible rotation axis — stays fixed under tilt, does NOT spin, so
        // students see Earth "twirling" under a tilted stick.
        const axisGeom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, -AXIS_LEN, 0),
            new THREE.Vector3(0,  AXIS_LEN, 0),
        ]);
        const axisMat = new THREE.LineBasicMaterial({
            color: 0xE8C26A, transparent: true, opacity: 0.85,
        });
        this.axisLine = new THREE.Line(axisGeom, axisMat);
        this.earthTiltGroup.add(this.axisLine);

        // Latitude reference rings. These are rotationally symmetric so it
        // doesn't matter whether they spin with Earth — attach to the tilt
        // group so they anchor to the geographic frame without the cost of
        // re-drawing during animation.
        this.earthTiltGroup.add(latCircleLine( 23.4, { color: 0xE8C26A, opacity: 0.65 })); // Tropic of Cancer
        this.earthTiltGroup.add(latCircleLine(-23.4, { color: 0xE8C26A, opacity: 0.65 })); // Tropic of Capricorn
        this.earthTiltGroup.add(latCircleLine( 66.6, { color: 0xE4F1EE, opacity: 0.55 })); // Arctic Circle
        this.earthTiltGroup.add(latCircleLine(-66.6, { color: 0xE4F1EE, opacity: 0.55 })); // Antarctic Circle
        this.earthTiltGroup.add(latCircleLine(0,     { color: 0xFFFFFF, opacity: 0.30 })); // Equator

        // Subsolar point marker: warm sprite on Earth's surface at the point
        // where the sun is directly overhead. Lives in the orbit group (not
        // earthPivot) so it stays pinned to the sun-facing side rather than
        // spinning with Earth — that way the yearly ±23.4° drift of the
        // subsolar latitude is the only motion it shows.
        //
        // depthTest is OFF so the full circular sprite always renders (a
        // billboard quad with depth-test on gets half-culled by the sphere
        // near the limb, which reads as a clipped half-moon). Instead we
        // cull it in JS via a camera-side dot-product test inside update().
        this.subsolarMarker = new THREE.Sprite(new THREE.SpriteMaterial({
            map: makeSunTexture(64),
            transparent: true,
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        this.subsolarMarker.scale.set(0.105, 0.105, 1);
        this.subsolarMarker.renderOrder = 6;
        this.subsolarMarker.frustumCulled = false;
        this.group.add(this.subsolarMarker);

        this.update(1);
    }

    /**
     * Position Earth on its orbital point for the given month (1..12) and
     * update the terminator's sun direction. Call this whenever month or
     * spin angle changes.
     */
    update(month, spinAngle = 0, camera = null) {
        const earthPos = earthOrbitPosition(month);
        this.earthPivot.position.copy(earthPos);
        this.earthSpinGroup.rotation.y = spinAngle;

        // Direction from Earth toward the sun (sun is at origin).
        const sunDir = earthPos.clone().negate().normalize();
        this.termMaterial.uniforms.uSunDir.value.copy(sunDir);

        // Subsolar point: on Earth's surface, exactly on the sun-facing side.
        // By construction this sits at the current subsolar latitude on
        // Earth's disc, so it traces the ±23.4° seasonal drift as month
        // advances.
        this.subsolarMarker.position.copy(earthPos).add(
            sunDir.clone().multiplyScalar(EARTH_R * 1.01),
        );

        // Hide the marker when the subsolar point is on the far hemisphere
        // from the camera. (depthTest is off, so without this check the
        // marker would draw straight through Earth when the camera is on
        // the night side.)
        if (camera) {
            const toCam = new THREE.Vector3()
                .subVectors(camera.position, earthPos);
            this.subsolarMarker.visible = toCam.dot(sunDir) > 0;
        } else {
            this.subsolarMarker.visible = true;
        }
    }

    setVisible(v) { this.group.visible = v; }

}

export { ORBIT_RADIUS };
