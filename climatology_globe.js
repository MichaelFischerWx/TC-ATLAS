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
import { setFieldCache } from './vendor/gc-atlas/era5.js';
import { computeACE, anomalyTransform, correlate } from './correlation.js';

const DATA_VER = 'v20260408';
const TRACKS_MANIFEST = 'ibtracs_tracks_manifest.json?' + DATA_VER;
const TRACKS_JSON_FALLBACK = 'ibtracs_tracks.json?' + DATA_VER;
const STORMS_JSON = 'ibtracs_storms.json?' + DATA_VER;

let _tracks = {};
let _stormMeta = {};            // sid → { name, year, basin, peak_wind_kt, ... }
let _overlay = null;
let _aceByBasin = null;         // computed once tracks load: { NA: {year: ace}, ..., GLOBAL: ... }
let _correlationActive = false; // true while displaying a correlation map; resets on field switch
let _preCorrField = null;       // remembers the field the user came from so we can advertise restore

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

// ── Correlation panel ─────────────────────────────────────────
//
// Runs when the user clicks "Compute correlation". Loads every per-year
// tile for the current (field, level, month), runs the anomaly transform
// against the chosen ACE basin time series, computes Pearson r + p per
// pixel, masks insignificant cells to NaN, and injects the result into
// era5.js's cache as the synthetic 'corr' field. Engine then displays it
// via the standard colormap pipeline. Switching back to any real field
// from the Field dropdown exits correlation mode automatically.

function _statusEl() { return document.getElementById('correlation-status'); }
function _setStatus(msg) {
    const el = _statusEl();
    if (el) el.textContent = msg;
}

async function _loadPerYearTilesForCurrentField(month) {
    // Walk the per-year manifest's `years` for the current field, fetch
    // each (year, month) tile, and build [{year, values}, …]. requestField
    // returns synchronously (cached value or null) and only kicks off the
    // fetch — we have to wait for tiles to actually land via the
    // onFieldLoaded subscription.
    const app = window.envGlobe;
    if (!app) return null;
    const field = (app.state.field === 'corr') ? (_preCorrField || 'sst') : app.state.field;
    const level = app.state.level;
    const era5 = await import('./vendor/gc-atlas/era5.js');
    const mfst = era5.getManifest('per_year');
    if (!mfst) {
        _setStatus('Per-year manifest not loaded yet — pick "Single year" once first.');
        return null;
    }
    // Resolve var location in manifest to grab its year list.
    let varMeta = null;
    for (const grp of Object.values(mfst.groups || {})) {
        if (grp[field]) { varMeta = grp[field]; break; }
    }
    if (!varMeta) {
        _setStatus(`Field ${field} not in per-year manifest.`);
        return null;
    }
    // Use year_months (per-month coverage) when available so we don't
    // wait on a year that doesn't have a tile for the requested month
    // (e.g. SST 2026/09 doesn't exist as of writing — it'd 404 and
    // hang the wait loop until our timeout).
    let years;
    if (Array.isArray(varMeta.year_months) && varMeta.year_months.length) {
        const set = new Set();
        for (const e of varMeta.year_months) {
            if (Array.isArray(e) && e[1] === month) set.add(e[0]);
        }
        years = [...set].sort((a, b) => a - b);
    } else {
        years = (varMeta.years || []).slice();
    }
    if (years.length < 10) {
        _setStatus(`Only ${years.length} years available for month ${month} — too few.`);
        return null;
    }

    // Subscribe BEFORE kicking off fetches so we don't miss arrivals.
    const pending = new Set(years);
    let resolveAll;
    const allDone = new Promise(r => { resolveAll = r; });
    const unsub = era5.onFieldLoaded(({ name, month: m, year, period }) => {
        if (name !== field || m !== month || period !== 'per_year') return;
        pending.delete(year);
        if (pending.size === 0) resolveAll();
    });

    // Trigger fetches; remove already-cached years from the pending set.
    // cachedMonth returns the Float32Array directly (or null) — NOT a
    // {values, vmin, vmax} cell, despite the surrounding cache being keyed
    // by such cells. `Array.isArray` would miss typed arrays, so check the
    // length property — typed arrays expose it, the .values *method* on
    // them does not.
    for (const y of years) {
        const cached = era5.cachedMonth(field, month, level, 'mean', 'per_year', y);
        if (cached && cached.length > 0) {
            pending.delete(y);
        } else {
            era5.requestField(field, { month, level, kind: 'mean', period: 'per_year', year: y });
        }
    }
    if (pending.size === 0) {
        unsub();
    } else {
        _setStatus(`Fetching ${pending.size} of ${years.length} per-year tiles…`);
        // Safety timeout: if some tiles 404 silently, don't hang forever.
        const timeout = new Promise(r => setTimeout(r, 30000));
        await Promise.race([allDone, timeout]);
        unsub();
    }

    // Pull whatever made it into the cache. cachedMonth returns the
    // Float32Array (or null) — assign it directly to `values`, don't
    // try to unwrap a `.values` property (Float32Array.prototype.values
    // is an iterator METHOD, so `cell.values` would be a 0-arity function
    // that silently passes truthy checks but has length 0 and produces
    // empty correlation outputs — this was the original 0-cells bug).
    const grids = [];
    for (const y of years) {
        const values = era5.cachedMonth(field, month, level, 'mean', 'per_year', y);
        if (values && values.length > 0) grids.push({ year: y, values });
    }
    return grids;
}

