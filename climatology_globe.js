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
import { FIELDS } from './vendor/gc-atlas/data.js';
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

// Tiny GA wrapper — mirrors the pattern in realtime_ir.js / satellite.js so
// climatology-globe usage shows up alongside the other pages in GA. Silent
// no-op if gtag isn't loaded (local dev, ad-blocker, etc.).
function _ga(action, params) {
    if (typeof gtag === 'function') {
        try { gtag('event', action, params || {}); } catch (e) { /* silent */ }
    }
}

// Per-field "learn more" metadata for the ⓘ popover. Lives here (not in
// vendor/gc-atlas/data.js) so the vendored upstream stays clean — anything
// TC-ATLAS-specific belongs in this layer. Keyed by FIELDS[name] key.
//
// `short`     : one-sentence layperson description (3–4 lines max).
// `learn_url` : link to authoritative reference (ECMWF param DB for raw
//               ERA5 vars, DOI for derived-field seminal papers).
// `learn_label`: link text shown in the popover.
//
// Raw ERA5 fields default to the Copernicus ERA5 monthly-means dataset
// page when no explicit entry exists. Derived fields and synthetic 'corr'
// have explicit entries so the popover never shows a stale fallback.
var _FIELD_INFO = {
    // ── Pressure-coord raw fields (ECMWF param DB IDs) ──
    t:    { short: 'Air temperature on a pressure surface, from ERA5 reanalysis.',          learn_url: 'https://codes.ecmwf.int/grib/param-db/130', learn_label: 'ECMWF parameter DB' },
    u:    { short: 'Zonal (east-positive) component of horizontal wind on a pressure surface.', learn_url: 'https://codes.ecmwf.int/grib/param-db/131', learn_label: 'ECMWF parameter DB' },
    v:    { short: 'Meridional (north-positive) component of horizontal wind on a pressure surface.', learn_url: 'https://codes.ecmwf.int/grib/param-db/132', learn_label: 'ECMWF parameter DB' },
    z:    { short: 'Geopotential — gravitational potential per unit mass; height of a pressure surface above the geoid.', learn_url: 'https://codes.ecmwf.int/grib/param-db/129', learn_label: 'ECMWF parameter DB' },
    q:    { short: 'Specific humidity — mass of water vapour per unit mass of moist air.', learn_url: 'https://codes.ecmwf.int/grib/param-db/133', learn_label: 'ECMWF parameter DB' },
    r:    { short: 'Relative humidity — water-vapour pressure as a fraction of saturation vapour pressure at the local temperature.', learn_url: 'https://codes.ecmwf.int/grib/param-db/157', learn_label: 'ECMWF parameter DB' },
    vo:   { short: 'Relative vorticity — vertical component of curl of horizontal wind. Positive = cyclonic in the NH.', learn_url: 'https://codes.ecmwf.int/grib/param-db/138', learn_label: 'ECMWF parameter DB' },
    d:    { short: 'Horizontal divergence — net mass flux out of a unit area; positive = upper-level outflow / lower-level mass loss.', learn_url: 'https://codes.ecmwf.int/grib/param-db/155', learn_label: 'ECMWF parameter DB' },
    w:    { short: 'Vertical velocity in pressure coords (Pa s⁻¹). Negative = ascent.', learn_url: 'https://codes.ecmwf.int/grib/param-db/135', learn_label: 'ECMWF parameter DB' },

    // ── Helmholtz decomposition (computed offline by build_helmholtz.py) ──
    psi:  { short: 'Streamfunction — non-divergent (rotational) part of horizontal flow. ∇²ψ = ζ.',
            learn_url: 'https://glossary.ametsoc.org/wiki/Streamfunction', learn_label: 'AMS Glossary' },
    chi:  { short: 'Velocity potential — divergent (irrotational) part of horizontal flow. ∇²χ = δ.',
            learn_url: 'https://glossary.ametsoc.org/wiki/Velocity_potential', learn_label: 'AMS Glossary' },

    // ── Surface fields ──
    t2m:  { short: '2-m air temperature interpolated between the surface and the lowest model level.', learn_url: 'https://codes.ecmwf.int/grib/param-db/167', learn_label: 'ECMWF parameter DB' },
    d2m:  { short: '2-m dewpoint temperature; difference (T − Td) is a moisture deficit proxy.',    learn_url: 'https://codes.ecmwf.int/grib/param-db/168', learn_label: 'ECMWF parameter DB' },
    sst:  { short: 'Sea-surface temperature, blended observational analysis (HadISST + OSTIA in ERA5).', learn_url: 'https://codes.ecmwf.int/grib/param-db/34',  learn_label: 'ECMWF parameter DB' },
    msl:  { short: 'Mean sea-level pressure — surface pressure reduced to sea level using a hypsometric correction.', learn_url: 'https://codes.ecmwf.int/grib/param-db/151', learn_label: 'ECMWF parameter DB' },
    sp:   { short: 'Surface pressure at the actual orography (no sea-level reduction).',           learn_url: 'https://codes.ecmwf.int/grib/param-db/134', learn_label: 'ECMWF parameter DB' },
    blh:  { short: 'Boundary-layer height — depth of the well-mixed layer adjacent to the surface.', learn_url: 'https://codes.ecmwf.int/grib/param-db/159', learn_label: 'ECMWF parameter DB' },
    tcwv: { short: 'Total column water vapour (precipitable water) — vertically integrated specific humidity.', learn_url: 'https://codes.ecmwf.int/grib/param-db/137', learn_label: 'ECMWF parameter DB' },
    tp:   { short: 'Total precipitation rate (large-scale + convective).',                          learn_url: 'https://codes.ecmwf.int/grib/param-db/228', learn_label: 'ECMWF parameter DB' },
    ews:  { short: 'Eastward turbulent surface wind stress (momentum flux into the surface).',     learn_url: 'https://codes.ecmwf.int/grib/param-db/180', learn_label: 'ECMWF parameter DB' },
    sshf: { short: 'Surface sensible heat flux. Positive = upward (from surface to atmosphere).',   learn_url: 'https://codes.ecmwf.int/grib/param-db/146', learn_label: 'ECMWF parameter DB' },
    slhf: { short: 'Surface latent heat flux. Positive = upward; evaporation cools the surface.',   learn_url: 'https://codes.ecmwf.int/grib/param-db/147', learn_label: 'ECMWF parameter DB' },
    ssr:  { short: 'Net surface short-wave radiation (down − up).',                                  learn_url: 'https://codes.ecmwf.int/grib/param-db/176', learn_label: 'ECMWF parameter DB' },
    str:  { short: 'Net surface long-wave radiation (down − up). Usually upward, hence negative.',  learn_url: 'https://codes.ecmwf.int/grib/param-db/177', learn_label: 'ECMWF parameter DB' },
    tisr: { short: 'Top-of-atmosphere incoming solar radiation — pure astronomical/insolation forcing.', learn_url: 'https://codes.ecmwf.int/grib/param-db/212', learn_label: 'ECMWF parameter DB' },
    ttr:  { short: 'Top-of-atmosphere net long-wave radiation (OLR with ERA5 sign convention).',    learn_url: 'https://codes.ecmwf.int/grib/param-db/179', learn_label: 'ECMWF parameter DB' },

    // ── Derived fields (computed in browser from component tiles) ──
    wspd: { short: 'Horizontal wind speed |V| = √(u² + v²) computed from component winds.',         learn_url: null,                                  learn_label: '' },
    pv:   { short: 'Ertel potential vorticity on isentropic surfaces — a Lagrangian-conserved tracer of dynamical activity. 1 PVU = 10⁻⁶ K m² kg⁻¹ s⁻¹. Tropopause ≈ 2 PVU.', learn_url: 'https://glossary.ametsoc.org/wiki/Potential_vorticity', learn_label: 'AMS Glossary' },
    mse:  { short: 'Moist static energy / cₚ. h = cₚT + gz + Lq — conserved under adiabatic + reversible-moist processes; tracks deep-convective stability.', learn_url: 'https://glossary.ametsoc.org/wiki/Moist_static_energy', learn_label: 'AMS Glossary' },
    dls:  { short: 'Deep-layer shear computed from monthly-mean winds: |⟨V₂₀₀⟩ − ⟨V₈₅₀⟩|. Underestimates the climatology of instantaneous shear (Jensen) — for TC genesis thresholds use a daily-resolved product.', learn_url: 'https://glossary.ametsoc.org/wiki/Vertical_wind_shear', learn_label: 'AMS Glossary' },
    mpi:  { short: 'Bister–Emanuel maximum potential intensity — theoretical upper bound on TC wind speed given local SST + atmospheric T/q profile (14 levels). Computed offline with Gilford\'s tcpyPI (vectorized BE-2002 in Python). NaN over land and where the algorithm fails to converge.',
            learn_url: 'https://doi.org/10.5194/gmd-14-2351-2021', learn_label: 'Gilford (2021) — tcpyPI · GMD' },

    // ── Synthetic ──
    corr: { short: 'Per-pixel Pearson correlation coefficient between the active field and the chosen climate-index time series. NaN cells fail the p-value threshold.', learn_url: null, learn_label: '' },
};

