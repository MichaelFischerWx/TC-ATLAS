/* realtime_experimental.js — RT Monitor "Experimental" tabs.
 *
 * ONE module, TWO model profiles — same panels, same JSON contract, different
 * producer:
 *
 *   #experimental     GHOST Stage-0/1 ML diagnostics (recon-independent
 *                     Vmax/Pmin/RMW from geostationary IR + SHIPS
 *                     environment), TC-SWARM realtime/ghost_rt -> ghost-rt/.
 *   #experimental_v2  FPM v1.0, the first-principles Pmin model (a different
 *                     architecture on the same IR frames: ridge on physical
 *                     predictors under a memory kernel, not a boosted-tree
 *                     stack). TC-SWARM realtime/fpm_rt -> fpm-rt/. Unlisted
 *                     link — no tab button.
 *
 * Both publish to gs://tc-atlas-ir-cache/ and mirror to Cloudflare R2; read
 * here from https://cdn.tcatlas.org/ (free egress, edge-cached) with GCS as
 * the fallback. Research guidance, NOT an official forecast or analysis.
 *
 * Panels are driven by the active profile (see PROFILES below) rather than
 * forked into a second file, so panel work keeps reaching both pages. Where a
 * profile lacks a quantity (FPM has no RMW — that is GHOST Stage-1, a
 * different model), the panel is gated off rather than rendered empty.
 *
 * Lazy-loaded on first tab activation (see _lazyViewMods in
 * realtime_ir.html). Public API: window.activateExperimentalView(profileKey).
 */
