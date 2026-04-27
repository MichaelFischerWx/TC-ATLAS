// GC-ATLAS — wind particle advection overlay.
// CPU-tracked particles that advect on a (u, v) field provided by the caller.
// Each particle carries a short trail of past positions; the trail is drawn
// as LineSegments with per-vertex alpha so the head is bright and the tail
// fades smoothly. Designed for ~3.5k particles × 14-step trails (~100k verts),
// comfortable at 60fps on a modern laptop.

import * as THREE from 'three';

const N           = 12000;   // particle count — dense cover (≈ nullschool feel)
const TRAIL       = 12;      // trail length (positions per particle)
const MAX_AGE     = 220;     // mean lifetime in frames (~3.7 s @ 60 fps)
const AGE_JITTER  = 0.35;    // ± fraction: per-particle lifetime varies in
                             // [MAX_AGE·(1-jitter), MAX_AGE·(1+jitter)] so
                             // deaths don't re-synchronise after first cycle.
const FADE_IN     = 15;      // frames over which alpha ramps from 0 on birth
const FADE_OUT    = 20;      // frames over which alpha fades back to 0 before death
const SPEED       = 0.0042;  // deg per (m/s · frame)
const RADIUS      = 1.006;   // lift slightly above data texture
const POLE_MASK   = 82;      // avoid seeding beyond ±82°
const SPEED_NORM  = 22;      // m/s that saturates particle opacity
const ALPHA_FLOOR = 0.55;    // minimum head opacity so calm flow is clearly visible
const ALPHA_PEAK  = 1.00;    // head opacity at jet-stream speeds

