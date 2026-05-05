// GC-ATLAS — ERA5 tile loader (async fetch + in-memory cache).
// Serves real ERA5 climatology tiles to the globe, with a subscribe-on-ready
// pattern so callers can keep a synchronous API: they get synthetic data until
// the real tile lands, then we fire an event and they re-render.

// TC-ATLAS vendor fork: GC-ATLAS upstream falls back to `data/tiles/...`
// on localhost so the dev server can use a local tile checkout. TC-ATLAS
// never ships local tiles — always read from gs://gc-atlas-era5 over HTTPS,
// regardless of host (localhost, GitHub Pages, prod). The bucket has CORS
// open so cross-origin fetches just work.
const IS_LOCAL = false;

// Multi-period tile trees. The 'default' period is our 1991-2020 climatology
// (present from day 1). Additional periods (e.g. '1961-1990') get their own
// cache + manifest so reference-period anomalies can be computed without
// confusing the primary loader.
function tileBaseFor(period) {
    // Literal alias for the 1991-2020 tile tree so callers can refer to it
    // unambiguously (the 'default' sentinel resolves to whatever the user
    // has chosen as the active climatology, which can be 1961-1990).
    if (period === 'default' || period === '1991-2020') {
        return IS_LOCAL ? 'data/tiles' : 'https://storage.googleapis.com/gc-atlas-era5/tiles';
    }
    if (period === 'per_year') {
        // The per-year tree spans the merged 1991 → present span (raw +
        // raw_2021_*) and is keyed by both year and month. Tiles are
        // float16+gzip per pipeline/compress_tiles.py.
        return IS_LOCAL ? 'data/tiles_per_year' : 'https://storage.googleapis.com/gc-atlas-era5/tiles_per_year';
    }
    // Period like '1961-1990' → folder 'tiles_1961_1990'.
    const folder = `tiles_${period.replace('-', '_')}`;
    return IS_LOCAL ? `data/${folder}` : `https://storage.googleapis.com/gc-atlas-era5/${folder}`;
}

const manifests = new Map();    // period → manifest JSON (or null while loading)
const cache = new Map();        // key (with period prefix) → { values } | 'pending'
const subscribers = new Set();  // fns({ name, month, level, period })
// Tile-progress subscribers — fire on every fetch start + complete so the
// loading overlay can show "X of Y tiles loaded" instead of an indefinite
// spinner. `totalThisBatch` resets to the current pending count whenever
// pending falls to 0 (i.e., between user-driven load bursts), so a gallery
// tile click that kicks off 24 fetches reports "0 → 24" cleanly rather
// than accumulating forever.
const progressSubscribers = new Set();
let tilesPending = 0;
let tilesInBatch = 0;
function notifyProgress() {
    for (const fn of progressSubscribers) {
        fn({ pending: tilesPending, total: tilesInBatch });
    }
}
export function onTileProgress(fn) {
    progressSubscribers.add(fn);
    return () => progressSubscribers.delete(fn);
}

// Back-compat: many callers still reference `manifest` as the default tree.
// Keep a getter that returns the default-period manifest.
let manifest = null;

// Active climatology period — the tree that callers get when they don't
// pass an explicit `period` (or pass the legacy 'default' sentinel). UI sets
// this via setActivePeriod(); reference-period anomaly callers continue to
// pass an explicit period (e.g. '1961-1990') and bypass this lookup.
let activePeriod = 'default';
export function setActivePeriod(p) { activePeriod = p || 'default'; }
export function getActivePeriod() { return activePeriod; }
function resolvePeriod(p) { return (p == null || p === 'default') ? activePeriod : p; }
// Map the active-period sentinel back to its literal label so reference
// dropdowns can show "Self · 1991-2020" / "Self · 1961-1990" honestly.
export function activePeriodLabel() {
    if (activePeriod === 'default' || activePeriod === '1991-2020') return '1991–2020';
    if (activePeriod === '1961-1990') return '1961–1990';
    return activePeriod;
}

