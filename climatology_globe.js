// Climatology Globe page boot.
//
// The vendored GC-ATLAS engine (`vendor/gc-atlas/globe.js`) auto-
// instantiates a GlobeApp against #globe-mount and exposes it as
// `window.envGlobe` (TC-ATLAS fork — see vendor/gc-atlas/globe.js bottom).
// This module piggy-backs on that boot to:
//   1. Fetch IBTrACS tracks (same chunked manifest as Global Archive).
//   2. Attach a TrackOverlay to the globe's group so storm tracks
//      render on the textured sphere using the same coordinate frame
//      as the ERA5 field tile.
//   3. Default the field/month dropdowns to SST + September (NH peak)
//      so the page lands on a TC-relevant view.
//   4. Re-render tracks whenever the globe's `field-updated` event
//      fires so the displayed-month tracks track the user's scrubbing.
//   5. Hover tooltip — raycasts on the sphere and reports the closest
//      visible best-track fix (storm name, date, intensity, pressure).

import * as THREE from 'three';
import { TrackOverlay, parseUTC } from './vendor/gc-atlas/track_overlay.js';

const DATA_VER = 'v20260408';
const TRACKS_MANIFEST = 'ibtracs_tracks_manifest.json?' + DATA_VER;
const TRACKS_JSON_FALLBACK = 'ibtracs_tracks.json?' + DATA_VER;
const STORMS_JSON = 'ibtracs_storms.json?' + DATA_VER;

let _tracks = {};
let _stormMeta = {};            // sid → { name, year, basin, peak_wind_kt, ... }
let _overlay = null;

const BASIN_NAMES = {
    NA: 'N. Atlantic', EP: 'E. Pacific', WP: 'W. Pacific',
    NI: 'N. Indian', SI: 'S. Indian', SP: 'S. Pacific', SA: 'S. Atlantic',
};

function loadTracks() {
    return fetch(TRACKS_MANIFEST)
        .then(r => { if (!r.ok) throw new Error('manifest unavailable'); return r.json(); })
        .then(m => {
            const chunks = m.chunks || [];
            return Promise.all(chunks.map(f => fetch(f + '?' + DATA_VER).then(r => r.json())));
        })
        .then(chunkArr => {
            chunkArr.forEach(c => Object.assign(_tracks, c));
            console.log('[ClimGlobe] Loaded tracks for ' + Object.keys(_tracks).length + ' storms');
        })
        .catch(() => fetch(TRACKS_JSON_FALLBACK)
            .then(r => r.json())
            .then(d => {
                _tracks = d;
                console.log('[ClimGlobe] Loaded tracks (single-file fallback) for ' + Object.keys(d).length + ' storms');
            })
            .catch(err => console.error('[ClimGlobe] Track load failed:', err)));
}

function loadStormMeta() {
    return fetch(STORMS_JSON)
        .then(r => r.json())
        .then(d => {
            (d.storms || []).forEach(s => { _stormMeta[s.sid] = s; });
            console.log('[ClimGlobe] Loaded metadata for ' + Object.keys(_stormMeta).length + ' storms');
        })
        .catch(err => console.warn('[ClimGlobe] Storm metadata load failed:', err));
}

function refreshTracks() {
    if (!_overlay || !window.envGlobe) return;
    const s = window.envGlobe.state || {};
    const year = (s.year != null && Number.isFinite(s.year)) ? s.year : null;
    const month = s.month;
    const toggle = document.getElementById('toggle-tracks');
    const visible = toggle ? toggle.checked : true;
    _overlay.setVisible(visible);
    if (visible) _overlay.render(_tracks, year, month);
}

function setSelect(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    let found = false;
    for (let i = 0; i < el.options.length; i++) {
        if (el.options[i].value === value) { found = true; break; }
    }
    if (!found) return;
    el.value = value;
    el.dispatchEvent(new Event('change'));
}

// ── Hover tooltip ─────────────────────────────────────────────
//
// On every pointermove over the globe canvas:
//   1. Raycast against the sphere to recover the cursor's geographic
//      (lat, lon).
//   2. Find the closest currently-visible best-track fix by haversine
//      distance — restricted to the (year, month) filter the
//      TrackOverlay is rendering, so the tooltip and the painted
//      polylines always agree.
//   3. If within the threshold, populate a tooltip with storm name +
//      timestamp + intensity (Saffir-Simpson) + pressure.
//
// We raycast against the globe mesh (not the Line2 tracks themselves)
// because Line2 raycasting uses screen-space pixel thresholds and is
// finicky with our linewidth + transparency settings; spherical-distance
// matching is simpler and gives the user a natural "snap" feel.

