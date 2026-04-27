// GC-ATLAS — URL state (de)serialization.
//
// Every pedagogically-relevant piece of state gets a short key in the URL
// hash so a copy-pasted link re-creates the exact figure on page load.
// Hash (not query) to avoid server round-trips on a static site and to
// skip browser-history spam when writing changes.
//
// Keys are abbreviated ("f" not "field") so URLs stay short enough to drop
// into a tweet or a slide footer. Unknown keys are ignored; malformed
// values fall back to the default — sharing an old URL against a newer
// build degrades gracefully instead of throwing.

import { FIELDS, LEVELS, THETA_LEVELS } from './data.js';
import { COLORMAPS } from './colormap.js';

// Each entry: [stateKey, urlKey, serialize, deserialize]
// `serialize(value)` returns a string or null (→ omit from URL).
// `deserialize(string)` returns a value or undefined (→ skip patch).
const SPEC = [
    // ── view + scalar selectors ────────────────────────────────────
    ['viewMode',           'v',
        v => ['globe','map','orbit'].includes(v) ? v[0] : null,
        s => ({ g:'globe', m:'map', o:'orbit' }[s])],
    ['field',              'f',
        v => v,
        s => (s in FIELDS) ? s : undefined],
    ['vCoord',             'vc',
        v => v === 'theta' ? 't' : 'p',
        s => s === 't' ? 'theta' : 'pressure'],
    ['level',              'L',
        v => String(v),
        s => { const n = Number(s); return LEVELS.includes(n) ? n : undefined; }],
    ['theta',              'th',
        v => String(v),
        s => { const n = Number(s); return THETA_LEVELS.includes(n) ? n : undefined; }],
    ['month',              'm',
        v => String(v),
        s => { const n = Number(s); return (n >= 1 && n <= 12) ? n : undefined; }],
    ['year',               'y',
        v => v == null ? null : String(v),
        s => {
            if (s === '' || s === 'null') return null;
            const n = Number(s); return Number.isFinite(n) ? n : undefined;
        }],
    ['customRange',        'cr',
        // Two shapes serialize here:
        //   contiguous range   → "2010-2024"
        //   index composite    → "c:<id>:<cmp>:<threshold>:<month>"
        //   e.g. "c:roni:ge:1.0:1"  →  RONI ≥ +1.0 in January
        // Null / unrecognized shape → omitted from URL (falls back to
        // climatology on the other side).
        v => {
            if (v == null) return null;
            if (v.id && v.cmp && Number.isFinite(v.threshold) && Number.isFinite(v.month)) {
                return `c:${v.id}:${v.cmp}:${v.threshold}:${v.month}`;
            }
            if (Number.isFinite(v.start) && Number.isFinite(v.end)) {
                return `${v.start}-${v.end}`;
            }
            return null;
        },
        s => {
            if (!s) return undefined;
            if (s.startsWith('c:')) {
                // id:cmp:threshold:month — years come later once indices.json
                // loads (see globe.js bootstrap). Frontend treats the empty
                // years list as "still resolving".
                const parts = s.slice(2).split(':');
                if (parts.length !== 4) return undefined;
                const [id, cmp, tStr, mStr] = parts;
                const threshold = Number(tStr);
                const month = Number(mStr);
                if (!['ge','le'].includes(cmp)) return undefined;
                if (!Number.isFinite(threshold) || !Number.isFinite(month)) return undefined;
                if (month < 1 || month > 12) return undefined;
                return { id, cmp, threshold, month, years: [] };
            }
            const m = /^(\d{4})-(\d{4})$/.exec(s);
            if (!m) return undefined;
            const start = Number(m[1]), end = Number(m[2]);
            return (end >= start && start >= 1900 && end <= 2100)
                ? { start, end }
                : undefined;
        }],
    ['cmap',               'cm',
        v => v,
        s => COLORMAPS.includes(s) ? s : undefined],
    ['kind',               'k',
        v => v === 'std' ? 's' : 'm',
        s => s === 's' ? 'std' : 'mean'],
    ['climatologyPeriod',  'cp',
        v => v === 'default' ? null : v,
        s => s],
    ['referencePeriod',    'rp',
        v => v === 'default' ? null : v,
        s => s],
    ['decompose',          'd',
        v => v === 'total' ? null : v,
        s => ['total','zonal','eddy','anomaly','zscore'].includes(s) ? s : undefined],
    // 3-month centered seasonal mean, anchored on state.month. On → DJF
    // when month=1, JJA when month=7, NDJ when month=12. Ignored by
    // advanced cross-section diagnostics (psi, M, ug, N², EP flux,
    // budgets) — only applies to field display + field cross-section.
    ['seasonal',           'sn',  v => v ? '1' : null, s => s === '1'],

    // ── compare overlay (map view) ─────────────────────────────────
    ['compareMode',        'cmp',
        v => v ? '1' : null,
        s => s === '1'],
    ['compareSplit',       'cs',
        v => v == null || v === 0.5 ? null : (Math.round(v * 1000) / 1000).toString(),
        s => { const n = Number(s); return (Number.isFinite(n) && n >= 0 && n <= 1) ? n : undefined; }],
    ['compareStyle',       'cst2',
        v => v === 'swipe' ? null : v,
        s => ['swipe', 'diff'].includes(s) ? s : undefined],
    ['compareYear',        'cy',
        v => v == null ? null : String(v),
        s => { const n = Number(s); return Number.isFinite(n) ? n : undefined; }],

    // ── manual colorbar overrides ──────────────────────────────────
    ['userVmin',           'cbmin',
        v => v == null ? null : String(v),
        s => { const n = Number(s); return Number.isFinite(n) ? n : undefined; }],
    ['userVmax',           'cbmax',
        v => v == null ? null : String(v),
        s => { const n = Number(s); return Number.isFinite(n) ? n : undefined; }],
    ['xsUserVmin',         'xscbmin',
        v => v == null ? null : String(v),
        s => { const n = Number(s); return Number.isFinite(n) ? n : undefined; }],
    ['xsUserVmax',         'xscbmax',
        v => v == null ? null : String(v),
        s => { const n = Number(s); return Number.isFinite(n) ? n : undefined; }],

    // ── map central meridian ───────────────────────────────────────
    ['mapCenterLon',       'mc',
        v => v === 0 ? null : String(v),
        s => { const n = Number(s); return (Number.isFinite(n) && n >= -180 && n <= 180) ? n : undefined; }],

    // ── visual overlays (0/1) ──────────────────────────────────────
    ['showCoastlines',     'cst', v => v ? null : '0', s => s !== '0'],
    ['showGraticule',      'grt', v => v ? null : '0', s => s !== '0'],
    ['showContours',       'ctr', v => v ? '1' : null, s => s === '1'],
    ['slidingClimo',       'sc',  v => v ? null : '0', s => s !== '0'],   // default true
    ['contourField',       'cof',
        v => v == null ? null : v,
        s => (s in FIELDS) ? s : undefined],
    ['showSun',            'sun', v => v ? null : '0', s => s !== '0'],
    ['windMode',           'wm',
        v => v === 'particles' ? null : v,
        s => ['off','particles','barbs'].includes(s) ? s : undefined],

    // ── panels ─────────────────────────────────────────────────────
    ['showXSection',       'xs',  v => v ? '1' : null, s => s === '1'],
    ['showLorenz',         'lz',  v => v ? '1' : null, s => s === '1'],
    ['xsDiag',             'xd',
        v => v === 'field' ? null : v,
        s => ['field','psi','M','ug','N2','epflux','mbudget','qbudget','hbudget'].includes(s) ? s : undefined],
];

