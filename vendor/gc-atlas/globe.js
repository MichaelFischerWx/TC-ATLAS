// GC-ATLAS — interactive globe renderer (Three.js).
// Mounts on #globe-mount, reads/writes controls in #field-select etc.
// Synthetic fields for now (js/data.js); swap to a Zarr loader when ERA5 lands.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { fillRGBA, fillColorbar, COLORMAPS, meanLuminance } from './colormap.js';
import { getField, FIELDS, LEVELS, THETA_LEVELS, MONTHS, GRID, invalidateIsentropicCache, isThetaOnly, customRangeYears, fieldHasStdTiles, expectedTilesForView, hasCachedIngredients } from './data.js';
import { loadIndices, getIndex, eventYears, compositeLabel } from './indices.js';
import { ParticleField } from './particles.js';
import { BarbField } from './barbs.js';
import { ContourField } from './contours.js';
import { ContourLabels } from './contour_labels.js';
import { SunLight } from './sun.js';
import { OrbitScene, ORBIT_RADIUS } from './orbit.js';
import { computeZonalMean, computeArcCrossSection, renderCrossSection, samplePanel } from './cross_section.js';
import { greatCircleArc, linearLatLonArc, latLonToVec3, gcDistanceKm, greatCircleMidpoint, linearLatLonMidpoint, threePointArc } from './arc.js';
import { loadManifest, onFieldLoaded, onTileProgress, isReady as era5Ready, prefetchField, cachedMonth, registerClamps, setActivePeriod, getManifest } from './era5.js';
import { decompose, annualMeanFrom, aggregatedDecompositionRange } from './decompose.js';
import { HoverProbe } from './hover.js';
import { computeMassStreamfunction, computeAngularMomentum, computeBruntVaisala, computeGeostrophicWind } from './diagnostics.js';
import { computeEPFlux } from './ep_flux.js';
import { computeLorenzCycle } from './lorenz.js';
import { buildMBudgetView } from './m_budget.js';
import { buildQBudgetView } from './q_budget.js';
import { buildHBudgetView } from './h_budget.js';
import { ParcelField } from './parcels.js';
import { GifExporter, downloadBlob } from './gif_export.js';
import { encodeStateToHash, decodeHashToPatch, writeHashDebounced } from './url_state.js';
import { computeSeries as tsComputeSeries, renderSeries as tsRenderSeries, hoverLookup as tsHoverLookup, bboxLabel as tsBboxLabel, seriesToCSV as tsSeriesToCSV, MONTH_NAMES as TS_MONTH_NAMES } from './timeseries.js';
import { CLIMO_WINDOWS, bestClimoFor, groupEventsByClimo } from './climo_windows.js';

const PLAY_INTERVAL_MS = 900;

// Natural Earth 50 m coastline + lakes. Bundled in the repo so the site
// has zero external dependencies for base geometry — works offline,
// identical behaviour across localhost / GitHub Pages. Lakes (Great
// Lakes, Caspian, Victoria, Baikal, Aral, …) draw alongside coastlines
// using the same shared material — a single Coastlines toggle controls
// both.
// TC-ATLAS vendor fork: coastline GeoJSON is shipped under
// vendor/gc-atlas/assets/coastlines/ rather than the GC-ATLAS
// site-root assets/. Update the base accordingly.
const COASTLINE_BASE = 'vendor/gc-atlas/assets/coastlines';
const COASTLINE_URL = `${COASTLINE_BASE}/ne_50m_coastline.geojson`;
const LAKES_URL     = `${COASTLINE_BASE}/ne_50m_lakes.geojson`;
const AXIAL_TILT = 23.4 * Math.PI / 180;

// Default globe viewpoint: centred on North America so the opening frame shows
// continents and the mid-latitude jet, not empty ocean.
const DEFAULT_VIEW = { lat: 35, lon: -95, distance: 3.35 };

// Equirectangular map dimensions (width 4, height 2 → lon spans [-2, 2], lat spans [-1, 1]).
const MAP_W = 4;
const MAP_H = 2;

// Split a polyline at points where consecutive x-coords jump by more than
// `maxJump` (i.e., the line crosses the equirectangular map's seam when the
// central meridian isn't at longitude 0). Returns a list of sub-polylines.
function splitAtSeam(pts, maxJump) {
    if (pts.length < 2) return [pts];
    const out = [];
    let cur = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        if (Math.abs(pts[i].x - pts[i - 1].x) > maxJump) {
            if (cur.length >= 2) out.push(cur);
            cur = [pts[i]];
        } else {
            cur.push(pts[i]);
        }
    }
    if (cur.length >= 2) out.push(cur);
    return out;
}

function cameraFromView({ lat, lon, distance }, tilt = 0) {
    const phi = lat * Math.PI / 180;
    const lam = lon * Math.PI / 180;
    const x0 = distance * Math.cos(phi) * Math.sin(lam);
    const y0 = distance * Math.sin(phi);
    const z0 = distance * Math.cos(phi) * Math.cos(lam);
    // globeGroup is rotated by `tilt` about +Z; apply the same rotation to the
    // camera target vector so the requested (lat, lon) actually ends up facing
    // the camera in world space.
    const c = Math.cos(tilt), s = Math.sin(tilt);
    return [x0 * c - y0 * s, x0 * s + y0 * c, z0];
}

class GlobeApp {
    listeners = {};

    constructor(mount) {
        this.mount = mount;
        this.state = {
            field: 't',
            level: 500,
            theta: 330,              // isentropic surface (K) when vCoord='theta'
            vCoord: 'pressure',      // 'pressure' | 'theta'
            month: 1,
            cmap: FIELDS.t.cmap,
            viewMode: 'globe',   // 'globe' | 'map'
            showCoastlines: true,
            showGraticule: true,
            showContours: false,
            // null = contour the displayed field (legacy behaviour);
            // string = field id of an independent overlay field
            contourField: null,
            showSun: true,
            windMode: 'particles',   // 'off' | 'particles' | 'barbs'
            decompose: 'total',      // 'total' | 'zonal' | 'eddy' | 'anomaly'
            kind: 'mean',            // 'mean' (climatology) | 'std' (inter-annual ±1σ)
            // 3-month centered seasonal mean anchored on state.month.
            // On → DJF when month=1, JJA when month=7, etc. Propagates
            // through getField (data.js) and cross-section field panel.
            // Advanced diagnostic cross-sections (ψ, M, EP, budgets)
            // ignore it until their component tiles are plumbed too.
            seasonal: false,
            referencePeriod: 'default',  // 'default' (1991-2020) | '1961-1990' | …
            climatologyPeriod: 'default', // active climatology — drives mean + std + decomp reference
            year: null,              // null = climatology mean; integer (e.g. 2003) = single-year snapshot
            customRange: null,       // null = off; {start, end} = composite mean over those years (incl.)
            compareMode: false,      // compare overlay (Map view only)
            compareStyle: 'swipe',   // 'swipe' (split map + divider) | 'diff' (active − target as one anomaly-style map)
            compareSplit: 0.5,       // split position in [0,1] — uv-x of the divider (swipe only)
            compareYear: null,       // when set, swipe right-half draws this year's tile (year-vs-* compare)
            userVmin: null,          // manual colorbar min override; null = auto
            userVmax: null,          // manual colorbar max override; null = auto
            xsUserVmin: null,        // cross-section colorbar min override; null = auto
            xsUserVmax: null,        // cross-section colorbar max override; null = auto
            mapCenterLon: 0,         // central meridian for the flat map (-180..180)
            showXSection: false,
            showLorenz: false,
            showTimeseries: false,    // area-mean time-series panel
            // bbox for the area-mean timeseries: { latMin, latMax, lonMin, lonMax }
            timeseriesRegion: null,
            timeseriesMode: 'total',  // 'total' | 'anomaly' (subtract same-month climo)
            // Composite anomaly: when true, each event year subtracts ITS
            // best-match 30-yr climatology (8 windows stepped every 5 yr,
            // see climo_windows.js) rather than the single active climo.
            // Removes warming-trend bias when composites span many decades.
            // Falls back to fixed climo if the needed window's tiles aren't
            // on GCS yet.
            slidingClimo: true,
            lorenzRef: 'lorenz',     // 'lorenz' (sorted) | 'simple' (area-mean)
            xsArc: null,             // { start:{lat,lon}, end:{lat,lon} } or null for zonal-mean
            xsDiag: 'field',         // 'field' | 'psi' | 'M' | 'N2' | 'epflux' | 'mbudget'
            mbTerm: 'total',         // 'total' | 'meanY' | 'meanP' | 'eddyY' | 'eddyP' | 'torque'
            mbForm: 'u',             // 'u' (∂[u]/∂t m/s/day) | 'M' (∂[M]/∂t scaled)
            mbMode: '2d',            // '2d' | '1d_mean' (mass-weighted profile) | '1d_int' (∫dp/g, N/m²)
        };
        this.windCache = { u: null, v: null, nlat: 0, nlon: 0, stale: true };

        // If the URL hash carries state (copy-pasted from a shared link),
        // apply it BEFORE the first render so init pulls the right tiles.
        // Unknown keys and malformed values fall back silently.
        const urlPatch = decodeHashToPatch(location.hash);
        // viewMode has side-effects (group visibility, reparenting particles
        // / barbs / contour labels) that only run inside setViewMode().
        // Bulk-assigning state.viewMode='map' here would make the later
        // setViewMode('map') a no-op (early-return "already this view"),
        // leaving the globeGroup visible and particles parented to the
        // invisible mapGroup. Pull viewMode aside and apply via setViewMode
        // once the scene is up.
        const pendingView = (urlPatch.viewMode && urlPatch.viewMode !== 'globe')
            ? urlPatch.viewMode : null;
        delete urlPatch.viewMode;
        if (Object.keys(urlPatch).length) Object.assign(this.state, urlPatch);

        this.initScene();
        this.initGlobe();
        this.initGraticule();
        this.initCoastlines();
        this.initParticles();
        this.bindUI();
        if (pendingView) {
            this.setViewMode(pendingView);
            // _syncUIFromState ran inside bindUI() with state.viewMode still
            // 'globe', so re-highlight the correct view-toggle button.
            document.querySelectorAll('.view-toggle button').forEach(b =>
                b.classList.toggle('active', b.id === `view-${pendingView}`));
        }
        // URL-restored state side-effects that need an explicit kick (the
        // bulk Object.assign above doesn't go through setState, so none of
        // setState's hooks ran). Each applies its side-effect only if the
        // state differs from defaults — cheap no-ops otherwise.
        if (Number.isFinite(this.state.mapCenterLon) && this.state.mapCenterLon !== 0) {
            this.applyMapCenterLon();
        }
        if (this.state.compareMode) this.applyCompareMode();
        if (!this.state.showSun) this.applySunVisibility();
        if (this.state.windMode && this.state.windMode !== 'particles') this.applyWindMode();
        // URL-restored best-match anomaly reference: preload every 30-yr
        // window's manifest up front (setState's best-match hook doesn't
        // fire on bulk-assigned state). Each manifest triggers an
        // updateField when it lands.
        if (this.state.referencePeriod === 'best-match') {
            for (const w of CLIMO_WINDOWS) {
                loadManifest(w.id).then((ok) => {
                    if (ok && this.state.referencePeriod === 'best-match') {
                        this.updateField();
                    }
                });
            }
        }
        this.updateField();
        this.animate();
        this.bootstrapEra5();

        // Back/forward button → re-apply hash state. Guard against the
        // write-side loop by ignoring the synthetic hashchange we'd trigger
        // when WE write the hash; use a version counter.
        this._urlHashInitCount = 0;
        window.addEventListener('hashchange', () => {
            if (this._urlHashWriting) return;
            const p = decodeHashToPatch(location.hash);
            if (Object.keys(p).length) this.setState(p);
        });
    }

    // ── ERA5 tile loader bootstrap ───────────────────────────────────
    async bootstrapEra5() {
        const ok = await loadManifest();
        if (!ok) return;
        // Register percentile-clamp metadata so spiky fields (vo, d, w, tp)
        // get colorbars based on their bulk distribution rather than isolated
        // topographic / convective extremes.
        registerClamps(FIELDS);
        // Load the climate-index table used by the composite builder. Fires
        // the UI refresh once it lands so the event list populates. A
        // shared URL may carry a composite spec ("cr=c:roni:ge:1.0:1")
        // that needs indices to resolve into a concrete year list — fill
        // it in here, then prefetch the matching per-year tiles.
        loadIndices().then(() => {
            const cr = this.state.customRange;
            if (cr && cr.id && (!cr.years || cr.years.length === 0)) {
                const raw = eventYears(cr.id, cr.month, cr.cmp, cr.threshold);
                // Wait for per-year manifest so the availability clip
                // doesn't fall back to "no clip" and re-introduce 404s.
                loadManifest('per_year').then(() => {
                    const { kept: years } = this._clipToAvailableYears(raw);
                    if (!years.length) return;
                    const label = compositeLabel(cr.id, cr.month, cr.cmp, cr.threshold);
                    this.setState({
                        customRange: { ...cr, years, label },
                    });
                    for (const y of years) {
                        prefetchField(this.state.field, {
                            level: this.state.level,
                            period: 'per_year',
                            year: y,
                        });
                    }
                });
            }
            // Sync the DOM controls so the dropdown reflects the URL-
            // specified index / comparator / threshold.
            if (cr && cr.id) {
                const sel    = document.getElementById('composite-index');
                const cmpSel = document.getElementById('composite-cmp');
                const thresh = document.getElementById('composite-threshold');
                if (sel)    sel.value    = cr.id;
                if (cmpSel) cmpSel.value = cr.cmp;
                if (thresh) thresh.value = String(cr.threshold);
                const details = document.getElementById('composite-details');
                if (details) details.open = true;
            }
            if (this.refreshCompositeUI) this.refreshCompositeUI();
        });
        // URL hash may carry state that needs non-default manifests (year
        // mode, custom range, reference period). Load them now. Each
        // triggers an updateField once it lands so the first paint happens
        // as soon as the right tiles are fetchable. Without this, the
        // initial updateField runs against a null 'per_year'/refPeriod
        // manifest — the tile fetch never kicks off and the globe sits on
        // "Loading..." indefinitely.
        const s = this.state;
        // Per-year manifest is needed whenever the displayed state pulls
        // from a per-year tile: single-year view, custom-range composite,
        // composite builder, OR a compareYear-based swipe target.
        const needsPerYear = s.year != null || !!s.customRange
                          || (s.compareMode && s.compareYear != null);
        const refPeriod = s.referencePeriod;
        const needsRefPeriod = refPeriod && refPeriod !== 'default' && refPeriod !== '1991-2020';
        const altClimoPeriod = s.climatologyPeriod && s.climatologyPeriod !== 'default' && s.climatologyPeriod !== '1991-2020';
        if (altClimoPeriod) {
            loadManifest(s.climatologyPeriod)
                .then((ok) => { if (ok) { setActivePeriod(s.climatologyPeriod); this.updateField(); } })
                .catch((err) => console.warn(`[era5] climatology period ${s.climatologyPeriod} manifest load failed:`, err));
        }
        if (needsRefPeriod) {
            loadManifest(refPeriod)
                .then((ok) => { if (ok) this.updateField(); })
                .catch((err) => console.warn(`[era5] reference period ${refPeriod} manifest load failed:`, err));
        }
        // Always load per-year manifest in the background so the Year
        // slider can populate. When a URL preselects a year or range, also
        // refresh updateField once it lands so the tile fetch kicks off.
        loadManifest('per_year')
            .then((ok) => {
                if (!ok) return;
                this.populateYearSelect();
                if (needsPerYear) this.updateField();
            })
            .catch((err) => console.warn('[era5] per-year manifest load failed:', err));
        // Progress subscription — renders "X of Y tiles loaded" beneath
        // the loading spinner so isentropic / deep-stack views feel like
        // progress rather than limbo.
        onTileProgress((p) => this.setLoadingProgress(p));

        onFieldLoaded(({ name, month, level, period, year }) => {
            const s = this.state;
            const levelMatches = (level == null || level === s.level);
            const monthMatches = (month === s.month);
            // Per-year tile arrivals are the active source whenever the user
            // has a year selected. Treat them like any active-period arrival
            // so updateField fires when the displayed (field, month, level)
            // match.
            const perYearActive = s.year != null
                && period === 'per_year' && (year == null || year === s.year);
            // Custom-range composite: any per-year tile that feeds the
            // mean should trigger a repaint attempt. Handles both the
            // contiguous { start, end } range and the explicit
            // { years: [...] } list form used by the composite builder.
            const customRangeActive = s.customRange
                && period === 'per_year'
                && year != null
                && customRangeYears(s.customRange).includes(year);
            // Tile arrival from a non-active period is useful for either
            // the climate-change-anomaly view OR the swipe-compare overlay
            // (both subtract / draw the same-month tile from a reference
            // period). Active-period tiles fall through to the regular
            // display-update logic below.
            const isActivePeriod = perYearActive || customRangeActive
                || (s.year == null && !s.customRange && (
                    period === s.climatologyPeriod ||
                    (!period && s.climatologyPeriod === 'default')));
            if (period && !isActivePeriod) {
                // θ climate-change / year-vs-refPeriod anomaly needs T (for
                // the θ cube) + the field (for interpolation) + pv (when
                // field is pv) at every level from the reference period.
                // Any of those tiles landing should trigger a re-render so
                // the θ interpolation can progress. name === s.field alone
                // isn't enough on θ.
                const thetaAnomalyWaiting = s.vCoord === 'theta'
                    && s.decompose === 'anomaly'
                    && s.referencePeriod === period
                    && (name === s.field || name === 't' || name === 'pv');
                const isRefForAnomaly = s.referencePeriod === period
                                     && s.decompose === 'anomaly'
                                     && (thetaAnomalyWaiting ||
                                         (name === s.field && monthMatches));
                const isRefForCompare = s.compareMode
                                     && s.referencePeriod === period
                                     && s.compareYear == null
                                     && name === s.field && monthMatches;
                // Year-tile arrivals also drive the swipe right-half when
                // the user has compareYear set (year-vs-* compare mode).
                const isYearForCompare = s.compareMode
                                      && s.compareYear != null
                                      && period === 'per_year'
                                      && (year == null || year === s.compareYear)
                                      && name === s.field && monthMatches;
                if (isRefForAnomaly || isRefForCompare || isYearForCompare) {
                    // Pressure tiles for θ interpolation change the θ cube
                    // / isentropic caches for the reference period — bust
                    // them so the next render rebuilds with fresh data.
                    if (thetaAnomalyWaiting) invalidateIsentropicCache();
                    this.updateField();
                }
                // σ-anom mode needs the climatology std tile (not an
                // active-period tile in year/composite mode). When that
                // arrives for the displayed field, re-render so the
                // standardized anomaly division uses the real σ.
                const isStdForZscore = s.decompose === 'zscore'
                    && name === s.field && monthMatches
                    && (period === s.climatologyPeriod
                        || (!period && s.climatologyPeriod === 'default')
                        || period === 'default');
                if (isStdForZscore) this.updateField();
                // Sliding-climo: a composite-anomaly view in sliding mode
                // pulls climo tiles from any of the 8 windows
                // (1961-1990 … 1996-2025). Re-render whenever a mean
                // tile of the displayed field arrives at the displayed
                // level + month in any of those windows.
                const slidingClimoWindow =
                    /^(19|20)\d{2}-(19|20)\d{2}$/.test(period || '');
                const isSlidingClimoTile = s.slidingClimo
                    && s.customRange && s.year == null
                    && s.decompose === 'anomaly'
                    && name === s.field && monthMatches && levelMatches
                    && slidingClimoWindow;
                if (isSlidingClimoTile) this.updateField();
                // Best-match reference: a single-year or year-vs-year
                // compare view using the "vs. best-match climatology"
                // option pulls climo tiles from any of the 8 windows.
                // Same re-render trigger as composite sliding.
                const isBestMatchTile = s.referencePeriod === 'best-match'
                    && (s.year != null || s.compareYear != null)
                    && s.decompose === 'anomaly'
                    && name === s.field && monthMatches && levelMatches
                    && slidingClimoWindow;
                if (isBestMatchTile) this.updateField();
                // Timeseries panel feeds from per-year tiles that aren't
                // "active period" for the main renderer — don't miss them.
                if (s.showTimeseries && s.timeseriesRegion
                    && name === s.field && levelMatches
                    && period === 'per_year') {
                    this._scheduleTimeseriesRender();
                }
                return;   // don't trigger any of the active-period logic
            }
            const isenActive  = (s.vCoord === 'theta');
            // θ-coord rendering needs T at every level (for the θ cube) plus
            // the chosen field at every level. PV additionally needs u, v.
            const isenNeedsName = isenActive &&
                (name === 't' || name === s.field ||
                 (s.field === 'wspd' && (name === 'u' || name === 'v')) ||
                 (s.field === 'pv'   && name === 'pv') ||
                 (s.field === 'mse'  && (name === 'z' || name === 'q')));
            const feedsCurrentField =
                (name === s.field) ||
                (s.field === 'wspd' && (name === 'u' || name === 'v')) ||
                (s.field === 'pv'   && (name === 't' || name === 'pv')) ||
                (s.field === 'mse'  && (name === 't' || name === 'z' || name === 'q')) ||
                (s.field === 'dls'  && (name === 'u' || name === 'v')) ||
                isenNeedsName;

            // PV and θ-coord fields span every pressure level, so don't
            // require level to match — any ingredient arrival could complete
            // the cache. DLS reads u / v at fixed 200 + 850 hPa regardless
            // of the dropdown level, so its ingredient tiles match too.
            const needsLevelMatch = !(
                isenNeedsName ||
                (s.field === 'pv' && (name === 't' || name === 'pv')) ||
                (s.field === 'dls' && (name === 'u' || name === 'v'))
            );
            // MSE in pressure-coord is single-level (only the chosen level matters).
            // In θ-coord it gets caught by isenNeedsName below.
            if (feedsCurrentField && monthMatches && (!needsLevelMatch || levelMatches)) {
                if (s.field === 'pv' || isenActive) invalidateIsentropicCache();
                this.updateField();
            }

            // Anomaly mode needs all 12 months to compute an accurate annual
            // mean; re-render whenever any month of the current field lands
            // so the anomaly sharpens as tiles come in.
            if (feedsCurrentField && levelMatches && !monthMatches &&
                s.decompose === 'anomaly') {
                this.updateField();
            }

            // Contour-overlay field tiles (independent from the displayed
            // field) — re-render so the contours appear once the overlay
            // tile lands.
            if (s.showContours && s.contourField && name === s.contourField
                && monthMatches) {
                this.updateField();
            }

            if (name === 'u' || name === 'v' || name === 'u10' || name === 'v10' ||
                (isenActive && name === 't')) this.windCache.stale = true;

            // Barbs are drawn ONCE from the wind cache at rebuild time, so
            // they don't self-heal the way particles do (particles resample
            // the cache every frame). When a newly-loaded u/v tile is the
            // one that matches the current level + month + period, rebuild
            // the barb mesh so it shows the new-level wind, not the cached
            // old-level wind from before the level change.
            const isWindForBarbs = (name === 'u' || name === 'v'
                                 || name === 'u10' || name === 'v10'
                                 || (isenActive && name === 't'));
            if (this.barbs && s.windMode === 'barbs' && isWindForBarbs
                && levelMatches && monthMatches && isActivePeriod) {
                this.barbs.rebuild(s.viewMode);
            }

            if (s.showXSection && feedsCurrentField && monthMatches) this.updateXSection();
            // ψ needs v at every level; M needs u at every level; N² needs T;
            // EP flux needs u, v, w, t. Refresh the panel whenever a relevant
            // tile lands so the diagnostic sharpens as the cache warms up.
            const diagNeeds = (s.xsDiag === 'psi'    && name === 'v')
                           || (s.xsDiag === 'M'      && name === 'u')
                           || (s.xsDiag === 'ug'     && name === 'z')
                           || (s.xsDiag === 'N2'     && name === 't')
                           || (s.xsDiag === 'epflux' && (name === 'u' || name === 'v' || name === 'w' || name === 't'))
                           || (s.xsDiag === 'mbudget' && (name === 'u' || name === 'v' || name === 'w'))
                           || (s.xsDiag === 'qbudget' && (name === 'u' || name === 'v' || name === 'w' || name === 'q'))
                           || (s.xsDiag === 'hbudget' && (name === 'u' || name === 'v' || name === 'w' || name === 't' || name === 'z' || name === 'q'));
            if (s.showXSection && diagNeeds && monthMatches) {
                this.updateXSection();
            }
            // Lorenz cycle needs u, v, w, t at every level for the current month.
            const lorenzIngredient = (name === 'u' || name === 'v' || name === 'w' || name === 't');
            if (s.showLorenz && lorenzIngredient && monthMatches) {
                this.updateLorenz();
            }
            // Area-mean time-series: any per-year tile of the displayed
            // field (at the displayed level if level-stratified) feeds the
            // series. Anomaly mode additionally consumes the climatology
            // tiles of the active period, which arrive with period ==
            // s.climatologyPeriod (or null for the default). Debounced
            // render so we don't redraw 792 times during the initial tile
            // burst.
            if (s.showTimeseries && s.timeseriesRegion
                && name === s.field
                && levelMatches
                && (period === 'per_year'
                    || (s.timeseriesMode === 'anomaly' && (!period
                        || period === s.climatologyPeriod)))) {
                this._scheduleTimeseriesRender();
            }
        });
        // Prime: ask for the current field, which triggers a fetch.
        this.updateField();
        // The wind overlay (particles / barbs) needs u and v at the current
        // level. The main field isn't necessarily u/v/wspd on first load, so
        // kick those fetches explicitly here — otherwise particles respawn
        // every frame on NaN winds until the user changes level or field.
        prefetchField('u', { level: this.state.level });
        prefetchField('v', { level: this.state.level });
    }

    // ── scene / camera / controls ────────────────────────────────────
    initScene() {
        const { w, h } = this.size();
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(32, w / h, 0.1, 100);
        this.camera.position.set(...cameraFromView(DEFAULT_VIEW, AXIAL_TILT));

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(w, h);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.mount.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.rotateSpeed = 0.7;
        this.controls.zoomSpeed = 0.7;
        this.controls.minDistance = 1.4;
        this.controls.maxDistance = 8;
        this.controls.enablePan = false;
        // Pause particle stepping while the user is orbiting / zooming so
        // the advected field doesn't scramble across frames while the view
        // geometry shifts. Resume once interaction ends.
        this._interactingControls = false;
        this.controls.addEventListener('start', () => { this._interactingControls = true; });
        this.controls.addEventListener('end',   () => { this._interactingControls = false; });

        // Tips card in the bottom-right. Persistent (doesn't fade on
        // interaction) until the user clicks the × — it's a reference for
        // keyboard/mouse controls, not a first-run tutorial.
        this.tipsPanel = document.getElementById('tips-panel');
        this.tipsContent = document.getElementById('tips-content');
        const dismiss   = document.getElementById('tips-dismiss');
        const tipsReopen = document.getElementById('tips-reopen');
        dismiss?.addEventListener('click', () => {
            this.tipsPanel?.classList.add('hidden');
            tipsReopen?.removeAttribute('hidden');
        });
        tipsReopen?.addEventListener('click', () => {
            this.tipsPanel?.classList.remove('hidden');
            tipsReopen.setAttribute('hidden', '');
        });
        this.updateHintForViewMode();   // populate with the initial view's tips

        // Map-mode drag handler — shifts the central meridian instead of
        // panning the camera (OrbitControls.enablePan = false in map mode).
        this.installMapDrag();
        // Globe-mode shift-drag: draw a great-circle arc for the cross-section.
        this.installArcDrag();
        this._installTimeseriesPicker();
        this._installTimeseriesHover();
        this._installKeyboardShortcuts();

        window.addEventListener('resize', () => this.onResize());
    }