const D2R = Math.PI / 180;
const EARTH_R_KM = 6371;
const HOVER_MAX_KM = 250;       // snap radius — ~2.5° at the equator
const HOVER_THROTTLE_MS = 33;   // ~30 Hz cap

function gcDistanceKm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * D2R;
    const dLon = (lon2 - lon1) * D2R;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function intensityCat(w) {
    if (w == null || !Number.isFinite(w)) return { label: '—', color: '#94a3b8' };
    if (w < 34)  return { label: 'TD',    color: '#60a5fa' };
    if (w < 64)  return { label: 'TS',    color: '#34d399' };
    if (w < 83)  return { label: 'Cat 1', color: '#fbbf24' };
    if (w < 96)  return { label: 'Cat 2', color: '#fb923c' };
    if (w < 113) return { label: 'Cat 3', color: '#f87171' };
    if (w < 137) return { label: 'Cat 4', color: '#ef4444' };
    return { label: 'Cat 5', color: '#dc2626' };
}

function fmtFixDate(t) {
    if (!t) return '';
    const dt = parseUTC(t);
    if (!dt || Number.isNaN(dt.getTime())) return String(t);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const Y = dt.getUTCFullYear();
    const M = months[dt.getUTCMonth()];
    const D = String(dt.getUTCDate()).padStart(2, '0');
    const hh = String(dt.getUTCHours()).padStart(2, '0');
    const mm = String(dt.getUTCMinutes()).padStart(2, '0');
    return `${M} ${D} ${Y} · ${hh}:${mm} UTC`;
}

// Reads from TrackOverlay.visibleFixes — a flat array populated once per
// render(), so the hot path is just a haversine sweep over the fixes that
// are *currently painted* on the globe (~600 in single-year mode, ~76k in
// climatology). No Date parsing in here; the year/month filter already
// happened at render time, which is what was making hover laggy before.
function findNearestFix(cursorLat, cursorLon) {
    if (!_overlay) return null;
    const fixes = _overlay.visibleFixes;
    if (!fixes || fixes.length === 0) return null;

    // Cheap pre-filter using a chord-length proxy in unit-sphere space —
    // skip haversine entirely for fixes that are obviously too far. Build
    // the cursor's unit vector once and compare to each fix's vector via
    // a precomputed bound on cos(angular_distance). For HOVER_MAX_KM=250
    // on a 6371-km Earth, the threshold angular distance is ~0.0392 rad,
    // so cos(θ) > ~0.99923 → dotProduct > 0.99923. We can convert to a
    // squared-chord cutoff: |Δ|² < 2(1 − cos θ). Anything over that, skip.
    const cosLat = Math.cos(cursorLat * D2R);
    const cx = cosLat * Math.sin(cursorLon * D2R);
    const cy = Math.sin(cursorLat * D2R);
    const cz = cosLat * Math.cos(cursorLon * D2R);
    const maxAng = HOVER_MAX_KM / EARTH_R_KM;
    const chordSqMax = 2 * (1 - Math.cos(maxAng));

    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < fixes.length; i++) {
        const f = fixes[i];
        const p = f.p;
        const cosLat2 = Math.cos(p.la * D2R);
        const px = cosLat2 * Math.sin(p.lo * D2R);
        const py = Math.sin(p.la * D2R);
        const pz = cosLat2 * Math.cos(p.lo * D2R);
        const dx = px - cx, dy = py - cy, dz = pz - cz;
        const chordSq = dx * dx + dy * dy + dz * dz;
        if (chordSq > chordSqMax) continue;
        // chord² → great-circle distance in km. d = 2R·asin(|chord|/2).
        const chord = Math.sqrt(chordSq);
        const d = 2 * EARTH_R_KM * Math.asin(Math.min(1, chord / 2));
        if (d < bestD) { bestD = d; best = { sid: f.sid, p, dist: d }; }
    }
    if (bestD > HOVER_MAX_KM) return null;
    return best;
}

function ensureTooltip() {
    let el = document.getElementById('track-tooltip');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'track-tooltip';
    el.className = 'track-tooltip hidden';
    document.body.appendChild(el);
    return el;
}