async function applyCorrelation() {
    const app = window.envGlobe;
    if (!app) return;
    if (!_aceByBasin) {
        _setStatus('Tracks still loading — try again in a moment.');
        return;
    }
    const indexEl  = document.getElementById('correlation-index');
    const pvalEl   = document.getElementById('correlation-pval');
    const anomBtns = document.querySelectorAll('#correlation-anom-toggle button.active');
    const indexId = indexEl?.value || 'ace_GLOBAL';
    const pvalThresh = Math.max(0, Math.min(1, parseFloat(pvalEl?.value || '0.05')));
    const anomMode = anomBtns[0]?.dataset?.corrAnom || 'sliding';

    // ACE index → year → value
    const basin = indexId.replace(/^ace_/, '');
    const indexSeries = _aceByBasin[basin];
    if (!indexSeries) {
        _setStatus(`Index ${indexId} unavailable.`);
        return;
    }

    const month = app.state.month;
    const t0 = performance.now();
    const grids = await _loadPerYearTilesForCurrentField(month);
    if (!grids || grids.length === 0) return;
    _setStatus(`Computing anomalies (${anomMode})…`);
    console.log('[Correlation] grids:', grids.length, 'years:',
                grids[0].year, '→', grids[grids.length - 1].year,
                'sample0=', grids[0].values[Math.round(grids[0].values.length / 2)]);
    console.log('[Correlation] index basin:', basin,
                'years available:', Object.keys(indexSeries).length,
                'samples e.g. 2005:', indexSeries[2005],
                '1995:', indexSeries[1995]);
    const overlap = grids.filter(g => Number.isFinite(indexSeries[g.year])).length;
    console.log('[Correlation] year-overlap (grid ∩ index):', overlap);

    const anom = anomalyTransform(grids, anomMode, { fixedSpan: [1991, 2020] });
    const sample = anom[Math.floor(anom.length / 2)];
    console.log('[Correlation] anom[mid].year:', sample.year,
                'anom[mid] sample value:', sample.values[Math.round(sample.values.length / 2)]);
    _setStatus(`Computing Pearson r over ${grids.length} years…`);
    const { r, p, n } = correlate(anom, indexSeries);

    let finiteR = 0, maxAbsR = 0, maxN = 0;
    for (let i = 0; i < r.length; i++) {
        if (Number.isFinite(r[i])) { finiteR++; maxAbsR = Math.max(maxAbsR, Math.abs(r[i])); }
        if (n[i] > maxN) maxN = n[i];
    }
    console.log('[Correlation] r stats — finite:', finiteR, '/', r.length,
                'max |r|:', maxAbsR.toFixed(3), 'max n:', maxN);

    // Hard p-mask: cells with p > threshold → NaN so engine renders transparent.
    let kept = 0;
    for (let i = 0; i < r.length; i++) {
        if (!Number.isFinite(p[i]) || p[i] > pvalThresh) r[i] = NaN;
        else kept++;
    }
    // Symmetric ±1 colorbar even if local extrema fall short.
    const peak = Math.max(0.01, ...Array.from(r).filter(Number.isFinite).map(Math.abs));
    const vmin = -peak, vmax = peak;
    console.log('[Correlation] kept after p-mask:', kept, 'peak |r|:', peak.toFixed(3));

    // Inject the synthetic 'corr' field at the current month so the engine
    // displays it. level=null because corr is a single-level field.
    setFieldCache('corr', { month, level: null, kind: 'mean', period: 'default', year: null,
                            values: r, vmin, vmax });

    // Remember the field we came from so the user can restore by re-picking
    // it from the dropdown. Mark correlation active.
    if (app.state.field !== 'corr') {
        _preCorrField = app.state.field;
        // Switch to the diverging colormap. The engine doesn't auto-pick a
        // field's preferred cmap on field change — state.cmap is sticky —
        // so we set it explicitly. _preCorrField is restored when the user
        // exits correlation mode via the field dropdown.
        app.setState({ field: 'corr', cmap: 'RdBu_r' });
    } else {
        // Already in corr mode (e.g., recompute on month change). Force a
        // repaint via the field-switch path so the new tile is picked up.
        app.setState({ field: 'corr' });
    }
    _correlationActive = true;

    const ms = (performance.now() - t0).toFixed(0);
    _setStatus(`Done · ${kept.toLocaleString()} significant cells (p ≤ ${pvalThresh}) · ${ms} ms`);
}