(function () {
    'use strict';

    /* Read route (2026-08-03). These objects used to be pulled straight off
       storage.googleapis.com, which made every viewer a paid GCS egress event
       ($0.12/GB) -- the last public data path on the site that never got the
       R2/Cloudflare treatment. The publisher (TC-SWARM ghost_rt_all.upload)
       now mirrors every object to R2, so reads come off cdn.tcatlas.org where
       egress is free and the edge caches them. GCS_BASE is retained purely as
       a fallback: if a mirror write ever fails, the object is still on GCS and
       the tab keeps working (at the old cost) instead of breaking. */
    var CDN_BASE = 'https://cdn.tcatlas.org/';
    var GCS_BASE = 'https://storage.googleapis.com/tc-atlas-ir-cache/';

    /* ---------------- model profiles ----------------
       Everything that differs between the GHOST page and the FPM page lives
       here. `arch` is season-scoped on purpose — bump it for a new season
       once that season's first archived storm exists. `file` is the per-storm
       object stem: <prefix>/<file><ATCF>.json.

       `panels.rmw` gates the size panel/tile/trace: GHOST predicts RMW in
       Stage-1, FPM does not model size at all, and an empty third panel would
       read as a broken feed rather than an absent quantity.

       `windIsDerived` marks a profile whose Vmax is not a wind model but a
       pressure-wind relationship applied to the model's own Pmin. That has to
       be visible in the UI — a WPR wind inherits the pressure error and adds
       its own, and reading it as a peer of GHOST's Vmax would overstate it. */
    var PROFILES = {
        ghost: {
            key: 'ghost',
            prefix: 'ghost-rt',
            arch: 'ghost-rt/archive2026',
            file: 'ghost_',
            name: 'GHOST',
            color: '#f43f5e',
            title: 'GHOST — ML Structure Diagnostics',
            headline: 'vmax_kt',
            windIsDerived: false,
            /* Vmax saturates near 150-160 kt (isotonic cap + Cat-5 handoff ramp).
               A pressure model has no such ceiling. */
            saturates: true,
            panels: { rmw: true, shap: true, dist: true, track: true,
                      comp: true }
        },
        fpm: {
            key: 'fpm',
            prefix: 'fpm-rt',
            arch: 'fpm-rt/archive2026',
            file: 'fpm_',
            name: 'FPM',
            /* Indigo against GHOST's rose: the two pages are meant to be
               opened side by side, so the traces must not read as the same
               model at a glance. */
            color: '#6366f1',
            title: 'FPM v1.0 — First-Principles Pressure Model',
            headline: 'pmin_hpa',
            windIsDerived: true,
            saturates: false,
            /* Basins where the model runs but was NOT part of the frozen
               v1.0 validation. Shown with estimates, carrying a standing
               disclaimer on every storm — the alternative (hiding them) makes
               the storm list silently disagree with the rest of the site.
               Keyed by ATCF basin prefix; the producer may override per storm
               with a `caveat` string in the payload. */
            provisional: {
                WP: 'West Pacific estimates are <strong>provisional</strong>. ' +
                    'FPM v1.0 was frozen on Atlantic and East/Central Pacific ' +
                    'boards only — this basin has no held-out board, no ' +
                    'aircraft-anchored verification of any kind, and its ' +
                    'training frames are mid-rebuild following an imagery ' +
                    'quality-control change. Read these as experimental ' +
                    'within an already-experimental product.'
            },
            /* Same panel set as GHOST except `rmw`, and that one is a real
               absence rather than a producer gap: FPM models pressure and
               nothing else, so there is no size estimate to draw. The
               drivers panel IS on — a ridge's contributions are exact
               coefficients, which is a better explanation than the boosted
               stack's approximated one, not a lesser substitute. */
            panels: { rmw: false, shap: true, dist: true, track: true,
                      comp: true }
        }
    };
    var M = PROFILES.ghost;      // active profile; set by activate()
    var MODEL_COL = M.color;
    var PREFIX = M.prefix;
    var ARCH_PREFIX = M.arch;

    var _root = null;          // #exp-main
    var _index = null;         // manifest {generated, storms:[{atcf,name}]}
    var _archOpen = null;      // archive collapsed state (null = auto)
    var _archIndex = null;     // season-archive manifest (or null)
    var _archSet = {};         // atcf -> true for archived storms
    var _storm = null;         // selected ATCF id
    var _series = {};          // atcf -> frames json
    var _plotlyReq = null;
    var _showComp = true;    // ON by default: a lone GHOST curve invites
                             // over-reading; peers give honest context
    var _showShap = false;   // model-driver (SHAP) panel
    var _showVerif = false;  // manuscript verification statistics
    var COMP_STYLE = {
        'D-PRINT':       '#a855f7',
        /* ADT comes from the CIMSS feed (~30 min) and carries MSLP, so it
           overlays the pressure panel too; Dvorak/SATCON remain f-deck-only
           and are wind-only + intermittent. */
        'SATCON':        '#ec4899',
        'ADT':           '#f59e0b',
        'Dvorak (DVTS)': '#14b8a6'
    };
    var _rangeH = 48;          // visible window, hours; 0 = full lifetime
                               // (must match a RANGES entry so a button reads active)
    var RANGES = [{ h: 24, label: '24 h' }, { h: 48, label: '48 h' },
                  { h: 0,  label: 'Full lifetime' }];
    var _showTrack = false;  // center-track mini-map panel
    var _showDist = false;   // conditional-distribution panel

    /* Saffir-Simpson palette + classifier — same values as realtime_ir.js /
       global_archive.js so category colors read identically site-wide. */
    var SS_COLORS = { TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24',
                      C2: '#fb923c', C3: '#f87171', C4: '#ef4444',
                      C5: '#dc2626' };
    var SS_BANDS = [
        { k: 'TS', lo: 34,  hi: 64 },  { k: 'C1', lo: 64,  hi: 83 },
        { k: 'C2', lo: 83,  hi: 96 },  { k: 'C3', lo: 96,  hi: 113 },
        { k: 'C4', lo: 113, hi: 137 }, { k: 'C5', lo: 137, hi: 250 }
    ];
    function windToCategory(v) {
        if (v == null || !isFinite(v)) return 'TD';
        if (v < 34) return 'TD';
        if (v < 64) return 'TS';
        if (v < 83) return 'C1';
        if (v < 96) return 'C2';
        if (v < 113) return 'C3';
        if (v < 137) return 'C4';
        return 'C5';
    }
    function categoryShort(cat) {
        return (cat === 'TD' || cat === 'TS') ? cat : 'Cat ' + cat.slice(1);
    }
    /* Badge text color: the light SS hues carry dark ink, the deep reds white. */
    function catInk(cat) {
        return (cat === 'C3' || cat === 'C4' || cat === 'C5')
            ? '#ffffff' : '#0f172a';
    }
    function hexToRgba(hex, a) {
        var n = parseInt(hex.slice(1), 16);
        return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' +
               (n & 255) + ',' + a + ')';
    }

    /* Standing disclaimer for a storm the active model runs but was not
       validated on. Payload wins over the profile default, so the producer
       can narrow or sharpen the wording per storm without a frontend change;
       an explicit `caveat: ""` suppresses it. */
    function provisionalNote(atcf, j) {
        if (j && typeof j.caveat === 'string') return j.caveat || null;
        var basin = (atcf || '').slice(0, 2).toUpperCase();
        return (M.provisional && M.provisional[basin]) || null;
    }

    /* Last frame with a finite value for `key` (frames hold nulls where a
       quantity is missing, e.g. NHC columns past the last analysis). */
    function lastFiniteFrame(fr, key) {
        for (var i = fr.length - 1; i >= 0; i--) {
            var v = fr[i][key];
            if (v !== null && v !== undefined && isFinite(v))
                return { v: v, t: fr[i].t, f: fr[i] };
        }
        return null;
    }

    /* Change over ~24 h: latest finite value minus the finite value nearest
       (now − 24 h). Needs ≥18 h of history so a young storm shows "—" rather
       than a misleading short-baseline delta; returns the true baseline hours
       so the label can stay honest when it isn't exactly 24. */
    function trend24(fr, key) {
        var last = lastFiniteFrame(fr, key);
        if (!last) return null;
        var target = new Date(last.t).getTime() - 24 * 3600e3;
        var best = null, bestD = Infinity;
        for (var i = 0; i < fr.length; i++) {
            var v = fr[i][key];
            if (v === null || v === undefined || !isFinite(v)) continue;
            var d = Math.abs(new Date(fr[i].t).getTime() - target);
            if (d < bestD) { bestD = d; best = fr[i]; }
        }
        if (!best) return null;
        var hrs = (new Date(last.t) - new Date(best.t)) / 3.6e6;
        if (hrs < 18) return null;
        return { d: last.v - best[key], h: hrs };
    }
    function fmtSigned(x, dp) {
        return (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(dp);
    }

    /* ---- conditional predictive distribution (vmax_dist lookup) ----
       Producer ships error percentiles of the storm-held-out OOF chain,
       binned by prediction level. Adding them to the live estimate gives
       calibrated bounds: the IQR band on the chart, the full curve in the
       Distribution panel. */
    function distBin(j, v, key) {
        var d = j[key || 'vmax_dist'];
        if (!d || !d.bin_edges || !d.err_q) return -1;
        for (var i = 0; i < d.bin_edges.length - 1; i++) {
            var hi = (d.bin_edges[i + 1] === null)
                ? Infinity : d.bin_edges[i + 1];
            if (v >= d.bin_edges[i] && v < hi) return i;
        }
        return -1;
    }
    function distErrAt(j, v, pct, key) {
        var i = distBin(j, v, key);
        if (i < 0) return null;
        var q = j[key || 'vmax_dist'].err_q['p' + (pct < 10 ? '0' + pct : pct)];
        return (q && q[i] !== null && q[i] !== undefined) ? q[i] : null;
    }
    function distBounds(j, plo, phi, key, field) {
        var fr = j.frames || [];
        key = key || 'vmax_dist'; field = field || 'vmax_kt';
        if (!j[key] || !j[key].err_q) return null;
        var lo = [], hi = [], any = false;
        fr.forEach(function (f) {
            var v = f[field];
            var a = (v == null) ? null : distErrAt(j, v, plo, key);
            var b = (v == null) ? null : distErrAt(j, v, phi, key);
            if (a === null || b === null) { lo.push(null); hi.push(null); return; }
            lo.push(v + a); hi.push(v + b); any = true;
        });
        return any ? { lo: lo, hi: hi } : null;
    }

    /* GA4 is already configured on the page (G-EFM8GFFKLK); mirror the
       guarded helper used by realtime_seasonal.js so a blocked/absent gtag
       can never throw into the render path. */
    function track(name, params) {
        try {
            if (typeof gtag === 'function') gtag('event', name, params || {});
        } catch (e) {}
    }

    function ensurePlotly() {
        if (typeof Plotly !== 'undefined') return Promise.resolve(true);
        if (_plotlyReq) return _plotlyReq;
        _plotlyReq = new Promise(function (resolve) {
            var s = document.createElement('script');
            s.src = 'https://cdn.plot.ly/plotly-2.27.0.min.js';
            s.onload = function () { resolve(true); };
            s.onerror = function () { _plotlyReq = null; resolve(false); };
            document.head.appendChild(s);
        });
        return _plotlyReq;
    }

    /* Fetch a published GHOST object by bucket-relative path (e.g.
       'ghost-rt/index.json'), preferring the CDN and falling back to GCS if
       the mirror is missing or the edge errors.

       Caching: the per-storm series payloads are 200-290 KB EACH and the tab
       fetches one for every live storm on open, so they are left on normal
       browser caching and the origin's max-age=300 does its job -- a 5-minute
       window against a 30-minute publish cadence. Only the tiny index.json
       (102 B) is fetched no-store, so the storm list and the `generated`
       stamp (which cache-busts the plan PNGs) are always current. */
    function fetchJson(path, noStore) {
        var opts = noStore ? { cache: 'no-store' } : undefined;
        function get(base) {
            return fetch(base + path, opts).then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            });
        }
        return get(CDN_BASE).catch(function () { return get(GCS_BASE); });
    }

    /* Verification numbers are quoted from the manuscript (Fischer, in prep).
       Held-out means the season's storms were withheld from training in every
       basin. Do NOT edit these by hand without checking the source.
       EXCEPTION: the "error by storm strength" table is NOT from the paper —
       it is computed with the manuscript's evaluation code on the same
       held-out 2025 frames (TC-SWARM realtime/rmse_by_intensity_2025.py,
       run 2026-07-26) and is labeled as such in the UI. */
    var GHOST_VERIF_HTML =
        '<div class="exp-verif-h">Preliminary verification' +
        '<span class="exp-verif-src">from the manuscript in preparation. ' +
        '&ldquo;Held out&rdquo; = the season\'s storms were withheld from ' +
        'training. Per-storm-mean unless noted.</span></div>' +

        '<div class="exp-verif-t"><table><caption>Intensity &mdash; 2025 ' +
        'Atlantic held out (13 storms, 1425 hourly frames)</caption><thead>' +
        '<tr><th>Method</th><th>Vmax RMSE</th><th>Bias</th></tr></thead><tbody>' +
        '<tr class="me"><td>GHOST</td><td>6.8 kt</td><td>+1.4 kt</td></tr>' +
        '<tr><td>D-PRINT (deep learning)</td><td>7.1 kt</td><td>&minus;3.1 kt</td></tr>' +
        '<tr><td>AiDT</td><td>7.9 kt</td><td>&minus;1.7 kt</td></tr>' +
        '<tr><td>Dvorak (DVTS)</td><td>8.4 kt</td><td>&minus;4.5 kt</td></tr>' +
        '<tr><td>ADT</td><td>9.8 kt</td><td>&minus;3.2 kt</td></tr>' +
        '</tbody></table></div>' +

        '<p class="exp-verif-note">GHOST\'s 6.8 kt carries a 95% confidence ' +
        'interval of [5.8, 8.0] kt, which contains D-PRINT\'s 7.1 kt &mdash; ' +
        'the two are <strong>statistically on par</strong>, not separated by a ' +
        'single season. GHOST\'s bias interval [&minus;0.5, +3.3] kt includes ' +
        'zero. The high-bias sits in the weak regime (about +9 kt at tropical ' +
        'depression intensity) and vanishes at major-hurricane intensity ' +
        '(&minus;0.3 kt for Vmax &ge; 96 kt), where the comparators run ' +
        'systematically low.</p>' +

        '<div class="exp-verif-t"><table><caption>Error by storm strength ' +
        '&mdash; same held-out 2025 frames, computed with the ' +
        'manuscript\'s evaluation code (supplementary; not a table from ' +
        'the paper)</caption><thead>' +
        '<tr><th>NHC best-track intensity</th><th>Frames</th><th>Bias</th>' +
        '<th>RMSE</th><th>RMSE vs typical wind</th></tr></thead><tbody>' +
        '<tr><td>Depression (&lt;34 kt)</td><td>56</td><td>+5.5 kt</td>' +
        '<td>6.0 kt</td><td>~22%</td></tr>' +
        '<tr><td>Tropical storm (34&ndash;63 kt)</td><td>825</td>' +
        '<td>+1.2 kt</td><td>6.2 kt</td><td>~13%</td></tr>' +
        '<tr><td>Category 1</td><td>171</td><td>&minus;3.5 kt</td>' +
        '<td>8.8 kt</td><td>~12%</td></tr>' +
        '<tr><td>Category 2</td><td>112</td><td>&minus;2.3 kt</td>' +
        '<td>8.5 kt</td><td>~10%</td></tr>' +
        '<tr><td>Category 3</td><td>73</td><td>+2.2 kt</td>' +
        '<td>11.4 kt</td><td>~11%</td></tr>' +
        '<tr><td>Category 4&ndash;5 (&ge;113 kt)</td><td>188</td>' +
        '<td>+2.7 kt</td><td>10.2 kt</td><td>~8%</td></tr>' +
        '</tbody></table></div>' +

        '<p class="exp-verif-note">How to read this: the <em>absolute</em> ' +
        'error grows with intensity, but the <em>relative</em> error ' +
        'shrinks &mdash; roughly 13% of the wind at tropical-storm strength ' +
        'versus 8&ndash;9% at Category 4&ndash;5. Two caveats: at major ' +
        'intensity the NHC best track itself carries roughly 10 kt of ' +
        'uncertainty, so part of the high-end &ldquo;error&rdquo; is ' +
        'disagreement with an uncertain reference rather than model error; ' +
        'and these rows pool all 1425 frames, which weights long-lived ' +
        'storms more than the headline 6.8 kt per-storm mean does (the ' +
        'same frames pooled give 7.7 kt overall &mdash; both are correct, ' +
        'they aggregate differently).</p>' +

        '<div class="exp-verif-t"><table><caption>Size (radius of maximum wind) ' +
        '&mdash; mean absolute error vs airborne radar, on the cases where every ' +
        'method is defined. GHOST column = the deployed model configuration (the ' +
        'one running on this page).</caption><thead>' +
        '<tr><th>Method</th><th>2024 held out<br>(n=146)</th>' +
        '<th>2025 held out<br>(n=76)</th></tr></thead><tbody>' +
        '<tr class="me"><td>GHOST <em>(no outer-wind input)</em></td>' +
        '<td>18.6 km</td><td>18.7 km</td></tr>' +
        '<tr><td>CK22 <em>(needs observed R34)</em></td><td>19.7 km</td><td>17.9 km</td></tr>' +
        '<tr><td>WB06 <em>(Vmax + latitude formula)</em></td><td>30.3 km</td><td>20.4 km</td></tr>' +
        '<tr><td>KZ07 <em>(Vmax + latitude formula)</em></td><td>33.2 km</td><td>34.2 km</td></tr>' +
        '</tbody></table></div>' +

        '<p class="exp-verif-note">GHOST and CK22 are <strong>statistically ' +
        'tied</strong> in both years: only 5&ndash;7 storms carry each ' +
        'season\'s comparison, and storm-clustered confidence intervals on ' +
        'the difference include zero both times &mdash; the year-to-year flip ' +
        'is sampling, not skill. The distinction is the inputs: CK22 must be ' +
        'handed the storm\'s observed outer wind radius (R34, itself a ' +
        'recon/scatterometer product); GHOST infers core size from the cloud ' +
        'field alone. On major hurricanes &mdash; where core size is best ' +
        'defined and matters most &mdash; GHOST\'s size error falls to ' +
        'about <strong>6 km</strong>. A radius error costs less than it ' +
        'appears: over matched radar cases the resulting tangential-wind ' +
        'error has a median of 2.3 kt, roughly 9% of the peak wind.</p>' +

        '<div class="exp-verif-t"><table><caption>Independent cross-check &mdash; ' +
        'correlation with tail Doppler radar wind (83 coincident frames)</caption>' +
        '<thead><tr><th>Method</th><th>r vs radar</th></tr></thead><tbody>' +
        '<tr class="me"><td>GHOST</td><td>0.92</td></tr>' +
        '<tr><td>D-PRINT</td><td>0.92</td></tr>' +
        '<tr><td>AiDT</td><td>0.89</td></tr>' +
        '<tr><td>ADT</td><td>0.85</td></tr>' +
        '<tr><td><em>Best track (upper bound)</em></td><td><em>0.97</em></td></tr>' +
        '</tbody></table></div>' +

        '<p class="exp-verif-note">Radar is independent of both the satellite ' +
        'imagery and the best-track process, so this addresses the concern that ' +
        'a technique trained against the best track might only be echoing the ' +
        'satellite estimates that shaped its labels. Other results: minimum ' +
        'pressure 6.4 hPa RMSE vs 8.1 for D-PRINT (2025); East Pacific 8.3 vs ' +
        '8.5 kt pooled over three held-out seasons (49 storms); pooled ' +
        'storm-grouped cross-validation over all development seasons gives ' +
        '10.1 kt and 8.2 hPa.</p>';

    /* FPM v1.0 verification. Quoted verbatim from the frozen boards
       (TC-SWARM experiments/stage0_intensity/docs_FPM_V1_0_MANIFEST.md and
       docs_FPM_V1_0_EP_MANIFEST.md, cut 2026-08-15). Do NOT edit by hand —
       regenerate from fpm_v1_freeze.py / fpm_v1_ep_extend.py.

       Two things are stated here that it would be easy to quietly omit, and
       both are load-bearing:
       (1) the page runs the FROZEN fit while the headline number is the
           leave-one-year-out one — the honest held-out figure is the LOYO
           column, and the gap between them is the in-sample optimism;
       (2) EP has no LOYO equivalent at all, so its numbers inherit a weaker
           protocol. Presenting the two basins as if they were scored the
           same way would be the single most misleading thing this table
           could do. */
    var FPM_VERIF_HTML =
        '<div class="exp-verif-h">FPM v1.0 verification' +
        '<span class="exp-verif-src">from the frozen v1.0 boards ' +
        '(cut 2026-08-15). Pooled over frames, not per-storm means &mdash; ' +
        'these are not comparable to the GHOST page&rsquo;s per-storm ' +
        'numbers.</span></div>' +

        '<div class="exp-verif-t"><table><caption>Minimum pressure &mdash; ' +
        'Atlantic, 1998&ndash;2025 (27,215 frames / 451 storms)</caption>' +
        '<thead><tr><th>Channel</th><th>Protocol</th><th>RMSE</th>' +
        '<th>Bias</th></tr></thead><tbody>' +
        '<tr class="me"><td>FPM v1.0 <em>(running on this page)</em></td>' +
        '<td>frozen fit</td><td>7.16 hPa</td><td>&minus;1.34 hPa</td></tr>' +
        '<tr><td>FPM v1.0</td><td>leave-one-year-out</td><td>7.32 hPa</td>' +
        '<td>&minus;1.40 hPa</td></tr>' +
        '<tr><td>FPM without the weak-end gate</td><td>frozen fit</td>' +
        '<td>16.92 hPa</td><td>&minus;11.89 hPa</td></tr>' +
        '</tbody></table></div>' +

        '<p class="exp-verif-note">The middle row is the honest one. This ' +
        'page necessarily runs the <em>frozen</em> fit &mdash; a ' +
        'leave-one-year-out model is a scoring protocol, not something that ' +
        'can be run forward on a storm happening now &mdash; so read 7.32 ' +
        'hPa as the expected out-of-sample error and the 0.16 hPa gap as ' +
        'the in-sample optimism. The third row shows how much of the ' +
        'skill is the weak-end gate: without it the model runs nearly 12 ' +
        'hPa too deep on average, because the pressure-deficit formulation ' +
        'it is built on has little to say about a system that barely has a ' +
        'vortex.</p>' +

        '<div class="exp-verif-t"><table><caption>Error by best-track ' +
        'pressure &mdash; Atlantic, held-out (leave-one-year-out) channel. ' +
        '&ldquo;Aircraft-anchored&rdquo; = within &plusmn;3 h of a ' +
        'reconnaissance fix carrying a <em>measured</em> ' +
        'pressure</caption><thead>' +
        '<tr><th>Best-track pressure</th><th>Frames</th><th>RMSE</th>' +
        '<th>Bias</th><th>Anchored<br>frames</th><th>Anchored<br>RMSE</th>' +
        '</tr></thead><tbody>' +
        '<tr><td>&gt;1005 hPa</td><td>7,937</td><td>5.26</td>' +
        '<td>&minus;3.48</td><td>710</td><td>4.07</td></tr>' +
        '<tr><td>990&ndash;1005</td><td>10,552</td><td>6.73</td>' +
        '<td>&minus;1.60</td><td>2,358</td><td>4.69</td></tr>' +
        '<tr><td>970&ndash;990</td><td>5,053</td><td>8.86</td>' +
        '<td>&minus;0.16</td><td>1,297</td><td>7.43</td></tr>' +
        '<tr><td>950&ndash;970</td><td>2,360</td><td>9.94</td>' +
        '<td>+1.87</td><td>955</td><td>10.32</td></tr>' +
        '<tr><td>940&ndash;950</td><td>663</td><td>9.94</td>' +
        '<td>+1.92</td><td>420</td><td>10.32</td></tr>' +
        '<tr><td>920&ndash;940</td><td>512</td><td>9.36</td>' +
        '<td>+1.27</td><td>377</td><td>8.85</td></tr>' +
        '<tr><td>&le;920</td><td>138</td><td>11.63</td><td>+6.84</td>' +
        '<td>118</td><td>11.70</td></tr>' +
        '</tbody></table></div>' +

        '<p class="exp-verif-note">The deep tail is where this model is ' +
        'both most interesting and least certain. Below 920 hPa it reads ' +
        'about 7 hPa too shallow &mdash; on 138 frames from a handful of ' +
        'storms, so treat the number as an indication rather than a rate. ' +
        'Note that the anchored column does not improve there: at extreme ' +
        'intensity the disagreement is with an actual barometer, not with ' +
        'best-track convention.</p>' +

        '<div class="exp-verif-t"><table><caption>East / Central Pacific ' +
        '&mdash; 2000&ndash;2025 (6,840 frames / 82 storms)</caption>' +
        '<thead><tr><th>Channel</th><th>Protocol</th><th>RMSE</th>' +
        '<th>Bias</th></tr></thead><tbody>' +
        '<tr class="me"><td>FPM v1.0 <em>(running on this page)</em></td>' +
        '<td>frozen fit</td><td>10.93 hPa</td><td>&minus;2.59 hPa</td></tr>' +
        '<tr><td><em>&mdash; aircraft-anchored frames only (n=335)</em></td>' +
        '<td><em>frozen fit</em></td><td><em>7.50 hPa</em></td>' +
        '<td><em>&minus;1.53 hPa</em></td></tr>' +
        '<tr><td>Ridge, ungated</td><td>leave-one-storm-out</td>' +
        '<td>14.58 hPa</td><td>&minus;8.88 hPa</td></tr>' +
        '</tbody></table></div>' +

        '<p class="exp-verif-note">The East Pacific is weaker evidence than ' +
        'the Atlantic and should be read that way. There is no ' +
        'leave-one-year-out board for this basin &mdash; the only held-out ' +
        'channel is an <em>ungated</em> leave-one-storm-out ridge, which is ' +
        'not the model this page runs, so the two rows above are not a ' +
        'like-for-like pair. Aircraft verification is also genuinely ' +
        'sparse: 4.9% of East Pacific frames are anchored to a measured ' +
        'pressure versus 22.9% in the Atlantic, and below 920 hPa the ' +
        'entire basin record holds <strong>eight</strong> barometer-anchored ' +
        'frames. Nothing about the East Pacific deep end can be established ' +
        'from this sample, and nothing here claims it.</p>' +

        '<p class="exp-verif-note"><strong>On the wind trace.</strong> FPM ' +
        'models pressure only. The maximum-wind curve on this page is that ' +
        'pressure passed through a fitted pressure&ndash;wind relationship ' +
        '(the deficit, translation speed, latitude and a size term), so it ' +
        'inherits the pressure error and adds its own. It is not an ' +
        'independent wind estimate and should not be compared against ' +
        'GHOST&rsquo;s Vmax as though it were one.</p>';

    /* Per-profile page copy. Kept beside the verification blocks rather than
       inline in renderShell so the two models' claims sit next to each other
       and stay easy to audit against their manifests. */
    var GHOST_LEDE =
        '<div class="exp-lede">GHOST provides <strong>independent, ' +
        'real-time estimates of tropical cyclone intensity (maximum ' +
        'sustained wind and minimum central pressure) and radius of ' +
        'maximum wind</strong> — derived from geostationary infrared ' +
        'imagery and the large-scale environment alone, with no aircraft ' +
        'reconnaissance required.</div>' +
        '<div class="exp-cite"><strong>Manuscript in preparation.</strong> ' +
        'GHOST (Geostationary-based Hurricane Objective Strength ' +
        'Technique) is an unpublished research method; this page is ' +
        'provided for scientific transparency and is <strong>not an ' +
        'official forecast or analysis</strong>. Please contact the ' +
        'author — Dr. Michael Fischer ' +
        '(<a href="mailto:mike.fischer@miami.edu">mike.fischer@miami.edu' +
        '</a>) — before citing or redistributing these estimates.</div>';

    var FPM_LEDE =
        '<div class="exp-lede">FPM estimates <strong>minimum central ' +
        'pressure in real time from geostationary infrared imagery ' +
        'alone</strong>, with no aircraft reconnaissance required. It is a ' +
        '<strong>different architecture</strong> from GHOST, not a retune ' +
        'of it: where GHOST is a boosted-tree stack over a large learned ' +
        'feature set, FPM is a small ridge regression on physically chosen ' +
        'predictors &mdash; eye warmth and size, eyewall structure, the ' +
        'radial shape of the core, and how far the cold canopy extends ' +
        '&mdash; fitted against the environmental pressure deficit rather ' +
        'than against pressure directly, because the deficit is what the ' +
        'vortex actually sets.</div>' +
        '<div class="exp-cite"><strong>Unlisted research page.</strong> ' +
        'FPM v1.0 is an unpublished research method under active ' +
        'development, shown here beside GHOST for comparison. It is ' +
        '<strong>not an official forecast or analysis</strong>, and it is ' +
        'not the model behind the GHOST tab. Please contact the author ' +
        '— Dr. Michael Fischer ' +
        '(<a href="mailto:mike.fischer@miami.edu">mike.fischer@miami.edu' +
        '</a>) — before citing or redistributing these estimates.</div>';

    /* Shared tail for both profiles: how the best-track reference behaves and
       why plan-view centers can lag. True of the frames themselves, which
       both producers share. */
    var TRACK_CAVEAT =
        'The best-track reference (NHC, or JTWC for West Pacific / Indian ' +
        'Ocean storms) is linearly interpolated between 6-hourly analyses ' +
        '(dots mark the real ones) and STOPS at the latest analysis &mdash; ' +
        'the model continues past it, so the most recent stretch has no ' +
        'reference to compare against yet. Below hurricane strength the ' +
        'plotted storm center comes from that interpolated track (the IR ' +
        'eye-lock engages only once an eye is trackable), so plan-view ' +
        'centers can lag a reforming or fast-moving storm — each panel ' +
        'is stamped with its center source.';

    var GHOST_NOTE =
        '<div class="exp-note">Guidance, not official analysis. ' +
        'Weak systems (TD / weak TS) have a known high-bias. Near ' +
        'Category-5 strength the estimates saturate (ceiling ' +
        '&asymp;150&ndash;160 kt): a flat, maxed-out trace means ' +
        '&ldquo;at or above the ceiling&rdquo;, and the strongest ' +
        'storms are typically under-read. The operational model ' +
        '(op-2026b, updated 2026-07-28) trains on 2000&ndash;2025 and ' +
        'adds ocean predictors &mdash; sea-surface temperature, ocean ' +
        'heat content and their recent changes, from operational SHIPS ' +
        'for NHC basins and a satellite ocean-heat-content analysis for ' +
        'JTWC basins &mdash; plus an intensity-trend state; this ' +
        'reduced, but did not eliminate, the tendency to read high ' +
        'while storms weaken over open water. Since 2026-08-05 a ' +
        'composition layer (GHOST 2.1p, op-2026c) refines the high end: ' +
        'once a trackable eye persists and the storm reads &ge;90 kt, ' +
        'specialist estimators tuned on major hurricanes take over ' +
        'Vmax/Pmin, with per-frame quality control that masks ' +
        'land-contaminated or corrupt scenes before smoothing. The ' +
        'Verification tables describe the manuscript&rsquo;s held-out ' +
        'configuration. ' + TRACK_CAVEAT + '</div>';

    var FPM_NOTE =
        '<div class="exp-note">Guidance, not official analysis. ' +
        '<strong>Pressure is the model; wind is derived.</strong> The ' +
        'maximum-wind trace is FPM&rsquo;s pressure passed through a fitted ' +
        'pressure&ndash;wind relationship, so it inherits the pressure ' +
        'error and adds its own &mdash; treat the pressure panel as the ' +
        'primary product. There is no size (RMW) panel here: FPM does not ' +
        'model size, and GHOST&rsquo;s RMW comes from a separate stage that ' +
        'is not part of this model. ' +
        '<strong>Basins:</strong> FPM v1.0&rsquo;s frozen boards cover the ' +
        'Atlantic and East / Central Pacific. West Pacific storms are shown ' +
        'as well, but they are <strong>provisional</strong>: no held-out ' +
        'board exists for that basin, there is no aircraft-anchored ' +
        'verification in it at all, and its training frames are mid-rebuild ' +
        'after an imagery quality-control change. Every West Pacific storm ' +
        'carries that disclaimer on its own page. ' +
        '<strong>Known behavior:</strong> below about 920 hPa the model ' +
        'reads roughly 7 hPa too shallow, and a weak-end gate carries much ' +
        'of the skill below tropical-storm strength &mdash; see ' +
        'Verification. ' +
        '<strong>Not fully independent of GHOST at the weak end:</strong> ' +
        'that gate is keyed on GHOST&rsquo;s wind estimate, blending the ' +
        'weak-end reader in below roughly 90 kt and switching it off above. ' +
        'The pressure model itself is entirely separate, but the published ' +
        'value for a weak system is a blend whose weight GHOST sets, so the ' +
        'two pages are not independent estimates there. Where GHOST has no ' +
        'wind for a frame the gate falls back to keying on FPM&rsquo;s own ' +
        'pressure. ' +
        /* The Global Archive's reanalysis tab publishes its own
           "GHOST-FPM Vmax" from the same pressure model but the full offline
           wind recipe. The two disagree at the top, and a reader comparing
           the same storm across the two pages has to be told why. Decision
           recorded in TC-SWARM realtime/FPM_WIND_CONSISTENCY.md. */
        '<strong>Against the archived reanalysis:</strong> the Global ' +
        'Archive&rsquo;s GHOST Reanalysis tab shows a &ldquo;GHOST-FPM ' +
        'V<sub>max</sub>&rdquo; for past storms. It comes from the same ' +
        'pressure model but a fuller wind recipe &mdash; one that uses ' +
        'best-track wind radii for size and a leave-one-storm-out correction ' +
        'at the strongest end. Neither can be computed while a storm is ' +
        'happening, so the wind on this page reads a few knots lower above ' +
        'about 110 kt. The pressure is the same model on both. ' +
        TRACK_CAVEAT + '</div>';

    PROFILES.ghost.verif = GHOST_VERIF_HTML;
    PROFILES.ghost.lede = GHOST_LEDE;
    PROFILES.ghost.note = GHOST_NOTE;
    PROFILES.fpm.verif = FPM_VERIF_HTML;
    PROFILES.fpm.lede = FPM_LEDE;
    PROFILES.fpm.note = FPM_NOTE;

    /* ---------------- main UI ---------------- */

    // Producer heartbeat: index.json is rewritten by every run (even when all
    // storms are cadence-skipped), so its age is a dead-man's switch for the
    // whole pipeline. Hourly cron + 30-min slack + 5-min GCS edge cache means
    // anything past ~2.5 h is a real outage, not jitter.
    var STALE_H = 2.5;

    function renderShell() {
        var storms = (_index && _index.storms) || [];
        var gen = _index && _index.generated
            ? new Date(_index.generated) : null;
        var genStr = gen
            ? gen.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
        var ageH = gen ? (Date.now() - gen.getTime()) / 36e5 : null;
        var staleHtml = '';
        if (_index && (ageH === null || ageH > STALE_H)) {
            staleHtml =
                '<div class="exp-stale">&#9888;&#65039; ' + M.name +
                ' updates are paused — the last successful run was ' +
                (ageH === null ? 'an unknown time' :
                 ageH > 48 ? Math.round(ageH / 24) + ' days' :
                 ageH.toFixed(1) + ' hours') +
                ' ago. Estimates and imagery below are from that run and do ' +
                'not reflect current storm status.</div>';
        }
        var html =
            '<div class="exp-inner">' +
            '<div class="exp-head">' +
            '  <div>' +
            '    <span class="exp-badge">EXPERIMENTAL</span>' +
            '    <span class="exp-title">' + M.title + '</span>' +
            '  </div>' +
            '  <div class="exp-meta">Updated ' + genStr +
            '    · refreshes every 30 minutes · ' +
            '<a href="#" id="exp-refresh">reload</a></div>' +
            '</div>' +
            staleHtml + M.lede + M.note;
        var arch = (_archIndex && _archIndex.storms) || [];
        if (!storms.length && !arch.length) {
            html += '<div class="exp-empty">No active storms right now — ' +
                'the pipeline publishes automatically when a storm forms.</div></div>';
            _root.innerHTML = html;
            bindRefresh();
            return;
        }
        if (storms.length) {
            html += '<div class="exp-chips" id="exp-chips">';
            storms.forEach(function (s) {
                /* A storm the producer could not run at all is listed but not
                   selectable, with the reason on the chip. Dropping it
                   instead would make the storm list silently disagree with
                   the Map tab, which reads as a broken feed rather than a
                   stated limit. Note this is NOT how out-of-validation
                   basins are handled — those render normally and carry a
                   disclaimer (see provisionalNote). */
                if (s.excluded) {
                    html += '<button class="exp-chip exp-chip-off" disabled ' +
                        'title="' + s.excluded + '">' +
                        (s.name || s.atcf) + ' <span>' + s.atcf + '</span>' +
                        '<em class="exp-chip-int">not available</em>' +
                        '</button>';
                    return;
                }
                html += '<button class="exp-chip' +
                    (provisionalNote(s.atcf) ? ' exp-chip-prov' : '') +
                    '" data-atcf="' + s.atcf + '">' +
                    (s.name || s.atcf) + ' <span>' + s.atcf + '</span>' +
                    '<em class="exp-chip-int" id="exp-int-' + s.atcf + '"></em>' +
                    '</button>';
            });
            html += '</div>';
        } else {
            html += '<div class="exp-empty exp-empty-sm">No active ' +
                'storms right now — browse the season archive below.</div>';
        }
        if (arch.length) {
            /* Collapsed by default (auto-open when there are no live storms,
               so the page never renders empty). Chips grouped by basin. */
            var archOpen = (_archOpen === null) ? !storms.length : _archOpen;
            html += '<div class="exp-arch-h">' +
                '<button class="exp-arch-toggle' +
                (archOpen ? ' open' : '') + '" id="exp-arch-toggle" ' +
                'aria-expanded="' + archOpen + '">' +
                ((_archIndex && _archIndex.year) || '') +
                ' season archive (' + arch.length + ') <b>&#9662;</b>' +
                '</button>' +
                '<span>retrospective ' + M.name + ' runs of completed storms</span>' +
                '</div>' +
                '<div class="exp-arch-body" id="exp-arch-body"' +
                (archOpen ? '' : ' hidden') + '>';
            var BASIN_NAMES = { AL: 'Atlantic', EP: 'East Pacific',
                                CP: 'Central Pacific', WP: 'West Pacific',
                                IO: 'North Indian',
                                SH: 'Southern Hemisphere' };
            var groups = {}, basinOrder = [];
            arch.forEach(function (s) {
                var b = (s.atcf || '').slice(0, 2);
                if (!groups[b]) { groups[b] = []; basinOrder.push(b); }
                groups[b].push(s);
            });
            basinOrder.forEach(function (b) {
                html += '<div class="exp-arch-basin">' +
                    (BASIN_NAMES[b] || b) + '</div>' +
                    '<div class="exp-chips exp-chips-arch">';
                groups[b].forEach(function (s) {
                    /* Filter-excluded storms (weak/overland whole life) are
                       listed but not selectable — silently missing reads as
                       a bug, and the reason is scientifically meaningful. */
                    if (s.excluded) {
                        html += '<button class="exp-chip exp-chip-arch ' +
                            'exp-chip-off" disabled title="' + s.excluded +
                            '">' + (s.name || s.atcf) +
                            ' <span>' + s.atcf + '</span>' +
                            '<em class="exp-chip-int">not scoreable</em>' +
                            '</button>';
                        return;
                    }
                    /* `peak_kt` is the producer-neutral field; ghost_peak_kt
                       is the original GHOST spelling, still read so an index
                       published before the rename keeps its chip labels. */
                    var pk = (s.peak_kt != null) ? s.peak_kt : s.ghost_peak_kt;
                    var pp = s.peak_hpa;
                    var cat = windToCategory(pk);
                    /* Label the chip with whatever the model actually
                       predicts: a pressure model's "peak" is its deepest
                       pressure, and quoting a derived wind there would put
                       the weakest number on the storm's headline. The
                       category swatch still needs a wind, so it only appears
                       when one was published. */
                    var chipLbl = '';
                    if (M.headline === 'pmin_hpa' && pp != null) {
                        chipLbl = (pk != null
                                ? '<i style="background:' + SS_COLORS[cat] + '"></i>'
                                : '') + 'min ' + Math.round(pp) + ' hPa';
                    } else if (pk != null) {
                        chipLbl = '<i style="background:' + SS_COLORS[cat] +
                            '"></i>peak ' + Math.round(pk) + ' kt';
                    }
                    html += '<button class="exp-chip exp-chip-arch" ' +
                        'data-atcf="' + s.atcf + '">' + (s.name || s.atcf) +
                        ' <span>' + s.atcf + '</span>' +
                        '<em class="exp-chip-int">' + chipLbl +
                        '</em></button>';
                });
                html += '</div>';
            });
            html += '</div>';
        }
        html +=
            '<div class="exp-tiles" id="exp-tiles"></div>' +
            /* Plan view leads: the latest imagery is the page's face, and the
               toggled panels (verification especially) must never push it
               out of view — they open BELOW the chart, verification last. */
            '<div class="exp-plan-wrap">' +
            '<div class="exp-plan-head">' +
            '<span class="exp-plan-title">IR plan-view evolution</span>' +
            '<button class="exp-range exp-dl" id="exp-plan-dl" ' +
            'title="Download plan view as PNG" ' +
            'aria-label="Download plan view as PNG">&#x2913; Download</button>' +
            '</div>' +
            /* crossorigin="anonymous" is LOAD-BEARING for the Download
               button, not decoration. Without it the browser fetches this
               image in no-CORS mode and stores a cache entry that CORS-mode
               requests may not reuse -- so the download handler's fetch() of
               the SAME url fails with an opaque "TypeError: Failed to fetch"
               and the save never even reaches TCExport. Must be set before
               src is assigned (it is: src is set later in selectStorm).
               Both cdn.tcatlas.org and the GCS fallback send
               access-control-allow-origin: *, so the image still loads. */
            '<img id="exp-plan" class="exp-plan" crossorigin="anonymous" ' +
            'alt="' + M.name + ' plan view">' +
            '</div>' +
            '<div class="exp-ranges" id="exp-ranges">' +
            '<span class="exp-ranges-label">Show</span>';
        RANGES.forEach(function (r) {
            html += '<button class="exp-range' +
                (r.h === _rangeH ? ' active' : '') + '" data-h="' + r.h + '">' +
                r.label + '</button>';
        });
        html += '<span class="exp-ranges-sep"></span>' +
            '<button class="exp-range exp-comp' + (_showComp ? ' active' : '') +
            '" id="exp-comp">Operational comparators</button>' +
            '<button class="exp-range exp-trackbtn' + (_showTrack ? ' active' : '') +
            '" id="exp-track-btn">Track map</button>' +
            '<button class="exp-range exp-distbtn' + (_showDist ? ' active' : '') +
            '" id="exp-dist-btn">Distribution</button>' +
            /* Both producers publish driver attribution now; the panel is
               payload-shaped (see drawShap), so what differs between them is
               the units and the method, not the chart. */
            (M.panels.shap
                ? '<button class="exp-range exp-shapbtn' +
                  (_showShap ? ' active' : '') +
                  '" id="exp-shap-btn">Model drivers</button>'
                : '') +
            '<button class="exp-range exp-verifbtn' + (_showVerif ? ' active' : '') +
            '" id="exp-verif-btn">Verification</button>' +
            '<button class="exp-range exp-dl" id="exp-dl" ' +
            'title="Download chart as PNG" aria-label="Download chart as PNG">' +
            '&#x2913; Download</button>' +
            '</div>' +
            '<div id="exp-plot" class="exp-plot"></div>' +
            '<div id="exp-track" class="exp-track" style="display:none;"></div>' +
            '<div id="exp-dist" class="exp-shap" style="display:none;"></div>' +
            '<div id="exp-shap" class="exp-shap" style="display:none;"></div>' +
            '<div id="exp-verif" class="exp-verif" style="display:none;"></div>' +
            '</div>';
        _root.innerHTML = html;
        bindRefresh();
        var chips = _root.querySelectorAll('.exp-chip');
        chips.forEach(function (c) {
            c.addEventListener('click', function () {
                selectStorm(c.getAttribute('data-atcf'));
            });
        });
        var archT = document.getElementById('exp-arch-toggle');
        if (archT) archT.addEventListener('click', function () {
            var body = document.getElementById('exp-arch-body');
            if (!body) return;
            _archOpen = body.hidden;          // toggling from current state
            body.hidden = !_archOpen;
            archT.classList.toggle('open', _archOpen);
            archT.setAttribute('aria-expanded', _archOpen);
            track(M.key + '_archive_toggle', { open: _archOpen });
        });
        var vBtn = document.getElementById('exp-verif-btn');
        if (vBtn) vBtn.addEventListener('click', function () {
            _showVerif = !_showVerif;
            track(M.key + '_verification', { on: _showVerif });
            vBtn.classList.toggle('active', _showVerif);
            var box = document.getElementById('exp-verif');
            if (!box) return;
            box.style.display = _showVerif ? 'block' : 'none';
            if (_showVerif) box.innerHTML = M.verif;
        });
        var trackBtn = document.getElementById('exp-track-btn');
        if (trackBtn) trackBtn.addEventListener('click', function () {
            _showTrack = !_showTrack;
            track(M.key + '_track_map', { on: _showTrack });
            trackBtn.classList.toggle('active', _showTrack);
            var box = document.getElementById('exp-track');
            if (box) box.style.display = _showTrack ? 'block' : 'none';
            if (_showTrack && _storm && _series[_storm]) drawTrack(_series[_storm]);
        });
        var distBtn = document.getElementById('exp-dist-btn');
        if (distBtn) distBtn.addEventListener('click', function () {
            _showDist = !_showDist;
            track(M.key + '_distribution', { on: _showDist });
            distBtn.classList.toggle('active', _showDist);
            var box = document.getElementById('exp-dist');
            if (box) box.style.display = _showDist ? 'block' : 'none';
            if (_showDist && _storm && _series[_storm]) drawDist(_series[_storm]);
        });
        var shapBtn = document.getElementById('exp-shap-btn');
        if (shapBtn) shapBtn.addEventListener('click', function () {
            _showShap = !_showShap;
            track(M.key + '_model_drivers', { on: _showShap });
            shapBtn.classList.toggle('active', _showShap);
            var box = document.getElementById('exp-shap');
            if (box) box.style.display = _showShap ? 'block' : 'none';
            if (_showShap && _storm && _series[_storm]) drawShap(_series[_storm]);
        });
        var compBtn = document.getElementById('exp-comp');
        if (compBtn) compBtn.addEventListener('click', function () {
            _showComp = !_showComp;
            track(M.key + '_comparators', { on: _showComp });
            compBtn.classList.toggle('active', _showComp);
            if (_storm && _series[_storm]) drawSeries(_series[_storm]);
        });
        var dlBtn = document.getElementById('exp-dl');
        if (dlBtn) dlBtn.addEventListener('click', function () {
            saveChartPng(dlBtn);
        });
        /* Plan view is a producer-rendered PNG on GCS (CORS origin:*), so
           download = fetch the blob and hand it to TCExport (the ONE save
           path — iOS-safe, share-sheet aware). */
        var pDl = document.getElementById('exp-plan-dl');
        if (pDl) pDl.addEventListener('click', function () {
            var img = document.getElementById('exp-plan');
            if (!img || !img.src || !window.TCExport || !_storm) return;
            track(M.key + '_plan_download', { storm: _storm });
            pDl.disabled = true;
            var stamp = (_index && _index.generated || '').slice(0, 10);
            /* Normal caching: img.src is already displayed and its URL is
               stamped with the publish time, so the browser copy is exactly
               the bytes the user is looking at. no-store here re-downloaded
               the full ~0.9 MB PNG on every save.
               The retry is the safety net for a cache entry stored in
               no-CORS mode BEFORE the img gained crossorigin="anonymous"
               (every phone that loaded this page earlier has one). A plain
               fetch can be refused against such an entry; cache:'reload'
               forces a fresh CORS-mode request that cannot reuse it. */
            fetch(img.src)
                .catch(function () { return fetch(img.src, { cache: 'reload' }); })
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.blob();
                })
                .then(function (b) {
                    /* TCExport.save(), NOT saveBlob(). saveBlob is the
                       low-level delivery step and returns FALSE when the
                       share sheet could not run -- on iOS the ~0.9 MB fetch
                       above routinely outlives the tap's transient user
                       activation, so share rejects with NotAllowedError.
                       This call site discarded that false and never showed
                       the fresh-tap overlay, so the button did nothing at all
                       on iPhone. save() owns the whole contract: desktop
                       anchor, touch share sheet, and the overlay fallback
                       whose Save button carries a brand-new activation.
                       Same silent-failure class as commit aa6f708c. */
                    return TCExport.save(b, 'TC-ATLAS_' + M.name + '_' + _storm +
                        '_planview' + (stamp ? '_' + stamp : '') + '.png');
                })
                .catch(function (e) {
                    /* Never swallow silently -- a dead save button with no
                       trace is what made this bug survive two audits. */
                    if (window.console) console.warn(M.name + ' plan save failed', e);
                })
                .then(function () { pDl.disabled = false; });
        });
        _root.querySelectorAll('.exp-range[data-h]').forEach(function (b) {
            b.addEventListener('click', function () {
                _rangeH = parseInt(b.getAttribute('data-h'), 10);
                track(M.key + '_range', { hours: _rangeH || 'lifetime' });
                _root.querySelectorAll('.exp-range[data-h]').forEach(
                    function (o) { o.classList.toggle('active', o === b); });
                /* Data already spans the full lifetime — a range change is a
                   pure client-side x-axis relayout, no refetch. */
                if (_storm && _series[_storm]) applyRange(_series[_storm]);
            });
        });
        var sel = storms.filter(function (s) { return !s.excluded; });
        var known = sel.concat(arch.filter(function (s) {
            return !s.excluded; }));
        /* Every listed storm can be excluded — e.g. only West Pacific
           systems are active and this model isn't validated there. Nothing
           is selectable then, and known[0] would throw. */
        if (known.length) {
            var want = _storm &&
                known.some(function (s) { return s.atcf === _storm; })
                ? _storm : known[0].atcf;
            selectStorm(want);
        }
        stampChipIntensities(sel);
    }

    /* Archived storms live under the season prefix; live ones under the
       real-time prefix. Everything downstream is prefix-agnostic.
       Returns a bucket-relative path -- fetchJson() picks CDN vs GCS. */
    function seriesPath(atcf) {
        return (_archSet[atcf] ? ARCH_PREFIX : PREFIX) +
            '/' + M.file + atcf + '.json';
    }

    /* Fill each storm chip with its latest GHOST intensity + category. Also
       warms the _series cache, so switching storms is instant afterwards. */
    function stampChipIntensities(storms) {
        storms.forEach(function (s) {
            var p = _series[s.atcf]
                ? Promise.resolve(_series[s.atcf])
                : fetchJson(PREFIX + '/' + M.file + s.atcf + '.json')
                    .then(function (j) { _series[s.atcf] = j; return j; });
            p.then(function (j) {
                var em = document.getElementById('exp-int-' + s.atcf);
                if (!em) return;
                var lf = lastFiniteFrame(j.frames || [], 'vmax_kt');
                if (!lf) return;
                var cat = windToCategory(lf.v);
                /* Pressure-first models lead with pressure; the wind is
                   still shown (it carries the category) but second. */
                var lp = M.headline === 'pmin_hpa'
                    ? lastFiniteFrame(j.frames || [], 'pmin_hpa') : null;
                em.innerHTML = '<i style="background:' + SS_COLORS[cat] +
                    '"></i>' + (lp
                        ? Math.round(lp.v) + ' hPa · ' + Math.round(lf.v) + ' kt'
                        : Math.round(lf.v) + ' kt · ' + categoryShort(cat));
            }).catch(function () {});
        });
    }

    function bindRefresh() {
        var a = document.getElementById('exp-refresh');
        if (a) a.addEventListener('click', function (e) {
            e.preventDefault();
            _series = {};
            loadIndex();
        });
    }

    function selectStorm(atcf) {
        if (_storm && _storm !== atcf) track(M.key + '_storm_select', { storm: atcf });
        _storm = atcf;
        _root.querySelectorAll('.exp-chip').forEach(function (c) {
            c.classList.toggle('active', c.getAttribute('data-atcf') === atcf);
        });
        var img = document.getElementById('exp-plan');
        if (img) {
            var gen = _archSet[atcf]
                ? (_archIndex && _archIndex.generated)
                : (_index && _index.generated);
            var planPath = (_archSet[atcf] ? ARCH_PREFIX : PREFIX) +
                '/' + M.file + atcf + '_plan.png?t=' +
                encodeURIComponent(gen || Date.now());
            /* Same CDN-first/GCS-fallback contract as fetchJson, but an <img>
               can only express it through onerror. Guarded so a failing GCS
               copy can't loop: the handler clears itself before retrying. */
            img.onerror = function () {
                img.onerror = null;
                img.src = GCS_BASE + planPath;
            };
            img.src = CDN_BASE + planPath;
        }
        var p = _series[atcf]
            ? Promise.resolve(_series[atcf])
            : fetchJson(seriesPath(atcf))
                .then(function (j) { _series[atcf] = j; return j; });
        Promise.all([p, ensurePlotly()]).then(function (res) {
            if (_storm !== atcf) return;
            renderTiles(res[0]);
            drawSeries(res[0]);
            if (_showTrack) drawTrack(res[0]);
            if (_showDist) drawDist(res[0]);
            if (_showShap) drawShap(res[0]);
        }).catch(function () {
            var el = document.getElementById('exp-plot');
            if (el) el.innerHTML =
                '<div class="exp-empty">Failed to load ' + atcf + ' data.</div>';
        });
    }

    /* Chart → PNG through TCExport (the ONE save path — iOS-safe, share-
       sheet aware). Same recipe as the Seasonal panels: force an opaque
       background matching the current viewing theme (else the transparent
       paper exports as a see-through PNG), snapshot, then redraw to restore
       the live transparent styling. */
    function saveChartPng(btn) {
        track(M.key + '_download_png', { storm: _storm || 'none' });
        var el = document.getElementById('exp-plot');
        if (!el || typeof Plotly === 'undefined' || !window.TCExport) return;
        if (!_storm || !_series[_storm]) return;
        var j = _series[_storm];
        var fr = j.frames || [];
        var stamp = fr.length
            ? fr[fr.length - 1].t.slice(0, 16).replace(/[:T-]/g, '')
            : new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '');
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var bg = dark ? '#0d1117' : '#ffffff';
        if (btn) btn.disabled = true;
        var fg = dark ? '#94a3b8' : '#475569';
        var m = JSON.parse(JSON.stringify(el.layout.margin || {}));
        m.b = (m.b || 40) + 58;          // room for the footer band
        Plotly.relayout(el, {
            paper_bgcolor: bg, plot_bgcolor: bg, margin: m,
            images: [{
                source: 'tc-atlas-favicon-96.png',   // same-origin: no canvas taint
                xref: 'paper', yref: 'paper', x: 0, y: -0.085,
                sizex: 0.055, sizey: 0.055,
                xanchor: 'left', yanchor: 'top', layer: 'above'
            }],
            /* Concat, don't replace: the live layout carries the category
               labels from labelBands() and they should survive into the PNG. */
            annotations: (el.layout.annotations || []).concat([{
                xref: 'paper', yref: 'paper', x: 0.065, y: -0.085,
                xanchor: 'left', yanchor: 'top', showarrow: false,
                align: 'left',
                text: '<b>TC-ATLAS</b> &#183; tcatlas.org',
                font: { size: 12, color: fg }
            }, {
                xref: 'paper', yref: 'paper', x: 0.065, y: -0.135,
                xanchor: 'left', yanchor: 'top', showarrow: false,
                align: 'left',
                text: '<b style="color:#F47321">EXPERIMENTAL</b> &#183; ' + M.name + ' is ' +
                      'an unpublished research method (manuscript in ' +
                      'preparation) &#8212; <b>not an official forecast or ' +
                      'analysis</b>.<br>Recon-independent estimates from ' +
                      'infrared imagery + reanalysis environment. Contact the ' +
                      'author before citing or redistributing.',
                font: { size: 10, color: fg }
            }])
        })
            .then(function () {
                return TCExport.savePlotly(el,
                    'TC-ATLAS_' + M.name + '_' + _storm + '_' + stamp + '.png', {
                        format: 'png',
                        width: Math.max(el.clientWidth, 1400),
                        height: Math.max(el.clientHeight, 800),
                        scale: 2
                    });
            })
            .catch(function () {})
            .then(function () {
                if (btn) btn.disabled = false;
                // Restore the live (transparent) theme layout.
                if (_storm && _series[_storm]) drawSeries(_series[_storm]);
            });
    }

    /* Visible x-window for the current range button. Autorange y so a zoomed
       view isn't squashed by the full-lifetime extremes. */
    function applyRange(j) {
        var el = document.getElementById('exp-plot');
        var fr = (j && j.frames) || [];
        if (!el || !fr.length || typeof Plotly === 'undefined') return;
        var last = new Date(fr[fr.length - 1].t);
        var first = new Date(fr[0].t);
        var lo = _rangeH ? new Date(last.getTime() - _rangeH * 3600e3) : first;
        if (lo < first) lo = first;
        var rng = [lo.toISOString(), last.toISOString()];
        /* Strip any previously-painted bands BEFORE autoranging — shapes in
           data coords are included in Plotly's autorange, so stale bands
           would stretch the Vmax axis. paintBands() re-adds them clipped to
           the realised range once it is known. */
        /* The size panel is absent on pressure-only models, so read the
           realised layout rather than assuming three rows — relayouting a
           yaxis3 that doesn't exist would quietly conjure one. */
        var up = {
            shapes: [], annotations: [],
            'xaxis.range': rng, 'xaxis2.range': rng,
            'yaxis.autorange': true, 'yaxis2.autorange': true
        };
        if (el.layout && el.layout.yaxis3) {
            up['xaxis3.range'] = rng;
            up['yaxis3.autorange'] = true;
        }
        Plotly.relayout(el, up).then(function () { paintBands(el); });
    }

    /* Saffir-Simpson category bands + "TS / Cat 1 / …" labels on the Vmax
       panel. Must run AFTER autorange settles: the realised y-range is read
       back, frozen, and the bands are clipped to it so they can never expand
       the axis (a full-height C5 band would otherwise autorange Vmax to
       250 kt for every storm). Rebuilt on every range change. */
    function paintBands(el) {
        var fl = el._fullLayout;
        if (!fl || !fl.yaxis || !fl.yaxis.range) return;
        var yr = fl.yaxis.range.slice();
        var y0 = yr[0], y1 = yr[1];
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var fg = dark ? '#94a3b8' : '#64748b';
        var shapes = [], ann = [];
        SS_BANDS.forEach(function (b) {
            if (b.hi <= y0 || b.lo >= y1) return;
            shapes.push({
                type: 'rect', xref: 'x domain', yref: 'y', x0: 0, x1: 1,
                y0: Math.max(b.lo, y0), y1: Math.min(b.hi, y1),
                fillcolor: hexToRgba(SS_COLORS[b.k], dark ? 0.10 : 0.08),
                line: { width: 0 }, layer: 'below'
            });
            if (b.lo < y1 - (y1 - y0) * 0.05) ann.push({
                xref: 'x domain', yref: 'y', x: 0.994,
                y: Math.max(b.lo, y0), xanchor: 'right', yanchor: 'bottom',
                showarrow: false, text: categoryShort(b.k),
                font: { size: 9, color: fg }, opacity: 0.9
            });
        });
        Plotly.relayout(el, {
            'yaxis.range': yr, 'yaxis.autorange': false,
            shapes: shapes, annotations: ann
        });
    }

    /* ---------------- latest-estimate stat tiles ---------------- */

    function renderTiles(j) {
        var box = document.getElementById('exp-tiles');
        if (!box) return;
        var fr = j.frames || [];
        var v = lastFiniteFrame(fr, 'vmax_kt');
        var p = lastFiniteFrame(fr, 'pmin_hpa');
        var r = lastFiniteFrame(fr, 'rmw_km');
        if (!v) { box.innerHTML = ''; return; }

        /* Trend line: arrow + delta, tinted by strengthening vs weakening
           (falling pressure and contracting RMW both read as strengthening).
           Deltas inside the noise deadband stay neutral so a −1 hPa wiggle
           doesn't wear a bold trend color. */
        var DEADBAND = { kt: 5, hPa: 3, km: 5 };
        function deltaLine(tr, unit, dp, strongerWhenUp) {
            if (!tr) return '<div class="exp-tile-d">— <span class="exp-tile-sub">' +
                '(needs 24 h of history)</span></div>';
            var up = tr.d >= 0;
            var stronger = strongerWhenUp ? up : !up;
            var cls = Math.abs(tr.d) < (DEADBAND[unit] || 0)
                ? '' : (stronger ? 'exp-up' : 'exp-down');
            var arrow = up ? '▲' : '▼';
            var hLbl = Math.abs(tr.h - 24) < 1.5 ? '24 h' : Math.round(tr.h) + ' h';
            return '<div class="exp-tile-d"><span class="' + cls + '">' + arrow +
                ' ' + fmtSigned(tr.d, dp) + ' ' + unit + '</span> over ' + hLbl +
                '</div>';
        }

        var tv = trend24(fr, 'vmax_kt');
        var tp = trend24(fr, 'pmin_hpa');
        var trm = trend24(fr, 'rmw_km');
        var cat = windToCategory(v.v);
        var asOf = '<div class="exp-tile-sub">at ' + v.t.slice(11, 16) + 'Z</div>';

        var windTile =
            '<div class="exp-tile">' +
            '<div class="exp-tile-k">' + M.name + ' max wind' +
            (M.windIsDerived
                ? ' <span class="exp-tile-sub" title="Not a wind model — ' +
                  'this is the modeled pressure passed through a fitted ' +
                  'pressure–wind relationship">(derived)</span>'
                : '') + '</div>' +
            '<div class="exp-tile-v">' + Math.round(v.v) +
            ' <span class="exp-tile-u">kt</span>' +
            '<span class="exp-cat" style="background:' + SS_COLORS[cat] +
            ';color:' + catInk(cat) + '">' + categoryShort(cat) + '</span></div>' +
            deltaLine(tv, 'kt', 0, true) +
            (function () {
                var a = distErrAt(j, v.v, 25), b = distErrAt(j, v.v, 75);
                return (a !== null && b !== null)
                    ? '<div class="exp-tile-sub">IQR ' +
                      Math.round(v.v + a) + '\u2013' + Math.round(v.v + b) +
                      ' kt <span title="25th\u201375th percentile of ' +
                      'storm-held-out CV outcomes at this predicted ' +
                      'intensity">\u24d8</span></div>'
                    : '';
            })() +
            /* NHC RI definition: ≥30 kt in 24 h (scaled to the true baseline). */
            (tv && tv.d * 24 / tv.h >= 30
                ? '<div class="exp-flag">Rapid intensification</div>'
                : (tv && tv.d * 24 / tv.h <= -30
                    ? '<div class="exp-flag down">Rapid weakening</div>' : '')) +
            /* Cat-5 saturation: the calibration chain tops out near
               150–155 kt (isotonic cap + handoff ramp; empirical max ever
               emitted 155.1 kt on held-out 2025). A flat, maxed-out value
               means "at or above the ceiling", not a measurement — and
               decays from saturation are invisible at first. */
            (M.saturates && v.v >= 145
                ? '<div class="exp-tile-sub exp-ceil">near the model’s ' +
                  'saturation ceiling (~150–160 kt) — read as ' +
                  '“at least”, not a precise value</div>'
                : '') +
            asOf + '</div>';

        var presTile = !p ? '' :
            '<div class="exp-tile">' +
            '<div class="exp-tile-k">' + M.name + ' min pressure</div>' +
            '<div class="exp-tile-v">' + Math.round(p.v) +
            ' <span class="exp-tile-u">hPa</span></div>' +
            deltaLine(tp, 'hPa', 0, false) +
            (function () {
                var a = distErrAt(j, p.v, 25, 'pmin_dist'),
                    b = distErrAt(j, p.v, 75, 'pmin_dist');
                return (a !== null && b !== null)
                    ? '<div class="exp-tile-sub">IQR ' +
                      Math.round(p.v + a) + '\u2013' + Math.round(p.v + b) +
                      ' hPa</div>'
                    : '';
            })() +
            '<div class="exp-tile-sub">at ' + p.t.slice(11, 16) + 'Z</div></div>';

        /* Lead with what the model actually predicts. */
        var html = (M.headline === 'pmin_hpa')
            ? presTile + windTile
            : windTile + presTile;

        if (r && M.panels.rmw) {
            var ph = lastFiniteFrame(fr, 'pinhole_prob');
            html +=
                '<div class="exp-tile">' +
                '<div class="exp-tile-k">' + M.name + ' eyewall radius (RMW)</div>' +
                '<div class="exp-tile-v">' + Math.round(r.v) +
                ' <span class="exp-tile-u">km</span></div>' +
                deltaLine(trm, 'km', 0, false) +
                ((ph && ph.v >= 0.10)
                    ? '<div class="exp-tile-sub">pinhole-eye probability ' +
                      Math.round(ph.v * 100) + '%</div>'
                    : '<div class="exp-tile-sub">at ' + r.t.slice(11, 16) +
                      'Z</div>') +
                '</div>';
        }

        /* Latest true best-track analysis + what GHOST said at that same
           time, so the "GHOST continues past the reference" caveat has a
           number. */
        var agT = j.agency || 'NHC';
        var fix = null;
        for (var i = fr.length - 1; i >= 0; i--) {
            if (fr[i].btk_is_fix && fr[i].btk_vmax_kt !== null &&
                fr[i].btk_vmax_kt !== undefined && isFinite(fr[i].btk_vmax_kt)) {
                fix = fr[i]; break;
            }
        }
        if (fix) {
            var ageH = (new Date(v.t) - new Date(fix.t)) / 3.6e6;
            var gAt = (fix.vmax_kt !== null && isFinite(fix.vmax_kt))
                ? fix.vmax_kt : null;
            html +=
                '<div class="exp-tile">' +
                '<div class="exp-tile-k">Last ' + agT + ' analysis</div>' +
                '<div class="exp-tile-v">' + Math.round(fix.btk_vmax_kt) +
                ' <span class="exp-tile-u">kt</span></div>' +
                '<div class="exp-tile-d">at ' + fix.t.slice(11, 16) + 'Z · ' +
                (ageH >= 1 ? Math.round(ageH) + ' h ago' : 'current') + '</div>' +
                (gAt !== null
                    ? '<div class="exp-tile-sub">' + M.name + ' at that time: ' +
                      Math.round(gAt) + ' kt (' +
                      fmtSigned(gAt - fix.btk_vmax_kt, 0) + ')</div>' : '') +
                '</div>';
        }
        if (_archSet[j.storm]) {
            html = '<div class="exp-arch-note">Archived storm — ' +
                'retrospective ' + M.name + ' run over the completed lifetime; ' +
                '“latest” values are the storm’s final analysis.</div>' + html;
        }
        /* Out-of-validation basin: estimates ARE shown, but the disclaimer
           goes above the numbers, not in a footnote under them. */
        var prov = provisionalNote(j.storm, j);
        if (prov) {
            html = '<div class="exp-prov-note">⚠️ ' + prov + '</div>' + html;
        }
        /* Model-version stamp. The description comes from the payload when
           the producer supplies one — the fallback below describes GHOST's
           op-2026c composition layer specifically, and printing that under
           any other model's version string would be a plain misstatement. */
        if (j.model_version) {
            html += '<div class="exp-arch-note">Model: ' + j.model_version +
                ' — ' + (j.model_version_note ||
                'eye-gated high-end refinement over the operational ' +
                'model; per-frame quality control masks land-contaminated ' +
                'and corrupt scenes (chart gaps are frames with no ' +
                'QC-clean estimate).') + '</div>';
        }
        box.innerHTML = html;
    }

    /* ---------------- conditional-distribution panel ---------------- */

    /* Full predictive distribution for the LATEST frame, as a CDF: for each
       stored percentile, x = estimate + conditional OOF error quantile,
       y = cumulative probability. The long right tail at high intensities is
       real information — storms whose frames carried similar predictions
       have verified far above them (that's where the monsters live). */
    function drawDist(j) {
        var box = document.getElementById('exp-dist');
        if (!box || typeof Plotly === 'undefined') return;
        var v = lastFiniteFrame(j.frames || [], 'vmax_kt');
        if (!v || !j.vmax_dist || !j.vmax_dist.err_q) {
            box.innerHTML = '<div class="exp-empty">No distribution lookup ' +
                'in this storm\u2019s file yet (republish to populate).</div>';
            return;
        }
        box.innerHTML =
            '<div class="exp-shap-head">Predictive distributions \u2014 ' +
            v.t.slice(5, 16).replace('T', ' ') + 'Z' +
            '<span class="exp-shap-sub">calibrated from storm-held-out CV ' +
            'frames with similar predicted values (bin sample size on each ' +
            'panel). The right tail of the wind panel is real information: ' +
            'it reflects storms that verified far above similar predictions ' +
            '\u2014 near the Cat-5 ceiling the point estimate is ' +
            'analog-limited and the tail carries the monster risk. RMW band ' +
            'pending its own CV artifact.</span></div>' +
            '<div class="exp-shap-grid">' +
            '<div id="exp-dist-v"></div><div id="exp-dist-p"></div></div>';
        cdfFig('exp-dist-v', j, 'vmax_dist', 'vmax_kt', 'Vmax (kt)', 'btk_vmax_kt');
        cdfFig('exp-dist-p', j, 'pmin_dist', 'pmin_hpa', 'Pmin (hPa)', 'btk_mslp_hpa');
    }

    function cdfFig(elId, j, key, field, label, refField) {
        var d = j[key];
        var v = lastFiniteFrame(j.frames || [], field);
        var el = document.getElementById(elId);
        if (!el) return;
        if (!d || !d.err_q || !d.pcts || !v) { el.innerHTML = ''; return; }
        var xs = [], ys = [];
        d.pcts.forEach(function (pc) {
            var e = distErrAt(j, v.v, pc, key);
            if (e !== null) { xs.push(v.v + e); ys.push(pc); }
        });
        if (xs.length < 4) { el.innerHTML = ''; return; }
        var bi = distBin(j, v.v, key);
        var n = (d.n && bi >= 0) ? d.n[bi] : null;
        var q25 = v.v + (distErrAt(j, v.v, 25, key) || 0);
        var q75 = v.v + (distErrAt(j, v.v, 75, key) || 0);
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var grid = dark ? '#1e293b' : '#e2e8f0';
        var fc = dark ? '#cbd5e1' : '#334155';
        var ref = refField ? lastFiniteFrame(j.frames || [], refField) : null;
        var shapes = [
            { type: 'rect', xref: 'x', yref: 'paper', x0: q25, x1: q75,
              y0: 0, y1: 1, fillcolor: 'rgba(244,63,94,0.10)',
              line: { width: 0 }, layer: 'below' },
            { type: 'line', xref: 'x', yref: 'paper', x0: v.v, x1: v.v,
              y0: 0, y1: 1, line: { color: MODEL_COL, width: 2 } }
        ];
        var ann = [{
            x: v.v, y: 0.97, xref: 'x', yref: 'paper', showarrow: false,
            text: M.name + ' ' + Math.round(v.v),
            font: { size: 10, color: MODEL_COL }, xanchor: 'left'
        }];
        if (ref) {
            shapes.push({ type: 'line', xref: 'x', yref: 'paper',
                x0: ref.v, x1: ref.v, y0: 0, y1: 1,
                line: { color: fc, width: 1.4, dash: 'dash' } });
            ann.push({ x: ref.v, y: 0.06, xref: 'x', yref: 'paper',
                showarrow: false, text: (j.agency || 'NHC') + ' ' +
                Math.round(ref.v), font: { size: 10, color: fc },
                xanchor: 'right' });
        }
        Plotly.react(elId, [{
            x: xs, y: ys, mode: 'lines+markers',
            line: { color: MODEL_COL, width: 2, shape: 'spline' },
            marker: { size: 5, color: MODEL_COL },
            hovertemplate: '%{y}% of similar CV frames verified \u2264 ' +
                '%{x:.0f}<extra></extra>'
        }], {
            height: 290, margin: { l: 48, r: 14, t: 22, b: 42 },
            title: { text: label + (n ? ' \u2014 n=' + n : ''),
                     font: { size: 11 } },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: dark ? 'rgba(15,23,42,0.55)' : 'rgba(248,250,252,0.7)',
            font: { color: fc, size: 10 },
            shapes: shapes, annotations: ann,
            xaxis: { title: { text: label, font: { size: 10 } },
                     gridcolor: grid },
            yaxis: { title: { text: 'cumulative %', font: { size: 10 } },
                     gridcolor: grid, range: [0, 100] }
        }, { displayModeBar: false, responsive: true })
          .then(function () { Plotly.Plots.resize(elId); });
    }

    /* ---------------- center-track mini-map ---------------- */

    /* The producer publishes the IR-recentered center for every frame
       (center_lat/lon + eye_recentered) but until now nothing displayed
       them. Full-lifetime track colored by model intensity; open circles
       mark frames where no IR eye lock was found and the center fell back
       to the interpolated/extrapolated NHC track. */
    function drawTrack(j) {
        var box = document.getElementById('exp-track');
        if (!box || typeof Plotly === 'undefined') return;
        var fr = (j.frames || []).filter(function (f) {
            return f.center_lat !== null && f.center_lat !== undefined &&
                   f.center_lon !== null && f.center_lon !== undefined;
        });
        if (fr.length < 2) {
            box.innerHTML = '<div class="exp-empty">No center-fix positions ' +
                'published for this storm yet.</div>';
            return;
        }
        var lats = fr.map(function (f) { return f.center_lat; });
        var lons = fr.map(function (f) { return f.center_lon; });
        /* Dateline-crossing track (CP basin): unwrap so the range is contiguous. */
        if (Math.max.apply(null, lons) - Math.min.apply(null, lons) > 180) {
            lons = lons.map(function (l) { return l < 0 ? l + 360 : l; });
        }
        var cols = fr.map(function (f) {
            return SS_COLORS[windToCategory(f.vmax_kt)]; });
        var syms = fr.map(function (f) {
            return f.eye_recentered ? 'circle' : 'circle-open'; });
        var hover = fr.map(function (f) {
            var cat = windToCategory(f.vmax_kt);
            return f.t.slice(5, 16).replace('T', ' ') + 'Z — ' +
                (f.vmax_kt != null ? Math.round(f.vmax_kt) + ' kt (' +
                    categoryShort(cat) + ')' : '—') +
                (f.rmw_km != null ? ' · RMW ' + Math.round(f.rmw_km) + ' km' : '') +
                (f.eye_recentered ? ' · IR-fixed center' : ' · track first-guess');
        });
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var grid = dark ? '#1e293b' : '#e2e8f0';
        var latPad = 2, lonPad = 2.5;
        var lo = Math.min.apply(null, lons), hi = Math.max.apply(null, lons);
        var la = Math.min.apply(null, lats), lb = Math.max.apply(null, lats);

        box.innerHTML =
            '<div class="exp-shap-head">' + M.name + ' center track' +
            '<span class="exp-shap-sub">full lifetime, colored by ' + M.name + ' ' +
            'intensity. Open circles = no IR eye lock; the center there comes ' +
            'from the interpolated ' + (j.agency || 'NHC') +
            ' track instead.</span></div>' +
            '<div id="exp-track-map"></div>' +
            '<div class="exp-track-leg" id="exp-track-leg"></div>';
        var leg = document.getElementById('exp-track-leg');
        if (leg) {
            var legHtml = '';
            ['TD', 'TS', 'C1', 'C2', 'C3', 'C4', 'C5'].forEach(function (k) {
                legHtml += '<span><i style="background:' + SS_COLORS[k] +
                    '"></i>' + categoryShort(k) + '</span>';
            });
            legHtml += '<span><i class="open"></i>track-based center</span>';
            leg.innerHTML = legHtml;
        }

        var traces = [
            { type: 'scattergeo', mode: 'lines', lat: lats, lon: lons,
              line: { color: dark ? '#475569' : '#94a3b8', width: 1 },
              hoverinfo: 'skip', showlegend: false },
            { type: 'scattergeo', mode: 'markers', lat: lats, lon: lons,
              marker: { size: 6, color: cols, symbol: syms,
                        line: { width: 0.5,
                                color: dark ? '#0f172a' : '#ffffff' } },
              text: hover, hoverinfo: 'text', showlegend: false },
            /* current position, emphasised */
            { type: 'scattergeo', mode: 'markers', lat: [lats[lats.length - 1]],
              lon: [lons[lons.length - 1]],
              marker: { size: 12, color: cols[cols.length - 1],
                        symbol: syms[syms.length - 1],
                        line: { width: 2,
                                color: dark ? '#e2e8f0' : '#0f172a' } },
              text: [hover[hover.length - 1]], hoverinfo: 'text',
              showlegend: false }
        ];
        /* Geo plots letterbox inside a fixed height (the projection keeps its
           own aspect), so derive the height from the track's lat/lon extent
           and the container width instead of hardcoding it — otherwise a
           long low-latitude track swims in vertical whitespace on phones. */
        var mapEl = document.getElementById('exp-track-map');
        var mapW = (mapEl && mapEl.clientWidth) || 800;
        var aspect = (lb - la + 2 * latPad) / Math.max(1, hi - lo + 2 * lonPad);
        var mapH = Math.max(240, Math.min(520, Math.round(mapW * aspect * 1.15)));
        Plotly.react('exp-track-map', traces, {
            height: mapH, margin: { l: 0, r: 0, t: 4, b: 0 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            geo: {
                projection: { type: 'mercator' },
                lonaxis: { range: [lo - lonPad, hi + lonPad],
                           showgrid: true, gridcolor: grid, dtick: 5 },
                lataxis: { range: [la - latPad, lb + latPad],
                           showgrid: true, gridcolor: grid, dtick: 5 },
                resolution: 50,
                showland: true,
                landcolor: dark ? '#1e293b' : '#e2e8f0',
                showocean: true,
                oceancolor: dark ? 'rgba(15,23,42,0.55)' : 'rgba(248,250,252,0.7)',
                showcoastlines: true,
                coastlinecolor: dark ? '#475569' : '#94a3b8',
                showcountries: true,
                countrycolor: dark ? '#334155' : '#cbd5e1',
                bgcolor: 'rgba(0,0,0,0)'
            }
        }, { displayModeBar: false, responsive: true })
          .then(function () { Plotly.Plots.resize('exp-track-map'); });
    }

    /* Plain-language glosses for the SHAP feature names. CONCEPTUAL ONLY —
       each says WHAT a feature measures, never HOW it is computed (no
       formulas, thresholds, kernels or window details); that stays with the
       manuscript. Grounded in the producer's own docstrings
       (build_symmetry_cdo.py, dvorak_feats.py, build_train_table.py,
       build_multiframe_feats.py) — do NOT guess new entries, a wrong gloss
       is worse than none. Suffixes: _km = kernel-smoothed over recent
       frames (NOT kilometres), _tr = its recent trend. */
    var FEATURE_GLOSS = {
        tc_lat: 'Storm latitude',
        age_h: 'Time since the system became a tropical cyclone',
        vmax_init: 'Intensity input to the size model (GHOST’s own estimate)',
        pres_init: 'Central-pressure input to the size model (GHOST’s own estimate)',
        mpi_init: 'Maximum potential intensity of the current ocean–atmosphere environment',
        shdc_init: 'Deep-layer vertical wind shear over the storm',
        sddc_init: 'Direction the deep-layer shear comes from',
        rhlo_init: 'Lower-troposphere relative humidity near the storm',
        rhmd_init: 'Mid-troposphere relative humidity near the storm',
        rhhi_init: 'Upper-troposphere relative humidity near the storm',
        pw2m_init: 'Column moisture (precipitable water) near the core',
        pw5m_init: 'Column moisture over the broader storm environment',
        dist2land: 'Distance to the nearest land',
        mot_speed: 'Forward (translation) speed of the storm',
        s0_eye_tb: 'Mean cloud-top warmth inside the eye region',
        s0_eye_tb_max: 'Warmest single eye pixel — subsidence warming, a classic intense-storm signal',
        s0_eye_maxcontrast: 'Warmest eye pixel vs the coldest eyewall ring (warm-eye-over-cold-eyewall contrast)',
        s0_eye_cdo_contrast: 'Mean eye warmth vs the coldest ring of the central overcast',
        s0_cdo_min_tb: 'Coldest ring-averaged cloud-top temperature (canopy coldness)',
        s0_cdo_min_rad: 'Radius of the coldest cloud-top ring (roughly the eyewall radius)',
        s0_cdo_mean_tb: 'Overall coldness of the central dense overcast',
        s0_ewall_wn1: 'One-sided (wavenumber-1) asymmetry of the eyewall cloud',
        s0_ewall_wn2: 'Elliptical (wavenumber-2) asymmetry of the eyewall cloud',
        s0_ewall_azistd: 'Unevenness of the eyewall cloud tops around the ring',
        s0_ewall_wn1frac: 'Share of eyewall asymmetry carried by its one-sided component',
        eye_tb_center: 'Cloud-top temperature right at the storm center',
        irb_rimn: 'Mean cloud-top temperature in the inner core',
        irb_rmmn: 'Mean cloud-top temperature in the middle core',
        irb_romn: 'Mean cloud-top temperature in the outer core',
        irb_risd: 'Ring-wise unevenness of inner-core cloud tops (low = symmetric)',
        irb_rmsd: 'Ring-wise unevenness of middle-core cloud tops (low = symmetric)',
        irb_rosd: 'Ring-wise unevenness of outer-core cloud tops (low = symmetric)',
        irb_min_tb: 'Coldest ring-averaged cloud-top temperature',
        irb_min_rad: 'Radius of the coldest cloud-top ring',
        irb_rad_dif: 'Warmth at the center vs the coldest ring around it',
        irb_grad_rad: 'Sharpest center-outward change in cloud-top temperature',
        irb_wn0_kur: 'Peakedness of the cloud-top temperature distribution',
        dv_banding_wrap: 'How completely cold banding wraps around the storm center',
        dv_conv_disp: 'Offset of the cold-convection mass from the storm center',
        dv_cdo_edge_sharp: 'Sharpness of the central overcast’s outer edge',
        dv_cold_frac_inner: 'Fraction of very cold cloud tops in the inner core',
        spiral: 'How coherently the cloud field organizes into a log-spiral banding pattern',
        spiral_disp: 'Offset between the best-fit spiral pattern and the storm center',
        spiral_norm: 'Spiral organization relative to the overall sharpness of the imagery',
        ltr12_eye: '12-hour warming/cooling trend of the eye region',
        ltr12_cdo: '12-hour warming/cooling trend of the cloud canopy',
        ltr6_cdo: '6-hour warming/cooling trend of the cloud canopy',
        'vigor_r050-r075': 'Convective vigor (coldness vs the storm’s recent minimum) in the 50–75 km ring',
        'vigor_r075-r100': 'Convective vigor (coldness vs the storm’s recent minimum) in the 75–100 km ring',
        'vigor_r100-r125': 'Convective vigor (coldness vs the storm’s recent minimum) in the 100–125 km ring',
        ir_vigor_eye_max: 'Peak convective vigor in the eye region',
        ir_vigor_rad: 'Radius of peak convective vigor',
        irb_vigor_azi_rad: 'Radius of the strongest ring-averaged convective vigor',
        irb_vigor_zero_rad: 'Radius where convective vigor fades to zero',
        irb_vigor_grad_rad: 'How sharply convective vigor changes with radius',
        irb_vigor_grad2_rad: 'Curvature of the convective-vigor profile with radius',
        irb_rad_grad2_val: 'Curvature of the cloud-top temperature profile near its steepest edge',
        cold_frac65_outer_mean: 'Fraction of cold cloud in the outer (100–200 km) band',
        r_eye: 'Apparent eye radius from the infrared imagery',
        r_cold: 'Radius of the surrounding cold-top ring',

        /* ---- FPM predictors ----
           A different model with a different feature set, so the hover text
           has to cover it too — otherwise every bar on the FPM drivers panel
           reads "Model input feature", which is worse than no panel. Names
           are the ridge's own design columns (fpm_v1_core.design_names /
           weak_names); `^2` and `log_` are stripped by featGloss below. */
        grad_in: 'How sharply cloud tops cool outward through the inner core',
        rad_rng_30: 'Warmest-to-coldest spread of cloud tops inside 30 km',
        mo_r200: 'Mean cloud-top temperature on the 200 km ring',
        m_r50: 'Mean cloud-top temperature on the 50 km ring',
        m_r100: 'Mean cloud-top temperature on the 100 km ring',
        m_r150: 'Mean cloud-top temperature on the 150 km ring',
        m_r200: 'Mean cloud-top temperature on the 200 km ring',
        m_r300: 'Mean cloud-top temperature on the 300 km ring',
        sd_r50: 'Unevenness of cloud tops around the 50 km ring',
        sd_r100: 'Unevenness of cloud tops around the 100 km ring',
        sd_r150: 'Unevenness of cloud tops around the 150 km ring',
        sd_r300: 'Unevenness of cloud tops around the 300 km ring',
        r_eyewall: 'Radius of the coldest cloud-top ring — the eyewall’s infrared scale, and the inner limit of the pressure integral',
        tb_ring: 'Cloud-top temperature of the eyewall ring — how deep eyewall convection is reaching',
        ring_azstd: 'Unevenness of cloud tops around the eyewall ring',
        ring_wn1: 'One-sided (wavenumber-1) asymmetry of the eyewall ring',
        ring_wn2: 'Elliptical (wavenumber-2) asymmetry of the eyewall ring',
        ring_closed_215: 'How completely the −58 °C (215 K) ring closes around the center',
        ring_range: 'Warmest-to-coldest spread around the eyewall ring',
        rad_sd_30: 'Radial structure of the core inside 30 km',
        rad_sd_50: 'Radial structure of the core inside 50 km',
        band_w: 'Thickness of the central dense overcast',
        band_lo: 'Inner edge of the central dense overcast',
        band_azsd_out: 'Unevenness of the outer banding around the storm',
        cdo_depth: 'Coldness of the central dense overcast — how deep its convection is',
        cdo_ext: 'How far the cold shield extends beyond the eyewall',
        cold_int300: 'Total cold-cloud coverage out to 300 km — the outer scale of the pressure integral',
        slope_out2: 'How quickly cloud tops warm outward beyond the canopy',
        asym_in: 'Departure of the inner core from axisymmetry',
        edge_ragged: 'Raggedness of the cloud canopy’s outer edge',
        dyn_rad: 'Radius at which the cloud-top profile changes character',
        dep_r100: 'How much colder the 100 km ring is than the surrounding airmass',
        dep_eye: 'How much warmer the eye is than the surrounding airmass',
        eye_wc: 'Warm-core prominence — the warmest eye pixels against the eye’s own mean',
        eye_tb: 'Cloud-top temperature in the eye',
        eye_defined: 'Whether a warm eye is resolvable at all in this frame',
        eye_contrast_deblurred: 'Eye-to-eyewall warmth contrast, corrected for the imagery blurring a small eye',
        cf220_200: 'Fraction of cloud colder than −53 °C within 200 km',
        cfrel65_200: 'Fraction within 200 km colder than the local airmass by 65 K — a threshold that means the same thing in any environment',
        cfrel45_200: 'Fraction within 200 km colder than the local airmass by 45 K',
        cfrel65_100: 'Fraction within 100 km colder than the local airmass by 65 K',
        rrel55: 'Area-equivalent radius of cloud 55 K colder than the local airmass',
        rrel75: 'Area-equivalent radius of cloud 75 K colder than the local airmass',
        r_cold220: 'Radius of the −53 °C (220 K) cold shield',
        r_cold235: 'Radius of the −38 °C (235 K) cold shield',
        absLat: 'Storm latitude',
        doy_sin: 'Time of year (seasonal phase)',
        translation_speed_24h: 'Forward speed of the storm, averaged over the last day',
        slow_mover_flag: 'Whether the storm has been moving slowly enough to churn its own ocean',
        land_fraction: 'Share of the surrounding area that is land',
        land_fraction_x_deficit: 'Land interaction, scaled by how deep the storm already is',
        mpi: 'Maximum potential intensity of the current ocean–atmosphere environment',
        mpi_x_deficit: 'Environmental potential, scaled by how deep the storm already is',
        disp: 'Offset between the best-fit spiral pattern and the storm center',
        norm: 'Spiral organization relative to the overall sharpness of the imagery',
        offcen_gain: 'How much better the spiral pattern fits off-center than at the center',
        min_sharp: 'How sharply the spiral fit degrades away from its best center — a well-defined center scores high',
        coh_inner: 'How well the inner cloud field aligns with a spiral',
        coh_outer: 'How well the outer cloud field aligns with a spiral',
        coh_io: 'Inner-minus-outer spiral coherence — whether organization is concentrated in the core',
        grad_conc: 'Share of the image’s structure concentrated in the inner core',
        hours_since_genesis: 'How long the system has existed',
        hours_since_own_peak: 'How long since the model’s own deepest reading',
        decline_from_own_peak: 'How far the model has backed off its own peak — a decay clock'
    };
    function featGloss(f) {
        if (FEATURE_GLOSS[f]) return FEATURE_GLOSS[f];
        var base = f.replace(/_(km|tr)$/, '');
        var sfx = /_km$/.test(f)
            ? ' — smoothed over the last few hours'
            : (/_tr$/.test(f) ? ' — its recent trend' : '');
        /* FPM decorates its design columns: `^2` is the squared (curvature)
           copy of a core term, `log_` a log-compressed size term, `d3_` a
           3-hour change. Strip and annotate rather than losing the gloss. */
        if (/\^2$/.test(base)) {
            base = base.replace(/\^2$/, '');
            sfx = ' — its squared term, letting the fit curve rather than ' +
                  'run straight' + sfx;
        }
        if (/^log_/.test(base)) {
            base = base.replace(/^log_/, '');
            sfx = ' — on a log scale' + sfx;
        }
        if (/^d3_/.test(base)) {
            base = base.replace(/^d3_/, '');
            sfx = ' — its change over the last 3 hours' + sfx;
        }
        if (FEATURE_GLOSS[base]) return FEATURE_GLOSS[base] + sfx;
        if (/^m_r\d+$/.test(base))
            return 'Mean cloud-top temperature on the ' +
                   base.slice(3) + ' km ring' + sfx;
        if (/^sd_r\d+$/.test(base))
            return 'Unevenness of cloud tops around the ' +
                   base.slice(4) + ' km ring' + sfx;
        if (/^(s0_|irb_|eye_|ir_)/.test(base))
            return 'Infrared cloud-top structure metric' + sfx;
        if (/^(dv_|spiral)/.test(base))
            return 'Cloud organization / banding metric' + sfx;
        if (/_init$/.test(base)) return 'Large-scale environment input';
        return 'Model input feature' + sfx;
    }
    /* Plotly hover labels don't wrap — break long glosses ourselves. */
    function wrapGloss(s) {
        var words = s.split(' '), lines = [], cur = '';
        words.forEach(function (w) {
            if ((cur + ' ' + w).length > 44) { lines.push(cur); cur = w; }
            else cur = cur ? cur + ' ' + w : w;
        });
        if (cur) lines.push(cur);
        return lines.join('<br>');
    }

    /* Exact TreeSHAP from the producer. Explains the RAW Stage-A booster and
       the base-18 RMW model -- deliberately NOT the published values, which
       add calibration, Stage-B inertia, a causal kernel and the pinhole
       blend. The panel says so, so nobody reads it as a decomposition of the
       number on the chart above. */
    function drawShap(j) {
        var box = document.getElementById('exp-shap');
        if (!box || typeof Plotly === 'undefined') return;
        var sh = j.shap;
        /* Two payload shapes, both supported on purpose. GHOST publishes
           `vmax_latest` / `rmw_latest` / `vmax_base` (TreeSHAP over a boosted
           stack); FPM publishes a generic `panels` array with its own units
           and titles, because a ridge's drivers are exact coefficients in
           hectopascals rather than approximated contributions in knots. New
           producers should use `panels` \u2014 the old keys are read so the
           GHOST objects already on the CDN keep rendering. */
        var panels = (sh && sh.panels) ? sh.panels : null;
        if (!panels && sh && sh.vmax_latest) {
            panels = [{ key: 'v', unit: ' kt', title: 'Intensity drivers (kt)',
                        bars: sh.vmax_latest }];
            if (sh.rmw_latest) {
                panels.push({ key: 'r', unit: ' %',
                              title: 'Size (RMW) drivers (% effect)',
                              bars: sh.rmw_latest });
            }
        }
        if (!panels || !panels.length) {
            box.innerHTML = '<div class="exp-empty">No driver attribution in ' +
                'this storm\'s file yet (republish to populate).</div>';
            return;
        }
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var grid = dark ? '#1e293b' : '#e2e8f0';
        var fc = dark ? '#cbd5e1' : '#334155';
        var last = (j.frames || []).slice(-1)[0];
        var gUnit = sh.groups_unit || 'kt';
        var blurb = sh.note ||
            ('exact TreeSHAP. Explains the intensity model\u2019s first-pass ' +
             'estimate (base ' + (sh.vmax_base || 0).toFixed(1) + ' kt) and ' +
             'the size model \u2014 not the calibrated, time-smoothed values ' +
             'plotted above.');
        box.innerHTML =
            '<div class="exp-shap-head">Model drivers &mdash; ' +
            (last ? last.t.slice(0, 16).replace('T', ' ') + 'Z' : '') +
            '<span class="exp-shap-sub">' + blurb +
            ' Hover a bar for what that feature measures.</span></div>' +
            '<div class="exp-shap-grid">' +
            panels.map(function (p, i) {
                return '<div id="exp-shap-p' + i + '"></div>';
            }).join('') + '</div>' +
            '<div id="exp-shap-t"></div>';

        function barFig(el, rows, unit, title) {
            if (!rows || !rows.length) return;
            var r = rows.slice().reverse();
            Plotly.react(el, [{
                type: 'bar', orientation: 'h',
                x: r.map(function (d) { return d.v; }),
                y: r.map(function (d) { return d.f; }),
                customdata: r.map(function (d) {
                    return wrapGloss(featGloss(d.f)); }),
                marker: { color: r.map(function (d) {
                    return d.v >= 0 ? '#f43f5e' : '#2e7dff'; }) },
                hovertemplate: '%{y}: %{x:+.2f}' + unit +
                    '<br><i>%{customdata}</i><extra></extra>'
            }], {
                title: { text: title, font: { size: 12 } },
                height: 300, margin: { l: 150, r: 12, t: 30, b: 34 },
                paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
                font: { color: fc, size: 10 },
                xaxis: { zeroline: true, zerolinecolor: fc, gridcolor: grid,
                         title: { text: unit, font: { size: 10 } } },
                yaxis: { automargin: true }
            }, { displayModeBar: false, responsive: true })
              .then(function () { Plotly.Plots.resize(el); });
        }
        panels.forEach(function (p, i) {
            barFig('exp-shap-p' + i, p.bars, p.unit || ' kt', p.title || '');
        });

        if (sh.groups && j.frames) {
            var t = j.frames.map(function (f) { return f.t; });
            var col = { 'IR structure': '#f43f5e',
                        'Organization / banding': '#a855f7',
                        'Environment': '#2e7dff',
                        'Temporal (multi-frame)': '#14b8a6',
                        'Storm age': '#f59e0b' };
            var tr = Object.keys(sh.groups).map(function (g) {
                return { x: t, y: sh.groups[g], name: g, mode: 'lines',
                         line: { color: col[g] || '#94a3b8', width: 1.8 } };
            });
            Plotly.react('exp-shap-t', tr, {
                title: { text: 'Grouped contribution through the storm\'s life',
                         font: { size: 12 } },
                height: 260, margin: { l: 54, r: 12, t: 30, b: 40 },
                paper_bgcolor: 'rgba(0,0,0,0)',
                plot_bgcolor: dark ? 'rgba(15,23,42,0.55)' : 'rgba(248,250,252,0.7)',
                font: { color: fc, size: 10 }, hovermode: 'x unified',
                legend: { orientation: 'h', y: -0.22, font: { size: 10 } },
                xaxis: { gridcolor: grid },
                yaxis: { title: { text: gUnit, font: { size: 10 } },
                         gridcolor: grid, zeroline: true, zerolinecolor: fc }
            }, { displayModeBar: false, responsive: true })
              .then(function () { Plotly.Plots.resize('exp-shap-t'); });
        }
    }

    function drawSeries(j) {
        var el = document.getElementById('exp-plot');
        if (!el || typeof Plotly === 'undefined') return;
        var fr = j.frames || [];
        var t = fr.map(function (f) { return f.t; });
        function col(k) { return fr.map(function (f) {
            return (f[k] === null || f[k] === undefined) ? null : f[k];
        }); }
        /* Two gates, both required: the profile has to claim a size product
           AND the payload has to actually carry one. Either alone would
           render an empty third panel — indistinguishable from a broken
           feed — on a run where the size stage failed. */
        var hasRmw = M.panels.rmw &&
            fr.some(function (f) { return f.rmw_km != null; });
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var font = { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", ' +
                             'Roboto, Helvetica, Arial, sans-serif',
                     color: dark ? '#cbd5e1' : '#334155' };
        var grid = dark ? '#1e293b' : '#e2e8f0';
        var nhc = { color: dark ? '#94a3b8' : '#64748b', width: 1.4,
                    dash: 'dash' };
        var ag = j.agency || 'NHC';
        var traces = [];
        /* Conditional IQR band: per-frame 25th/75th-percentile bounds from
           the storm-held-out OOF error distribution, conditioned on the
           prediction level (lookup shipped in the JSON). Drawn under the
           GHOST line; the full distribution lives in the Distribution
           panel. */
        var iqr = distBounds(j, 25, 75);
        if (iqr) {
            traces.push(
                { x: t, y: iqr.lo, yaxis: 'y', xaxis: 'x', mode: 'lines',
                  line: { width: 0 }, hoverinfo: 'skip', showlegend: false },
                { x: t, y: iqr.hi, yaxis: 'y', xaxis: 'x', mode: 'lines',
                  line: { width: 0 }, fill: 'tonexty',
                  fillcolor: 'rgba(244,63,94,0.13)',
                  name: 'IQR (conditional)',
                  hovertemplate: '%{y:.0f} kt (p75)' });
        }
        traces.push(
            /* One GHOST color across all three panels so the single legend
               entry means the same thing everywhere (the y-axis titles already
               say which quantity each panel shows). */
            { x: t, y: col('vmax_kt'), name: M.name, yaxis: 'y',
              line: { color: MODEL_COL, width: 2.4 },
              hovertemplate: '%{y:.1f} kt' });
        traces = traces.concat([
            { x: t, y: col('btk_vmax_kt'), name: ag + ' best track (interp)',
              yaxis: 'y', line: nhc, connectgaps: false,
              hovertemplate: '%{y:.0f} kt' },
            { x: fr.filter(function (d) { return d.btk_is_fix; })
                   .map(function (d) { return d.t; }),
              y: fr.filter(function (d) { return d.btk_is_fix; })
                   .map(function (d) { return d.btk_vmax_kt; }),
              name: ag + ' analysis', yaxis: 'y', mode: 'markers',
              marker: { size: 5, color: nhc.color } },
            (function () {
                var b = distBounds(j, 25, 75, 'pmin_dist', 'pmin_hpa');
                return b ? { x: t, y: b.lo, yaxis: 'y2', mode: 'lines',
                    line: { width: 0 }, hoverinfo: 'skip',
                    showlegend: false } : null;
            })(),
            (function () {
                var b = distBounds(j, 25, 75, 'pmin_dist', 'pmin_hpa');
                return b ? { x: t, y: b.hi, yaxis: 'y2', mode: 'lines',
                    line: { width: 0 }, fill: 'tonexty',
                    fillcolor: 'rgba(244,63,94,0.13)', showlegend: false,
                    hovertemplate: '%{y:.0f} hPa (p75)',
                    name: 'IQR' } : null;
            })(),
            { x: t, y: col('pmin_hpa'), name: M.name, yaxis: 'y2',
              line: { color: MODEL_COL, width: 2.4 }, showlegend: false,
              hovertemplate: '%{y:.0f} hPa' },
            { x: t, y: col('btk_mslp_hpa'), name: ag + ' best track (interp)',
              yaxis: 'y2', line: nhc, showlegend: false, connectgaps: false,
              hovertemplate: '%{y:.0f} hPa' },
            /* Size panel only where the model actually predicts size. Nulls
               are dropped by the filter below, the same way the conditional
               IQR bands are. */
            hasRmw ? { x: t, y: col('rmw_km'), name: M.name, yaxis: 'y3',
              line: { color: MODEL_COL, width: 2.4 }, showlegend: false,
              hovertemplate: '%{y:.0f} km' } : null,
            hasRmw ? { x: t, y: col('btk_rmw_km'), name: ag + ' RMW', yaxis: 'y3',
              line: nhc, showlegend: false, connectgaps: false,
              hovertemplate: '%{y:.0f} km' } : null
        ]);
        /* Mobile: 7 legend entries (now carrying update times) wrap to three
           rows and used to sit ON TOP of the Vmax panel, and the fixed 58 px
           left margin clipped "RMW (km)" to "1W (km)". Give the legend real
           room above the plot, shrink its font, and let the y-axes claim the
           margin they need. */
        var narrow = window.innerWidth < 640;
        /* Legend always sits ABOVE the plot area (yanchor bottom at y=1.0)
           so its rows grow upward into the top margin, never down onto the
           Vmax panel. The margin must therefore budget for the wrapped rows:
           comparators add up to 4 extra entries (with update-time stamps)
           which wrap to 2-3 rows at desktop widths too, not just on phones. */
        var topM = narrow ? (_showComp ? 116 : 64)
                          : (_showComp ? 88 : 48);
        var layout = {
            grid: { rows: hasRmw ? 3 : 2, columns: 1, pattern: 'independent',
                    roworder: 'top to bottom' },
            height: (narrow ? (hasRmw ? 640 : 470) : (hasRmw ? 560 : 415)) +
                    (topM - (narrow ? 104 : 26)),
            margin: narrow ? { l: 8, r: 8, t: topM, b: 44 }
                           : { l: 58, r: 16, t: topM, b: 40 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: dark ? 'rgba(15,23,42,0.55)' : 'rgba(248,250,252,0.7)',
            font: font,
            hovermode: 'x unified',
            legend: narrow
                ? { orientation: 'h', y: 1.0, yanchor: 'bottom', x: 0,
                    xanchor: 'left', font: { size: 9 },
                    itemwidth: 30, tracegroupgap: 2 }
                : { orientation: 'h', y: 1.0, yanchor: 'bottom', x: 0,
                    xanchor: 'left', font: { size: 11 } },
            /* Saffir-Simpson bands are painted AFTER autorange settles (see
               paintBands) — shapes in data coords participate in Plotly's
               y-autorange, so declaring the 250-kt C5 band here would blow
               the Vmax axis out to 250 regardless of the storm. */
            /* The bottom panel owns the tick labels and every other x-axis
               matches it — which panel that is depends on whether the size
               panel exists. */
            xaxis:  { anchor: 'y',  gridcolor: grid,
                      matches: hasRmw ? 'x3' : 'x2',
                      showticklabels: false },
            xaxis2: { anchor: 'y2', gridcolor: grid,
                      matches: hasRmw ? 'x3' : undefined,
                      showticklabels: !hasRmw, automargin: !hasRmw },
            yaxis:  { title: { text: M.windIsDerived
                                 ? 'Vmax (kt, derived)' : 'Vmax (kt)',
                               standoff: 4 },
                      automargin: true, gridcolor: grid,
                      domain: hasRmw ? [0.70, 1.00] : [0.56, 1.00] },
            yaxis2: { title: { text: 'Pmin (hPa)', standoff: 4 }, automargin: true, gridcolor: grid,
                      domain: hasRmw ? [0.36, 0.64] : [0.00, 0.46] }
        };
        if (hasRmw) {
            layout.xaxis3 = { anchor: 'y3', gridcolor: grid, automargin: true };
            layout.yaxis3 = { title: { text: 'RMW (km)', standoff: 4 },
                              automargin: true, gridcolor: grid,
                              domain: [0.00, 0.30], rangemode: 'tozero' };
        }
        /* Assign subplot x-axes by the trace's y-axis, not by position —
           the conditional IQR band shifts indices. */
        traces = traces.filter(function (tr) { return tr; });
        traces.forEach(function (tr) {
            if (tr.yaxis === 'y2') tr.xaxis = tr.xaxis || 'x2';
            if (tr.yaxis === 'y3') tr.xaxis = tr.xaxis || 'x3';
        });

        /* Operational satellite estimators, scored against the same target.
           Sparse + irregular (f-deck fixes are a few per day), so markers
           with connecting lines rather than a continuous curve. */
        if (_showComp && j.comparators) {
            Object.keys(j.comparators).forEach(function (name) {
                var rows = j.comparators[name] || [];
                if (!rows.length) return;
                var col = COMP_STYLE[name] || '#94a3b8';
                var many = rows.length > 60;
                /* f-deck comparators (ADT / Dvorak / SATCON) are appended on
                   the advisory cycle and can be many hours old, so a series
                   that merely ENDS early looks like a live disagreement.
                   Stamp the last update into the legend, and flag it when the
                   series is well behind the newest GHOST frame. */
                var lastT = rows[rows.length - 1].t;
                var ageH = (new Date(t[t.length - 1]) - new Date(lastT)) / 3.6e6;
                var short = window.innerWidth < 640;
                var lbl = short
                    ? name.replace(' (DVTS)', '') + ' ' + lastT.slice(11, 16) +
                      (ageH >= 2 ? '\u00b7' + ageH.toFixed(0) + 'h' : '')
                    : name + ' \u00b7 ' + lastT.slice(11, 16) + 'Z' +
                      (ageH >= 2 ? ' (' + ageH.toFixed(0) + ' h old)' : '');
                traces.push({
                    x: rows.map(function (r) { return r.t; }),
                    y: rows.map(function (r) { return r.vmax_kt; }),
                    name: lbl, yaxis: 'y', xaxis: 'x',
                    mode: many ? 'lines' : 'lines+markers',
                    line: { color: col, width: 1.4 },
                    marker: { size: 5, color: col },
                    opacity: 0.9,
                    hovertemplate: '%{y:.0f} kt'
                });
                var hasP = rows.some(function (r) {
                    return r.pmin_hpa !== undefined && r.pmin_hpa !== null; });
                if (hasP) traces.push({
                    x: rows.map(function (r) { return r.t; }),
                    y: rows.map(function (r) {
                        return (r.pmin_hpa === undefined) ? null : r.pmin_hpa; }),
                    name: lbl + ' Pmin', yaxis: 'y2', xaxis: 'x2',
                    mode: 'lines', line: { color: col, width: 1.4 },
                    opacity: 0.9, showlegend: false,
                    hovertemplate: '%{y:.0f} hPa'
                });
            });
        }
        /* Aircraft verification fixes: one diamond per recon center pass.
           Flight-level wind arrives already surface-adjusted by the producer
           (x0.90 at 700 mb / x0.80 at 850 mb, Franklin et al. 2003) so the
           Vmax marker is apples-to-apples with GHOST; hover keeps the raw
           flight-level and SFMR values. RMW passes through unadjusted —
           GHOST predicts the 2-km RMW, so the FL wind-max radius is the
           natural comparison. */
        if (j.recon && j.recon.length) {
            var ink = dark ? '#f1f5f9' : '#0f172a';
            var ring = dark ? '#0f172a' : '#ffffff';
            var rec = j.recon;
            var mk = { symbol: 'diamond', size: 9, color: ink,
                       line: { width: 1.5, color: ring } };
            traces.push({
                x: rec.map(function (r) { return r.t; }),
                y: rec.map(function (r) { return r.vmax_sfc_kt; }),
                name: 'Recon (sfc-adjusted)', yaxis: 'y', xaxis: 'x',
                mode: 'markers', marker: mk,
                text: rec.map(function (r) {
                    return r.vmax_sfc_kt + ' kt sfc — FL ' + r.fl_wind_kt +
                        ' kt' +
                        (r.fl_wind_t
                            ? ' (' + r.fl_wind_t.slice(11, 16) + 'Z)' : '') +
                        ' @ ' + r.fl_level_mb + ' mb ×' + r.sfc_factor +
                        (r.sfmr_kt != null ? ' · SFMR ' + r.sfmr_kt + ' kt' : '') +
                        (r.eye ? '<br>eye: ' + r.eye : '') +
                        '<br>' + (r.src === 'hdob'
                            ? 'derived from HDOBs (VDM not posted yet)'
                            : 'official Vortex Data Message fix');
                }),
                hovertemplate: '%{text}<extra>Recon</extra>'
            });
            traces.push({
                x: rec.map(function (r) { return r.t; }),
                y: rec.map(function (r) { return r.pmin_hpa; }),
                name: 'Recon', yaxis: 'y2', xaxis: 'x2', mode: 'markers',
                marker: mk, showlegend: false,
                hovertemplate: '%{y:.0f} hPa (extrapolated)<extra>Recon</extra>'
            });
            /* hasRmw, not just "the fix carries an RMW": on a profile with
               no size panel there is no y3/x3 for this to land on, and
               Plotly would CREATE one with a default full-height domain —
               drawing a phantom kilometre axis and a second x-axis straight
               across both real panels. */
            var rr = hasRmw
                ? rec.filter(function (r) { return r.rmw_km != null; }) : [];
            if (rr.length) traces.push({
                x: rr.map(function (r) { return r.t; }),
                y: rr.map(function (r) { return r.rmw_km; }),
                name: 'Recon', yaxis: 'y3', xaxis: 'x3', mode: 'markers',
                marker: mk, showlegend: false,
                hovertemplate: '%{y:.0f} km — range of the max ' +
                    'flight-level wind<extra>Recon</extra>'
            });
        }
        /* Instantaneous read: the per-frame estimate BEFORE the causal
           kernel (and, for GHOST, before Stage-B inertia) — it leads the
           published value during rapid change and is noisier in steady
           state. Off by default; click the legend entry to show. Drawn in
           the model's own color, dotted and translucent, because it is the
           SAME model without its memory — not a comparator product.

           Both panels, where the payload has both: on a pressure-first
           profile the wind panel is derived, so the pressure trace is the
           one that shows what the kernel is actually doing. */
        var instCol = hexToRgba(MODEL_COL, 0.75);
        [{ f: 'vmax_inst_kt', ax: 'y', xax: 'x', u: ' kt', dp: 0 },
         { f: 'pmin_inst_hpa', ax: 'y2', xax: 'x2', u: ' hPa', dp: 1 }
        ].forEach(function (s) {
            if (!fr.some(function (r) { return r[s.f] != null; })) return;
            traces.push({
                x: t, y: col(s.f),
                name: M.name + ' instantaneous', yaxis: s.ax, xaxis: s.xax,
                mode: 'lines', legendgroup: 'inst',
                showlegend: s.f === (M.headline === 'pmin_hpa'
                    ? 'pmin_inst_hpa' : 'vmax_inst_kt'),
                line: { width: 1.2, dash: 'dot', color: instCol },
                visible: 'legendonly',
                hovertemplate: '%{y:.' + s.dp + 'f}' + s.u + ' — single-frame '
                    + 'read, no smoothing<extra>' + M.name + ' inst</extra>'
            });
        });
        /* SAR surface-wind analyses (Ifremer CyclObs: RCM / Sentinel-1 /
           RADARSAT-2). Star per pass on the Vmax + RMW panels — the only
           direct surface-wind truth available in JTWC basins. CyclObs
           processing lags an acquisition by hours, so passes appear on
           later runs. */
        if (j.sar && j.sar.length) {
            var inkS = dark ? '#fbbf24' : '#b45309';
            var ringS = dark ? '#0f172a' : '#ffffff';
            var mkS = { symbol: 'star', size: 11, color: inkS,
                        line: { width: 1.2, color: ringS } };
            traces.push({
                x: j.sar.map(function (r) { return r.t; }),
                y: j.sar.map(function (r) { return r.sfc_kt; }),
                name: 'SAR surface wind', yaxis: 'y', xaxis: 'x',
                mode: 'markers', marker: mkS,
                text: j.sar.map(function (r) {
                    var q = r.quads_kt;
                    return r.sfc_kt + ' kt surface — ' + (r.mission || 'SAR') +
                        (r.src === 'star' ? ' (NOAA/STAR)' : ' (CyclObs)') +
                        (r.eye_in_acq ? ' · eye in swath' : '') +
                        (q ? '<br>quadrants: ' + ['NE', 'SE', 'SW', 'NW']
                            .filter(function (k) { return q[k] != null; })
                            .map(function (k) { return k + ' ' + q[k]; })
                            .join(' · ') + ' kt' : '') +
                        (r.rmw_km != null ? '<br>SAR RMW ' + r.rmw_km + ' km'
                                          : '') +
                        (r.sfc_kt >= 100 || r.rmw_km != null && r.rmw_km < 20
                            ? '<br><i>SAR can saturate below the true max ' +
                              'in extreme / small cores</i>' : '');
                }),
                hovertemplate: '%{text}<extra>SAR</extra>'
            });
            var sr = hasRmw
                ? j.sar.filter(function (r) { return r.rmw_km != null; }) : [];
            if (sr.length) traces.push({
                x: sr.map(function (r) { return r.t; }),
                y: sr.map(function (r) { return r.rmw_km; }),
                name: 'SAR', yaxis: 'y3', xaxis: 'x3', mode: 'markers',
                marker: mkS, showlegend: false,
                hovertemplate: '%{y:.0f} km — SAR-analyzed RMW' +
                    '<extra>SAR</extra>'
            });
        }
        /* Upcoming SAR acquisition (STAR schedule) — small note on the Vmax
           panel so users know when the next surface-wind truth arrives. */
        if (j.sar_next) {
            layout.annotations = (layout.annotations || []).concat([{
                xref: 'x domain', yref: 'y domain', x: 0.01, y: 0.02,
                xanchor: 'left', yanchor: 'bottom', showarrow: false,
                font: { size: 10, color: dark ? '#94a3b8' : '#64748b' },
                text: '☆ next SAR pass ' +
                    j.sar_next.replace('T', ' ').slice(5, 16) + 'Z' +
                    (j.sar_next.indexOf('(') > 0
                        ? ' ' + j.sar_next.slice(j.sar_next.indexOf('(')) : '')
            }]);
        }
        /* Backstop for the whole class of bug fixed above: a trace pointing
           at an axis this layout never declared makes Plotly invent it with
           a default full-figure domain, which silently draws a phantom axis
           across the real panels. Cheaper to drop the trace than to ship a
           chart nobody can read — and it is logged, so the cause is
           findable rather than merely invisible. */
        var axOK = function (a, pre) {
            return !a || a === pre || layout[pre + 'axis' + a.slice(1)] !== undefined;
        };
        var dropped = traces.filter(function (tr) {
            return !(axOK(tr.yaxis, 'y') && axOK(tr.xaxis, 'x'));
        });
        if (dropped.length) {
            traces = traces.filter(function (tr) {
                return dropped.indexOf(tr) < 0;
            });
            console.warn('[experimental] dropped ' + dropped.length +
                ' trace(s) bound to an axis this layout does not define: ' +
                dropped.map(function (d) {
                    return d.name + '@' + (d.yaxis || 'y');
                }).join(', '));
        }
        Plotly.react(el, traces, layout, {
            responsive: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['toImage', 'lasso2d', 'select2d']
        }).then(function () { applyRange(j); });
    }

    /* ---------------- entry ---------------- */

    function loadIndex() {
        _lastLoad = Date.now();
        Promise.all([
            fetchJson(PREFIX + '/index.json', true),
            /* archive is optional: absent until the first season storm
               completes, and its loss must never take the live page down */
            fetchJson(ARCH_PREFIX + '/index.json', true)
                .catch(function () { return null; })
        ]).then(function (res) {
            _index = res[0];
            _archIndex = res[1];
            /* A LIVE storm must never be served out of the season archive.
               The archive pass can misfile an active storm as completed (a
               quiet JTWC b-deck reads as dissipation) and its manifest entry
               is never pruned afterwards, so WP132026 sat in both indexes:
               live as Peilou through 08-10, archived as a 3-day-stale run
               under the name the b-deck carried that day ("Kujira"). Every
               downstream path keys off _archSet, so the live chip silently
               loaded the archived JSON + plan PNG under the old name.
               Drop the archive copy on any ATCF collision — live always
               wins, and the chips, the count and seriesPath() all follow. */
            var live = {};
            ((_index && _index.storms) || []).forEach(function (s) {
                live[s.atcf] = true;
            });
            if (_archIndex && _archIndex.storms) {
                _archIndex.storms = _archIndex.storms.filter(function (s) {
                    return !live[s.atcf];
                });
            }
            _archSet = {};
            ((_archIndex && _archIndex.storms) || []).forEach(function (s) {
                _archSet[s.atcf] = true;
            });
            renderShell();
        }).catch(function () {
            _root.innerHTML = '<div class="exp-inner"><div class="exp-empty">' +
                'Could not load ' + M.name + ' output right now — the publisher may be ' +
                'mid-publish. Try again shortly.</div></div>';
        });
    }

    /* Redraw the chart when the site theme toggles (data-theme attribute). */
    new MutationObserver(function () {
        if (_storm && _series[_storm] &&
            document.getElementById('exp-plot')) {
            drawSeries(_series[_storm]);
            if (_showTrack) drawTrack(_series[_storm]);
            if (_showDist) drawDist(_series[_storm]);
            if (_showShap) drawShap(_series[_storm]);
        }
    }).observe(document.documentElement,
               { attributes: true, attributeFilter: ['data-theme'] });

    /* The producer republishes hourly, but a tab left open would keep showing
       whatever it fetched on first activation (series are memoized in
       _series). Re-pull while the tab is actually being looked at, and again
       whenever it regains visibility after going stale. */
    var REFRESH_MS = 10 * 60 * 1000;
    var _lastLoad = 0;

    function refreshIfStale(force) {
        if (!_root || !PREFIX) return;
        if (document.hidden) return;
        if (!/^experimental/.test(
                document.documentElement.getAttribute('data-view') || ''))
            return;
        if (!force && Date.now() - _lastLoad < REFRESH_MS) return;
        _series = {};
        loadIndex();
    }
    setInterval(function () { refreshIfStale(false); }, 60 * 1000);
    document.addEventListener('visibilitychange', function () {
        refreshIfStale(false);
    });

    /* Switch the active model profile. Every piece of fetched state is keyed
       to the producer, so a switch must drop ALL of it — leaving _series or
       _archSet behind would paint one model's storms with the other's numbers
       (they share ATCF ids, so nothing would visibly fail). */
    function setProfile(key) {
        var p = PROFILES[key] || PROFILES.ghost;
        if (p === M) return false;
        M = p;
        MODEL_COL = M.color;
        PREFIX = M.prefix;
        ARCH_PREFIX = M.arch;
        _index = null; _archIndex = null; _archSet = {};
        _storm = null; _series = {}; _archOpen = null;
        _lastLoad = 0;
        return true;
    }

    window.activateExperimentalView = function (profileKey) {
        _root = document.getElementById('exp-main');
        if (!_root) return;
        var switched = setProfile(profileKey || 'ghost');
        track(M.key + '_view_open', { narrow: window.innerWidth < 640 });
        /* A profile switch reuses the same #exp-main node, so the previous
           model's DOM is still mounted — blank it before the fetch or the old
           storm chips stay clickable against the new prefix. */
        if (switched) _root.innerHTML = '';
        loadIndex();
    };
})();