/** Encode a state snapshot as a URL hash (without the leading '#'). */
export function encodeStateToHash(state) {
    const params = new URLSearchParams();
    for (const [stateKey, urlKey, serialize] of SPEC) {
        const s = serialize(state[stateKey]);
        if (s != null) params.set(urlKey, s);
    }
    return params.toString();
}

/** Parse a URL hash (with or without leading '#') into a state patch.
 *  Unknown keys and malformed values are silently dropped. */
export function decodeHashToPatch(hash) {
    const clean = (hash || '').replace(/^#/, '');
    if (!clean) return {};
    const params = new URLSearchParams(clean);
    const patch = {};
    for (const [stateKey, urlKey, _serialize, deserialize] of SPEC) {
        if (!params.has(urlKey)) continue;
        const raw = params.get(urlKey);
        const v = deserialize(raw);
        if (v !== undefined) patch[stateKey] = v;
    }
    return patch;
}

/** Replace the current URL hash without adding a history entry. */
export function writeHashDebounced(state, delay = 250) {
    clearTimeout(writeHashDebounced._t);
    writeHashDebounced._t = setTimeout(() => {
        const h = encodeStateToHash(state);
        const url = `${location.pathname}${location.search}${h ? '#' + h : ''}`;
        history.replaceState(null, '', url);
    }, delay);
}
