/* ══════════════════════════════════════════════════════════════
   TC-ATLAS theme system — light (default) + dark (opt-in).
   ══════════════════════════════════════════════════════════════
   - Persists choice to localStorage under "tc-atlas-theme".
   - Falls back to prefers-color-scheme on first visit.
   - Toggle button(s) with class .theme-toggle are auto-wired.
   - Dispatches a `theme:change` CustomEvent on <html> when the
     theme changes, so charts/maps can repaint accordingly.
   - Loaded synchronously in <head> so the chosen theme is applied
     BEFORE the body paints (no flash of wrong theme).
   ══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var STORAGE_KEY = 'tc-atlas-theme';
    var THEMES = ['light', 'dark'];

    function readStored() {
        try {
            var v = localStorage.getItem(STORAGE_KEY);
            return THEMES.indexOf(v) >= 0 ? v : null;
        } catch (e) { return null; }
    }
    function writeStored(t) {
        try { localStorage.setItem(STORAGE_KEY, t); } catch (e) {}
    }
    // Light mode is the brand default. We deliberately do NOT fall back
    // to prefers-color-scheme so the site presents consistently to first-
    // time visitors regardless of their OS theme preference. Users can
    // opt into dark via the topbar toggle, and we remember their choice.

    function applyTheme(theme) {
        if (THEMES.indexOf(theme) < 0) theme = 'light';
        var root = document.documentElement;
        if (theme === 'dark') root.setAttribute('data-theme', 'dark');
        else root.removeAttribute('data-theme');
        // Update toggle UI state — show the icon for the OPPOSITE mode
        // (the destination), since that's the "show what you'll get"
        // pattern used by GitHub, Notion, Apple, etc.
        var nextLabel = theme === 'dark' ? 'Switch to light mode'
                                         : 'Switch to dark mode';
        var toggles = document.querySelectorAll('.theme-toggle');
        for (var i = 0; i < toggles.length; i++) {
            toggles[i].setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
            toggles[i].setAttribute('aria-label', nextLabel);
            toggles[i].setAttribute('title', nextLabel);
            toggles[i].dataset.theme = theme;
        }
        // Notify listeners (charts, maps) — fire on next tick so the
        // CSS variable values are already resolved when handlers read them.
        setTimeout(function () {
            var ev;
            try {
                ev = new CustomEvent('theme:change', { detail: { theme: theme } });
            } catch (e) {
                ev = document.createEvent('CustomEvent');
                ev.initCustomEvent('theme:change', false, false, { theme: theme });
            }
            document.documentElement.dispatchEvent(ev);
        }, 0);
    }

    // Apply on first paint — no flash of wrong theme. Light by default.
    var initial = readStored() || 'light';
    applyTheme(initial);

    // Wire toggles after DOM ready. Also re-apply the current theme so
    // each toggle picks up its aria-label / title (applyTheme ran at
    // script-load time when no toggles existed yet).
    function wireToggles() {
        var toggles = document.querySelectorAll('.theme-toggle');
        var current = document.documentElement.getAttribute('data-theme') === 'dark'
            ? 'dark' : 'light';
        for (var i = 0; i < toggles.length; i++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    var c = document.documentElement.getAttribute('data-theme') === 'dark'
                        ? 'dark' : 'light';
                    var next = c === 'dark' ? 'light' : 'dark';
                    writeStored(next);
                    applyTheme(next);
                });
            })(toggles[i]);
        }
        // Re-apply so toggles get the destination-label
        applyTheme(current);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireToggles);
    } else {
        wireToggles();
    }

    // ── Plotly theme bridge ──────────────────────────────────────
    // Read CSS-var theme values that Plotly should use. JS code that
    // creates Plotly charts can call window.TCATheme.plotly() to get
    // a layout patch with the current theme's paper/plot/font/grid
    // colors. Charts also auto-relayout on `theme:change` if they're
    // tagged with class `js-theme-chart` and have a Plotly id (their
    // div element has __plotly_data__ attached).
    function readVar(name) {
        return getComputedStyle(document.documentElement)
            .getPropertyValue(name).trim();
    }
    function plotlyTheme() {
        return {
            paper_bgcolor: readVar('--plot-paper') || '#ffffff',
            plot_bgcolor:  readVar('--plot-bg')    || '#ffffff',
            font: {
                family: 'DM Sans, sans-serif',
                color: readVar('--plot-text') || '#0f1623'
            },
            xaxis: {
                gridcolor:  readVar('--plot-grid') || 'rgba(15,22,35,0.08)',
                linecolor:  readVar('--plot-grid') || 'rgba(15,22,35,0.08)',
                tickfont:   { color: readVar('--plot-axis') || '#5b6573' },
                titlefont:  { color: readVar('--plot-axis') || '#5b6573' }
            },
            yaxis: {
                gridcolor:  readVar('--plot-grid') || 'rgba(15,22,35,0.08)',
                linecolor:  readVar('--plot-grid') || 'rgba(15,22,35,0.08)',
                tickfont:   { color: readVar('--plot-axis') || '#5b6573' },
                titlefont:  { color: readVar('--plot-axis') || '#5b6573' }
            },
            hoverlabel: {
                bgcolor:    readVar('--plot-hover-bg')     || '#ffffff',
                bordercolor: readVar('--plot-hover-border') || 'rgba(15,22,35,0.15)',
                font: { color: readVar('--plot-text') || '#0f1623',
                        family: 'DM Sans', size: 12 }
            }
        };
    }

    // Auto-relayout any chart tagged js-theme-chart on theme change
    document.documentElement.addEventListener('theme:change', function () {
        if (typeof window.Plotly === 'undefined') return;
        var nodes = document.querySelectorAll('.js-theme-chart');
        var patch = plotlyTheme();
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            if (!n._fullLayout) continue;
            try { window.Plotly.relayout(n, patch); } catch (e) {}
        }
    });

    // ── Basemap variant bridge ──────────────────────────────────
    // CARTO has light_all / dark_all tile variants. JS code that adds
    // basemap tile layers can call window.TCATheme.basemapVariant()
    // to get "light" or "dark" and pick the right tile URL.
    function basemapVariant() {
        var v = (readVar('--basemap-variant') || '"light"').replace(/"/g, '');
        return (v === 'dark') ? 'dark' : 'light';
    }

    // ── Auto-register CARTO Leaflet tile layers ────────────────
    // Patch L.tileLayer once Leaflet is available so any tile layer
    // pointing at basemaps.cartocdn.com gets registered for theme
    // swapping. On theme:change we call .setUrl() with the matching
    // light_* or dark_* variant — Leaflet repaints the tiles in place.
    var _cartoLayers = [];
    function cartoSwapUrl(currentUrl, theme) {
        // Map the prefix segment after cartocdn.com/<here>/{z}/...
        // We swap the leading word ("light_" ↔ "dark_") and keep the
        // rest (all / nolabels / only_labels).
        return currentUrl.replace(
            /(basemaps\.cartocdn\.com\/)(light|dark)(_[a-z_]+\/)/,
            function (m, p1, p2, p3) {
                var want = (theme === 'dark') ? 'dark' : 'light';
                return p1 + want + p3;
            }
        );
    }
    function patchLeaflet() {
        if (typeof window.L === 'undefined' || !window.L.tileLayer) return false;
        if (window.L.__tcaPatched) return true;
        // Patch the FACTORY function L.tileLayer(url, opts). Page code
        // calls this directly, so it's the most reliable hook —
        // rewriting the URL here happens BEFORE the TileLayer is
        // constructed, so no tile fetch ever uses the wrong variant.
        var origFactory = window.L.tileLayer;
        var newFactory = function (url, opts) {
            if (typeof url === 'string'
                && url.indexOf('basemaps.cartocdn.com') >= 0) {
                var current = (document.documentElement.getAttribute('data-theme') === 'dark')
                    ? 'dark' : 'light';
                var swapped = cartoSwapUrl(url, current);
                var layer = origFactory(swapped, opts);
                if (_cartoLayers.indexOf(layer) < 0) _cartoLayers.push(layer);
                return layer;
            }
            return origFactory(url, opts);
        };
        // Preserve sub-factories like L.tileLayer.wms
        Object.keys(origFactory).forEach(function (k) { newFactory[k] = origFactory[k]; });
        window.L.tileLayer = newFactory;
        // Also patch the prototype.onAdd as a safety net for any code
        // that uses `new L.TileLayer(...)` directly instead of the factory.
        var origOnAdd = window.L.TileLayer.prototype.onAdd;
        window.L.TileLayer.prototype.onAdd = function (map) {
            if (this._url && typeof this._url === 'string'
                && this._url.indexOf('basemaps.cartocdn.com') >= 0) {
                if (_cartoLayers.indexOf(this) < 0) _cartoLayers.push(this);
                var current = (document.documentElement.getAttribute('data-theme') === 'dark')
                    ? 'dark' : 'light';
                var swapped = cartoSwapUrl(this._url, current);
                if (swapped !== this._url) this._url = swapped;
            }
            return origOnAdd.call(this, map);
        };
        window.L.TileLayer.prototype.__tcaPatched = true;
        return true;
    }
    // Race-sensitive: page code may call L.tileLayer immediately after
    // Leaflet loads. Use a tight 5ms poll to win the race, plus a
    // MutationObserver as belt-and-suspenders (catches Leaflet attached
    // via async script). After 2s we assume L either loaded or never will.
    var pollAttempts = 0;
    function pollPatch() {
        if (patchLeaflet()) return;
        if (++pollAttempts < 400) setTimeout(pollPatch, 5);
    }
    pollPatch();
    // Also patch on any DOM mutation in <head> — catches script injection
    try {
        var mo = new MutationObserver(function () {
            if (patchLeaflet()) mo.disconnect();
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        // Stop observing after 8 s no matter what to avoid leaks
        setTimeout(function () { mo.disconnect(); }, 8000);
    } catch (e) {}

    // After patch succeeds, also reconcile any tile layers that were
    // created BEFORE the patch (race lost). Walk all Leaflet maps via
    // their .leaflet-container DOM nodes and swap _url + redraw.
    function reconcileExistingLayers() {
        if (typeof window.L === 'undefined') return;
        var current = (document.documentElement.getAttribute('data-theme') === 'dark')
            ? 'dark' : 'light';
        var containers = document.querySelectorAll('.leaflet-container');
        containers.forEach(function (c) {
            // Leaflet stores the map as `_leaflet_id` keyed in L.Map._initContainerId
            // but the cleanest access is via the container's _leaflet_id and walking
            // L.Map instances. Easiest: use Leaflet's `L.DomUtil.get(id)._leaflet_id`
            // doesn't expose Map directly, so instead we walk all known event targets.
            // Simpler: use the fact that L.Map.prototype._initContainer stores `_leaflet_map`
            // on the container. (Leaflet 1.x sets `c._leaflet_id` plus an internal map ref.)
        });
        // Direct approach — many pages stash the map on window. Walk window
        // for any object that has _layers (Leaflet Map signature).
        for (var k in window) {
            try {
                var v = window[k];
                if (v && v._layers && typeof v.eachLayer === 'function') {
                    v.eachLayer(function (layer) {
                        if (layer && layer._url
                            && typeof layer._url === 'string'
                            && layer._url.indexOf('basemaps.cartocdn.com') >= 0) {
                            if (_cartoLayers.indexOf(layer) < 0) _cartoLayers.push(layer);
                            var swapped = cartoSwapUrl(layer._url, current);
                            if (swapped !== layer._url && layer.setUrl) {
                                layer.setUrl(swapped);
                            }
                        }
                    });
                }
            } catch (e) {}
        }
    }
    // Run reconciliation a few times to catch maps created at varying delays
    setTimeout(reconcileExistingLayers, 200);
    setTimeout(reconcileExistingLayers, 1000);
    setTimeout(reconcileExistingLayers, 3000);

    document.documentElement.addEventListener('theme:change', function (e) {
        var theme = (e && e.detail && e.detail.theme) || 'light';
        for (var i = 0; i < _cartoLayers.length; i++) {
            try {
                var layer = _cartoLayers[i];
                if (!layer || !layer._url) continue;
                var newUrl = cartoSwapUrl(layer._url, theme);
                if (newUrl !== layer._url) layer.setUrl(newUrl);
            } catch (err) {}
        }
    });

    // Public API
    window.TCATheme = {
        get: function () {
            return document.documentElement.getAttribute('data-theme') === 'dark'
                ? 'dark' : 'light';
        },
        set: function (t) {
            if (THEMES.indexOf(t) < 0) return;
            writeStored(t);
            applyTheme(t);
        },
        plotly: plotlyTheme,
        basemapVariant: basemapVariant,
        readVar: readVar
    };
})();
