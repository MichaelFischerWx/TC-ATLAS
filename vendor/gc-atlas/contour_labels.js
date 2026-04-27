// GC-ATLAS — contour labels.
// The GLSL contour overlay draws isolines but doesn't know *where* they run,
// so we handle label placement in JS. For each of a handful of "label
// meridians" we scan latitude top-to-bottom, detect points where the field
// crosses a multiple of the contour interval, and drop a billboarded text
// sprite at that (lat, lon). Small, readable, low-cost (~20–40 sprites).
//
// Visibility is slaved to the main Contours toggle; the class only owns
// geometry lifecycle (create/dispose on every field update).

import * as THREE from 'three';

const LABEL_LONS = [-120, 0, 120];            // 3 meridians at 120° spacing
const MIN_LAT_GAP = 3.0;                      // degrees — min spacing on same meridian
const LIFT       = 1.0045;                    // above the terminator shell at 1.003
const MAP_LIFT   = 0.0015;                    // sprite lift above map plane
const FONT_PX    = 22;
const CANVAS_W   = 128;
const CANVAS_H   = 40;

export class ContourLabels {
    constructor(project) {
        this.project = project;
        this.group = new THREE.Group();
        this.group.renderOrder = 4;
        this._visible = true;
    }

    setVisible(v) {
        this._visible = v;
        this.group.visible = v;
    }

    setProjection(project) { this.project = project; }

    /** Rebuild labels for the current field. values is row-major (nlat, nlon),
     *  lat descending (row 0 = +90°). Pass `null` to clear. */
    update(values, nlat, nlon, interval, { viewMode = 'globe' } = {}) {
        this.clear();
        if (!values || !interval || interval <= 0) return;

        const lats = [];
        for (let i = 0; i < nlat; i++) lats.push(90 - i);
        const lonIndex = (lon) => Math.round((lon + 180) % 360);

        for (const lon of LABEL_LONS) {
            const j = lonIndex(lon);
            let prevV = NaN;
            let prevK = NaN;
            let lastLabelLat = Infinity;
            for (let i = 0; i < nlat; i++) {
                const v = values[i * nlon + j];
                if (!Number.isFinite(v)) { prevV = NaN; prevK = NaN; continue; }
                const k = Math.floor(v / interval);
                if (Number.isFinite(prevV) && k !== prevK) {
                    const level = (k > prevK ? k : k + 1) * interval;
                    const t = (level - prevV) / (v - prevV);
                    const lat = lats[i - 1] + t * (lats[i] - lats[i - 1]);
                    // Skip labels too close to the previous one on this meridian
                    // to keep high-gradient regions (ITCZ, jet core) readable.
                    if (Math.abs(lat - lastLabelLat) >= MIN_LAT_GAP) {
                        this._dropLabel(lat, lon, level, viewMode);
                        lastLabelLat = lat;
                    }
                }
                prevV = v; prevK = k;
            }
        }
    }

    clear() {
        for (const child of this.group.children) {
            if (child.material) child.material.dispose();
            if (child.material?.map) child.material.map.dispose();
        }
        this.group.clear();
    }

    _dropLabel(lat, lon, level, viewMode) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: makeLabelTexture(formatLevel(level)),
            transparent: true,
            depthTest: true,
            depthWrite: false,
        }));
        // Default frustumCulled = true culls sprites whose anchor is off-screen,
        // even when the billboarded quad would still overlap the viewport — which
        // makes labels near the screen edge disappear on zoom. Turn it off; the
        // labels are cheap and we want every visible one to render.
        sprite.frustumCulled = false;
        if (viewMode === 'map') {
            const p = this.project(lat, lon, 1);
            sprite.position.set(p.x, p.y, MAP_LIFT);
            sprite.scale.set(0.18, 0.056, 1);
        } else {
            const p = this.project(lat, lon, LIFT);
            sprite.position.set(p.x, p.y, p.z);
            sprite.scale.set(0.10, 0.031, 1);
        }
        sprite.renderOrder = 4;
        this.group.add(sprite);
    }
}

function formatLevel(v) {
    const abs = Math.abs(v);
    if (abs === 0) return '0';
    if (abs < 1)   return v.toFixed(2).replace(/\.?0+$/, '');
    if (abs < 10)  return v.toFixed(1).replace(/\.0$/, '');
    return Math.round(v).toString();
}

function makeLabelTexture(text) {
    const canvas = document.createElement('canvas');
    canvas.width  = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.font = `600 ${FONT_PX}px "DM Sans", "Inter", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Dark outline so the label reads on any colormap; light fill on top.
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(8, 18, 14, 0.92)';
    ctx.strokeText(text, CANVAS_W / 2, CANVAS_H / 2);
    ctx.fillStyle = 'rgba(248, 252, 250, 0.98)';
    ctx.fillText(text, CANVAS_W / 2, CANVAS_H / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}