export class ParticleField {
    constructor(getUV, projectFn) {
        this.getUV = getUV;
        // Injected projection (globe sphere or equirectangular plane). Must
        // return a THREE.Vector3 when given (lat, lon, radius-or-layer).
        this.project = projectFn || ((lat, lon, r) => {
            const phi = lat * Math.PI / 180;
            const lam = lon * Math.PI / 180;
            return new THREE.Vector3(
                r * Math.cos(phi) * Math.sin(lam),
                r * Math.sin(phi),
                r * Math.cos(phi) * Math.cos(lam),
            );
        });

        this.state = new Float32Array(N * 3);           // lat, lon, age
        this.speed = new Float32Array(N);               // per-particle speed (m/s)
        this.lifetime = new Float32Array(N);            // per-particle death frame
        this.trail = new Float32Array(N * TRAIL * 3);   // xyz per trail step

        const segs = N * (TRAIL - 1);
        this.positions = new Float32Array(segs * 2 * 3);
        this.alphas    = new Float32Array(segs * 2);

        this.geom = new THREE.BufferGeometry();
        this.geom.setAttribute('position',
            new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
        this.geom.setAttribute('alpha',
            new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));

        const mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            uniforms: { uColor: { value: new THREE.Color(0xFFFFFF) } },
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
                void main() {
                    gl_FragColor = vec4(uColor, vAlpha);
                }
            `,
        });
        this.trailMesh = new THREE.LineSegments(this.geom, mat);

        // Head-dot pass — a THREE.Points object with one vertex per particle
        // at the trail head. WebGL's built-in line stroke is clamped to 1 px,
        // which makes slow-wind particles almost invisible because their
        // trails collapse into sub-pixel segments. gl_PointSize lets us draw
        // a 2.5-px disk that always stays visible regardless of trail length.
        this.headPositions = new Float32Array(N * 3);
        this.headAlphas    = new Float32Array(N);
        this.headGeom = new THREE.BufferGeometry();
        this.headGeom.setAttribute('position',
            new THREE.BufferAttribute(this.headPositions, 3).setUsage(THREE.DynamicDrawUsage));
        this.headGeom.setAttribute('alpha',
            new THREE.BufferAttribute(this.headAlphas, 1).setUsage(THREE.DynamicDrawUsage));
        const headMat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            uniforms: { uColor: { value: new THREE.Color(0xFFFFFF) } },
            vertexShader: `
                attribute float alpha;
                varying float vAlpha;
                void main() {
                    vAlpha = alpha;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = 2.5;
                }
            `,
            fragmentShader: `
                uniform vec3 uColor;
                varying float vAlpha;
                void main() {
                    vec2 c = gl_PointCoord - 0.5;
                    if (dot(c, c) > 0.25) discard;   // circular dot
                    gl_FragColor = vec4(uColor, vAlpha);
                }
            `,
        });
        this.headMesh = new THREE.Points(this.headGeom, headMat);

        this.object = new THREE.Group();
        this.object.add(this.trailMesh);
        this.object.add(this.headMesh);

        // On initial construction, stagger ages across the full lifetime so
        // respawn events are spread evenly over the first MAX_AGE frames.
        for (let i = 0; i < N; i++) this.respawn(i, true);
        this.updateGeometry();
    }

    respawn(i, initial = false) {
        const lat = (Math.random() * 2 - 1) * POLE_MASK;
        const lon = Math.random() * 360 - 180;
        this.state[i * 3]     = lat;
        this.state[i * 3 + 1] = lon;
        // Fresh lifetime with jitter so respawned cohorts don't march to
        // death together. The first construction also staggers the starting
        // age across the (new) lifetime so the initial deaths are spread.
        const life = MAX_AGE * (1 - AGE_JITTER + 2 * AGE_JITTER * Math.random());
        this.lifetime[i] = life;
        this.state[i * 3 + 2] = initial ? Math.floor(Math.random() * life) : 0;
        const [x, y, z] = this.latLonToXYZ(lat, lon);
        const tx = i * TRAIL * 3;
        for (let t = 0; t < TRAIL; t++) {
            this.trail[tx + t * 3]     = x;
            this.trail[tx + t * 3 + 1] = y;
            this.trail[tx + t * 3 + 2] = z;
        }
    }

    latLonToXYZ(lat, lon) {
        const v = this.project(lat, lon, RADIUS);
        return [v.x, v.y, v.z];
    }

    /** Called by the host when the projection changes (globe ↔ map). */
    onProjectionChanged() {
        for (let i = 0; i < N; i++) {
            const [x, y, z] = this.latLonToXYZ(this.state[i * 3], this.state[i * 3 + 1]);
            const tx = i * TRAIL * 3;
            for (let t = 0; t < TRAIL; t++) {
                this.trail[tx + t * 3]     = x;
                this.trail[tx + t * 3 + 1] = y;
                this.trail[tx + t * 3 + 2] = z;
            }
        }
        this.updateGeometry();
    }

    step() {
        for (let i = 0; i < N; i++) {
            let lat = this.state[i * 3];
            let lon = this.state[i * 3 + 1];
            let age = this.state[i * 3 + 2];

            const uv = this.getUV(lat, lon);
            if (!uv || !Number.isFinite(uv[0]) || !Number.isFinite(uv[1])) {
                this.respawn(i);
                continue;
            }
            const [u, v] = uv;
            const dlat = v * SPEED;
            const dlon = u * SPEED / Math.max(0.08, Math.cos(lat * Math.PI / 180));
            lat += dlat;
            lon += dlon;
            age += 1;
            this.speed[i] = Math.sqrt(u * u + v * v);

            if (Math.abs(lat) > POLE_MASK + 3 || age > this.lifetime[i]) {
                this.respawn(i);
                continue;
            }
            let wrapped = false;
            if (lon > 180)       { lon -= 360; wrapped = true; }
            else if (lon < -180) { lon += 360; wrapped = true; }

            this.state[i * 3]     = lat;
            this.state[i * 3 + 1] = lon;
            this.state[i * 3 + 2] = age;

            const tx = i * TRAIL * 3;
            const [x, y, z] = this.latLonToXYZ(lat, lon);

            // Screen-space wrap detection — catches the case where the map
            // seam isn't at ±180 (central meridian slider moved). A normal
            // one-frame step is ≪ 0.05 world units; anything above 0.5 is a
            // seam-crossing teleport.
            if (!wrapped) {
                const px = this.trail[tx];
                const py = this.trail[tx + 1];
                const pz = this.trail[tx + 2];
                const dx = x - px, dy = y - py, dz = z - pz;
                if (dx * dx + dy * dy + dz * dz > 0.25) wrapped = true;
            }

            if (wrapped) {
                // Reset the trail to the new head. On the sphere this doesn't
                // matter (old and new positions are adjacent in 3D), but on the
                // flat equirectangular map the trail would streak across the
                // whole width if we shifted normally.
                for (let t = 0; t < TRAIL; t++) {
                    this.trail[tx + t * 3]     = x;
                    this.trail[tx + t * 3 + 1] = y;
                    this.trail[tx + t * 3 + 2] = z;
                }
            } else {
                // Shift trail: position[0] is newest, position[TRAIL-1] oldest.
                for (let t = TRAIL - 1; t > 0; t--) {
                    this.trail[tx + t * 3]     = this.trail[tx + (t - 1) * 3];
                    this.trail[tx + t * 3 + 1] = this.trail[tx + (t - 1) * 3 + 1];
                    this.trail[tx + t * 3 + 2] = this.trail[tx + (t - 1) * 3 + 2];
                }
                this.trail[tx]     = x;
                this.trail[tx + 1] = y;
                this.trail[tx + 2] = z;
            }
        }
        this.updateGeometry();
    }

    updateGeometry() {
        const pos = this.positions, al = this.alphas;
        const hpos = this.headPositions, hal = this.headAlphas;
        const tailMax = TRAIL - 1;
        for (let i = 0; i < N; i++) {
            // Head opacity = speed ramp × age envelope. The age envelope
            // fades each particle in over FADE_IN frames and out over
            // FADE_OUT frames before respawn, so births and deaths don't
            // look like abrupt pops in the jet axis.
            const age = this.state[i * 3 + 2];
            const life = this.lifetime[i];
            let ageFade = 1;
            if (age < FADE_IN) {
                ageFade = age / FADE_IN;
            } else if (age > life - FADE_OUT) {
                ageFade = Math.max(0, (life - age) / FADE_OUT);
            }
            const speedAlpha = ALPHA_FLOOR +
                (ALPHA_PEAK - ALPHA_FLOOR) * Math.min(1, this.speed[i] / SPEED_NORM);
            const headAlpha = speedAlpha * ageFade;
            const tx = i * TRAIL * 3;
            const ox = i * tailMax * 6;
            const ax = i * tailMax * 2;
            for (let t = 0; t < tailMax; t++) {
                const k = ox + t * 6;
                const ak = ax + t * 2;
                pos[k]     = this.trail[tx + t * 3];
                pos[k + 1] = this.trail[tx + t * 3 + 1];
                pos[k + 2] = this.trail[tx + t * 3 + 2];
                pos[k + 3] = this.trail[tx + (t + 1) * 3];
                pos[k + 4] = this.trail[tx + (t + 1) * 3 + 1];
                pos[k + 5] = this.trail[tx + (t + 1) * 3 + 2];
                al[ak]     = headAlpha * (1 - t / tailMax);
                al[ak + 1] = headAlpha * (1 - (t + 1) / tailMax);
            }
            // Head dot at trail[0] (newest position). Alpha a bit brighter
            // than the segment head so the dot is the clear focal point.
            hpos[i * 3]     = this.trail[tx];
            hpos[i * 3 + 1] = this.trail[tx + 1];
            hpos[i * 3 + 2] = this.trail[tx + 2];
            hal[i] = Math.min(1, headAlpha * 1.15);
        }
        this.geom.attributes.position.needsUpdate = true;
        this.geom.attributes.alpha.needsUpdate = true;
        this.headGeom.attributes.position.needsUpdate = true;
        this.headGeom.attributes.alpha.needsUpdate = true;
    }

    setVisible(v) { this.object.visible = v; }

    setColor(hex) {
        this.trailMesh.material.uniforms.uColor.value.setHex(hex);
        this.headMesh.material.uniforms.uColor.value.setHex(hex);
    }
}