function bindCorrelationPanel() {
    const applyBtn = document.getElementById('correlation-apply-btn');
    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            applyBtn.classList.add('is-computing');
            applyCorrelation()
                .catch(err => { console.error('[Correlation]', err); _setStatus('Error: ' + err.message); })
                .finally(() => applyBtn.classList.remove('is-computing'));
        });
    }
    // Anomaly-mode segmented toggle.
    const anomBtns = document.querySelectorAll('#correlation-anom-toggle button');
    anomBtns.forEach(btn => btn.addEventListener('click', () => {
        anomBtns.forEach(b => b.classList.toggle('active', b === btn));
    }));
    // When the user picks any non-corr field from the Field dropdown,
    // exit correlation mode and restore the natural colormap for the
    // newly-selected field (cmap is sticky across field changes by
    // design, but for correlation the diverging cmap was unique to corr).
    const fieldSel = document.getElementById('field-select');
    if (fieldSel) {
        fieldSel.addEventListener('change', () => {
            if (fieldSel.value !== 'corr') {
                _correlationActive = false;
                _preCorrField = null;
                // Restore the new field's preferred cmap if it has one.
                import('./vendor/gc-atlas/data.js').then(({ FIELDS }) => {
                    const m = FIELDS[fieldSel.value];
                    if (m && m.cmap) window.envGlobe?.setState({ cmap: m.cmap });
                });
            }
        });
    }
    // Recompute on month change while correlation is active so scrubbing
    // months stays meaningful (each month has its own correlation map).
    const monthSel = document.getElementById('month-select');
    if (monthSel) {
        monthSel.addEventListener('change', () => {
            if (_correlationActive && window.envGlobe?.state?.field === 'corr') {
                // Run async; the engine has already fired its 'change' chain
                // but the corr-tile for the new month doesn't exist yet, so
                // the globe will be blank until our recompute lands.
                applyCorrelation().catch(err => console.error('[Correlation]', err));
            }
        });
    }
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

    Promise.all([loadTracks(), loadStormMeta()]).then(() => {
        refreshTracks();
        // ACE per (basin, year) for the Index Correlation panel. Cheap
        // enough (~tens of ms over 13.5k tracks) to compute synchronously.
        try {
            _aceByBasin = computeACE(_tracks);
            const yrs = Object.keys(_aceByBasin.GLOBAL || {}).length;
            console.log(`[ClimGlobe] Computed ACE per basin (${yrs} years)`);
        } catch (err) {
            console.warn('[ClimGlobe] ACE compute failed:', err);
        }
    });

    document.addEventListener('change', (e) => {
        if (e.target && e.target.id === 'toggle-tracks') refreshTracks();
    });

    bindCorrelationPanel();
    setupHover();
}

init();