const pad = (n) => String(n).padStart(2, '0');
// Cache key includes period + kind + year so a single field can hold
// mean/std, multiple base periods, and any number of individual years
// concurrently for the same (month, level).
const keyOf = (name, month, level, kind = 'mean', period = 'default', year = null) =>
    level == null
        ? `${period}|${name}|sl|${month}|${year ?? '_'}|${kind}`
        : `${period}|${name}|${level}|${month}|${year ?? '_'}|${kind}`;

// Build the URL for a tile. Honours per-year naming (year_month) and the
// f16-gz encoding (.bin.gz extension) declared in the variable's manifest.
function tilePathFor(meta, group, name, level, month, kind, period, year) {
    const base = tileBaseFor(period);
    const ext = meta.encoding === 'f16-gz' ? '.bin.gz' : '.bin';
    if (period === 'per_year' && year != null) {
        if (meta.levels) return `${base}/${group}/${name}/${level}_${year}_${pad(month)}${ext}`;
        return `${base}/${group}/${name}/${year}_${pad(month)}${ext}`;
    }
    const stdPrefix = kind === 'std' ? 'std_' : '';
    if (meta.levels) return `${base}/${group}/${name}/${stdPrefix}${level}_${pad(month)}${ext}`;
    return `${base}/${group}/${name}/${stdPrefix}${pad(month)}${ext}`;
}

// Per-tile metadata key (matches the pipeline's tile basename).
function tileMetaKey(meta, level, month, period, year) {
    if (period === 'per_year' && year != null) {
        return meta.levels ? `${level}_${year}_${pad(month)}` : `${year}_${pad(month)}`;
    }
    return meta.levels ? `${level}_${pad(month)}` : `${pad(month)}`;
}

/** Load the manifest for a period (default or a reference). Returns true if found. */
export async function loadManifest(period = 'default') {
    if (manifests.has(period) && manifests.get(period)) {
        if (period === 'default') manifest = manifests.get(period);
        return true;
    }
    try {
        const resp = await fetch(`${tileBaseFor(period)}/manifest.json`, { cache: 'no-cache' });
        if (!resp.ok) {
            manifests.set(period, null);
            return false;
        }
        const m = await resp.json();
        manifests.set(period, m);
        // Alias the literal '1991-2020' name to the same manifest as
        // 'default' (and vice versa) so callers can ask for the current
        // climatology by its proper name.
        if (period === 'default') {
            manifest = m;
            manifests.set('1991-2020', m);
        } else if (period === '1991-2020') {
            if (!manifests.get('default')) manifests.set('default', m);
            if (!manifest) manifest = m;
        }
        return true;
    } catch (_err) {
        manifests.set(period, null);
        return false;
    }
}

export function isReady(period = 'default') { return !!manifests.get(period); }

/** Read-only view of a loaded manifest (or null). For UI code that wants to
 *  enumerate available years / levels / vars without round-tripping fetch. */
export function getManifest(period = 'default') { return manifests.get(period) || null; }

/** Return { group, meta } for a short name in a given period's manifest. */
// Synthetic fields registered by setFieldCache that don't exist in any
// manifest — e.g. the climatology globe's 'corr' (Pearson r maps). The
// meta here is just enough to satisfy resolveField + requestField:
// shape from a sample tile, units / long_name carried verbatim. Keyed
// by name.
const syntheticFields = new Map();

function resolveField(name, period = 'default') {
    const m = manifests.get(period);
    if (m) {
        for (const [group, vars_] of Object.entries(m.groups)) {
            if (vars_[name]) return { group, meta: vars_[name] };
        }
    }
    // Synthetic fallback — same shape as a manifest hit so the rest of
    // the pipeline (requestField → cache lookup → return) works as-is.
    const syn = syntheticFields.get(name);
    if (syn) return { group: '_synthetic', meta: syn };
    return null;
}