    installArcDrag() {
        const el = this.renderer.domElement;
        const raycaster = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        let dragging = false;
        let startPt = null;

        const pointToLatLon = (e) => {
            const rect = el.getBoundingClientRect();
            ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(ndc, this.camera);

            if (this.state.viewMode === 'globe') {
                if (!this.globe) return null;
                const hits = raycaster.intersectObject(this.globe);
                if (hits.length === 0) return null;
                const local = this.globeGroup.worldToLocal(hits[0].point.clone());
                const n = local.length() || 1;
                return {
                    lat: Math.asin(local.y / n) * 180 / Math.PI,
                    lon: Math.atan2(local.x, local.z) * 180 / Math.PI,
                };
            }
            if (this.state.viewMode === 'map') {
                if (!this.mapMesh) return null;
                const hits = raycaster.intersectObject(this.mapMesh);
                if (hits.length === 0) return null;
                let lon = hits[0].point.x * (360 / MAP_W) + this.state.mapCenterLon;
                const lat = hits[0].point.y * (180 / MAP_H);
                lon = ((lon + 180) % 360 + 360) % 360 - 180;
                if (lat < -90 || lat > 90) return null;
                return { lat, lon };
            }
            return null;   // orbit view doesn't support clicks
        };

        // Alt+click: drop a cluster of Lagrangian parcels at the clicked
        // (lat, lon), defaulting to the upper troposphere. Installed before
        // the shift+drag listener so pointerdown-propagation order is
        // deterministic.
        el.addEventListener('pointerdown', (e) => {
            if (!e.altKey) return;
            if (this.state.viewMode !== 'globe') return;
            const p = pointToLatLon(e);
            if (!p) return;
            e.preventDefault();
            // First-time seed: kick prefetches for u, v, w at every level so
            // the 3D wind cube fills in parallel with the first few steps.
            if (!this.parcels.hasActive()) {
                for (const L of LEVELS) {
                    prefetchField('u', { level: L });
                    prefetchField('v', { level: L });
                    prefetchField('w', { level: L });
                }
            }
            this.parcels.seed(p.lat, p.lon, this.state.level);
        });

        el.addEventListener('pointerdown', (e) => {
            if (!e.shiftKey) return;
            // Globe + map both support shift-drag arcs; orbit view doesn't.
            if (this.state.viewMode === 'orbit') return;
            // No arcs in diagnostic modes — they're inherently zonal.
            if (this.state.xsDiag !== 'field') return;
            const p = pointToLatLon(e);
            if (!p) return;
            dragging = true;
            startPt = p;
            // Pause OrbitControls (globe) or the map drag-pan handler so the
            // arc draw doesn't fight the camera/projection drag.
            this.controls.enabled = false;
            e.preventDefault();
            el.setPointerCapture(e.pointerId);
            // Open the cross-section panel if it isn't already.
            if (!this.state.showXSection) {
                const chk = document.getElementById('toggle-xsection');
                if (chk) chk.checked = true;
                this.setState({ showXSection: true });
            }
            // Re-drawing from scratch wipes any pinned midpoint.
            this.setState({ xsArc: { start: p, end: p, mid: null } });
        });

        el.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const p = pointToLatLon(e);
            if (!p) return;
            this.setState({ xsArc: { start: startPt, end: p, mid: null } });
        });

        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            this.controls.enabled = true;
            try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        };
        el.addEventListener('pointerup', endDrag);
        el.addEventListener('pointercancel', endDrag);

        // ── Handle-drag: click-and-drag the start / mid / end dots ─────────
        // Once an arc exists, the three markers become draggable without any
        // modifier key. Midpoint drag pins the arc into a three-point curve;
        // endpoint drag leaves the mid unpinned so it auto-follows (unless
        // the user already pinned it, in which case the curve updates shape
        // but the mid stays where they put it).
        // Shares `raycaster` + `ndc` with the shift-drag hit-test above.
        let handleDrag = null; // { which: 'start' | 'mid' | 'end' }
        const hitTestHandles = (clientX, clientY) => {
            if (!this.arcGroup || !this.arcGroup.visible) return null;
            const rect = el.getBoundingClientRect();
            ndc.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
            ndc.y = -((clientY - rect.top)  / rect.height) * 2 + 1;
            raycaster.setFromCamera(ndc, this.camera);
            const hits = raycaster.intersectObjects(
                [this.arcStartDot, this.arcMidDot, this.arcEndDot], false);
            if (!hits.length) return null;
            const hit = hits[0].object;
            if (hit === this.arcStartDot) return 'start';
            if (hit === this.arcEndDot)   return 'end';
            if (hit === this.arcMidDot)   return 'mid';
            return null;
        };
        el.addEventListener('pointerdown', (e) => {
            // Don't intercept modifier-held clicks — those belong to the
            // existing shift-arc / alt-parcel handlers above.
            if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
            if (this.state.viewMode === 'orbit') return;
            if (this.state.xsDiag !== 'field') return;
            if (!this.state.xsArc) return;
            const which = hitTestHandles(e.clientX, e.clientY);
            if (!which) return;
            handleDrag = { which };
            this.controls.enabled = false;
            e.preventDefault();
            el.setPointerCapture(e.pointerId);
            el.style.cursor = 'grabbing';
        });
        el.addEventListener('pointermove', (e) => {
            if (!handleDrag) {
                // Hover affordance: show a grab cursor when over a dot.
                if (this.state.xsArc && this.state.xsDiag === 'field'
                    && this.state.viewMode !== 'orbit' && !dragging) {
                    const over = hitTestHandles(e.clientX, e.clientY);
                    el.style.cursor = over ? 'grab' : '';
                }
                return;
            }
            const p = pointToLatLon(e);
            if (!p) return;
            const a = this.state.xsArc;
            if (!a) return;
            const patch = { ...a };
            if (handleDrag.which === 'start') {
                patch.start = p;
                // If the mid is unpinned (null), leave it null — it'll
                // auto-recompute on render. If it's pinned, leave it alone
                // so the user's curve shape is preserved.
            } else if (handleDrag.which === 'end') {
                patch.end = p;
            } else { // 'mid'
                patch.mid = p;   // pin it
            }
            this.setState({ xsArc: patch });
        });
        const endHandleDrag = (e) => {
            if (!handleDrag) return;
            handleDrag = null;
            this.controls.enabled = true;
            el.style.cursor = '';
            try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        };
        el.addEventListener('pointerup', endHandleDrag);
        el.addEventListener('pointercancel', endHandleDrag);

        // Double-click the midpoint dot to unpin it (arc reverts to straight
        // great-circle / linear path). Mirrors the Unpin-midpoint button in
        // the xs-panel footer — one is pointer-native, one is always visible.
        el.addEventListener('dblclick', (e) => {
            if (this.state.viewMode === 'orbit') return;
            if (this.state.xsDiag !== 'field') return;
            const a = this.state.xsArc;
            if (!a || !a.mid) return;
            const which = hitTestHandles(e.clientX, e.clientY);
            if (which !== 'mid') return;
            e.preventDefault();
            this.setState({ xsArc: { start: a.start, end: a.end, mid: null } });
        });
    }

    installMapDrag() {
        const el = this.renderer.domElement;
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        // When compareMode is on, drag drives the swipe divider (split position)
        // instead of panning the central meridian.
        const updateSplitFromPointer = (e) => {
            // Raycast to the active map plane and use the world-x of the hit
            // — handles zoom and central-meridian shift uniformly.
            const rect = el.getBoundingClientRect();
            const mouse = new THREE.Vector2(
                ((e.clientX - rect.left) / rect.width) * 2 - 1,
                -((e.clientY - rect.top) / rect.height) * 2 + 1,
            );
            const ray = new THREE.Raycaster();
            ray.setFromCamera(mouse, this.camera);
            const hits = ray.intersectObject(this.mapMesh, false);
            if (!hits.length) return;
            // Clamp to a small inset so the divider stays grabbable even at
            // the edges (the map plane spans x in [-MAP_W/2, +MAP_W/2]).
            const margin = 0.04 * MAP_W;
            const worldX = Math.max(-MAP_W / 2 + margin,
                            Math.min(MAP_W / 2 - margin, hits[0].point.x));
            const split = (worldX / MAP_W) + 0.5;
            this.applyCompareSplit(split);
            // Hide the "Drag to compare" hint after the first drag so it
            // stops blocking data. Reset on toggle-off / -on.
            this._compareDragged = true;
        };
        el.addEventListener('pointerdown', (e) => {
            if (this.state.viewMode !== 'map') return;
            // Skip the pan if the user is shift-dragging (cross-section arc),
            // alt-clicking (Lagrangian parcels — globe-only but cheap to guard
            // here too), or interacting with a panel above the canvas.
            if (e.shiftKey || e.altKey) return;
            dragging = true;
            this._interactingControls = true;   // pause particle stepping while panning
            lastX = e.clientX;
            lastY = e.clientY;
            el.setPointerCapture(e.pointerId);
            // In compare mode, the click jumps the divider to the pointer
            // (no need to grab the line first) — feels right with swipe UX.
            if (this.state.compareMode) updateSplitFromPointer(e);
        });
        el.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            if (this.state.compareMode) {
                updateSplitFromPointer(e);
                return;   // skip the pan-meridian path
            }
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            // How many degrees of longitude does one CSS pixel correspond to
            // in world space? At the current camera distance/FOV, the visible
            // world width is  2·dist·tan(fov/2)·aspect.  One world-unit of
            // plane equals (360 / MAP_W)° of longitude.
            const dist = this.camera.position.length();
            const fovY = this.camera.fov * Math.PI / 180;
            const visibleW = 2 * dist * Math.tan(fovY / 2) * this.camera.aspect;
            const visibleH = 2 * dist * Math.tan(fovY / 2);
            const lonPerPx = (visibleW / el.clientWidth) * (360 / MAP_W);
            let lon = this.state.mapCenterLon - dx * lonPerPx;
            // Wrap into [-180, 180].
            lon = ((lon + 180) % 360 + 360) % 360 - 180;
            this.setState({ mapCenterLon: lon });
            // Keep the slider and label in sync.
            const slider = document.getElementById('map-center-slider');
            const label  = document.getElementById('map-center-value');
            if (slider) slider.value = lon.toFixed(0);
            if (label)  label.textContent = `${Math.round(lon)}°`;
            // Vertical drag pans the camera target Y so users can see polar
            // regions when zoomed in (otherwise they're locked at equatorial
            // centre because OrbitControls pan is disabled in map view).
            // Clamped to the map plane bounds so the camera doesn't drift
            // off into empty space.
            const wppY = visibleH / el.clientHeight;
            const newY = this.controls.target.y + dy * wppY;
            const maxY = MAP_H / 2;
            const clampedY = Math.max(-maxY, Math.min(maxY, newY));
            this.controls.target.y = clampedY;
            this.camera.position.y = clampedY;
            this.controls.update();
        });
        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            this._interactingControls = false;
            try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        };
        el.addEventListener('pointerup', endDrag);
        el.addEventListener('pointercancel', endDrag);
        el.addEventListener('pointerleave', endDrag);
    }

    updateHintForViewMode() {
        if (!this.tipsContent) return;
        // Three-row tips card with distinct kbd badges per row. Content
        // swaps with view mode so each view only shows its relevant
        // gestures.
        const rows = {
            globe: [
                { kbd: 'drag',         desc: 'rotate the globe' },
                { kbd: '⇧ + drag',    desc: 'draw cross-section arc' },
                { kbd: 'drag dots',    desc: 'reshape arc · dblclick mid to unpin' },
                { kbd: '⌥ + click',   desc: 'release parcels' },
                { kbd: 'scroll',       desc: 'zoom' },
            ],
            map: this.state.compareMode ? [
                { kbd: 'drag',         desc: 'slide the swipe-compare divider' },
                { kbd: 'scroll',       desc: 'zoom' },
            ] : [
                { kbd: 'drag',         desc: 'pan the central meridian' },
                { kbd: '⇧ + drag',    desc: 'draw cross-section arc' },
                { kbd: 'drag dots',    desc: 'reshape arc · dblclick mid to unpin' },
                { kbd: 'scroll',       desc: 'zoom' },
            ],
            orbit: [
                { kbd: 'drag',         desc: 'orbit the camera' },
                { kbd: 'scroll',       desc: 'zoom' },
            ],
        }[this.state.viewMode] || [];
        this.tipsContent.innerHTML = rows.map(r =>
            `<div class="tips-row"><span class="tips-kbd">${r.kbd}</span>` +
            `<span class="tips-desc">${r.desc}</span></div>`,
        ).join('') + '<div class="tips-row"><span class="tips-kbd">?</span><span class="tips-desc">keyboard shortcuts</span></div>';
    }

    size() {
        const r = this.mount.getBoundingClientRect();
        return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    }

    onResize() {
        const { w, h } = this.size();
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        if (this.barbs) this.barbs.updateResolution(w, h);
        if (this.arcLineMaterial) this.arcLineMaterial.resolution.set(w, h);
    }

    // ── meshes + data textures ───────────────────────────────────────
    initGlobe() {
        // Two top-level groups. Only one is visible at a time.
        this.globeGroup = new THREE.Group();
        this.globeGroup.rotation.z = AXIAL_TILT;
        this.scene.add(this.globeGroup);

        this.mapGroup = new THREE.Group();
        this.mapGroup.visible = false;
        this.scene.add(this.mapGroup);

        this.orbitGroup = new THREE.Group();
        this.orbitGroup.visible = false;
        this.scene.add(this.orbitGroup);

        // Shared canvas → shared data grid.
        this.canvas = document.createElement('canvas');
        this.canvas.width = GRID.nlon;
        this.canvas.height = GRID.nlat;
        this.ctx = this.canvas.getContext('2d');
        this.imageData = this.ctx.createImageData(GRID.nlon, GRID.nlat);

        // Sphere uses a texture with a +0.25 u-offset (see SphereGeometry UV note).
        this.texture = new THREE.CanvasTexture(this.canvas);
        this.texture.minFilter = THREE.LinearFilter;
        this.texture.magFilter = THREE.LinearFilter;
        this.texture.wrapS = THREE.RepeatWrapping;
        this.texture.colorSpace = THREE.SRGBColorSpace;
        this.texture.offset.x = 0.25;

        // Plane uses a clone of the same canvas. Repeat-wrap horizontally so
        // shifting texture.offset.x changes the central meridian without
        // revealing an edge.
        this.mapTexture = new THREE.CanvasTexture(this.canvas);
        this.mapTexture.minFilter = THREE.LinearFilter;
        this.mapTexture.magFilter = THREE.LinearFilter;
        this.mapTexture.wrapS = THREE.RepeatWrapping;
        this.mapTexture.colorSpace = THREE.SRGBColorSpace;

        // Mini-Earth in orbit view shares the same shaded canvas but needs
        // its own texture instance so the +0.25 sphere offset doesn't bleed
        // into the flat map plane.
        this.earthTexture = new THREE.CanvasTexture(this.canvas);
        this.earthTexture.minFilter = THREE.LinearFilter;
        this.earthTexture.magFilter = THREE.LinearFilter;
        this.earthTexture.wrapS = THREE.RepeatWrapping;
        this.earthTexture.colorSpace = THREE.SRGBColorSpace;
        this.earthTexture.offset.x = 0.25;

        const sphereGeom = new THREE.SphereGeometry(1, 192, 96);
        const sphereMat  = new THREE.MeshBasicMaterial({ map: this.texture });
        this.globe = new THREE.Mesh(sphereGeom, sphereMat);
        this.globeGroup.add(this.globe);

        const planeGeom = new THREE.PlaneGeometry(MAP_W, MAP_H, GRID.nlon, GRID.nlat);
        const planeMat  = new THREE.MeshBasicMaterial({ map: this.mapTexture, side: THREE.DoubleSide });
        this.mapMesh = new THREE.Mesh(planeGeom, planeMat);
        this.mapGroup.add(this.mapMesh);

        // ── swipe-compare overlay (Map view) ─────────────────────────────
        // A second canvas + texture painted with the reference period; drawn
        // on a duplicate plane just in front, with a clipping plane that hides
        // everything to the LEFT of the divider — so the user sees the active
        // period on the left and the reference period on the right.
        this.referenceCanvas = document.createElement('canvas');
        this.referenceCanvas.width = GRID.nlon;
        this.referenceCanvas.height = GRID.nlat;
        this.referenceCtx = this.referenceCanvas.getContext('2d');
        this.referenceImageData = this.referenceCtx.createImageData(GRID.nlon, GRID.nlat);
        this.referenceTexture = new THREE.CanvasTexture(this.referenceCanvas);
        this.referenceTexture.minFilter = THREE.LinearFilter;
        this.referenceTexture.magFilter = THREE.LinearFilter;
        this.referenceTexture.wrapS = THREE.RepeatWrapping;
        this.referenceTexture.colorSpace = THREE.SRGBColorSpace;
        // Plane equation (1,0,0)·p + constant = 0 → keeps p.x > -constant.
        // Initial constant=0 → keeps right half (x > 0).
        this.splitPlane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
        this.renderer.localClippingEnabled = true;
        const refMat = new THREE.MeshBasicMaterial({
            map: this.referenceTexture, side: THREE.DoubleSide,
            clippingPlanes: [this.splitPlane], clipShadows: false,
        });
        this.mapMeshRef = new THREE.Mesh(planeGeom, refMat);
        this.mapMeshRef.position.z = 0.001;   // win z-fight with the active plane
        this.mapMeshRef.visible = false;
        this.mapGroup.add(this.mapMeshRef);
        // Globe-view companion: a second sphere shell at radius 1.001 with
        // the reference texture, clipped by a vertical plane through the
        // y-axis. As compareSplit changes, the plane rotates around y so the
        // dividing meridian sweeps east-west across the globe.
        this.referenceSphereTexture = new THREE.CanvasTexture(this.referenceCanvas);
        this.referenceSphereTexture.minFilter = THREE.LinearFilter;
        this.referenceSphereTexture.magFilter = THREE.LinearFilter;
        this.referenceSphereTexture.wrapS = THREE.RepeatWrapping;
        this.referenceSphereTexture.colorSpace = THREE.SRGBColorSpace;
        this.referenceSphereTexture.offset.x = 0.25;   // match the active sphere
        // Plane through y-axis: normal in the x-z plane. Initial (-1,0,0)
        // keeps the western hemisphere (x < 0). applyCompareSplit rotates it.
        this.globeSplitPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
        const globeRefMat = new THREE.MeshBasicMaterial({
            map: this.referenceSphereTexture,
            clippingPlanes: [this.globeSplitPlane], clipShadows: false,
        });
        this.globeRef = new THREE.Mesh(sphereGeom, globeRefMat);
        this.globeRef.scale.setScalar(1.001);   // tiny outset to win z-fight
        this.globeRef.visible = false;
        this.globeGroup.add(this.globeRef);
        // Divider — amber to match the equator and cross-section arc styling
        // (same accent palette across all "lat/lon line" overlays). A wider
        // semi-transparent halo behind a bright thin core sells the line at
        // 1px linewidth without a Line2 dependency.
        const splitLineGeom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, -MAP_H / 2, 0.002),
            new THREE.Vector3(0,  MAP_H / 2, 0.002),
        ]);
        const splitLineHaloGeom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, -MAP_H / 2, 0.0019),
            new THREE.Vector3(0,  MAP_H / 2, 0.0019),
        ]);
        this.splitLine = new THREE.Line(splitLineGeom,
            new THREE.LineBasicMaterial({ color: 0xE8C26A, transparent: true, opacity: 0.95 }));
        // Halo: a wider faint amber glow behind the core line for visibility.
        // Two extra strokes at slight x-offsets give the look of a thicker line.
        const haloMat = new THREE.LineBasicMaterial({ color: 0xE8C26A, transparent: true, opacity: 0.35 });
        this.splitLineHaloA = new THREE.Line(splitLineHaloGeom.clone(), haloMat);
        this.splitLineHaloB = new THREE.Line(splitLineHaloGeom.clone(), haloMat);
        this.splitLineHaloA.position.x = -0.008;
        this.splitLineHaloB.position.x =  0.008;
        this.splitLine.add(this.splitLineHaloA);
        this.splitLine.add(this.splitLineHaloB);
        this.splitLine.visible = false;
        this.mapGroup.add(this.splitLine);

        // Contour overlay: isolines drawn on top of the shaded field.
        this.contours = new ContourField({
            nlon: GRID.nlon, nlat: GRID.nlat, mapW: MAP_W, mapH: MAP_H,
        });
        this.globeGroup.add(this.contours.sphereMesh);
        this.mapGroup.add(this.contours.planeMesh);
        this.contours.setVisible(this.state.showContours);

        // Labels for the contour isolines. Separate groups for globe vs map
        // since the sprite positions depend on projection.
        this.contourLabels = new ContourLabels((lat, lon, r) => this.project(lat, lon, r));
        this.globeGroup.add(this.contourLabels.group);
        this.contourLabels.setVisible(this.state.showContours);

        // Lagrangian parcel field (alt-click to seed on globe view).
        this.parcels = new ParcelField();
        this.globeGroup.add(this.parcels.object);

        // Arc for the cross-section feature (shift-drag to draw). Uses Line2
        // (fat lines) so the stroke stays visible at any zoom; WebGL's
        // built-in line rasteriser clamps to 1 px on most drivers. Two small
        // amber spheres mark the endpoints so the direction of the arc reads
        // at a glance.
        this.arcGroup = new THREE.Group();
        this.arcGroup.visible = false;
        this.arcGroup.renderOrder = 7;
        this.arcLineMaterial = new LineMaterial({
            color: 0xFFE27A,
            linewidth: 4,
            worldUnits: false,
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            resolution: new THREE.Vector2(window.innerWidth, window.innerHeight),
        });
        this.arcLine = new Line2(new LineGeometry(), this.arcLineMaterial);
        this.arcLine.renderOrder = 7;
        this.arcGroup.add(this.arcLine);

        const endpointMat = new THREE.MeshBasicMaterial({
            color: 0xFFC74D, transparent: true, opacity: 0.95, depthTest: false,
        });
        const midpointMat = new THREE.MeshBasicMaterial({
            color: 0xFFE27A, transparent: true, opacity: 0.95, depthTest: false,
        });
        const endpointGeom = new THREE.SphereGeometry(0.018, 16, 12);
        const midpointGeom = new THREE.SphereGeometry(0.013, 16, 12);
        this.arcStartDot = new THREE.Mesh(endpointGeom, endpointMat);
        this.arcEndDot   = new THREE.Mesh(endpointGeom, endpointMat);
        this.arcMidDot   = new THREE.Mesh(midpointGeom, midpointMat);
        this.arcStartDot.renderOrder = 8;
        this.arcEndDot.renderOrder = 8;
        this.arcMidDot.renderOrder = 8;
        this.arcGroup.add(this.arcStartDot);
        this.arcGroup.add(this.arcEndDot);
        this.arcGroup.add(this.arcMidDot);
        this.currentGroup().add(this.arcGroup);

        // Sun marker + day/night terminator. Both live in the scene (not the
        // globeGroup) so their geometry is in world coords — the shadow
        // shader's dot(vNormal, uSunDir) is a direct world-space product.
        this.sun = new SunLight();
        this.scene.add(this.sun.sprite);
        this.scene.add(this.sun.shadowMesh);
        this.sun.update(this.state.month);
        this.applySunVisibility();

        // Subtle rim glow on the globe (sphere mode only).
        const glow = new THREE.Mesh(
            new THREE.SphereGeometry(1.04, 96, 48),
            new THREE.MeshBasicMaterial({
                color: 0x2DBDA0, transparent: true, opacity: 0.07, side: THREE.BackSide,
            }),
        );
        this.globeGroup.add(glow);

        // Orbit view: heliocentric scene with a mini-Earth tied to the same
        // shaded canvas texture. Lives in its own group and toggles via the
        // view-mode segmented control.
        this.orbit = new OrbitScene(() => this.earthTexture);
        this.orbitGroup.add(this.orbit.group);
        this.orbit.group.visible = true;   // group already parented; outer group handles visibility
        this.orbit.update(this.state.month, 0, this.camera);
        this.spinAngle = 0;                 // cumulative diurnal rotation (rad)

        // Hover readout — shows (lat, lon, value) at the cursor. Reads the
        // last-rendered (decomposed) field, not the raw tile, so it matches
        // what the user sees on the globe / map.
        this.hover = new HoverProbe({
            canvas:          this.renderer.domElement,
            camera:          this.camera,
            getViewMode:     () => this.state.viewMode,
            getGlobeMesh:    () => this.globe,
            getMapMesh:      () => this.mapMesh,
            getMapW:         () => MAP_W,
            getMapH:         () => MAP_H,
            getMapCenterLon: () => this.state.mapCenterLon,
            sampleDisplayed: (lat, lon) => this.sampleDisplayed(lat, lon),
            formatLabel:     (lat, lon, v) => this.formatHoverLabel(lat, lon, v),
        });
    }

    currentGroup() { return this.state.viewMode === 'globe' ? this.globeGroup : this.mapGroup; }

    // Unified projection. r=1 lives on the sphere (or plane); r>1 lifts overlays.
    project(lat, lon, r = 1) {
        if (this.state.viewMode === 'map') {
            // Re-centre around state.mapCenterLon, wrapping into [-180, 180].
            let x = lon - this.state.mapCenterLon;
            if (x >  180) x -= 360;
            else if (x < -180) x += 360;
            return new THREE.Vector3(
                x * (MAP_W / 360),
                lat * (MAP_H / 180),
                (r - 1) * 0.25,
            );
        }
        const phi = lat * Math.PI / 180;
        const lam = lon * Math.PI / 180;
        return new THREE.Vector3(
            r * Math.cos(phi) * Math.sin(lam),
            r * Math.sin(phi),
            r * Math.cos(phi) * Math.cos(lam),
        );
    }

    // ── graticule overlay ─────────────────────────────────────────────
    initGraticule() {
        // Store raw (lat, lon) path definitions; the mesh is rebuilt per view mode.
        this.gratPaths = [];
        const seg = 180;
        for (let lat = -60; lat <= 60; lat += 30) {
            if (lat === 0) continue;
            const pts = [];
            for (let k = 0; k <= seg; k++) pts.push([lat, -180 + 360 * k / seg]);
            this.gratPaths.push({ kind: 'parallel', pts, style: 'main' });
        }
        {
            const pts = [];
            for (let k = 0; k <= seg; k++) pts.push([0, -180 + 360 * k / seg]);
            this.gratPaths.push({ kind: 'equator', pts, style: 'eq' });
        }
        for (let lon = -180; lon < 180; lon += 30) {
            const pts = [];
            for (let k = 0; k <= seg; k++) pts.push([-90 + 180 * k / seg, lon]);
            this.gratPaths.push({ kind: 'meridian', pts, style: 'main' });
        }
        this.gratGroup = new THREE.Group();
        this.rebuildGraticule();
    }

    rebuildGraticule() {
        this.gratGroup.parent?.remove(this.gratGroup);
        for (const child of this.gratGroup.children) child.geometry.dispose();
        this.gratGroup.clear();

        const main = new THREE.LineBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.55 });
        const eq   = new THREE.LineBasicMaterial({ color: 0xE8C26A, transparent: true, opacity: 0.90 });
        const R = 1.006;
        const wrap = this.state.viewMode === 'globe';  // parallels wrap on the sphere; not on a flat map
        const isMap = this.state.viewMode === 'map';
        const seamJump = MAP_W / 2;
        for (const path of this.gratPaths) {
            const pts = path.pts.map(([lat, lon]) => this.project(lat, lon, R));
            const mat = path.style === 'eq' ? eq : main;
            if (wrap && (path.kind === 'parallel' || path.kind === 'equator')) {
                const geom = new THREE.BufferGeometry().setFromPoints(pts);
                this.gratGroup.add(new THREE.LineLoop(geom, mat));
            } else {
                const segments = isMap ? splitAtSeam(pts, seamJump) : [pts];
                for (const seg of segments) {
                    if (seg.length < 2) continue;
                    const geom = new THREE.BufferGeometry().setFromPoints(seg);
                    this.gratGroup.add(new THREE.Line(geom, mat));
                }
            }
        }
        this.currentGroup().add(this.gratGroup);
        this.gratGroup.visible = this.state.showGraticule;
    }

    // ── coastlines + lakes overlay (Natural Earth 50 m, mirrored on GCS) ─
    async initCoastlines() {
        this.coastGroup = new THREE.Group();
        // Walk a GeoJSON geometry into a list of [lon,lat] rings/lines.
        // Coastlines are LineString / MultiLineString; lakes are Polygon /
        // MultiPolygon (we draw the rings as outlines, not filled).
        const ringsOf = (g) => {
            if (!g) return [];
            switch (g.type) {
                case 'LineString':      return [g.coordinates];
                case 'MultiLineString': return g.coordinates;
                case 'Polygon':         return g.coordinates;        // [outer, hole1, …]
                case 'MultiPolygon':    return g.coordinates.flat(); // → list of rings
                default:                return [];
            }
        };
        const fetchFeatures = async (url) => {
            try {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const gj = await resp.json();
                const out = [];
                for (const feat of gj.features) out.push(...ringsOf(feat.geometry));
                return out;
            } catch (err) {
                console.warn(`[globe] failed to load ${url}:`, err);
                return [];
            }
        };
        const [coastRings, lakeRings] = await Promise.all([
            fetchFeatures(COASTLINE_URL),
            fetchFeatures(LAKES_URL),
        ]);
        this.coastFeatures = [...coastRings, ...lakeRings];
        if (this.coastFeatures.length) this.rebuildCoastlines();
    }

    rebuildCoastlines() {
        if (!this.coastFeatures) return;
        this.coastGroup.parent?.remove(this.coastGroup);
        for (const child of this.coastGroup.children) child.geometry.dispose();
        this.coastGroup.clear();

        // Single shared material so applyCoastlineContrast() can flip colour
        // without rebuilding geometry on every cmap change.
        this.coastMat = new THREE.LineBasicMaterial({ transparent: true });
        // R=1.005 → map-mode z = 0.00125, in front of the swipe-compare
        // reference plane (z=0.001) so coastlines stay visible on the right
        // half. Original 1.003 put them behind the overlay.
        const R = 1.005;
        const seamJump = MAP_W / 2;  // flag if consecutive x-coords wrap the map
        const isMap = this.state.viewMode === 'map';
        for (const ring of this.coastFeatures) {
            const pts = ring.map(([lon, lat]) => this.project(lat, lon, R));
            // In map mode the central-meridian shift can split continents across
            // the seam; drop adjacent points whose x jumps by more than half the
            // map width into separate Line objects so we don't draw a spurious
            // stroke across the whole globe.
            const segments = isMap ? splitAtSeam(pts, seamJump) : [pts];
            for (const seg of segments) {
                if (seg.length < 2) continue;
                const geom = new THREE.BufferGeometry().setFromPoints(seg);
                this.coastGroup.add(new THREE.Line(geom, this.coastMat));
            }
        }
        this.currentGroup().add(this.coastGroup);
        this.coastGroup.visible = this.state.showCoastlines;
        this.applyCoastlineContrast();
    }

    applyCoastlineContrast(effCmap) {
        if (!this.coastMat) return;
        // Track the most recent effective cmap so post-rebuild calls (which
        // pass nothing) reuse the last value updateField() handed us.
        if (effCmap) this._coastEffCmap = effCmap;
        const cmap = this._coastEffCmap || this.state.cmap;
        // Match the contour-ink threshold (0.45) and palette so coastlines
        // and contour strokes stay visually consistent on every cmap.
        const darkBg = meanLuminance(cmap) < 0.45;
        this.coastMat.color.setHex(darkBg ? 0xf4faf7 : 0x000000);
        this.coastMat.opacity = darkBg ? 0.70 : 0.88;
    }

    // ── wind overlays (particles + barbs) ────────────────────────────
    initParticles() {
        const getUV = (lat, lon) => this.sampleWind(lat, lon);
        const proj  = (lat, lon, r) => this.project(lat, lon, r);

        this.particles = new ParticleField(getUV, proj);
        this.barbs = new BarbField(getUV, proj);

        this.applyWindMode();
        this.applyParticleContrast();
        this.currentGroup().add(this.particles.object);
        this.currentGroup().add(this.barbs.object);
    }

    applyMapCenterLon() {
        // Canvas maps uv.x=0 → lon=-180, uv.x=1 → +180. To show lon=centerLon
        // at plane-centre (uv.x=0.5), the texture sample needs offset
        // +centerLon/360 so that 0.5 + offset = (centerLon+180)/360.
        const u = this.state.mapCenterLon / 360;   // [-0.5, 0.5]
        if (this.mapTexture) {
            this.mapTexture.wrapS = THREE.RepeatWrapping;
            this.mapTexture.offset.x = u;
            this.mapTexture.needsUpdate = true;
        }
        // Reference (compare) texture must follow the same shift so the two
        // halves of the swipe share a coordinate system.
        if (this.referenceTexture) {
            this.referenceTexture.wrapS = THREE.RepeatWrapping;
            this.referenceTexture.offset.x = u;
            this.referenceTexture.needsUpdate = true;
        }
        // Contour overlay on the plane shares the same texture sample space
        // (see contours.js planeMaterial.uUOffset).
        if (this.contours?.planeMaterial?.uniforms?.uUOffset) {
            this.contours.planeMaterial.uniforms.uUOffset.value = u;
        }
        // Coastlines and graticule use project() which now reads state.mapCenterLon.
        if (this.state.viewMode === 'map') {
            this.rebuildCoastlines();
            this.rebuildGraticule();
            // Particles store world-space positions but project() depends on
            // mapCenterLon — after a pan the existing trail positions are
            // stale (they read at the OLD centre-lon). Reproject from each
            // particle's stored (lat, lon) so the wind field stays anchored
            // to the map instead of sliding with the cursor.
            if (this.particles) this.particles.onProjectionChanged();
            if (this.barbs)     this.barbs.rebuild('map');
        }
    }

    applySunVisibility() {
        if (!this.sun) return;
        // Sun / terminator are globe-mode concepts; hide in flat-map mode.
        this.sun.setVisible(this.state.showSun && this.state.viewMode === 'globe');
    }

    // ── seasonal label text (e.g. "DJF") beside the 3-mo toggle ──────
    // Populates the label element so the user can see which three
    // months the averaging is covering, even without exporting. Shows
    // only when seasonal is on — hides otherwise to keep the UI quiet.
    _refreshSeasonalLabel() {
        const el = document.getElementById('seasonal-label');
        if (!el) return;
        if (!this.state.seasonal) { el.textContent = ''; return; }
        const M = ['J','F','M','A','M','J','J','A','S','O','N','D'];
        const m  = this.state.month;
        const p  = (m + 10) % 12;
        const n  =  m       % 12;
        el.textContent = `· ${M[p]}${M[m-1]}${M[n]}`;
    }

    // ── reference-period dropdown labels ─────────────────────────────
    // The "Self · 12-month mean" / "vs. 1991-2020" / "vs. 1961-1990"
    // options mean different things depending on whether year mode is on
    // and which 30-year window is the active climatology. Re-label and
    // re-disable in place so the dropdown always reads honestly.
    refreshRefPeriodLabels() {
        const sel = document.getElementById('ref-period-select');
        if (!sel) return;
        // Reference period is only meaningful in:
        //   • anomaly / σ-anom decomposition (it's the subtracted baseline)
        //   • ±1σ kind (Δσ comparison target)
        //   • Compare swipe (right-half period when no compareYear is set)
        // Hide the row in plain Total/Zonal/Eddy on the Mean tile so the
        // sidebar doesn't suggest an option that doesn't apply.
        const row = document.getElementById('ref-period-row');
        if (row) {
            const decomposeUsesIt = this.state.decompose === 'anomaly'
                                  || this.state.decompose === 'zscore';
            const compareUsesIt   = this.state.compareMode
                                  && this.state.compareYear == null;
            const stdUsesIt       = this.state.kind === 'std';
            row.hidden = !(decomposeUsesIt || compareUsesIt || stdUsesIt);
        }
        const yearOn = this.state.year != null;
        const active = this.state.climatologyPeriod;
        const activeLabel = active === '1961-1990' ? '1961–1990' : '1991–2020';
        for (const opt of sel.options) {
            if (opt.value === 'default') {
                // Year mode → "Self" subtracts the active climatology mean
                // for the same month (the year-anomaly path). Climatology
                // mode → it's the field's 12-month annual self-mean.
                opt.textContent = yearOn
                    ? `vs. ${activeLabel} mean (current climatology)`
                    : 'Self · 12-month mean';
            } else if (opt.value === '1991-2020') {
                // Useless when active = 1991-2020 (subtracts itself); useful
                // when active is 1961-1990 (lets you explicitly ask for the
                // modern-baseline anomaly).
                opt.disabled = (active === 'default' || active === '1991-2020');
            } else if (opt.value === '1961-1990') {
                // Same self-comparison guard as before.
                opt.disabled = (active === '1961-1990');
            }
        }
        // If the current selection just got disabled, fall back to default.
        if (sel.options[sel.selectedIndex]?.disabled) {
            sel.value = 'default';
            this.state.referencePeriod = 'default';
        }
    }

    // ── year sliders (main + compare) ────────────────────────────────
    // Both the Single-year picker (Climatology section) and the Compare
    // year-target slider read their range from the per-year manifest.
    //
    // The trailing edge of the manifest is ragged: the most recent year
    // (e.g. 2026) typically has only the first few months uploaded while
    // the rest of the season is still pending. The `years` array reports
    // the union over all months, so trusting it gives the slider a max
    // that 404s for any month the user is actually likely to view (the
    // default is September). Use `year_months` and the current
    // `state.month` to clamp the max to the latest year that actually
    // has the displayed month available — re-run on month change so the
    // bound shifts as the user scrubs the seasonal cycle.
    populateYearSelect() {
        const mfst = getManifest('per_year');
        if (!mfst) return;
        let years = null;
        let yearMonths = null;
        for (const grp of Object.values(mfst.groups || {})) {
            for (const v of Object.values(grp)) {
                if (!years && Array.isArray(v.years) && v.years.length) years = v.years;
                if (!yearMonths && Array.isArray(v.year_months) && v.year_months.length) yearMonths = v.year_months;
                if (years && yearMonths) break;
            }
            if (years && yearMonths) break;
        }
        if (!years || !years.length) return;
        const minY = years[0];
        const absMaxY = years[years.length - 1];
        // Latest year that has a tile for the currently-displayed month.
        // Falls back to absMaxY when year_months is unavailable.
        const month = this.state.month;
        let maxY = absMaxY;
        if (yearMonths && Number.isFinite(month)) {
            let latestForMonth = null;
            for (const e of yearMonths) {
                if (Array.isArray(e) && e[1] === month) {
                    if (latestForMonth == null || e[0] > latestForMonth) latestForMonth = e[0];
                }
            }
            if (latestForMonth != null) maxY = latestForMonth;
        }
        // Main year slider in the Climatology section.
        const slider = document.getElementById('year-slider');
        const display = document.getElementById('year-display');
        if (slider) {
            slider.min = String(minY);
            slider.max = String(maxY);
            slider.disabled = false;
            const v = this.state.year != null
                ? Math.max(minY, Math.min(maxY, this.state.year))
                : maxY;
            slider.value = String(v);
            if (display) display.textContent = String(v);
            // If a month-change clamp shifted maxY below the active year
            // (e.g. user was on Mar 2026, then moves to April → maxY drops
            // to 2025), sync state.year so the next fetch hits a real tile
            // instead of 404'ing on the now-impossible (year, month) pair.
            if (this.state.year != null && v !== this.state.year) {
                this.setState({ year: v });
            }
        }
        // Compare-against year slider in the Compare section. Default to the
        // most recent year - 10 so users get a nontrivial comparison out of
        // the box (e.g. 2026 vs 2016) when they pick "Specific year" mode.
        const cmpSlider = document.getElementById('compare-year-slider');
        const cmpDisplay = document.getElementById('compare-year-display');
        if (cmpSlider) {
            cmpSlider.min = String(minY);
            cmpSlider.max = String(maxY);
            cmpSlider.disabled = false;
            const v = this.state.compareYear != null
                ? Math.max(minY, Math.min(maxY, this.state.compareYear))
                : Math.max(minY, maxY - 10);
            cmpSlider.value = String(v);
            if (cmpDisplay) cmpDisplay.textContent = String(v);
            if (this.state.compareYear != null && v !== this.state.compareYear) {
                this.setState({ compareYear: v });
            }
        }
    }

    // ── swipe compare helpers ────────────────────────────────────────
    applyCompareSplit(split) {
        const s = Math.max(0.02, Math.min(0.98, split));
        this.state.compareSplit = s;
        const worldX = (s - 0.5) * MAP_W;
        // Map view: linear plane through worldX. Keeps x > worldX (right half).
        if (this.splitPlane) this.splitPlane.constant = -worldX;
        if (this.splitLine)  this.splitLine.position.x = worldX;
        // Globe view: rotate the clipping plane around the y-axis so the
        // dividing meridian sits at the longitude corresponding to compareSplit.
        // The texture has offset.x = 0.25, so visually the s=0.5 split
        // corresponds to the meridian at the back of the default camera view.
        // Empirical alignment kept simple: split angle θ = (s - 0.5) * 2π.
        if (this.globeSplitPlane) {
            const theta = (s - 0.5) * 2 * Math.PI;
            this.globeSplitPlane.normal.set(-Math.cos(theta), 0, Math.sin(theta));
        }
    }

    applyCompareMode() {
        const on = !!this.state.compareMode;
        const inMap   = this.state.viewMode === 'map';
        const inGlobe = this.state.viewMode === 'globe';
        const isDiff  = on && this.state.compareStyle === 'diff';
        // Diff style hides the swipe chrome — the right-half mesh, the
        // divider line, the globe reference shell. The single main map
        // renders (active − target) instead, handled in updateField.
        if (this.mapMeshRef) this.mapMeshRef.visible = on && inMap && !isDiff;
        if (this.splitLine)  this.splitLine.visible  = on && inMap && !isDiff;
        if (this.globeRef)   this.globeRef.visible   = on && inGlobe && !isDiff;
        if (on && !isDiff) this.applyCompareSplit(this.state.compareSplit ?? 0.5);
        this.updateCompareLabels();
    }

    // Position the period labels above each half of the swipe-compare and
    // refresh their text. Called from animate() so they track camera zoom /
    // central-meridian shift / divider drag without per-event wiring.
    //
    // Diff style (A − B painted in place on one map) repurposes the left
    // label as a single centered "A − B" caption and hides the right
    // label + drag handle — there's no divider to drag and no two-half
    // split to identify, just one painted difference field.
    updateCompareLabels() {
        const lEl = document.getElementById('compare-label-left');
        const rEl = document.getElementById('compare-label-right');
        const hEl = document.getElementById('compare-handle');
        if (!lEl || !rEl) return;
        const on = this.state.compareMode && this.state.viewMode === 'map';
        if (!on) {
            if (!lEl.hidden) lEl.hidden = true;
            if (!rEl.hidden) rEl.hidden = true;
            if (hEl && !hEl.hidden) hEl.hidden = true;
            return;
        }
        const fmt = (p) => p === 'default' ? '1991–2020'
                       : (p === '1961-1990' ? '1961–1990' : p);
        const leftLabel = this.state.year != null
            ? String(this.state.year)
            : fmt(this.state.climatologyPeriod);
        let rightLabel;
        if (this.state.compareYear != null) {
            rightLabel = String(this.state.compareYear);
        } else {
            const refP = this.compareRefPeriod();
            rightLabel = refP ? fmt(refP) : '—';
        }

        const canvas = this.renderer.domElement;
        const canvasRect = canvas.getBoundingClientRect();
        const containerRect = canvas.parentElement.getBoundingClientRect();
        const offsetX = canvasRect.left - containerRect.left;

        const isDiff = this.state.compareStyle === 'diff';
        if (isDiff) {
            // One centered caption: "A − B". Right label + drag handle
            // have no role in diff mode (no divider, no two halves).
            lEl.textContent = `${leftLabel} − ${rightLabel}`;
            const padding = 90;
            const center = offsetX + canvasRect.width / 2;
            lEl.style.left = Math.max(offsetX + padding,
                Math.min(offsetX + canvasRect.width - padding, center)) + 'px';
            if (lEl.hidden) lEl.hidden = false;
            if (!rEl.hidden) rEl.hidden = true;
            if (hEl && !hEl.hidden) hEl.hidden = true;
            return;
        }

        // Swipe style — two labels straddling the movable divider, drag
        // handle pinned to it.
        lEl.textContent = leftLabel;
        rEl.textContent = rightLabel;
        const split = this.state.compareSplit ?? 0.5;
        const worldPos = new THREE.Vector3((split - 0.5) * MAP_W, 0, 0);
        const ndc = worldPos.clone().project(this.camera);
        const splitX = (ndc.x + 1) * 0.5 * canvasRect.width;
        const leftCenter  = offsetX + splitX * 0.5;
        const rightCenter = offsetX + (splitX + canvasRect.width) * 0.5;
        const padding = 70;   // ~half a label width
        lEl.style.left = Math.max(offsetX + padding,
            Math.min(offsetX + canvasRect.width - padding, leftCenter)) + 'px';
        rEl.style.left = Math.max(offsetX + padding,
            Math.min(offsetX + canvasRect.width - padding, rightCenter)) + 'px';
        if (lEl.hidden) lEl.hidden = false;
        if (rEl.hidden) rEl.hidden = false;
        if (hEl) {
            if (this._compareDragged) {
                if (!hEl.hidden) hEl.hidden = true;
            } else {
                const handleX = Math.max(offsetX + 56,
                    Math.min(offsetX + canvasRect.width - 56, offsetX + splitX));
                hEl.style.left = handleX + 'px';
                if (hEl.hidden) hEl.hidden = false;
            }
        }
    }

    // Compare needs a genuine alternate reference period selected; otherwise
    // the right half would mirror the left. Returns the period to use, or
    // null if no valid comparison can be drawn.
    compareRefPeriod() {
        const r = this.state.referencePeriod;
        if (!r || r === 'default') return null;
        if (r === this.state.climatologyPeriod) return null;
        return r;
    }

    // Compare needs SOMETHING valid to paint on the right half: either a
    // specific year (state.compareYear) or a non-self reference period.
    // Returns true when at least one path will produce a tile.
    compareHasTarget() {
        return (this.state.compareYear != null) || !!this.compareRefPeriod();
    }

    // NaN-safe bilinear sample of the currently-displayed field (after
    // decomposition). Returns a number or null when outside the grid.
    sampleDisplayed(lat, lon) {
        // In compare mode the cursor may be over either side of the divider.
        // Pick which painted-values array to sample from based on which side
        // of the split this lon falls on.
        let vals = this._displayedValues;
        if (this.state.compareMode && this._referenceValues) {
            if (this._cursorOnReferenceSide(lon)) vals = this._referenceValues;
        }
        if (!vals) return null;
        const { nlat, nlon } = GRID;
        const rLat = 90 - lat;
        const rLon = ((lon + 180) % 360 + 360) % 360;
        if (rLat < 0 || rLat > nlat - 1) return null;
        const i0 = Math.floor(rLat);
        const i1 = Math.min(nlat - 1, i0 + 1);
        const j0 = Math.floor(rLon) % nlon;
        const j1 = (j0 + 1) % nlon;
        const fi = rLat - i0;
        const fj = rLon - Math.floor(rLon);
        const v00 = vals[i0 * nlon + j0], v01 = vals[i0 * nlon + j1];
        const v10 = vals[i1 * nlon + j0], v11 = vals[i1 * nlon + j1];
        const corners = [v00, v01, v10, v11];
        if (!corners.every(Number.isFinite)) {
            let s = 0, n = 0;
            for (const v of corners) if (Number.isFinite(v)) { s += v; n += 1; }
            return n > 0 ? s / n : null;
        }
        const vT = v00 * (1 - fj) + v01 * fj;
        const vB = v10 * (1 - fj) + v11 * fj;
        return vT * (1 - fi) + vB * fi;
    }

    // Is the cursor on the reference side of the compare divider? Map view
    // and Globe view use different split geometries (plane-uv vs world-x
    // meridian), so route each through its own check. Used by both hover
    // value sampling and the hover period-label tag.
    _cursorOnReferenceSide(lon) {
        const s = this.state.compareSplit;
        if (this.state.viewMode === 'globe') {
            // Globe clipping plane: normal = (-cos θ, 0, sin θ) with
            // θ = (s - 0.5) * 2π. The reference shell paints where
            // -cos(θ)·x + sin(θ)·z > 0, i.e. sin(θ - lon) > 0.
            const theta = (s - 0.5) * 2 * Math.PI;
            const phi = lon * Math.PI / 180;
            return Math.sin(theta - phi) > 0;
        }
        // Map view: plane-uv-x > compareSplit means right of the divider.
        const planeU = ((((lon + 180) / 360) - this.state.mapCenterLon / 360) % 1 + 1) % 1;
        return planeU > s;
    }

    // For the hover label: which period is the cursor over right now?
    // null = not in compare mode (no period suffix needed).
    sampledPeriodLabel(lat, lon) {
        if (!this.state.compareMode || !this._referenceValues) return null;
        const onReference = this._cursorOnReferenceSide(lon);
        const fmt = (p) => p === 'default' ? '1991–2020'
                       : (p === '1961-1990' ? '1961–1990' : p);
        if (onReference) {
            if (this.state.compareYear != null) return String(this.state.compareYear);
            return fmt(this.compareRefPeriod());
        }
        // Active side — either the current year or the active climatology.
        if (this.state.year != null) return String(this.state.year);
        return fmt(this.state.climatologyPeriod);
    }

    formatHoverLabel(lat, lon, v) {
        const meta = FIELDS[this.state.field] || {};
        const latS = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
        const lonS = `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
        const mode = this.state.decompose;
        const modeTag = (mode && mode !== 'total')
            ? `<span class="hv-mode">${mode}</span>` : '';
        // σ-anom is a unit-less z-score — override the field's native unit
        // so the readout reads "+6.81 σ" instead of "6.81 mm/day zscore".
        // Matches the colorbar unit logic (see updateColorbar).
        const unitText = (mode === 'zscore') ? 'σ' : (meta.units || '');
        // In compare mode, append which period the cursor is over so the
        // value is unambiguous.
        const periodLabel = this.sampledPeriodLabel(lat, lon);
        const periodTag = periodLabel
            ? `<span class="hv-mode" style="color:var(--amber); border-color:rgba(232,194,106,0.4);">${periodLabel}</span>`
            : '';
        return (
            `${latS}<span class="hv-sep">·</span>${lonS}` +
            `<span class="hv-sep">·</span>` +
            `<span class="hv-value">${fmtValue(v)}</span>` +
            `<span class="hv-unit">${unitText}</span>${modeTag}${periodTag}`
        );
    }

    /** Pointer hover on the cross-section canvas → (lat, p, value) tooltip. */
    bindXSHover() {
        const canvas = document.getElementById('xs-canvas');
        const tip    = document.getElementById('xs-hover');
        if (!canvas || !tip) return;
        // Padding in CSS pixels — must mirror renderCrossSection's calc
        // (which uses padL = 42*DPR etc. in BUFFER pixels; in CSS pixels the
        // numbers are the same since they're proportional to DPR).
        const PAD_L = 42, PAD_R = 10, PAD_T = 10, PAD_B = 26;

        const onMove = (e) => {
            if (!this.state.showXSection) { tip.classList.add('hidden'); return; }
            const zm = this._xsLastZm;
            if (!zm) { tip.classList.add('hidden'); return; }
            const rect = canvas.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const plotW = rect.width  - PAD_L - PAD_R;
            const plotH = rect.height - PAD_T - PAD_B;
            if (cx < PAD_L || cx > PAD_L + plotW || cy < PAD_T || cy > PAD_T + plotH) {
                tip.classList.add('hidden'); return;
            }
            const fracX = (cx - PAD_L) / plotW;
            const fracY = (cy - PAD_T) / plotH;
            const sample = samplePanel(zm, fracX, fracY);
            if (!sample) { tip.classList.add('hidden'); return; }
            tip.innerHTML = this.formatXSHoverLabel(zm, sample);
            // Position; flip to other side of cursor near right/bottom edges.
            const pad = 14;
            const w = tip.offsetWidth || 200;
            const h = tip.offsetHeight || 30;
            let x = e.clientX + pad;
            let y = e.clientY + pad;
            if (x + w > window.innerWidth)  x = e.clientX - w - pad;
            if (y + h > window.innerHeight) y = e.clientY - h - pad;
            tip.style.left = `${x}px`;
            tip.style.top  = `${y}px`;
            tip.classList.remove('hidden');
        };
        canvas.addEventListener('pointermove',  onMove);
        canvas.addEventListener('pointerleave', () => tip.classList.add('hidden'));
    }

    formatXSHoverLabel(zm, sample) {
        const fmt = (v, n = 2) => Number.isFinite(v) ? v.toFixed(n) : '—';
        const latS = `${Math.abs(sample.lat).toFixed(1)}°${sample.lat >= 0 ? 'N' : 'S'}`;
        const parts = [latS];
        if (sample.lon !== undefined) {
            const lonS = `${Math.abs(sample.lon).toFixed(1)}°${sample.lon >= 0 ? 'E' : 'W'}`;
            parts.push(lonS);
        }
        if (sample.p !== undefined) parts.push(`${Math.round(sample.p)} hPa`);
        const valHtml =
            `<span class="hv-value">${fmt(sample.value, 2)}</span>` +
            `<span class="hv-unit">${zm.units || ''}</span>`;
        return parts.join('<span class="hv-sep">·</span>') +
               '<span class="hv-sep">·</span>' + valHtml;
    }

    applyParticleContrast() {
        if (!this.particles) return;
        // Ink a dark near-black on bright colormaps (turbo, wind, plasma end)
        // and white on dark ones (viridis, magma). Threshold tuned so magma
        // stays white and turbo flips to dark. In eddy/anomaly modes the
        // effective cmap is forced to RdBu_r, so use that instead.
        const darkInk = 0x0b1a14;
        const lightInk = 0xffffff;
        const sym = this.state.decompose === 'eddy' || this.state.decompose === 'anomaly';
        const cmap = sym ? 'RdBu_r' : this.state.cmap;
        this.particles.setColor(meanLuminance(cmap) > 0.52 ? darkInk : lightInk);
    }

    applyWindMode() {
        const m = this.state.windMode;
        if (this.particles)   this.particles.setVisible(m === 'particles');
        if (this.barbs) this.barbs.setVisible(m === 'barbs');
    }

    refreshWindCache() {
        const { field, month, level, theta, vCoord } = this.state;
        // Pick the right wind source for the displayed field's level type:
        // single-level fields (SST, MSL, T2m, surface fluxes, …) get the
        // 10-m winds (u10/v10); pressure-level fields get u/v at the chosen
        // pressure or θ surface. Without this, surface fields would show
        // 500 hPa winds (or whatever the pressure dropdown was last set to)
        // — pedagogically misleading over SST, T2m, MSL, etc.
        const meta = FIELDS[field];
        const useSurface = meta?.type === 'sl';
        const uF = useSurface
            ? getField('u10', { month })
            : getField('u', { month, level, coord: vCoord, theta });
        const vF = useSurface
            ? getField('v10', { month })
            : getField('v', { month, level, coord: vCoord, theta });
        // If the request came back pending (tiles still loading, especially
        // in θ-coord where we need T + u + v at every pressure level), keep
        // the previous cache so particles keep moving with the last good
        // field instead of snapping to NaN. `stale` stays true so we retry
        // on the next tick.
        if (!uF.isReal || !vF.isReal) return;
        this.windCache.u = uF.values;
        this.windCache.v = vF.values;
        this.windCache.nlat = GRID.nlat;
        this.windCache.nlon = GRID.nlon;
        this.windCache.stale = false;
    }

    sampleWind(lat, lon) {
        if (this.windCache.stale) this.refreshWindCache();
        const { u, v, nlat, nlon } = this.windCache;
        if (!u || !v) return null;
        // Grid row 0 = lat +90, col 0 = lon −180.
        const rLat = 90 - lat;
        const rLon = ((lon + 180) % 360 + 360) % 360;
        if (rLat < 0 || rLat > nlat - 1) return null;
        const i0 = Math.floor(rLat);
        const i1 = Math.min(nlat - 1, i0 + 1);
        const j0 = Math.floor(rLon) % nlon;
        const j1 = (j0 + 1) % nlon;
        const fi = rLat - i0;
        const fj = rLon - Math.floor(rLon);
        const uTop = u[i0 * nlon + j0] * (1 - fj) + u[i0 * nlon + j1] * fj;
        const uBot = u[i1 * nlon + j0] * (1 - fj) + u[i1 * nlon + j1] * fj;
        const vTop = v[i0 * nlon + j0] * (1 - fj) + v[i0 * nlon + j1] * fj;
        const vBot = v[i1 * nlon + j0] * (1 - fj) + v[i1 * nlon + j1] * fj;
        return [uTop * (1 - fi) + uBot * fi, vTop * (1 - fi) + vBot * fi];
    }

    // ── mode switching ───────────────────────────────────────────────
    setViewMode(mode) {
        if (mode === this.state.viewMode) return;
        this.state.viewMode = mode;
        this.globeGroup.visible = mode === 'globe';
        this.mapGroup.visible   = mode === 'map';
        this.orbitGroup.visible = mode === 'orbit';

        // Map-specific controls only meaningful in map view.
        const mcg = document.getElementById('map-center-group');
        if (mcg) mcg.hidden = mode !== 'map';
        // Sections that only make sense in one view: hide them in the
        // others so the sidebar stays focused on what the user can actually
        // do right now. Compare swipe is map-only; parcels release is
        // globe-only.
        const compareSec = document.getElementById('compare-group');
        if (compareSec) compareSec.hidden = mode !== 'map';
        const parcelsSec = document.getElementById('parcels-section');
        if (parcelsSec) parcelsSec.hidden = mode !== 'globe';
        this.updateHintForViewMode();

        this.rebuildCoastlines();
        this.rebuildGraticule();

        // Wind overlays + contour labels only attach to globe or map groups;
        // in orbit mode they're hidden (orbit view is too zoomed-out for them
        // to read). Parent them to globeGroup as a no-op when in orbit.
        const overlayParent = mode === 'orbit' ? this.globeGroup : this.currentGroup();

        this.particles.object.parent?.remove(this.particles.object);
        this.barbs.object.parent?.remove(this.barbs.object);
        overlayParent.add(this.particles.object);
        overlayParent.add(this.barbs.object);
        this.particles.onProjectionChanged();
        if (this.state.windMode === 'barbs') this.barbs.rebuild(mode);

        if (this.contourLabels) {
            this.contourLabels.group.parent?.remove(this.contourLabels.group);
            overlayParent.add(this.contourLabels.group);
            this.contourLabels.setProjection((lat, lon, r) => this.project(lat, lon, r));
            this.updateField();  // regenerate labels for new projection
        }
        if (this.arcGroup) {
            this.arcGroup.parent?.remove(this.arcGroup);
            overlayParent.add(this.arcGroup);
            this.updateArcLine();
        }
        this.applySunVisibility();
        // Compare overlay lives in different groups for each view (mapMeshRef
        // in mapGroup, globeRef in globeGroup); refresh visibility so the
        // right one shows after the view swap.
        this.applyCompareMode();

        this.configureCamera();
    }

    configureCamera() {
        if (this.state.viewMode === 'globe') {
            this.camera.position.set(...cameraFromView(DEFAULT_VIEW, AXIAL_TILT));
            this.controls.enableRotate = true;
            this.controls.enablePan = false;
            this.controls.minDistance = 1.4;
            this.controls.maxDistance = 8;
        } else if (this.state.viewMode === 'map') {
            this.camera.position.set(0, 0, 3.6);
            this.controls.enableRotate = false;
            this.controls.enablePan = false;      // custom drag handler shifts centre meridian instead
            this.controls.minDistance = 1.2;
            this.controls.maxDistance = 6;
            this.controls.target.set(0, 0, 0);
            this.controls.update();
            return;
        } else if (this.state.viewMode === 'orbit') {
            // Camera above the ecliptic, looking down-and-inward so the
            // student sees the orbit plane, the sun, and Earth's tilted axis
            // all at once.
            this.camera.position.set(ORBIT_RADIUS * 1.4, ORBIT_RADIUS * 1.1, ORBIT_RADIUS * 1.4);
            this.controls.enableRotate = true;
            this.controls.enablePan = false;
            this.controls.minDistance = 2.0;
            this.controls.maxDistance = 14;
        } else {
            this.camera.position.set(0, 0, 3.6);
            this.controls.enableRotate = false;
            this.controls.enablePan = true;
            this.controls.screenSpacePanning = true;
            this.controls.minDistance = 1.2;
            this.controls.maxDistance = 6;
        }
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    // ── state updates ─────────────────────────────────────────────────
    setState(patch) {
        // viewMode is a heavyweight transition (re-parents overlay groups,
        // rebuilds coastlines/graticule for the new projection, repositions
        // wind+contour overlays). Route through setViewMode so any caller
        // can drive a view change via state — without it the visible groups
        // wouldn't update. Hop early so 'viewMode' isn't double-applied by
        // the Object.assign below.
        if ('viewMode' in patch && patch.viewMode !== this.state.viewMode) {
            this.setViewMode(patch.viewMode);
            // Sync the view-toggle button row.
            const map = { globe: 'view-globe', map: 'view-map', orbit: 'view-orbit' };
            document.querySelectorAll('.view-toggle button').forEach(b =>
                b.classList.toggle('active', b.id === map[patch.viewMode]));
            delete patch.viewMode;
        }
        Object.assign(this.state, patch);
        if ('field' in patch) {
            // Manual colorbar override almost certainly doesn't apply to the
            // new field — drop it so the user sees the new field's natural
            // range. Persists across level / month / mode changes per design.
            this.state.userVmin = null;
            this.state.userVmax = null;
            // Same for the cross-section panel.
            this.state.xsUserVmin = null;
            this.state.xsUserVmax = null;
        }
        if ('xsDiag' in patch) {
            // Each xs diagnostic has its own units (ψ in 10⁹ kg/s, M in 10⁹
            // m²/s, N² in 10⁻⁴ s⁻², EP flux, budgets …). A clamp set for one
            // mode is meaningless for the next, so reset on mode change.
            this.state.xsUserVmin = null;
            this.state.xsUserVmax = null;
        }
        if ('decompose' in patch) {
            // Total / zonal / eddy / anomaly / σ-anom each have very
            // different natural ranges (e.g. SST total 270-305 K vs SST
            // anomaly ±5 K vs σ-anom ±3 dimensionless). Whether the user
            // manually clamped or just let the auto-range latch onto the
            // anomaly's small bounds, the previous range is wrong for the
            // new mode — drop it so the colorbar re-fits to the new field.
            this.state.userVmin = null;
            this.state.userVmax = null;
        }
        if ('showCoastlines' in patch && this.coastGroup) this.coastGroup.visible = !!patch.showCoastlines;
        if ('showGraticule' in patch && this.gratGroup)   this.gratGroup.visible   = !!patch.showGraticule;
        if ('showContours' in patch && this.contours)     this.contours.setVisible(!!patch.showContours);
        if ('contourField' in patch) {
            // Kick a fetch for the new overlay field at the current level,
            // then re-render so the new isolines appear.
            const ofName = patch.contourField;
            if (ofName) {
                const om = FIELDS[ofName];
                prefetchField(ofName, {
                    level: om?.type === 'pl' ? this.state.level : undefined,
                });
            }
            this.updateField();
        }
        if ('showSun' in patch || 'viewMode' in patch)    this.applySunVisibility();
        if ('month' in patch || 'seasonal' in patch)      this._refreshSeasonalLabel();
        if ('month' in patch && this.sun)                 this.sun.update(this.state.month);
        if ('month' in patch && this.orbit)               this.orbit.update(this.state.month, this.spinAngle, this.camera);
        // Year-slider max depends on which (year, month) tiles exist —
        // 2026 has only Jan-Mar uploaded as of writing, so the latest
        // valid year drops from 2026 to 2025 the moment the user moves
        // off Q1. Re-clamp on every month change.
        if ('month' in patch)                             this.populateYearSelect();
        if ('windMode' in patch) this.applyWindMode();
        if ('cmap' in patch) this.applyParticleContrast();
        if ('slidingClimo' in patch) {
            // Toggling sliding climo affects both the composite anomaly
            // path AND the timeseries anomaly mode (both piggyback on
            // this single toggle). Prefetch manifests for every climo
            // window so the sliding path has tiles to draw from, and
            // re-render both consumers.
            if (patch.slidingClimo) {
                for (const w of CLIMO_WINDOWS) {
                    if (w.id !== '1991-2020' && w.id !== '1961-1990') {
                        loadManifest(w.id);
                    }
                }
            }
            this.updateField();
            if (this.state.showTimeseries) this._scheduleTimeseriesRender();
        }
        if ('decompose' in patch) {
            this.applyParticleContrast();
            // Anomaly needs the full 12-month tile set to compute the annual
            // mean; prefetch here so switching modes hurries them along.
            if (patch.decompose === 'anomaly') {
                prefetchField(this.state.field, { level: this.state.level });
            }
            // σ-anom additionally needs the std tile for the current month.
            // Prefetch all 12 std tiles so cross-month aggregation works
            // and month-scrubs are smooth.
            if (patch.decompose === 'zscore') {
                prefetchField(this.state.field, {
                    level: this.state.level, kind: 'std',
                });
            }
        }
        if ('mapCenterLon' in patch) this.applyMapCenterLon();
        if ('compareMode' in patch || 'viewMode' in patch) this.applyCompareMode();
        if ('compareSplit' in patch) this.applyCompareSplit(this.state.compareSplit);
        if ('compareStyle' in patch) {
            // Toggle the reference mesh / divider chrome, then repaint so
            // diff or swipe gets applied to the main canvas.
            this.applyCompareMode();
            this.updateField();
        }
        if ('compareMode' in patch) this.updateHintForViewMode();
        if ('xsArc' in patch) this.updateArcLine();
        if ('xsDiag' in patch) {
            // Diagnostics sample a specific component field at every
            // pressure level — prefetch them all so the panel fills in
            // quickly when the user switches mode.
            if (patch.xsDiag === 'psi') {
                for (const L of LEVELS) prefetchField('v', { level: L });
            } else if (patch.xsDiag === 'M') {
                for (const L of LEVELS) prefetchField('u', { level: L });
            } else if (patch.xsDiag === 'ug') {
                for (const L of LEVELS) prefetchField('z', { level: L });
            } else if (patch.xsDiag === 'N2') {
                for (const L of LEVELS) prefetchField('t', { level: L });
            } else if (patch.xsDiag === 'epflux') {
                for (const L of LEVELS) {
                    prefetchField('u', { level: L });
                    prefetchField('v', { level: L });
                    prefetchField('w', { level: L });
                    prefetchField('t', { level: L });
                }
            } else if (patch.xsDiag === 'mbudget') {
                for (const L of LEVELS) {
                    prefetchField('u', { level: L });
                    prefetchField('v', { level: L });
                    prefetchField('w', { level: L });
                }
            } else if (patch.xsDiag === 'qbudget') {
                for (const L of LEVELS) {
                    prefetchField('u', { level: L });
                    prefetchField('v', { level: L });
                    prefetchField('w', { level: L });
                    prefetchField('q', { level: L });
                }
                // Surface E-P overlay needs slhf + tp (single-level).
                prefetchField('slhf', {});
                prefetchField('tp',   {});
            } else if (patch.xsDiag === 'hbudget') {
                for (const L of LEVELS) {
                    prefetchField('u', { level: L });
                    prefetchField('v', { level: L });
                    prefetchField('w', { level: L });
                    prefetchField('t', { level: L });
                    prefetchField('z', { level: L });
                    prefetchField('q', { level: L });
                }
                // Surface heating overlay: turbulent fluxes + radiation.
                for (const sl of ['slhf','sshf','ssr','str','tisr','ttr']) prefetchField(sl, {});
            }
            // Show / hide the budget sub-controls. Same panel UI is shared
            // across all three budgets — the term labels are generic enough.
            const isBudget = ['mbudget','qbudget','hbudget'].includes(patch.xsDiag);
            const mbCtl = document.getElementById('mb-controls');
            if (mbCtl) mbCtl.hidden = !isBudget;
            // Hide the form toggle for q/h budgets (only meaningful for M).
            const mbFormGroup = document.querySelector('.mb-row-toggles .mb-toggle-group:first-child');
            if (mbFormGroup) mbFormGroup.style.display = (patch.xsDiag === 'mbudget') ? '' : 'none';
            // Re-label the residual-term option per budget context.
            const torqueOpt = document.querySelector('#mb-term-select option[value="torque"]');
            if (torqueOpt) {
                torqueOpt.textContent = patch.xsDiag === 'qbudget' ? 'Implied source (E−P)'
                                       : patch.xsDiag === 'hbudget' ? 'Implied atmospheric heating'
                                       : 'Implied surface torque';
            }
            const mbInfoBtn = document.getElementById('mb-info-btn');
            if (mbInfoBtn) mbInfoBtn.hidden = patch.xsDiag !== 'mbudget';   // popover is M-specific
            const mbInfo = document.getElementById('mb-info');
            if (mbInfo && patch.xsDiag !== 'mbudget') {
                mbInfo.setAttribute('hidden', '');
                mbInfoBtn?.classList.remove('active');
            }
            // Q-budget and H-budget: closure hasn't been formally validated
            // against literature (ROADMAP item #8 pending). Surface a
            // "structure reliable, magnitudes want a spot-check" caveat
            // inline whenever either is active. M-budget has its own
            // sharper caveats in the info popover already.
            const caveat = document.getElementById('budget-caveat');
            if (caveat) {
                caveat.hidden = !(patch.xsDiag === 'qbudget' || patch.xsDiag === 'hbudget');
            }
        }
        if ('showXSection' in patch) {
            const panel = document.getElementById('xsection-panel');
            if (panel) panel.hidden = !patch.showXSection;
        }
        if ('showLorenz' in patch) {
            const panel = document.getElementById('lorenz-panel');
            if (panel) panel.hidden = !patch.showLorenz;
            if (patch.showLorenz) {
                // Lorenz needs u, v, w, t at every level — kick a full prefetch.
                for (const L of LEVELS) {
                    prefetchField('u', { level: L });
                    prefetchField('v', { level: L });
                    prefetchField('w', { level: L });
                    prefetchField('t', { level: L });
                }
            }
        }
        if ('showTimeseries' in patch) {
            const panel = document.getElementById('timeseries-panel');
            const r = this.state.timeseriesRegion;
            // Panel shows only when the user has BOTH opted into the feature
            // AND a region has been picked. Without that gate, the panel
            // would cover the map while the user is trying to draw the box.
            if (panel) panel.hidden = !(patch.showTimeseries && r);
            if (patch.showTimeseries) {
                loadManifest('per_year').then(() => {
                    if (!this.state.timeseriesRegion) {
                        // First-time: drop straight into picking mode so the
                        // map stays visible. The panel reveals itself once
                        // the region is committed.
                        this._enterTimeseriesPicking();
                    } else {
                        this._prefetchTimeseriesTiles();
                        this._drawTimeseriesRegionOverlay(
                            { lat: r.latMin, lon: r.lonMin },
                            { lat: r.latMax, lon: r.lonMax },
                        );
                        const lbl = document.getElementById('ts-region-label');
                        if (lbl) lbl.textContent = tsBboxLabel(r);
                        this.renderTimeseries();
                    }
                });
            } else {
                this._exitTimeseriesPicking();
                if (this._tsRegionLine) this._tsRegionLine.visible = false;
            }
        }
        if ('timeseriesRegion' in patch) {
            // Region just committed (or replaced) — reveal the panel if the
            // user had opted in, fetch tiles, and kick a render.
            if (this.state.showTimeseries) {
                const panel = document.getElementById('timeseries-panel');
                if (panel) panel.hidden = false;
            }
            this._syncTimeseriesBoundsInputs();
            this._prefetchTimeseriesTiles();
            this._scheduleTimeseriesRender();
        }
        if ('timeseriesMode' in patch) this._scheduleTimeseriesRender();
        if (this.state.showTimeseries
            && ('field' in patch || 'level' in patch
                || 'vCoord' in patch || 'theta' in patch)) {
            this._prefetchTimeseriesTiles();
            this._scheduleTimeseriesRender();
        }
        if ('level' in patch || 'month' in patch || 'vCoord' in patch || 'theta' in patch || 'field' in patch) this.windCache.stale = true;
        if ('month' in patch && this.parcels) this.parcels.invalidateCube();
        if ('vCoord' in patch || 'theta' in patch) invalidateIsentropicCache();
        if ('year' in patch || 'customRange' in patch) {
            // Time-slice change (year / customRange) invalidates derived +
            // isentropic caches (their keys don't include those) and the
            // wind cache; trigger a re-render.
            invalidateIsentropicCache();
            this.windCache.stale = true;
            if (this.parcels) this.parcels.invalidateCube();
            // Climatology-period control is meaningless when viewing a
            // single year OR a custom-range composite — grey it out.
            const climoSel = document.getElementById('climo-period-select');
            const altActive = (this.state.year != null) || !!this.state.customRange;
            if (climoSel) climoSel.disabled = altActive;
            // Reference-period dropdown's "Self" option means different things
            // in climatology vs year mode. Relabel so the user sees what the
            // anomaly is actually subtracting.
            this.refreshRefPeriodLabels();
            if (this.refreshCompositeUI) this.refreshCompositeUI();
        }
        if ('month' in patch && this.refreshCompositeUI) {
            // Index threshold is evaluated at the current month, so the
            // matched-event list changes with every month scrub.
            this.refreshCompositeUI();
        }
        if ('climatologyPeriod' in patch) {
            // The "Self" label also depends on which 30-yr window is active
            // when in climatology mode (changes "1991-2020" → "1961-1990").
            this.refreshRefPeriodLabels();
        }
        if ('decompose' in patch || 'kind' in patch || 'compareMode' in patch
            || 'compareYear' in patch) {
            // Toggle ref-period-row visibility based on whether anomaly /
            // ±1σ / compare actually need it.
            this.refreshRefPeriodLabels();
        }
        if ('climatologyPeriod' in patch) {
            // Switch the active tile tree. Derived / isentropic caches don't
            // include period in their keys, so wipe them to force rebuild from
            // the new period's underlying tiles. Wind cache + parcel cube same.
            setActivePeriod(patch.climatologyPeriod);
            invalidateIsentropicCache();
            this.windCache.stale = true;
            if (this.parcels) this.parcels.invalidateCube();
            // Disable the climate-change-anomaly option when comparing the
            // active period against itself would yield zero — keeps the UI
            // consistent until we add a literal '1991-2020' name.
            const refSel = document.getElementById('ref-period-select');
            if (refSel) {
                for (const opt of refSel.options) {
                    if (opt.value !== 'default') {
                        opt.disabled = (opt.value === patch.climatologyPeriod);
                    }
                }
                if (refSel.value === patch.climatologyPeriod) {
                    const stalePeriod = refSel.value;
                    refSel.value = 'default';
                    this.state.referencePeriod = 'default';
                    // Surface the silent reset — user just picked a
                    // climatology period that matched their reference
                    // period (self vs self → zero anomaly), so we
                    // dropped them back to "Self · 12-month mean".
                    const flash = document.getElementById('ref-period-flash');
                    if (flash) {
                        flash.textContent =
                            `Reference period reset to "Self" — ${stalePeriod} is now your active climatology, so comparing against it would yield zero.`;
                        flash.hidden = false;
                        flash.classList.remove('is-fading');
                        clearTimeout(this._refPeriodFlashTimer);
                        this._refPeriodFlashTimer = setTimeout(() => {
                            flash.classList.add('is-fading');
                            setTimeout(() => { flash.hidden = true; }, 450);
                        }, 5000);
                    }
                }
            }
            // Make sure the alternate manifest is loaded; if it isn't, kick
            // the loader and re-render once it lands (a placeholder NaN field
            // shows in the meantime).
            if (patch.climatologyPeriod !== 'default') {
                loadManifest(patch.climatologyPeriod).then((ok) => {
                    if (ok) {
                        this.updateField();
                        // σ-anom availability depends on the newly-loaded
                        // manifest's has_std flags — re-evaluate once it lands.
                        this._refreshZscoreAvailability?.();
                    }
                });
            }
            this._refreshZscoreAvailability?.();
        }
        if ('field' in patch) this._refreshZscoreAvailability?.();

        // Eagerly prefetch all 12 months at this (field, level) so the
        // colorbar stabilises quickly once any tile lands.
        // Reference-period change: lazy-load the manifest, then prefetch the
        // current field at all 12 months for the reference period.
        if ('referencePeriod' in patch && patch.referencePeriod === 'best-match') {
            // best-match fans out across every 30-yr window (the active
            // year or compareYear picks the specific one) — preload all
            // 8 manifests up front so getField(..., period: '1996-2025')
            // etc. don't return null on first call. No single-period
            // prefetch here since we don't yet know which window will
            // apply; re-render fires when any manifest lands.
            for (const w of CLIMO_WINDOWS) {
                loadManifest(w.id).then((ok) => {
                    if (ok && this.state.referencePeriod === 'best-match') {
                        this.updateField();
                    }
                });
            }
        } else if ('referencePeriod' in patch && patch.referencePeriod !== 'default') {
            (async () => {
                const ok = await loadManifest(patch.referencePeriod);
                if (!ok) {
                    console.warn(`[ref-period] manifest unavailable for ${patch.referencePeriod} — falling back to self-anomaly`);
                    return;
                }
                prefetchField(this.state.field, { level: this.state.level, period: patch.referencePeriod });
                // θ climate-change / year-vs-refPeriod anomaly needs T at
                // every level + field at every level from the reference
                // period so the θ-cube + interpolation can run without
                // cold-start stalls. Applies whether or not year is set.
                if (this.state.vCoord === 'theta'
                        && this.state.decompose === 'anomaly') {
                    for (const L of LEVELS) {
                        prefetchField('t', { level: L, period: patch.referencePeriod });
                        if (this.state.field !== 't') {
                            prefetchField(this.state.field, { level: L, period: patch.referencePeriod });
                        }
                        if (this.state.field === 'pv') {
                            prefetchField('pv', { level: L, period: patch.referencePeriod });
                        }
                    }
                }
                if (this.state.decompose === 'anomaly') this.updateField();
            })();
        }
        if ('field' in patch || 'level' in patch || 'vCoord' in patch || 'theta' in patch || 'kind' in patch || 'year' in patch || 'compareYear' in patch) {
            const isen = this.state.vCoord === 'theta';
            const kind = this.state.kind;
            prefetchField(this.state.field, { level: this.state.level, kind });
            // If user is in climate-change-anomaly mode, also prefetch the
            // reference period's tiles for the new field/level.
            if (this.state.referencePeriod !== 'default') {
                prefetchField(this.state.field, { level: this.state.level, period: this.state.referencePeriod });
            }
            // Year mode: prefetch all 12 months of the chosen year so the
            // cross-month aggregator's colorbar stabilises and month-scrub
            // is instant. Climatology mean for the same months is already
            // covered by the active-period prefetch above (used as the
            // year-anomaly reference).
            if (this.state.year != null) {
                prefetchField(this.state.field, {
                    level: this.state.level,
                    period: 'per_year',
                    year: this.state.year,
                });
                // Year + θ-coord: the θ-cube needs T at EVERY level for the
                // chosen year, and the displayed field needs values at every
                // level for the interpolation. Prefetch both so θ-year mode
                // is responsive to month scrubs.
                if (this.state.vCoord === 'theta') {
                    for (const L of LEVELS) {
                        prefetchField('t', {
                            level: L, period: 'per_year', year: this.state.year });
                        if (this.state.field !== 't') {
                            prefetchField(this.state.field, {
                                level: L, period: 'per_year', year: this.state.year });
                        }
                        // PV on θ needs pv tiles at every level too.
                        if (this.state.field === 'pv') {
                            prefetchField('pv', {
                                level: L, period: 'per_year', year: this.state.year });
                        }
                    }
                }
            }
            // Also prefetch the compare-target year when in year-vs-* mode.
            if (this.state.compareMode && this.state.compareYear != null) {
                prefetchField(this.state.field, {
                    level: this.state.level,
                    period: 'per_year',
                    year: this.state.compareYear,
                });
            }
            prefetchField('u', { level: this.state.level });
            prefetchField('v', { level: this.state.level });
            // Single-level fields use 10-m winds for the particle/barb overlay
            // (see refreshWindCache); kick those tiles too so the wind layer
            // populates instantly when the user picks SST / T2m / MSL / etc.
            if (FIELDS[this.state.field]?.type === 'sl') {
                prefetchField('u10', {});
                prefetchField('v10', {});
            }
            // MSE depends on t, z, q at the chosen level (and at every level
            // when in θ-coord OR when the cross-section panel is open).
            // We prefetch ALL 12 months at the chosen level so the aggregate
            // colorbar stabilises rather than re-shifting as months load —
            // mirrors what prefetchField does automatically for raw tiles.
            if (this.state.field === 'mse') {
                prefetchField('t', { level: this.state.level });
                prefetchField('z', { level: this.state.level });
                prefetchField('q', { level: this.state.level });
                if (this.state.showXSection) {
                    for (const L of LEVELS) {
                        prefetchField('t', { level: L });
                        prefetchField('z', { level: L });
                        prefetchField('q', { level: L });
                    }
                }
            }
            // PV and any θ-coord rendering require T at every pressure level
            // (for the θ cube) plus the chosen field at every level — kick
            // those here so they arrive in parallel. In θ-coord we also
            // prefetch u and v at every level unconditionally, because the
            // wind overlay (particles / barbs) samples isentropic u, v even
            // when the primary field is something else.
            const needsAllLevels = (this.state.field === 'pv') || isen;
            if (needsAllLevels) {
                // Build the list of ingredients we need at every level.
                // PV needs t (for the θ cube) + pv (the canonical Ertel field
                // we now interpolate directly to θ surfaces).
                const ingredients = ['t'];
                if (isen || this.state.field === 'wspd') {
                    ingredients.push('u', 'v');
                }
                if (this.state.field === 'pv') {
                    ingredients.push('pv');
                }
                if (this.state.field === 'mse') {
                    ingredients.push('z', 'q');
                }
                if (FIELDS[this.state.field]?.type === 'pl' &&
                    !['u','v','wspd','pv','t','mse'].includes(this.state.field)) {
                    ingredients.push(this.state.field);
                }
                // Hot path: fetch every level for the CURRENT month first so
                // the view renders asap. Deferring the other 11 months keeps
                // the browser's 6-connection queue focused on what we need
                // right now — the all-months warmup follows in a microtask
                // for the colorbar aggregation + play mode.
                const current = [this.state.month];
                for (const L of LEVELS) {
                    for (const name of ingredients) {
                        prefetchField(name, { level: L, months: current });
                    }
                }
                setTimeout(() => {
                    const others = [1,2,3,4,5,6,7,8,9,10,11,12].filter(m => m !== this.state.month);
                    for (const L of LEVELS) {
                        for (const name of ingredients) {
                            prefetchField(name, { level: L, months: others });
                        }
                    }
                }, 1500);
            }
        }

        // Barbs are static — rebuild when the wind field (or map centering)
        // changes, or when the user switches INTO barbs mode.
        if (this.barbs && this.state.windMode === 'barbs' &&
            ('level' in patch || 'month' in patch || 'windMode' in patch || 'mapCenterLon' in patch)) {
            this.barbs.rebuild(this.state.viewMode);
        }

        this.updateField();
        if (this.state.showXSection) this.updateXSection();
        if (this.state.showLorenz)   this.updateLorenz();

        // Persist the current view into the URL hash so back/forward + copy-
        // paste both work. Debounced so rapid month/year scrubs don't thrash
        // history.replaceState. Doesn't create history entries.
        writeHashDebounced(this.state);
    }

    updateLorenz() {
        const cycle = computeLorenzCycle(this.state.month, this.state.lorenzRef);
        const setText = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
        const setConv = (id, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (!Number.isFinite(val)) { el.textContent = '—'; el.classList.remove('neg'); return; }
            el.textContent = `${val >= 0 ? '+' : ''}${val.toFixed(2)}`;
            el.classList.toggle('neg', val < 0);
        };
        const setReservoir = (id, val) => {
            // Display in MJ/m² (J/m² ÷ 1e6).
            if (!Number.isFinite(val)) { setText(id, '—'); return; }
            const mj = val / 1e6;
            setText(id, mj >= 100 ? mj.toFixed(0) : mj.toFixed(1));
        };
        if (!cycle) {
            setText('lz-PM','…'); setText('lz-PE','…'); setText('lz-KM','…'); setText('lz-KE','…');
            return;
        }
        setReservoir('lz-PM', cycle.reservoirs.PM);
        setReservoir('lz-PE', cycle.reservoirs.PE);
        setReservoir('lz-KM', cycle.reservoirs.KM);
        setReservoir('lz-KE', cycle.reservoirs.KE);
        setConv('lz-c-PMPE', cycle.conversions.C_PM_PE);
        setConv('lz-c-PEKE', cycle.conversions.C_PE_KE);
        setConv('lz-c-KEKM', cycle.conversions.C_KE_KM);
        setConv('lz-c-PMKM', cycle.conversions.C_PM_KM);
        // Arrow widths encode |C| (capped). Flip direction when negative by
        // swapping the line endpoints' marker; simpler: rotate the visible
        // marker via the line's `transform` if needed. For now we leave
        // arrows pointing in canonical direction and let the sign in the
        // label communicate reversal.
        const widthFor = (v) => Number.isFinite(v) ? Math.max(0.8, Math.min(4.5, Math.abs(v) * 0.6)) : 1.2;
        const setArrow = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.setAttribute('stroke-width', widthFor(val).toFixed(2));
        };
        setArrow('lz-arrow-PMPE', cycle.conversions.C_PM_PE);
        setArrow('lz-arrow-PEKE', cycle.conversions.C_PE_KE);
        setArrow('lz-arrow-KEKM', cycle.conversions.C_KE_KM);
        setArrow('lz-arrow-PMKM', cycle.conversions.C_PM_KM);
    }

    updateXSection() {
        const canvas = document.getElementById('xs-canvas');
        if (!canvas) return;
        const { field, month, xsArc, cmap, showContours, xsDiag, seasonal } = this.state;
        // Seasonal is now honoured by every diagnostic (cachedMonth +
        // the diagnostic modules all accept the flag). One shared opts
        // object feeds both the plain-field paths and the diagnostic
        // helpers below.
        const xsOpts = { seasonal };
        let zm;
        let effCmap = cmap;
        if (xsDiag === 'psi') {
            zm = computeMassStreamfunction(month, xsOpts);
            if (!zm) {
                zm = computeZonalMean(field, month, xsOpts);
            } else {
                effCmap = 'RdBu_r';
                zm.contourInterval = 20;             // 10⁹ kg/s
            }
        } else if (xsDiag === 'M') {
            zm = computeAngularMomentum(month, xsOpts);
            if (!zm) {
                zm = computeZonalMean(field, month, xsOpts);
            } else {
                effCmap = 'viridis';
                zm.contourInterval = 0.5;            // 10⁹ m²/s
            }
        } else if (xsDiag === 'ug') {
            zm = computeGeostrophicWind(month, xsOpts);
            if (!zm) {
                zm = computeZonalMean(field, month, xsOpts);
            } else {
                effCmap = 'RdBu_r';                  // signed: westerly + / easterly −
                zm.contourInterval = 10;             // m/s, matches u contour
            }
        } else if (xsDiag === 'N2') {
            zm = computeBruntVaisala(month, xsOpts);
            if (!zm) {
                zm = computeZonalMean(field, month, xsOpts);
            } else {
                effCmap = 'magma';
                zm.contourInterval = 1;              // 10⁻⁴ s⁻²
            }
        } else if (xsDiag === 'epflux') {
            zm = computeEPFlux(month, xsOpts);
            if (!zm) {
                zm = computeZonalMean(field, month, xsOpts);
            } else {
                effCmap = 'RdBu_r';                  // ∇·F shading: westerly + / easterly −
                zm.contourInterval = 2;              // m s⁻¹ day⁻¹
            }
        } else if (xsDiag === 'mbudget') {
            zm = buildMBudgetView(month, {
                term: this.state.mbTerm,
                form: this.state.mbForm,
                mode: this.state.mbMode,
                seasonal,
            });
            if (!zm) {
                zm = computeZonalMean(field, month, xsOpts);
            } else {
                effCmap = 'RdBu_r';
                zm.suppressContours = true;
            }
        } else if (xsDiag === 'qbudget') {
            zm = buildQBudgetView(month, {
                term: this.state.mbTerm,
                form: 'q',
                mode: this.state.mbMode,
                seasonal,
            });
            if (!zm) {
                zm = computeZonalMean(field, month, xsOpts);
            } else {
                effCmap = 'RdBu_r';
                zm.suppressContours = true;
            }
        } else if (xsDiag === 'hbudget') {
            zm = buildHBudgetView(month, {
                term: this.state.mbTerm,
                form: 'h',
                mode: this.state.mbMode,
                seasonal,
            });
            if (!zm) {
                zm = computeZonalMean(field, month, xsOpts);
            } else {
                effCmap = 'RdBu_r';
                zm.suppressContours = true;
            }
        } else if (xsArc) {
            // Map view: straight-line-in-(lat, lon) sampling — reads as a
            // straight line on the equirectangular projection. Globe view:
            // great-circle — reads as straight on the sphere. When the user
            // has pinned a midpoint (xsArc.mid set), we sample a three-point
            // curve through it instead — lets the user follow a curved jet
            // streak, an eye-wall track, etc.
            const kind = this.state.viewMode === 'map' ? 'linear' : 'gc';
            const arc = xsArc.mid
                ? threePointArc(xsArc.start, xsArc.mid, xsArc.end, 192, { kind })
                : (kind === 'linear'
                    ? linearLatLonArc(xsArc.start.lat, xsArc.start.lon,
                                      xsArc.end.lat,   xsArc.end.lon, 192)
                    : greatCircleArc(xsArc.start.lat, xsArc.start.lon,
                                     xsArc.end.lat,   xsArc.end.lon, 192));
            zm = computeArcCrossSection(field, month, arc, xsOpts);
            if (!zm) { zm = computeZonalMean(field, month); }
        } else {
            zm = computeZonalMean(field, month);
        }
        // Propagate display options into the renderer: gridlines always on,
        // contours gated by the main Contours toggle for field sections,
        // but forced on in diagnostic modes (ψ and M tell their story via
        // isolines — contour slope IS the pedagogy). Diagnostics that flag
        // suppressContours (M-budget) opt out — their data is too noisy after
        // double-derivative amplification for the fwidth-based overlay.
        zm.showContours = zm.suppressContours
            ? false
            : (zm.isDiagnostic ? true : !!showContours);
        if (zm.contourInterval == null) {
            zm.contourInterval = FIELDS[field]?.contour || 0;
        }
        // User colorbar overrides, applied post-compute so renderCrossSection
        // and the colorbar DOM both reflect the same clamped range.
        if (this.state.xsUserVmin != null) zm.vmin = this.state.xsUserVmin;
        if (this.state.xsUserVmax != null) zm.vmax = this.state.xsUserVmax;
        renderCrossSection(canvas, zm, effCmap);
        this.updateXSectionColorbar(zm, effCmap);
        // Stash for the hover handler — it inverse-maps cursor → (lat, p, value).
        this._xsLastZm = zm;
        const title = document.getElementById('xs-title');
        const hint  = document.getElementById('xs-hint');
        const reset = document.getElementById('xs-reset');
        if (title) {
            if (zm.isDiagnostic) {
                title.textContent = `${zm.name}  (${zm.units})`;
            } else if (zm.kind === 'arc') {
                const km = Math.round(zm.distanceKm).toLocaleString();
                const suffix = zm.type === 'pl' ? '' : `  (${zm.units})`;
                title.textContent = `Arc · ${zm.name} · ${km} km${suffix}`;
            } else {
                const suffix = zm.type === 'pl' ? '' : `  (${zm.units})`;
                title.textContent = `Zonal mean · ${zm.name}${suffix}`;
            }
        }
        if (hint) {
            if (zm.isDiagnostic) {
                // Accurate footer per diagnostic.
                const desc = {
                    psi: 'ψ(φ, p) = (2π a cos φ / g) · ∫₀ᵖ [v] dp',
                    M:   'M = (Ω a cos φ + u) · a cos φ · from zonal-mean u',
                    ug:  '[u_g] = -(g/f) · ∂[z]/∂y · masked |φ| < 5° (f → 0)',
                    N2:  'N² = -(g²p / R T θ) · ∂θ/∂p · static stability',
                    epflux: 'F = (-a cos φ [u′v′], a cos φ f [v′θ′] / ∂[θ]/∂p) — stationary eddies; shading: ∇·F (m s⁻¹ day⁻¹)',
                    mbudget: '∂[M]/∂t = -∇·([v][M]) - ∇·([v*M*]) + torque · stationary eddies only · 1° monthly clim',
                }[xsDiag] || 'Zonal-mean diagnostic';
                hint.innerHTML = desc;
            } else if (zm.kind === 'arc') {
                hint.innerHTML = '<span class="xs-kbd">⇧</span> + drag to redraw';
            } else {
                hint.innerHTML = '<span class="xs-kbd">⇧</span> + drag globe to draw an arc';
            }
        }
        if (reset) reset.hidden = zm.kind !== 'arc';
        // "Unpin midpoint" only makes sense when the user has actually
        // pinned one — hide otherwise so the footer stays lean.
        const resetMid = document.getElementById('xs-reset-mid');
        if (resetMid) {
            resetMid.hidden = !(zm.kind === 'arc' && this.state.xsArc?.mid);
        }
        this.updateArcLine();
    }

    updateXSectionColorbar(zm, cmap) {
        const cb = document.getElementById('xs-cb-canvas');
        if (cb) {
            // Retina-crisp mini bar, same DPR logic as the main canvas.
            const DPR = Math.min(window.devicePixelRatio || 1, 2);
            const cssW = cb.clientWidth || 380;
            const cssH = cb.clientHeight || 10;
            if (cb.width !== cssW * DPR || cb.height !== cssH * DPR) {
                cb.width  = cssW * DPR;
                cb.height = cssH * DPR;
            }
            fillColorbar(cb, cmap);
        }
        const setTxt = (id, text) => {
            const el = document.getElementById(id);
            if (el) el.textContent = text;
        };
        // xs-cb-min / xs-cb-max are <input>s — same override-accent treatment
        // as the main colorbar inputs. Skip .value writes while focused so we
        // don't yank a mid-edit cursor.
        const setInput = (id, text, isOverride) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (document.activeElement !== el) el.value = text;
            el.classList.toggle('is-override', !!isOverride);
        };
        setInput('xs-cb-min', fmtValue(zm.vmin), this.state.xsUserVmin != null);
        setInput('xs-cb-max', fmtValue(zm.vmax), this.state.xsUserVmax != null);
        setTxt('xs-cb-units', zm.units || '');
        const autoBtn = document.getElementById('xs-cb-auto');
        if (autoBtn) autoBtn.classList.toggle('is-active',
            this.state.xsUserVmin != null || this.state.xsUserVmax != null);
    }

    updateArcLine() {
        if (!this.arcGroup) return;
        const a = this.state.xsArc;
        if (!a) { this.arcGroup.visible = false; return; }
        // Same arc shape as the cross-section sampling (see updateField).
        const kind = this.state.viewMode === 'map' ? 'linear' : 'gc';
        const arc = a.mid
            ? threePointArc(a.start, a.mid, a.end, 96, { kind })
            : (kind === 'linear'
                ? linearLatLonArc(a.start.lat, a.start.lon, a.end.lat, a.end.lon, 96)
                : greatCircleArc(a.start.lat, a.start.lon, a.end.lat, a.end.lon, 96));
        const LIFT = 1.015;
        const pts = arc.map(({ lat, lon }) => this.project(lat, lon, LIFT));
        const flat = new Float32Array(pts.length * 3);
        for (let i = 0; i < pts.length; i++) {
            flat[i * 3]     = pts[i].x;
            flat[i * 3 + 1] = pts[i].y;
            flat[i * 3 + 2] = pts[i].z;
        }
        this.arcLine.geometry.dispose();
        this.arcLine.geometry = new LineGeometry();
        this.arcLine.geometry.setPositions(flat);
        this.arcLine.computeLineDistances();
        // Endpoint dots at start / end. The mid dot sits at the pinned
        // midpoint if the user has set one — otherwise at the auto-derived
        // geometric midpoint along the straight arc. Pinned midpoints get
        // a brighter fill to signal "this is user-controlled."
        const midLL = a.mid
            ? a.mid
            : (kind === 'linear'
                ? linearLatLonMidpoint(a.start.lat, a.start.lon, a.end.lat, a.end.lon)
                : greatCircleMidpoint(a.start.lat, a.start.lon, a.end.lat, a.end.lon));
        const s = this.project(a.start.lat, a.start.lon, LIFT);
        const e = this.project(a.end.lat,   a.end.lon,   LIFT);
        const m = this.project(midLL.lat, midLL.lon, LIFT);
        this.arcStartDot.position.copy(s);
        this.arcEndDot.position.copy(e);
        this.arcMidDot.position.copy(m);
        // Pinned midpoint → brighter emerald; auto midpoint → softer amber.
        if (this.arcMidDot.material) {
            this.arcMidDot.material.color.setHex(a.mid ? 0x5FE0A5 : 0xFFE27A);
        }
        // Hide the arc line when the panel is closed, in orbit view, or in
        // any diagnostic mode (all diagnostics are zonal).
        this.arcGroup.visible = this.state.showXSection
                              && this.state.viewMode !== 'orbit'
                              && this.state.xsDiag === 'field';
    }

    updateField() {
        const { field, level, theta, vCoord, month, cmap, decompose: mode, kind, seasonal } = this.state;
        const f = getField(field, {
            month, level, coord: vCoord, theta, kind,
            year: this.state.year,
            customRange: this.state.customRange,
            seasonal,
        });
        this.setLoadingOverlay(!f.isReal);
        // Stash the expected-tiles-for-first-paint snapshot for the overlay
        // progress counter. Computed once per updateField call; stays stable
        // while the tiles stream in. Only needs to be refreshed on pending
        // loads (once painted, overlay is hidden anyway).
        if (!f.isReal) {
            this._expectedTiles = expectedTilesForView(this.state);
        }

        // Decide the effective decomposition for paint. Three transforms
        // can override the user-selected mode:
        //   • ±1σ + non-active reference period → 'anomaly' (Δσ display)
        //   • compareMode → suppress Δσ AND climate-change anomaly so the
        //     swipe IS the comparison (raw vs raw, or zonal vs zonal,
        //     or eddy vs eddy — apples-to-apples on each side)
        //   • ±1σ otherwise → 'total' (decomposing a stddev is meaningless)
        const compareOn = !!this.state.compareMode;
        const wantsStdAnomaly = kind === 'std' && f.kind === 'std'
                             && this.state.referencePeriod !== 'default'
                             && this.state.referencePeriod !== this.state.climatologyPeriod;
        const isStdAnomaly = wantsStdAnomaly && !compareOn;
        let effMode;
        if (kind === 'std') {
            effMode = isStdAnomaly ? 'anomaly' : 'total';
        } else if (compareOn && mode === 'anomaly' && this.state.compareYear == null) {
            // climo-vs-refPeriod or climo-vs-year compare with Anomaly
            // degenerates on the right half (ref − ref = 0), so fall back
            // to raw comparison. year-vs-year compare with Anomaly is
            // meaningful (both sides show departures from the same climo)
            // and flows through the anomaly path below.
            effMode = 'total';
        } else {
            effMode = mode;
        }
        const decomp = this.applyDecomposition(f, effMode);
        // Δσ is a difference field → divergent palette. Plain ±1σ stays magma.
        const effCmap = (kind === 'std' && !isStdAnomaly)
            ? 'magma'
            : (decomp.symmetric ? 'RdBu_r' : cmap);

        // Swipe-compare: paint the right half with a different time slice
        // (a specific year, or the chosen Reference period's climatology).
        // Pool the cmap range so both halves share a scale. Works in any
        // kind (mean / std) and any effMode (total / zonal / eddy). For
        // non-total effMode each side decomposes its own data independently.
        const compareYear = this.state.compareMode ? this.state.compareYear : null;
        const compareRef = this.state.compareMode && compareYear == null
            ? this.compareRefPeriod() : null;
        const compareActive = !!compareRef || compareYear != null;
        let refValues = null;
        if (compareActive) {
            const refField = compareYear != null
                ? getField(field, {
                    month, level, coord: vCoord, theta,
                    kind: 'mean', year: compareYear,   // year tiles are mean-only
                    seasonal,
                })
                : getField(field, {
                    month, level, coord: vCoord, theta,
                    kind, period: compareRef,
                    seasonal,
                });
            if (refField.isReal) {
                let refDec;
                if (effMode === 'total' || !effMode) {
                    refDec = { values: refField.values, vmin: refField.vmin, vmax: refField.vmax };
                } else if (effMode === 'anomaly') {
                    // Year-vs-year anomaly compare. Two baseline modes:
                    //
                    //   referencePeriod = 'best-match' + compareYear set →
                    //     each side uses its OWN best-match 30-yr climo
                    //     (left = bestClimoFor(leftYear), right =
                    //      bestClimoFor(compareYear)). Each half is
                    //     detrended against its own era — more honest for
                    //     events separated by decades, but the two halves
                    //     now reference different baselines.
                    //
                    //   otherwise → SHARED baseline (decomp.annualMean from
                    //     the left side) so both halves measure departures
                    //     from one fixed climo.
                    let rightAnnualMean = decomp.annualMean;
                    if (this.state.referencePeriod === 'best-match'
                        && compareYear != null) {
                        const rightClimoPeriod = bestClimoFor(compareYear).id;
                        const rightClimo = getField(field, {
                            month, level, coord: vCoord, theta,
                            kind: 'mean', period: rightClimoPeriod,
                        });
                        if (rightClimo.isReal) rightAnnualMean = rightClimo.values;
                    }
                    refDec = decompose(
                        refField.values, GRID.nlat, GRID.nlon, 'anomaly',
                        rightAnnualMean,
                        decomp.clamp ? { clamp: decomp.clamp } : {},
                    );
                } else {
                    // zonal / eddy: each side decomposes independently.
                    refDec = decompose(refField.values, GRID.nlat, GRID.nlon, effMode);
                }
                refValues = refDec.values;
                if (this.state.userVmin == null) decomp.vmin = Math.min(decomp.vmin, refDec.vmin);
                if (this.state.userVmax == null) decomp.vmax = Math.max(decomp.vmax, refDec.vmax);
            }
        }

        // Diff style: replace decomp.values with (active − target) and
        // force a symmetric RdBu_r colorbar centered on zero. The swipe
        // reference mesh is hidden by applyCompareMode when style='diff',
        // so only the main map renders — with the 2-D difference field
        // painted as an anomaly.
        let effCmapFinal = effCmap;
        if (compareActive && this.state.compareStyle === 'diff' && refValues) {
            const N = decomp.values.length;
            const diff = new Float32Array(N);
            let absMax = 0;
            for (let i = 0; i < N; i++) {
                const a = decomp.values[i];
                const b = refValues[i];
                if (Number.isFinite(a) && Number.isFinite(b)) {
                    diff[i] = a - b;
                    const d = Math.abs(diff[i]);
                    if (d > absMax) absMax = d;
                } else {
                    diff[i] = NaN;
                }
            }
            decomp.values = diff;
            decomp.symmetric = true;
            decomp.vmin = -absMax;
            decomp.vmax =  absMax;
            effCmapFinal = 'RdBu_r';
            // Don't also paint the reference texture — we're not swiping.
            refValues = null;
        }

        // Manual colorbar overrides — applied after auto-range AND compare
        // pooling so user input wins over everything.
        if (this.state.userVmin != null) decomp.vmin = this.state.userVmin;
        if (this.state.userVmax != null) decomp.vmax = this.state.userVmax;

        // Stash what's currently painted on the globe for hover sampling.
        this._displayedValues = decomp.values;

        fillRGBA(this.imageData.data, decomp.values, {
            vmin: decomp.vmin, vmax: decomp.vmax, cmap: effCmapFinal,
        });
        this.ctx.putImageData(this.imageData, 0, 0);
        this.texture.needsUpdate = true;
        if (this.mapTexture) this.mapTexture.needsUpdate = true;
        if (this.earthTexture) this.earthTexture.needsUpdate = true;

        // Paint the reference period into the second canvas (right half of
        // the swipe). Same cmap + range as the active so the comparison is
        // honest. When compare is off OR no reference is loaded, leave the
        // reference texture as-is (it's hidden by mapMeshRef.visible=false).
        if (refValues) {
            fillRGBA(this.referenceImageData.data, refValues, {
                vmin: decomp.vmin, vmax: decomp.vmax, cmap: effCmap,
            });
            this.referenceCtx.putImageData(this.referenceImageData, 0, 0);
            this.referenceTexture.needsUpdate = true;
            // Both the map plane (referenceTexture) and the globe shell
            // (referenceSphereTexture) wrap the same canvas — flag the
            // sphere variant too so globe-view compare stays in sync.
            if (this.referenceSphereTexture) this.referenceSphereTexture.needsUpdate = true;
        }
        // Stash the reference values so hover lookup can return the right
        // half's value when the cursor is over the reference period.
        this._referenceValues = refValues;

        // Decorated field for contour overlay + colorbar. The heatmap uses
        // the decomposed values (shading the eddy / anomaly / zonal signal),
        // but contours always track the RAW field so the overlay puts the
        // decomposition signal in the context of the total state — standard
        // "shade anomaly, contour total" synoptic practice.
        const fDecorated = {
            ...f,
            values: decomp.values,        // decomposed — used by the colorbar + panel
            rawValues: f.values,          // original tile values — used by contours
            vmin: decomp.vmin,
            vmax: decomp.vmax,
            // Δσ display reuses the anomaly machinery but is conceptually
            // a separate mode — tag it explicitly so the colorbar title can
            // say "Δσ" instead of "anomaly".
            decomposeMode: isStdAnomaly ? 'std-anomaly' : mode,
            isSymmetric: decomp.symmetric,
            effCmap: effCmapFinal,
        };
        this.updateContours(fDecorated);
        this.applyCoastlineContrast(effCmapFinal);
        this.updateStatus(f);   // status reflects raw tile, not the transform
        this.emit('field-updated', { field: fDecorated });
    }

    setLoadingOverlay(visible) {
        let el = document.getElementById('globe-loading');
        if (!el) {
            el = document.createElement('div');
            el.id = 'globe-loading';
            el.innerHTML = '<div class="globe-loading-card">'
                + '<div class="globe-loading-spinner"></div>'
                + '<div class="globe-loading-text">Loading ERA5 tiles…</div>'
                + '<div class="globe-loading-progress"></div>'
                + '</div>';
            this.mount.appendChild(el);
        }
        el.classList.toggle('visible', !!visible);
    }

    /** "X of Y tiles loaded" progress for the loading overlay.
     *  Y starts at expectedTilesForView (first-paint canonical count),
     *  but can grow upward if actual in-flight (from era5.js tilesInBatch)
     *  exceeds the expected floor — e.g. wind-overlay tiles or background
     *  cross-month aggregation kicking in alongside the first paint.
     *  Y never shrinks, so the counter doesn't feel like it's walking back.
     *  X is (Y − pending) clamped, so it monotonically rises.
     */
    setLoadingProgress({ pending, total }) {
        const el = document.getElementById('globe-loading');
        if (!el) return;
        const line = el.querySelector('.globe-loading-progress');
        if (!line) return;
        const expected = this._expectedTiles || 0;
        // Anchor the high-water mark so Y can only grow. Cleared when the
        // batch idles (pending hits 0).
        if (pending === 0) {
            this._progressHighWater = 0;
        } else {
            this._progressHighWater = Math.max(this._progressHighWater || 0,
                                               expected, total || 0);
        }
        const y = this._progressHighWater;
        if (pending > 0 && y > 0) {
            const done = Math.max(0, y - pending);
            line.textContent = `${done} of ${y} tiles loaded`;
        } else {
            line.textContent = '';
        }
    }

    applyDecomposition(f, mode) {
        if (mode === 'total' || !mode) {
            // Honour the cross-month aggregated vmin/vmax that getField
            // already computed (era5.js aggregateStats for raw fields,
            // aggregateRangeByPrefix for derived). Recomputing per-month range
            // via statsOf would shift the colorbar on every month-scrub.
            // symmetric:false here so effCmap respects the user's cmap choice;
            // the symmetric range itself is enforced upstream in getField for
            // fields with `symmetric: true` in FIELDS metadata.
            return {
                values: f.values,
                vmin: f.vmin, vmax: f.vmax,
                symmetric: false,
                empty: false,
            };
        }

        // Anomaly mode reference: either climate-change (same month from a
        // different base period) or seasonal (12-month annual mean of self).
        // For climate-change mode the per-month aggregator needs the matching
        // month's reference, so we keep both the current-month array (for the
        // inline decompose call) and a per-month fetcher (for the aggregator).
        let annualMean = null;
        let annualMeanForAgg = null;
        // zscore needs the same machinery as anomaly to find the climo mean —
        // it just additionally divides by σ inside decompose().
        if (mode === 'anomaly' || mode === 'zscore') {
            if (this.state.vCoord === 'theta') {
                // θ-mode anomaly, unified logic:
                //
                //   refPeriod set + year set → year-vs-refPeriod-climo
                //     (e.g. "2015 Jul 330K PV minus 1961-1990 Jul 330K PV mean")
                //   refPeriod set + no year → climate-change anomaly
                //     (e.g. "1991-2020 Jul mean minus 1961-1990 Jul mean on 330K")
                //   no refPeriod + year set → year-vs-active-climo
                //     (e.g. "2015 Jul 330K PV minus 1991-2020 Jul 330K PV mean")
                //   no refPeriod + no year → self-anomaly
                //     (value minus 12-month annual mean of active climo on θ)
                //
                // Reference-source logic: same-month reference when either
                // year or refPeriod is in play (pedagogically: "departure
                // from THIS MONTH's normal"). 12-month mean only for pure
                // self-anomaly (classic "seasonal departure" definition).
                const theta = this.state.theta;
                const fieldName = this.state.field;
                const refPeriod = this.state.referencePeriod;
                const fieldClamp = FIELDS[fieldName]?.clamp ?? null;
                const hasRefPeriod = refPeriod !== 'default'
                    && refPeriod !== this.state.climatologyPeriod;
                const hasYear = this.state.year != null;
                const hasComposite = !!this.state.customRange;

                let annualMeanTheta = null;
                let annualMeanForAgg = null;

                if (hasRefPeriod || hasYear || hasComposite) {
                    // Same-month reference. The reference period is either
                    // the chosen alt-climo (refPeriod) or the active default.
                    // When both year and refPeriod are set, refPeriod wins
                    // (deeper baseline for the year-anomaly).
                    // 'best-match' in year mode resolves to bestClimoFor(year).
                    let refArgs;
                    if (refPeriod === 'best-match' && hasYear) {
                        refArgs = { period: bestClimoFor(this.state.year).id };
                    } else if (hasRefPeriod && refPeriod !== 'best-match') {
                        refArgs = { period: refPeriod };
                    } else {
                        refArgs = { /* active climo — no extras */ };
                    }
                    const refField = getField(fieldName, {
                        month: this.state.month, coord: 'theta', theta, ...refArgs,
                    });
                    annualMeanTheta = refField.isReal ? refField.values : null;
                    annualMeanForAgg = (m) => {
                        const rf = getField(fieldName, {
                            month: m, coord: 'theta', theta, ...refArgs,
                        });
                        return rf.isReal ? rf.values : null;
                    };
                } else {
                    // Pure self-anomaly: 12-month annual mean of active climo.
                    const getMonthClimoIsen = (m) => {
                        const g = getField(fieldName, { month: m, coord: 'theta', theta });
                        return g.isReal ? g.values : null;
                    };
                    annualMeanTheta = annualMeanFrom(
                        getMonthClimoIsen, GRID.nlat, GRID.nlon);
                    annualMeanForAgg = annualMeanTheta;
                }

                // θ-coord doesn't ship std tiles, so zscore on θ silently
                // degrades to the regular anomaly view (better than empty).
                const isenMode = (mode === 'zscore') ? 'anomaly' : mode;
                const current = decompose(f.values, GRID.nlat, GRID.nlon, isenMode,
                                          annualMeanTheta, { clamp: fieldClamp });
                if (!current.empty) {
                    const range = aggregatedDecompositionRange(
                        isenMode,
                        (m) => {
                            // Cache-peek before getField — same rationale as
                            // the pressure-coord call site below: avoids
                            // leaking ~11 extra fetches that _pvComputeRaw /
                            // buildThetaCube would kick off when bailing.
                            const args = { month: m, coord: 'theta', theta,
                                           year: this.state.year };
                            if (!hasCachedIngredients(fieldName, args)) return null;
                            const g = getField(fieldName, args);
                            return g.isReal ? g : null;
                        },
                        GRID.nlat, GRID.nlon, annualMeanForAgg,
                        { symmetric: !!FIELDS[fieldName]?.symmetric, clamp: fieldClamp },
                    );
                    if (range) { current.vmin = range.vmin; current.vmax = range.vmax; }
                    // Expose the climatology baseline so swipe-compare can
                    // subtract it from the right-hand side too (year-vs-year
                    // anomaly: both halves are departures from the same climo).
                    current.annualMean = annualMeanTheta;
                    current.clamp = fieldClamp;
                    return current;
                }
                // Couldn't compute (no cached months yet) — fall back to total
                // so the map keeps painting while tiles load in the background.
                return { values: f.values, vmin: f.vmin, vmax: f.vmax, symmetric: false, empty: false };
            }
            const meta = FIELDS[this.state.field] || {};
            const useLevel = meta.type === 'pl' ? this.state.level : null;
            const refPeriod = this.state.referencePeriod;
            // Year- or composite-anomaly: with a specific year OR a custom
            // year list / range selected, anomaly = the displayed tile
            // (one year, or the composite mean) minus the CLIMATOLOGY MEAN
            // for the same month. The climatology comes from the chosen
            // reference period (default = active 30-year window).
            // Pedagogical: "how much warmer was Jul 2015 than the
            // 1991-2020 Jul mean?" or "how much warmer is Oct SST during
            // El Niño events than the Oct climatology?" Without the
            // composite branch here, the composite fell through to the
            // self-anomaly path (12-month mean), mixing the seasonal
            // cycle into what should be an event anomaly.
            if (this.state.year != null || this.state.customRange) {
                // Year- or composite-anomaly. Works for both raw and derived
                // fields — the climatology reference is fetched without
                // year/customRange so getField routes derived fields through
                // their normal climatology compute (e.g. DLS climo from
                // climatology u/v at 200+850, then |V_top − V_bot|).
                //
                // Reference-period resolution:
                //   'best-match' + single year → bestClimoFor(year).id
                //   'default'                  → active 30-yr window
                //   explicit window            → that window
                let fixedClimoPeriod;
                if (refPeriod === 'best-match' && this.state.year != null) {
                    fixedClimoPeriod = bestClimoFor(this.state.year).id;
                } else if (refPeriod !== 'default' && refPeriod !== 'best-match') {
                    fixedClimoPeriod = refPeriod;
                } else {
                    fixedClimoPeriod = 'default';
                }
                // Sliding-climo: when composite is active and the user has
                // opted in, each event year subtracts its best-match 30-yr
                // climatology instead of the single active period. The
                // event-weighted climo is mathematically equivalent to
                // "subtract per-year climo, then average" (since the
                // anomaly operator is linear) but only requires one tile
                // per unique window — so a 9-event composite spanning 3
                // climo windows fetches 3 climo tiles, not 9.
                // 'best-match' in year mode is handled above via the
                // fixedClimoPeriod path; sliding only applies to composites.
                const useSliding = this.state.slidingClimo
                    && this.state.customRange
                    && this.state.year == null
                    && Array.isArray(this.state.customRange.years)
                    && (refPeriod === 'default' || refPeriod === 'best-match');
                const refForMonth = (m) => {
                    if (useSliding) {
                        const w = this._weightedClimoForEvents(
                            this.state.field, m, this.state.level,
                            this.state.vCoord, this.state.theta,
                            this.state.customRange.years,
                        );
                        if (w) return w;
                        // Fall through to fixed-climo if any sliding tile
                        // hasn't loaded — keeps the display useful while
                        // the new period manifests fetch in the background.
                    }
                    const rf = getField(this.state.field, {
                        month: m,
                        level: this.state.level,
                        coord: this.state.vCoord,
                        theta: this.state.theta,
                        kind: 'mean',
                        period: fixedClimoPeriod,
                    });
                    return rf.isReal ? rf.values : null;
                };
                annualMean = refForMonth(this.state.month);
                annualMeanForAgg = refForMonth;
            } else if (refPeriod !== 'default' && !meta.derived) {
                // Climate-change anomaly: same month from reference period.
                // `kind` is propagated so when Display=±1σ we fetch the ref
                // period's std tile (giving Δσ) instead of its mean tile.
                const refField = getField(this.state.field, {
                    month: this.state.month,
                    level: this.state.level,
                    coord: this.state.vCoord,
                    theta: this.state.theta,
                    kind: this.state.kind,
                    period: refPeriod,
                });
                annualMean = refField.isReal ? refField.values : null;
                // Per-month reference for the aggregator — without this every
                // pooled month would subtract January's reference, mixing the
                // 30 K seasonal cycle into the climate-change colorbar range.
                annualMeanForAgg = (m) => {
                    const rf = getField(this.state.field, {
                        month: m,
                        level: this.state.level,
                        coord: this.state.vCoord,
                        theta: this.state.theta,
                        kind: this.state.kind,
                        period: refPeriod,
                    });
                    return rf.isReal ? rf.values : null;
                };
            } else {
                // Derived fields (wspd, mse, dls) need the derived field
                // evaluated per-month to form the annual mean — their
                // component tiles aren't the right source. Route through
                // getField which hits computeDerived and fills the per-month
                // cache opportunistically.
                annualMean = meta.derived === true
                    ? annualMeanFrom(
                        (m) => {
                            const d = getField(this.state.field, {
                                month: m, level: useLevel,
                                coord: this.state.vCoord,
                                theta: this.state.theta,
                            });
                            return d.isReal ? d.values : null;
                        },
                        GRID.nlat, GRID.nlon,
                    )
                    : annualMeanFrom(
                        (m) => cachedMonth(this.state.field, m, useLevel),
                        GRID.nlat, GRID.nlon,
                    );
                // Self-anomaly: same 12-month mean for every iteration.
                annualMeanForAgg = annualMean;
            }
        }

        const { field, level, vCoord, theta } = this.state;
        const fieldClamp = FIELDS[field]?.clamp ?? null;
        // For standardized-anomaly mode, also fetch the same-month climo σ
        // so decompose() can divide. Use the ACTIVE climo period's std
        // tile (reference period if the user has set one). When std isn't
        // available (derived fields), decompose returns empty:true and
        // the display falls back to raw values — UI surfaces this in the
        // colorbar subtitle below.
        let currentStdTile = null;
        let stdTileForMonth = null;
        if (mode === 'zscore') {
            // σ denominator: 'best-match' is a per-year concept for the
            // NUMERATOR (each year subtracts its closest 30-yr climo
            // mean) but there's no 'best-match' tile tree — the σ for
            // a composite can't be composed coherently across multiple
            // 30-yr windows. Fall back to the active climatology's σ.
            // Explicit periods (e.g. '1961-1990') keep sourcing their
            // own σ tiles. Without this fallback, the std fetch 404s
            // (period = 'best-match' → no manifest), decompose returns
            // empty: true, and the globe silently paints raw values.
            const refPeriod = this.state.referencePeriod;
            const climoPeriod = (refPeriod !== 'default' && refPeriod !== 'best-match')
                ? refPeriod : 'default';
            const stdCall = (m) => getField(field, {
                month: m, level, coord: vCoord, theta,
                kind: 'std', period: climoPeriod,
            });
            const stdNow = stdCall(this.state.month);
            currentStdTile = (stdNow.isReal && !stdNow.stdUnavailable)
                ? stdNow.values : null;
            stdTileForMonth = (m) => {
                const sf = stdCall(m);
                return (sf.isReal && !sf.stdUnavailable) ? sf.values : null;
            };
        }
        const current = decompose(f.values, GRID.nlat, GRID.nlon, mode, annualMean,
                                  { clamp: fieldClamp, stdTile: currentStdTile });

        // Cross-month aggregation for stable colorbar — without this the range
        // shifts every time the user scrubs months because the local extrema
        // change. We pull from getField (uses cached tiles for raw fields,
        // existing _wspdCache/_mseCache/_pvCache entries for derived).
        const range = aggregatedDecompositionRange(
            mode,
            (m) => {
                // Peek the cache first — if month m's ingredients aren't
                // all present, skip rather than calling getField (which
                // would trigger fetches we don't need and that leak into
                // the first-paint load window). Stable-colorbar aggregation
                // remains correct: it uses whatever's cached, refreshes
                // whenever a new tile lands via the onFieldLoaded re-render.
                const args = { month: m, level, coord: vCoord, theta,
                               year: this.state.year, customRange: this.state.customRange };
                if (!hasCachedIngredients(field, args)) return null;
                const fm = getField(field, args);
                return fm.isReal ? fm : null;
            },
            GRID.nlat, GRID.nlon, annualMeanForAgg,
            { symmetric: !!FIELDS[field]?.symmetric, clamp: fieldClamp,
              stdTileForMonth },
        );
        if (range) {
            current.vmin = range.vmin;
            current.vmax = range.vmax;
        }
        // Standardized-anomaly default range: hard-cap at ±5 σ. Real
        // climatological z-scores almost never exceed ±5; anything beyond
        // is dominated by division-by-near-zero in low-variance cells
        // (e.g. tropical SST σ → 0.1 K → a 50 K artifact in a single
        // pixel pulls the percentile clamp to ±500). The user can still
        // override with the cb-min/cb-max inputs to see extremes.
        if (mode === 'zscore') {
            current.vmin = -5;
            current.vmax =  5;
        }
        // Expose the climatology baseline (pressure-coord branch) so swipe-
        // compare can apply the same anomaly transform to the right half.
        current.annualMean = annualMean;
        current.clamp = fieldClamp;
        return current;
    }

    updateContours(f) {
        if (!this.contours) return;

        // Pick the source for the contour overlay: either the displayed
        // field (legacy default) or an independent overlay field. Same
        // time-slice (year / customRange / climo period / θ surface) as
        // the displayed field so the comparison is on equal footing.
        const overlayName = this.state.contourField;
        const useOverlay = overlayName && overlayName !== this.state.field;
        let contourMeta, contourValues;
        if (useOverlay) {
            contourMeta = FIELDS[overlayName] || {};
            const ov = getField(overlayName, {
                month: this.state.month,
                level: contourMeta.type === 'pl' ? this.state.level : undefined,
                coord: this.state.vCoord,
                theta: this.state.theta,
                kind: 'mean',
                year: this.state.year,
                customRange: this.state.customRange,
            });
            // While the overlay tile is still loading, hide the contours so
            // we don't paint a stale or all-NaN field. onFieldLoaded will
            // re-fire updateField (which calls us) when the tile arrives.
            if (!ov.isReal) {
                this.contours.setVisible(false);
                this.contourLabels?.clear();
                return;
            }
            contourValues = ov.values;
        } else {
            contourMeta = FIELDS[this.state.field] || {};
            // Contour source for "same as displayed": the RAW field values
            // always. When a decomposition is on, the isolines show the
            // total state overlaid on the shaded eddy / anomaly — standard
            // textbook practice.
            contourValues = f.rawValues || f.values;
        }
        const interval = contourMeta.contour;
        if (!interval) {
            this.contours.setVisible(false);
            this.contourLabels?.clear();
            return;
        }

        this.contours.setData(contourValues);
        this.contours.setInterval(interval);
        // Zero-line emphasis follows the contour-source field's cmap so
        // u/v / vorticity / divergence / etc still get the zero-isoline
        // highlight whether they're shaded or contoured.
        const divergent = contourMeta.cmap === 'RdBu_r';
        this.contours.setEmphasis(0, divergent);
        // Ink luminance still tracks the SHADED background so contours
        // stay legible against whatever colormap is active for the heatmap.
        const effCmap = f.effCmap || this.state.cmap;
        const darkBg = meanLuminance(effCmap) < 0.45;
        this.contours.setInk(darkBg ? 0xf4faf7 : 0x0a1712);
        this.contours.setOpacity(darkBg ? 0.70 : 0.85);
        this.contours.setVisible(this.state.showContours);

        if (this.contourLabels) {
            this.contourLabels.update(
                contourValues, GRID.nlat, GRID.nlon, interval,
                { viewMode: this.state.viewMode },
            );
            this.contourLabels.setVisible(this.state.showContours);
        }
    }

    updateStatus(f) {
        const el = document.getElementById('sidebar-status');
        if (!el) return;
        if (f.isReal) {
            el.innerHTML = '<strong>ERA5 · 1991–2020</strong>' +
                'Monthly-mean climatology at 1° grid, served from <code>gs://gc-atlas-era5</code>.';
        } else {
            el.innerHTML = '<strong>Loading…</strong>' +
                'Fetching the ERA5 tile for this field. It should render in a moment.';
        }
    }

    // ── mini event bus ────────────────────────────────────────────────
    on(name, fn)     { (this.listeners[name] ||= []).push(fn); }
    emit(name, data) { (this.listeners[name] || []).forEach(fn => fn(data)); }

    // ── UI wiring ────────────────────────────────────────────────────
    bindUI() {
        const fieldSel = document.getElementById('field-select');
        // Build a Map of group → entries to emit one <optgroup> per category,
        // preserving insertion order so the dropdown reads as a guided tour
        // (Dynamics → Moisture → Derived → Surface → fluxes → TOA).
        const groups = new Map();
        for (const [key, meta] of Object.entries(FIELDS)) {
            if (meta.hidden) continue;   // overlay-only sources (u10, v10, …)
            const g = meta.group || 'Other';
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push([key, meta]);
        }
        for (const [groupName, entries] of groups) {
            const og = document.createElement('optgroup');
            og.label = groupName;
            for (const [key, meta] of entries) {
                og.appendChild(Object.assign(document.createElement('option'),
                    { value: key, textContent: meta.name }));
            }
            fieldSel.appendChild(og);
        }
        fieldSel.value = this.state.field;
        fieldSel.addEventListener('change', () => {
            const field = fieldSel.value;
            const meta = FIELDS[field];
            const patch = { field };
            if (meta.cmap) patch.cmap = meta.cmap;
            // Fields flagged thetaOnly (e.g. PV) force θ-coord. Snap
            // state.theta to the field's defaultLevel (interpreted as K)
            // when we switch into θ-coord this way.
            if (isThetaOnly(field)) {
                patch.vCoord = 'theta';
                if (meta.defaultLevel) patch.theta = meta.defaultLevel;
            } else if (meta.type === 'pl' && meta.defaultLevel && this.state.vCoord === 'pressure') {
                patch.level = meta.defaultLevel;
            }
            this.setState(patch);
            document.getElementById('cmap-select').value = this.state.cmap;
            this.refreshVCoordUI();
        });

        const vcoordGroup = document.getElementById('vcoord-toggle');
        if (vcoordGroup) {
            vcoordGroup.querySelectorAll('button').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const vCoord = btn.dataset.coord;
                    if (vCoord === this.state.vCoord) return;
                    // Block switching away from θ if the current field demands it.
                    if (vCoord === 'pressure' && isThetaOnly(this.state.field)) return;
                    this.setState({ vCoord });
                    this.refreshVCoordUI();
                });
            });
        }

        const levelSel = document.getElementById('level-select');
        this.populateLevelSelect();
        levelSel.addEventListener('change', () => {
            const v = +levelSel.value;
            if (this.state.vCoord === 'theta') this.setState({ theta: v });
            else this.setState({ level: v });
        });

        const monthSel = document.getElementById('month-select');
        MONTHS.forEach((m, i) => {
            monthSel.appendChild(Object.assign(document.createElement('option'),
                { value: i + 1, textContent: m }));
        });
        monthSel.value = this.state.month;
        const monthSlider = document.getElementById('month-slider');
        if (monthSlider) monthSlider.value = this.state.month;

        const syncMonthUI = (m) => {
            monthSel.value = m;
            if (monthSlider) monthSlider.value = m;
        };
        this._syncMonthUI = syncMonthUI;

        monthSel.addEventListener('change', () => {
            this.stopPlay();
            const m = +monthSel.value;
            syncMonthUI(m);
            this.setState({ month: m });
        });
        if (monthSlider) {
            monthSlider.addEventListener('input', () => {
                this.stopPlay();
                const m = +monthSlider.value;
                syncMonthUI(m);
                this.setState({ month: m });
            });
        }

        const playBtn = document.getElementById('month-play');
        playBtn.addEventListener('click', () => {
            if (this.playTimer) this.stopPlay();
            else                this.startPlay();
        });

        const cmapSel = document.getElementById('cmap-select');
        for (const c of COLORMAPS) {
            cmapSel.appendChild(Object.assign(document.createElement('option'),
                { value: c, textContent: c }));
        }
        cmapSel.value = this.state.cmap;
        cmapSel.addEventListener('change', () => this.setState({ cmap: cmapSel.value }));

        // Manual colorbar range — type a number into either input to override,
        // or press the ↺ Auto button to clear. Empty input = clear that side.
        const cbMinEl = document.getElementById('cb-min');
        const cbMaxEl = document.getElementById('cb-max');
        const cbAutoEl = document.getElementById('cb-auto');
        const parseCbInput = (raw) => {
            const s = String(raw ?? '').trim();
            if (s === '' || s === '—') return null;
            const n = Number(s);
            return Number.isFinite(n) ? n : null;
        };
        const commitCbRange = () => {
            let userVmin = parseCbInput(cbMinEl?.value);
            let userVmax = parseCbInput(cbMaxEl?.value);
            // If both set and reversed, swap so min < max — fillRGBA's
            // (v - vmin) / (vmax - vmin) goes negative otherwise and the
            // whole globe collapses to the cmap's first colour.
            if (userVmin != null && userVmax != null && userVmin > userVmax) {
                [userVmin, userVmax] = [userVmax, userVmin];
            }
            this.setState({ userVmin, userVmax });
        };
        cbMinEl?.addEventListener('change', commitCbRange);
        cbMaxEl?.addEventListener('change', commitCbRange);
        // Enter to commit immediately (change fires on blur otherwise).
        for (const el of [cbMinEl, cbMaxEl]) {
            el?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
            });
        }
        cbAutoEl?.addEventListener('click', () => {
            this.setState({ userVmin: null, userVmax: null });
        });

        // Cross-section colorbar: same override pattern as the main colorbar
        // but feeds xsUserVmin / xsUserVmax and re-triggers updateXSection.
        const xsCbMinEl  = document.getElementById('xs-cb-min');
        const xsCbMaxEl  = document.getElementById('xs-cb-max');
        const xsCbAutoEl = document.getElementById('xs-cb-auto');
        const commitXsCbRange = () => {
            let xsUserVmin = parseCbInput(xsCbMinEl?.value);
            let xsUserVmax = parseCbInput(xsCbMaxEl?.value);
            if (xsUserVmin != null && xsUserVmax != null && xsUserVmin > xsUserVmax) {
                [xsUserVmin, xsUserVmax] = [xsUserVmax, xsUserVmin];
            }
            this.setState({ xsUserVmin, xsUserVmax });
        };
        xsCbMinEl?.addEventListener('change', commitXsCbRange);
        xsCbMaxEl?.addEventListener('change', commitXsCbRange);
        for (const el of [xsCbMinEl, xsCbMaxEl]) {
            el?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
            });
        }
        xsCbAutoEl?.addEventListener('click', () => {
            this.setState({ xsUserVmin: null, xsUserVmax: null });
        });

        document.getElementById('toggle-coastlines').addEventListener('change', (e) => {
            this.setState({ showCoastlines: e.target.checked });
        });
        document.getElementById('toggle-graticule').addEventListener('change', (e) => {
            this.setState({ showGraticule: e.target.checked });
        });
        document.getElementById('toggle-contours').addEventListener('change', (e) => {
            this.setState({ showContours: e.target.checked });
            const row = document.getElementById('contour-field-row');
            if (row) row.hidden = !e.target.checked;
        });
        // Populate the contour-overlay dropdown with every field that has
        // a `contour:` interval defined. Same field-grouping as the main
        // selector so the optgroups read consistently.
        const contourSel = document.getElementById('contour-field-select');
        if (contourSel) {
            const groups = new Map();
            for (const [key, meta] of Object.entries(FIELDS)) {
                if (meta.hidden || meta.contour == null) continue;
                const g = meta.group || 'Other';
                if (!groups.has(g)) groups.set(g, []);
                groups.get(g).push([key, meta]);
            }
            for (const [groupName, entries] of groups) {
                const og = document.createElement('optgroup');
                og.label = groupName;
                for (const [key, meta] of entries) {
                    og.appendChild(Object.assign(document.createElement('option'),
                        { value: key, textContent: meta.name }));
                }
                contourSel.appendChild(og);
            }
            contourSel.addEventListener('change', (e) => {
                this.setState({ contourField: e.target.value || null });
            });
        }
        document.getElementById('toggle-sun').addEventListener('change', (e) => {
            this.setState({ showSun: e.target.checked });
        });
        // Wind overlay mode: segmented control (Off / Particles / Barbs)
        document.querySelectorAll('[data-wind-mode]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const mode = btn.getAttribute('data-wind-mode');
                document.querySelectorAll('[data-wind-mode]').forEach((b) =>
                    b.classList.toggle('active', b === btn));
                this.setState({ windMode: mode });
            });
        });
        // Decomposition mode: Total / Zonal / Eddy / Anomaly
        document.querySelectorAll('[data-decompose]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const mode = btn.getAttribute('data-decompose');
                document.querySelectorAll('[data-decompose]').forEach((b) =>
                    b.classList.toggle('active', b === btn));
                this.setState({ decompose: mode });
            });
        });
        // Anomaly reference period — chooses what Anomaly mode compares against.
        const refSel = document.getElementById('ref-period-select');
        if (refSel) {
            refSel.value = this.state.referencePeriod;
            refSel.addEventListener('change', () => {
                this.setState({ referencePeriod: refSel.value });
            });
        }
        // Climatology period — switches the active 30-year window for Mean,
        // ±1σ, and decomposition references everywhere on the page.
        const climoSel = document.getElementById('climo-period-select');
        if (climoSel) {
            climoSel.value = this.state.climatologyPeriod;
            climoSel.addEventListener('change', () => {
                this.setState({ climatologyPeriod: climoSel.value });
            });
        }
        // Year picker — null = climatology mean (existing tile trees);
        // a specific year (e.g. 2003) routes to data/tiles_per_year/ for
        // that single-year snapshot. Mutually exclusive with the
        // climatology dropdown semantically — when a year is set, the
        // climatology-period control is greyed out (no meaning when
        // showing a single year's tile).
        // Time-mode toggle: Climatology vs Single year vs Custom range.
        //   Climatology mode → Period dropdown (active 30-year window)
        //   Single year mode → slider over the per-year manifest's years
        //   Custom range  → [start, end] year inputs + Compute button
        // Each mode clears the state of the others so only one is active.
        const timeModeButtons = document.querySelectorAll('#time-mode-toggle button');
        const climoOptions    = document.getElementById('time-climo-options');
        const yearOptions     = document.getElementById('time-year-options');
        const rangeOptions    = document.getElementById('time-range-options');
        const yearSlider      = document.getElementById('year-slider');
        const yearDisplay     = document.getElementById('year-display');
        const setTimeMode = (mode) => {
            timeModeButtons.forEach(b =>
                b.classList.toggle('active', b.dataset.timeMode === mode));
            if (climoOptions) climoOptions.hidden = (mode !== 'climo');
            if (yearOptions)  yearOptions.hidden  = (mode !== 'year');
            if (rangeOptions) rangeOptions.hidden = (mode !== 'range');
        };
        timeModeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.timeMode;
                setTimeMode(mode);
                if (mode === 'climo') {
                    const patch = {};
                    if (this.state.year != null) patch.year = null;
                    if (this.state.customRange) patch.customRange = null;
                    if (Object.keys(patch).length) this.setState(patch);
                } else if (mode === 'year') {
                    const patch = { customRange: null };
                    const y = yearSlider ? Number(yearSlider.value) : null;
                    if (Number.isFinite(y) && y !== this.state.year) patch.year = y;
                    this.setState(patch);
                } else if (mode === 'range') {
                    // Don't auto-compute; user clicks the button to kick it.
                    if (this.state.year != null) this.setState({ year: null });
                }
            });
        });
        // Custom-range inputs + compute button. We DON'T auto-compute on
        // input change (would fire a potentially large prefetch with every
        // keystroke). User clicks "Compute mean" to trigger — sets
        // state.customRange, which routes through composeCustomRangeMean
        // and prefetches the needed per-year tiles.
        const rangeStart  = document.getElementById('range-start');
        const rangeEnd    = document.getElementById('range-end');
        const rangeBtn    = document.getElementById('range-compute-btn');
        const rangeLabel  = document.getElementById('range-compute-label');
        const rangeStatus = document.getElementById('range-status');
        const updateRangeBtnLabel = () => {
            if (!rangeBtn || !rangeLabel || !rangeStart || !rangeEnd) return;
            const s = Number(rangeStart.value), e = Number(rangeEnd.value);
            if (!Number.isFinite(s) || !Number.isFinite(e) || s > e) {
                rangeLabel.textContent = 'Enter a valid range';
                rangeBtn.disabled = true;
                return;
            }
            rangeBtn.disabled = false;
            const active = this.state.customRange;
            const matches = active && active.start === s && active.end === e;
            rangeLabel.textContent = matches
                ? `Active · ${s}–${e} (${e - s + 1} yrs)`
                : `Compute ${s}–${e} mean (${e - s + 1} yrs)`;
            rangeBtn.classList.toggle('is-done', !!matches);
        };
        rangeStart?.addEventListener('input', updateRangeBtnLabel);
        rangeEnd  ?.addEventListener('input', updateRangeBtnLabel);
        rangeBtn  ?.addEventListener('click', () => {
            const s = Number(rangeStart.value), e = Number(rangeEnd.value);
            if (!Number.isFinite(s) || !Number.isFinite(e) || s > e) return;
            // Brief spinner pulse — the prefetch fans out async so the
            // button would otherwise look unresponsive even though tiles
            // are streaming in.
            rangeBtn.classList.add('is-computing');
            setTimeout(() => rangeBtn.classList.remove('is-computing'), 900);
            // Prefetch the per-year tiles for every year in range at the
            // current (field, level). They land asynchronously and the
            // onFieldLoaded listener re-paints as each arrives.
            for (let y = s; y <= e; y++) {
                prefetchField(this.state.field, {
                    level: this.state.level,
                    period: 'per_year',
                    year: y,
                });
            }
            if (rangeStatus) rangeStatus.textContent =
                `Fetching ${e - s + 1} years × 12 months of ${this.state.field}… the globe will paint when all tiles arrive.`;
            this.setState({ customRange: { start: s, end: e }, year: null });
            updateRangeBtnLabel();
        });
        updateRangeBtnLabel();
        // Composite builder: parametric event-year composites driven by a
        // climate index + comparator + threshold. Applying a composite
        // routes through state.customRange = {years, label, ...} so the
        // rest of the decomposition / compare machinery treats it exactly
        // like a custom year range.
        this._bindCompositeBuilder();
        if (yearSlider) {
            // 'input' fires continuously during drag, so the globe scrubs
            // through years live (cache hits make subsequent scrubs instant).
            yearSlider.addEventListener('input', () => {
                const year = Number(yearSlider.value);
                if (yearDisplay) yearDisplay.textContent = String(year);
                this.setState({ year });
            });
            // Arrow keys when the slider is focused are native (range input).
        }
        // Initial mode reflects state.year on load (null = Climatology).
        setTimeMode(this.state.year != null ? 'year' : 'climo');
        // Refresh the reference-period dropdown's label/disabled state once
        // on load so it reflects the initial year + active climatology.
        this.refreshRefPeriodLabels();
        // Swipe-compare toggle (Map view) — drives the right-half overlay.
        // Auto-switches to Map view when enabled, and auto-picks 1961–1990
        // as the reference period if the user hasn't set one, so the right
        // half is never blank on first toggle.
        const compareToggle = document.getElementById('toggle-compare');
        const compareModeButtons = document.querySelectorAll('#compare-mode-toggle button');
        const compareYearOpts    = document.getElementById('compare-year-options');
        const compareYearSlider  = document.getElementById('compare-year-slider');
        const compareYearDisplay = document.getElementById('compare-year-display');
        const setCompareMode = (mode) => {
            compareModeButtons.forEach(b =>
                b.classList.toggle('active', b.dataset.compareMode === mode));
            if (compareYearOpts) compareYearOpts.hidden = (mode !== 'year');
        };
        // Compare-style segmented toggle (Swipe vs Diff).
        const compareStyleButtons = document.querySelectorAll('#compare-style-toggle button');
        compareStyleButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                const style = btn.dataset.compareStyle;
                compareStyleButtons.forEach(b =>
                    b.classList.toggle('active', b === btn));
                this.setState({ compareStyle: style });
            });
        });
        compareModeButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.compareMode;
                setCompareMode(mode);
                if (mode === 'ref') {
                    // Drop compareYear; existing referencePeriod path takes
                    // over for the right-half target.
                    if (this.state.compareYear != null) this.setState({ compareYear: null });
                    // If no ref is currently set, auto-pick one so the right
                    // half doesn't go blank.
                    if (this.state.compareMode && !this.compareRefPeriod()
                        && this.state.climatologyPeriod !== '1961-1990') {
                        this.setState({ referencePeriod: '1961-1990' });
                        const refSel = document.getElementById('ref-period-select');
                        if (refSel) refSel.value = '1961-1990';
                    }
                } else {
                    // Year mode: use the slider's current value. If the
                    // slider hasn't been initialized yet, fall back to a
                    // sensible default.
                    const y = compareYearSlider ? Number(compareYearSlider.value)
                                                : this.state.compareYear;
                    if (Number.isFinite(y) && y !== this.state.compareYear) {
                        this.setState({ compareYear: y });
                    }
                }
            });
        });
        if (compareYearSlider) {
            compareYearSlider.addEventListener('input', () => {
                const year = Number(compareYearSlider.value);
                if (compareYearDisplay) compareYearDisplay.textContent = String(year);
                this.setState({ compareYear: year });
            });
        }
        if (compareToggle) {
            compareToggle.checked = this.state.compareMode;
            compareToggle.addEventListener('change', (e) => {
                const on = !!e.target.checked;
                const patch = { compareMode: on };
                if (on) {
                    if (this.state.viewMode !== 'map') patch.viewMode = 'map';
                    // Default mode: year-vs-* if the user is currently
                    // viewing a single year (compares it against another
                    // year), otherwise the existing reference-period path.
                    const startMode = (this.state.year != null) ? 'year' : 'ref';
                    setCompareMode(startMode);
                    if (startMode === 'year') {
                        const y = compareYearSlider ? Number(compareYearSlider.value)
                                                    : (this._yearMax ?? 2015);
                        if (Number.isFinite(y) && this.state.compareYear !== y) {
                            patch.compareYear = y;
                        }
                    } else {
                        if (!this.compareRefPeriod() && this.state.climatologyPeriod !== '1961-1990') {
                            patch.referencePeriod = '1961-1990';
                        }
                    }
                    this._compareDragged = false;
                } else {
                    if (this.state.compareYear != null) patch.compareYear = null;
                }
                this.setState(patch);
                if (patch.referencePeriod) {
                    const refSel = document.getElementById('ref-period-select');
                    if (refSel) refSel.value = patch.referencePeriod;
                }
            });
            // Initial mode reflects whether the user has a compareYear set.
            setCompareMode(this.state.compareYear != null ? 'year' : 'ref');
        }
        // Mean | ±1σ display toggle. ±1σ disables decomposition (no anomaly
        // of stddev) and forces a sequential colormap.
        // Apply the ±1σ-mode UI state (disable decomp buttons, relabel the
        // reference dropdown for σ-comparison) once on init AND on each kind
        // toggle. The reference dropdown stays enabled in ±1σ so the user
        // can pick a comparison period for the Δσ view.
        const applyKindUI = (kind) => {
            const decompSeg = document.querySelector('#decompose-group .decomp-seg');
            if (decompSeg) decompSeg.classList.toggle('is-disabled', kind === 'std');
            const refLabel = document.querySelector('label[for="ref-period-select"]');
            if (refLabel) refLabel.textContent = (kind === 'std') ? 'σ comparison' : 'Anomaly reference';
        };
        applyKindUI(this.state.kind);
        // σ-anom availability: the default 1991-2020 tree lacks std tiles for
        // 8 pressure-level raw vars (t, u, v, q, r, vo, w, z); derived-field
        // σ tiles land only once build_derived_std.py runs + pushes to GCS.
        // Rather than silently falling back to mean, disable the button with
        // a tooltip. Re-evaluated on field / kind / period changes.
        this._refreshZscoreAvailability = () => {
            const btn = document.querySelector('[data-decompose="zscore"]');
            if (!btn) return;
            const available = fieldHasStdTiles(
                this.state.field, this.state.climatologyPeriod);
            btn.classList.toggle('is-unavailable', !available);
            btn.title = available
                ? 'Standardized anomaly: (value − climo mean) ÷ climo σ. Unit-less z-score; |z| > 2 is unusual, > 3 is rare. Makes regions with different absolute variability (tropics vs midlatitudes) directly comparable.'
                : `σ-anom is unavailable for this field in the ${this.state.climatologyPeriod === 'default' ? '1991–2020' : this.state.climatologyPeriod} climatology — no σ tiles have been published for it yet.`;
            // If the user was on σ-anom and it just became unavailable,
            // fall back to Total rather than painting nothing.
            if (!available && this.state.decompose === 'zscore') {
                this.setState({ decompose: 'total' });
                document.querySelectorAll('[data-decompose]').forEach((b) =>
                    b.classList.toggle('active', b.getAttribute('data-decompose') === 'total'));
            }
        };
        this._refreshZscoreAvailability();
        document.querySelectorAll('[data-kind]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const kind = btn.getAttribute('data-kind');
                document.querySelectorAll('[data-kind]').forEach((b) =>
                    b.classList.toggle('active', b === btn));
                applyKindUI(kind);
                this.setState({ kind });
            });
        });
        // Central-meridian slider (map view only)
        const mapCenterSlider = document.getElementById('map-center-slider');
        const mapCenterValue  = document.getElementById('map-center-value');
        mapCenterSlider?.addEventListener('input', () => {
            const lon = +mapCenterSlider.value;
            mapCenterValue.textContent = `${lon}°`;
            this.setState({ mapCenterLon: lon });
        });
        document.getElementById('toggle-xsection').addEventListener('change', (e) => {
            this.setState({ showXSection: e.target.checked });
        });
        // 3-month seasonal mean toggle — centered on state.month with
        // wrap (Jan → DJF, Jul → JJA, Dec → NDJ). Affects the displayed
        // field + field cross-section (not advanced diagnostics).
        // Prefetch all 12 months on toggle-on so any month scrub from
        // here has the neighboring tiles ready — cheap, keeps the
        // averaging from waiting a round-trip on every month change.
        document.getElementById('toggle-seasonal')?.addEventListener('change', (e) => {
            if (e.target.checked) {
                prefetchField(this.state.field, { level: this.state.level });
            }
            this.setState({ seasonal: e.target.checked });
        });
        document.getElementById('toggle-lorenz')?.addEventListener('change', (e) => {
            this.setState({ showLorenz: e.target.checked });
            if (e.target.checked) this.updateLorenz();
        });
        document.getElementById('toggle-timeseries')?.addEventListener('change', (e) => {
            this.setState({ showTimeseries: e.target.checked });
        });
        document.getElementById('ts-close')?.addEventListener('click', () => {
            const cb = document.getElementById('toggle-timeseries');
            if (cb) cb.checked = false;
            this.setState({ showTimeseries: false });
        });
        document.getElementById('ts-pick-btn')?.addEventListener('click', () => {
            this._enterTimeseriesPicking();
        });
        document.querySelectorAll('#ts-mode-toggle button').forEach((btn) => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.tsMode;
                document.querySelectorAll('#ts-mode-toggle button').forEach(b =>
                    b.classList.toggle('active', b === btn));
                this.setState({ timeseriesMode: mode });
            });
        });
        document.getElementById('ts-download-btn')?.addEventListener('click', () => {
            this._downloadTimeseriesCSV();
        });
        // Manual bounds inputs — Apply button + Enter key both commit.
        const tsApplyBounds = () => {
            const lat1 = Number(document.getElementById('ts-lat1')?.value);
            const lat2 = Number(document.getElementById('ts-lat2')?.value);
            const lon1 = Number(document.getElementById('ts-lon1')?.value);
            const lon2 = Number(document.getElementById('ts-lon2')?.value);
            if (![lat1, lat2, lon1, lon2].every(Number.isFinite)) return;
            const region = {
                latMin: Math.min(lat1, lat2),
                latMax: Math.max(lat1, lat2),
                lonMin: lon1,
                lonMax: lon2,   // east-of-west; lon1 > lon2 wraps the dateline
            };
            if (region.latMax - region.latMin < 0.4) return;
            this.setState({ timeseriesRegion: region });
            this._drawTimeseriesRegionOverlay(
                { lat: region.latMin, lon: region.lonMin },
                { lat: region.latMax, lon: region.lonMax },
            );
            const lbl = document.getElementById('ts-region-label');
            if (lbl) lbl.textContent = tsBboxLabel(region);
        };
        document.getElementById('ts-bounds-apply')?.addEventListener('click', tsApplyBounds);
        ['ts-lat1', 'ts-lat2', 'ts-lon1', 'ts-lon2'].forEach((id) => {
            const el = document.getElementById(id);
            el?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') tsApplyBounds();
            });
        });
        document.getElementById('lorenz-close')?.addEventListener('click', () => {
            const cb = document.getElementById('toggle-lorenz');
            if (cb) cb.checked = false;
            this.setState({ showLorenz: false });
        });
        document.getElementById('lorenz-info-btn')?.addEventListener('click', () => {
            const info = document.getElementById('lorenz-info');
            const btn  = document.getElementById('lorenz-info-btn');
            if (!info || !btn) return;
            const open = info.hasAttribute('hidden');
            if (open) { info.removeAttribute('hidden'); btn.classList.add('active'); }
            else      { info.setAttribute('hidden', ''); btn.classList.remove('active'); }
        });
        document.querySelectorAll('input[name="lorenz-ref"]').forEach((radio) => {
            radio.addEventListener('change', (e) => {
                if (!e.target.checked) return;
                this.setState({ lorenzRef: e.target.value });
                if (this.state.showLorenz) this.updateLorenz();
            });
        });
        document.getElementById('xs-reset')?.addEventListener('click', () => {
            this.setState({ xsArc: null });
        });
        document.getElementById('xs-reset-mid')?.addEventListener('click', () => {
            const a = this.state.xsArc;
            if (!a) return;
            // Unpin the midpoint — arc reverts to straight start→end.
            this.setState({ xsArc: { start: a.start, end: a.end, mid: null } });
        });
        document.getElementById('parcels-clear')?.addEventListener('click', () => {
            this.parcels?.clear();
        });
        this.bindGifExport();
        const diagSel = document.getElementById('xs-diag-select');
        if (diagSel) {
            diagSel.value = this.state.xsDiag;
            diagSel.addEventListener('change', () => {
                this.setState({ xsDiag: diagSel.value });
            });
        }
        // M-budget sub-controls — present only when xsDiag === 'mbudget'.
        const mbTermSel = document.getElementById('mb-term-select');
        if (mbTermSel) {
            mbTermSel.value = this.state.mbTerm;
            mbTermSel.addEventListener('change', () => {
                const patch = { mbTerm: mbTermSel.value };
                // "All terms" overlay only makes sense in lat-only mode —
                // auto-flip the mode toggle to keep the UX coherent.
                const inLatOnly = (this.state.mbMode === '1d_mean' || this.state.mbMode === '1d_int');
                if (mbTermSel.value === 'all' && !inLatOnly) {
                    patch.mbMode = '1d_mean';
                    const radio = document.querySelector('input[name="mb-mode"][value="1d_mean"]');
                    if (radio) radio.checked = true;
                }
                this.setState(patch);
            });
        }
        document.querySelectorAll('input[name="mb-form"]').forEach((r) => {
            r.addEventListener('change', (e) => {
                if (e.target.checked) this.setState({ mbForm: e.target.value });
            });
        });
        document.querySelectorAll('input[name="mb-mode"]').forEach((r) => {
            r.addEventListener('change', (e) => {
                if (e.target.checked) this.setState({ mbMode: e.target.value });
            });
        });
        document.getElementById('mb-info-btn')?.addEventListener('click', () => {
            const info = document.getElementById('mb-info');
            const btn  = document.getElementById('mb-info-btn');
            if (!info || !btn) return;
            const open = info.hasAttribute('hidden');
            if (open) { info.removeAttribute('hidden'); btn.classList.add('active'); }
            else      { info.setAttribute('hidden', ''); btn.classList.remove('active'); }
        });
        document.getElementById('xs-close').addEventListener('click', () => {
            // Drop fullscreen state on close — otherwise the .expanded class
            // keeps `display:flex` even with [hidden] set (same CSS specificity,
            // .expanded comes later so it wins). Removing it both fixes the
            // visual close + makes the next open default to compact size.
            const panel = document.getElementById('xsection-panel');
            panel?.classList.remove('expanded');
            document.getElementById('toggle-xsection').checked = false;
            this.setState({ showXSection: false });
        });
        // Expand-to-fullscreen toggle. The DPR-aware renderCrossSection re-sizes
        // the canvas buffer to whatever CSS dimensions it ends up at, so simply
        // toggling the .expanded class and re-rendering on the next tick is
        // enough to get crisp output at the larger size.
        // Hover readout — inverse-maps cursor on xs-canvas to (lat, p, value).
        // Pointer events on the panel don't reach the globe canvas underneath
        // (the panel has solid backdrop + sits in front), so this won't fight
        // the existing globe HoverProbe.
        this.bindXSHover();
        document.getElementById('xs-expand')?.addEventListener('click', () => {
            const panel = document.getElementById('xsection-panel');
            const btn   = document.getElementById('xs-expand');
            if (!panel || !btn) return;
            const expanded = panel.classList.toggle('expanded');
            btn.textContent = expanded ? '⛶' : '⛶';
            btn.setAttribute('title', expanded ? 'Restore' : 'Expand to fullscreen');
            // Defer one frame so the new CSS dimensions settle before redraw.
            requestAnimationFrame(() => {
                if (this.state.showXSection) this.updateXSection();
            });
        });

        // View-mode toggle (Globe | Map | Orbit)
        const btnGlobe = document.getElementById('view-globe');
        const btnMap   = document.getElementById('view-map');
        const btnOrbit = document.getElementById('view-orbit');
        const setActive = (mode) => {
            btnGlobe.classList.toggle('active', mode === 'globe');
            btnMap.classList.toggle('active',   mode === 'map');
            btnOrbit.classList.toggle('active', mode === 'orbit');
        };
        btnGlobe.addEventListener('click', () => { this.setViewMode('globe'); setActive('globe'); });
        btnMap.addEventListener('click',   () => { this.setViewMode('map');   setActive('map'); });
        btnOrbit.addEventListener('click', () => { this.setViewMode('orbit'); setActive('orbit'); });

        // Sync the UI chrome with state after bindUI wiring is done — picks
        // up any URL-hash state that was merged in at construct time.
        this._syncUIFromState();

        // Share-link button — copy the current URL (with serialized state
        // in the hash) to the clipboard. Shows a short "Copied!" confirm
        // on the button's label, then reverts after a second.
        const shareBtn   = document.getElementById('share-link-btn');
        const shareLabel = document.getElementById('share-link-label');
        if (shareBtn && shareLabel) {
            shareBtn.addEventListener('click', async () => {
                // Flush any pending debounced hash write so the URL we copy
                // reflects the latest state (otherwise the last ~250 ms of
                // control changes might not be in the URL yet).
                const h = encodeStateToHash(this.state);
                const url = `${location.origin}${location.pathname}${location.search}${h ? '#' + h : ''}`;
                history.replaceState(null, '', url);
                try {
                    await navigator.clipboard.writeText(url);
                    shareLabel.textContent = 'Copied!';
                    shareBtn.classList.add('is-copied');
                    setTimeout(() => {
                        shareLabel.textContent = 'Share link';
                        shareBtn.classList.remove('is-copied');
                    }, 1400);
                } catch (err) {
                    // Clipboard blocked (non-HTTPS, permission denied, …).
                    // Fall back to selecting the URL in the address bar.
                    shareLabel.textContent = 'URL above ↑';
                    shareBtn.classList.add('is-copied');
                    console.warn('[share] clipboard write blocked:', err);
                    setTimeout(() => {
                        shareLabel.textContent = 'Share link';
                        shareBtn.classList.remove('is-copied');
                    }, 1800);
                }
            });
        }

        // Mobile controls drawer: hamburger toggles the sidebar overlay.
        const hamburger = document.getElementById('sidebar-toggle');
        const sidebar   = document.getElementById('sidebar');
        const backdrop  = document.getElementById('sidebar-backdrop');
        const setDrawer = (open) => {
            sidebar?.classList.toggle('open', open);
            backdrop?.classList.toggle('open', open);
        };
        hamburger?.addEventListener('click', () => {
            setDrawer(!sidebar?.classList.contains('open'));
        });
        backdrop?.addEventListener('click', () => setDrawer(false));
        // Auto-close on any view-mode or field change so the user sees the result.
        const closeOnSelect = () => { if (window.innerWidth <= 820) setDrawer(false); };
        btnGlobe.addEventListener('click', closeOnSelect);
        btnMap.addEventListener('click', closeOnSelect);
        btnOrbit.addEventListener('click', closeOnSelect);

        this.refreshLevelAvailability();
        this.on('field-updated', ({ field }) => this.updateColorbar(field));
    }

    // ── composite builder (climate-index-driven event compositing) ───
    _bindCompositeBuilder() {
        const sel     = document.getElementById('composite-index');
        const cmpSel  = document.getElementById('composite-cmp');
        const thresh  = document.getElementById('composite-threshold');
        const btn     = document.getElementById('composite-apply-btn');
        const slidCB  = document.getElementById('toggle-sliding-climo');
        if (!sel || !btn) return;
        const refresh = () => this.refreshCompositeUI();
        sel    .addEventListener('change', refresh);
        cmpSel ?.addEventListener('change', refresh);
        thresh ?.addEventListener('input',  refresh);
        btn.addEventListener('click', () => {
            // Spinner pulse so the user gets immediate feedback — the tile
            // prefetch fan-out runs async and the button would otherwise
            // look dead until the first tile arrives.
            btn.classList.add('is-computing');
            setTimeout(() => btn.classList.remove('is-computing'), 900);
            this._applyComposite();
        });
        if (slidCB) {
            slidCB.checked = !!this.state.slidingClimo;
            slidCB.addEventListener('change', (e) => {
                this.setState({ slidingClimo: e.target.checked });
            });
        }

        // Mode toggle (By index / By selection). Default is 'index'.
        // Held on the instance instead of state because it's pure UI mode —
        // the actual composite output (state.customRange) is what drives
        // the engine.
        this._compositeMode = this._compositeMode || 'index';
        this._compositeSelectedYears  = this._compositeSelectedYears  || new Set();
        this._compositeSelectedMonths = this._compositeSelectedMonths || new Set();
        const modeBtns = document.querySelectorAll('#composite-mode-toggle button');
        const indexPane = document.getElementById('composite-mode-index');
        const selPane   = document.getElementById('composite-mode-selection');
        const setMode = (mode) => {
            this._compositeMode = mode;
            modeBtns.forEach(b => b.classList.toggle('active', b.dataset.compositeMode === mode));
            if (indexPane) indexPane.hidden = (mode !== 'index');
            if (selPane)   selPane.hidden   = (mode !== 'selection');
            this.refreshCompositeUI();
        };
        modeBtns.forEach(b => b.addEventListener('click', () => setMode(b.dataset.compositeMode)));
        this._setCompositeMode = setMode;

        // Build year chips lazily — depends on the per-year manifest
        // which loads async. Re-run after era5Ready in case it wasn't
        // loaded at init time. Month chips don't need the manifest so
        // they paint immediately.
        this._buildYearChips();
        this._buildMonthChips();
        if (!era5Ready('per_year')) {
            const tryAgain = () => {
                if (era5Ready('per_year')) {
                    this._buildYearChips();
                    return;
                }
                setTimeout(tryAgain, 300);
            };
            setTimeout(tryAgain, 300);
        }

        // Quick actions for the year-selection pane.
        const quickActions = document.querySelectorAll('#composite-mode-selection [data-sel-act]');
        quickActions.forEach(b => b.addEventListener('click', () => {
            const act = b.dataset.selAct;
            const allChips = document.querySelectorAll('#composite-year-chips .yr-chip');
            allChips.forEach(c => {
                const y = Number(c.dataset.year);
                if (act === 'all')    this._compositeSelectedYears.add(y);
                if (act === 'none')   this._compositeSelectedYears.delete(y);
                if (act === 'invert') {
                    if (this._compositeSelectedYears.has(y)) this._compositeSelectedYears.delete(y);
                    else this._compositeSelectedYears.add(y);
                }
                c.classList.toggle('selected', this._compositeSelectedYears.has(y));
            });
            this.refreshCompositeUI();
        }));

        // Quick actions for the month-selection pane (Clear + season presets).
        const monthActions = document.querySelectorAll('#composite-mode-selection [data-sel-month-act]');
        const SEASON_PRESETS = {
            djf: [12, 1, 2], mam: [3, 4, 5],  jja: [6, 7, 8],
            son: [9, 10, 11], jas: [7, 8, 9], none: [],
        };
        monthActions.forEach(b => b.addEventListener('click', () => {
            const preset = SEASON_PRESETS[b.dataset.selMonthAct];
            this._compositeSelectedMonths = new Set(preset);
            this._syncMonthChipsFromState();
            this.refreshCompositeUI();
        }));

        // Clear-active-composite button. Visibility is driven by
        // refreshCompositeUI based on state.customRange. Click reverts
        // both customRange and year so the globe falls back to the
        // climatology mean (matching the "Climatology" time-mode button).
        const clearBtn = document.getElementById('composite-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (!this.state.customRange && this.state.year == null) return;
                this.setState({ customRange: null, year: null });
                this.refreshCompositeUI();
            });
        }

        this.refreshCompositeUI();
    }

    // Build the 12 month chips (Jan…Dec). Independent of any tile manifest —
    // can run synchronously at bind time.
    _buildMonthChips() {
        const container = document.getElementById('composite-month-chips');
        if (!container || container.dataset.built === '1') return;
        const frag = document.createDocumentFragment();
        for (let m = 1; m <= 12; m++) {
            const chip = document.createElement('div');
            chip.className = 'mo-chip';
            chip.dataset.month = String(m);
            chip.textContent = MONTHS[m - 1];
            chip.title = 'Click to toggle ' + MONTHS[m - 1] + ' in the composite';
            chip.addEventListener('click', () => {
                if (this._compositeSelectedMonths.has(m)) this._compositeSelectedMonths.delete(m);
                else this._compositeSelectedMonths.add(m);
                chip.classList.toggle('selected', this._compositeSelectedMonths.has(m));
                this.refreshCompositeUI();
            });
            frag.appendChild(chip);
        }
        container.appendChild(frag);
        container.dataset.built = '1';
        this._syncMonthChipsFromState();
    }

    // Mirror the active customRange.months (if any) onto the chip grid.
    // Called after the chips exist or when customRange changes shape (e.g.,
    // restored from URL state).
    _syncMonthChipsFromState() {
        const cr = this.state.customRange;
        if (cr && Array.isArray(cr.months) && cr.months.length) {
            this._compositeSelectedMonths = new Set(cr.months);
        }
        const chips = document.querySelectorAll('#composite-month-chips .mo-chip');
        chips.forEach(c => {
            const m = Number(c.dataset.month);
            c.classList.toggle('selected', this._compositeSelectedMonths.has(m));
        });
    }

    // Populate the year-chip grid from the per_year tile manifest. Called
    // at bind time AND once the manifest is ready (it loads async).
    _buildYearChips() {
        const container = document.getElementById('composite-year-chips');
        if (!container || container.dataset.built === '1') return;
        const mfst = getManifest('per_year');
        let years = null;
        for (const grp of Object.values(mfst?.groups || {})) {
            for (const v of Object.values(grp)) {
                if (Array.isArray(v.years) && v.years.length) { years = v.years.slice(); break; }
            }
            if (years) break;
        }
        if (!years) return;  // manifest not ready yet — caller will retry
        years.sort((a, b) => a - b);
        const frag = document.createDocumentFragment();
        years.forEach(y => {
            const chip = document.createElement('div');
            chip.className = 'yr-chip';
            chip.dataset.year = String(y);
            chip.textContent = String(y);
            chip.title = 'Click to toggle ' + y + ' in the composite';
            chip.addEventListener('click', () => {
                if (this._compositeSelectedYears.has(y)) this._compositeSelectedYears.delete(y);
                else this._compositeSelectedYears.add(y);
                chip.classList.toggle('selected', this._compositeSelectedYears.has(y));
                this.refreshCompositeUI();
            });
            frag.appendChild(chip);
        });
        container.appendChild(frag);
        container.dataset.built = '1';
        // If a customRange was restored from URL with mode='selection', the
        // chip selections need to be painted now that the chips exist.
        this._syncYearChipsFromState();
    }

    // Mirror the active customRange.selectedYears (if any) onto the chip
    // grid so URL-deep-linked composites visibly highlight the right cells.
    _syncYearChipsFromState() {
        const cr = this.state.customRange;
        if (!cr || cr.mode !== 'selection' || !Array.isArray(cr.selectedYears)) return;
        this._compositeSelectedYears = new Set(cr.selectedYears);
        const chips = document.querySelectorAll('#composite-year-chips .yr-chip');
        chips.forEach(c => {
            const y = Number(c.dataset.year);
            c.classList.toggle('selected', this._compositeSelectedYears.has(y));
        });
        // Months come along for free if the URL carried a multi-month spec.
        this._syncMonthChipsFromState();
        if (this._setCompositeMode) this._setCompositeMode('selection');
    }

    // Clip a year list to those with per-year tiles available. The
    // index tables reach back to 1948/1950 but the per-year tile tree
    // starts at 1961 — requesting earlier years would 404 on every
    // fetch, so the UI silently drops them (and notes the clip).
    _clipToAvailableYears(years) {
        const mfst = getManifest('per_year');
        let available = null;
        for (const grp of Object.values(mfst?.groups || {})) {
            for (const v of Object.values(grp)) {
                if (Array.isArray(v.years) && v.years.length) { available = v.years; break; }
            }
            if (available) break;
        }
        if (!available) return { kept: years, dropped: [] };
        const set = new Set(available);
        const kept = years.filter(y => set.has(y));
        const dropped = years.filter(y => !set.has(y));
        return { kept, dropped };
    }

    refreshCompositeUI() {
        const btn       = document.getElementById('composite-apply-btn');
        const label     = document.getElementById('composite-apply-label');
        const eventsDiv = document.getElementById('composite-events');
        if (!btn) return;

        // Show the "Clear active composite" button only when one is active.
        // Driven from state so it reflects URL-restored composites too.
        const clearBtn = document.getElementById('composite-clear-btn');
        if (clearBtn) {
            const active = !!(this.state.customRange);
            clearBtn.hidden = !active;
        }

        const mode = this._compositeMode || 'index';
        if (mode === 'selection') {
            return this._refreshCompositeUISelection(btn, label, eventsDiv);
        }
        return this._refreshCompositeUIIndex(btn, label, eventsDiv);
    }

    _refreshCompositeUIIndex(btn, label, eventsDiv) {
        const sel       = document.getElementById('composite-index');
        const cmpSel    = document.getElementById('composite-cmp');
        const thresh    = document.getElementById('composite-threshold');
        const descDiv   = document.getElementById('composite-index-desc');
        const srcDiv    = document.getElementById('composite-source');
        if (!sel) return;

        const id = sel.value;
        const ix = getIndex(id);
        if (!ix) {
            // Indices not yet loaded (or fetch failed). Keep the button
            // disabled; message will refresh when loadIndices resolves.
            if (eventsDiv) eventsDiv.textContent = 'Indices loading…';
            if (descDiv)   descDiv.textContent   = '';
            if (srcDiv)    srcDiv.textContent    = '';
            btn.disabled = true;
            return;
        }
        if (descDiv) descDiv.textContent = ix.description || '';
        if (srcDiv) {
            // Render attribution as: "Source: <provider ↗> · raw data ↗ · <paper ↗>"
            // Falls back to the bare data URL if the JSON entry is from an
            // older build that lacks the provider/paper fields.
            const _esc = s => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
                                             .replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const _link = (href, text) => href
                ? `<a href="${_esc(href)}" target="_blank" rel="noopener noreferrer" class="ts-source-link">${_esc(text)} ↗</a>`
                : '';
            const parts = [];
            if (ix.provider) {
                parts.push(_link(ix.provider_url || ix.source, ix.provider));
            }
            if (ix.source) parts.push(_link(ix.source, 'raw data'));
            if (ix.paper)  parts.push(_link(ix.paper_url, ix.paper));
            srcDiv.innerHTML = parts.length
                ? `Source: ${parts.filter(Boolean).join(' · ')}`
                : '';
        }

        const cmp       = cmpSel ? cmpSel.value : 'ge';
        const threshold = thresh ? Number(thresh.value) : NaN;
        if (!Number.isFinite(threshold)) {
            if (eventsDiv) eventsDiv.textContent = 'Enter a numeric threshold.';
            btn.disabled = true;
            return;
        }

        const month = this.state.month;
        const raw   = eventYears(id, month, cmp, threshold);
        const { kept: years, dropped } = this._clipToAvailableYears(raw);
        if (years.length === 0) {
            if (eventsDiv) {
                eventsDiv.textContent = raw.length === 0
                    ? 'No matching years for this threshold.'
                    : `All ${raw.length} matching year(s) predate the ERA5 per-year tile tree (1961–present).`;
            }
            btn.disabled = true;
            return;
        }
        if (eventsDiv) {
            const note = dropped.length
                ? `<div style="opacity:0.6; margin-top:4px; font-size:0.62rem;">Dropped ${dropped.length} pre-1961 year${dropped.length === 1 ? '' : 's'}: ${dropped.join(', ')}</div>`
                : '';
            eventsDiv.innerHTML =
                `<strong>${years.length} event${years.length === 1 ? '' : 's'}</strong> · ${years.join(', ')}${note}`;
        }

        const active = this.state.customRange;
        const isActive = active
            && active.id === id
            && active.cmp === cmp
            && active.threshold === threshold
            && active.month === month;
        if (label) {
            label.textContent = isActive
                ? `Active · ${compositeLabel(id, month, cmp, threshold)}`
                : `Apply · ${compositeLabel(id, month, cmp, threshold)}`;
        }
        btn.classList.toggle('is-done', !!isActive);
        btn.disabled = false;
    }

    _refreshCompositeUISelection(btn, label, eventsDiv) {
        const descDiv = document.getElementById('composite-index-desc');
        const srcDiv  = document.getElementById('composite-source');
        if (descDiv) descDiv.textContent = '';
        if (srcDiv)  srcDiv.textContent  = '';

        const picked = Array.from(this._compositeSelectedYears).sort((a, b) => a - b);
        const { kept: years, dropped } = this._clipToAvailableYears(picked);
        if (years.length === 0) {
            if (eventsDiv) {
                eventsDiv.textContent = picked.length === 0
                    ? 'Pick one or more years from the grid above.'
                    : `All ${picked.length} selected year(s) predate the per-year tile tree (1961–present).`;
            }
            btn.disabled = true;
            if (label) label.textContent = 'Apply composite';
            btn.classList.remove('is-done');
            return;
        }

        // Resolve the month set: explicit user picks override the global
        // Month. Empty pick → fall back to [state.month] (single month).
        const monthsPicked = Array.from(this._compositeSelectedMonths)
            .filter(m => Number.isFinite(m) && m >= 1 && m <= 12)
            .sort((a, b) => a - b);
        const months = monthsPicked.length ? monthsPicked : [this.state.month];
        const monLbl = months.length > 1
            ? months.map(m => MONTHS[m - 1].slice(0, 3)).join('+')
            : (MONTHS[months[0] - 1] || String(months[0]));

        if (eventsDiv) {
            const tileCount = years.length * months.length;
            const note = dropped.length
                ? `<div style="opacity:0.6; margin-top:4px; font-size:0.62rem;">Dropped ${dropped.length} pre-1961 year${dropped.length === 1 ? '' : 's'}: ${dropped.join(', ')}</div>`
                : '';
            const sizeNote = `<div style="opacity:0.55; margin-top:4px; font-size:0.62rem;">~${tileCount} tile${tileCount === 1 ? '' : 's'} fetched on Apply (${years.length} yr × ${months.length} mo)</div>`;
            eventsDiv.innerHTML =
                `<strong>${years.length} year${years.length === 1 ? '' : 's'}</strong> · ${monLbl} · ${years.join(', ')}${note}${sizeNote}`;
        }

        const active = this.state.customRange;
        const activeMonths = active && Array.isArray(active.months) && active.months.length
            ? active.months : (active ? [active.month] : []);
        const isActive = active
            && active.mode === 'selection'
            && Array.isArray(active.selectedYears)
            && active.selectedYears.length === years.length
            && active.selectedYears.every((y, i) => y === years[i])
            && activeMonths.length === months.length
            && activeMonths.every((m, i) => m === months[i]);
        const lbl = `Custom · ${monLbl} · ${years.length} yr`;
        if (label) {
            label.textContent = isActive ? `Active · ${lbl}` : `Apply · ${lbl}`;
        }
        btn.classList.toggle('is-done', !!isActive);
        btn.disabled = false;
    }

    // Which ingredient fields does the active displayed field need at the
    // per-year tile level? Mirrors the dispatch in data.js's
    // computeDerived / fieldOnIsentrope so the composite Apply button
    // prefetches the right tiles for derived / θ-coord fields.
    _compositeIngredientFields() {
        const f = this.state.field;
        const isenActive = this.state.vCoord === 'theta';
        if (f === 'pv')   return ['t', 'pv'];
        if (f === 'wspd') return isenActive ? ['t', 'u', 'v'] : ['u', 'v'];
        if (f === 'mse')  return isenActive ? ['t', 'z', 'q'] : ['t', 'z', 'q'];
        if (f === 'dls')  return ['u', 'v'];
        // θ-coord on a non-derived field — needs t for the cube + the field.
        if (isenActive)   return ['t', f];
        // Plain raw field on pressure: just the field itself.
        return [f];
    }

    _applyComposite() {
        // Hook for app-level field substitution. Climatology Globe uses this
        // to exit Index-Correlation mode (state.field='corr') back to the
        // underlying real field before compositing — otherwise the engine
        // tries to fetch per-year tiles for the synthetic 'corr' field, all
        // 404, and the loading spinner spins forever.
        if (typeof this.beforeApplyComposite === 'function') {
            try { this.beforeApplyComposite(); } catch (e) { console.warn('[composite] beforeApplyComposite hook threw:', e); }
        }
        // Defensive guard: refuse to compose hidden / synthetic fields. If
        // the hook didn't (or couldn't) substitute, bail loudly instead of
        // hanging. Hidden fields are flagged in FIELDS[name].hidden.
        const fmeta = FIELDS[this.state.field];
        if (fmeta?.hidden) {
            const eventsDiv = document.getElementById('composite-events');
            if (eventsDiv) {
                eventsDiv.innerHTML =
                    `<strong style="color:#fbbf24;">Cannot composite '${this.state.field}'</strong> — ` +
                    `pick a real field (SST, MPI, etc.) first.`;
            }
            return;
        }
        const mode = this._compositeMode || 'index';
        if (mode === 'selection') return this._applyCompositeSelection();
        return this._applyCompositeIndex();
    }

    _applyCompositeIndex() {
        const sel    = document.getElementById('composite-index');
        const cmpSel = document.getElementById('composite-cmp');
        const thresh = document.getElementById('composite-threshold');
        if (!sel) return;
        const id        = sel.value;
        const cmp       = cmpSel ? cmpSel.value : 'ge';
        const threshold = thresh ? Number(thresh.value) : NaN;
        if (!Number.isFinite(threshold)) return;
        const month = this.state.month;
        // Clip to years that have per-year tiles (1961–present). Without
        // this, pre-1961 events fire 404s against the tile bucket.
        const { kept: years } = this._clipToAvailableYears(
            eventYears(id, month, cmp, threshold));
        if (years.length === 0) return;
        this._prefetchCompositeYears(years, month);
        const label = compositeLabel(id, month, cmp, threshold);
        this.setState({
            // `id / cmp / threshold / month` travel with customRange so
            // refreshCompositeUI can detect when the DOM controls still
            // describe the active composite (and show "Active · …").
            customRange: { years, label, id, cmp, threshold, month, mode: 'index' },
            year: null,
        });
        this.refreshCompositeUI();
    }

    _applyCompositeSelection() {
        const picked = Array.from(this._compositeSelectedYears).sort((a, b) => a - b);
        const { kept: years } = this._clipToAvailableYears(picked);
        if (years.length === 0) return;
        const monthsPicked = Array.from(this._compositeSelectedMonths)
            .filter(m => Number.isFinite(m) && m >= 1 && m <= 12)
            .sort((a, b) => a - b);
        const months = monthsPicked.length ? monthsPicked : [this.state.month];
        const anchorMonth = months[0];   // for legacy code that reads .month
        this._prefetchCompositeYears(years, months);
        const monLbl = months.length > 1
            ? months.map(m => MONTHS[m - 1].slice(0, 3)).join('+')
            : (MONTHS[anchorMonth - 1] || String(anchorMonth));
        const label = `Custom: ${years.length} yr · ${monLbl}`;
        const cr = {
            years, label, mode: 'selection',
            selectedYears: years.slice(),
            // .month kept for back-compat with anchor-reading code paths
            // (e.g. refreshTracks falling back to month when months[] absent).
            month: anchorMonth,
        };
        // Only attach months[] when the user actually picked a multi-month
        // set — single-month back-compat keeps the old engine path active.
        if (monthsPicked.length > 0) cr.months = months.slice();
        this.setState({ customRange: cr, year: null });
        this.refreshCompositeUI();
    }

    // Shared per-year-tile prefetch fan-out. For raw fields this is just
    // the field tile at the displayed level; for derived (PV, wspd, mse,
    // dls) and θ-coord fields the composer needs ingredient tiles at every
    // pressure level, so kick a wider prefetch — current month set only to
    // avoid flooding (months scrub lazily). `months` may be a single int
    // (legacy) or an array (multi-month composite).
    _prefetchCompositeYears(years, months) {
        const monthList = Array.isArray(months) ? months : [months];
        const ingredients = this._compositeIngredientFields();
        const meta = FIELDS[this.state.field];
        const allLevels = !!(meta?.derived || this.state.vCoord === 'theta');
        const lvls = allLevels ? LEVELS : [meta?.type === 'pl' ? this.state.level : null];
        for (const y of years) {
            for (const ing of ingredients) {
                for (const L of lvls) {
                    prefetchField(ing, {
                        level: L,
                        months: monthList,
                        period: 'per_year',
                        year: y,
                    });
                }
            }
        }
    }

    // ── sliding-climo helper for composite anomalies ──────────────────
    // Given a list of event years, fetch each unique best-match climo tile
    // and return the event-weighted mean grid: out[i,j] = (1/N) Σ_y climo_y[i,j].
    // Returns null if any required climo window's tile hasn't loaded yet
    // (or its manifest doesn't exist on GCS — e.g. a window we haven't
    // built tiles for). Caller falls back to the active fixed period.
    _weightedClimoForEvents(field, month, level, coord, theta, years) {
        if (!Array.isArray(years) || years.length === 0) return null;
        const groups = groupEventsByClimo(years);
        const totalN = years.length;
        const N = GRID.nlat * GRID.nlon;
        const out = new Float32Array(N);
        for (const { window, years: ys } of groups.values()) {
            // Kick a manifest load for any window we haven't seen yet —
            // first call is async; subsequent renders find the tile.
            if (window.id !== '1991-2020' && window.id !== '1961-1990') {
                loadManifest(window.id);   // fire-and-forget
            }
            const climo = getField(field, {
                month, level, coord, theta,
                kind: 'mean', period: window.id,
            });
            if (!climo.isReal) return null;
            const w = ys.length / totalN;
            const cv = climo.values;
            for (let i = 0; i < N; i++) out[i] += w * cv[i];
        }
        return out;
    }

    // ── area-mean time series ─────────────────────────────────────────
    _syncTimeseriesBoundsInputs() {
        const r = this.state.timeseriesRegion;
        if (!r) return;
        const set = (id, v) => {
            const el = document.getElementById(id);
            if (el && document.activeElement !== el) el.value = String(Math.round(v));
        };
        set('ts-lat1', r.latMin);
        set('ts-lat2', r.latMax);
        set('ts-lon1', r.lonMin);
        set('ts-lon2', r.lonMax);
    }

    _showTimeseriesLoading(loaded, total) {
        const overlay = document.getElementById('ts-loading');
        const text    = document.getElementById('ts-loading-text');
        const fill    = document.getElementById('ts-loading-fill');
        if (!overlay) return;
        if (total === 0 || loaded === total) {
            overlay.classList.add('hidden');
            return;
        }
        overlay.classList.remove('hidden');
        const pct = total > 0 ? Math.round(loaded / total * 100) : 0;
        if (text) text.textContent = loaded === 0
            ? 'Fetching ERA5 tiles…'
            : `Loading ${loaded} / ${total} months  (${pct}%)`;
        if (fill) fill.style.width = `${pct}%`;
    }

    _availablePerYears() {
        const mfst = getManifest('per_year');
        for (const grp of Object.values(mfst?.groups || {})) {
            for (const v of Object.values(grp)) {
                if (Array.isArray(v.years) && v.years.length) return v.years;
            }
        }
        return [];
    }

    _enterTimeseriesPicking() {
        const panel = document.getElementById('timeseries-panel');
        const btn   = document.getElementById('ts-pick-btn');
        const hint  = document.getElementById('ts-hint');
        this._tsPicking = true;
        if (panel) panel.classList.add('picking');
        if (btn)   btn.textContent = 'Picking…';
        if (hint)  hint.textContent = 'Drag a rectangle on the Map view. ESC to cancel.';
        // Auto-switch to map view — box-select only makes sense there
        // in v1 (globe-view picking would need a spherical box overlay).
        if (this.state.viewMode !== 'map') this.setViewMode('map');
        // Suppress orbit-controls pan/zoom while picking.
        this.controls.enabled = false;
        // Visual affordances — change the canvas cursor to a crosshair so
        // the user knows they're in pick mode, and show a top-centre banner
        // with instructions (the panel may be hidden until a region is
        // committed, so a canvas-level hint is the only visible cue).
        // Toggle via a class so the override beats #globe-mount canvas
        // { cursor: grab } without specificity gymnastics.
        this.renderer?.domElement.classList.add('ts-picking');
        let banner = document.getElementById('ts-pick-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'ts-pick-banner';
            banner.className = 'ts-pick-banner';
            banner.innerHTML = 'Drag a rectangle on the map to pick a region  ·  <b>ESC</b> cancels';
            document.body.appendChild(banner);
        }
        banner.classList.remove('hidden');
        // One-shot ESC to cancel.
        this._tsEscHandler = (e) => {
            if (e.key === 'Escape') this._exitTimeseriesPicking();
        };
        window.addEventListener('keydown', this._tsEscHandler);
    }

    _exitTimeseriesPicking() {
        const panel = document.getElementById('timeseries-panel');
        const btn   = document.getElementById('ts-pick-btn');
        const hint  = document.getElementById('ts-hint');
        this._tsPicking = false;
        this._tsPickStart = null;
        if (panel) panel.classList.remove('picking');
        if (btn)   btn.textContent = 'Pick region';
        if (hint)  hint.textContent = this.state.timeseriesRegion
            ? 'Drag again to redraw. ESC cancels.'
            : 'Click Pick region, then drag on the Map view to set bounds.';
        this.controls.enabled = true;
        this.renderer?.domElement.classList.remove('ts-picking');
        const banner = document.getElementById('ts-pick-banner');
        if (banner) banner.classList.add('hidden');
        if (this._tsEscHandler) {
            window.removeEventListener('keydown', this._tsEscHandler);
            this._tsEscHandler = null;
        }
    }

    // ── keyboard shortcuts ────────────────────────────────────────────
    _installKeyboardShortcuts() {
        // Step the month with wrap (Dec → Jan, Jan → Dec).
        const stepMonth = (delta) => {
            const next = ((this.state.month - 1 + delta + 12) % 12) + 1;
            if (this._syncMonthUI) this._syncMonthUI(next);
            this.setState({ month: next });
        };
        // Step the vertical level by one in the direction of altitude.
        // delta=+1 = up in altitude (lower pressure / higher θ).
        // LEVELS is sorted ascending in pressure (10 → 1000 hPa) so up
        // means decrementing the index; THETA_LEVELS is ascending in θ
        // (warmer = higher altitude) so up means incrementing.
        const clamp = (i, n) => Math.max(0, Math.min(n - 1, i));
        const stepLevel = (delta) => {
            if (this.state.vCoord === 'theta') {
                const i = THETA_LEVELS.indexOf(this.state.theta);
                if (i < 0) return;
                this.setState({ theta: THETA_LEVELS[clamp(i + delta, THETA_LEVELS.length)] });
            } else {
                const i = LEVELS.indexOf(this.state.level);
                if (i < 0) return;
                this.setState({ level: LEVELS[clamp(i - delta, LEVELS.length)] });
            }
        };
        const cycleDecompose = () => {
            const order = ['total', 'anomaly', 'zonal', 'eddy'];
            const i = order.indexOf(this.state.decompose);
            const next = order[((i < 0 ? 0 : i) + 1) % order.length];
            this.setState({ decompose: next });
            this._syncUIFromState();
        };

        window.addEventListener('keydown', (e) => {
            // Skip when modifier keys are held — leaves Cmd-S, Ctrl-F, etc.
            // free for the browser.
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            // Skip when typing in any form control so the bounds inputs +
            // year inputs + threshold input keep accepting numbers.
            const t = e.target;
            const tag = t?.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t?.isContentEditable) return;

            // Esc clears the help overlay or any other dismissible state
            // (timeseries-picker has its own ESC handler installed at
            // pick-mode start).
            if (e.key === 'Escape') {
                const help = document.getElementById('shortcut-help');
                if (help && !help.hidden) { help.hidden = true; e.preventDefault(); return; }
                return;
            }

            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    if (this.playTimer) this.stopPlay();
                    else                this.startPlay();
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    stepMonth(-1);
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    stepMonth(+1);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    stepLevel(+1);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    stepLevel(-1);
                    break;
                case 'g': case 'G':
                    this.setViewMode('globe');
                    document.querySelectorAll('.view-toggle button').forEach(b =>
                        b.classList.toggle('active', b.id === 'view-globe'));
                    break;
                case 'm': case 'M':
                    this.setViewMode('map');
                    document.querySelectorAll('.view-toggle button').forEach(b =>
                        b.classList.toggle('active', b.id === 'view-map'));
                    break;
                case 'o': case 'O':
                    this.setViewMode('orbit');
                    document.querySelectorAll('.view-toggle button').forEach(b =>
                        b.classList.toggle('active', b.id === 'view-orbit'));
                    break;
                case 'c': case 'C': {
                    const next = !this.state.showContours;
                    this.setState({ showContours: next });
                    const cb = document.getElementById('toggle-contours');
                    if (cb) cb.checked = next;
                    const row = document.getElementById('contour-field-row');
                    if (row) row.hidden = !next;
                    break;
                }
                case 'a': case 'A':
                    cycleDecompose();
                    break;
                case '?':
                    e.preventDefault();
                    this._toggleShortcutHelp();
                    break;
            }
        });
    }

    _toggleShortcutHelp(force) {
        let panel = document.getElementById('shortcut-help');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'shortcut-help';
            panel.className = 'shortcut-help';
            panel.innerHTML = `
                <div class="sc-card">
                    <div class="sc-head">
                        <span>Keyboard shortcuts</span>
                        <button class="sc-close" aria-label="Close">&times;</button>
                    </div>
                    <table class="sc-table">
                        <tr><td><kbd>Space</kbd></td><td>Play / pause months</td></tr>
                        <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>Previous / next month</td></tr>
                        <tr><td><kbd>↑</kbd> <kbd>↓</kbd></td><td>Up / down a vertical level (altitude direction)</td></tr>
                        <tr><td><kbd>G</kbd> <kbd>M</kbd> <kbd>O</kbd></td><td>Globe / Map / Orbit view</td></tr>
                        <tr><td><kbd>C</kbd></td><td>Toggle contours</td></tr>
                        <tr><td><kbd>A</kbd></td><td>Cycle decomposition (total → anomaly → zonal → eddy)</td></tr>
                        <tr><td><kbd>?</kbd></td><td>Toggle this help</td></tr>
                        <tr><td><kbd>Esc</kbd></td><td>Cancel picking / close this help</td></tr>
                    </table>
                    <p class="sc-foot">Shortcuts pause while typing in any input. <span class="sc-kbd">⇧</span>+drag draws cross-section arcs · <span class="sc-kbd">⌥</span>+click globe releases parcels.</p>
                </div>
            `;
            document.body.appendChild(panel);
            panel.querySelector('.sc-close').addEventListener('click', () => { panel.hidden = true; });
            panel.addEventListener('click', (e) => { if (e.target === panel) panel.hidden = true; });
        }
        panel.hidden = (force === false) ? true : (force === true ? false : !panel.hidden);
    }

    _installTimeseriesHover() {
        const canvas = document.getElementById('ts-canvas');
        if (!canvas) return;
        const tip = document.getElementById('ts-hover-tip');
        canvas.addEventListener('pointermove', (e) => {
            if (!this._tsHoverCtx || !this._tsLastSeries) { this._clearTimeseriesHover(); return; }
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const hit = tsHoverLookup(this._tsHoverCtx, this._tsLastSeries, mx, my);
            if (!hit) { this._clearTimeseriesHover(); return; }
            this._tsHoverHit = hit;
            this._paintTimeseriesHoverMarker();
            if (tip) {
                const meta = FIELDS[this.state.field] || {};
                const p = hit.point;
                tip.innerHTML = `${TS_MONTH_NAMES[p.month - 1]} ${p.year}<span class="hv-sep">·</span><span class="hv-value">${fmtValue(p.value)}</span><span class="hv-unit">${meta.units || ''}</span>`;
                // Shares the .hover-tooltip class → position:fixed with
                // viewport-relative clientX/Y. Offset above-right of cursor,
                // flip if that would clip the viewport.
                const pad = 14;
                const w = tip.offsetWidth || 180;
                const h = tip.offsetHeight || 28;
                let x = e.clientX + pad;
                let y = e.clientY - h - pad;
                if (x + w > window.innerWidth)  x = e.clientX - w - pad;
                if (y < 0)                      y = e.clientY + pad;
                tip.style.left = `${x}px`;
                tip.style.top  = `${y}px`;
                tip.classList.remove('hidden');
            }
        });
        canvas.addEventListener('pointerleave', () => this._clearTimeseriesHover());
    }

    _clearTimeseriesHover() {
        this._tsHoverHit = null;
        const tip = document.getElementById('ts-hover-tip');
        if (tip) tip.classList.add('hidden');
        // Re-paint the chart to erase the marker.
        const canvas = document.getElementById('ts-canvas');
        if (canvas && this._tsLastSeries && this._tsHoverCtx) {
            const meta = FIELDS[this.state.field] || {};
            this._tsHoverCtx = tsRenderSeries(canvas, this._tsLastSeries, {
                units: meta.units,
                symmetric: this.state.timeseriesMode === 'anomaly',
            });
        }
    }

    _paintTimeseriesHoverMarker() {
        const hit = this._tsHoverHit;
        if (!hit || !this._tsHoverCtx) return;
        const canvas = document.getElementById('ts-canvas');
        if (!canvas || !this._tsLastSeries) return;
        // Redraw the base chart first — otherwise every pointermove layers
        // another dot + guideline onto the canvas and you end up with a
        // swarm of markers across the plot.
        const meta = FIELDS[this.state.field] || {};
        this._tsHoverCtx = tsRenderSeries(canvas, this._tsLastSeries, {
            units: meta.units,
            symmetric: this.state.timeseriesMode === 'anomaly',
        });
        const ctx = canvas.getContext('2d');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const { padT, h } = this._tsHoverCtx;
        // Vertical guideline
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hit.xOnPlot, padT);
        ctx.lineTo(hit.xOnPlot, padT + h);
        ctx.stroke();
        ctx.setLineDash([]);
        // Marker dot
        ctx.fillStyle = '#f0f6f2';
        ctx.beginPath();
        ctx.arc(hit.xOnPlot, hit.yOnPlot, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#4fd1a5';
        ctx.lineWidth = 1.4;
        ctx.stroke();
    }

    _installTimeseriesPicker() {
        // One-time install — wired alongside the arc-drag handler.
        const el = this.renderer.domElement;
        const raycaster = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        const mapPoint = (e) => {
            if (this.state.viewMode !== 'map' || !this.mapMesh) return null;
            const rect = el.getBoundingClientRect();
            ndc.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
            ndc.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
            raycaster.setFromCamera(ndc, this.camera);
            const hits = raycaster.intersectObject(this.mapMesh);
            if (!hits.length) return null;
            let lon = hits[0].point.x * (360 / MAP_W) + this.state.mapCenterLon;
            const lat = hits[0].point.y * (180 / MAP_H);
            lon = ((lon + 180) % 360 + 360) % 360 - 180;
            if (lat < -90 || lat > 90) return null;
            return { lat, lon };
        };
        el.addEventListener('pointerdown', (e) => {
            if (!this._tsPicking) return;
            const p = mapPoint(e);
            if (!p) return;
            e.preventDefault();
            e.stopPropagation();
            this._tsPickStart = p;
            el.setPointerCapture(e.pointerId);
        }, true);
        el.addEventListener('pointermove', (e) => {
            if (!this._tsPicking || !this._tsPickStart) return;
            const p = mapPoint(e);
            if (!p) return;
            this._tsPickCurrent = p;
            this._drawTimeseriesRegionOverlay(this._tsPickStart, p);
        }, true);
        el.addEventListener('pointerup', (e) => {
            if (!this._tsPicking || !this._tsPickStart) return;
            const p = mapPoint(e) || this._tsPickCurrent;
            if (p) {
                const region = {
                    latMin: Math.min(this._tsPickStart.lat, p.lat),
                    latMax: Math.max(this._tsPickStart.lat, p.lat),
                    lonMin: this._tsPickStart.lon,
                    lonMax: p.lon,
                };
                // Degenerate box guard — require at least ~0.5° span either way.
                if (Math.abs(region.latMax - region.latMin) > 0.4
                    && Math.abs(region.lonMax - region.lonMin) > 0.4) {
                    this.setState({ timeseriesRegion: region });
                    this._drawTimeseriesRegionOverlay(
                        { lat: region.latMin, lon: region.lonMin },
                        { lat: region.latMax, lon: region.lonMax },
                    );
                    const lbl = document.getElementById('ts-region-label');
                    if (lbl) lbl.textContent = tsBboxLabel(region);
                }
            }
            this._tsPickStart = null;
            this._tsPickCurrent = null;
            try { el.releasePointerCapture(e.pointerId); } catch (_) { /* already gone */ }
            this._exitTimeseriesPicking();
        }, true);
    }

    _drawTimeseriesRegionOverlay(a, b) {
        // Simple rectangle in mapGroup at z slightly above the map plane so
        // it doesn't z-fight. Rebuilt on each call. Globe-view visualization
        // is deferred — users pick on the map which is the v1 scope.
        if (this.state.viewMode !== 'map') return;
        if (!this._tsRegionLine) {
            const geom = new LineGeometry();
            const mat = new LineMaterial({
                color: 0x4fd1a5,
                linewidth: 2.0,
                dashed: false,
                transparent: true,
                opacity: 0.85,
            });
            mat.resolution.set(window.innerWidth, window.innerHeight);
            this._tsRegionLine = new Line2(geom, mat);
            this._tsRegionLine.renderOrder = 10;
            this.mapGroup.add(this._tsRegionLine);
        }
        // Convert (lat, lon) back to map-plane coordinates. Reverse of
        // mapPoint: lon' = lon - mapCenterLon (shortest wrap), x = lon' / (360/MAP_W).
        const mc = this.state.mapCenterLon;
        const wrap = (lon) => {
            let d = lon - mc;
            d = ((d + 180) % 360 + 360) % 360 - 180;
            return d;
        };
        const xA = wrap(a.lon) / (360 / MAP_W);
        const xB = wrap(b.lon) / (360 / MAP_W);
        const yA = a.lat / (180 / MAP_H);
        const yB = b.lat / (180 / MAP_H);
        const z = 0.0013;
        const pts = [
            xA, yA, z,  xB, yA, z,  xB, yB, z,  xA, yB, z,  xA, yA, z,
        ];
        this._tsRegionLine.geometry.setPositions(pts);
        this._tsRegionLine.computeLineDistances();
        this._tsRegionLine.visible = true;
    }

    _prefetchTimeseriesTiles() {
        const region = this.state.timeseriesRegion;
        if (!region) return;
        const years = this._availablePerYears();
        if (!years.length) return;
        const meta = FIELDS[this.state.field];
        if (!meta || meta.derived) return;   // v1: raw-tile fields only
        const level = meta.type === 'pl' ? this.state.level : null;
        for (const y of years) {
            prefetchField(this.state.field, {
                level, period: 'per_year', year: y,
            });
        }
        // Also prefetch the climatology tiles (for anomaly mode).
        prefetchField(this.state.field, { level });
    }

    _scheduleTimeseriesRender() {
        clearTimeout(this._tsRenderTimer);
        this._tsRenderTimer = setTimeout(() => this.renderTimeseries(), 180);
    }

    renderTimeseries() {
        if (!this.state.showTimeseries) return;
        const canvas = document.getElementById('ts-canvas');
        if (!canvas) return;
        const region = this.state.timeseriesRegion;
        if (!region) {
            // Clear to "no region" placeholder.
            const ctx = canvas.getContext('2d');
            const cssW = canvas.clientWidth || 520, cssH = canvas.clientHeight || 230;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#8bb0a1';
            ctx.font = '13px ui-monospace, "JetBrains Mono", Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Click Pick region, then drag on the map.', cssW / 2, cssH / 2);
            return;
        }
        const years = this._availablePerYears();
        if (!years.length) return;
        const meta = FIELDS[this.state.field];
        if (!meta || meta.derived) {
            const ctx = canvas.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#ffa0a0';
            ctx.font = '12px ui-monospace, Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Derived fields not supported for time series (v1).',
                         canvas.clientWidth / 2, canvas.clientHeight / 2);
            return;
        }
        const level = meta.type === 'pl' ? this.state.level : null;
        const series = tsComputeSeries(getField, region, {
            field: this.state.field,
            level,
            coord: this.state.vCoord,
            theta: this.state.theta,
            years,
            anomaly: this.state.timeseriesMode === 'anomaly',
            period: this.state.climatologyPeriod === 'default'
                ? 'default' : this.state.climatologyPeriod,
            // Share the composite-builder's best-match toggle so the
            // timeseries anomaly is trend-aware by default: each year
            // subtracts its closest 30-yr climatology instead of one
            // fixed window across 1961-2026.
            slidingClimo: !!this.state.slidingClimo,
            bestClimoForYear: bestClimoFor,
        });
        this._tsHoverCtx = tsRenderSeries(canvas, series, {
            units: meta.units,
            symmetric: this.state.timeseriesMode === 'anomaly',
        });
        // Re-stack any existing hover marker on top of the fresh paint.
        this._paintTimeseriesHoverMarker();
        // Status line: loaded / total months + extrema. Also drive the
        // loading overlay — visible until tiles cross a "ready" threshold
        // (40%) so the user sees a clear "fetching" state on first pick
        // instead of a chart that fills in over several seconds.
        const finite = series.filter(p => p.value != null && Number.isFinite(p.value));
        const total = series.length;
        const statsEl = document.getElementById('ts-stats');
        if (statsEl) {
            if (finite.length === 0) {
                statsEl.textContent = '';
            } else {
                const pct = Math.round(finite.length / total * 100);
                const mean = finite.reduce((s, p) => s + p.value, 0) / finite.length;
                statsEl.textContent = `${finite.length}/${total} months · mean ${mean.toFixed(2)}${meta.units ? ' ' + meta.units : ''}${pct < 100 ? ` (${pct}%)` : ''}`;
            }
        }
        // Show the spinner+bar overlay while < 40% of months have arrived;
        // once it's mostly populated the partial chart is informative
        // enough on its own.
        const ready = finite.length / Math.max(total, 1) >= 0.4;
        this._showTimeseriesLoading(ready ? total : finite.length, total);
        // Title: reflect field + region + mode.
        const title = document.getElementById('ts-title');
        if (title) {
            const suffix = this.state.timeseriesMode === 'anomaly' ? ' anomaly' : '';
            const coord = meta.type === 'pl'
                ? (this.state.vCoord === 'theta'
                    ? ` · θ=${this.state.theta} K` : ` · ${this.state.level} hPa`)
                : '';
            title.textContent = `${meta.name}${coord}${suffix}`;
        }
        // Cache the series for CSV download.
        this._tsLastSeries = series;
    }

    _downloadTimeseriesCSV() {
        const series = this._tsLastSeries;
        if (!series || !series.length) return;
        const meta = FIELDS[this.state.field];
        const level = meta.type === 'pl' ? this.state.level : null;
        const csv = tsSeriesToCSV(series, {
            field: this.state.field,
            level,
            region: this.state.timeseriesRegion
                ? tsBboxLabel(this.state.timeseriesRegion) : '',
            mode: this.state.timeseriesMode,
            units: meta.units,
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
        a.href = url;
        a.download = `tc-atlas-${this.state.field}-timeseries-${stamp}.csv`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
    }

    startPlay() {
        const btn = document.getElementById('month-play');
        const monthSel = document.getElementById('month-select');
        if (btn) { btn.textContent = '⏸'; btn.classList.add('playing'); btn.setAttribute('aria-label', 'pause'); }
        // Prefetch the whole seasonal cycle for the current field (and for u/v so
        // the wind particles stay smooth as months advance).
        prefetchField(this.state.field, { level: this.state.level });
        prefetchField('u', { level: this.state.level });
        prefetchField('v', { level: this.state.level });
        this.playTimer = setInterval(() => {
            const next = this.state.month === 12 ? 1 : this.state.month + 1;
            if (this._syncMonthUI) this._syncMonthUI(next);
            this.setState({ month: next });
        }, PLAY_INTERVAL_MS);
    }

    stopPlay() {
        if (!this.playTimer) return;
        clearInterval(this.playTimer);
        this.playTimer = null;
        const btn = document.getElementById('month-play');
        if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); btn.setAttribute('aria-label', 'play through months'); }
    }

    bindGifExport() {
        const openBtn = document.getElementById('export-gif');
        const modal   = document.getElementById('gif-modal');
        const closeBtn = document.getElementById('gif-close');
        const cancelBtn = document.getElementById('gif-cancel');
        const startBtn = document.getElementById('gif-start');
        const progress = document.getElementById('gif-progress');
        const progressFill = document.getElementById('gif-progress-fill');
        const progressText = document.getElementById('gif-progress-text');
        if (!openBtn || !modal) return;

        const open  = () => {
            modal.classList.remove('hidden');
            progress.classList.add('hidden');
            startBtn.disabled = false;
            startBtn.textContent = 'Capture';
            // Grey out the swipe-sweep option when compare isn't active
            // on the map view (the capture would fail otherwise).
            const swipeOpt = document.getElementById('gif-opt-swipe');
            const swipeRadio = swipeOpt?.querySelector('input[type="radio"]');
            const swipeOk = this.state.compareMode && this.state.viewMode === 'map';
            if (swipeOpt) {
                // Toggle .is-unavailable instead of opacity — keeps the option
                // visible with its amber "how to enable" caption so the user
                // learns what to do next rather than guessing.
                swipeOpt.classList.toggle('is-unavailable', !swipeOk);
            }
            if (swipeRadio) {
                swipeRadio.disabled = !swipeOk;
                // If the user previously picked swipe-sweep but compare
                // is now off, re-default to the still-main mode.
                if (!swipeOk && swipeRadio.checked) {
                    const mainStill = document.querySelector('input[name="gif-mode"][value="still-main"]');
                    if (mainStill) mainStill.checked = true;
                }
            }
            // Same treatment for the "still · cross-section" option —
            // only enabled when the xs panel is actually open. Otherwise
            // the capture has nothing to grab.
            const xsOpt = document.getElementById('gif-opt-xsection');
            const xsRadio = xsOpt?.querySelector('input[type="radio"]');
            const xsPanel = document.getElementById('xsection-panel');
            const xsOk = xsPanel && !xsPanel.hidden;
            if (xsOpt) {
                xsOpt.classList.toggle('is-unavailable', !xsOk);
            }
            if (xsRadio) {
                xsRadio.disabled = !xsOk;
                if (!xsOk && xsRadio.checked) {
                    const mainStill = document.querySelector('input[name="gif-mode"][value="still-main"]');
                    if (mainStill) mainStill.checked = true;
                }
            }
        };
        const close = () => { modal.classList.add('hidden'); };

        openBtn.addEventListener('click', open);
        // Floating "Save view" pill up top-right (next to Share link) opens
        // the same modal so users don't have to scroll the sidebar.
        const floatingSaveBtn = document.getElementById('save-view-btn');
        if (floatingSaveBtn) floatingSaveBtn.addEventListener('click', open);
        closeBtn.addEventListener('click', close);
        cancelBtn.addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

        const exporter = new GifExporter({
            renderer: this.renderer,
            state: this.state,
            setState: (p) => this.setState(p),
            updateField: () => this.updateField(),
            // "Ready" = the currently-rendered field came back as a real
            // tile, not the pending placeholder.
            getIsReady: () => {
                const { field, level, theta, vCoord, month } = this.state;
                return !!getField(field, { month, level, coord: vCoord, theta }).isReal;
            },
        });

        startBtn.addEventListener('click', async () => {
            const mode = document.querySelector('input[name="gif-mode"]:checked')?.value || 'animated';
            startBtn.disabled = true;
            startBtn.textContent = 'Capturing…';
            progress.classList.remove('hidden');
            progressFill.style.width = '0%';
            progressText.textContent = 'Capturing 0 / 0';

            // Pause monthly auto-play during capture so we don't fight it.
            const wasPlaying = !!this.playTimer;
            if (wasPlaying) this.stopPlay();

            const onProgress = (i, n) => {
                progressFill.style.width = (100 * i / n).toFixed(1) + '%';
                progressText.textContent = `Capturing ${i} / ${n}`;
            };

            try {
                let blob, ext;
                if (mode === 'still-main') {
                    blob = await exporter.saveStill({ format: 'png' });
                    ext  = 'png';
                    // Still images are single-shot — show a 100% progress
                    // bar so the user gets the usual "done" signal.
                    progressFill.style.width = '100%';
                    progressText.textContent = 'Captured';
                } else if (mode === 'still-xsection') {
                    blob = await exporter.saveXsectionStill({ format: 'png' });
                    ext  = 'png';
                    progressFill.style.width = '100%';
                    progressText.textContent = 'Captured';
                } else if (mode === 'annual') {
                    blob = await exporter.captureAnnual({ onProgress });
                    ext  = 'gif';
                } else if (mode === 'swipe-sweep') {
                    blob = await exporter.captureSwipeSweep({ onProgress });
                    ext  = 'gif';
                } else {
                    blob = await exporter.captureAnimated({ durationMs: 5000, fps: 15, onProgress });
                    ext  = 'gif';
                }
                const sizeMB = blob.size / 1024 / 1024;
                progressText.textContent = ext === 'gif'
                    ? `Encoding… ${sizeMB.toFixed(1)} MB`
                    : `Saving · ${(blob.size / 1024).toFixed(0)} kB`;
                const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
                downloadBlob(blob, `tc-atlas-${mode}-${stamp}.${ext}`);
                progressText.textContent = ext === 'gif'
                    ? `Done · ${sizeMB.toFixed(1)} MB`
                    : `Done · ${(blob.size / 1024).toFixed(0)} kB`;
                startBtn.textContent = 'Capture again';
                startBtn.disabled = false;
            } catch (err) {
                console.error('[export] capture failed:', err);
                progressText.textContent = `Capture failed: ${err.message || err}`;
                startBtn.disabled = false;
                startBtn.textContent = 'Retry';
            }

            if (wasPlaying) this.startPlay();
        });
    }

    populateLevelSelect() {
        const levelSel = document.getElementById('level-select');
        if (!levelSel) return;
        const isen = this.state.vCoord === 'theta';
        const values = isen ? THETA_LEVELS : LEVELS;
        const unit   = isen ? 'K' : 'hPa';
        const current = isen ? this.state.theta : this.state.level;
        levelSel.innerHTML = '';
        for (const v of values) {
            levelSel.appendChild(Object.assign(document.createElement('option'),
                { value: v, textContent: `${v} ${unit}` }));
        }
        // Snap to the nearest legal value if the current one isn't in the menu.
        const closest = values.reduce((best, v) =>
            Math.abs(v - current) < Math.abs(best - current) ? v : best, values[0]);
        levelSel.value = closest;
        if (isen && closest !== current) this.state.theta = closest;
        if (!isen && closest !== current) this.state.level = closest;
    }

    // One-shot sync of every UI control (segmented toggles, checkboxes,
    // sliders, dropdowns, view-toggle) to whatever's currently in
    // this.state. Called after bindUI wiring completes so a URL-hash-
    // restored view paints with the matching control chrome.
    _syncUIFromState() {
        const s = this.state;
        // View toggle (Globe / Map / Orbit).
        const map = { globe: 'view-globe', map: 'view-map', orbit: 'view-orbit' };
        document.querySelectorAll('.view-toggle button').forEach(b =>
            b.classList.toggle('active', b.id === map[s.viewMode]));
        if (s.viewMode && s.viewMode !== 'globe') this.setViewMode(s.viewMode);
        // Segmented toggles (kind, decompose, vertical coord, wind mode,
        // time-mode, compare-mode). Each uses a data-attribute to identify
        // its value; set .active on the matching button.
        const seg = (sel, attr, value) => {
            document.querySelectorAll(sel).forEach(b =>
                b.classList.toggle('active', b.dataset[attr] === String(value)));
        };
        seg('#kind-toggle button',         'kind',        s.kind);
        seg('.decomp-seg button',          'decompose',   s.decompose);
        seg('#vcoord-toggle button',       'coord',       s.vCoord);
        seg('.wind-mode .segmented button','windMode',    s.windMode);
        seg('#time-mode-toggle button',    'timeMode',
            s.customRange ? 'range' : (s.year != null ? 'year' : 'climo'));
        seg('#compare-mode-toggle button', 'compareMode', s.compareYear != null ? 'year' : 'ref');
        seg('#compare-style-toggle button', 'compareStyle', s.compareStyle || 'swipe');
        // Checkboxes for overlay toggles + panels + compare.
        const check = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
        check('toggle-coastlines', s.showCoastlines);
        check('toggle-graticule',  s.showGraticule);
        check('toggle-contours',   s.showContours);
        // Contour-overlay row visibility + dropdown selection.
        const cofRow = document.getElementById('contour-field-row');
        if (cofRow) cofRow.hidden = !s.showContours;
        const cofSel = document.getElementById('contour-field-select');
        if (cofSel) cofSel.value = s.contourField || '';
        check('toggle-sun',        s.showSun);
        check('toggle-xsection',   s.showXSection);
        check('toggle-lorenz',     s.showLorenz);
        check('toggle-timeseries', s.showTimeseries);
        check('toggle-compare',    s.compareMode);
        check('toggle-seasonal',   s.seasonal);
        // Seasonal label shows the current 3-month window in parentheses
        // next to the checkbox so users see exactly what they're averaging.
        this._refreshSeasonalLabel();
        // Dropdown selects.
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        set('field-select',        s.field);
        set('month-select',        s.month);
        set('cmap-select',         s.cmap);
        set('ref-period-select',   s.referencePeriod);
        set('climo-period-select', s.climatologyPeriod);
        set('xs-diag-select',      s.xsDiag);
        // Sliders.
        const monthSlider = document.getElementById('month-slider');
        if (monthSlider) monthSlider.value = String(s.month);
        const mapCenter = document.getElementById('map-center-slider');
        if (mapCenter) mapCenter.value = String(s.mapCenterLon);
        const mapCenterVal = document.getElementById('map-center-value');
        if (mapCenterVal) mapCenterVal.textContent = `${Math.round(s.mapCenterLon)}°`;
        // Panels (hidden/shown).
        const xsPanel = document.getElementById('xsection-panel');
        if (xsPanel) xsPanel.hidden = !s.showXSection;
        const lzPanel = document.getElementById('lorenz-panel');
        if (lzPanel) lzPanel.hidden = !s.showLorenz;
        // Time-mode options visibility — mirror the three-way mode.
        const timeMode = s.customRange ? 'range' : (s.year != null ? 'year' : 'climo');
        const climoOpts = document.getElementById('time-climo-options');
        const yearOpts  = document.getElementById('time-year-options');
        const rangeOpts = document.getElementById('time-range-options');
        if (climoOpts) climoOpts.hidden = (timeMode !== 'climo');
        if (yearOpts)  yearOpts.hidden  = (timeMode !== 'year');
        if (rangeOpts) rangeOpts.hidden = (timeMode !== 'range');
        // Custom-range inputs — restore start/end from state when loading a
        // shared URL that carries them. The years-list form (composite
        // builder) leaves the start/end inputs at whatever the user last
        // typed; the composite-details block renders the active composite.
        if (s.customRange && Number.isFinite(s.customRange.start)
                          && Number.isFinite(s.customRange.end)) {
            const rs = document.getElementById('range-start');
            const re = document.getElementById('range-end');
            if (rs) rs.value = String(s.customRange.start);
            if (re) re.value = String(s.customRange.end);
        }
        const cmpYearOpts = document.getElementById('compare-year-options');
        if (cmpYearOpts) cmpYearOpts.hidden = (s.compareYear == null);
        // Re-apply label for the reference-period dropdown and any state-
        // dependent CSS classes (the existing helpers handle this).
        if (this.refreshRefPeriodLabels) this.refreshRefPeriodLabels();
        if (this.applyCompareMode)       this.applyCompareMode();
    }

    refreshVCoordUI() {
        const meta = FIELDS[this.state.field];
        const levelSel = document.getElementById('level-select');
        const disabled = meta.type === 'sl';
        levelSel.disabled = disabled;
        // Explain why the select is inert when the user hovers it — otherwise
        // "the dropdown went grey" looks like a bug on single-level fields.
        levelSel.title = disabled
            ? `${meta.name || this.state.field} is a single-level field (${meta.units || ''}) — it has no vertical structure to pick a level from.`
            : '';
        const wrap = levelSel.closest('.control-group');
        if (wrap) wrap.classList.toggle('is-disabled', disabled);

        this.populateLevelSelect();

        // Update the label on the level group + the segmented toggle buttons.
        const label = document.querySelector('label[for="level-select"], #level-label');
        if (label) label.textContent = (this.state.vCoord === 'theta') ? 'Isentropic level' : 'Pressure level';

        const tgl = document.getElementById('vcoord-toggle');
        if (tgl) {
            tgl.querySelectorAll('button').forEach((btn) => {
                btn.classList.toggle('active', btn.dataset.coord === this.state.vCoord);
                btn.disabled = (btn.dataset.coord === 'pressure' && isThetaOnly(this.state.field));
            });
        }
    }

    // Legacy alias so existing call sites keep working.
    refreshLevelAvailability() { this.refreshVCoordUI(); }

    updateColorbar(field) {
        const cb = document.getElementById('colorbar-canvas');
        // Use the effective cmap from the decomposition so the colorbar
        // matches the painted globe (forced to RdBu_r in eddy/anomaly).
        const effCmap = field.effCmap || this.state.cmap;
        if (cb) fillColorbar(cb, effCmap);
        const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
        // cb-min / cb-max are now <input>s — write to .value (skip when the
        // input is focused so we don't yank a mid-edit cursor) and toggle
        // the override accent style based on which side has a manual value.
        const setInput = (id, text, isOverride) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (document.activeElement !== el) el.value = text;
            el.classList.toggle('is-override', !!isOverride);
        };
        setInput('cb-min', fmtValue(field.vmin), this.state.userVmin != null);
        setInput('cb-max', fmtValue(field.vmax), this.state.userVmax != null);
        const autoBtn = document.getElementById('cb-auto');
        if (autoBtn) autoBtn.classList.toggle('is-active',
            this.state.userVmin != null || this.state.userVmax != null);
        const modeSuffix = {
            zonal:           ' · zonal mean',
            eddy:            ' · eddy',
            anomaly:         ' · anomaly',
            zscore:          ' · σ-anom',
            'std-anomaly':   ' · Δσ',
        }[field.decomposeMode] || '';
        const coordSuffix = (field.type === 'pl')
            ? (this.state.vCoord === 'theta'
                ? ` · θ = ${this.state.theta} K`
                : ` · ${this.state.level} hPa`)
            : '';
        // Period / year suffix in the colorbar title — explicit when not on
        // the default 1991–2020 climatology so the user always knows which
        // tile they're viewing. Composites show the index+threshold label
        // ("RONI ≥ +1.0 · Jan · 8 events") rather than a year range.
        let periodSuffix = '';
        const cr = this.state.customRange;
        if (this.state.year != null) {
            periodSuffix = ` · ${this.state.year}`;
        } else if (cr && cr.label) {
            periodSuffix = ` · ${cr.label} · ${cr.years.length} events`;
        } else if (cr && Number.isFinite(cr.start) && Number.isFinite(cr.end)) {
            periodSuffix = ` · ${cr.start}–${cr.end} mean`;
        } else if (this.state.climatologyPeriod !== 'default') {
            periodSuffix = ` · ${this.state.climatologyPeriod}`;
        }
        set('cb-title', field.name + coordSuffix + periodSuffix + modeSuffix);
        // Standardized anomaly is unit-less (units of σ); the field's
        // native units don't apply once we've divided.
        set('cb-units', field.decomposeMode === 'zscore' ? 'σ' : field.units);
        // Field-level caveat / pedagogical note (e.g. DLS computed from
        // monthly-mean winds underestimates instantaneous shear). Pulled
        // from FIELDS[name].note so any field can surface a one-liner.
        const noteEl = document.getElementById('cb-note');
        if (noteEl) {
            const fieldMeta = FIELDS[this.state.field] || {};
            if (fieldMeta.note) {
                noteEl.textContent = fieldMeta.note;
                noteEl.hidden = false;
            } else {
                noteEl.textContent = '';
                noteEl.hidden = true;
            }
        }
        // Sub-title under the colorbar: when an independent contour-overlay
        // field is active, name it + its interval so the second ink isn't
        // mystery isolines. ("contours: Geopotential 500 hPa, every 60 m")
        const sub = document.getElementById('cb-sub');
        if (sub) {
            const cof = this.state.contourField;
            if (this.state.showContours && cof && cof !== this.state.field) {
                const om = FIELDS[cof] || {};
                const interval = om.contour;
                sub.textContent = `contours: ${om.name}${interval ? `, every ${interval} ${om.units || ''}` : ''}`.trim();
                sub.hidden = false;
            } else {
                sub.textContent = '';
                sub.hidden = true;
            }
        }
    }

    // ── render loop ──────────────────────────────────────────────────
    animate() {
        const tick = () => {
            this.controls.update();
            if (this.state.windMode === 'particles' && this.particles
                && !this._interactingControls) this.particles.step();
            // Lagrangian parcels only step when there are active ones and
            // when the globe is the active view.
            if (this.state.viewMode === 'globe' &&
                this.parcels && this.parcels.hasActive()) {
                this.parcels.step(this.state.month);
            }
            // Diurnal spin on the mini-Earth in orbit mode — purely cosmetic
            // (the data is monthly climatology, so there's no "real" time of
            // day), but the rotation sells the "this is a planet" effect.
            if (this.state.viewMode === 'orbit' && this.orbit) {
                this.spinAngle = (this.spinAngle + 0.012) % (Math.PI * 2);
                this.orbit.update(this.state.month, this.spinAngle, this.camera);
            }
            this.renderer.render(this.scene, this.camera);
            // Reposition swipe-compare period labels every frame so they
            // track camera zoom / central-meridian shift / divider drag.
            // No-op when compare is off (early return inside the helper).
            if (this.state.compareMode) this.updateCompareLabels();
            requestAnimationFrame(tick);
        };
        tick();
    }
}

function fmtValue(v) {
    if (Math.abs(v) >= 1000) return v.toFixed(0);
    if (Math.abs(v) >= 10)   return v.toFixed(1);
    return v.toFixed(2);
}

const mount = document.getElementById('globe-mount');
if (mount) {
    // TC-ATLAS embedding: expose the instance on window so the parent page
    // can attach overlays (track_overlay.js), read state, and subscribe to
    // 'field-updated' events. In stand-alone GC-ATLAS this is harmless.
    window.envGlobe = new GlobeApp(mount);
}