function showTooltip(el, clientX, clientY, hit) {
    const meta = _stormMeta[hit.sid] || {};
    const stormName = (meta.name && meta.name !== 'UNNAMED') ? meta.name
                    : (hit.p.n && hit.p.n !== 'NR' && hit.p.n !== 'NOT_NAMED') ? hit.p.n
                    : 'Unnamed';
    const cat = intensityCat(hit.p.w);
    const basin = BASIN_NAMES[meta.basin] || meta.basin || '';
    const wKt = (hit.p.w != null && Number.isFinite(hit.p.w)) ? `${hit.p.w} kt` : '— kt';
    const pHpa = (hit.p.p != null && Number.isFinite(hit.p.p)) ? `${hit.p.p} hPa` : '';
    const dateStr = fmtFixDate(hit.p.t);

    el.innerHTML =
        `<div class="tt-title">${stormName} <span class="tt-year">${meta.year || ''}</span></div>` +
        (basin ? `<div class="tt-basin">${basin}</div>` : '') +
        `<div class="tt-row"><span class="tt-cat" style="color:${cat.color}">${cat.label}</span> · ${wKt}${pHpa ? ' · ' + pHpa : ''}</div>` +
        `<div class="tt-date">${dateStr}</div>`;

    const pad = 14;
    const w = el.offsetWidth || 220;
    const h = el.offsetHeight || 80;
    let x = clientX + pad;
    let y = clientY + pad;
    if (x + w > window.innerWidth)  x = clientX - w - pad;
    if (y + h > window.innerHeight) y = clientY - h - pad;
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
    el.classList.remove('hidden');
}

function hideTooltip(el) { el?.classList.add('hidden'); }

function setupHover() {
    const mount = document.getElementById('globe-mount');
    if (!mount || !window.envGlobe) return;
    const canvas = mount.querySelector('canvas');
    if (!canvas) return;
    const tt = ensureTooltip();
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let lastAt = 0;

    canvas.addEventListener('pointermove', (e) => {
        if (e.buttons !== 0) { hideTooltip(tt); return; }
        const now = performance.now();
        if (now - lastAt < HOVER_THROTTLE_MS) return;
        lastAt = now;

        // Tracks render on the globe view only; in map/orbit just hide.
        const s = window.envGlobe.state || {};
        if (s.viewMode !== 'globe') { hideTooltip(tt); return; }

        // Respect the user's TC-tracks toggle — no hover on hidden tracks.
        const toggle = document.getElementById('toggle-tracks');
        if (toggle && !toggle.checked) { hideTooltip(tt); return; }

        const rect = canvas.getBoundingClientRect();
        ndc.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
        ndc.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, window.envGlobe.camera);
        const hits = raycaster.intersectObject(window.envGlobe.globe);
        if (!hits.length) { hideTooltip(tt); return; }

        const local = window.envGlobe.globe.parent.worldToLocal(hits[0].point.clone());
        const n = local.length() || 1;
        const lat = Math.asin(local.y / n) * 180 / Math.PI;
        const lon = Math.atan2(local.x, local.z) * 180 / Math.PI;

        const found = findNearestFix(lat, lon);
        if (!found) { hideTooltip(tt); return; }

        showTooltip(tt, e.clientX, e.clientY, found);
    });
    canvas.addEventListener('pointerleave', () => hideTooltip(tt));
    canvas.addEventListener('pointerdown',  () => hideTooltip(tt));
}

function init() {
    if (!window.envGlobe) {
        console.warn('[ClimGlobe] window.envGlobe missing — was #globe-mount in the DOM?');
        return;
    }
    _overlay = new TrackOverlay(window.envGlobe.globeGroup);
    window.envGlobe.on('field-updated', refreshTracks);
    // Sync the Line2 LineMaterial resolution to the actual globe canvas
    // (NOT window) so linewidth in CSS pixels is computed correctly. Window
    // dimensions include the sidebar, which makes lines render thinner than
    // requested and can clip them entirely on smaller viewports.
    const syncResolution = () => {
        const mount = document.getElementById('globe-mount');
        if (!mount || !_overlay) return;
        const r = mount.getBoundingClientRect();
        _overlay.onResize(Math.max(1, r.width), Math.max(1, r.height));
    };
    syncResolution();
    window.addEventListener('resize', syncResolution);

    // TC-relevant defaults. Dropdowns own state in globe.js — dispatching
    // 'change' is how we override the engine's built-in field='t'/level=500
    // /month=1 defaults.
    setSelect('field-select', 'sst');
    setSelect('month-select', '9');

    Promise.all([loadTracks(), loadStormMeta()]).then(refreshTracks);

    document.addEventListener('change', (e) => {
        if (e.target && e.target.id === 'toggle-tracks') refreshTracks();
    });

    setupHover();
}

init();