/** Short names the manifest currently lists. */
export function availableFields() {
    if (!manifest) return [];
    const out = [];
    for (const vars_ of Object.values(manifest.groups)) {
        for (const name of Object.keys(vars_)) out.push(name);
    }
    return out;
}

/** Levels present for a pressure-level variable (or null). */
export function availableLevels(name) {
    const r = resolveField(name);
    return r && r.meta.levels ? r.meta.levels.slice() : null;
}

/** Cached-only lookup — no fetch side-effect. Returns Float32Array | null.
 *  `seasonal: true` returns the NaN-safe pointwise mean of the three tiles
 *  centered on `month` (wrapping at Dec). If any of the three is missing,
 *  returns null — caller should treat that as "not ready yet" and retry
 *  on the next tile-loaded event. */
export function cachedMonth(name, month, level = null, kind = 'mean', period = 'default', year = null, seasonal = false) {
    if (seasonal) {
        const prev = ((month + 10) % 12) + 1;
        const next = (month %  12) + 1;
        const a = cachedMonth(name, prev,  level, kind, period, year, false);
        const b = cachedMonth(name, month, level, kind, period, year, false);
        const c = cachedMonth(name, next,  level, kind, period, year, false);
        if (!a || !b || !c) return null;
        const N = b.length;
        const out = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            let s = 0, n = 0;
            if (Number.isFinite(a[i])) { s += a[i]; n += 1; }
            if (Number.isFinite(b[i])) { s += b[i]; n += 1; }
            if (Number.isFinite(c[i])) { s += c[i]; n += 1; }
            out[i] = n > 0 ? s / n : NaN;
        }
        return out;
    }
    const eff = resolvePeriod(period);
    const r = resolveField(name, eff);
    if (!r) return null;
    const useLevel = r.meta.levels ? level : null;
    const hit = cache.get(keyOf(name, month, useLevel, kind, eff, year));
    return hit && hit !== 'pending' ? hit.values : null;
}

/**
 * Return the field synchronously if cached; otherwise kick off a fetch,
 * return null, and notify subscribers when the tile arrives.
 */
export function requestField(name, { month, level, kind = 'mean', period = 'default', year = null } = {}) {
    const eff = resolvePeriod(period);
    const r = resolveField(name, eff);
    if (!r) return null;
    const useLevel = r.meta.levels ? level : null;
    const key = keyOf(name, month, useLevel, kind, eff, year);
    const hit = cache.get(key);
    if (hit && hit !== 'pending') {
        // Aggregate-across-cached-months only makes sense for climatology
        // tiles; per-year tiles are single snapshots, so use the per-tile
        // range directly.
        // Pool vmin/vmax across all 12 months of the same (name, level,
        // kind, period, year) slice. Works for climatology (year=null)
        // AND single-year (year=YYYY) so the colorbar doesn't shift as
        // the user scrubs months within a fixed year.
        const agg = aggregateStats(name, useLevel, kind, eff, year);
        return {
            values: hit.values,
            vmin: agg ? agg.vmin : hit.vmin,
            vmax: agg ? agg.vmax : hit.vmax,
            shape: r.meta.shape,
            units: r.meta.units,
            long_name: r.meta.long_name,
            lat_descending: r.meta.lat_descending,
            isReal: true,
            kind,
            period: eff,
            year,
        };
    }
    if (!hit) {
        // Synthetic fields (e.g., 'corr' from the Index Correlation panel)
        // only ever exist via setFieldCache — they're computed client-side
        // and do not have any tile path on GCS. Skipping the fetch here
        // avoids a 404 storm any time the cache miss matches: e.g., when
        // the user changes the active climatology period after computing
        // a correlation, or when the GIF exporter scrubs to a month that
        // hasn't been computed yet (the beforeAnnualFrame hook will fill
        // it in shortly).
        if (r.group !== '_synthetic') {
            fetchTile(name, r.group, r.meta, month, useLevel, kind, eff, year);
        }
    }
    return null;
}

