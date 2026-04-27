// GC-ATLAS — 30-year climatology windows for trend-aware anomalies.
//
// Eight overlapping 30-year periods stepped every 5 years (WMO convention).
// Each event year in a composite picks ITS closest-center climatology
// rather than always referencing the active period (default 1991-2020).
// This removes the warming-trend bias when a composite spans many decades:
// a 1972 SST departure is now measured against 1961-1990, not 1991-2020.
//
// Tile-set names match the on-disk convention used by era5.js's
// tileBaseFor():  "1971-2000" → data/tiles_1971_2000/ (or the equivalent
// GCS prefix).

export const CLIMO_WINDOWS = [
    { id: '1961-1990', start: 1961, end: 1990, center: 1975.5 },
    { id: '1966-1995', start: 1966, end: 1995, center: 1980.5 },
    { id: '1971-2000', start: 1971, end: 2000, center: 1985.5 },
    { id: '1976-2005', start: 1976, end: 2005, center: 1990.5 },
    { id: '1981-2010', start: 1981, end: 2010, center: 1995.5 },
    { id: '1986-2015', start: 1986, end: 2015, center: 2000.5 },
    { id: '1991-2020', start: 1991, end: 2020, center: 2005.5 },
    { id: '1996-2025', start: 1996, end: 2025, center: 2010.5 },
];

/** Return the climatology window whose 30-year midpoint is closest to
 *  the given calendar year. Ties (year equidistant between two centers)
 *  go to the LATER window — slight bias toward warmer baselines, the
 *  more conservative direction for trend-mitigation in a warming climate. */
export function bestClimoFor(year) {
    let best = CLIMO_WINDOWS[0];
    let bestDist = Math.abs(year - best.center);
    for (let i = 1; i < CLIMO_WINDOWS.length; i++) {
        const w = CLIMO_WINDOWS[i];
        const d = Math.abs(year - w.center);
        if (d <= bestDist) {     // <= so ties pick the later window
            best = w;
            bestDist = d;
        }
    }
    return best;
}

/** Group event years by their best-match climatology window. Returns a
 *  Map keyed by window.id with values { window, years[] } so callers
 *  can fetch each unique climo tile once and weight by event count. */
export function groupEventsByClimo(years) {
    const groups = new Map();
    for (const y of years) {
        const w = bestClimoFor(y);
        if (!groups.has(w.id)) groups.set(w.id, { window: w, years: [] });
        groups.get(w.id).years.push(y);
    }
    return groups;
}
