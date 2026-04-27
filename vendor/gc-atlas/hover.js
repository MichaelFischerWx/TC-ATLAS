// GC-ATLAS — hover readout.
//
// Attaches a pointermove listener to the canvas. On each move (throttled
// to ~30 Hz):
//  - If we're on the globe view, raycast into the sphere mesh. On hit,
//    convert the world-space point back through the tilted globe group to
//    get geographic (lat, lon).
//  - If we're on the map view, raycast into the plane mesh; convert world
//    XY to (lat, lon), accounting for the central-meridian offset.
//  - Skip orbit view (Earth is too small to hover meaningfully).
//
// Then bilinear-sample the currently-displayed field at (lat, lon) and
// update a DOM tooltip. Hidden during drags (e.buttons != 0) so it doesn't
// fight rotate / shift-drag arcs / map pan.

import * as THREE from 'three';

const THROTTLE_MS = 33;  // ~30 Hz cap

export class HoverProbe {
    constructor({
        canvas,
        camera,
        getViewMode,
        getGlobeMesh,
        getMapMesh,
        getMapW,
        getMapH,
        getMapCenterLon,
        sampleDisplayed,
        formatLabel,
    }) {
        this.canvas = canvas;
        this.camera = camera;
        this.getViewMode     = getViewMode;
        this.getGlobeMesh    = getGlobeMesh;
        this.getMapMesh      = getMapMesh;
        this.getMapW         = getMapW;
        this.getMapH         = getMapH;
        this.getMapCenterLon = getMapCenterLon;
        this.sampleDisplayed = sampleDisplayed;
        this.formatLabel     = formatLabel;

        this.raycaster = new THREE.Raycaster();
        this.ndc = new THREE.Vector2();
        this.tooltip = document.getElementById('hover-tooltip');
        this.lastAt = 0;

        canvas.addEventListener('pointermove', (e) => this._onMove(e));
        canvas.addEventListener('pointerleave', () => this._hide());
        canvas.addEventListener('pointerdown',  () => this._hide());
    }

    _onMove(e) {
        // Any button pressed → drag in progress (rotate, shift-arc, map pan).
        if (e.buttons !== 0) { this._hide(); return; }
        const now = performance.now();
        if (now - this.lastAt < THROTTLE_MS) return;
        this.lastAt = now;

        const viewMode = this.getViewMode();
        if (viewMode === 'orbit') { this._hide(); return; }

        const p = this._pointToLatLon(e, viewMode);
        if (!p) { this._hide(); return; }

        const v = this.sampleDisplayed(p.lat, p.lon);
        if (v === null || v === undefined || !Number.isFinite(v)) {
            this._hide();
            return;
        }
        this._show(e.clientX, e.clientY, this.formatLabel(p.lat, p.lon, v));
    }

    _pointToLatLon(e, viewMode) {
        const rect = this.canvas.getBoundingClientRect();
        this.ndc.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
        this.ndc.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.ndc, this.camera);

        if (viewMode === 'globe') {
            const globe = this.getGlobeMesh();
            if (!globe) return null;
            const hits = this.raycaster.intersectObject(globe);
            if (hits.length === 0) return null;
            // Transform world hit point → globe's local (untilted) frame.
            const local = globe.parent.worldToLocal(hits[0].point.clone());
            const n = local.length() || 1;
            return {
                lat: Math.asin(local.y / n) * 180 / Math.PI,
                lon: Math.atan2(local.x, local.z) * 180 / Math.PI,
            };
        }

        if (viewMode === 'map') {
            const map = this.getMapMesh();
            if (!map) return null;
            const hits = this.raycaster.intersectObject(map);
            if (hits.length === 0) return null;
            const MAP_W = this.getMapW();
            const MAP_H = this.getMapH();
            const centerLon = this.getMapCenterLon();
            const worldX = hits[0].point.x;
            const worldY = hits[0].point.y;
            let lon = worldX * (360 / MAP_W) + centerLon;
            const lat = worldY * (180 / MAP_H);
            // Wrap lon into [-180, 180].
            lon = ((lon + 180) % 360 + 360) % 360 - 180;
            if (lat < -90 || lat > 90) return null;
            return { lat, lon };
        }
        return null;
    }

    _show(clientX, clientY, html) {
        if (!this.tooltip) return;
        this.tooltip.innerHTML = html;
        // Position just below-right of the cursor; flip to the other side
        // if we'd otherwise clip the viewport.
        const pad = 14;
        const w = this.tooltip.offsetWidth || 180;
        const h = this.tooltip.offsetHeight || 28;
        let x = clientX + pad;
        let y = clientY + pad;
        if (x + w > window.innerWidth)  x = clientX - w - pad;
        if (y + h > window.innerHeight) y = clientY - h - pad;
        this.tooltip.style.left = `${x}px`;
        this.tooltip.style.top  = `${y}px`;
        this.tooltip.classList.remove('hidden');
    }

    _hide() {
        this.tooltip?.classList.add('hidden');
    }
}