async function fetchTile(name, group, meta, month, level, kind = 'mean', period = 'default', year = null) {
    const key = keyOf(name, month, level, kind, period, year);
    cache.set(key, 'pending');
    const url = tilePathFor(meta, group, name, level, month, kind, period, year);
    // Progress: reset the batch total if we were idle, otherwise add to it.
    if (tilesPending === 0) tilesInBatch = 0;
    tilesPending += 1;
    tilesInBatch += 1;
    notifyProgress();
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        let values;
        if (meta.encoding === 'f16-gz') {
            // Stream-decompress gzip → uint16 → dequantize to float32 using
            // per-tile vmin/vmax recorded in meta.tiles by compress_tiles.py.
            const decompressed = resp.body.pipeThrough(new DecompressionStream('gzip'));
            const buf = await new Response(decompressed).arrayBuffer();
            const u16 = new Uint16Array(buf);
            const tk = tileMetaKey(meta, level, month, period, year);
            const t = meta.tiles?.[tk];
            if (!t) throw new Error(`no per-tile metadata for ${tk}`);
            const range = (t.vmax - t.vmin) / 65534;
            values = new Float32Array(u16.length);
            for (let i = 0; i < u16.length; i++) {
                values[i] = u16[i] === 0xFFFF ? NaN : t.vmin + u16[i] * range;
            }
        } else {
            const buf = await resp.arrayBuffer();
            values = new Float32Array(buf);
        }
        // Apply the same unit conversions to std tiles — std of a linear
        // transform is the same transform of the std (modulo abs sign), so
        // multiplying by 1000 (q) or dividing by DAY (radiative fluxes) is
        // valid for both mean and std variants.
        applyUnitConversions(name, values);
        // Per-tile colorbar range. For most fields we use the true min/max,
        // but a few (vorticity, divergence, vertical velocity, precipitation)
        // are dominated by isolated topographic / convective spikes that
        // squash the colorbar — for those we use a percentile clamp set in
        // the FIELDS metadata as `clamp: { lo, hi }` (fractions in [0,1]).
        const clamp = CLAMPS.get(name);
        let vmin, vmax;
        if (clamp) {
            [vmin, vmax] = percentileBounds(values, clamp.lo, clamp.hi);
        } else {
            vmin = Infinity; vmax = -Infinity;
            for (let i = 0; i < values.length; i++) {
                const v = values[i];
                if (v < vmin) vmin = v;
                if (v > vmax) vmax = v;
            }
        }
        cache.set(key, { values, vmin, vmax });
        for (const fn of subscribers) fn({ name, month, level, period, year });
    } catch (err) {
        console.warn(`[era5] tile failed ${url}:`, err);
        cache.delete(key);
    }
    // Progress: decrement and notify regardless of success/failure so a
    // 404'd tile doesn't leave the counter stuck below zero.
    tilesPending = Math.max(0, tilesPending - 1);
    notifyProgress();
}

// Per-field percentile clamp registry, populated lazily on first request from
// FIELDS metadata (avoids a circular import). Set by registerClamps() below.
const CLAMPS = new Map();
export function registerClamps(fields) {
    for (const [name, meta] of Object.entries(fields)) {
        if (meta.clamp) CLAMPS.set(name, meta.clamp);
    }
}

/** NaN-safe percentile bounds. Sorts a copy of finite values; returns
 *  [lo-percentile, hi-percentile]. lo, hi as fractions in [0, 1]. */
function percentileBounds(values, lo, hi) {
    const finite = [];
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (Number.isFinite(v)) finite.push(v);
    }
    if (finite.length === 0) return [0, 1];
    finite.sort((a, b) => a - b);
    const idxLo = Math.max(0, Math.min(finite.length - 1, Math.floor(lo * (finite.length - 1))));
    const idxHi = Math.max(0, Math.min(finite.length - 1, Math.floor(hi * (finite.length - 1))));
    return [finite[idxLo], finite[idxHi]];
}