// Default fallback link for any raw ERA5 field without an explicit entry.
var _ERA5_DATASET_PRESSURE = 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-pressure-levels-monthly-means';
var _ERA5_DATASET_SINGLE   = 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels-monthly-means';

// Pre-compute the UTC year+month integer on each best-track fix once at load
// time. Without this, every TrackOverlay.render() call re-parses ~400 k
// timestamps via parseUTC + getUTCFullYear + getUTCMonth — the dominant cost
// on every field/month change.
function _annotateTracks(tracks) {
    const sids = Object.keys(tracks);
    for (let i = 0; i < sids.length; i++) {
        const arr = tracks[sids[i]];
        if (!arr) continue;
        for (let j = 0; j < arr.length; j++) {
            const p = arr[j];
            if (!p || !p.t || p._y != null) continue;  // already annotated
            const dt = parseUTC(p.t);
            p._y = dt.getUTCFullYear();
            p._m = dt.getUTCMonth() + 1;
        }
    }
}

function loadTracks() {
    return fetch(TRACKS_MANIFEST)
        .then(r => { if (!r.ok) throw new Error('manifest unavailable'); return r.json(); })
        .then(m => {
            const chunks = m.chunks || [];
            return Promise.all(chunks.map(f => fetch(f + '?' + DATA_VER).then(r => r.json())));
        })
        .then(chunkArr => {
            chunkArr.forEach(c => Object.assign(_tracks, c));
            _annotateTracks(_tracks);
            console.log('[ClimGlobe] Loaded tracks for ' + Object.keys(_tracks).length + ' storms');
        })
        .catch(() => fetch(TRACKS_JSON_FALLBACK)
            .then(r => r.json())
            .then(d => {
                _tracks = d;
                _annotateTracks(_tracks);
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

// Track render is expensive (~400k fix iterations + the merged-Line geometry
// build). 'field-updated' fires on every field/level/colormap change too,
// so dedupe against (yearFilter, month, visible). Field-only changes become
// no-ops.
//
// When a composite is active (state.customRange.years is set), we filter
// tracks to ONLY those event years × the composite's month — so the storms
// shown match the years the composite was built from. This makes the
// "RONI > 1.0 in Sep" composite, for example, light up only the storm
// tracks from those Sep months.
let _lastRenderKey = null;
function refreshTracks(force) {
    if (!_overlay || !window.envGlobe) return;
    const s = window.envGlobe.state || {};
    const toggle = document.getElementById('toggle-tracks');
    const visible = toggle ? toggle.checked : true;
    _overlay.setVisible(visible);
    if (!visible) return;

    // Tracks dict isn't loaded yet — bail without writing the dedupe key
    // so the post-load refresh actually paints (it'd otherwise see an
    // identical key and short-circuit, leaving the globe with no tracks
    // until the user toggled the checkbox off and on).
    if (!_tracks || Object.keys(_tracks).length === 0) return;

    // Year filter: composite year-list > single year > null (any year).
    const cr = s.customRange;
    let yearFilter = null;
    let monthFilter = s.month;
    let yearScopeActive = false;  // true when a composite or single year is active
    if (cr && Array.isArray(cr.years) && cr.years.length) {
        yearFilter = cr.years;
        yearScopeActive = true;
        // Composites are anchored on a specific month (cr.month); use that
        // explicitly rather than s.month so the painted tracks always agree
        // with the year list the composite was built from.
        if (Number.isFinite(cr.month)) monthFilter = cr.month;
        // Multi-month composites carry months[]; if so, use those.
        if (Array.isArray(cr.months) && cr.months.length) monthFilter = cr.months;
    } else if (s.year != null && Number.isFinite(s.year)) {
        yearFilter = s.year;
        yearScopeActive = true;
    }

    // "Show all months in active year(s)" — when a year scope is active
    // (composite OR single year), let the user override the month filter
    // to null so every storm in those years paints, regardless of which
    // month the field is displaying. No-op when no year scope is active
    // (climatology view already shows the chosen month across all years).
    const allMonthsCB = document.getElementById('toggle-tracks-all-months');
    const wantAllMonths = !!(allMonthsCB && allMonthsCB.checked);
    if (wantAllMonths && yearScopeActive) monthFilter = null;

    // "Limit to the active climatology window" — when no other year
    // scope is active, restrict the track overlay to the years inside
    // the selected 30-yr climatology window (e.g. 1991-2020). Useful
    // when comparing a climatology field to the storms that actually
    // occurred during the same baseline. No-op if a composite or
    // single-year scope is already in play (those windows take
    // precedence). The active window is encoded as "<start>-<end>"
    // in state.climatologyPeriod, with 'default' meaning 1991-2020.
    const climoWindowCB = document.getElementById('toggle-tracks-climo-window');
    const wantClimoWindow = !!(climoWindowCB && climoWindowCB.checked);
    if (wantClimoWindow && !yearScopeActive) {
        const cp = s.climatologyPeriod || 'default';
        const period = (cp === 'default') ? '1991-2020' : cp;
        const m = /^(\d{4})-(\d{4})$/.exec(period);
        if (m) {
            const start = +m[1], end = +m[2];
            const yrs = [];
            for (let y = start; y <= end; y++) yrs.push(y);
            yearFilter = yrs;
        }
    }

    // Build a stable key that accounts for the year-list shape.
    const yearKey  = Array.isArray(yearFilter)  ? yearFilter.join(',')  : String(yearFilter);
    const monthKey = Array.isArray(monthFilter) ? monthFilter.join(',') : String(monthFilter);
    const key = yearKey + '|' + monthKey;
    if (!force && key === _lastRenderKey) return;
    _lastRenderKey = key;
    _overlay.render(_tracks, yearFilter, monthFilter);
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

// Returns a per-year list of {year, values} for the active field at the
// given month + level, supporting both raw (manifest-backed) and JS-derived
// fields (wspd, dls, mse — computed in data.js's getField from component
// tiles). For derived fields each year requires multiple component tiles
// (e.g. dls = |⟨V₂₀₀⟩ − ⟨V₈₅₀⟩| → 4 component tiles per year), so the wait
// loop subscribes to ANY onFieldLoaded event and re-polls getField until
// every year resolves to isReal:true (or timeout).
async function _loadPerYearTilesForCurrentField(month, yearRange) {
    const app = window.envGlobe;
    if (!app) return null;
    const field = (app.state.field === 'corr') ? (_preCorrField || 'sst') : app.state.field;
    const level = app.state.level;
    const era5 = await import('./vendor/gc-atlas/era5.js');
    const data = await import('./vendor/gc-atlas/data.js');
    const meta = data.FIELDS[field];
    if (!meta) {
        _setStatus(`Field ${field} not in FIELDS.`);
        return null;
    }
    const isDerived = !!meta.derived;
    const mfst = era5.getManifest('per_year');
    if (!mfst) {
        _setStatus('Per-year manifest not loaded yet — pick "Single year" once first.');
        return null;
    }

    // Year list:
    //   raw fields → that field's own year_months filtered to the active month
    //   derived fields → use any sample component's year_months (u for wspd
    //                    / dls, t for mse) — they all share the same coverage
    //                    by virtue of being downloaded together.
    const sampleVar = isDerived
        ? (field === 'mse' ? 't' : 'u')
        : field;
    let varMeta = null;
    for (const grp of Object.values(mfst.groups || {})) {
        if (grp[sampleVar]) { varMeta = grp[sampleVar]; break; }
    }
    if (!varMeta) {
        _setStatus(`No per-year coverage info for ${field} (sample var ${sampleVar} missing).`);
        return null;
    }
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
    // Optional user-supplied [startYear, endYear] clip — used by the
    // correlation panel so the user can constrain the regression to a
    // specific era (e.g., post-1966 satellite era for EP/WP ACE).
    if (yearRange && (Number.isFinite(yearRange[0]) || Number.isFinite(yearRange[1]))) {
        const lo = Number.isFinite(yearRange[0]) ? yearRange[0] : -Infinity;
        const hi = Number.isFinite(yearRange[1]) ? yearRange[1] : +Infinity;
        years = years.filter(y => y >= lo && y <= hi);
    }
    if (years.length < 10) {
        const span = (yearRange && (Number.isFinite(yearRange[0]) || Number.isFinite(yearRange[1])))
            ? ` in your year range (${yearRange[0] ?? '−∞'}–${yearRange[1] ?? '+∞'})` : '';
        _setStatus(`Only ${years.length} years available for month ${month}${span} — need ≥ 10.`);
        return null;
    }

    // Probe-then-wait pattern. For each year, call getField — for raw
    // fields this kicks off the per-year tile fetch and (if cached) returns
    // immediately with isReal:true; for derived fields it kicks off the
    // component tile fetches. We subscribe to ANY onFieldLoaded and re-poll
    // pending years on each fire (cheap — just dict lookups).
    const opts = (year) => ({
        month, level, year, coord: 'pressure',
        kind: 'mean', period: 'per_year',
    });
    const grids = [];
    const pending = new Set(years);
    const tryAll = () => {
        for (const y of [...pending]) {
            const f = data.getField(field, opts(y));
            if (f && f.isReal && f.values && f.values.length > 0) {
                grids.push({ year: y, values: f.values });
                pending.delete(y);
            }
        }
    };
    tryAll();

    if (pending.size > 0) {
        _setStatus(`Fetching tiles for ${pending.size} of ${years.length} years` +
                   (isDerived ? ` (derived field — multiple tiles per year)` : '') + '…');
        await new Promise(resolve => {
            let lastUpdate = performance.now();
            const unsub = era5.onFieldLoaded(() => {
                tryAll();
                if (pending.size === 0) {
                    unsub();
                    clearTimeout(to);
                    resolve();
                    return;
                }
                // Throttle status updates so we don't spam the UI on every
                // tile arrival (could be hundreds for derived fields).
                const now = performance.now();
                if (now - lastUpdate > 250) {
                    _setStatus(`Fetching tiles for ${pending.size} of ${years.length} years…`);
                    lastUpdate = now;
                }
            });
            // Safety timeout — derived fields can need 200+ tiles, so allow
            // 90 s rather than the 30 s for raw.
            const to = setTimeout(() => { unsub(); resolve(); }, 90000);
        });
        // Final pass to pick up anything that landed during the closing race.
        tryAll();
    }

    grids.sort((a, b) => a.year - b.year);
    return grids;
}

// Capture the corr field's original generic name + note at module load so
// we can restore them when the user exits correlation mode. After a run,
// applyCorrelation overrides .name with "<field> × <index>" and .note
// with the year span / anom mode / p-threshold — those are stale once
// the user picks a different display field.
const _CORR_DEFAULT_NAME = (FIELDS.corr && FIELDS.corr.name) || 'Index correlation (r)';
const _CORR_DEFAULT_NOTE = (FIELDS.corr && FIELDS.corr.note) ||
    'Per-pixel Pearson r against the chosen index time series. NaN cells fail the p-value threshold.';

function _resetCorrFieldDefaults() {
    if (!FIELDS.corr) return;
    FIELDS.corr.name = _CORR_DEFAULT_NAME;
    FIELDS.corr.note = _CORR_DEFAULT_NOTE;
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
    // Optional user year-range clip from the UI inputs.
    const yrStartEl = document.getElementById('correlation-year-start');
    const yrEndEl   = document.getElementById('correlation-year-end');
    const yrStart = yrStartEl && yrStartEl.value !== '' ? parseInt(yrStartEl.value, 10) : NaN;
    const yrEnd   = yrEndEl   && yrEndEl.value   !== '' ? parseInt(yrEndEl.value,   10) : NaN;
    const yearRange = (Number.isFinite(yrStart) || Number.isFinite(yrEnd)) ? [yrStart, yrEnd] : null;
    const t0 = performance.now();
    const grids = await _loadPerYearTilesForCurrentField(month, yearRange);
    if (!grids || grids.length === 0) return;
    _setStatus(`Computing anomalies (${anomMode})…`);
    const anom = anomalyTransform(grids, anomMode, { fixedSpan: [1991, 2020] });
    _setStatus(`Computing Pearson r over ${grids.length} years…`);
    const { r, p } = correlate(anom, indexSeries);

    // Hard p-mask: cells with p > threshold → NaN so engine renders transparent.
    let kept = 0;
    for (let i = 0; i < r.length; i++) {
        if (!Number.isFinite(p[i]) || p[i] > pvalThresh) r[i] = NaN;
        else kept++;
    }
    // Symmetric ±1 colorbar even if local extrema fall short.
    const peak = Math.max(0.01, ...Array.from(r).filter(Number.isFinite).map(Math.abs));
    const vmin = -peak, vmax = peak;

    // Inject the synthetic 'corr' field at the current month so the engine
    // displays it. level=null because corr is a single-level field.
    // Cache against the ACTIVE climatology period — the engine looks up
    // the corr tile under whichever period is selected, so writing to
    // state.climatologyPeriod (rather than always 'default') keeps the
    // tile visible when the user picks 1996-2025 / 1961-1990 / etc.
    const cachePeriod = app.state.climatologyPeriod || 'default';
    setFieldCache('corr', { month, level: null, kind: 'mean', period: cachePeriod, year: null,
                            values: r, vmin, vmax });

    // ── Update the corr field's display title + footnote so the
    // sidebar caption AND the saved-image colorbar panel say what's
    // actually being correlated, instead of the generic
    // "Index correlation (r)". E.g.:
    //   name → "Sea surface temperature × ACE (N. Atlantic)"
    //   note → "1961–2025 (65 yr) · sliding anomalies · p ≤ 0.05"
    // FIELDS is mutated in place; the engine reads .name on every
    // updateField pass, so the next setState below picks up the new
    // title without any other plumbing.
    const underlyingField = (app.state.field === 'corr')
        ? (_preCorrField || 'sst')
        : app.state.field;
    const underlyingMeta = FIELDS[underlyingField] || {};
    const fieldDisplayName = underlyingMeta.name || underlyingField.toUpperCase();
    const indexLabel = (indexEl && indexEl.selectedIndex >= 0)
        ? indexEl.options[indexEl.selectedIndex].text
        : indexId;
    const yMinNow = grids[0]?.year, yMaxNow = grids[grids.length - 1]?.year;
    const spanForNote = (yMinNow && yMaxNow)
        ? `${yMinNow}–${yMaxNow} (${grids.length} yr)`
        : `${grids.length} yr`;
    if (FIELDS.corr) {
        FIELDS.corr.name = `${fieldDisplayName} × ${indexLabel}`;
        FIELDS.corr.note = `${spanForNote} · ${anomMode} anomalies · p ≤ ${pvalThresh}`;
    }

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
    const yrs = grids.length;
    const yMin = grids[0]?.year, yMax = grids[grids.length - 1]?.year;
    const spanLbl = (yMin && yMax) ? ` · ${yMin}–${yMax} (${yrs} yr)` : '';
    _setStatus(`Done · ${kept.toLocaleString()} significant cells (p ≤ ${pvalThresh})${spanLbl} · ${ms} ms`);
    _ga('clim_globe_correlation_apply', {
        index: indexId,
        anom_mode: anomMode,
        n_years: yrs,
        year_start: yMin || null,
        year_end: yMax || null,
        field: app.state.field === 'corr' ? (_preCorrField || 'unknown') : app.state.field,
        month: month,
        significant_cells: kept,
    });
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
                // Restore generic title + note on the corr field so the
                // next correlation run starts from a clean slate (the
                // dynamic title we set in applyCorrelation referenced a
                // specific field × index that's no longer relevant).
                _resetCorrFieldDefaults();
                // Restore the new field's preferred cmap if it has one.
                const m = FIELDS[fieldSel.value];
                if (m && m.cmap) window.envGlobe?.setState({ cmap: m.cmap });
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

    // Same story for the climatology-period dropdown: when the user picks
    // a different 30-yr window (e.g. 1991-2020 → 1996-2025), the engine
    // looks up the corr cache at the new period — which was never written
    // since correlation runs only ever cache against the active period at
    // their compute time. Re-run applyCorrelation on the new period.
    const climoSel = document.getElementById('climo-period-select');
    if (climoSel) {
        climoSel.addEventListener('change', () => {
            if (_correlationActive && window.envGlobe?.state?.field === 'corr') {
                applyCorrelation().catch(err => console.error('[Correlation]', err));
            }
        });
    }
}

// ── Field info popover ───────────────────────────────────────────────
//
// Renders next to the Field selector when the ⓘ button is clicked.
// Pulls the field's name + units from FIELDS (vendored data.js) and
// merges with our local _FIELD_INFO entry for the description + learn
// link. Dismissed by clicking outside, hitting Esc, or re-clicking ⓘ.
function _bindFieldInfoPopover() {
    const btn = document.getElementById('field-info-btn');
    const pop = document.getElementById('field-info-popover');
    const sel = document.getElementById('field-select');
    if (!btn || !pop || !sel) return;

    const close = () => { pop.hidden = true; };
    const open = async () => {
        const { FIELDS } = await import('./vendor/gc-atlas/data.js');
        const fname = sel.value;
        const meta = FIELDS[fname] || {};
        const info = _FIELD_INFO[fname] || {};
        const escAttr = s => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        const escText = s => String(s || '').replace(/&/g, '&amp;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // Default learn link for raw ERA5 fields without an explicit entry:
        // point at the Copernicus dataset page for the appropriate level type.
        let learnUrl   = info.learn_url || null;
        let learnLabel = info.learn_label || 'Learn more';
        if (!learnUrl && meta.group !== '_internal' && !meta.derived) {
            learnUrl = (meta.type === 'pl') ? _ERA5_DATASET_PRESSURE : _ERA5_DATASET_SINGLE;
            learnLabel = 'ERA5 dataset on CDS';
        }
        const noteOrShort = info.short || meta.note || '';
        const isDerived = !!meta.derived;
        const provider = isDerived
            ? '<span style="opacity:0.7;">Computed in browser from ERA5 components.</span>'
            : '<span style="opacity:0.7;">Source: ERA5 reanalysis (ECMWF / Copernicus C3S).</span>';
        pop.innerHTML =
            `<div class="fi-title">${escText(meta.name || fname)}` +
                (meta.units ? ` <span class="fi-units">[${escText(meta.units)}]</span>` : '') +
            `</div>` +
            (noteOrShort ? `<div class="fi-body">${escText(noteOrShort)}</div>` : '') +
            `<div class="fi-meta">${provider}</div>` +
            (learnUrl
                ? `<div class="fi-learn"><a href="${escAttr(learnUrl)}" target="_blank" rel="noopener noreferrer" class="ts-source-link">${escText(learnLabel)} ↗</a></div>`
                : '');
        pop.hidden = false;
        _ga('clim_globe_field_info_open', { field: fname });
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (pop.hidden) open(); else close();
    });
    document.addEventListener('click', (e) => {
        if (pop.hidden) return;
        if (pop.contains(e.target) || btn.contains(e.target)) return;
        close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !pop.hidden) close();
    });
    // Auto-close + re-open with fresh content if the user changes the
    // active field while the popover is open.
    sel.addEventListener('change', () => {
        if (!pop.hidden) open();
    });
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

    // Composite-builder safety hook: if the user applies a composite while
    // the Index-Correlation overlay is active (state.field='corr'), exit
    // correlation mode FIRST so the prefetch reads tiles for a real field
    // instead of 404-spamming for the synthetic 'corr' tile path.
    window.envGlobe.beforeApplyComposite = () => {
        if (window.envGlobe.state.field === 'corr' && _preCorrField) {
            _correlationActive = false;
            _resetCorrFieldDefaults();
            window.envGlobe.setState({ field: _preCorrField });
        }
    };

    // GIF-export per-frame hook: when an annual-cycle GIF is being
    // captured AND the user is in correlation mode, re-run the
    // correlation for each month before the frame is captured. Without
    // this, only the originally-computed month had a corr tile and the
    // other 11 frames painted empty. applyCorrelation reads state.month
    // (which the gif exporter has already updated) so each call computes
    // the right month's r-map.
    window.envGlobe.beforeAnnualFrame = async () => {
        if (window.envGlobe.state.field === 'corr' && _correlationActive) {
            try { await applyCorrelation(); }
            catch (err) { console.warn('[ClimGlobe] beforeAnnualFrame correlation recompute failed:', err); }
        }
    };

    _ga('clim_globe_page_load');

    // Listen for composite + field changes via the engine's emitter so we
    // capture both UI-driven and URL-restored applies. Dedupe on the
    // customRange shape so re-renders don't double-fire.
    let _lastCompositeKey = null;
    let _lastField = window.envGlobe.state?.field || null;
    let _lastMonth = window.envGlobe.state?.month || null;
    window.envGlobe.on('field-updated', () => {
        const s = window.envGlobe.state || {};
        if (s.field !== _lastField) {
            _ga('clim_globe_field_change', { field: s.field });
            _lastField = s.field;
        }
        if (s.month !== _lastMonth) {
            _ga('clim_globe_month_change', { month: s.month });
            _lastMonth = s.month;
        }
        const cr = s.customRange;
        if (cr && Array.isArray(cr.years)) {
            const key = (cr.mode || 'index') + '|' + cr.years.join(',') +
                (Array.isArray(cr.months) ? '|m=' + cr.months.join(',') : '|m=' + cr.month);
            if (key !== _lastCompositeKey) {
                _ga('clim_globe_composite_apply', {
                    mode: cr.mode || 'index',
                    n_years: cr.years.length,
                    n_months: Array.isArray(cr.months) ? cr.months.length : 1,
                    index: cr.id || null,
                });
                _lastCompositeKey = key;
            }
        } else if (_lastCompositeKey) {
            _lastCompositeKey = null;
        }
    });

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
        // Toggle-tracks changes visibility but not (year, month), so force
        // a re-render past the dedupe guard so the lines paint immediately.
        if (e.target && (e.target.id === 'toggle-tracks'
                      || e.target.id === 'toggle-tracks-all-months'
                      || e.target.id === 'toggle-tracks-climo-window'
                      || e.target.id === 'climo-period-select')) {
            refreshTracks(true);
            _ga('clim_globe_tracks_toggle', {
                id: e.target.id,
                checked: !!e.target.checked,
            });
        }
    });

    bindCorrelationPanel();
    setupHover();
    _bindFieldInfoPopover();
}

init();