export function onFieldLoaded(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

/** Inject a pre-computed Float32Array into the field cache, then notify
 *  the same `field-loaded` subscribers a fetched tile would have. Used by
 *  features that synthesize fields client-side (correlation maps, custom
 *  composites) so they can share the engine's colormap / contour / save
 *  / GIF pipeline without re-implementing it. vmin/vmax may be passed
 *  explicitly; if omitted, finite-range is computed here.
 *
 *  Also registers a synthetic-field meta so resolveField finds the name
 *  even though it isn't in any GCS manifest — without this, getField
 *  returns a pendingField (isReal:false) and the loading overlay never
 *  hides. shape / units / long_name come from FIELDS metadata if the
 *  caller supplies them, else are inferred from the values array length.
 */
export function setFieldCache(name, { month, level = null, kind = 'mean', period = 'default', year = null,
                                       values, vmin, vmax,
                                       shape, units = '', long_name = '',
                                       lat_descending = true } = {}) {
    if (!values) return;
    const key = keyOf(name, month, level, kind, period, year);
    if (vmin == null || vmax == null) {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (Number.isFinite(v)) {
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
        }
        if (vmin == null) vmin = Number.isFinite(lo) ? lo : 0;
        if (vmax == null) vmax = Number.isFinite(hi) ? hi : 1;
    }
    // Register a synthetic-field meta on first inject. Shape is taken
    // from any concurrently-cached real field (so synthetic 'corr'
    // inherits the active grid) or sniffed from the values length.
    if (!syntheticFields.has(name)) {
        let inferredShape = shape;
        if (!inferredShape) {
            // Sniff shape from any cached real-field tile — they all share
            // the active grid.
            for (const [, val] of cache) {
                if (val && val.values && val.values.length === values.length
                    && val._shape) {
                    inferredShape = val._shape;
                    break;
                }
            }
            if (!inferredShape) {
                // Last resort: derive from manifest if present.
                const anyManifest = manifests.get('default') || manifests.get('per_year');
                if (anyManifest) {
                    for (const grp of Object.values(anyManifest.groups || {})) {
                        for (const v of Object.values(grp)) {
                            if (Array.isArray(v.shape) && v.shape[0] * v.shape[1] === values.length) {
                                inferredShape = v.shape;
                                break;
                            }
                        }
                        if (inferredShape) break;
                    }
                }
            }
        }
        syntheticFields.set(name, {
            shape: inferredShape || [181, 360],
            units, long_name, lat_descending,
            // levels: null marks a single-level field. Synthetic fields
            // don't currently support pressure-level injection.
            levels: null,
        });
    }
    cache.set(key, { values, vmin, vmax });
    for (const fn of subscribers) fn({ name, month, level, period, year });
}

/** Aggregate vmin/vmax across every cached month at (name, level, kind,
 *  period, year). Restricting by year lets single-year mode pool stats
 *  across THAT year's months only — so the colorbar stops jumping as
 *  the user scrubs months within a fixed year. Climatology mode (year
 *  null) restricts to climatology entries (year token '_'), which also
 *  prevents per-year extremes from polluting the climo colorbar. */
function aggregateStats(name, level, kind = 'mean', period = 'default', year = null) {
    const prefix = level == null
        ? `${period}|${name}|sl|`
        : `${period}|${name}|${level}|`;
    const yearToken = year != null ? String(year) : '_';
    const suffix = `|${yearToken}|${kind}`;
    let vmin = Infinity, vmax = -Infinity, any = false;
    for (const [key, val] of cache.entries()) {
        if (!val || typeof val !== 'object') continue;
        if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
        if (val.vmin < vmin) vmin = val.vmin;
        if (val.vmax > vmax) vmax = val.vmax;
        any = true;
    }
    return any ? { vmin, vmax } : null;
}

/** Kick off fetches for many months in parallel (for the "play" seasonal cycle). */
export function prefetchField(name, { level = null, months = [1,2,3,4,5,6,7,8,9,10,11,12], kind = 'mean', period = 'default', year = null } = {}) {
    const eff = resolvePeriod(period);
    const r = resolveField(name, eff);
    if (!r) return;
    // Synthetic fields don't have GCS tiles — never prefetch (mirror the
    // requestField guard above).
    if (r.group === '_synthetic') return;
    if (kind === 'std' && r.meta.has_std === false) return;
    // Derived-σ vars (wspd / mse / dls) declare has_mean: false in their
    // manifest entry — the mean is computed client-side from components,
    // so chasing a non-existent mean tile would 404-loop. Guard here.
    if (kind === 'mean' && r.meta.has_mean === false) return;
    const useLevel = r.meta.levels ? level : null;
    for (const m of months) {
        const key = keyOf(name, m, useLevel, kind, eff, year);
        if (!cache.has(key)) fetchTile(name, r.group, r.meta, m, useLevel, kind, eff, year);
    }
}

// ── per-variable unit normalisations ─────────────────────────────────────
// Applied once at tile load, before caching, so all downstream code sees
// values in the units advertised in data.js FIELDS metadata.
const G   = 9.80665;
const DAY = 86400;
const RADIATIVE_FLUX_VARS = new Set(['sshf', 'slhf', 'ssr', 'str', 'tisr', 'ttr']);

function applyUnitConversions(name, values) {
    const n = values.length;
    if (name === 'z' || name === 'oro') {
        // ERA5 geopotential (m² s⁻²) → geopotential height (m).
        // 'oro' is the surface geopotential (model orography invariant).
        for (let i = 0; i < n; i++) values[i] /= G;
    } else if (name === 'msl' || name === 'sp') {
        // Pa → hPa
        for (let i = 0; i < n; i++) values[i] /= 100;
    } else if (name === 'tp') {
        // Monthly means provide m per day — convert to mm/day.
        for (let i = 0; i < n; i++) values[i] *= 1000;
    } else if (RADIATIVE_FLUX_VARS.has(name)) {
        // Monthly means provide J m⁻² per day — convert to W m⁻².
        for (let i = 0; i < n; i++) values[i] /= DAY;
    } else if (name === 'ews') {
        // Eastward turbulent surface stress: monthly mean in N m⁻² s
        // (accumulated over a day). Divide by DAY to get instantaneous N m⁻².
        for (let i = 0; i < n; i++) values[i] /= DAY;
    } else if (name === 'q') {
        // kg/kg → g/kg (typical surface tropics ≈ 18 g/kg, stratosphere ≈ 0)
        for (let i = 0; i < n; i++) values[i] *= 1000;
    } else if (name === 'd' || name === 'vo') {
        // s⁻¹ → 10⁻⁵ s⁻¹ (gen-circ teaching unit; mid-trop ζ scales ~10⁻⁵)
        for (let i = 0; i < n; i++) values[i] *= 1e5;
    } else if (name === 'chi' || name === 'psi') {
        // m² s⁻¹ → 10⁶ m² s⁻¹ ("Mm²/s") for readability. 200 hPa ψ peaks
        // at ±100 Mm²/s; χ peaks ~±10 Mm²/s.
        for (let i = 0; i < n; i++) values[i] /= 1e6;
    } else if (name === 'pv') {
        // K m² kg⁻¹ s⁻¹ → PVU (1 PVU = 10⁻⁶ K m² kg⁻¹ s⁻¹). Tropopause sits
        // around 2 PVU; stratospheric values reach 10+ PVU.
        for (let i = 0; i < n; i++) values[i] *= 1e6;
    }
}
