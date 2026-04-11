/* ═══════════════════════════════════════════════════════════════
   Real-Time Monitor — realtime_ir.js
   Self-contained IIFE for the Real-Time Monitor page.
   Provides: global map with active TC markers, click-through
   to storm detail with IR animation + intensity timeline.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ── Config ──────────────────────────────────────────────────
    var API_BASE = 'https://tc-atlas-api-361010099051.us-east1.run.app';
    var POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
    var DEFAULT_LOOKBACK_HOURS = 6;
    var DEFAULT_RADIUS_DEG = 10.0;

    // ── IR Colormap LUTs (for client-side raw Tb rendering) ────
    var IR_COLORMAPS = {};
    var irSelectedColormap = 'enhanced';
    var _irRenderCanvas = null;

    // Raw Tb frame storage — parallel to animFrameLayers
    var rawTbFrames = [];  // array of {tb_data: Uint8Array, rows, cols, bounds}

    (function buildColormaps() {
        function buildLUT(stops) {
            var lut = new Uint8Array(256 * 4);
            lut[0] = 0; lut[1] = 0; lut[2] = 0; lut[3] = 0;
            for (var i = 1; i <= 255; i++) {
                var frac = 1.0 - (i - 1) / 254.0;
                var lo = stops[0], hi = stops[stops.length - 1];
                for (var s = 0; s < stops.length - 1; s++) {
                    if (frac >= stops[s].f && frac <= stops[s + 1].f) {
                        lo = stops[s]; hi = stops[s + 1];
                        break;
                    }
                }
                var t = (hi.f === lo.f) ? 0 : (frac - lo.f) / (hi.f - lo.f);
                t = Math.max(0, Math.min(1, t));
                var idx = i * 4;
                lut[idx]     = Math.round(lo.r + t * (hi.r - lo.r));
                lut[idx + 1] = Math.round(lo.g + t * (hi.g - lo.g));
                lut[idx + 2] = Math.round(lo.b + t * (hi.b - lo.b));
                lut[idx + 3] = 255;
            }
            return lut;
        }

        function buildLUTfromTb(tbStops) {
            var vmin = 160.0, vmax = 330.0;
            var fracStops = tbStops.map(function(s) {
                return {f: 1.0 - (s.tb - vmin) / (vmax - vmin), r: s.r, g: s.g, b: s.b};
            });
            fracStops.sort(function(a, b) { return a.f - b.f; });
            return buildLUT(fracStops);
        }

        // Enhanced IR — NOAA-style
        IR_COLORMAPS['enhanced'] = buildLUT([
            {f: 0.00, r:   8, g:   8, b:   8},
            {f: 0.15, r:  40, g:  40, b:  40},
            {f: 0.30, r:  90, g:  90, b:  90},
            {f: 0.40, r: 140, g: 140, b: 140},
            {f: 0.50, r: 200, g: 200, b: 200},
            {f: 0.55, r:   0, g: 180, b: 255},
            {f: 0.60, r:   0, g: 100, b: 255},
            {f: 0.65, r:   0, g: 255, b:   0},
            {f: 0.70, r: 255, g: 255, b:   0},
            {f: 0.75, r: 255, g: 180, b:   0},
            {f: 0.80, r: 255, g:  80, b:   0},
            {f: 0.85, r: 255, g:   0, b:   0},
            {f: 0.90, r: 180, g:   0, b: 180},
            {f: 0.95, r: 255, g: 180, b: 255},
            {f: 1.00, r: 255, g: 255, b: 255}
        ]);

        // Dvorak Enhanced
        IR_COLORMAPS['dvorak'] = buildLUTfromTb([
            {tb: 170, r: 255, g: 255, b: 255},
            {tb: 183, r: 255, g:   0, b: 255},
            {tb: 193, r: 255, g:   0, b:   0},
            {tb: 203, r: 255, g: 128, b:   0},
            {tb: 213, r: 255, g: 255, b:   0},
            {tb: 223, r:   0, g: 255, b:   0},
            {tb: 233, r:   0, g: 128, b: 255},
            {tb: 243, r:   0, g:   0, b: 255},
            {tb: 253, r: 128, g: 128, b: 128},
            {tb: 273, r: 180, g: 180, b: 180},
            {tb: 293, r:  60, g:  60, b:  60},
            {tb: 310, r:  10, g:  10, b:  10}
        ]);

        // BD Grayscale
        IR_COLORMAPS['grayscale'] = (function () {
            var vmin = 160.0, vmax = 330.0;
            var lut = new Uint8Array(256 * 4);
            lut[0] = 0; lut[1] = 0; lut[2] = 0; lut[3] = 0;
            for (var i = 1; i <= 255; i++) {
                var tb = vmin + (i - 1) * (vmax - vmin) / 254.0;
                var gray;
                if (tb < 193) gray = 85;
                else if (tb < 198) gray = 135;
                else if (tb < 204) gray = 255;
                else if (tb < 210) gray = 0;
                else if (tb < 220) gray = 160;
                else if (tb < 232) gray = 110;
                else if (tb < 243) gray = 60;
                else if (tb < 282) gray = Math.round(202 + (tb - 243) * (109 - 202) / (282 - 243));
                else if (tb <= 303) gray = Math.round(255 + (tb - 282) * (0 - 255) / (303 - 282));
                else gray = 0;
                gray = Math.max(0, Math.min(255, gray));
                var idx = i * 4;
                lut[idx] = gray; lut[idx + 1] = gray; lut[idx + 2] = gray; lut[idx + 3] = 255;
            }
            return lut;
        })();

        // Funktop
        IR_COLORMAPS['funktop'] = buildLUTfromTb([
            {tb: 309, r:   0, g:   0, b:   0},
            {tb: 308, r:  20, g:  20, b:  20},
            {tb: 255, r: 216, g: 216, b: 216},
            {tb: 254.9, r: 100, g: 100, b:   0},
            {tb: 235, r: 248, g: 248, b:   0},
            {tb: 234.9, r:   0, g:   0, b: 120},
            {tb: 215, r:   0, g: 252, b: 252},
            {tb: 214.9, r:  84, g:   0, b:   0},
            {tb: 203, r: 252, g:   0, b:   0},
            {tb: 202.9, r: 252, g:  80, b:  80},
            {tb: 195, r: 252, g: 140, b: 140},
            {tb: 194.9, r:   0, g: 252, b:   0},
            {tb: 182, r: 252, g: 252, b: 252},
            {tb: 181, r: 252, g: 252, b: 252}
        ]);

        // AVN
        IR_COLORMAPS['avn'] = buildLUTfromTb([
            {tb: 310, r:   0, g:   0, b:   0},
            {tb: 243, r: 255, g: 255, b: 255},
            {tb: 242.9, r:   0, g: 150, b: 255},
            {tb: 223, r:   0, g: 110, b: 150},
            {tb: 222.9, r: 160, g: 160, b:   0},
            {tb: 213, r: 250, g: 250, b:   0},
            {tb: 212.9, r: 250, g: 250, b:   0},
            {tb: 203, r: 200, g: 120, b:   0},
            {tb: 202.9, r: 250, g:   0, b:   0},
            {tb: 193, r: 200, g:   0, b:   0},
            {tb: 192, r:  88, g:  88, b:  88}
        ]);

        // NHC
        IR_COLORMAPS['nhc'] = buildLUTfromTb([
            {tb: 298, r:   0, g:   0, b:   0},
            {tb: 297, r:   0, g:   0, b:  24},
            {tb: 282, r:   0, g:   0, b: 252},
            {tb: 262, r:   0, g: 252, b:   0},
            {tb: 242, r: 252, g:   0, b:   0},
            {tb: 203, r: 252, g: 248, b: 248},
            {tb: 202.9, r: 216, g: 216, b: 216},
            {tb: 170, r: 252, g: 252, b: 252}
        ]);

        // RAMMB
        IR_COLORMAPS['rammb'] = buildLUTfromTb([
            {tb: 310, r: 181, g:  85, b:  85},
            {tb: 298, r:   0, g:   0, b:   0},
            {tb: 243, r: 254, g: 254, b: 254},
            {tb: 242.9, r: 168, g: 253, b: 253},
            {tb: 223, r:  84, g:  84, b:  84},
            {tb: 222.9, r:   0, g:   0, b: 103},
            {tb: 213, r:   0, g:   0, b: 254},
            {tb: 212.9, r:   0, g:  96, b:  13},
            {tb: 203, r:   0, g: 252, b:   0},
            {tb: 202.9, r:  77, g:  13, b:   0},
            {tb: 193, r: 251, g:   0, b:   0},
            {tb: 192.9, r: 252, g: 252, b:   0},
            {tb: 183, r:   0, g:   0, b:   0},
            {tb: 182.9, r: 255, g: 255, b: 255},
            {tb: 173, r:   4, g:   4, b:   4}
        ]);

        // IRB
        IR_COLORMAPS['irb'] = buildLUTfromTb([
            {tb: 303, r:  18, g:  18, b:  18},
            {tb: 283, r: 120, g: 120, b: 120},
            {tb: 278, r: 215, g: 217, b: 219},
            {tb: 273, r: 252, g: 252, b: 252},
            {tb: 263, r:  43, g:  57, b: 161},
            {tb: 253, r:  61, g: 173, b: 143},
            {tb: 238, r: 255, g: 249, b:  87},
            {tb: 233, r: 227, g: 192, b:  36},
            {tb: 218, r: 166, g:  35, b:  63},
            {tb: 213, r:  77, g:  13, b:   7},
            {tb: 203, r: 150, g:  73, b: 201},
            {tb: 193, r: 224, g: 224, b: 255},
            {tb: 173, r:   0, g:   0, b:   0}
        ]);

        // Claude — custom TC analysis enhancement
        IR_COLORMAPS['claude'] = buildLUTfromTb([
            {tb: 310, r:  12, g:  12, b:  22},
            {tb: 293, r:  70, g:  70, b:  82},
            {tb: 283, r: 120, g: 120, b: 132},
            {tb: 273, r: 180, g: 180, b: 192},
            {tb: 263, r: 216, g: 218, b: 228},
            {tb: 253, r: 140, g: 210, b: 220},
            {tb: 248, r:  68, g: 180, b: 196},
            {tb: 243, r:  32, g: 148, b: 166},
            {tb: 238, r:  40, g: 178, b: 116},
            {tb: 233, r:  96, g: 208, b:  68},
            {tb: 228, r: 192, g: 220, b:  40},
            {tb: 223, r: 238, g: 196, b:  48},
            {tb: 218, r: 228, g: 132, b:  48},
            {tb: 213, r: 214, g:  78, b:  56},
            {tb: 208, r: 180, g:  36, b:  68},
            {tb: 203, r: 196, g:  48, b: 156},
            {tb: 198, r: 228, g: 112, b: 204},
            {tb: 193, r: 248, g: 196, b: 240},
            {tb: 183, r: 255, g: 255, b: 255},
            {tb: 173, r: 240, g: 240, b: 255}
        ]);
    })();

    /** Decode base64 tb_data into Uint8Array */
    function decodeTbData(base64str) {
        var binary = atob(base64str);
        var arr = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
            arr[i] = binary.charCodeAt(i);
        }
        return arr;
    }

    /** Render raw Tb uint8 array to a data:image/png URI using canvas + colormap LUT. */
    function renderTbToDataURI(tbData, rows, cols, colormap) {
        if (!_irRenderCanvas) _irRenderCanvas = document.createElement('canvas');
        _irRenderCanvas.width = cols;
        _irRenderCanvas.height = rows;
        var ctx = _irRenderCanvas.getContext('2d');
        var imgData = ctx.createImageData(cols, rows);
        var pixels = imgData.data;
        var lut = IR_COLORMAPS[colormap] || IR_COLORMAPS['enhanced'];
        for (var i = 0; i < tbData.length; i++) {
            var val = tbData[i];
            var pi = i * 4;
            if (val === 0) {
                pixels[pi] = 0; pixels[pi + 1] = 0; pixels[pi + 2] = 0; pixels[pi + 3] = 0;
            } else {
                var li = val * 4;
                pixels[pi]     = lut[li];
                pixels[pi + 1] = lut[li + 1];
                pixels[pi + 2] = lut[li + 2];
                pixels[pi + 3] = lut[li + 3];
            }
        }
        ctx.putImageData(imgData, 0, 0);
        return _irRenderCanvas.toDataURL('image/png');
    }

    /**
     * L.GridLayer subclass that renders raw Tb data as canvas tiles.
     * Each tile is rendered at native zoom resolution, avoiding the
     * upscaling blur of a single L.imageOverlay on Retina displays.
     */
    var RawTbTileLayer = L.GridLayer.extend({
        initialize: function (tbData, rows, cols, bounds, colormap, options) {
            this._tbData = tbData;
            this._tbRows = rows;
            this._tbCols = cols;
            // bounds: [[south, west], [north, east]]
            this._dataBounds = bounds;
            this._colormap = colormap;
            this._lut = IR_COLORMAPS[colormap] || IR_COLORMAPS['enhanced'];
            L.GridLayer.prototype.initialize.call(this, options);
        },

        createTile: function (coords) {
            var tile = document.createElement('canvas');
            var tileSize = this.getTileSize();
            var tw = tileSize.x, th = tileSize.y;
            tile.width = tw;
            tile.height = th;

            var ctx = tile.getContext('2d');

            // Data geographic bounds
            var dataSouth = this._dataBounds[0][0], dataWest = this._dataBounds[0][1];
            var dataNorth = this._dataBounds[1][0], dataEast = this._dataBounds[1][1];
            var dataLatSpan = dataNorth - dataSouth;
            var dataLonSpan = dataEast - dataWest;

            var map = this._map;
            var nwPoint = coords.scaleBy(tileSize);
            var z = coords.z;

            // Pre-compute lat for each row and lon for each column
            // (avoids calling map.unproject for every pixel)
            var rowLats = new Float64Array(th);
            for (var py = 0; py < th; py++) {
                rowLats[py] = map.unproject(L.point(nwPoint.x, nwPoint.y + py), z).lat;
            }
            var colLons = new Float64Array(tw);
            for (var px = 0; px < tw; px++) {
                colLons[px] = map.unproject(L.point(nwPoint.x + px, nwPoint.y), z).lng;
            }

            // Quick bounds check: skip tile if entirely outside data bounds
            var tileNorth = rowLats[0], tileSouth = rowLats[th - 1];
            var tileWest = colLons[0], tileEast = colLons[tw - 1];
            if (tileSouth > dataNorth || tileNorth < dataSouth ||
                tileEast < dataWest || tileWest > dataEast) {
                return tile;  // empty tile
            }

            var imgData = ctx.createImageData(tw, th);
            var pixels = imgData.data;
            var lut = this._lut;
            var tbData = this._tbData;
            var tbRows = this._tbRows;
            var tbCols = this._tbCols;
            var hasData = false;

            // Pre-compute data column indices for each tile column
            var colIndices = new Int32Array(tw);
            for (var px = 0; px < tw; px++) {
                var colFrac = (colLons[px] - dataWest) / dataLonSpan;
                if (colFrac < 0 || colFrac >= 1) { colIndices[px] = -1; continue; }
                var dc = Math.floor(colFrac * tbCols);
                colIndices[px] = (dc >= 0 && dc < tbCols) ? dc : -1;
            }

            for (var py = 0; py < th; py++) {
                var lat = rowLats[py];
                var rowFrac = (dataNorth - lat) / dataLatSpan;
                if (rowFrac < 0 || rowFrac >= 1) continue;
                var dataRow = Math.floor(rowFrac * tbRows);
                if (dataRow < 0 || dataRow >= tbRows) continue;
                var rowOffset = dataRow * tbCols;

                for (var px = 0; px < tw; px++) {
                    var dc = colIndices[px];
                    if (dc < 0) continue;

                    var val = tbData[rowOffset + dc];
                    if (val === 0) continue;

                    var pi = (py * tw + px) * 4;
                    var li = val * 4;
                    pixels[pi]     = lut[li];
                    pixels[pi + 1] = lut[li + 1];
                    pixels[pi + 2] = lut[li + 2];
                    pixels[pi + 3] = lut[li + 3];
                    hasData = true;
                }
            }

            if (hasData) {
                ctx.putImageData(imgData, 0, 0);
            }
            return tile;
        },

        /** Update colormap and redraw all tiles */
        updateColormap: function (colormap) {
            this._colormap = colormap;
            this._lut = IR_COLORMAPS[colormap] || IR_COLORMAPS['enhanced'];
            this.redraw();
        },

        /** Compatibility shim: setUrl triggers a redraw (used by recolorRawFrames) */
        setUrl: function () {
            this.redraw();
        },

        /** setOpacity — L.GridLayer doesn't have this by default (L.TileLayer does).
         *  Needed for the animation system's show/hide frame toggling. */
        setOpacity: function (opacity) {
            this.options.opacity = opacity;
            var container = this.getContainer ? this.getContainer() : this._container;
            if (container) {
                container.style.opacity = opacity;
            }
            return this;
        },
    });

    /** Render the detail view Tb colorbar canvas from active colormap LUT */
    function renderDetailColorbar() {
        var canvas = document.getElementById('ir-tb-colorbar-canvas');
        if (!canvas) return;
        var lut = IR_COLORMAPS[irSelectedColormap] || IR_COLORMAPS['enhanced'];
        var ctx = canvas.getContext('2d');
        var w = canvas.width, h = canvas.height;
        for (var x = 0; x < w; x++) {
            // Left = warm (index 255 = 310K), right = cold (index 1 = 170K)
            var idx = Math.round(255 - x * 254 / (w - 1));
            if (idx < 1) idx = 1;
            var li = idx * 4;
            ctx.fillStyle = 'rgb(' + lut[li] + ',' + lut[li + 1] + ',' + lut[li + 2] + ')';
            ctx.fillRect(x, 0, 1, h);
        }
    }

    /** Re-render all raw Tb frames with a new colormap (no server round-trip) */
    function recolorRawFrames() {
        if (rawTbFrames.length === 0) return;

        // If animFrameLayers are still GIBS tiles (no updateColormap/setUrl),
        // switch to canvas tile layers via _applyRawTbToMap().
        if (animFrameLayers.length > 0 &&
            !animFrameLayers[0].setUrl && !animFrameLayers[0].updateColormap) {
            _applyRawTbToMap();
            return;
        }

        for (var i = 0; i < animFrameLayers.length; i++) {
            if (animFrameLayers[i] && animFrameLayers[i].updateColormap) {
                animFrameLayers[i].updateColormap(irSelectedColormap);
            }
        }
        renderDetailColorbar();
    }

    // ── Natural Earth coastline GeoJSON cache ──────────────────
    var _coastlineGeoJSON = null;
    var _coastlineLoading = false;
    var _coastlineQueue = [];

    function _loadCoastlineOverlay(targetMap) {
        function _addToMap(geojson, m) {
            L.geoJSON(geojson, {
                pane: 'coastlinePane',
                style: {
                    color: '#000000',
                    weight: 1.2,
                    opacity: 0.7,
                    fillColor: 'transparent',
                    fillOpacity: 0,
                    interactive: false
                }
            }).addTo(m);
        }
        if (_coastlineGeoJSON) { _addToMap(_coastlineGeoJSON, targetMap); return; }
        _coastlineQueue.push(targetMap);
        if (_coastlineLoading) return;
        _coastlineLoading = true;
        fetch('https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_coastline.geojson')
            .then(function (r) { return r.json(); })
            .then(function (geojson) {
                _coastlineGeoJSON = geojson;
                _coastlineQueue.forEach(function (m) { _addToMap(geojson, m); });
                _coastlineQueue = [];
            })
            .catch(function () { _coastlineQueue = []; })
            .finally(function () { _coastlineLoading = false; });
    }

    // NASA GIBS WMTS tile config for IR imagery
    var GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
    var GIBS_IR_LAYERS = {
        'GOES-East':  'GOES-East_ABI_Band13_Clean_Infrared',
        'GOES-West':  'GOES-West_ABI_Band13_Clean_Infrared',
        'Himawari':   'Himawari_AHI_Band13_Clean_Infrared'
    };
    var GIBS_TILEMATRIX = 'GoogleMapsCompatible_Level6';
    var GIBS_MAX_ZOOM = 6;  // GIBS geostationary IR imagery max zoom
    var GIBS_IR_INTERVAL_MIN = 10;  // GIBS tiles every 10 minutes

    // GIBS GeoColor (true-colour day, blended IR night) — higher zoom
    var GIBS_GEOCOLOR_LAYERS = {
        'GOES-East':  'GOES-East_ABI_GeoColor',
        'GOES-West':  'GOES-West_ABI_GeoColor',
        'Himawari':   null  // no native GIBS GeoColor; synthesized via day(vis)/night(IR) switching
    };
    // GIBS Red Visible (single-band daytime-only)
    var GIBS_VIS_LAYERS = {
        'GOES-East':  'GOES-East_ABI_Band2_Red_Visible_1km',
        'GOES-West':  'GOES-West_ABI_Band2_Red_Visible_1km',
        'Himawari':   'Himawari_AHI_Band3_Red_Visible_1km'
    };
    var GIBS_VIS_TILEMATRIX = 'GoogleMapsCompatible_Level7';
    var GIBS_VIS_MAX_ZOOM = 7;

    // Satellite coverage zones for seamless compositing.
    // Each satellite has a "core" range (full opacity) and a narrow cross-fade
    // at the boundary to the adjacent satellite.  Core zones are set so that
    // GOES-East and GOES-West meet cleanly near -110° with a tight 5° blend
    // (the old 25° blend created a visible 40° swath of blurry dual-source
    // compositing over the western US).  The Africa/Middle East gap (no
    // Meteosat in GIBS) is handled by the nearest-satellite fallback.
    var SAT_ZONES = [
        { name: 'GOES-East', sublon: -75.2,  coreWest: -110, coreEast:   15 },
        { name: 'GOES-West', sublon: -137.2, coreWest: -180, coreEast: -110 },
        { name: 'Himawari',  sublon:  140.7, coreWest:   60, coreEast:  180 }
    ];
    var BLEND_WIDTH_DEG = 5; // narrow cross-fade to avoid blurry dual-source artifacts

    // Sub-satellite longitudes for choosing best satellite per storm
    var SAT_SUBLONS = [
        { name: 'GOES-East', sublon: -75.2 },
        { name: 'GOES-West', sublon: -137.2 },
        { name: 'Himawari',  sublon: 140.7 }
    ];

    // Saffir-Simpson color palette (matches global_archive.js)
    var SS_COLORS = {
        TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24',
        C2: '#fb923c', C3: '#f87171', C4: '#ef4444', C5: '#dc2626'
    };

    // ── GA4 helper ──────────────────────────────────────────────
    function _ga(action, params) {
        if (typeof gtag === 'function') {
            try { gtag('event', action, params || {}); } catch (e) { /* silent */ }
        }
    }

    // ── State ───────────────────────────────────────────────────
    var map = null;
    var stormMarkers = [];     // L.marker references
    var stormData = [];        // latest active-storms response
    var pollTimer = null;
    var currentStormId = null; // ATCF ID of detail view

    // Basin activity sidebar
    var basinSidebarVisible = false;
    var seasonSummaryData = null;
    var seasonSummaryTimer = null;
    var SEASON_SUMMARY_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

    var BASIN_NAMES = {
        NA: 'North Atlantic', EP: 'East Pacific', WP: 'West Pacific',
        NI: 'North Indian', SI: 'South Indian', SP: 'South Pacific'
    };
    var BASIN_COLORS = {
        NA: '#2e7dff', EP: '#00d4ff', WP: '#f87171',
        NI: '#fbbf24', SI: '#34d399', SP: '#a78bfa'
    };
    var gibsIRLayers = [];     // GIBS IR tile layers on main map
    var trackLayers = [];      // past track polylines + dots on main map

    // Global map product state
    var globalProduct = 'eir';       // 'eir' or 'geocolor'
    var gibsVisLayers = [];          // GIBS GeoColor tile layers on main map
    var latestGIBSTime = null;       // cached latest GIBS time string (oldest satellite — used for animation)
    var latestGIBSTimes = {};         // per-satellite latest times, e.g. {'GOES-East': '...', 'Himawari': '...'}

    // Global map animation state
    var GLOBAL_ANIM_LOOKBACK_H = 4;  // 4-hour lookback for global animation
    var GLOBAL_ANIM_STEP_MIN = 30;   // 30-min steps
    var globalAnimFrameTimes = [];    // ISO time strings
    var globalAnimFrameLayers = [];   // parallel composite L.GridLayer (one per frame, opacity 0 until shown)
    var globalAnimIndex = 0;
    var globalAnimPlaying = false;
    var globalAnimTimer = null;       // rAF handle (global view)
    var globalAnimLastTick = 0;       // timestamp of last frame advance (global view)
    var globalAnimLoaded = 0;
    var globalAnimReady = false;
    var globalAnimLoading = false;    // true while frames are being pre-loaded
    var globalAnimSpeedIdx = 1;        // index into GLOBAL_ANIM_SPEEDS
    var GLOBAL_ANIM_SPEEDS = [
        { label: '0.5×', ms: 1200 },
        { label: '1×',   ms: 600 },
        { label: '1.5×', ms: 400 },
        { label: '2×',   ms: 300 }
    ];

    // Storm detail mini-map state
    var detailMap = null;
    var detailTrackLayers = [];
    var detailSatName = '';     // which satellite is used for this storm
    var detailStormLat = 0;    // storm latitude for solar position calc
    var detailStormLon = 0;    // storm longitude for solar position calc

    // Pre-loaded frame animation state
    var animFrameTimes = [];   // array of ISO time strings
    var animFrameLayers = [];  // parallel array of L.tileLayer (one per frame)
    var animIndex = 0;
    var animPlaying = false;
    var animTimer = null;       // rAF handle (detail view)
    var animLastTick = 0;       // timestamp of last frame advance (detail view)
    var animIntervalMs = 500;   // detail view frame interval (ms)
    var framesLoaded = 0;      // how many frames have finished loading tiles
    var framesReady = false;   // true once all frames loaded
    var validFrames = [];      // indices of frames that loaded actual tile data
    var frameHasError = [];    // parallel to animFrameLayers — true if frame had tile errors

    // ── Model Forecast Overlay State ──────────────────────────────
    var _rtModelData = null;           // Full a-deck response from API
    var _rtModelVisible = false;       // Overlay is active
    var _rtModelAutoSync = true;       // Auto-switch cycle based on IR frame time
    var _rtModelShowIntensity = true;  // Show intensity forecasts on chart
    var _rtModelActiveCycle = null;    // Currently displayed init time (YYYYMMDDHH)
    var _rtModelTrackLayers = [];      // Leaflet polylines on map
    var _rtModelMarkerLayers = [];     // Leaflet circle markers for forecast points
    var _rtModelLegendModels = [];     // Models visible in current cycle
    var _rtModelLastAtcf = null;       // Last ATCF ID loaded
    var _rtModelTypeFilters = { official: true, dynamical: true, ai: true, consensus: true, statistical: false };
    var _rtModelShowInterp = false;    // false = show all, true = interpolated/late-cycle only
    var _rtModelIntensityTraces = [];  // Plotly trace indices for intensity chart

    // ── DeepMind WeatherLab Ensemble State ────────────────────
    var _rtWeatherlabData = null;      // API response
    var _rtWeatherlabVisible = false;  // toggle state
    var _rtWeatherlabLayers = [];      // Leaflet polylines
    var _rtWeatherlabMarkers = [];     // Leaflet circle markers
    var _rtWeatherlabMeanTraces = [];  // Plotly trace indices
    var _rtWeatherlabMinCat = null;    // min category filter (null = show all)

    // ── DeepMind 1000-Member Ensemble Distribution State ──────
    var _rtDmEnsData = null;           // API response from /weatherlab-ensemble
    var _rtDmHistTauIdx = 0;           // current slider index for intensity histogram
    var _rtDmChangeTauIdx = 4;         // current slider index for change histogram
    var _rtDmChangeInt = 24;           // 12 or 24 hour change interval

    // ── ASCAT Wind Barb Overlay State ───────────────────────
    var _rtAscatPasses = null;         // API response: list of passes
    var _rtAscatVisible = false;       // overlay toggle state
    var _rtAscatLayers = [];           // L.marker references on map
    var _rtAscatLastAtcf = null;       // last storm we fetched passes for
    var _rtAscatActiveUrl = null;      // currently displayed pass data URL

    var RT_MODEL_COLORS = {
        'OFCL': '#ff4757', 'JTWC': '#ffa502',
        'AVNO': '#ff6b6b', 'AVNI': '#ff6b6b', 'GFSO': '#ff6b6b',
        'EMX':  '#4ecdc4', 'EMXI': '#4ecdc4', 'EEMN': '#45b7aa',
        'CMC':  '#ffe66d', 'CMCI': '#ffe66d',
        'UKM':  '#a29bfe', 'UKMI': '#a29bfe',
        'NVGM': '#6c5ce7', 'NGMI': '#6c5ce7',
        'HWRF': '#00b894', 'HWFI': '#00b894',
        'HMON': '#e17055', 'HMNI': '#e17055',
        'HAFS': '#00cec9', 'HAFA': '#00cec9', 'HAFB': '#81ecec',
        'HFSA': '#00cec9', 'HFAI': '#00cec9', 'HFSB': '#81ecec', 'HFBI': '#81ecec',
        'CTCX': '#fab1a0', 'COTC': '#fab1a0', 'COTI': '#fab1a0',
        'GFDN': '#e17055', 'GFNI': '#e17055',
        'AVNX': '#ff6b6b', 'NGX':  '#6c5ce7',
        'AEMN': '#ff8a80', 'NEMN': '#b388ff', 'CEMN': '#fff176',
        'CHIP': '#ce93d8',
        'GENI': '#00ff87', 'GEN2': '#00ff87',
        'GRPH': '#00e676', 'GRPI': '#00e676', 'GRP2': '#00e676',
        'APTS': '#76ff03', 'PTSI': '#76ff03',
        'AIFS': '#69f0ae', 'AIFI': '#69f0ae',
        'SHIP': '#ffeaa7', 'DSHP': '#fdcb6e', 'LGEM': '#e2b04a',
        'TVCN': '#ffffff', 'TVCA': '#ffffff', 'TVCE': '#f0f0f0', 'TVCX': '#e0e0e0',
        'IVCN': '#dfe6e9', 'ICON': '#c8d6e5', 'FSSE': '#74b9ff',
        'GUNA': '#b2bec3', 'CGUN': '#636e72'
    };

    // Cached DOM refs for animation hot path (populated on first use)
    var _elFrameTime = null;
    var _elSatLabel = null;
    var _elAnimCounter = null;
    var _elAnimSlider = null;
    var _elAnimPlay = null;
    function _cacheAnimEls() {
        if (!_elFrameTime) _elFrameTime = document.getElementById('ir-frame-time');
        if (!_elSatLabel) _elSatLabel = document.getElementById('ir-satellite-label');
        if (!_elAnimCounter) _elAnimCounter = document.getElementById('ir-anim-counter');
        if (!_elAnimSlider) _elAnimSlider = document.getElementById('ir-anim-slider');
        if (!_elAnimPlay) _elAnimPlay = document.getElementById('ir-anim-play');
    }

    // Product mode: 'eir' (Enhanced IR), 'geocolor', or 'vigor'
    var productMode = 'eir';

    // GeoColor overlay state
    var geocolorFrameLayers = [];   // parallel array of L.tileLayer for GeoColor frames
    var geocolorFrameTimes = [];    // ISO time strings for GeoColor frames
    var geocolorFramesLoaded = 0;
    var geocolorFramesReady = false;
    var geocolorValidFrames = [];
    var geocolorFrameHasError = [];

    // IR Vigor overlay state
    var vigorMode = false;          // true when vigor product is active
    var vigorLayer = null;          // L.GridLayer for client-side vigor tiles
    var vigorCache = {};            // keyed by atcf_id → computed vigor data
    var vigorFetching = false;      // true while vigor computation is running

    // ── GIBS Clean IR Colormap Reverse LUT ───────────────────
    // GIBS Band 13 "Clean Infrared" uses an enhanced colormap:
    //   warm (330K) → black/dark gray → mid gray → light gray (248K)
    //   → cyan → blue → green → yellow → orange → red → pink → white (163K)
    // The forward stops below were derived empirically from GIBS tile
    // pixel data and calibrated against known meteorological Tb ranges.
    // The reverse LUT maps any RGB → approximate Tb via nearest-colour.
    var GIBS_TB_MIN = 163.0;        // K — coldest (white)
    var GIBS_TB_MAX = 330.0;        // K — warmest (black)

    // Forward colormap stops: [Tb_kelvin, R, G, B]
    var GIBS_CMAP_STOPS = [
        [330,   0,   0,   0],     // black (warmest)
        [320,  18,  18,  18],
        [310,  40,  40,  40],
        [300,  68,  68,  68],     // dark gray (warm ocean surface)
        [290, 100, 100, 100],     // mid gray (typical SST)
        [280, 133, 133, 133],
        [270, 165, 165, 165],
        [260, 195, 195, 195],
        [250, 218, 218, 218],     // light gray
        [245,   0, 210, 240],     // light cyan (gray→colour transition)
        [240,   0, 180, 220],     // cyan
        [235,   0, 140, 200],     // cyan-blue
        [230,   0, 100, 175],     // blue
        [225,   0,  60, 150],     // dark blue
        [220,   0,  25, 125],     // very dark blue
        [215,   0, 100,  30],     // dark green (blue→green transition)
        [210,   0, 200,  40],     // green
        [205,  60, 240,   0],     // yellow-green
        [200, 180, 255,   0],     // yellow
        [195, 255, 220,   0],     // golden yellow
        [190, 255, 160,   0],     // orange
        [185, 255,  80,   0],     // red-orange
        [180, 255,   0,   0],     // red
        [175, 200,   0, 120],     // dark magenta
        [170, 255, 150, 255],     // pink
        [163, 255, 255, 255]      // white (coldest)
    ];

    // Build 512-entry forward table (Tb → RGB) by interpolating stops
    var GIBS_FWD_LUT_SIZE = 512;
    var GIBS_FWD_LUT = (function () {
        var n = GIBS_FWD_LUT_SIZE;
        var lut = new Uint8Array(n * 3); // [R,G,B, R,G,B, ...]
        var tbArr = new Float32Array(n);
        for (var i = 0; i < n; i++) {
            // Map index to Tb: 0 → GIBS_TB_MAX (warm), n-1 → GIBS_TB_MIN (cold)
            var tb = GIBS_TB_MAX - (i / (n - 1)) * (GIBS_TB_MAX - GIBS_TB_MIN);
            tbArr[i] = tb;
            // Find surrounding stops (stops are sorted warm→cold, descending Tb)
            var lo = GIBS_CMAP_STOPS[0], hi = GIBS_CMAP_STOPS[GIBS_CMAP_STOPS.length - 1];
            for (var s = 0; s < GIBS_CMAP_STOPS.length - 1; s++) {
                if (tb <= GIBS_CMAP_STOPS[s][0] && tb >= GIBS_CMAP_STOPS[s + 1][0]) {
                    lo = GIBS_CMAP_STOPS[s];
                    hi = GIBS_CMAP_STOPS[s + 1];
                    break;
                }
            }
            var t = (lo[0] === hi[0]) ? 0 : (lo[0] - tb) / (lo[0] - hi[0]);
            lut[i * 3]     = Math.round(lo[1] + t * (hi[1] - lo[1]));
            lut[i * 3 + 1] = Math.round(lo[2] + t * (hi[2] - lo[2]));
            lut[i * 3 + 2] = Math.round(lo[3] + t * (hi[3] - lo[3]));
        }
        return { rgb: lut, tb: tbArr };
    })();

    // Build 3D reverse lookup table (quantised RGB → forward LUT index → Tb)
    // Quantise to 32 levels per channel → 32³ = 32768 entries
    var GIBS_REV_Q = 32;
    var GIBS_REV_SHIFT = 3; // 256 / 32 = 8, log2(8) = 3
    var GIBS_REV_LUT = (function () {
        var q = GIBS_REV_Q;
        var table = new Uint16Array(q * q * q); // stores forward LUT index (0..511)
        var fwd = GIBS_FWD_LUT.rgb;
        var n = GIBS_FWD_LUT_SIZE;

        for (var ri = 0; ri < q; ri++) {
            var rc = ri * 8 + 4; // centre of quantisation bin
            for (var gi = 0; gi < q; gi++) {
                var gc = gi * 8 + 4;
                for (var bi = 0; bi < q; bi++) {
                    var bc = bi * 8 + 4;
                    var bestDist = Infinity, bestIdx = 0;
                    for (var j = 0; j < n; j++) {
                        var dr = rc - fwd[j * 3];
                        var dg = gc - fwd[j * 3 + 1];
                        var db = bc - fwd[j * 3 + 2];
                        var d = dr * dr + dg * dg + db * db;
                        if (d < bestDist) { bestDist = d; bestIdx = j; }
                    }
                    table[(ri * q + gi) * q + bi] = bestIdx;
                }
            }
        }
        return table;
    })();

    // Vigor rendering range (K)
    var VIGOR_VMIN = -10.0;         // strong deepening convection
    var VIGOR_VMAX =  80.0;         // clear sky well above local min

    // Vigor colormap stops (matches backend _VIGOR_STOPS)
    var VIGOR_STOPS = [
        [0.00,  10,  10,  30],
        [0.10,  20,  40, 120],
        [0.20,  40,  80, 180],
        [0.30,  80, 140, 220],
        [0.40, 160, 200, 240],
        [0.50, 230, 230, 230],
        [0.60, 255, 255, 150],
        [0.70, 255, 220,  50],
        [0.80, 255, 140,   0],
        [0.90, 230,  50,   0],
        [1.00, 200,   0, 150]
    ];

    // Pre-built 256-entry vigor RGBA LUT
    var VIGOR_LUT = (function () {
        var lut = new Uint8Array(256 * 4);
        for (var i = 0; i < 256; i++) {
            var frac = i / 255.0;
            var lo = VIGOR_STOPS[0], hi = VIGOR_STOPS[VIGOR_STOPS.length - 1];
            for (var s = 0; s < VIGOR_STOPS.length - 1; s++) {
                if (VIGOR_STOPS[s][0] <= frac && frac <= VIGOR_STOPS[s + 1][0]) {
                    lo = VIGOR_STOPS[s];
                    hi = VIGOR_STOPS[s + 1];
                    break;
                }
            }
            var t = (hi[0] === lo[0]) ? 0 : (frac - lo[0]) / (hi[0] - lo[0]);
            lut[i * 4]     = Math.round(lo[1] + t * (hi[1] - lo[1]));
            lut[i * 4 + 1] = Math.round(lo[2] + t * (hi[2] - lo[2]));
            lut[i * 4 + 2] = Math.round(lo[3] + t * (hi[3] - lo[3]));
            lut[i * 4 + 3] = 255;
        }
        return lut;
    })();

    // Spatial min filter radius in degrees (~200 km at equator)
    var VIGOR_RADIUS_DEG = 1.8;

    // Cold-cloud Tb threshold for vigor display (only show vigor where
    // current Tb < this value, i.e. convective cloud tops only)
    var VIGOR_TB_THRESHOLD = 253.15;  // -20°C in Kelvin

    // ── Helpers ─────────────────────────────────────────────────

    /** Classify wind speed (kt) to Saffir-Simpson category key */
    function windToCategory(vmax) {
        if (vmax == null) return 'TD';
        if (vmax < 34)  return 'TD';
        if (vmax < 64)  return 'TS';
        if (vmax < 83)  return 'C1';
        if (vmax < 96)  return 'C2';
        if (vmax < 113) return 'C3';
        if (vmax < 137) return 'C4';
        return 'C5';
    }

    /** Readable category label */
    function categoryLabel(cat) {
        var labels = {
            TD: 'Tropical Depression',
            TS: 'Tropical Storm',
            C1: 'Category 1', C2: 'Category 2', C3: 'Category 3',
            C4: 'Category 4', C5: 'Category 5'
        };
        return labels[cat] || cat;
    }

    /** Short category label for badges */
    function categoryShort(cat) {
        if (cat === 'TD') return 'TD';
        if (cat === 'TS') return 'TS';
        return 'Cat ' + cat.replace('C', '');
    }

    /** Format lat/lon for display */
    function fmtLatLon(lat, lon) {
        var ns = lat >= 0 ? 'N' : 'S';
        var ew = lon >= 0 ? 'E' : 'W';
        return Math.abs(lat).toFixed(1) + '\u00B0' + ns + ' ' +
               Math.abs(lon).toFixed(1) + '\u00B0' + ew;
    }

    /** Get the official forecast URL for a storm based on its source/basin */
    function getOfficialForecastUrl(storm) {
        var source = (storm.source || '').toUpperCase();
        var basin = (storm.basin || '').toUpperCase();
        var id = (storm.atcf_id || '').toUpperCase();

        if (source === 'NHC' || basin === 'ATL' || basin === 'EPAC' || basin === 'CPAC') {
            // NHC — link to the storm-specific advisory page
            // NHC URL pattern: https://www.nhc.noaa.gov/refresh/graphics_{basin_num}+shtml/...
            // Simpler: link to the main active storms page
            return 'https://www.nhc.noaa.gov/';
        } else if (source === 'JTWC' || basin === 'WPAC' || basin === 'IO' || basin === 'SHEM') {
            // JTWC — link to their tropical warnings page
            return 'https://www.metoc.navy.mil/jtwc/jtwc.html';
        }
        return null;
    }

    /** Format UTC timestamp for display */
    function fmtUTC(isoStr) {
        if (!isoStr) return '\u2014';
        try {
            var d = new Date(isoStr);
            var mo = String(d.getUTCMonth() + 1).padStart(2, '0');
            var day = String(d.getUTCDate()).padStart(2, '0');
            var hh = String(d.getUTCHours()).padStart(2, '0');
            var mm = String(d.getUTCMinutes()).padStart(2, '0');
            return mo + '/' + day + ' ' + hh + ':' + mm + ' UTC';
        } catch (e) { return isoStr; }
    }

    /** Pick the best satellite for a given longitude (angular distance to sub-satellite point) */
    function bestSatelliteForLon(lon) {
        var best = SAT_SUBLONS[0], bestDist = 999;
        for (var i = 0; i < SAT_SUBLONS.length; i++) {
            var d = Math.abs(lon - SAT_SUBLONS[i].sublon);
            if (d > 180) d = 360 - d;
            if (d < bestDist) { bestDist = d; best = SAT_SUBLONS[i]; }
        }
        return best.name;
    }

    // ═══════════════════════════════════════════════════════════
    //  GIBS TILE HELPERS
    // ═══════════════════════════════════════════════════════════

    /** Round a Date to the nearest GIBS interval (10 min) in the past */
    function roundToGIBSInterval(dt) {
        var d = new Date(dt.getTime());
        var m = d.getUTCMinutes();
        d.setUTCMinutes(m - (m % GIBS_IR_INTERVAL_MIN), 0, 0);
        return d;
    }

    /** Format a Date as GIBS subdaily time string: YYYY-MM-DDTHH:MI:SSZ */
    function toGIBSTime(dt) {
        return dt.getUTCFullYear() + '-' +
               String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' +
               String(dt.getUTCDate()).padStart(2, '0') + 'T' +
               String(dt.getUTCHours()).padStart(2, '0') + ':' +
               String(dt.getUTCMinutes()).padStart(2, '0') + ':00Z';
    }

    /** Approximate solar elevation angle (degrees) at a given lat/lon/time.
     *  Positive = sun above horizon, negative = below.
     *  Used to determine day/night for Himawari GeoColor compositing. */
    function solarElevation(lat, lon, date) {
        var d = new Date(date);
        var start = new Date(d.getUTCFullYear(), 0, 1);
        var dayOfYear = Math.floor((d - start) / 86400000) + 1;
        var declRad = (23.45 * Math.PI / 180) * Math.sin(2 * Math.PI * (284 + dayOfYear) / 365);
        var utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
        var haRad = ((utcHours - 12) * 15 + lon) * Math.PI / 180;
        var latRad = lat * Math.PI / 180;
        return Math.asin(
            Math.sin(latRad) * Math.sin(declRad) +
            Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad)
        ) * 180 / Math.PI;
    }

    /** Create a GIBS IR tile URL for a given layer + time (direct, no Leaflet template) */
    function gibsTileUrl(layerName, timeStr) {
        return GIBS_BASE + '/' + layerName + '/default/' + timeStr +
               '/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png';
    }

    /** Create a direct GIBS tile URL (no Leaflet placeholders) */
    function gibsTileUrlDirect(layerName, timeStr, z, y, x) {
        return GIBS_BASE + '/' + layerName + '/default/' + timeStr +
               '/GoogleMapsCompatible_Level6/' + z + '/' + y + '/' + x + '.png';
    }

    /** Create a direct GIBS tile URL with configurable TileMatrixSet */
    function gibsTileUrlWithMatrix(layerName, timeStr, z, y, x, tileMatrix) {
        return GIBS_BASE + '/' + layerName + '/default/' + timeStr +
               '/' + tileMatrix + '/' + z + '/' + y + '/' + x + '.png';
    }

    /** Create a Leaflet tile layer for a single GIBS IR product at a given time
     *  (used for storm-detail animation where only one satellite is needed).
     *  Uses a custom GridLayer with per-tile retry so that individual tiles
     *  that 404 at the requested time automatically fall back to 10/20/30 min
     *  earlier, eliminating gaps in the animation frames. */
    function createGIBSLayer(layerName, timeStr, opacity, bounds) {
        var RetryLayer = L.GridLayer.extend({
            options: {
                maxZoom: GIBS_MAX_ZOOM,
                maxNativeZoom: GIBS_MAX_ZOOM,
                tileSize: 256,
                opacity: opacity || 0.6,
                attribution: '<a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
                updateWhenZooming: false,
                keepBuffer: 3
            },

            _layerName: layerName,
            _timeStr: timeStr,

            createTile: function (coords, done) {
                var tile = document.createElement('canvas');
                var ctx = tile.getContext('2d');
                var size = this.getTileSize();
                tile.width = size.x;
                tile.height = size.y;

                loadImageWithRetry(this._layerName, this._timeStr, coords.z, coords.y, coords.x)
                    .then(function (result) {
                        if (result.img) {
                            ctx.drawImage(result.img, 0, 0, size.x, size.y);
                        }
                        done(null, tile);
                    });

                return tile;
            }
        });

        var layer = new RetryLayer();
        if (bounds) {
            layer.options.bounds = L.latLngBounds(bounds);
        }
        return layer;
    }

    /** Like satellitesForTile but returns GeoColor/visible layer names.
     *  For Himawari, falls back to Red Visible + includes IR fallback layer name
     *  so the compositor can draw IR as base for nighttime tiles. */
    function satellitesForTileVis(x, z) {
        var lonRange = tileLonRange(x, z);
        var centerLon = (lonRange.west + lonRange.east) / 2;

        var bestSat = null;
        var bestScore = -Infinity;

        for (var i = 0; i < SAT_ZONES.length; i++) {
            var sat = SAT_ZONES[i];
            var hasGeoColor = !!GIBS_GEOCOLOR_LAYERS[sat.name];
            var layerName = GIBS_GEOCOLOR_LAYERS[sat.name] || GIBS_VIS_LAYERS[sat.name];
            if (!layerName) continue;

            var score;
            if (centerLon >= sat.coreWest && centerLon <= sat.coreEast) {
                score = 1.0;
            } else {
                var distW = sat.coreWest - centerLon;
                var distE = centerLon - sat.coreEast;
                score = -Math.min(Math.abs(distW), Math.abs(distE));
            }

            if (score > bestScore) {
                bestScore = score;
                bestSat = {
                    name: sat.name,
                    layerName: layerName,
                    weight: 1.0,
                    irFallback: hasGeoColor ? null : (GIBS_IR_LAYERS[sat.name] || null)
                };
            }
        }

        if (!bestSat) {
            var best = SAT_SUBLONS[0], bestDist = 999;
            for (var j = 0; j < SAT_SUBLONS.length; j++) {
                var d = Math.abs(centerLon - SAT_SUBLONS[j].sublon);
                if (d > 180) d = 360 - d;
                if (d < bestDist) { bestDist = d; best = SAT_SUBLONS[j]; }
            }
            var hasGC = !!GIBS_GEOCOLOR_LAYERS[best.name];
            var ln = GIBS_GEOCOLOR_LAYERS[best.name] || GIBS_VIS_LAYERS[best.name];
            bestSat = {
                name: best.name,
                layerName: ln,
                weight: 1.0,
                irFallback: hasGC ? null : (GIBS_IR_LAYERS[best.name] || null)
            };
        }

        return [bestSat];
    }

    /** Per-pixel blend: overlay visible image onto IR base in a canvas context.
     *  Daytime pixels (visible brightness above threshold) use the visible image.
     *  Nighttime pixels (dark visible) convert the colored IR to grayscale,
     *  mimicking the look of real GeoColor imagery (grayscale IR at night).
     *  This correctly handles tiles that span the day/night terminator. */
    function blendVisibleOverIR(ctx, visImg, w, h) {
        var VIS_BRIGHT_THRESHOLD = 12; // nighttime pixels are 0-2, daytime ocean ~15+
        var tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = w;
        tmpCanvas.height = h;
        var tmpCtx = tmpCanvas.getContext('2d');
        tmpCtx.drawImage(visImg, 0, 0, w, h);
        var visData = tmpCtx.getImageData(0, 0, w, h);
        var irData = ctx.getImageData(0, 0, w, h);
        var vd = visData.data;
        var id = irData.data;
        for (var p = 0; p < vd.length; p += 4) {
            var brightness = (vd[p] + vd[p + 1] + vd[p + 2]) / 3;
            if (brightness > VIS_BRIGHT_THRESHOLD) {
                // Daytime: use visible imagery
                id[p]     = vd[p];
                id[p + 1] = vd[p + 1];
                id[p + 2] = vd[p + 2];
                id[p + 3] = 255;
            } else {
                // Nighttime: convert colored IR to grayscale
                var gray = Math.round(0.299 * id[p] + 0.587 * id[p + 1] + 0.114 * id[p + 2]);
                id[p]     = gray;
                id[p + 1] = gray;
                id[p + 2] = gray;
            }
        }
        ctx.putImageData(irData, 0, 0);
    }

    /** Create a seamless composite GeoColor/Visible layer for the global map.
     *  For GOES: uses GeoColor (handles day/night automatically).
     *  For Himawari: hybrid — draws IR as base, overlays Red Visible during daytime. */
    function createCompositeGIBSLayerVis(timeStr, opacity) {
        var CompositeVisLayer = L.GridLayer.extend({
            options: {
                tileSize: 256,
                maxZoom: GIBS_VIS_MAX_ZOOM,
                maxNativeZoom: GIBS_VIS_MAX_ZOOM,
                opacity: opacity || 0.65,
                attribution: '<a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
                updateWhenZooming: false,
                keepBuffer: 3
            },

            _timeStr: timeStr,

            createTile: function (coords, done) {
                var tile = document.createElement('canvas');
                var ctx = tile.getContext('2d');
                var size = this.getTileSize();
                tile.width = size.x;
                tile.height = size.y;

                var sats = satellitesForTileVis(coords.x, coords.z);
                var z = coords.z;
                var y = coords.y;
                var x = coords.x;
                var ts = this._timeStr;
                var sat = sats[0];

                if (sat.irFallback) {
                    // Hybrid mode: IR base + per-pixel visible overlay
                    // Visible pixels brighter than threshold replace IR;
                    // dark (nighttime) pixels keep the IR base underneath.
                    Promise.all([
                        loadImageWithRetry(sat.irFallback, ts, z, y, x),
                        loadImageWithRetryVis(sat.layerName, ts, z, y, x)
                    ]).then(function (results) {
                        var irResult = results[0];
                        var visResult = results[1];
                        if (irResult.img) {
                            ctx.drawImage(irResult.img, 0, 0, size.x, size.y);
                        }
                        if (visResult.img) {
                            blendVisibleOverIR(ctx, visResult.img, size.x, size.y);
                        }
                        done(null, tile);
                    }).catch(function () {
                        done(null, tile);
                    });
                } else {
                    // Standard GeoColor (handles day/night itself)
                    loadImageWithRetryVis(sat.layerName, ts, z, y, x).then(function (result) {
                        if (result.img) {
                            ctx.drawImage(result.img, 0, 0, size.x, size.y);
                        }
                        done(null, tile);
                    }).catch(function () {
                        done(null, tile);
                    });
                }

                return tile;
            }
        });

        return new CompositeVisLayer();
    }

    /** Create a Leaflet tile layer for GIBS GeoColor/Visible at a given time.
     *  Uses GoogleMapsCompatible_Level7 (higher zoom than IR).
     *  For GOES: uses GeoColor which handles day/night automatically.
     *  For Himawari: uses hybrid mode — Enhanced IR as base with Red Visible
     *  composited on top during daytime. At night the IR shines through. */
    function createGIBSLayerVis(layerName, timeStr, opacity, irFallbackLayer) {
        var VisRetryLayer = L.GridLayer.extend({
            options: {
                maxZoom: GIBS_VIS_MAX_ZOOM,
                maxNativeZoom: GIBS_VIS_MAX_ZOOM,
                tileSize: 256,
                opacity: opacity || 0.6,
                attribution: '<a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
                updateWhenZooming: false,
                keepBuffer: 3
            },

            _layerName: layerName,
            _timeStr: timeStr,
            _irFallback: irFallbackLayer || null,

            createTile: function (coords, done) {
                var tile = document.createElement('canvas');
                var ctx = tile.getContext('2d');
                var size = this.getTileSize();
                tile.width = size.x;
                tile.height = size.y;
                var irLayer = this._irFallback;
                var visLayer = this._layerName;
                var ts = this._timeStr;

                if (irLayer) {
                    // Hybrid mode: IR base + per-pixel visible overlay
                    Promise.all([
                        loadImageWithRetry(irLayer, ts, coords.z, coords.y, coords.x),
                        loadImageWithRetryVis(visLayer, ts, coords.z, coords.y, coords.x)
                    ]).then(function (results) {
                        var irResult = results[0];
                        var visResult = results[1];
                        if (irResult.img) {
                            ctx.drawImage(irResult.img, 0, 0, size.x, size.y);
                        }
                        if (visResult.img) {
                            blendVisibleOverIR(ctx, visResult.img, size.x, size.y);
                        }
                        done(null, tile);
                    }).catch(function () {
                        done(null, tile);
                    });
                } else {
                    // Standard mode (GeoColor handles day/night itself)
                    loadImageWithRetryVis(visLayer, ts, coords.z, coords.y, coords.x)
                        .then(function (result) {
                            if (result.img) {
                                ctx.drawImage(result.img, 0, 0, size.x, size.y);
                            }
                            done(null, tile);
                        });
                }

                return tile;
            }
        });

        return new VisRetryLayer();
    }

    /** Load a GIBS visible/GeoColor tile with time-fallback retry.
     *  Same strategy as IR but uses the visible TileMatrixSet. */
    function loadImageWithRetryVis(layerName, timeStr, z, y, x) {
        // Wider retry window for visible/GeoColor tiles — Himawari data on
        // GIBS can lag 1-2 hours behind GOES due to the JMA→LANCE→GIBS pipeline
        var attempts = [0, 10, 20, 30, 60, 90, 120];
        var baseDate = new Date(timeStr);

        function tryAttempt(idx) {
            if (idx >= attempts.length) return Promise.resolve({ img: null });
            var dt = new Date(baseDate.getTime() - attempts[idx] * 60 * 1000);
            var ts = toGIBSTime(roundToGIBSInterval(dt));
            var url = gibsTileUrlWithMatrix(layerName, ts, z, y, x, GIBS_VIS_TILEMATRIX);
            return loadImage(url).then(function (img) {
                if (img) return { img: img, timeUsed: ts };
                return tryAttempt(idx + 1);
            });
        }

        return tryAttempt(0);
    }

    // ── Seamless Composite GIBS Layer ─────────────────────────
    // Replaces 3 separate bounded tile layers with a single
    // L.GridLayer that alpha-blends satellite imagery at boundaries.

    /** Convert tile coords to the longitude of the tile center */
    function tileCenterLon(x, z) {
        var n = Math.pow(2, z);
        return (x + 0.5) / n * 360 - 180;
    }

    /** Convert tile coords to the longitude range of the tile */
    function tileLonRange(x, z) {
        var n = Math.pow(2, z);
        var west = x / n * 360 - 180;
        var east = (x + 1) / n * 360 - 180;
        return { west: west, east: east };
    }

    /** Determine the single best satellite for a given tile.
     *  Always returns exactly one satellite — no multi-source blending.
     *  Alpha-blending two geostationary views (different angles + scan times)
     *  produces visible dark/blurry bands, especially at low zoom where tiles
     *  span 20-45° of longitude.  A hard cutoff is cleaner because GOES-East
     *  and GOES-West use the same ABI instrument on overlapping footprints. */
    function satellitesForTile(x, z) {
        var lonRange = tileLonRange(x, z);
        var centerLon = (lonRange.west + lonRange.east) / 2;

        // Score each satellite by how close the tile center is to the core zone
        var bestSat = null;
        var bestScore = -Infinity;

        for (var i = 0; i < SAT_ZONES.length; i++) {
            var sat = SAT_ZONES[i];
            var layerName = GIBS_IR_LAYERS[sat.name];
            if (!layerName) continue;

            // Score = 1.0 if inside core, ramps down with distance outside core
            var score;
            if (centerLon >= sat.coreWest && centerLon <= sat.coreEast) {
                // Inside core — score based on distance to nearest edge (prefer center)
                score = 1.0;
            } else {
                // Outside core — negative distance (further = worse)
                var distW = sat.coreWest - centerLon;
                var distE = centerLon - sat.coreEast;
                score = -Math.min(Math.abs(distW), Math.abs(distE));
            }

            if (score > bestScore) {
                bestScore = score;
                bestSat = { name: sat.name, layerName: layerName, weight: 1.0 };
            }
        }

        // Fallback to nearest sub-satellite point if nothing scored well
        if (!bestSat) {
            var best = SAT_SUBLONS[0], bestDist = 999;
            for (var j = 0; j < SAT_SUBLONS.length; j++) {
                var d = Math.abs(centerLon - SAT_SUBLONS[j].sublon);
                if (d > 180) d = 360 - d;
                if (d < bestDist) { bestDist = d; best = SAT_SUBLONS[j]; }
            }
            bestSat = { name: best.name, layerName: GIBS_IR_LAYERS[best.name], weight: 1.0 };
        }

        return [bestSat];
    }

    /** Load an image as a promise */
    function loadImage(url) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () { resolve(img); };
            img.onerror = function () { resolve(null); }; // resolve null on error (tile may not exist)
            img.src = url;
        });
    }

    /** Load an image with retry at progressively older GIBS times.
     *  Tries the primary time, then falls back 10/20/30 min earlier.
     *  Returns {img, timeUsed} or {img: null} if all attempts fail. */
    function loadImageWithRetry(layerName, timeStr, z, y, x) {
        var attempts = [0, 10, 20, 30]; // minute offsets to try
        var baseDate = new Date(timeStr);

        function tryAttempt(idx) {
            if (idx >= attempts.length) return Promise.resolve({ img: null });
            var dt = new Date(baseDate.getTime() - attempts[idx] * 60 * 1000);
            var ts = toGIBSTime(roundToGIBSInterval(dt));
            var url = gibsTileUrlDirect(layerName, ts, z, y, x);
            return loadImage(url).then(function (img) {
                if (img) return { img: img, timeUsed: ts };
                return tryAttempt(idx + 1);
            });
        }

        return tryAttempt(0);
    }

    /** Create the seamless composite GIBS GridLayer */
    function createCompositeGIBSLayer(timeStr, opacity, perSatTimes) {
        // perSatTimes is optional: {'GOES-East': ts, 'GOES-West': ts, 'Himawari': ts}
        // When provided, each tile uses the freshest time for its assigned satellite.
        // When absent (e.g. animation frames), all tiles share timeStr.
        var satTimes = perSatTimes || null;

        var CompositeLayer = L.GridLayer.extend({
            options: {
                tileSize: 256,
                maxZoom: GIBS_MAX_ZOOM,
                maxNativeZoom: GIBS_MAX_ZOOM,
                opacity: opacity || 0.65,
                attribution: '<a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
                updateWhenZooming: false,
                keepBuffer: 3
            },

            _timeStr: timeStr,
            _satTimes: satTimes,

            createTile: function (coords, done) {
                var tile = document.createElement('canvas');
                var ctx = tile.getContext('2d');
                var size = this.getTileSize();
                tile.width = size.x;
                tile.height = size.y;

                var sats = satellitesForTile(coords.x, coords.z);
                var z = coords.z;
                var y = coords.y;
                var x = coords.x;
                var layerSatTimes = this._satTimes;
                var fallbackTs = this._timeStr;

                if (sats.length === 1) {
                    // Single satellite — use per-satellite time if available
                    var ts = (layerSatTimes && layerSatTimes[sats[0].name]) || fallbackTs;
                    loadImageWithRetry(sats[0].layerName, ts, z, y, x).then(function (result) {
                        if (result.img) {
                            ctx.drawImage(result.img, 0, 0, size.x, size.y);
                        }
                        done(null, tile);
                    });
                } else {
                    // Multiple satellites — composite with alpha blending + retry
                    var promises = [];
                    for (var i = 0; i < sats.length; i++) {
                        var ts = (layerSatTimes && layerSatTimes[sats[i].name]) || fallbackTs;
                        promises.push(loadImageWithRetry(sats[i].layerName, ts, z, y, x));
                    }
                    Promise.all(promises).then(function (results) {
                        for (var j = 0; j < results.length; j++) {
                            if (!results[j].img) continue;
                            ctx.globalAlpha = sats[j].weight;
                            ctx.drawImage(results[j].img, 0, 0, size.x, size.y);
                        }
                        ctx.globalAlpha = 1.0;
                        done(null, tile);
                    });
                }

                return tile;
            }
        });

        return new CompositeLayer();
    }

    /** Probe GIBS for the latest available time for EACH satellite independently.
     *  GOES data typically arrives within 15-20 min; Himawari can lag 60-120 min
     *  due to the JMA → LANCE → GIBS pipeline.  By finding per-satellite times we
     *  avoid penalising GOES freshness for Himawari's slower pipeline.
     *
     *  Returns a promise that resolves with:
     *    { perSat: {'GOES-East': ts, 'GOES-West': ts, 'Himawari': ts},
     *      oldest: ts }    // oldest across all sats (safe for animation)
     */
    function findLatestGIBSTimes() {
        var offsets = [15, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
        // Representative tiles for each satellite (z3 tiles within each footprint)
        var satellites = [
            { name: 'GOES-East', layer: GIBS_IR_LAYERS['GOES-East'], suffix: '/GoogleMapsCompatible_Level6/3/3/2.png' },
            { name: 'GOES-West', layer: GIBS_IR_LAYERS['GOES-West'], suffix: '/GoogleMapsCompatible_Level6/3/3/0.png' },
            { name: 'Himawari',  layer: GIBS_IR_LAYERS['Himawari'],  suffix: '/GoogleMapsCompatible_Level6/3/3/6.png' }
        ];

        var PROBE_BATCH = 4;  // probe 4 offsets in parallel per batch

        function findTimeForSat(sat) {
            function tryBatch(startIdx) {
                if (startIdx >= offsets.length) {
                    // All failed — fall back to 90 min ago
                    var fb = roundToGIBSInterval(new Date());
                    fb = new Date(fb.getTime() - 90 * 60 * 1000);
                    return Promise.resolve(toGIBSTime(fb));
                }
                var batch = offsets.slice(startIdx, startIdx + PROBE_BATCH);
                var probes = batch.map(function (offset) {
                    var dt = roundToGIBSInterval(new Date());
                    dt = new Date(dt.getTime() - offset * 60 * 1000);
                    var ts = toGIBSTime(dt);
                    var url = GIBS_BASE + '/' + sat.layer + '/default/' + ts + sat.suffix;
                    return fetch(url, { cache: 'no-store' }).then(function (r) {
                        return r.ok ? { offset: offset, ts: ts } : null;
                    }).catch(function () {
                        return null;
                    });
                });
                return Promise.all(probes).then(function (results) {
                    // Pick the freshest (smallest offset) successful probe
                    var best = null;
                    for (var i = 0; i < results.length; i++) {
                        if (results[i] && (!best || results[i].offset < best.offset)) {
                            best = results[i];
                        }
                    }
                    if (best) return best.ts;
                    // None in this batch succeeded — try next batch
                    return tryBatch(startIdx + PROBE_BATCH);
                });
            }
            return tryBatch(0);
        }

        return Promise.all(satellites.map(function (sat) {
            return findTimeForSat(sat).then(function (ts) {
                return { name: sat.name, time: ts };
            });
        })).then(function (results) {
            var perSat = {};
            var oldestMs = Infinity;
            for (var i = 0; i < results.length; i++) {
                perSat[results[i].name] = results[i].time;
                var ms = new Date(results[i].time).getTime();
                if (ms < oldestMs) oldestMs = ms;
            }
            var oldest = toGIBSTime(new Date(oldestMs));
            return { perSat: perSat, oldest: oldest };
        });
    }

    /** Legacy wrapper — returns the oldest satellite time (for animation compatibility) */
    function findLatestGIBSTime() {
        return findLatestGIBSTimes().then(function (result) {
            latestGIBSTimes = result.perSat;
            return result.oldest;
        });
    }

    /** Add the seamless composite GIBS IR layer to the map.
     *  Uses per-satellite times so GOES tiles show the freshest data (~15-20 min)
     *  while Himawari tiles use their own latest (may be 60-120 min behind). */
    function addGIBSOverlay(targetMap, opacity) {
        findLatestGIBSTimes().then(function (result) {
            latestGIBSTimes = result.perSat;
            latestGIBSTime = result.oldest;  // animation fallback
            var lyr = createCompositeGIBSLayer(result.oldest, opacity || 0.65, result.perSat);
            lyr.addTo(targetMap);
            gibsIRLayers = [lyr];
            console.log('GIBS per-satellite times:', JSON.stringify(result.perSat),
                        '| oldest (animation):', result.oldest);
        });
        return []; // layers added asynchronously — gibsIRLayers updated in callback
    }

    /** Remove GIBS layers from a map */
    function removeGIBSOverlay(targetMap, layers) {
        for (var i = 0; i < layers.length; i++) {
            targetMap.removeLayer(layers[i]);
        }
    }

    /** Swap composite GIBS layer to a new time string */
    function swapGIBSTime(targetMap, layers, timeStr, opacity) {
        for (var i = 0; i < layers.length; i++) {
            targetMap.removeLayer(layers[i]);
        }
        var lyr = createCompositeGIBSLayer(timeStr, opacity || 0.7);
        lyr.addTo(targetMap);
        return [lyr];
    }

    /** Toggle the global map between IR and GeoColor */
    function setGlobalProduct(mode) {
        if (mode === globalProduct) return;
        globalProduct = mode;

        // Update toggle button
        var toggleBtn = document.getElementById('ir-global-product-toggle');
        if (toggleBtn) {
            toggleBtn.textContent = (mode === 'geocolor') ? 'Switch to IR' : 'Switch to GeoColor';
            toggleBtn.title = (mode === 'geocolor')
                ? 'Currently showing GeoColor — click to switch to Enhanced IR'
                : 'Currently showing Enhanced IR — click to switch to GeoColor';
        }

        // Show/hide IR colorbar
        var colorbar = document.getElementById('ir-global-colorbar');
        if (colorbar) colorbar.style.display = (mode === 'geocolor') ? 'none' : '';

        // If global animation is loaded, it needs to be rebuilt for the new product
        var hadAnim = globalAnimReady;
        if (globalAnimFrameLayers.length > 0) {
            cleanupGlobalAnimation();
        }

        var timeStr = latestGIBSTime;
        if (!timeStr) return; // GIBS time not resolved yet

        if (mode === 'geocolor') {
            removeGIBSOverlay(map, gibsIRLayers);
            gibsIRLayers = [];
            var visLyr = createCompositeGIBSLayerVis(timeStr, 0.75);
            visLyr.addTo(map);
            gibsVisLayers = [visLyr];
        } else {
            removeGIBSOverlay(map, gibsVisLayers);
            gibsVisLayers = [];
            // Use per-satellite times for static IR layer (fresher GOES tiles)
            var perSat = (Object.keys(latestGIBSTimes).length > 0) ? latestGIBSTimes : null;
            var irLyr = createCompositeGIBSLayer(timeStr, 0.65, perSat);
            irLyr.addTo(map);
            gibsIRLayers = [irLyr];
        }

        // Re-load animation if it was active
        if (hadAnim) {
            loadGlobalAnimation();
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  GLOBAL MAP ANIMATION
    // ═══════════════════════════════════════════════════════════

    /** Create a composite layer for a given time based on the current global product. */
    function createGlobalAnimFrame(timeStr) {
        if (globalProduct === 'geocolor') {
            return createCompositeGIBSLayerVis(timeStr, 0);
        }
        return createCompositeGIBSLayer(timeStr, 0);
    }

    /** Load all global animation frames. Called when user clicks the play button. */
    function loadGlobalAnimation() {
        if (!map || !latestGIBSTime || globalAnimLoading) return;

        // If already loaded, just show the latest frame
        if (globalAnimReady && globalAnimFrameLayers.length > 0) {
            showGlobalAnimFrame(globalAnimFrameLayers.length - 1);
            return;
        }

        globalAnimLoading = true;
        globalAnimLoaded = 0;
        globalAnimReady = false;

        // Build frame times from latestGIBSTime
        var latest = new Date(latestGIBSTime);
        globalAnimFrameTimes = [];
        var step = GLOBAL_ANIM_STEP_MIN * 60 * 1000;
        var numFrames = Math.floor(GLOBAL_ANIM_LOOKBACK_H * 60 / GLOBAL_ANIM_STEP_MIN) + 1;
        for (var i = numFrames - 1; i >= 0; i--) {
            var dt = new Date(latest.getTime() - i * step);
            globalAnimFrameTimes.push(toGIBSTime(roundToGIBSInterval(dt)));
        }

        console.log('[Global Anim] Loading', globalAnimFrameTimes.length, 'frames for', globalProduct);

        // Update controls to show loading state
        updateGlobalAnimControls('loading', 0);

        // Remove static single-frame layer — animation frames will replace it
        if (globalProduct === 'geocolor') {
            removeGIBSOverlay(map, gibsVisLayers);
            gibsVisLayers = [];
        } else {
            removeGIBSOverlay(map, gibsIRLayers);
            gibsIRLayers = [];
        }

        // Pre-create all frame layers at opacity 0
        globalAnimFrameLayers = [];
        for (var f = 0; f < globalAnimFrameTimes.length; f++) {
            var lyr = createGlobalAnimFrame(globalAnimFrameTimes[f]);
            lyr.addTo(map);
            globalAnimFrameLayers.push(lyr);

            (function (layer, idx, total) {
                layer.on('load', function () {
                    globalAnimLoaded++;
                    var pct = Math.round((globalAnimLoaded / total) * 100);
                    updateGlobalAnimControls('loading', pct);

                    if (globalAnimLoaded >= total) {
                        globalAnimReady = true;
                        globalAnimLoading = false;
                        globalAnimIndex = total - 1;
                        showGlobalAnimFrame(globalAnimIndex);
                        updateGlobalAnimControls('ready');
                        console.log('[Global Anim] All', total, 'frames loaded');
                    }
                });
            })(lyr, f, globalAnimFrameTimes.length);
        }

        // Safety timeout: force-enable after 45s
        setTimeout(function () {
            if (globalAnimLoading && !globalAnimReady) {
                console.warn('[Global Anim] Timeout — enabling with', globalAnimLoaded, '/', globalAnimFrameTimes.length);
                globalAnimReady = true;
                globalAnimLoading = false;
                globalAnimIndex = globalAnimFrameTimes.length - 1;
                showGlobalAnimFrame(globalAnimIndex);
                updateGlobalAnimControls('ready');
            }
        }, 45000);
    }

    /** Show a specific global animation frame */
    function showGlobalAnimFrame(idx) {
        if (idx < 0 || idx >= globalAnimFrameLayers.length) return;

        // Hide all frames
        for (var i = 0; i < globalAnimFrameLayers.length; i++) {
            globalAnimFrameLayers[i].setOpacity(0);
        }

        // Show requested frame
        globalAnimIndex = idx;
        globalAnimFrameLayers[idx].setOpacity(globalProduct === 'geocolor' ? 0.75 : 0.65);

        // Update time display
        var timeEl = document.getElementById('ir-global-anim-time');
        if (timeEl && globalAnimFrameTimes[idx]) {
            timeEl.textContent = fmtUTC(globalAnimFrameTimes[idx]);
        }

    }

    /** Step to next global animation frame */
    function nextGlobalFrame() {
        if (!globalAnimReady || globalAnimFrameLayers.length === 0) return;
        var next = (globalAnimIndex + 1) % globalAnimFrameLayers.length;
        showGlobalAnimFrame(next);
    }

    /** Step to previous global animation frame */
    function prevGlobalFrame() {
        if (!globalAnimReady || globalAnimFrameLayers.length === 0) return;
        var prev = (globalAnimIndex - 1 + globalAnimFrameLayers.length) % globalAnimFrameLayers.length;
        showGlobalAnimFrame(prev);
    }

    /** rAF tick for global animation */
    function _globalAnimTick(ts) {
        if (!globalAnimPlaying) return;
        var ms = GLOBAL_ANIM_SPEEDS[globalAnimSpeedIdx].ms;
        if (ts - globalAnimLastTick >= ms) {
            globalAnimLastTick = ts;
            nextGlobalFrame();
        }
        globalAnimTimer = requestAnimationFrame(_globalAnimTick);
    }

    /** Start global animation loop */
    function startGlobalAnimation() {
        if (!globalAnimReady) {
            // Start loading if not yet loaded
            loadGlobalAnimation();
            return;
        }
        globalAnimPlaying = true;
        updateGlobalAnimControls('playing');
        globalAnimLastTick = 0;
        globalAnimTimer = requestAnimationFrame(_globalAnimTick);
    }

    /** Cycle to the next animation speed and restart if playing */
    function cycleGlobalAnimSpeed() {
        globalAnimSpeedIdx = (globalAnimSpeedIdx + 1) % GLOBAL_ANIM_SPEEDS.length;
        var speedBtn = document.getElementById('ir-global-anim-speed');
        if (speedBtn) speedBtn.textContent = GLOBAL_ANIM_SPEEDS[globalAnimSpeedIdx].label;
        // Speed change takes effect automatically on next rAF tick (no restart needed)
    }

    /** Stop global animation loop */
    function stopGlobalAnimation() {
        globalAnimPlaying = false;
        if (globalAnimTimer) cancelAnimationFrame(globalAnimTimer);
        globalAnimTimer = null;
        if (globalAnimReady) {
            updateGlobalAnimControls('ready');
        }
    }

    /** Toggle global animation play/pause */
    function toggleGlobalAnimation() {
        if (globalAnimPlaying) {
            stopGlobalAnimation();
        } else {
            startGlobalAnimation();
        }
    }

    /** Clean up global animation frames */
    function cleanupGlobalAnimation() {
        stopGlobalAnimation();
        for (var i = 0; i < globalAnimFrameLayers.length; i++) {
            if (map && globalAnimFrameLayers[i]) {
                map.removeLayer(globalAnimFrameLayers[i]);
            }
        }
        globalAnimFrameLayers = [];
        globalAnimFrameTimes = [];
        globalAnimLoaded = 0;
        globalAnimReady = false;
        globalAnimLoading = false;
        globalAnimIndex = 0;
        updateGlobalAnimControls('idle');
    }

    /** Update the global animation control panel state.
     *  States: 'idle', 'loading', 'ready', 'playing' */
    function updateGlobalAnimControls(state, pct) {
        var panel = document.getElementById('ir-global-anim-panel');
        if (!panel) return;

        var playBtn = document.getElementById('ir-global-anim-play');
        var timeEl = document.getElementById('ir-global-anim-time');
        var statusEl = document.getElementById('ir-global-anim-status');

        if (state === 'idle') {
            if (playBtn) { playBtn.innerHTML = '&#9654;'; playBtn.title = 'Load & play global animation'; }
            if (timeEl) timeEl.textContent = '';
            if (statusEl) statusEl.textContent = '';
        } else if (state === 'loading') {
            if (playBtn) { playBtn.innerHTML = '&#8987;'; playBtn.title = 'Loading frames\u2026'; playBtn.disabled = true; }
            if (statusEl) statusEl.textContent = (pct != null ? pct + '%' : 'Loading\u2026');
        } else if (state === 'ready') {
            if (playBtn) { playBtn.innerHTML = '&#9654;'; playBtn.title = 'Play'; playBtn.disabled = false; }
            if (statusEl) statusEl.textContent = (globalAnimIndex + 1) + '/' + globalAnimFrameLayers.length;
        } else if (state === 'playing') {
            if (playBtn) { playBtn.innerHTML = '&#9646;&#9646;'; playBtn.title = 'Pause'; playBtn.disabled = false; }
            if (statusEl) statusEl.textContent = '';
        }
    }

    /** Build an array of GIBS time strings for animation (lookback_hours, every 30 min).
     *  @param {Date}    centerDt      - end time reference
     *  @param {number}  lookbackHours - how many hours to look back
     *  @param {boolean} verified      - if true, centerDt is an already-verified
     *                                   GIBS time so skip the 15-min safety margin */
    function buildFrameTimes(centerDt, lookbackHours, verified) {
        var times = [];
        var end = roundToGIBSInterval(centerDt);
        if (!verified) {
            // Apply 15-min safety margin when using unverified current time
            end = new Date(end.getTime() - 15 * 60 * 1000);
        }
        var start = new Date(end.getTime() - lookbackHours * 3600 * 1000);
        var step = 30 * 60 * 1000; // 30-min steps for animation (not every 10 min — too many frames)
        for (var t = start.getTime(); t <= end.getTime(); t += step) {
            var d = roundToGIBSInterval(new Date(t));
            times.push(toGIBSTime(d));
        }
        return times;
    }

    // ═══════════════════════════════════════════════════════════
    //  MAP VIEW
    // ═══════════════════════════════════════════════════════════

    /** Initialize the Leaflet map */
    function initMap() {
        map = L.map('ir-map', {
            center: [20, -40],
            zoom: 3,
            minZoom: 2,
            maxZoom: GIBS_MAX_ZOOM,
            zoomControl: true,
            worldCopyJump: true,
            preferCanvas: true  // faster rendering for vector overlays
        });

        // Dark basemap (underneath IR) — load first for fast initial paint
        var basemap = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd',
            maxZoom: 19
        }).addTo(map);

        // Defer GIBS overlay slightly so basemap tiles get priority in the browser's
        // connection pool (6 connections per host). This makes the map feel responsive
        // immediately rather than everything loading at once.
        // addGIBSOverlay is now async (probes for latest available GIBS time)
        // and updates gibsIRLayers directly when the layer is ready.
        var gibsRequested = false;
        basemap.once('load', function () {
            if (!gibsRequested) {
                gibsRequested = true;
                addGIBSOverlay(map, 0.85);
            }
        });
        // Fallback in case basemap load event doesn't fire (cached tiles)
        setTimeout(function () {
            if (!gibsRequested) {
                gibsRequested = true;
                addGIBSOverlay(map, 0.85);
            }
        }, 800);

        // Coastline overlay — Natural Earth 50m GeoJSON as thin black outlines
        // (same approach as global archive) so land masses are clearly visible.
        map.createPane('coastlinePane');
        map.getPane('coastlinePane').style.zIndex = 450;
        map.getPane('coastlinePane').style.pointerEvents = 'none';
        _loadCoastlineOverlay(map);

        // Labels on top of IR
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | IR: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
            subdomains: 'abcd',
            maxZoom: 19,
            pane: 'overlayPane'
        }).addTo(map);

        map.zoomControl.setPosition('topleft');

        // Allow zoom 7 (GeoColor tiles go up to Level7)
        map.setMaxZoom(GIBS_VIS_MAX_ZOOM);

        // Add IR/GeoColor toggle control (bottom-right of map)
        var ProductToggle = L.Control.extend({
            options: { position: 'topright' },
            onAdd: function () {
                var btn = L.DomUtil.create('button', 'ir-global-toggle-btn');
                btn.id = 'ir-global-product-toggle';
                btn.textContent = 'Switch to GeoColor';
                btn.title = 'Currently showing Enhanced IR — click to switch to GeoColor';
                btn.style.cssText = 'padding:6px 14px;font-family:DM Sans,sans-serif;font-size:0.72rem;font-weight:500;color:#8b9ec2;background:rgba(15,33,64,0.88);border:1px solid rgba(255,255,255,0.12);border-radius:5px;cursor:pointer;white-space:nowrap;backdrop-filter:blur(4px);';
                L.DomEvent.disableClickPropagation(btn);
                btn.addEventListener('click', function () {
                    setGlobalProduct(globalProduct === 'eir' ? 'geocolor' : 'eir');
                });
                btn.addEventListener('mouseenter', function () {
                    btn.style.background = 'rgba(30,60,110,0.9)';
                    btn.style.color = '#c0d0ea';
                });
                btn.addEventListener('mouseleave', function () {
                    btn.style.background = 'rgba(15,33,64,0.88)';
                    btn.style.color = '#8b9ec2';
                });
                return btn;
            }
        });
        map.addControl(new ProductToggle());

        // Add IR Tb colorbar to global map (bottom-left, above animation panel)
        var TbColorbar = L.Control.extend({
            options: { position: 'bottomleft' },
            onAdd: function () {
                var container = L.DomUtil.create('div', 'ir-global-colorbar');
                container.id = 'ir-global-colorbar';
                container.style.cssText = 'background:rgba(0,0,0,0.65);padding:6px 10px;border-radius:4px;font-family:JetBrains Mono,monospace;font-size:0.65rem;color:rgba(255,255,255,0.7);pointer-events:none;margin-bottom:4px;';
                L.DomEvent.disableClickPropagation(container);

                var label = L.DomUtil.create('div', '', container);
                label.textContent = 'Brightness Temp (K)';
                label.style.cssText = 'margin-bottom:2px;';

                var bar = L.DomUtil.create('div', '', container);
                bar.style.cssText = 'width:160px;height:10px;border-radius:2px;margin:4px 0 2px;background:linear-gradient(to right,rgb(8,8,8),rgb(90,90,90),rgb(200,200,200),rgb(0,100,255),rgb(0,255,0),rgb(255,180,0),rgb(255,0,0),rgb(180,0,180),rgb(255,255,255));';

                var labels = L.DomUtil.create('div', '', container);
                labels.style.cssText = 'display:flex;justify-content:space-between;font-size:0.6rem;';
                labels.innerHTML = '<span>310</span><span>250</span><span>190</span>';

                return container;
            }
        });
        map.addControl(new TbColorbar());

        // Add global animation control panel (bottom-right, above status bar)
        var AnimPanel = L.Control.extend({
            options: { position: 'bottomleft' },
            onAdd: function () {
                var container = L.DomUtil.create('div', 'ir-global-anim-panel');
                container.id = 'ir-global-anim-panel';
                container.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 10px;font-family:DM Sans,sans-serif;font-size:0.72rem;color:#8b9ec2;background:rgba(15,33,64,0.88);border:1px solid rgba(255,255,255,0.12);border-radius:5px;backdrop-filter:blur(4px);margin-bottom:36px;';
                L.DomEvent.disableClickPropagation(container);

                // Prev button
                var prevBtn = L.DomUtil.create('button', '', container);
                prevBtn.innerHTML = '&#9664;';
                prevBtn.title = 'Previous frame';
                prevBtn.style.cssText = 'background:none;border:none;color:#8b9ec2;cursor:pointer;font-size:0.7rem;padding:2px 4px;';
                prevBtn.addEventListener('click', function () {
                    stopGlobalAnimation();
                    prevGlobalFrame();
                });

                // Play/Pause button
                var playBtn = L.DomUtil.create('button', '', container);
                playBtn.id = 'ir-global-anim-play';
                playBtn.innerHTML = '&#9654;';
                playBtn.title = 'Load & play global animation';
                playBtn.style.cssText = 'background:none;border:none;color:#60a5fa;cursor:pointer;font-size:0.85rem;padding:2px 6px;';
                playBtn.addEventListener('click', toggleGlobalAnimation);

                // Next button
                var nextBtn = L.DomUtil.create('button', '', container);
                nextBtn.innerHTML = '&#9654;';
                nextBtn.title = 'Next frame';
                nextBtn.style.cssText = 'background:none;border:none;color:#8b9ec2;cursor:pointer;font-size:0.7rem;padding:2px 4px;';
                nextBtn.addEventListener('click', function () {
                    stopGlobalAnimation();
                    nextGlobalFrame();
                });

                // Time display
                var timeSpan = L.DomUtil.create('span', '', container);
                timeSpan.id = 'ir-global-anim-time';
                timeSpan.style.cssText = 'color:#e2e8f0;font-weight:500;font-size:0.68rem;letter-spacing:0.03em;min-width:90px;';

                // Speed toggle button
                var speedBtn = L.DomUtil.create('button', '', container);
                speedBtn.id = 'ir-global-anim-speed';
                speedBtn.textContent = GLOBAL_ANIM_SPEEDS[globalAnimSpeedIdx].label;
                speedBtn.title = 'Cycle animation speed';
                speedBtn.style.cssText = 'background:rgba(96,165,250,0.15);border:1px solid rgba(96,165,250,0.3);color:#60a5fa;cursor:pointer;font-size:0.6rem;font-weight:600;padding:1px 6px;border-radius:3px;font-family:JetBrains Mono,monospace;';
                speedBtn.addEventListener('click', cycleGlobalAnimSpeed);

                // Status display
                var statusSpan = L.DomUtil.create('span', '', container);
                statusSpan.id = 'ir-global-anim-status';
                statusSpan.style.cssText = 'color:#64748b;font-size:0.65rem;';

                // Stop/reset button
                var stopBtn = L.DomUtil.create('button', '', container);
                stopBtn.innerHTML = '&#9632;';
                stopBtn.title = 'Stop animation and return to latest';
                stopBtn.style.cssText = 'background:none;border:none;color:#8b9ec2;cursor:pointer;font-size:0.65rem;padding:2px 4px;';
                stopBtn.addEventListener('click', function () {
                    if (globalAnimFrameLayers.length === 0) return;
                    cleanupGlobalAnimation();
                    // Restore static single-frame layer (with per-satellite times for IR)
                    if (latestGIBSTime) {
                        if (globalProduct === 'geocolor') {
                            var visLyr = createCompositeGIBSLayerVis(latestGIBSTime, 0.75);
                            visLyr.addTo(map);
                            gibsVisLayers = [visLyr];
                        } else {
                            var perSat = (Object.keys(latestGIBSTimes).length > 0) ? latestGIBSTimes : null;
                            var irLyr = createCompositeGIBSLayer(latestGIBSTime, 0.65, perSat);
                            irLyr.addTo(map);
                            gibsIRLayers = [irLyr];
                        }
                    }
                });

                return container;
            }
        });
        map.addControl(new AnimPanel());
    }

    /** Clear existing storm markers from the map */
    function clearMarkers() {
        for (var i = 0; i < stormMarkers.length; i++) {
            map.removeLayer(stormMarkers[i]);
        }
        stormMarkers = [];
    }

    /** Place storm markers on the map */
    function renderStormMarkers(storms) {
        clearMarkers();

        for (var i = 0; i < storms.length; i++) {
            var s = storms[i];
            var cat = s.category || windToCategory(s.vmax_kt);
            var color = SS_COLORS[cat] || SS_COLORS.TD;

            var icon = L.divIcon({
                className: '',
                html: '<div class="ir-storm-marker" style="' +
                      'width:18px;height:18px;background:' + color + ';' +
                      'color:' + color + ';' +
                      '"></div>',
                iconSize: [18, 18],
                iconAnchor: [9, 9],
                popupAnchor: [0, -12]
            });

            var marker = L.marker([s.lat, s.lon], { icon: icon });

            // Popup content
            var vmaxStr = s.vmax_kt != null ? s.vmax_kt + ' kt' : '\u2014';
            var mslpStr = s.mslp_hpa != null ? s.mslp_hpa + ' hPa' : '\u2014';
            var popupHtml =
                '<div class="ir-popup">' +
                  '<div class="ir-popup-name">' + (s.name || 'UNNAMED') + '</div>' +
                  '<div class="ir-popup-meta">' +
                    '<strong>' + categoryShort(cat) + '</strong> &middot; ' + vmaxStr + '<br>' +
                    'MSLP: ' + mslpStr + '<br>' +
                    fmtLatLon(s.lat, s.lon) + '<br>' +
                    '<span style="color:#64748b;">' + (s.atcf_id || '') + '</span>' +
                  '</div>' +
                  '<button class="ir-popup-btn" onclick="window._irOpenStorm(\'' + s.atcf_id + '\')">View IR Detail</button>' +
                '</div>';

            marker.bindPopup(popupHtml, { maxWidth: 260 });

            // Also open detail on double-click
            (function (atcfId) {
                marker.on('dblclick', function () {
                    window._irOpenStorm(atcfId);
                });
            })(s.atcf_id);

            marker.addTo(map);
            stormMarkers.push(marker);
        }
    }

    /** Clear past track layers from the map */
    function clearTracks() {
        for (var i = 0; i < trackLayers.length; i++) {
            map.removeLayer(trackLayers[i]);
        }
        trackLayers = [];
    }

    /** Fetch metadata for a storm and draw its past track on the main map */
    function fetchAndDrawTrack(storm) {
        var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id) + '/metadata';

        fetch(url, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (meta) {
                if (!meta || !meta.intensity_history || meta.intensity_history.length < 2) return;
                drawTrackOnMap(map, meta.intensity_history, storm, trackLayers);
            })
            .catch(function (err) { console.warn('[RT Monitor] Track fetch failed:', err.message || ''); });
    }

    /** Draw a past track polyline + intensity dots on a Leaflet map */
    function drawTrackOnMap(targetMap, history, storm, layerArr) {
        // Build segments colored by intensity
        for (var i = 1; i < history.length; i++) {
            var prev = history[i - 1];
            var curr = history[i];

            // Skip segments with impossibly large spatial jumps (recycled invest IDs)
            var dlat = curr.lat - prev.lat;
            var dlon = curr.lon - prev.lon;
            var cosLat = Math.cos((curr.lat + prev.lat) * 0.5 * Math.PI / 180);
            var dist = Math.sqrt(dlat * dlat + (dlon * cosLat) * (dlon * cosLat));
            if (dist > 8) continue;  // >8° (~900 km) in one fix interval = invest recycling

            var cat = windToCategory(curr.vmax_kt);
            var color = SS_COLORS[cat] || SS_COLORS.TD;

            // Segment polyline
            var seg = L.polyline(
                [[prev.lat, prev.lon], [curr.lat, curr.lon]],
                { color: color, weight: 2.5, opacity: 0.7 }
            );
            seg.addTo(targetMap);
            layerArr.push(seg);

            // Dot at each fix
            var dot = L.circleMarker([curr.lat, curr.lon], {
                radius: 3, color: color, fillColor: color,
                fillOpacity: 0.9, weight: 0
            });
            // Tooltip with time + wind
            var tipText = fmtUTC(curr.time) +
                (curr.vmax_kt != null ? ' — ' + curr.vmax_kt + ' kt' : '');
            dot.bindTooltip(tipText, { direction: 'top', offset: [0, -6] });
            dot.addTo(targetMap);
            layerArr.push(dot);
        }

        // Name label near the current position
        var last = history[history.length - 1];
        var cat = storm.category || windToCategory(storm.vmax_kt);
        var label = L.marker([last.lat, last.lon], {
            icon: L.divIcon({
                className: '',
                html: '<div style="color:#fff;font-size:11px;font-weight:600;' +
                      'text-shadow:0 1px 3px rgba(0,0,0,0.8);white-space:nowrap;' +
                      'pointer-events:none;transform:translate(12px,-6px);">' +
                      (storm.name || storm.atcf_id) + '</div>',
                iconSize: [0, 0]
            }),
            interactive: false
        });
        label.addTo(targetMap);
        layerArr.push(label);
    }

    /** Fetch tracks for all active storms */
    function fetchAllTracks(storms) {
        clearTracks();
        for (var i = 0; i < storms.length; i++) {
            fetchAndDrawTrack(storms[i]);
        }
    }

    /** Update the stats bar in the topbar */
    function updateStats(data) {
        var el = function (id) { return document.getElementById(id); };

        var totalActive = data.storms ? data.storms.length : 0;
        el('stat-active').textContent = totalActive;

        var byBasin = data.count_by_basin || {};
        el('stat-atl').textContent = (byBasin.ATL || 0);
        el('stat-epac').textContent = (byBasin.EPAC || 0);
        el('stat-wpac').textContent = (byBasin.WPAC || 0);
        el('stat-shem').textContent = (byBasin.SHEM || 0);

        // Update status bar
        if (totalActive === 0) {
            el('ir-status-text').textContent = 'No active tropical cyclones';
        } else {
            el('ir-status-text').textContent = totalActive + ' active system' + (totalActive === 1 ? '' : 's');
        }
        if (data.updated_utc) {
            el('ir-last-update').textContent = 'Updated: ' + fmtUTC(data.updated_utc);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  DATA FETCHING
    // ═══════════════════════════════════════════════════════════

    /** Poll /ir-monitor/active-storms */
    function pollActiveStorms() {
        var loaderEl = document.getElementById('ir-loader');
        var noStormsEl = document.getElementById('ir-no-storms');

        fetch(API_BASE + '/ir-monitor/active-storms', { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                stormData = data.storms || [];

                // Hide loader
                if (loaderEl) loaderEl.style.display = 'none';

                // Update UI
                updateStats(data);
                renderStormMarkers(stormData);
                fetchAllTracks(stormData);

                // Show/hide no-storms message
                if (noStormsEl) {
                    noStormsEl.style.display = stormData.length === 0 ? 'block' : 'none';
                }

                // Handle deep link on first load
                handleDeepLink();

                // If viewing a storm detail, refresh the header with
                // latest data (name changes, position updates, etc.)
                if (currentStormId) {
                    _refreshDetailHeader(stormData);
                    // Also refresh the intensity chart with latest metadata
                    fetchStormMetadata(currentStormId, function (err, meta) {
                        if (!err && meta) renderIntensityChart(meta);
                    });
                }

                // Pre-warm raw Tb cache for all active storms so data is
                // ready instantly when a user clicks into the detail view.
                _prefetchAllStormsRawTb(stormData);

                _ga('ir_poll_success', { storm_count: stormData.length });
            })
            .catch(function (err) {
                console.warn('[RT Monitor] Poll failed:', err.message);

                // Hide loader, show status
                if (loaderEl) loaderEl.style.display = 'none';
                var statusEl = document.getElementById('ir-status-text');
                if (statusEl) statusEl.textContent = 'Unable to reach server — retrying in 10 min';

                _ga('ir_poll_error', { error: err.message });
            });
    }

    /** Clean up pre-loaded frame layers */
    function cleanupFrameLayers() {
        for (var i = 0; i < animFrameLayers.length; i++) {
            if (animFrameLayers[i] && detailMap) {
                detailMap.removeLayer(animFrameLayers[i]);
            }
        }
        animFrameLayers = [];
        animFrameTimes = [];
        framesLoaded = 0;
        _frameLoadedOnce = {};
        framesReady = false;
        // Also clean up GeoColor frames
        cleanupGeocolorFrameLayers();
    }

    /** Show/hide the loading progress overlay on the detail map */
    function showLoadingProgress(show, pct) {
        var loader = document.getElementById('ir-image-loader');
        var loaderText = loader ? loader.querySelector('.ir-loader-text') : null;
        if (!loader) return;
        if (show) {
            loader.style.display = 'flex';
            if (loaderText) {
                var label = (productMode === 'geocolor') ? 'GeoColor' : 'IR';
                loaderText.textContent = pct != null
                    ? 'Pre-loading ' + label + ' frames\u2026 ' + pct + '%'
                    : 'Pre-loading ' + label + ' frames\u2026';
            }
        } else {
            loader.style.display = 'none';
        }
    }

    var _frameLoadedOnce = {};  // track which frames have fired their initial load
    var _firstFrameShown = false;  // true once we've shown the first available frame
    var _rawTbPrefetchStarted = false;  // guard: only start raw Tb pre-fetch once per storm
    var _deferredLoadsStarted = false;  // guard: only start deferred data loads once per storm
    var _deferredStormRef = null;       // storm object for deferred loads

    /** Called when a single frame layer finishes loading its tiles */
    function onFrameLayerLoaded(frameIdx) {
        // Ignore re-fires from zoom/pan — only count the initial load
        if (_frameLoadedOnce[frameIdx]) return;
        _frameLoadedOnce[frameIdx] = true;

        framesLoaded++;
        var total = animFrameTimes.length;
        var pct = Math.round((framesLoaded / total) * 100);

        // Track this frame as valid if it didn't have tile errors
        if (!frameHasError[frameIdx]) {
            validFrames.push(frameIdx);
            validFrames.sort(function (a, b) { return a - b; });
        }

        // Show the FIRST valid frame immediately so the user sees imagery
        // right away instead of staring at a blank map while 12 more load.
        if (!_firstFrameShown && validFrames.length > 0 && productMode === 'eir') {
            _firstFrameShown = true;
            showFrame(validFrames[validFrames.length - 1]);
            // First frame visible — start loading secondary data
            _triggerDeferredLoads();
            // Switch loader text to indicate remaining frames loading in background
            showLoadingProgress(true, pct);
        } else {
            showLoadingProgress(true, pct);
        }

        if (framesLoaded >= total) {
            framesReady = true;
            // Only update UI if we're currently in EIR mode (GeoColor has its own handler)
            if (productMode === 'eir') {
                showLoadingProgress(false);
                // Show the latest VALID frame now that all tiles are cached
                if (validFrames.length > 0) {
                    showFrame(validFrames[validFrames.length - 1]);
                } else {
                    showFrame(animFrameTimes.length - 1);
                }
                // Update slider max to reflect valid frame count
                var slider = document.getElementById('ir-anim-slider');
                if (slider && validFrames.length > 0) {
                    slider.max = validFrames.length - 1;
                    slider.value = validFrames.length - 1;
                }
                // Enable animation controls
                var playBtn = document.getElementById('ir-anim-play');
                if (playBtn) playBtn.disabled = false;
                updateAnimCounter();
            }
            console.log('[RT Monitor] All ' + total + ' IR frames pre-loaded (' + detailSatName + '), ' + validFrames.length + ' valid');
            // All GIBS tiles loaded — start raw Tb pre-fetch for colormap upgrade
            _fetchRawTbIncremental(currentStormId, true, function () {
                if (productMode === 'eir' && rawTbFrames.length > 0 && detailMap) {
                    showLoadingProgress(false);
                    _applyRawTbToMap();
                    console.log('[RT Monitor] Auto-applied Enhanced IR colormap (' + rawTbFrames.length + ' frames)');
                }
            });
        }
    }

    /** Load secondary data (models, WeatherLab, ASCAT, intensity chart).
     *  Deferred until the first IR frame is visible so the satellite
     *  imagery gets full bandwidth priority. */
    function _triggerDeferredLoads() {
        if (_deferredLoadsStarted) return;
        _deferredLoadsStarted = true;
        var storm = _deferredStormRef;
        if (!storm) return;

        _rtLoadModelForecasts(storm);
        _rtLoadWeatherlab(storm);
        _rtLoadDmEnsemble(storm);
        _rtLoadAscatPasses(storm);
        fetchStormMetadata(storm.atcf_id, function (err, meta) {
            if (!err && meta) {
                renderIntensityChart(meta);
                if (meta.has_recon) {
                    document.getElementById('ir-recon-section').style.display = 'block';
                    document.getElementById('ir-recon-info').innerHTML =
                        '<span style="color:#34d399;">\u25CF Active reconnaissance</span><br>' +
                        '<a href="explorer.html?tab=realtime">\u2192 Open in Real-Time TDR</a>';
                } else {
                    document.getElementById('ir-recon-section').style.display = 'none';
                }
            }
        });
        // Raw Tb pre-fetch starts when ALL GIBS tiles finish loading
        // (see onFrameLayerLoaded). Panel requests get a natural head
        // start since they fire on the first tile, not the last.
    }

    /** Fallback: load GIBS tile layers for animation (used when image overlay fails) */
    function _initDetailMapGIBS(storm, satLayerName) {
        if (!detailMap) return;

        var endTime;
        var gibsTimeVerified = false;
        if (latestGIBSTimes && latestGIBSTimes[detailSatName]) {
            endTime = new Date(latestGIBSTimes[detailSatName]);
            gibsTimeVerified = true;
        } else {
            endTime = new Date();
        }
        animFrameTimes = buildFrameTimes(endTime, DEFAULT_LOOKBACK_HOURS, gibsTimeVerified);
        animIndex = animFrameTimes.length - 1;

        var FRAME_BATCH_SIZE = 3;
        var totalFrames = animFrameTimes.length;
        var loadOrder = [];
        for (var k = totalFrames - 1; k >= 0; k--) loadOrder.push(k);

        for (var i = 0; i < totalFrames; i++) {
            var lyr = createGIBSLayer(satLayerName, animFrameTimes[i], 0);
            frameHasError.push(false);
            animFrameLayers.push(lyr);
        }

        var _batchAddedToMap = {};
        var _batchNextIdx = 0;

        function _addNextBatch() {
            var added = 0;
            while (_batchNextIdx < loadOrder.length && added < FRAME_BATCH_SIZE) {
                var fi = loadOrder[_batchNextIdx];
                _batchNextIdx++;
                if (_batchAddedToMap[fi]) continue;
                _batchAddedToMap[fi] = true;
                animFrameLayers[fi].addTo(detailMap);
                (function (idx) {
                    animFrameLayers[idx].on('tileerror', function () {
                        frameHasError[idx] = true;
                        onFrameLayerLoaded(idx);
                        _addNextBatch();
                    });
                    animFrameLayers[idx].on('load', function () {
                        onFrameLayerLoaded(idx);
                        _addNextBatch();
                    });
                })(fi);
                added++;
            }
        }
        _addNextBatch();

        var slider = document.getElementById('ir-anim-slider');
        if (slider) { slider.max = animFrameTimes.length - 1; slider.value = animIndex; }
        updateAnimCounter();
        updateFrameOverlay();

        console.log('[RT Monitor] GIBS fallback: loading ' + totalFrames + ' tile layers');
    }

    /** Initialize the detail mini-map for a storm */
    function initDetailMap(storm) {
        var container = document.getElementById('ir-image-container');

        // Destroy old mini-map if exists
        cleanupFrameLayers();
        if (detailMap) {
            detailMap.remove();
            detailMap = null;
        }

        // Hide the old canvas, ensure map div exists
        var canvas = document.getElementById('ir-canvas');
        if (canvas) canvas.style.display = 'none';

        var mapDiv = document.getElementById('ir-detail-map');
        if (!mapDiv) {
            mapDiv = document.createElement('div');
            mapDiv.id = 'ir-detail-map';
            mapDiv.style.cssText = 'width:100%;height:100%;position:absolute;top:0;left:0;z-index:1;';
            container.appendChild(mapDiv);
        }
        mapDiv.style.display = 'block';

        // Create mini-map centered on storm
        // Allow up to zoom 7 (GeoColor supports Level7); IR tiles still capped at Level6
        detailMap = L.map(mapDiv, {
            center: [storm.lat, storm.lon],
            zoom: 5,
            minZoom: 3,
            maxZoom: GIBS_VIS_MAX_ZOOM,
            zoomControl: true,
            attributionControl: false
        });

        // Dark basemap
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 19
        }).addTo(detailMap);

        // Store storm position for solar elevation calculations (GeoColor day/night)
        detailStormLat = storm.lat;
        detailStormLon = storm.lon;

        // Pick the single best satellite for this storm's longitude
        detailSatName = bestSatelliteForLon(storm.lon);
        var satLayerName = GIBS_IR_LAYERS[detailSatName];

        // Reset animation state
        framesLoaded = 0;
        _frameLoadedOnce = {};
        _firstFrameShown = false;
        _rawTbPrefetchStarted = false;
        _deferredLoadsStarted = false;
        _deferredStormRef = storm;
        framesReady = false;
        animFrameLayers = [];
        validFrames = [];
        frameHasError = [];

        // Disable play button until frames load
        var playBtn = document.getElementById('ir-anim-play');
        if (playBtn) playBtn.disabled = true;

        // Show loading progress
        showLoadingProgress(true, 0);

        // ── GIBS tiles (immediate) ───────────────────────────
        // Load GIBS tiles from NASA's CDN — fast, reliable, no
        // backend dependency. User sees imagery within 3-5 seconds.
        _initDetailMapGIBS(storm, satLayerName);

        // Raw Tb pre-fetch starts inside _triggerDeferredLoads() with a
        // 3-second delay, giving panel requests (models, WeatherLab, etc.)
        // a head start on the backend before the heavy Tb fetches begin.

        // Coastline overlay — Natural Earth 50m black outlines (matches global archive)
        detailMap.createPane('coastlinePane');
        detailMap.getPane('coastlinePane').style.zIndex = 450;
        detailMap.getPane('coastlinePane').style.pointerEvents = 'none';
        _loadCoastlineOverlay(detailMap);

        // ASCAT wind barb pane — above tiles, below coastlines
        detailMap.createPane('ascatPane');
        detailMap.getPane('ascatPane').style.zIndex = 440;
        detailMap.getPane('ascatPane').style.pointerEvents = 'none';

        // Labels on top (in overlay pane so above IR tiles)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
            subdomains: 'abcd', maxZoom: 19, pane: 'overlayPane'
        }).addTo(detailMap);

        // Storm center marker
        var cat = storm.category || windToCategory(storm.vmax_kt);
        var color = SS_COLORS[cat] || SS_COLORS.TD;
        L.circleMarker([storm.lat, storm.lon], {
            radius: 8, color: color, fillColor: color,
            fillOpacity: 0.7, weight: 2
        }).addTo(detailMap);

        // Fetch and draw past track on detail map
        detailTrackLayers = [];
        var stormCopy = storm;
        fetchStormMetadata(storm.atcf_id, function (metaErr, meta) {
            if (!metaErr && meta && meta.intensity_history && meta.intensity_history.length >= 2) {
                drawTrackOnMap(detailMap, meta.intensity_history, stormCopy, detailTrackLayers);
            }
        });

        // Show IR Tb colorbar legend (vigor legend stays hidden until toggled)
        var tbLeg = document.getElementById('ir-tb-legend');
        if (tbLeg) tbLeg.style.display = 'block';

        // Force map resize after layout settles
        setTimeout(function () { detailMap.invalidateSize(); }, 100);

        // Safety timeout: if GIBS tiles haven't loaded within 30s, start anyway
        setTimeout(function () {
            if (!framesReady && animFrameLayers.length > 0) {
                console.warn('[RT Monitor] Frame preload timeout — enabling animation with ' + framesLoaded + '/' + animFrameTimes.length + ' frames (' + validFrames.length + ' valid)');
                framesReady = true;
                if (productMode === 'eir') {
                    showLoadingProgress(false);
                }
                var playBtn = document.getElementById('ir-anim-play');
                if (playBtn && productMode === 'eir') playBtn.disabled = false;
                var slider = document.getElementById('ir-anim-slider');
                if (productMode === 'eir') {
                    if (slider && validFrames.length > 0) {
                        slider.max = validFrames.length - 1;
                        slider.value = validFrames.length - 1;
                        showFrame(validFrames[validFrames.length - 1]);
                    } else {
                        showFrame(animFrameTimes.length - 1);
                    }
                    updateAnimCounter();
                }
                _triggerDeferredLoads();
            }
        }, 30000);

        _ga('ir_detail_map_init', {
            atcf_id: storm.atcf_id,
            satellite: detailSatName,
            frames: animFrameTimes.length
        });
    }

    /** Fetch storm metadata (intensity history, etc.) */
    function fetchStormMetadata(atcfId, callback) {
        var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(atcfId) + '/metadata';

        fetch(url, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                callback(null, data);
            })
            .catch(function (err) {
                console.warn('[RT Monitor] Metadata fetch failed:', err.message);
                callback(err);
            });
    }

    // ═══════════════════════════════════════════════════════════
    //  STORM DETAIL VIEW
    // ═══════════════════════════════════════════════════════════

    /** Open the storm detail view */
    function openStormDetail(atcfId) {
        currentStormId = atcfId;

        // Clean up model overlay from previous storm
        _rtRemoveModelOverlay();

        // Stop global animation if running (frames stay in memory for return)
        stopGlobalAnimation();

        // Reset product state for new storm
        productMode = 'eir';
        vigorMode = false;
        vigorFetching = false;
        removeVigorLayer();
        cleanupGeocolorFrameLayers();
        var eirBtn = document.getElementById('ir-product-eir');
        var geoBtn = document.getElementById('ir-product-geocolor');
        var vigBtn = document.getElementById('ir-product-vigor');
        if (eirBtn) eirBtn.classList.add('ir-product-active');
        if (geoBtn) { geoBtn.classList.remove('ir-product-active'); geoBtn.classList.remove('ir-vigor-loading'); geoBtn.textContent = 'GeoColor'; }
        if (vigBtn) { vigBtn.classList.remove('ir-product-active'); vigBtn.classList.remove('ir-vigor-loading'); vigBtn.textContent = 'IR Vigor'; }
        var vigorLegend = document.getElementById('ir-vigor-legend');
        if (vigorLegend) vigorLegend.style.display = 'none';

        // Find storm in current data
        var storm = null;
        for (var i = 0; i < stormData.length; i++) {
            if (stormData[i].atcf_id === atcfId) {
                storm = stormData[i];
                break;
            }
        }

        if (!storm) {
            console.warn('[RT Monitor] Storm not found:', atcfId);
            return;
        }

        // Update URL hash for deep linking
        if (window.history && window.history.replaceState) {
            window.history.replaceState(null, '', 'realtime_ir.html#' + atcfId);
        }

        // Hide map view, show detail
        document.getElementById('ir-main').style.display = 'none';
        document.getElementById('ir-legend').style.display = 'none';
        var detailEl = document.getElementById('ir-detail');
        detailEl.style.display = 'block';

        // Populate header
        var cat = storm.category || windToCategory(storm.vmax_kt);
        var color = SS_COLORS[cat] || SS_COLORS.TD;
        document.getElementById('ir-detail-name').textContent = storm.name || 'UNNAMED';
        document.getElementById('ir-detail-id').textContent = storm.atcf_id;
        var catEl = document.getElementById('ir-detail-cat');
        catEl.textContent = categoryShort(cat) + (storm.vmax_kt != null ? ' \u00B7 ' + storm.vmax_kt + ' kt' : '');
        catEl.style.background = color;

        // Populate info grid
        document.getElementById('ir-info-basin').textContent = storm.basin || '\u2014';
        document.getElementById('ir-info-position').textContent = fmtLatLon(storm.lat, storm.lon);
        document.getElementById('ir-info-motion').textContent =
            storm.motion_deg != null ? storm.motion_deg + '\u00B0 at ' + (storm.motion_kt || '\u2014') + ' kt' : '\u2014';
        document.getElementById('ir-info-mslp').textContent =
            storm.mslp_hpa != null ? storm.mslp_hpa + ' hPa' : '\u2014';
        document.getElementById('ir-info-vmax').textContent =
            storm.vmax_kt != null ? storm.vmax_kt + ' kt (' + categoryShort(cat) + ')' : '\u2014';
        document.getElementById('ir-info-lastfix').textContent = fmtUTC(storm.last_fix_utc);

        // Official forecast link
        var officialSection = document.getElementById('ir-official-section');
        var officialLink = document.getElementById('ir-official-link');
        var officialUrl = getOfficialForecastUrl(storm);
        if (officialUrl) {
            officialLink.href = officialUrl;
            officialSection.style.display = 'block';
        } else {
            officialSection.style.display = 'none';
        }

        // Initialize GIBS-based IR mini-map
        stopAnimation();
        animFrameTimes = [];
        animIndex = 0;
        initDetailMap(storm);

        // Secondary data (models, WeatherLab, ASCAT, intensity chart) is
        // deferred until the first IR frame is visible — see _triggerDeferredLoads().
        // This gives the satellite imagery full bandwidth priority.

        _ga('ir_open_detail', { atcf_id: atcfId, name: storm.name, category: cat });
    }

    /**
     * Refresh the detail view header with latest storm data from a poll.
     * Handles name changes (e.g. "Four" → "Sinlaku"), position updates,
     * and intensity changes while the detail view is open.
     */
    function _refreshDetailHeader(storms) {
        if (!currentStormId) return;
        var storm = null;
        for (var i = 0; i < storms.length; i++) {
            if (storms[i].atcf_id === currentStormId) {
                storm = storms[i];
                break;
            }
        }
        if (!storm) return;

        var cat = storm.category || windToCategory(storm.vmax_kt);
        var color = SS_COLORS[cat] || SS_COLORS.TD;

        var nameEl = document.getElementById('ir-detail-name');
        if (nameEl) nameEl.textContent = storm.name || 'UNNAMED';

        var catEl = document.getElementById('ir-detail-cat');
        if (catEl) {
            catEl.textContent = categoryShort(cat) + (storm.vmax_kt != null ? ' \u00B7 ' + storm.vmax_kt + ' kt' : '');
            catEl.style.background = color;
        }

        var posEl = document.getElementById('ir-info-position');
        if (posEl) posEl.textContent = fmtLatLon(storm.lat, storm.lon);

        var mslpEl = document.getElementById('ir-info-mslp');
        if (mslpEl) mslpEl.textContent = storm.mslp_hpa != null ? storm.mslp_hpa + ' hPa' : '\u2014';

        var vmaxEl = document.getElementById('ir-info-vmax');
        if (vmaxEl) vmaxEl.textContent = storm.vmax_kt != null ? storm.vmax_kt + ' kt (' + categoryShort(cat) + ')' : '\u2014';

        var fixEl = document.getElementById('ir-info-lastfix');
        if (fixEl) fixEl.textContent = fmtUTC(storm.last_fix_utc);

        var motionEl = document.getElementById('ir-info-motion');
        if (motionEl) motionEl.textContent =
            storm.motion_deg != null ? storm.motion_deg + '\u00B0 at ' + (storm.motion_kt || '\u2014') + ' kt' : '\u2014';
    }

    /** Close the detail view and return to the map */
    function closeStormDetail() {
        currentStormId = null;
        stopAnimation();

        // Clean up model overlay
        _rtRemoveModelOverlay();
        _rtRemoveAscatOverlay();

        // Reset product state
        removeVigorLayer();
        cleanupGeocolorFrameLayers();
        rawTbFrames = [];
        _gibsAnimFrameLayers = null;
        productMode = 'eir';
        vigorMode = false;
        vigorFetching = false;

        // Reset colormap selector
        var cmapSelect = document.getElementById('ir-colormap-select');
        if (cmapSelect) cmapSelect.value = 'gibs';
        var gradBar = document.getElementById('ir-tb-legend-bar-gradient');
        var canvasBar = document.getElementById('ir-tb-colorbar-canvas');
        if (gradBar) gradBar.style.display = '';
        if (canvasBar) canvasBar.style.display = 'none';
        var eirBtn = document.getElementById('ir-product-eir');
        var geoBtn = document.getElementById('ir-product-geocolor');
        var vigBtn = document.getElementById('ir-product-vigor');
        if (eirBtn) eirBtn.classList.add('ir-product-active');
        if (geoBtn) { geoBtn.classList.remove('ir-product-active'); geoBtn.classList.remove('ir-vigor-loading'); geoBtn.textContent = 'GeoColor'; }
        if (vigBtn) { vigBtn.classList.remove('ir-product-active'); vigBtn.classList.remove('ir-vigor-loading'); vigBtn.textContent = 'IR Vigor'; }
        var vigorLegend = document.getElementById('ir-vigor-legend');
        if (vigorLegend) vigorLegend.style.display = 'none';
        var tbLegend = document.getElementById('ir-tb-legend');
        if (tbLegend) tbLegend.style.display = 'none';

        // Clean up pre-loaded frame layers
        cleanupFrameLayers();

        // Clean up detail mini-map
        if (detailMap) {
            detailMap.remove();
            detailMap = null;
        }
        var detailMapDiv = document.getElementById('ir-detail-map');
        if (detailMapDiv) detailMapDiv.style.display = 'none';

        // Update URL
        if (window.history && window.history.replaceState) {
            window.history.replaceState(null, '', 'realtime_ir.html');
        }

        // Hide detail, show map
        document.getElementById('ir-detail').style.display = 'none';
        document.getElementById('ir-main').style.display = 'block';
        document.getElementById('ir-legend').style.display = 'block';

        // Resize map (in case container changed)
        if (map) map.invalidateSize();

        _ga('ir_close_detail');
    }

    // ═══════════════════════════════════════════════════════════
    //  IR ANIMATION (GIBS time-stepping)
    // ═══════════════════════════════════════════════════════════

    /** Update the overlay info with the current frame time */
    function updateFrameOverlay() {
        if (animFrameTimes.length === 0) return;
        _cacheAnimEls();
        var timeStr = animFrameTimes[animIndex];
        if (_elFrameTime) _elFrameTime.textContent = fmtUTC(timeStr);
        if (_elSatLabel) _elSatLabel.textContent = detailSatName || 'GIBS IR';
    }

    /** Show a specific frame by toggling opacity (instant — no tile fetching) */
    function showFrame(idx) {
        if (idx < 0 || idx >= animFrameLayers.length || !detailMap) return;

        // Hide the current frame
        if (animIndex >= 0 && animIndex < animFrameLayers.length) {
            animFrameLayers[animIndex].setOpacity(0);
        }

        // Show the new frame
        animIndex = idx;
        animFrameLayers[idx].setOpacity(0.85);
        updateFrameOverlay();

        // Sync model overlay to new frame time
        if (_rtModelVisible && _rtModelAutoSync && _rtModelData) {
            _rtSyncModelCycleToIR();
        }
    }

    /** Find the position of animIndex within validFrames (or -1) */
    /** Get the active set of valid frames and frame layers for the current product mode */
    function activeFrameState() {
        if (productMode === 'geocolor') {
            return {
                valid: geocolorValidFrames,
                layers: geocolorFrameLayers,
                times: geocolorFrameTimes,
                ready: geocolorFramesReady,
                showFn: showGeocolorFrame
            };
        }
        return {
            valid: validFrames,
            layers: animFrameLayers,
            times: animFrameTimes,
            ready: framesReady,
            showFn: showFrame
        };
    }

    /** Update the frame counter text (shows position in valid frames) */
    function updateAnimCounter() {
        _cacheAnimEls();
        if (!_elAnimCounter) return;
        var state = activeFrameState();
        var pos = activeValidFramePos();
        if (state.valid.length > 0 && pos >= 0) {
            _elAnimCounter.textContent = (pos + 1) + ' / ' + state.valid.length;
        } else {
            _elAnimCounter.textContent = (animIndex + 1) + ' / ' + state.times.length;
        }
    }

    /** Find position of animIndex within the active valid frames array */
    function activeValidFramePos() {
        var state = activeFrameState();
        for (var i = 0; i < state.valid.length; i++) {
            if (state.valid[i] === animIndex) return i;
        }
        return -1;
    }

    /** Step to next valid frame */
    function nextFrame() {
        if (productMode === 'vigor') return;
        var state = activeFrameState();
        if (!state.ready) return;
        if (state.valid.length === 0) return;
        var pos = activeValidFramePos();
        var nextPos = (pos + 1) % state.valid.length;
        state.showFn(state.valid[nextPos]);
        _cacheAnimEls();
        if (_elAnimSlider) _elAnimSlider.value = nextPos;
        updateAnimCounter();
    }

    /** Step to previous valid frame */
    function prevFrame() {
        if (productMode === 'vigor') return;
        var state = activeFrameState();
        if (!state.ready) return;
        if (state.valid.length === 0) return;
        var pos = activeValidFramePos();
        var prevPos = (pos - 1 + state.valid.length) % state.valid.length;
        state.showFn(state.valid[prevPos]);
        _cacheAnimEls();
        if (_elAnimSlider) _elAnimSlider.value = prevPos;
        updateAnimCounter();
    }

    /** Toggle play/pause */
    function togglePlay() {
        if (animPlaying) {
            stopAnimation();
        } else {
            startAnimation();
        }
    }

    /** rAF tick for detail animation */
    function _animTick(ts) {
        if (!animPlaying) return;
        if (ts - animLastTick >= animIntervalMs) {
            animLastTick = ts;
            nextFrame();
        }
        animTimer = requestAnimationFrame(_animTick);
    }

    /** Start animation loop */
    function startAnimation() {
        if (productMode === 'vigor') return;
        var state = activeFrameState();
        if (state.times.length < 2 || !state.ready) return;
        animPlaying = true;
        _cacheAnimEls();
        if (_elAnimPlay) {
            _elAnimPlay.innerHTML = '&#9646;&#9646;'; // pause icon
            _elAnimPlay.title = 'Pause';
        }

        // rAF-driven loop — ~2 fps via animIntervalMs (500ms)
        animLastTick = 0;
        animTimer = requestAnimationFrame(_animTick);
    }

    /** Stop animation loop */
    function stopAnimation() {
        animPlaying = false;
        if (animTimer) cancelAnimationFrame(animTimer);
        animTimer = null;
        _cacheAnimEls();
        if (_elAnimPlay) {
            _elAnimPlay.innerHTML = '&#9654;'; // play icon
            _elAnimPlay.title = 'Play';
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  INTENSITY CHART (Plotly)
    // ═══════════════════════════════════════════════════════════

    /** Render the intensity timeline chart */
    function renderIntensityChart(meta) {
        var chartEl = document.getElementById('ir-intensity-chart');
        if (!chartEl || typeof Plotly === 'undefined') return;

        var history = meta.intensity_history || [];
        if (history.length === 0) {
            chartEl.innerHTML = '<div style="text-align:center;color:#64748b;padding:40px 0;font-size:0.8rem;">No intensity data available</div>';
            return;
        }

        var times = [];
        var winds = [];
        var colors = [];
        for (var i = 0; i < history.length; i++) {
            times.push(history[i].time);
            winds.push(history[i].vmax_kt);
            var cat = windToCategory(history[i].vmax_kt);
            colors.push(SS_COLORS[cat]);
        }

        var trace = {
            x: times,
            y: winds,
            type: 'scatter',
            mode: 'lines+markers',
            line: { color: '#2e7dff', width: 2 },
            marker: { color: colors, size: 5 }
        };

        var layout = {
            margin: { t: 8, r: 10, b: 36, l: 42 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            xaxis: {
                gridcolor: 'rgba(255,255,255,0.04)',
                tickfont: { size: 9, color: '#8b9ec2', family: 'JetBrains Mono' },
                tickformat: '%m/%d %Hz'
            },
            yaxis: {
                title: { text: 'Vmax (kt)', font: { size: 10, color: '#8b9ec2' } },
                gridcolor: 'rgba(255,255,255,0.04)',
                tickfont: { size: 9, color: '#8b9ec2', family: 'JetBrains Mono' }
            },
            // SS category shading bands
            shapes: [
                { type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 34,  y1: 64,  fillcolor: 'rgba(52,211,153,0.06)', line: { width: 0 } },
                { type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 64,  y1: 83,  fillcolor: 'rgba(251,191,36,0.06)',  line: { width: 0 } },
                { type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 83,  y1: 96,  fillcolor: 'rgba(251,146,60,0.06)',  line: { width: 0 } },
                { type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 96,  y1: 113, fillcolor: 'rgba(248,113,113,0.06)', line: { width: 0 } },
                { type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 113, y1: 137, fillcolor: 'rgba(239,68,68,0.06)',   line: { width: 0 } },
                { type: 'rect', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: 137, y1: 200, fillcolor: 'rgba(220,38,38,0.06)',   line: { width: 0 } }
            ]
        };

        var config = {
            displayModeBar: false,
            responsive: true
        };

        Plotly.newPlot(chartEl, [trace], layout, config);
    }

    // ═══════════════════════════════════════════════════════════
    //  IR VIGOR PRODUCT
    // ═══════════════════════════════════════════════════════════

    /** Switch between product modes: 'eir', 'geocolor', 'vigor' */
    function setProductMode(mode) {
        var prevMode = productMode;
        productMode = mode;
        vigorMode = (mode === 'vigor');

        // Update toggle button active states
        var eirBtn = document.getElementById('ir-product-eir');
        var geoBtn = document.getElementById('ir-product-geocolor');
        var vigBtn = document.getElementById('ir-product-vigor');
        if (eirBtn) eirBtn.classList.toggle('ir-product-active', mode === 'eir');
        if (geoBtn) geoBtn.classList.toggle('ir-product-active', mode === 'geocolor');
        if (vigBtn) vigBtn.classList.toggle('ir-product-active', mode === 'vigor');

        // Show/hide legends
        var vigorLeg = document.getElementById('ir-vigor-legend');
        var tbLeg = document.getElementById('ir-tb-legend');
        if (vigorLeg) vigorLeg.style.display = (mode === 'vigor') ? 'block' : 'none';
        if (tbLeg) tbLeg.style.display = (mode === 'eir') ? 'block' : 'none';

        // --- Deactivate previous mode ---
        if (prevMode === 'eir') {
            hideAllAnimFrames();
            stopAnimation();
        } else if (prevMode === 'geocolor') {
            hideAllGeocolorFrames();
            stopAnimation();
        } else if (prevMode === 'vigor') {
            removeVigorLayer();
        }

        // --- Activate new mode ---
        if (mode === 'eir') {
            // Restore IR slider state
            var slider = document.getElementById('ir-anim-slider');
            if (slider && validFrames.length > 0) {
                slider.max = validFrames.length - 1;
                var pos = -1;
                for (var vi = 0; vi < validFrames.length; vi++) {
                    if (validFrames[vi] === animIndex) { pos = vi; break; }
                }
                if (pos < 0) pos = validFrames.length - 1;
                slider.value = pos;
            }
            if (animFrameLayers.length > 0 && framesReady) {
                showFrame(animIndex);
            }
            var playBtn = document.getElementById('ir-anim-play');
            if (playBtn) playBtn.disabled = !framesReady;
            updateFrameOverlay();
            updateAnimCounter();
        } else if (mode === 'geocolor') {
            loadGeocolorFrames();
        } else if (mode === 'vigor') {
            hideAllAnimFrames();
            hideAllGeocolorFrames();
            stopAnimation();
            fetchAndShowVigor();
        }
    }

    /** Backward-compatible wrapper for vigor toggle */
    function setVigorMode(enabled) {
        setProductMode(enabled ? 'vigor' : 'eir');
    }

    /** Hide all IR animation frame layers */
    function hideAllAnimFrames() {
        for (var i = 0; i < animFrameLayers.length; i++) {
            animFrameLayers[i].setOpacity(0);
        }
    }

    // ── Raw Tb pre-fetch cache (per-storm, keyed by ATCF ID) ──
    var _rawTbCache = {};  // { atcfId: { rawTbFrames: [...], cachedAt: ms } }
    var RAW_TB_CACHE_TTL_MS = POLL_INTERVAL_MS;  // invalidate after one poll cycle

    /**
     * Pre-fetch raw Tb frames for ALL active storms on page load.
     * Fires sequentially (one storm at a time) to avoid hammering the API.
     * Cached data is used by _prefetchRawTbSilent() / fetchRawTbFrames()
     * when the user clicks into a storm detail view.
     */
    var MAX_PREFETCH_STORMS = 3;  // limit background prefetch to avoid bandwidth waste

    function _prefetchAllStormsRawTb(storms) {
        if (!storms || storms.length === 0) return;
        // Skip background prefetch while user is viewing a detail (prioritize foreground).
        // Also defer briefly so deep-link handling can set currentStormId first.
        if (currentStormId) return;
        // Double-check after a microtask to catch deep-link race
        setTimeout(function () { _prefetchAllStormsRawTbInner(storms); }, 0);
    }

    function _prefetchAllStormsRawTbInner(storms) {
        if (currentStormId) return;
        // Only prefetch the strongest storms (highest vmax_kt), capped at MAX_PREFETCH_STORMS
        var sorted = storms.slice().sort(function (a, b) {
            return (b.vmax_kt || 0) - (a.vmax_kt || 0);
        });
        var queue = sorted.slice(0, MAX_PREFETCH_STORMS);
        function fetchNext() {
            if (queue.length === 0) return;
            // Abort if user opened a detail view while prefetch was running
            if (currentStormId) return;
            var storm = queue.shift();
            var atcfId = storm.atcf_id;
            var cached = _rawTbCache[atcfId];
            if (!atcfId || (cached && (Date.now() - cached.cachedAt) < RAW_TB_CACHE_TTL_MS)) { fetchNext(); return; }
            _fetchRawTbIncremental(atcfId, true, function () {
                console.log('[IR Pre-fetch] ' + atcfId + ': done (' +
                    ((_rawTbCache[atcfId] || {}).rawTbFrames || []).length + ' frames)');
                fetchNext();
            });
        }
        fetchNext();
    }

    // ── Cached GIBS tile layers for switching back from raw Tb ──
    var _gibsAnimFrameLayers = null;  // stashed GIBS tile layers

    /**
     * Silently populate rawTbFrames[] from the per-storm cache (or fetch).
     * Does NOT switch the display — GIBS tiles remain active.
     * When the user later selects a non-GIBS colormap, rawTbFrames[]
     * are immediately available for recoloring without another API call.
     */
    /**
     * Fetch raw Tb frames incrementally (one at a time) using the
     * /ir-raw-frame endpoint.  Each frame is fetched individually so
     * partial results are available immediately and Cloud Run doesn't
     * time out trying to generate all 13 frames in one request.
     *
     * @param {string} stormId - ATCF ID
     * @param {boolean} silent - if true, don't update loading UI
     * @param {function} onComplete - called when all frames are loaded
     */
    function _fetchRawTbIncremental(stormId, silent, onComplete) {
        if (!stormId) return;

        // Use cache if available and not expired
        var cached = _rawTbCache[stormId];
        if (cached && cached.rawTbFrames && cached.rawTbFrames.length > 0 &&
            (Date.now() - cached.cachedAt) < RAW_TB_CACHE_TTL_MS) {
            if (stormId === currentStormId) {
                rawTbFrames = cached.rawTbFrames;
            }
            console.log('[RT Monitor] Loaded ' + cached.rawTbFrames.length + ' raw Tb frames from cache for ' + stormId);
            if (onComplete) onComplete();
            return;
        }

        var totalFrames = 13;  // will be updated from first response
        var loadedFrames = [];
        var completed = 0;
        var failed = 0;
        var concurrency = 3;   // fetch 3 frames in parallel

        function fetchFrame(idx) {
            if (idx >= totalFrames) return;
            if (stormId !== currentStormId && !silent) return;  // storm changed

            var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(stormId) + '/ir-raw-frame'
                + '?frame_index=' + idx
                + '&lookback_hours=' + DEFAULT_LOOKBACK_HOURS
                + '&radius_deg=' + DEFAULT_RADIUS_DEG
                + '&interval_min=30';

            fetch(url, { cache: 'no-store' })
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(function (frame) {
                    if (frame.total_frames) totalFrames = frame.total_frames;

                    loadedFrames[idx] = {
                        tb_data: decodeTbData(frame.tb_data),
                        rows: frame.tb_rows,
                        cols: frame.tb_cols,
                        bounds: frame.bounds
                    };
                    completed++;

                    if (!silent) {
                        showLoadingProgress(true, Math.round(100 * completed / totalFrames));
                    }
                    console.log('[RT Monitor] Raw Tb frame ' + idx + '/' + totalFrames +
                        ' (' + frame.tb_cols + 'x' + frame.tb_rows + ' px)');
                })
                .catch(function (err) {
                    console.warn('[RT Monitor] Frame ' + idx + ' failed:', err.message);
                    failed++;
                    completed++;
                })
                .finally(function () {
                    // Launch next frame beyond the initial concurrent batch
                    var nextIdx = idx + concurrency;
                    if (nextIdx < totalFrames) fetchFrame(nextIdx);

                    // All done?
                    if (completed >= totalFrames) {
                        // Compact: remove holes from failed frames
                        var result = [];
                        for (var i = 0; i < totalFrames; i++) {
                            if (loadedFrames[i]) result.push(loadedFrames[i]);
                        }
                        _rawTbCache[stormId] = { rawTbFrames: result, cachedAt: Date.now() };
                        // Only update the global rawTbFrames if this is
                        // the storm currently being viewed
                        if (stormId === currentStormId) {
                            rawTbFrames = result;
                        }
                        console.log('[RT Monitor] All raw Tb frames loaded for ' +
                            stormId + ': ' + result.length + ' OK, ' + failed + ' failed');
                        if (onComplete) onComplete();
                    }
                });
        }

        // Launch initial batch of concurrent fetches
        for (var i = 0; i < Math.min(concurrency, totalFrames); i++) {
            fetchFrame(i);
        }
    }

    function _prefetchRawTbSilent() {
        _fetchRawTbIncremental(currentStormId, true, null);
    }

    /** Fetch raw Tb frames from API and switch to client-side rendering */
    /** Build L.imageOverlay layers from rawTbFrames[] and switch display */
    function _applyRawTbToMap() {
        // Stash current GIBS tile layers (only on first switch)
        if (!_gibsAnimFrameLayers && animFrameLayers.length > 0) {
            // Check if current layers are GIBS tiles (not RawTbTileLayers)
            var isGibs = !animFrameLayers[0].updateColormap;
            if (isGibs) {
                _gibsAnimFrameLayers = animFrameLayers.slice();
                for (var i = 0; i < _gibsAnimFrameLayers.length; i++) {
                    _gibsAnimFrameLayers[i].setOpacity(0);
                }
            }
        }

        // Remove any existing raw Tb tile layers from the map
        for (var i = 0; i < animFrameLayers.length; i++) {
            if (animFrameLayers[i] && animFrameLayers[i].updateColormap && detailMap) {
                detailMap.removeLayer(animFrameLayers[i]);
            }
        }

        // Create canvas tile layers from rawTbFrames
        var newLayers = [];
        for (var i = 0; i < rawTbFrames.length; i++) {
            var frame = rawTbFrames[i];
            var overlay = new RawTbTileLayer(
                frame.tb_data, frame.rows, frame.cols,
                frame.bounds, irSelectedColormap,
                { opacity: 0, pane: 'tilePane', className: 'ir-raw-overlay' }
            );
            overlay.addTo(detailMap);
            newLayers.push(overlay);
        }

        // Replace animFrameLayers with raw overlays
        animFrameLayers = newLayers;
        validFrames = [];
        for (var vi = 0; vi < newLayers.length; vi++) { validFrames.push(vi); }
        framesReady = true;
        animIndex = newLayers.length - 1;

        var slider = document.getElementById('ir-anim-slider');
        if (slider) {
            slider.max = validFrames.length - 1;
            slider.value = validFrames.length - 1;
        }

        showFrame(animIndex);
        showLoadingProgress(false);
        renderDetailColorbar();

        // Switch colorbar to canvas rendering
        var gradBar = document.getElementById('ir-tb-legend-bar-gradient');
        var canvasBar = document.getElementById('ir-tb-colorbar-canvas');
        if (gradBar) gradBar.style.display = 'none';
        if (canvasBar) canvasBar.style.display = '';

        var playBtn = document.getElementById('ir-anim-play');
        if (playBtn) playBtn.disabled = false;

        if (_rtModelVisible && _rtModelAutoSync && _rtModelData) {
            _rtSyncModelCycleToIR();
        }
    }

    /** Fetch raw Tb frames from API (or cache) and switch to client-side rendering */
    function fetchRawTbFrames() {
        if (!currentStormId) return;
        showLoadingProgress(true, 0);

        // Use pre-fetched cache if available
        if (rawTbFrames.length > 0) {
            _applyRawTbToMap();
            return;
        }
        var cached = _rawTbCache[currentStormId];
        if (cached && cached.rawTbFrames && cached.rawTbFrames.length > 0) {
            rawTbFrames = cached.rawTbFrames;
            _applyRawTbToMap();
            return;
        }

        // Fetch frames incrementally
        _fetchRawTbIncremental(currentStormId, false, function () {
            if (rawTbFrames.length > 0) {
                _applyRawTbToMap();
            } else {
                console.warn('[RT Monitor] No raw Tb frames loaded');
                showLoadingProgress(false);
                var cmapSelect = document.getElementById('ir-colormap-select');
                if (cmapSelect) cmapSelect.value = 'gibs';
            }
        });
    }

    /** Switch back to GIBS tile layers from raw Tb overlays */
    function switchToGIBSTiles() {
        // Remove raw Tb overlays from map
        for (var i = 0; i < animFrameLayers.length; i++) {
            if (animFrameLayers[i] && detailMap) {
                detailMap.removeLayer(animFrameLayers[i]);
            }
        }
        rawTbFrames = [];

        // Restore stashed GIBS tile layers
        if (_gibsAnimFrameLayers) {
            animFrameLayers = _gibsAnimFrameLayers;
            _gibsAnimFrameLayers = null;

            // Restore valid frames and show current frame
            validFrames = [];
            for (var i = 0; i < animFrameLayers.length; i++) {
                if (!frameHasError[i]) validFrames.push(i);
            }
            if (validFrames.length > 0) {
                animIndex = validFrames[validFrames.length - 1];
                showFrame(animIndex);
            }

            var slider = document.getElementById('ir-anim-slider');
            if (slider) {
                slider.max = validFrames.length - 1;
                slider.value = validFrames.length - 1;
            }
        }
    }

    /** Hide all GeoColor animation frame layers */
    function hideAllGeocolorFrames() {
        for (var i = 0; i < geocolorFrameLayers.length; i++) {
            geocolorFrameLayers[i].setOpacity(0);
        }
    }

    /** Clean up GeoColor frame layers from the map */
    function cleanupGeocolorFrameLayers() {
        for (var i = 0; i < geocolorFrameLayers.length; i++) {
            if (detailMap && geocolorFrameLayers[i]) {
                detailMap.removeLayer(geocolorFrameLayers[i]);
            }
        }
        geocolorFrameLayers = [];
        geocolorFrameTimes = [];
        geocolorValidFrames = [];
        geocolorFrameHasError = [];
        geocolorFramesLoaded = 0;
        geocolorFramesReady = false;
    }

    /** Remove the vigor image overlay from the map */
    function removeVigorLayer() {
        if (vigorLayer && detailMap) {
            detailMap.removeLayer(vigorLayer);
            vigorLayer = null;
        }
    }

    /** Load GeoColor animation frames lazily (only when user switches to GeoColor mode).
     *  Uses same frame times as IR but with GeoColor/visible GIBS layers. */
    function loadGeocolorFrames() {
        if (!detailMap || !currentStormId) return;

        // If already loaded, just restore slider and show the current frame
        if (geocolorFramesReady && geocolorFrameLayers.length > 0) {
            var slider = document.getElementById('ir-anim-slider');
            if (slider && geocolorValidFrames.length > 0) {
                slider.max = geocolorValidFrames.length - 1;
                slider.value = geocolorValidFrames.length - 1;
            }
            var playBtn = document.getElementById('ir-anim-play');
            if (playBtn) playBtn.disabled = false;
            showGeocolorFrame(geocolorValidFrames.length > 0
                ? geocolorValidFrames[geocolorValidFrames.length - 1]
                : geocolorFrameLayers.length - 1);
            updateAnimCounter();
            return;
        }

        // If already loading, skip
        if (geocolorFrameLayers.length > 0 && !geocolorFramesReady) return;

        // Determine layer strategy
        var hasNativeGeoColor = !!GIBS_GEOCOLOR_LAYERS[detailSatName];
        var visLayerName = GIBS_GEOCOLOR_LAYERS[detailSatName] || GIBS_VIS_LAYERS[detailSatName];
        var irLayerName = GIBS_IR_LAYERS[detailSatName] || null;
        if (!visLayerName) {
            showVigorToast('No visible imagery available for ' + detailSatName);
            setProductMode('eir');
            return;
        }

        // Use the same frame times as IR
        geocolorFrameTimes = animFrameTimes.slice();
        geocolorFramesLoaded = 0;
        geocolorFramesReady = false;
        geocolorValidFrames = [];
        geocolorFrameHasError = [];

        // Show loading state on the GeoColor button
        var geoBtn = document.getElementById('ir-product-geocolor');
        if (geoBtn) {
            geoBtn.classList.add('ir-vigor-loading');
            geoBtn.textContent = 'Loading\u2026';
        }
        showLoadingProgress(true, 0);

        // Update satellite label — always "GeoColor" regardless of satellite
        var satLabel = document.getElementById('ir-satellite-label');
        if (satLabel) {
            satLabel.textContent = 'GeoColor \u2014 ' + detailSatName;
        }

        // Pre-create ALL GeoColor frame tile layers (hidden at opacity 0).
        // For satellites with native GeoColor (GOES): use createGIBSLayerVis.
        // For satellites without (Himawari): per-frame day/night switching —
        //   daytime → Red Visible tiles,  nighttime → Clean IR tiles (grayscale).
        for (var i = 0; i < geocolorFrameTimes.length; i++) {
            var timeStr = geocolorFrameTimes[i];
            var lyr;
            if (hasNativeGeoColor) {
                // GOES: use native GeoColor layer (handles day/night internally)
                lyr = createGIBSLayerVis(visLayerName, timeStr, 0, null);
            } else {
                // Himawari: choose visible or IR based on solar elevation
                var sunElev = solarElevation(detailStormLat, detailStormLon, new Date(timeStr));
                if (sunElev > -6) {
                    // Daytime / civil twilight: use visible tiles (Level7)
                    lyr = createGIBSLayerVis(visLayerName, timeStr, 0, null);
                } else {
                    // Nighttime: use clean IR tiles (grayscale, Level6)
                    lyr = createGIBSLayer(irLayerName, timeStr, 0);
                }
            }
            lyr.addTo(detailMap);
            geocolorFrameHasError.push(false);

            (function (layer, idx) {
                layer.on('tileerror', function () {
                    geocolorFrameHasError[idx] = true;
                });
                layer.on('load', function () {
                    onGeocolorFrameLoaded(idx);
                });
            })(lyr, i);

            geocolorFrameLayers.push(lyr);
        }

        // Safety timeout
        setTimeout(function () {
            if (!geocolorFramesReady && geocolorFrameLayers.length > 0 && productMode === 'geocolor') {
                console.warn('[RT Monitor] GeoColor preload timeout — enabling with ' + geocolorFramesLoaded + '/' + geocolorFrameTimes.length + ' frames');
                geocolorFramesReady = true;
                showLoadingProgress(false);
                if (geoBtn) {
                    geoBtn.classList.remove('ir-vigor-loading');
                    geoBtn.textContent = 'GeoColor';
                }
                var playBtn = document.getElementById('ir-anim-play');
                if (playBtn) playBtn.disabled = false;
                var slider = document.getElementById('ir-anim-slider');
                if (slider && geocolorValidFrames.length > 0) {
                    slider.max = geocolorValidFrames.length - 1;
                    slider.value = geocolorValidFrames.length - 1;
                    showGeocolorFrame(geocolorValidFrames[geocolorValidFrames.length - 1]);
                }
                updateAnimCounter();
            }
        }, 30000);
    }

    /** Called when a GeoColor frame tile layer finishes loading */
    function onGeocolorFrameLoaded(idx) {
        geocolorFramesLoaded++;
        if (!geocolorFrameHasError[idx]) {
            geocolorValidFrames.push(idx);
            geocolorValidFrames.sort(function (a, b) { return a - b; });
        }

        var total = geocolorFrameTimes.length;
        var pct = Math.round((geocolorFramesLoaded / total) * 100);
        showLoadingProgress(true, pct);

        if (geocolorFramesLoaded >= total) {
            geocolorFramesReady = true;
            showLoadingProgress(false);
            var geoBtn = document.getElementById('ir-product-geocolor');
            if (geoBtn) {
                geoBtn.classList.remove('ir-vigor-loading');
                geoBtn.textContent = 'GeoColor';
            }

            var playBtn = document.getElementById('ir-anim-play');
            if (playBtn) playBtn.disabled = false;

            // Update slider for GeoColor valid frames
            var slider = document.getElementById('ir-anim-slider');
            if (slider && geocolorValidFrames.length > 0) {
                slider.max = geocolorValidFrames.length - 1;
                slider.value = geocolorValidFrames.length - 1;
            }

            // Show last frame if still in GeoColor mode
            if (productMode === 'geocolor' && geocolorValidFrames.length > 0) {
                showGeocolorFrame(geocolorValidFrames[geocolorValidFrames.length - 1]);
            }
            updateAnimCounter();
        }
    }

    /** Show a specific GeoColor frame by toggling opacity */
    function showGeocolorFrame(idx) {
        if (idx < 0 || idx >= geocolorFrameLayers.length || !detailMap) return;

        // Hide all GeoColor frames
        for (var i = 0; i < geocolorFrameLayers.length; i++) {
            geocolorFrameLayers[i].setOpacity(0);
        }

        // Show the requested frame
        animIndex = idx;
        geocolorFrameLayers[idx].setOpacity(0.92);

        // Update overlay info
        if (geocolorFrameTimes[idx]) {
            document.getElementById('ir-frame-time').textContent = fmtUTC(geocolorFrameTimes[idx]);
        }
        document.getElementById('ir-satellite-label').textContent =
            'GeoColor \u2014 ' + detailSatName;

        // Sync model overlay to new frame time
        if (_rtModelVisible && _rtModelAutoSync && _rtModelData) {
            _rtSyncModelCycleToIR();
        }
    }

    // ── Client-Side Vigor Computation Helpers ────────────────

    /** Convert GIBS Clean IR pixel → approximate Tb (Kelvin).
     *  Uses the pre-computed 3D reverse LUT for O(1) nearest-colour lookup.
     *  Handles both the grayscale (warm) and enhanced-colour (cold) regions. */
    function gibsPixelToTb(r, g, b) {
        var ri = r >> GIBS_REV_SHIFT;
        var gi = g >> GIBS_REV_SHIFT;
        var bi = b >> GIBS_REV_SHIFT;
        var idx = GIBS_REV_LUT[(ri * GIBS_REV_Q + gi) * GIBS_REV_Q + bi];
        return GIBS_FWD_LUT.tb[idx];
    }

    /** Read pixel data from all visible tiles in a GridLayer.
     *  Returns { tiles: { 'z:x:y': { tb: Float32Array, w, h, coords } }, tileKeys: [] } */
    function extractTbFromLayer(layer) {
        var tiles = layer._tiles;
        var result = {};
        var keys = [];
        if (!tiles) return { tiles: result, tileKeys: keys };
        for (var key in tiles) {
            if (!tiles.hasOwnProperty(key)) continue;
            var tile = tiles[key];
            if (!tile.el || !tile.current) continue;
            var canvas = tile.el;
            try {
                var ctx = canvas.getContext('2d');
                var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                var pixels = imgData.data;
                var n = canvas.width * canvas.height;
                var tb = new Float32Array(n);
                for (var i = 0; i < n; i++) {
                    var off = i * 4;
                    if (pixels[off + 3] < 128) {
                        tb[i] = NaN;
                    } else {
                        tb[i] = gibsPixelToTb(pixels[off], pixels[off + 1], pixels[off + 2]);
                    }
                }
                result[key] = { tb: tb, w: canvas.width, h: canvas.height, coords: tile.coords };
                keys.push(key);
            } catch (e) {
                // Cross-origin canvas or empty tile — skip
            }
        }
        return { tiles: result, tileKeys: keys };
    }

    /** Stitch tile Tb arrays into a single large 2D array.
     *  Returns { tb: Float32Array, w, h, bounds: {south,north,west,east}, tileW, tileH, grid } */
    function stitchTileTb(tileData) {
        var tiles = tileData.tiles;
        var keys = tileData.tileKeys;
        if (keys.length === 0) return null;

        // Find bounding tile coords
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        var zoom = 0, tileW = 256, tileH = 256;
        for (var i = 0; i < keys.length; i++) {
            var t = tiles[keys[i]];
            var c = t.coords;
            zoom = c.z;
            tileW = t.w;
            tileH = t.h;
            if (c.x < minX) minX = c.x;
            if (c.x > maxX) maxX = c.x;
            if (c.y < minY) minY = c.y;
            if (c.y > maxY) maxY = c.y;
        }

        var gridW = maxX - minX + 1;
        var gridH = maxY - minY + 1;
        var totalW = gridW * tileW;
        var totalH = gridH * tileH;
        var stitched = new Float32Array(totalW * totalH);
        stitched.fill(NaN);

        // Place each tile's data
        for (var i = 0; i < keys.length; i++) {
            var t = tiles[keys[i]];
            var c = t.coords;
            var ox = (c.x - minX) * tileW;
            var oy = (c.y - minY) * tileH;
            for (var row = 0; row < t.h; row++) {
                for (var col = 0; col < t.w; col++) {
                    stitched[(oy + row) * totalW + (ox + col)] = t.tb[row * t.w + col];
                }
            }
        }

        // Compute geographic bounds (Web Mercator tile → lat/lon)
        var n = Math.pow(2, zoom);
        var west = minX / n * 360 - 180;
        var east = (maxX + 1) / n * 360 - 180;
        // Y → lat via Mercator inverse
        var north = Math.atan(Math.sinh(Math.PI * (1 - 2 * minY / n))) * 180 / Math.PI;
        var south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (maxY + 1) / n))) * 180 / Math.PI;

        return {
            tb: stitched, w: totalW, h: totalH,
            bounds: { south: south, north: north, west: west, east: east },
            tileW: tileW, tileH: tileH,
            grid: { minX: minX, maxX: maxX, minY: minY, maxY: maxY, zoom: zoom }
        };
    }

    /** Compute pixel-wise temporal average across multiple stitched Tb frames.
     *  All frames must have the same dimensions. */
    function temporalAvgTb(stitchedFrames) {
        if (stitchedFrames.length === 0) return null;
        var ref = stitchedFrames[0];
        var n = ref.w * ref.h;
        var sum = new Float32Array(n);
        var cnt = new Uint8Array(n);

        for (var f = 0; f < stitchedFrames.length; f++) {
            var tb = stitchedFrames[f].tb;
            for (var i = 0; i < n; i++) {
                if (!isNaN(tb[i])) {
                    sum[i] += tb[i];
                    cnt[i]++;
                }
            }
        }
        var avg = new Float32Array(n);
        for (var i = 0; i < n; i++) {
            avg[i] = cnt[i] > 0 ? sum[i] / cnt[i] : NaN;
        }
        return { tb: avg, w: ref.w, h: ref.h, bounds: ref.bounds, grid: ref.grid, tileW: ref.tileW, tileH: ref.tileH };
    }

    /** Separable 2D spatial minimum filter.
     *  Operates on a flat Float32Array of size w×h with given pixel radius.
     *  NaN pixels are skipped; if an entire window is NaN the output is NaN. */
    function spatialMinFilter(tb, w, h, radius) {
        var n = w * h;
        var temp = new Float32Array(n);
        var out = new Float32Array(n);

        // Horizontal pass
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var minVal = Infinity;
                var x0 = Math.max(0, x - radius);
                var x1 = Math.min(w - 1, x + radius);
                for (var xx = x0; xx <= x1; xx++) {
                    var v = tb[y * w + xx];
                    if (!isNaN(v) && v < minVal) minVal = v;
                }
                temp[y * w + x] = (minVal === Infinity) ? NaN : minVal;
            }
        }

        // Vertical pass
        for (var x = 0; x < w; x++) {
            for (var y = 0; y < h; y++) {
                var minVal = Infinity;
                var y0 = Math.max(0, y - radius);
                var y1 = Math.min(h - 1, y + radius);
                for (var yy = y0; yy <= y1; yy++) {
                    var v = temp[yy * w + x];
                    if (!isNaN(v) && v < minVal) minVal = v;
                }
                out[y * w + x] = (minVal === Infinity) ? NaN : minVal;
            }
        }
        return out;
    }

    /** Map a vigor value (K) to RGBA using the pre-built LUT */
    function vigorToRGBA(vigor) {
        if (isNaN(vigor)) return [0, 0, 0, 0];
        var frac = (vigor - VIGOR_VMIN) / (VIGOR_VMAX - VIGOR_VMIN);
        frac = Math.max(0, Math.min(1, frac));
        var idx = Math.round(frac * 255);
        return [VIGOR_LUT[idx * 4], VIGOR_LUT[idx * 4 + 1], VIGOR_LUT[idx * 4 + 2], VIGOR_LUT[idx * 4 + 3]];
    }

    /** Compute client-side vigor from pre-loaded animation frame tile canvases.
     *  vigor = current_Tb − domain_min(temporal_avg_Tb)
     *
     *  The reference is the DOMAIN-WIDE minimum of the temporal-average Tb —
     *  a single scalar representing the coldest persistent convection in the
     *  entire storm system.  This means only the CDO core (where current Tb
     *  is colder than the coldest time-averaged point) can go negative.
     *  Most grid points will be positive (warmer than the CDO reference). */
    function computeClientVigor() {
        if (!detailMap || animFrameLayers.length === 0 || validFrames.length === 0) return null;

        console.time('[Vigor] total computation');

        // Use only the latest valid frame — no temporal averaging needed.
        // This avoids the storm-following problem: a fixed Eulerian grid
        // smears the CDO when computing temporal averages because the storm
        // translates through the domain over the lookback window.
        var latestIdx = validFrames[validFrames.length - 1];
        var layer = animFrameLayers[latestIdx];
        var tileData = extractTbFromLayer(layer);
        var stitched = stitchTileTb(tileData);
        if (!stitched) {
            console.warn('[Vigor] Could not extract Tb from latest frame');
            return null;
        }

        console.log('[Vigor] Stitched size:', stitched.w, '×', stitched.h);

        // 1. Collect all convective pixels (Tb < -20°C / 253.15 K)
        var coldPixels = [];
        for (var j = 0; j < stitched.tb.length; j++) {
            var t = stitched.tb[j];
            if (!isNaN(t) && t < VIGOR_TB_THRESHOLD) {
                coldPixels.push(t);
            }
        }

        if (coldPixels.length < 20) {
            console.warn('[Vigor] Too few cold pixels:', coldPixels.length);
            return null;
        }

        // 2. Find the 5th percentile of cold-pixel Tb (the coldest 5% of
        //    convective cloud tops).  This is the vigor reference — robust to
        //    single-pixel noise unlike an absolute minimum.
        coldPixels.sort(function (a, b) { return a - b; });
        var p05idx = Math.floor(coldPixels.length * 0.05);
        var p05 = coldPixels[p05idx];

        console.log('[Vigor] Cold pixels:', coldPixels.length,
                     '| P05 Tb:', p05.toFixed(1), 'K (' + (p05 - 273.15).toFixed(1) + '°C)',
                     '| Min Tb:', coldPixels[0].toFixed(1), 'K');

        // 3. Compute vigor: current_Tb − P05(cold_Tb)
        //    - Negative → colder than the 5th percentile (overshooting tops,
        //      vigorous convective cores)
        //    - Near zero → among the coldest sustained convection (CDO core)
        //    - Positive → warmer than the coldest convection (thinning anvil,
        //      outer rain bands, warming CDO)
        //    Warm pixels (Tb >= threshold) are masked out.
        var vigorArr = new Float32Array(stitched.w * stitched.h);
        for (var i = 0; i < vigorArr.length; i++) {
            var curTb = stitched.tb[i];
            if (isNaN(curTb) || curTb >= VIGOR_TB_THRESHOLD) {
                vigorArr[i] = NaN;
            } else {
                vigorArr[i] = curTb - p05;
            }
        }

        console.timeEnd('[Vigor] total computation');

        return {
            vigor: vigorArr,
            w: stitched.w,
            h: stitched.h,
            bounds: stitched.bounds,
            grid: stitched.grid,
            tileW: stitched.tileW,
            tileH: stitched.tileH,
            framesUsed: 1,
            datetime_utc: animFrameTimes[latestIdx]
        };
    }

    /** Compute vigor and display as tile overlay (called when vigor mode is activated) */
    function fetchAndShowVigor() {
        if (!currentStormId || !detailMap) return;

        // Check cache first
        if (vigorCache[currentStormId]) {
            showVigorOverlay(vigorCache[currentStormId]);
            return;
        }

        if (!framesReady || validFrames.length < 1) {
            showVigorToast('IR Vigor requires at least 1 loaded animation frame. Please wait for frames to load.');
            setVigorMode(false);
            return;
        }

        // Show loading state
        var vigBtn = document.getElementById('ir-product-vigor');
        if (vigBtn) {
            vigBtn.classList.add('ir-vigor-loading');
            vigBtn.textContent = 'Computing\u2026';
        }
        vigorFetching = true;

        // Run computation asynchronously (setTimeout to allow UI update)
        setTimeout(function () {
            try {
                var result = computeClientVigor();
                vigorFetching = false;

                if (vigBtn) {
                    vigBtn.classList.remove('ir-vigor-loading');
                    vigBtn.textContent = 'IR Vigor';
                }

                if (!result) {
                    showVigorToast('IR Vigor computation failed — not enough tile data available.');
                    setVigorMode(false);
                    return;
                }

                vigorCache[currentStormId] = result;

                if (vigorMode) {
                    showVigorOverlay(result);
                }

                _ga('ir_vigor_loaded', {
                    atcf_id: currentStormId,
                    frames_used: result.framesUsed
                });
            } catch (err) {
                console.warn('[RT Monitor] Vigor computation error:', err);
                vigorFetching = false;
                if (vigBtn) {
                    vigBtn.classList.remove('ir-vigor-loading');
                    vigBtn.textContent = 'IR Vigor';
                }
                showVigorToast('IR Vigor computation failed: ' + err.message);
                setVigorMode(false);
            }
        }, 50);
    }

    /** Show a temporary toast message */
    function showVigorToast(msg) {
        var toast = document.createElement('div');
        toast.textContent = msg;
        toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(180,80,20,0.95);color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;z-index:10000;max-width:500px;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.4);';
        document.body.appendChild(toast);
        setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 6000);
    }

    /** Render the computed vigor data as a canvas-based Leaflet ImageOverlay.
     *  The vigor array is painted into an offscreen canvas at full tile resolution,
     *  then displayed as an image overlay with proper geographic bounds.
     *  This scales naturally with zoom (Leaflet handles the CSS transform). */
    function showVigorOverlay(data) {
        removeVigorLayer();
        if (!detailMap || !data.vigor || !data.bounds) return;

        var vigorArr = data.vigor;
        var vw = data.w;
        var vh = data.h;
        var bnd = data.bounds;

        // Render vigor into an offscreen canvas at full computed resolution
        var canvas = document.createElement('canvas');
        canvas.width = vw;
        canvas.height = vh;
        var ctx = canvas.getContext('2d');
        var imgData = ctx.createImageData(vw, vh);
        var pix = imgData.data;

        for (var i = 0; i < vigorArr.length; i++) {
            var v = vigorArr[i];
            if (isNaN(v)) continue;

            var frac = (v - VIGOR_VMIN) / (VIGOR_VMAX - VIGOR_VMIN);
            frac = Math.max(0, Math.min(1, frac));
            var idx = Math.round(frac * 255);
            var off = i * 4;
            pix[off]     = VIGOR_LUT[idx * 4];
            pix[off + 1] = VIGOR_LUT[idx * 4 + 1];
            pix[off + 2] = VIGOR_LUT[idx * 4 + 2];
            pix[off + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);

        // Convert canvas to data URL and create image overlay
        var dataUrl = canvas.toDataURL('image/png');
        var bounds = L.latLngBounds(
            L.latLng(bnd.south, bnd.west),
            L.latLng(bnd.north, bnd.east)
        );

        vigorLayer = L.imageOverlay(dataUrl, bounds, { opacity: 0.92 });
        vigorLayer.addTo(detailMap);

        // Use crisp rendering so individual pixels stay sharp when zoomed
        var imgEl = vigorLayer.getElement();
        if (imgEl) {
            imgEl.style.imageRendering = 'pixelated';
            imgEl.style.imageRendering = '-moz-crisp-edges';
        }

        // Update the overlay info label
        var satLabel = document.getElementById('ir-satellite-label');
        if (satLabel) satLabel.textContent = 'IR Vigor (' + data.framesUsed + ' frames)';
        var timeLabel = document.getElementById('ir-frame-time');
        if (timeLabel) timeLabel.textContent = fmtUTC(data.datetime_utc);
    }

    // ═══════════════════════════════════════════════════════════
    //  DEEP LINKING
    // ═══════════════════════════════════════════════════════════

    var deepLinkHandled = false;

    /** Check URL hash for a deep-linked storm */
    function handleDeepLink() {
        if (deepLinkHandled) return;
        var hash = window.location.hash.replace('#', '').trim();
        if (!hash) return;

        // Check if storm exists in current data
        for (var i = 0; i < stormData.length; i++) {
            if (stormData[i].atcf_id === hash) {
                deepLinkHandled = true;
                openStormDetail(hash);
                return;
            }
        }
        // Storm not in active list — could be expired; just stay on map
    }

    // ═══════════════════════════════════════════════════════════
    //  EVENT BINDING
    // ═══════════════════════════════════════════════════════════

    function bindEvents() {
        // Back button
        document.getElementById('ir-back-btn').addEventListener('click', function () {
            closeStormDetail();
        });

        // Animation controls
        document.getElementById('ir-anim-prev').addEventListener('click', function () {
            stopAnimation();
            prevFrame();
        });
        document.getElementById('ir-anim-play').addEventListener('click', togglePlay);
        document.getElementById('ir-anim-next').addEventListener('click', function () {
            stopAnimation();
            nextFrame();
        });
        document.getElementById('ir-anim-slider').addEventListener('input', function () {
            var state = activeFrameState();
            if (!state.ready) return;
            stopAnimation();
            var sliderPos = parseInt(this.value, 10);
            if (state.valid.length > 0 && sliderPos < state.valid.length) {
                state.showFn(state.valid[sliderPos]);
            }
            updateAnimCounter();
        });

        // Product toggle buttons (Enhanced IR / GeoColor / IR Vigor)
        document.getElementById('ir-product-eir').addEventListener('click', function () {
            if (productMode === 'eir') return;
            setProductMode('eir');
        });
        document.getElementById('ir-product-geocolor').addEventListener('click', function () {
            if (productMode === 'geocolor') return;
            setProductMode('geocolor');
        });
        document.getElementById('ir-product-vigor').addEventListener('click', function () {
            if (productMode === 'vigor' || vigorFetching) return;
            setProductMode('vigor');
        });

        // Colormap selector
        var cmapSelect = document.getElementById('ir-colormap-select');
        if (cmapSelect) {
            cmapSelect.addEventListener('change', function () {
                var val = cmapSelect.value;
                if (val === 'gibs') {
                    // Switch back to GIBS tiles
                    if (rawTbFrames.length > 0) {
                        switchToGIBSTiles();
                    }
                    // Show gradient bar, hide canvas
                    var gradBar = document.getElementById('ir-tb-legend-bar-gradient');
                    var canvasBar = document.getElementById('ir-tb-colorbar-canvas');
                    if (gradBar) gradBar.style.display = '';
                    if (canvasBar) canvasBar.style.display = 'none';
                } else {
                    irSelectedColormap = val;
                    if (rawTbFrames.length > 0) {
                        // Already have raw data — just re-render
                        recolorRawFrames();
                    } else {
                        // Need to fetch raw Tb data from API
                        fetchRawTbFrames();
                    }
                    // Show canvas bar, hide gradient bar
                    var gradBar = document.getElementById('ir-tb-legend-bar-gradient');
                    var canvasBar = document.getElementById('ir-tb-colorbar-canvas');
                    if (gradBar) gradBar.style.display = 'none';
                    if (canvasBar) canvasBar.style.display = '';
                    renderDetailColorbar();
                }
            });
        }

        // Browser back/forward
        window.addEventListener('popstate', function () {
            var hash = window.location.hash.replace('#', '').trim();
            if (hash && currentStormId !== hash) {
                openStormDetail(hash);
            } else if (!hash && currentStormId) {
                closeStormDetail();
            }
        });

        // Keyboard shortcuts (detail view)
        document.addEventListener('keydown', function (e) {
            if (!currentStormId) return;
            if (e.key === 'ArrowLeft')  { stopAnimation(); prevFrame(); }
            if (e.key === 'ArrowRight') { stopAnimation(); nextFrame(); }
            if (e.key === ' ')          { e.preventDefault(); togglePlay(); }
            if (e.key === 'Escape')     { closeStormDetail(); }
        });
    }

    // ═══════════════════════════════════════════════════════════
    //  INIT
    // ═══════════════════════════════════════════════════════════

    /** Global entry point called from popup buttons */
    window._irOpenStorm = function (atcfId) {
        openStormDetail(atcfId);
    };

    // ═══════════════════════════════════════════════════════════
    //  BASIN ACTIVITY SIDEBAR
    // ═══════════════════════════════════════════════════════════

    window.toggleBasinSidebar = function () {
        basinSidebarVisible = !basinSidebarVisible;
        var sidebar = document.getElementById('basin-sidebar');
        var toggle = document.getElementById('basin-sidebar-toggle');
        var mapEl = document.getElementById('ir-map');

        if (basinSidebarVisible) {
            sidebar.classList.add('open');
            toggle.classList.add('active');
            mapEl.classList.add('sidebar-open');
            // Fetch if we don't have data yet
            if (!seasonSummaryData) fetchSeasonSummary();
        } else {
            sidebar.classList.remove('open');
            toggle.classList.remove('active');
            mapEl.classList.remove('sidebar-open');
        }
        // Let Leaflet recalculate after CSS transition
        setTimeout(function () { if (map) map.invalidateSize(); }, 350);
        _ga('ir_basin_sidebar_toggle', { visible: basinSidebarVisible });
    };

    function fetchSeasonSummary() {
        fetch(API_BASE + '/ir-monitor/season-summary', { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                seasonSummaryData = data;
                renderBasinSidebar();
            })
            .catch(function (err) {
                console.warn('[RT Monitor] Season summary fetch failed:', err.message || '');
                var content = document.getElementById('basin-sidebar-content');
                if (content) content.innerHTML = '<div class="basin-sidebar-loading">Unable to load season data</div>';
            });
    }

    function renderBasinSidebar() {
        if (!seasonSummaryData) return;

        var yearEl = document.getElementById('basin-sidebar-year');
        if (yearEl) yearEl.textContent = seasonSummaryData.year;

        var climoLabel = document.getElementById('basin-sidebar-climo-label');
        if (climoLabel) climoLabel.textContent = 'Climatology: ' + (seasonSummaryData.climo_period || '1991-2020');

        var content = document.getElementById('basin-sidebar-content');
        if (!content) return;

        var basins = seasonSummaryData.basins || {};
        // Sort: active_now desc, then named_storms desc
        var keys = Object.keys(basins).sort(function (a, b) {
            var da = basins[a], db = basins[b];
            if (db.active_now !== da.active_now) return db.active_now - da.active_now;
            return db.named_storms - da.named_storms;
        });

        var html = '';
        for (var i = 0; i < keys.length; i++) {
            var basin = keys[i];
            var d = basins[basin];
            var color = BASIN_COLORS[basin] || '#64748b';
            var name = BASIN_NAMES[basin] || basin;

            // Skip basins with zero activity this season and no active storms
            if (d.named_storms === 0 && d.active_now === 0) continue;

            // Active badge
            var activeBadge = d.active_now > 0
                ? '<span class="basin-card-active">' + d.active_now + ' active</span>'
                : '<span class="basin-card-active none">quiet</span>';

            // ACE bar
            var acePct = d.climo_ace > 0 ? Math.round((d.ace / d.climo_ace) * 100) : 0;
            var aceBarWidth = Math.min(acePct, 150); // cap at 150% for display
            var aceColor = acePct >= 100 ? '#f87171' : acePct >= 75 ? '#fbbf24' : '#34d399';

            html += '<div class="basin-card" style="--basin-color:' + color + ';">' +
                '<div class="basin-card-header">' +
                    '<span class="basin-card-name">' + name + '</span>' +
                    activeBadge +
                '</div>' +
                '<div class="basin-card-stats">' +
                    '<div class="basin-stat">' +
                        '<div class="basin-stat-val">' + d.named_storms + '</div>' +
                        '<div class="basin-stat-label">Named</div>' +
                    '</div>' +
                    '<div class="basin-stat">' +
                        '<div class="basin-stat-val">' + d.hurricanes + '</div>' +
                        '<div class="basin-stat-label">Hurr</div>' +
                    '</div>' +
                    '<div class="basin-stat">' +
                        '<div class="basin-stat-val">' + d.major_hurricanes + '</div>' +
                        '<div class="basin-stat-label">Major</div>' +
                    '</div>' +
                '</div>' +
                '<div class="basin-ace-row">' +
                    '<span class="basin-ace-label">ACE ' + d.ace.toFixed(1) + '</span>' +
                    '<div class="basin-ace-bar">' +
                        '<div class="basin-ace-fill" style="width:' + aceBarWidth + '%;background:' + aceColor + ';"></div>' +
                    '</div>' +
                    '<span class="basin-ace-pct">' + acePct + '%</span>' +
                '</div>' +
            '</div>';
        }

        // If no basins have activity
        if (!html) {
            html = '<div class="basin-sidebar-loading">No tropical cyclone activity this season</div>';
        }

        content.innerHTML = html;
    }

    // ═══════════════════════════════════════════════════════════
    //  MODEL FORECAST OVERLAY (ATCF A-DECK)
    // ═══════════════════════════════════════════════════════════

    /**
     * Load model forecast data when a storm is selected.
     */
    function _rtLoadModelForecasts(storm) {
        var section = document.getElementById('rt-models-section');
        var statusEl = document.getElementById('rt-models-status');

        var atcfId = storm.atcf_id;
        if (!atcfId) {
            if (section) section.style.display = 'none';
            return;
        }
        if (section) section.style.display = '';

        // Skip if already loaded for this storm
        if (atcfId === _rtModelLastAtcf && _rtModelData) return;
        _rtModelLastAtcf = atcfId;
        _rtModelData = null;

        if (statusEl) statusEl.textContent = 'Loading...';

        fetch(API_BASE + '/global/adeck?atcf_id=' + encodeURIComponent(atcfId), { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) {
                _rtModelData = json;

                // Populate cycle dropdown
                var sel = document.getElementById('rt-model-cycle-select');
                if (sel) {
                    sel.innerHTML = '';
                    var inits = json.init_times || [];
                    for (var i = 0; i < inits.length; i++) {
                        var dt = inits[i];
                        var opt = document.createElement('option');
                        opt.value = dt;
                        opt.textContent = dt.substring(0,4) + '-' + dt.substring(4,6) + '-' +
                            dt.substring(6,8) + ' ' + dt.substring(8,10) + ' UTC';
                        sel.appendChild(opt);
                    }
                }

                if (statusEl) statusEl.textContent = json.n_cycles + ' cycles, ' + json.models.length + ' models';

                // Check if this storm has any interpolated models
                var hasInterp = false;
                var cycles = json.cycles || {};
                var cKeys = Object.keys(cycles);
                for (var ci = 0; ci < cKeys.length && !hasInterp; ci++) {
                    var cyc = cycles[cKeys[ci]];
                    var tKeys = Object.keys(cyc);
                    for (var tj = 0; tj < tKeys.length; tj++) {
                        if (cyc[tKeys[tj]].interp === true) { hasInterp = true; break; }
                    }
                }

                var interpBtn = document.getElementById('rt-model-interp-btn');
                _rtModelShowInterp = false;
                if (!hasInterp) {
                    if (interpBtn) {
                        interpBtn.title = 'No interpolated models available for this storm era.';
                        interpBtn.disabled = true;
                        interpBtn.style.opacity = '0.4';
                    }
                } else {
                    if (interpBtn) {
                        interpBtn.title = 'Click to show only late-cycle (interpolated) models.';
                        interpBtn.disabled = false;
                        interpBtn.style.opacity = '';
                    }
                }

                // If overlay is active, render current cycle
                if (_rtModelVisible) {
                    _rtSyncModelCycleToIR();
                }
            })
            .catch(function (e) {
                if (statusEl) statusEl.textContent = 'Unavailable';
                console.warn('[RT Models] A-deck load failed', e);
            });
    }

    /**
     * Toggle the model forecast overlay on/off.
     */
    window._rtToggleModelOverlay = function () {
        var btn = document.getElementById('rt-models-toggle-btn');
        var controls = document.getElementById('rt-model-controls');

        if (_rtModelVisible) {
            _rtModelVisible = false;
            if (btn) btn.textContent = 'Models';
            if (controls) controls.style.display = 'none';
            _rtClearModelLayers();
            _rtClearModelIntensityTraces();
            return;
        }

        _rtModelVisible = true;
        if (btn) btn.textContent = 'Hide Models';
        if (controls) controls.style.display = '';

        // Update intensity button to reflect current state
        var intBtn = document.getElementById('rt-model-intensity-btn');
        if (intBtn) intBtn.style.background = _rtModelShowIntensity ? 'rgba(116,185,255,0.2)' : '';

        if (_rtModelData) {
            _rtSyncModelCycleToIR();
        }

        // Auto-activate DeepMind ensemble if data is loaded
        if (!_rtWeatherlabVisible && (_rtWeatherlabData || _rtDmEnsData)) {
            window._rtToggleWeatherlab();
        }
    };

    /**
     * Toggle auto-sync of model cycle to IR frame time.
     */
    window._rtToggleModelAutoSync = function () {
        _rtModelAutoSync = document.getElementById('rt-model-auto-sync').checked;
        if (_rtModelAutoSync && _rtModelVisible) {
            _rtSyncModelCycleToIR();
        }
    };

    /**
     * Manually select a forecast cycle from the dropdown.
     */
    window._rtSelectModelCycle = function (initTime) {
        _rtModelAutoSync = false;
        document.getElementById('rt-model-auto-sync').checked = false;
        _rtRenderModelCycle(initTime);
        if (_rtModelShowIntensity) {
            _rtRenderModelIntensityTraces(initTime);
        }
    };

    /**
     * Toggle a model type filter.
     */
    window._rtToggleModelTypeFilter = function (mtype) {
        _rtModelTypeFilters[mtype] = !_rtModelTypeFilters[mtype];

        var _filterBtnStyles = {
            official: { color: '#ff4757', border: 'rgba(255,71,87,0.4)', bg: 'rgba(255,71,87,0.15)' },
            ai:       { color: '#00ff87', border: 'rgba(0,255,135,0.4)', bg: 'rgba(0,255,135,0.15)' }
        };

        document.querySelectorAll('.rt-model-filter-btn').forEach(function (btn) {
            var t = btn.getAttribute('data-mtype');
            if (!t) return;
            var isActive = _rtModelTypeFilters[t];
            btn.classList.toggle('active', isActive);

            var styles = _filterBtnStyles[t];
            if (styles) {
                if (isActive) {
                    btn.style.color = styles.color;
                    btn.style.borderColor = styles.border;
                    btn.style.background = styles.bg;
                } else {
                    btn.style.color = '';
                    btn.style.borderColor = '';
                    btn.style.background = '';
                }
            }
        });

        if (_rtModelVisible && _rtModelActiveCycle) {
            _rtRenderModelCycle(_rtModelActiveCycle);
            if (_rtModelShowIntensity) {
                _rtRenderModelIntensityTraces(_rtModelActiveCycle);
            }
        }
    };

    /**
     * Toggle interpolated-only vs all models.
     */
    window._rtToggleModelInterp = function () {
        _rtModelShowInterp = !_rtModelShowInterp;

        var btn = document.getElementById('rt-model-interp-btn');
        if (btn) {
            if (_rtModelShowInterp) {
                btn.title = 'Filtering to late-cycle (interpolated) models only. Click to show all.';
                btn.style.color = '#fbbf24';
                btn.style.borderColor = 'rgba(251,191,36,0.4)';
                btn.style.background = 'rgba(251,191,36,0.15)';
            } else {
                btn.title = 'Click to show only late-cycle (interpolated) models.';
                btn.style.color = '';
                btn.style.borderColor = '';
                btn.style.background = '';
            }
        }

        if (_rtModelVisible && _rtModelActiveCycle) {
            _rtRenderModelCycle(_rtModelActiveCycle);
            if (_rtModelShowIntensity) {
                _rtRenderModelIntensityTraces(_rtModelActiveCycle);
            }
        }
    };

    /**
     * Toggle intensity forecast traces on the chart.
     */
    window._rtToggleModelIntensity = function () {
        _rtModelShowIntensity = !_rtModelShowIntensity;
        var btn = document.getElementById('rt-model-intensity-btn');
        if (btn) btn.style.background = _rtModelShowIntensity ? 'rgba(116,185,255,0.2)' : '';

        if (_rtModelShowIntensity && _rtModelActiveCycle) {
            _rtRenderModelIntensityTraces(_rtModelActiveCycle);
        } else {
            _rtClearModelIntensityTraces();
        }
    };

    /**
     * Find the most recent init cycle at or before the current IR frame time.
     */
    function _rtSyncModelCycleToIR() {
        if (!_rtModelData || !_rtModelData.init_times || !_rtModelData.init_times.length) return;

        // Get current IR datetime from the animation frame
        var irDtStr = (animFrameTimes && animIndex >= 0 && animIndex < animFrameTimes.length)
            ? animFrameTimes[animIndex]
            : null;

        var inits = _rtModelData.init_times;
        var bestInit = inits[inits.length - 1]; // default to latest

        if (irDtStr) {
            var irDate = new Date(irDtStr);
            if (!isNaN(irDate.getTime())) {
                var irYMDH = irDate.getUTCFullYear().toString() +
                    ('0' + (irDate.getUTCMonth() + 1)).slice(-2) +
                    ('0' + irDate.getUTCDate()).slice(-2) +
                    ('0' + irDate.getUTCHours()).slice(-2);

                for (var i = inits.length - 1; i >= 0; i--) {
                    if (inits[i] <= irYMDH) {
                        bestInit = inits[i];
                        break;
                    }
                }
            }
        }

        // Skip re-render if cycle hasn't changed
        if (bestInit === _rtModelActiveCycle) return;

        // Update dropdown
        var sel = document.getElementById('rt-model-cycle-select');
        if (sel) sel.value = bestInit;

        _rtRenderModelCycle(bestInit);
        if (_rtModelShowIntensity) {
            _rtRenderModelIntensityTraces(bestInit);
        }
    }

    /**
     * Render forecast tracks for a given init cycle on the detail map.
     */
    function _rtRenderModelCycle(initTime) {
        _rtModelActiveCycle = initTime;
        _rtClearModelLayers();

        if (!_rtModelData || !_rtModelData.cycles || !_rtModelData.cycles[initTime]) return;
        if (!detailMap) return;

        var cycle = _rtModelData.cycles[initTime];
        var legendHtml = '';
        var _legendSeen = {};
        _rtModelLegendModels = [];

        var initDate = new Date(
            parseInt(initTime.substring(0,4)),
            parseInt(initTime.substring(4,6)) - 1,
            parseInt(initTime.substring(6,8)),
            parseInt(initTime.substring(8,10))
        );

        var techKeys = Object.keys(cycle).sort();

        for (var ti = 0; ti < techKeys.length; ti++) {
            var tech = techKeys[ti];
            var forecast = cycle[tech];

            // Apply type filters
            if (!_rtModelTypeFilters[forecast.type]) continue;
            // Apply interpolation filter
            if (_rtModelShowInterp && forecast.interp === false) continue;

            var points = forecast.points;
            if (!points || points.length < 2) continue;

            var color = forecast.color || RT_MODEL_COLORS[tech] || '#888';
            var isOfficial = forecast.type === 'official';
            var isConsensus = forecast.type === 'consensus';
            var weight = isOfficial ? 3.5 : (isConsensus ? 2.5 : 1.5);
            var opacity = isOfficial ? 1.0 : (isConsensus ? 0.9 : 0.6);
            var dashArray = (isOfficial || isConsensus) ? null : '4,3';

            // Build polyline from forecast points
            var latlngs = [];
            for (var pi = 0; pi < points.length; pi++) {
                latlngs.push([points[pi].lat, points[pi].lon]);
            }

            var line = L.polyline(latlngs, {
                color: color,
                weight: weight,
                opacity: opacity,
                dashArray: dashArray,
                interactive: false
            }).addTo(detailMap);
            _rtModelTrackLayers.push(line);

            // Add markers at tau-0 (init) and every 24h
            for (var mi = 0; mi < points.length; mi++) {
                var pt = points[mi];
                var isTau0 = (pt.tau === 0);
                var is24h = (pt.tau > 0 && pt.tau % 24 === 0);

                if (isTau0 || is24h) {
                    var mRadius = isOfficial ? (isTau0 ? 5 : 4) : (isTau0 ? 3.5 : 2.5);
                    var mWeight = isOfficial ? 2 : (isTau0 ? 1.5 : 1);
                    var marker = L.circleMarker([pt.lat, pt.lon], {
                        radius: mRadius,
                        color: isTau0 ? '#fff' : color,
                        fillColor: color,
                        fillOpacity: isTau0 ? 1.0 : 0.7,
                        weight: mWeight,
                        opacity: 0.8,
                        interactive: true
                    }).addTo(detailMap);

                    var tauLabel = isTau0 ? forecast.name + ' init' : forecast.name + ' +' + pt.tau + 'h';
                    if (pt.wind) tauLabel += ' \u00B7 ' + pt.wind + ' kt';
                    marker.bindTooltip(tauLabel, { direction: 'top', offset: [0, -6] });

                    _rtModelMarkerLayers.push(marker);
                }
            }

            // Build legend entry
            var legendKey = forecast.name + '|' + color;
            _rtModelLegendModels.push(tech);
            if (!_legendSeen[legendKey]) {
                _legendSeen[legendKey] = true;
                legendHtml += '<span class="rt-model-legend-item" style="color:' + color + ';">' +
                    '<span class="rt-model-legend-swatch" style="background:' + color + ';"></span>' +
                    forecast.name + '</span>';
            }
        }

        var legendEl = document.getElementById('rt-model-legend');
        if (legendEl) legendEl.innerHTML = legendHtml;
    }

    /**
     * Render model intensity forecast traces on the Plotly intensity chart.
     */
    function _rtRenderModelIntensityTraces(initTime) {
        _rtClearModelIntensityTraces();

        if (!_rtModelData || !_rtModelData.cycles || !_rtModelData.cycles[initTime]) return;

        var chartEl = document.getElementById('ir-intensity-chart');
        if (!chartEl || !chartEl.data) return;

        var cycle = _rtModelData.cycles[initTime];
        var initDate = new Date(
            parseInt(initTime.substring(0,4)),
            parseInt(initTime.substring(4,6)) - 1,
            parseInt(initTime.substring(6,8)),
            parseInt(initTime.substring(8,10))
        );

        var newTraces = [];
        var techKeys = Object.keys(cycle).sort();

        for (var ti = 0; ti < techKeys.length; ti++) {
            var tech = techKeys[ti];
            var forecast = cycle[tech];
            if (!_rtModelTypeFilters[forecast.type]) continue;
            if (_rtModelShowInterp && forecast.interp === false) continue;

            var points = forecast.points;
            if (!points || points.length < 2) continue;

            var times = [];
            var winds = [];
            var hasWind = false;
            for (var pi = 0; pi < points.length; pi++) {
                if (points[pi].wind != null) {
                    var fDate = new Date(initDate.getTime() + points[pi].tau * 3600000);
                    times.push(fDate.toISOString());
                    winds.push(points[pi].wind);
                    hasWind = true;
                }
            }

            if (!hasWind || winds.length < 2) continue;

            var color = forecast.color || RT_MODEL_COLORS[tech] || '#888';
            var isOfficial = forecast.type === 'official';
            var isConsensus = forecast.type === 'consensus';
            newTraces.push({
                x: times,
                y: winds,
                type: 'scatter',
                mode: isOfficial ? 'lines+markers' : 'lines',
                name: forecast.name,
                line: {
                    color: color,
                    width: isOfficial ? 3 : (isConsensus ? 2.5 : 1.5),
                    dash: 'solid'
                },
                marker: isOfficial ? { size: 5, symbol: 'diamond', color: color } : undefined,
                opacity: isOfficial ? 1.0 : (isConsensus ? 0.85 : 0.65),
                showlegend: false,
                hovertemplate: forecast.name + ': %{y} kt<extra></extra>'
            });
        }

        if (newTraces.length > 0 && typeof Plotly !== 'undefined') {
            Plotly.addTraces(chartEl, newTraces);
            _rtModelIntensityTraces = [];
            var baseCount = chartEl.data.length - newTraces.length;
            for (var i = 0; i < newTraces.length; i++) {
                _rtModelIntensityTraces.push(baseCount + i);
            }
        }
    }

    /**
     * Remove all model forecast layers from the map.
     */
    function _rtClearModelLayers() {
        for (var i = 0; i < _rtModelTrackLayers.length; i++) {
            if (detailMap) try { detailMap.removeLayer(_rtModelTrackLayers[i]); } catch (e) {}
        }
        _rtModelTrackLayers = [];
        for (var j = 0; j < _rtModelMarkerLayers.length; j++) {
            if (detailMap) try { detailMap.removeLayer(_rtModelMarkerLayers[j]); } catch (e) {}
        }
        _rtModelMarkerLayers = [];
    }

    /**
     * Remove model intensity traces from the Plotly chart.
     */
    function _rtClearModelIntensityTraces() {
        if (_rtModelIntensityTraces.length === 0) return;
        var chartEl = document.getElementById('ir-intensity-chart');
        if (!chartEl || typeof Plotly === 'undefined') return;

        try {
            var sorted = _rtModelIntensityTraces.slice().sort(function (a, b) { return b - a; });
            Plotly.deleteTraces(chartEl, sorted);
        } catch (e) {
            console.warn('[RT Models] Failed to remove intensity traces', e);
        }
        _rtModelIntensityTraces = [];
    }

    // ═══════════════════════════════════════════════════════════
    //  DEEPMIND WEATHERLAB ENSEMBLE OVERLAY
    // ═══════════════════════════════════════════════════════════

    var _WEATHERLAB_MEMBER_COLOR = 'rgba(0, 229, 255, 0.25)';
    var _WEATHERLAB_MEAN_COLOR = '#00e5ff';

    /**
     * Load WeatherLab ensemble data for a storm (called from openStormDetail).
     */
    function _rtLoadWeatherlab(storm) {
        if (!storm || !storm.atcf_id) return;
        _rtWeatherlabData = null;

        fetch(API_BASE + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id) + '/weatherlab', { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error(r.status);
                return r.json();
            })
            .then(function (json) {
                _rtWeatherlabData = json;
                var btn = document.getElementById('rt-weatherlab-btn');
                if (btn) btn.title = json.n_members + ' members, init ' + json.init_time;
                console.log('[WeatherLab] Loaded ' + json.n_members + ' members for ' + storm.atcf_id);
            })
            .catch(function () {
                // Silent — WeatherLab may not have data for this storm
            });
    }

    /**
     * Toggle DeepMind ensemble overlay on/off.
     */
    window._rtToggleWeatherlab = function () {
        var btn = document.getElementById('rt-weatherlab-btn');

        if (_rtWeatherlabVisible) {
            _rtWeatherlabVisible = false;
            _rtClearWeatherlabLayers();
            _rtClearWeatherlabIntensity();
            if (detailMap) detailMap.off('zoomend', _rtWeatherlabOnZoom);
            if (btn) { btn.style.background = 'rgba(0,229,255,0.15)'; }
            var filterEl = document.getElementById('rt-weatherlab-filter');
            if (filterEl) filterEl.style.display = 'none';
            _rtWeatherlabMinCat = null;
            var catSel = document.getElementById('rt-weatherlab-cat-filter');
            if (catSel) catSel.value = '';
            // Hide distribution panels
            var distEl = document.getElementById('rt-dm-intensity-dist');
            var changeEl = document.getElementById('rt-dm-change-dist');
            var lmiEl = document.getElementById('rt-dm-lmi-dist');
            if (distEl) distEl.style.display = 'none';
            if (changeEl) changeEl.style.display = 'none';
            if (lmiEl) lmiEl.style.display = 'none';
            return;
        }

        if (!_rtWeatherlabData) {
            if (btn) btn.title = 'No DeepMind data available';
            return;
        }

        _rtWeatherlabVisible = true;
        if (btn) { btn.style.background = 'rgba(0,229,255,0.35)'; }
        var filterEl = document.getElementById('rt-weatherlab-filter');
        if (filterEl) filterEl.style.display = '';
        _rtRenderWeatherlab();
        _rtRenderWeatherlabIntensity();
        if (detailMap) detailMap.on('zoomend', _rtWeatherlabOnZoom);

        // Show 1000-member distribution panels if data is loaded
        if (_rtDmEnsData) {
            _rtShowDmPanels();
        }
    };

    /**
     * Render 50 ensemble spaghetti tracks + mean on the detail map.
     */
    /** Zoom-based scale factor for ensemble rendering.
     *  At zoom 5 (default): 1.0x. Scales up gently at higher zooms. */
    /** Wind speed threshold for each Saffir-Simpson category */
    var _SS_WIND_THRESHOLDS = { 'TS': 34, 'C1': 64, 'C2': 83, 'C3': 96, 'C4': 113, 'C5': 137 };

    /** Check if a member's max wind reaches at least the given category */
    function _wlMemberReachesCat(pts, minCat) {
        if (!minCat || !pts) return true;
        var threshold = _SS_WIND_THRESHOLDS[minCat] || 0;
        for (var i = 0; i < pts.length; i++) {
            if (pts[i].wind != null && pts[i].wind >= threshold) return true;
        }
        return false;
    }

    /**
     * Filter ensemble members by max intensity category.
     */
    window._rtFilterWeatherlabByCat = function (cat) {
        _rtWeatherlabMinCat = cat || null;
        if (_rtWeatherlabVisible) {
            _rtRenderWeatherlab();
            _rtRenderWeatherlabIntensity();
        }
    };

    function _wlZoomScale() {
        if (!detailMap) return 1.0;
        var z = detailMap.getZoom();
        // z5=1.0, z6=1.3, z7=1.7, z8=2.1, z9=2.5
        return 1.0 + (z - 5) * 0.35;
    }

    /** Re-scale WeatherLab layers on zoom change */
    function _rtWeatherlabOnZoom() {
        if (!_rtWeatherlabVisible) return;
        var s = _wlZoomScale();
        for (var i = 0; i < _rtWeatherlabLayers.length; i++) {
            var lyr = _rtWeatherlabLayers[i];
            if (lyr._isMeanLine) {
                lyr.setStyle({ weight: 3 * s });
            } else {
                lyr.setStyle({ weight: Math.max(0.8, 1 * s) });
            }
        }
        for (var j = 0; j < _rtWeatherlabMarkers.length; j++) {
            var m = _rtWeatherlabMarkers[j];
            var base = m._wlBaseRadius || 2;
            m.setRadius(base * s);
        }
    }

    function _rtRenderWeatherlab() {
        _rtClearWeatherlabLayers();
        if (!_rtWeatherlabData || !detailMap) return;

        var s = _wlZoomScale();
        var members = _rtWeatherlabData.members || {};
        var memberKeys = Object.keys(members);
        var shownCount = 0;

        // Render ensemble members as thin spaghetti
        for (var mi = 0; mi < memberKeys.length; mi++) {
            var key = memberKeys[mi];
            var pts = members[key].points;
            if (!pts || pts.length < 2) continue;

            // Apply intensity filter
            if (!_wlMemberReachesCat(pts, _rtWeatherlabMinCat)) continue;
            shownCount++;

            var latlngs = [];
            for (var pi = 0; pi < pts.length; pi++) {
                latlngs.push([pts[pi].lat, pts[pi].lon]);
            }

            var line = L.polyline(latlngs, {
                color: _WEATHERLAB_MEMBER_COLOR,
                weight: Math.max(0.8, 1 * s),
                opacity: 1,
                interactive: false
            }).addTo(detailMap);
            _rtWeatherlabLayers.push(line);

            // Add markers at 24h intervals with tooltips
            for (var pi = 0; pi < pts.length; pi++) {
                var pt = pts[pi];
                if (pt.tau > 0 && pt.tau % 24 !== 0) continue;

                var cat = windToCategory(pt.wind);
                var color = SS_COLORS[cat] || '#64748b';
                var baseR = pt.tau === 0 ? 3 : 2;
                var marker = L.circleMarker([pt.lat, pt.lon], {
                    radius: baseR * s,
                    color: color,
                    fillColor: color,
                    fillOpacity: 0.8,
                    weight: 0.5 * s,
                    opacity: 0.7,
                    interactive: true
                }).addTo(detailMap);
                marker._wlBaseRadius = baseR;

                var tipHtml = '<b>Member ' + key + '</b> +' + pt.tau + 'h<br>' +
                    pt.lat.toFixed(1) + '\u00B0N ' + pt.lon.toFixed(1) + '\u00B0E<br>' +
                    (pt.wind != null ? pt.wind.toFixed(0) + ' kt' : '') +
                    (pt.pres != null ? ' \u00B7 ' + pt.pres.toFixed(0) + ' hPa' : '') +
                    '<br><span style="color:' + color + ';">' + cat + '</span>';

                marker.bindTooltip(tipHtml, { direction: 'top', offset: [0, -4] });
                _rtWeatherlabMarkers.push(marker);
            }

            // LMI marker — diamond at the point of maximum intensity
            var lmiPt = null;
            var lmiWind = -1;
            for (var li = 0; li < pts.length; li++) {
                if (pts[li].wind != null && pts[li].wind > lmiWind) {
                    lmiWind = pts[li].wind;
                    lmiPt = pts[li];
                }
            }
            if (lmiPt && lmiWind >= 34) {
                var lmiCat = windToCategory(lmiWind);
                var lmiColor = SS_COLORS[lmiCat] || '#64748b';
                var lmiR = 3.5;
                var lmiMarker = L.circleMarker([lmiPt.lat, lmiPt.lon], {
                    radius: lmiR * s,
                    color: '#fff',
                    fillColor: lmiColor,
                    fillOpacity: 1,
                    weight: 1.2 * s,
                    opacity: 0.9,
                    interactive: true
                }).addTo(detailMap);
                lmiMarker._wlBaseRadius = lmiR;

                var lmiTip = '<b>Member ' + key + ' LMI</b><br>' +
                    '+' + lmiPt.tau + 'h \u00B7 ' + lmiWind.toFixed(0) + ' kt' +
                    (lmiPt.pres != null ? ' \u00B7 ' + lmiPt.pres.toFixed(0) + ' hPa' : '') +
                    '<br>' + lmiPt.lat.toFixed(1) + '\u00B0N ' + lmiPt.lon.toFixed(1) + '\u00B0E' +
                    '<br><span style="color:' + lmiColor + ';">' + lmiCat + '</span>';

                lmiMarker.bindTooltip(lmiTip, { direction: 'top', offset: [0, -5] });
                _rtWeatherlabMarkers.push(lmiMarker);
            }
        }

        // Render ensemble mean as thick line
        var mean = _rtWeatherlabData.ensemble_mean;
        if (mean && mean.points && mean.points.length >= 2) {
            var meanLatLngs = [];
            for (var i = 0; i < mean.points.length; i++) {
                meanLatLngs.push([mean.points[i].lat, mean.points[i].lon]);
            }

            var meanLine = L.polyline(meanLatLngs, {
                color: _WEATHERLAB_MEAN_COLOR,
                weight: 3 * s,
                opacity: 0.95,
                interactive: false
            }).addTo(detailMap);
            meanLine._isMeanLine = true;
            _rtWeatherlabLayers.push(meanLine);

            // Markers at standard forecast hours on mean
            for (var i = 0; i < mean.points.length; i++) {
                var pt = mean.points[i];
                if (pt.tau > 0 && pt.tau % 24 !== 0) continue;

                var cat = windToCategory(pt.wind);
                var color = SS_COLORS[cat] || '#64748b';
                var baseR = pt.tau === 0 ? 5 : 4;
                var marker = L.circleMarker([pt.lat, pt.lon], {
                    radius: baseR * s,
                    color: '#fff',
                    fillColor: color,
                    fillOpacity: 1,
                    weight: 1.5 * s,
                    opacity: 1,
                    interactive: true
                }).addTo(detailMap);
                marker._wlBaseRadius = baseR;

                var tipHtml = '<b>DeepMind Mean</b> +' + pt.tau + 'h<br>' +
                    pt.lat.toFixed(1) + '\u00B0N ' + pt.lon.toFixed(1) + '\u00B0E<br>' +
                    (pt.wind != null ? pt.wind.toFixed(0) + ' kt' : '') +
                    (pt.pres != null ? ' \u00B7 ' + pt.pres.toFixed(0) + ' hPa' : '') +
                    '<br><span style="color:' + color + ';">' + cat + '</span>';

                marker.bindTooltip(tipHtml, { direction: 'top', offset: [0, -6] });
                _rtWeatherlabMarkers.push(marker);
            }

            // LMI marker for ensemble mean
            var meanLmiPt = null;
            var meanLmiWind = -1;
            for (var ml = 0; ml < mean.points.length; ml++) {
                if (mean.points[ml].wind != null && mean.points[ml].wind > meanLmiWind) {
                    meanLmiWind = mean.points[ml].wind;
                    meanLmiPt = mean.points[ml];
                }
            }
            if (meanLmiPt && meanLmiWind >= 34) {
                var mlCat = windToCategory(meanLmiWind);
                var mlColor = SS_COLORS[mlCat] || '#64748b';
                var mlR = 6;
                var mlMarker = L.circleMarker([meanLmiPt.lat, meanLmiPt.lon], {
                    radius: mlR * s,
                    color: '#fff',
                    fillColor: mlColor,
                    fillOpacity: 1,
                    weight: 2 * s,
                    opacity: 1,
                    interactive: true
                }).addTo(detailMap);
                mlMarker._wlBaseRadius = mlR;

                var mlTip = '<b>DeepMind Mean LMI</b><br>' +
                    '+' + meanLmiPt.tau + 'h \u00B7 ' + meanLmiWind.toFixed(0) + ' kt' +
                    (meanLmiPt.pres != null ? ' \u00B7 ' + meanLmiPt.pres.toFixed(0) + ' hPa' : '') +
                    '<br>' + meanLmiPt.lat.toFixed(1) + '\u00B0N ' + meanLmiPt.lon.toFixed(1) + '\u00B0E' +
                    '<br><span style="color:' + mlColor + ';">' + mlCat + '</span>';

                mlMarker.bindTooltip(mlTip, { direction: 'top', offset: [0, -7] });
                _rtWeatherlabMarkers.push(mlMarker);
            }
        }

        // Update filter count
        var countEl = document.getElementById('rt-weatherlab-filter-count');
        if (countEl) {
            countEl.textContent = _rtWeatherlabMinCat
                ? shownCount + '/' + memberKeys.length + ' members'
                : memberKeys.length + ' members';
        }
    }

    /**
     * Add ensemble mean + spread envelope to the Plotly intensity chart.
     */
    function _rtRenderWeatherlabIntensity() {
        _rtClearWeatherlabIntensity();
        if (!_rtWeatherlabData) return;

        var chartEl = document.getElementById('ir-intensity-chart');
        if (!chartEl || !chartEl.data) return;

        var initTime = _rtWeatherlabData.init_time;
        var initDate = new Date(
            parseInt(initTime.substring(0,4)),
            parseInt(initTime.substring(4,6)) - 1,
            parseInt(initTime.substring(6,8)),
            parseInt(initTime.substring(8,10))
        );

        var newTraces = [];

        // Compute min/max envelope across filtered members
        var members = _rtWeatherlabData.members || {};
        var memberKeys = Object.keys(members);
        var tauMap = {};  // tau -> {winds: [], times: ISO}
        for (var mi = 0; mi < memberKeys.length; mi++) {
            var pts = members[memberKeys[mi]].points;
            if (!_wlMemberReachesCat(pts, _rtWeatherlabMinCat)) continue;
            if (!pts) continue;
            for (var pi = 0; pi < pts.length; pi++) {
                var pt = pts[pi];
                if (pt.wind == null) continue;
                if (!tauMap[pt.tau]) {
                    var t = new Date(initDate.getTime() + pt.tau * 3600000);
                    tauMap[pt.tau] = { winds: [], time: t.toISOString() };
                }
                tauMap[pt.tau].winds.push(pt.wind);
            }
        }

        var taus = Object.keys(tauMap).map(Number).sort(function (a, b) { return a - b; });

        // Min envelope (bottom of spread)
        var minTimes = [];
        var minWinds = [];
        for (var i = 0; i < taus.length; i++) {
            minTimes.push(tauMap[taus[i]].time);
            minWinds.push(Math.min.apply(null, tauMap[taus[i]].winds));
        }
        newTraces.push({
            x: minTimes, y: minWinds,
            type: 'scatter', mode: 'lines',
            name: 'DeepMind min',
            line: { color: 'rgba(0,229,255,0.15)', width: 0 },
            showlegend: false, hoverinfo: 'skip'
        });

        // Max envelope (top of spread, filled to min)
        var maxTimes = [];
        var maxWinds = [];
        for (var i = 0; i < taus.length; i++) {
            maxTimes.push(tauMap[taus[i]].time);
            maxWinds.push(Math.max.apply(null, tauMap[taus[i]].winds));
        }
        newTraces.push({
            x: maxTimes, y: maxWinds,
            type: 'scatter', mode: 'lines',
            name: 'DeepMind spread',
            line: { color: 'rgba(0,229,255,0.15)', width: 0 },
            fill: 'tonexty',
            fillcolor: 'rgba(0,229,255,0.12)',
            showlegend: false, hoverinfo: 'skip'
        });

        // Ensemble mean line
        var mean = _rtWeatherlabData.ensemble_mean;
        if (mean && mean.points) {
            var meanTimes = [];
            var meanWinds = [];
            for (var i = 0; i < mean.points.length; i++) {
                if (mean.points[i].wind != null) {
                    var t = new Date(initDate.getTime() + mean.points[i].tau * 3600000);
                    meanTimes.push(t.toISOString());
                    meanWinds.push(mean.points[i].wind);
                }
            }
            newTraces.push({
                x: meanTimes, y: meanWinds,
                type: 'scatter', mode: 'lines+markers',
                name: 'DeepMind Mean',
                line: { color: _WEATHERLAB_MEAN_COLOR, width: 2.5 },
                marker: { size: 4, symbol: 'circle', color: _WEATHERLAB_MEAN_COLOR },
                opacity: 0.9,
                showlegend: false,
                hovertemplate: 'DeepMind: %{y:.0f} kt<extra></extra>'
            });
        }

        if (newTraces.length > 0 && typeof Plotly !== 'undefined') {
            Plotly.addTraces(chartEl, newTraces);
            _rtWeatherlabMeanTraces = [];
            var baseCount = chartEl.data.length - newTraces.length;
            for (var i = 0; i < newTraces.length; i++) {
                _rtWeatherlabMeanTraces.push(baseCount + i);
            }
        }
    }

    /**
     * Remove ensemble layers from map.
     */
    function _rtClearWeatherlabLayers() {
        for (var i = 0; i < _rtWeatherlabLayers.length; i++) {
            if (detailMap) try { detailMap.removeLayer(_rtWeatherlabLayers[i]); } catch (e) {}
        }
        _rtWeatherlabLayers = [];
        for (var j = 0; j < _rtWeatherlabMarkers.length; j++) {
            if (detailMap) try { detailMap.removeLayer(_rtWeatherlabMarkers[j]); } catch (e) {}
        }
        _rtWeatherlabMarkers = [];
    }

    /**
     * Remove ensemble intensity traces from chart.
     */
    function _rtClearWeatherlabIntensity() {
        if (_rtWeatherlabMeanTraces.length === 0) return;
        var chartEl = document.getElementById('ir-intensity-chart');
        if (!chartEl || typeof Plotly === 'undefined') return;
        try {
            var sorted = _rtWeatherlabMeanTraces.slice().sort(function (a, b) { return b - a; });
            Plotly.deleteTraces(chartEl, sorted);
        } catch (e) {}
        _rtWeatherlabMeanTraces = [];
    }

    /**
     * Full cleanup of WeatherLab state.
     */
    // ═══════════════════════════════════════════════════════════
    //  DEEPMIND 1000-MEMBER ENSEMBLE DISTRIBUTION PANELS
    // ═══════════════════════════════════════════════════════════

    var _DM_SS_COLORS = {
        TD: '#60a5fa', TS: '#34d399', C1: '#fbbf24', C2: '#fb923c',
        C3: '#ef4444', C4: '#c430a0', C5: '#8b5cf6'
    };

    /** Assign SS color to a wind speed value */
    function _dmWindColor(w) {
        if (w == null) return '#64748b';
        if (w < 34) return _DM_SS_COLORS.TD;
        if (w < 64) return _DM_SS_COLORS.TS;
        if (w < 83) return _DM_SS_COLORS.C1;
        if (w < 96) return _DM_SS_COLORS.C2;
        if (w < 113) return _DM_SS_COLORS.C3;
        if (w < 137) return _DM_SS_COLORS.C4;
        return _DM_SS_COLORS.C5;
    }

    /**
     * Load 1000-member ensemble data for histogram panels.
     */
    function _rtLoadDmEnsemble(storm) {
        if (!storm || !storm.atcf_id) return;
        _rtDmEnsData = null;

        fetch(API_BASE + '/ir-monitor/storm/' + encodeURIComponent(storm.atcf_id) + '/weatherlab-ensemble', { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error(r.status);
                return r.json();
            })
            .then(function (json) {
                _rtDmEnsData = json;
                console.log('[WeatherLab 1K] Loaded ' + json.n_members + ' members');
                // If DeepMind toggle is already active, show panels immediately
                if (_rtWeatherlabVisible) {
                    _rtShowDmPanels();
                }
            })
            .catch(function () {
                // Silent — 1000-member data may not be available
            });
    }

    /** Slider handler for intensity histogram */
    /** Show distribution panels and initialize sliders/charts */
    function _rtShowDmPanels() {
        if (!_rtDmEnsData) return;
        var taus = _rtDmEnsData.lead_times_h || [];

        var idx24 = taus.indexOf(24);
        var default24 = idx24 >= 0 ? idx24 : Math.min(4, taus.length - 1);

        var histSlider = document.getElementById('rt-dm-hist-slider');
        if (histSlider) { histSlider.max = taus.length - 1; histSlider.value = default24; }
        var changeSlider = document.getElementById('rt-dm-change-slider');
        if (changeSlider) {
            changeSlider.max = taus.length - 1;
            changeSlider.value = default24;
            _rtDmChangeTauIdx = default24;
        }

        var distEl = document.getElementById('rt-dm-intensity-dist');
        var changeEl = document.getElementById('rt-dm-change-dist');
        var lmiEl = document.getElementById('rt-dm-lmi-dist');
        if (distEl) distEl.style.display = '';
        if (changeEl) changeEl.style.display = '';
        if (lmiEl) lmiEl.style.display = '';

        _rtDmHistTauIdx = default24;
        _rtRenderIntensityHist();
        _rtRenderChangeHist();
        _rtRenderLmiHist();
    }

    window._rtDmHistSlide = function (idx) {
        _rtDmHistTauIdx = parseInt(idx);
        _rtRenderIntensityHist();
    };

    /** Slider handler for change histogram */
    window._rtDmChangeSlide = function (idx) {
        _rtDmChangeTauIdx = parseInt(idx);
        _rtRenderChangeHist();
    };

    /** Toggle 12h/24h change interval */
    window._rtDmChangeInterval = function (hours) {
        _rtDmChangeInt = hours;
        var btn12 = document.getElementById('rt-dm-change-12h-btn');
        var btn24 = document.getElementById('rt-dm-change-24h-btn');
        if (btn12) btn12.style.background = hours === 12 ? 'rgba(0,229,255,0.2)' : '';
        if (btn24) btn24.style.background = hours === 24 ? 'rgba(0,229,255,0.2)' : '';
        if (btn12) btn12.classList.toggle('active', hours === 12);
        if (btn24) btn24.classList.toggle('active', hours === 24);
        _rtRenderChangeHist();
    };

    /**
     * Render intensity histogram at the current slider tau.
     */
    function _rtRenderIntensityHist() {
        if (!_rtDmEnsData || typeof Plotly === 'undefined') return;

        var taus = _rtDmEnsData.lead_times_h || [];
        var tau = taus[_rtDmHistTauIdx];
        if (tau == null) return;

        var label = document.getElementById('rt-dm-hist-label');
        if (label) label.textContent = '+' + tau + 'h';

        var tauKey = String(Math.round(tau));
        var data = _rtDmEnsData.intensity[tauKey];
        if (!data || !data.winds) return;

        // Filter out nulls
        var winds = data.winds.filter(function (w) { return w != null; });
        if (winds.length === 0) return;

        // Compute percentiles
        var sorted = winds.slice().sort(function (a, b) { return a - b; });
        var p = function (pct) { return sorted[Math.floor(pct / 100 * (sorted.length - 1))]; };
        var mean = winds.reduce(function (a, b) { return a + b; }, 0) / winds.length;

        var chartEl = document.getElementById('rt-dm-hist-chart');
        if (!chartEl) return;

        // Pre-bin into 5-kt bins with SS-colored bars
        var binSize = 5;
        var binCenters = [];
        var binCounts = [];
        var binColors = [];
        for (var b = 0; b < 175; b += binSize) {
            var center = b + binSize / 2;
            var count = 0;
            for (var wi = 0; wi < winds.length; wi++) {
                if (winds[wi] >= b && winds[wi] < b + binSize) count++;
            }
            if (count > 0 || b < 170) {
                binCenters.push(center);
                binCounts.push(count);
                binColors.push(_dmWindColor(center));
            }
        }

        var trace = {
            x: binCenters,
            y: binCounts,
            type: 'bar',
            width: binSize * 0.9,
            marker: {
                color: binColors,
                line: { color: 'rgba(0,0,0,0.3)', width: 0.5 }
            },
            hovertemplate: '%{x:.0f} kt<br>%{y} members<extra></extra>'
        };

        // SS category threshold lines with labels
        var ssThresholds = [
            { v: 34, label: 'TS' }, { v: 64, label: 'C1' },
            { v: 83, label: 'C2' }, { v: 96, label: 'C3' },
            { v: 113, label: 'C4' }, { v: 137, label: 'C5' }
        ];
        var shapes = ssThresholds.map(function (t) {
            return {
                type: 'line', x0: t.v, x1: t.v, y0: 0, y1: 1, yref: 'paper',
                line: { color: 'rgba(255,255,255,0.15)', width: 1, dash: 'dot' }
            };
        });

        // Percentile summary as single line (avoids overlapping labels)
        var pctText = 'P10: ' + p(10).toFixed(0) + '  P50: ' + p(50).toFixed(0) +
            '  P90: ' + p(90).toFixed(0) + ' kt';
        var annotations = [
            { x: 0, y: 1.06, xref: 'paper', yref: 'paper', text: pctText,
              showarrow: false, font: { size: 8, color: '#94a3b8' },
              xanchor: 'left', yanchor: 'bottom' }
        ];

        // Mean line
        shapes.push({
            type: 'line', x0: mean, x1: mean, y0: 0, y1: 1, yref: 'paper',
            line: { color: '#00e5ff', width: 1.5 }
        });

        var layout = {
            height: 180,
            margin: { t: 25, r: 10, b: 30, l: 40 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { family: 'JetBrains Mono, monospace', size: 9, color: '#94a3b8' },
            xaxis: {
                title: { text: 'Vmax (kt)', font: { size: 9 } },
                range: [0, 175],
                dtick: 20,
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            yaxis: {
                title: { text: 'Count', font: { size: 9 } },
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            shapes: shapes,
            annotations: annotations,
            bargap: 0.08
        };

        Plotly.newPlot(chartEl, [trace], layout, {
            displayModeBar: false, responsive: false, staticPlot: true
        });
    }

    /**
     * Render intensity change histogram at the current slider tau.
     */
    function _rtRenderChangeHist() {
        if (!_rtDmEnsData || typeof Plotly === 'undefined') return;

        var taus = _rtDmEnsData.lead_times_h || [];
        var tau = taus[_rtDmChangeTauIdx];
        if (tau == null) return;

        var label = document.getElementById('rt-dm-change-label');
        if (label) label.textContent = '+' + tau + 'h';

        var changeData = _rtDmChangeInt === 12
            ? _rtDmEnsData.intensity_change_12h
            : _rtDmEnsData.intensity_change_24h;

        var tauKey = String(Math.round(tau));
        var data = changeData ? changeData[tauKey] : null;
        if (!data || !data.dv) {
            // No change data at this tau (too early)
            var chartEl = document.getElementById('rt-dm-change-chart');
            if (chartEl) Plotly.purge(chartEl);
            return;
        }

        var dv = data.dv.filter(function (v) { return v != null; });
        if (dv.length === 0) return;

        // RI threshold and probability
        var riThreshold = _rtDmChangeInt === 24 ? 30 : 20;
        var riCount = dv.filter(function (v) { return v >= riThreshold; }).length;
        var riPct = Math.round(riCount / dv.length * 100);
        var mean = dv.reduce(function (a, b) { return a + b; }, 0) / dv.length;

        var chartEl = document.getElementById('rt-dm-change-chart');
        if (!chartEl) return;

        // Pre-bin data into 5-kt bins and color by bin center value
        var binSize = 5;
        var dvMin = Math.floor(Math.min.apply(null, dv) / binSize) * binSize;
        var dvMax = Math.ceil(Math.max.apply(null, dv) / binSize) * binSize;
        var binCenters = [];
        var binCounts = [];
        var binColors = [];
        for (var b = dvMin; b < dvMax; b += binSize) {
            var center = b + binSize / 2;
            var count = 0;
            for (var di = 0; di < dv.length; di++) {
                if (dv[di] >= b && dv[di] < b + binSize) count++;
            }
            binCenters.push(center);
            binCounts.push(count);
            // Diverging: blue (weakening) → gray (neutral) → red (intensifying)
            if (center <= -30)     binColors.push('#1e40af');
            else if (center <= -15) binColors.push('#3b82f6');
            else if (center <= -5)  binColors.push('#93c5fd');
            else if (center < 5)    binColors.push('#94a3b8');
            else if (center < 15)   binColors.push('#fca5a5');
            else if (center < 30)   binColors.push('#ef4444');
            else                    binColors.push('#991b1b');
        }

        var trace = {
            x: binCenters,
            y: binCounts,
            type: 'bar',
            width: binSize * 0.9,
            marker: {
                color: binColors,
                line: { color: 'rgba(0,0,0,0.3)', width: 0.5 }
            },
            hovertemplate: '%{x:+.0f} kt/' + _rtDmChangeInt + 'h<br>%{y} members<extra></extra>'
        };

        var shapes = [
            // Zero line
            { type: 'line', x0: 0, x1: 0, y0: 0, y1: 1, yref: 'paper',
              line: { color: 'rgba(255,255,255,0.2)', width: 1 } },
            // RI threshold
            { type: 'line', x0: riThreshold, x1: riThreshold, y0: 0, y1: 1, yref: 'paper',
              line: { color: '#dc2626', width: 1.5, dash: 'dash' } },
            // Mean
            { type: 'line', x0: mean, x1: mean, y0: 0, y1: 1, yref: 'paper',
              line: { color: '#00e5ff', width: 1.5 } }
        ];

        var annotations = [
            { x: riThreshold, y: 1, yref: 'paper', text: 'RI: ' + riPct + '%',
              showarrow: false, font: { size: 9, color: '#dc2626' },
              yanchor: 'bottom', xanchor: 'left', xshift: 4 }
        ];

        var layout = {
            height: 180,
            margin: { t: 20, r: 10, b: 30, l: 35 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { family: 'JetBrains Mono, monospace', size: 9, color: '#94a3b8' },
            xaxis: {
                title: { text: '\u0394V (kt/' + _rtDmChangeInt + 'h)', font: { size: 9 } },
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            yaxis: {
                title: { text: 'Members', font: { size: 9 } },
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            shapes: shapes,
            annotations: annotations,
            bargap: 0.05
        };

        Plotly.newPlot(chartEl, [trace], layout, {
            displayModeBar: false, responsive: false, staticPlot: true
        });
    }

    /** Clean up ensemble distribution panels */
    /**
     * Render LMI distribution — histogram of each member's lifetime max wind.
     */
    function _rtRenderLmiHist() {
        if (!_rtDmEnsData || typeof Plotly === 'undefined') return;

        var chartEl = document.getElementById('rt-dm-lmi-chart');
        if (!chartEl) return;

        // Compute LMI for each member: max wind across all lead times
        var intensity = _rtDmEnsData.intensity || {};
        var taus = _rtDmEnsData.lead_times_h || [];
        var nMembers = _rtDmEnsData.n_members || 0;

        // For each member index, find the max wind across all taus
        var lmiWinds = [];
        for (var mi = 0; mi < nMembers; mi++) {
            var maxW = -Infinity;
            for (var ti = 0; ti < taus.length; ti++) {
                var tauKey = String(Math.round(taus[ti]));
                var data = intensity[tauKey];
                if (data && data.winds && data.winds[mi] != null) {
                    if (data.winds[mi] > maxW) maxW = data.winds[mi];
                }
            }
            if (maxW > -Infinity) lmiWinds.push(maxW);
        }

        if (lmiWinds.length === 0) return;

        // Pre-bin into 5-kt bins
        var binSize = 5;
        var binCenters = [];
        var binCounts = [];
        var binColors = [];
        for (var b = 0; b < 185; b += binSize) {
            var center = b + binSize / 2;
            var count = 0;
            for (var wi = 0; wi < lmiWinds.length; wi++) {
                if (lmiWinds[wi] >= b && lmiWinds[wi] < b + binSize) count++;
            }
            if (count > 0 || (b >= 20 && b <= 160)) {
                binCenters.push(center);
                binCounts.push(count);
                binColors.push(_dmWindColor(center));
            }
        }

        // Percentiles
        var sorted = lmiWinds.slice().sort(function (a, b) { return a - b; });
        var p = function (pct) { return sorted[Math.floor(pct / 100 * (sorted.length - 1))]; };
        var mean = lmiWinds.reduce(function (a, b) { return a + b; }, 0) / lmiWinds.length;

        var trace = {
            x: binCenters,
            y: binCounts,
            type: 'bar',
            width: binSize * 0.9,
            marker: {
                color: binColors,
                line: { color: 'rgba(0,0,0,0.3)', width: 0.5 }
            },
            hovertemplate: '%{x:.0f} kt<br>%{y} members<extra></extra>'
        };

        // SS threshold lines
        var shapes = [34, 64, 83, 96, 113, 137].map(function (v) {
            return {
                type: 'line', x0: v, x1: v, y0: 0, y1: 1, yref: 'paper',
                line: { color: 'rgba(255,255,255,0.15)', width: 1, dash: 'dot' }
            };
        });
        // Mean line
        shapes.push({
            type: 'line', x0: mean, x1: mean, y0: 0, y1: 1, yref: 'paper',
            line: { color: '#00e5ff', width: 1.5 }
        });

        // Compute category probabilities
        var catProbs = {};
        var cats = [['C1+', 64], ['C3+', 96], ['C5', 137]];
        for (var ci = 0; ci < cats.length; ci++) {
            var cnt = lmiWinds.filter(function (w) { return w >= cats[ci][1]; }).length;
            catProbs[cats[ci][0]] = Math.round(cnt / lmiWinds.length * 100);
        }

        // Compact summary as a single annotation at top-left (avoids overlap)
        var summaryText = 'P10: ' + p(10).toFixed(0) + '  P50: ' + p(50).toFixed(0) +
            '  P90: ' + p(90).toFixed(0) + ' kt';
        var catText = 'C1+: ' + catProbs['C1+'] + '%  C3+: ' + catProbs['C3+'] +
            '%  C5: ' + catProbs['C5'] + '%';

        var annotations = [
            { x: 0, y: 1.06, xref: 'paper', yref: 'paper', text: summaryText,
              showarrow: false, font: { size: 8, color: '#94a3b8' },
              xanchor: 'left', yanchor: 'bottom' },
            { x: 1, y: 1.06, xref: 'paper', yref: 'paper', text: catText,
              showarrow: false, font: { size: 8, color: '#94a3b8' },
              xanchor: 'right', yanchor: 'bottom' }
        ];

        var layout = {
            height: 180,
            margin: { t: 30, r: 10, b: 30, l: 40 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { family: 'JetBrains Mono, monospace', size: 9, color: '#94a3b8' },
            xaxis: {
                title: { text: 'LMI Vmax (kt)', font: { size: 9 } },
                range: [0, 185],
                dtick: 20,
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            yaxis: {
                title: { text: 'Count', font: { size: 9 } },
                gridcolor: 'rgba(255,255,255,0.05)',
                zeroline: false
            },
            shapes: shapes,
            annotations: annotations,
            bargap: 0.08
        };

        Plotly.newPlot(chartEl, [trace], layout, {
            displayModeBar: false, responsive: false, staticPlot: true
        });
    }

    function _rtRemoveDmEnsemble() {
        _rtDmEnsData = null;
        var distEl = document.getElementById('rt-dm-intensity-dist');
        var changeEl = document.getElementById('rt-dm-change-dist');
        var lmiEl = document.getElementById('rt-dm-lmi-dist');
        if (distEl) distEl.style.display = 'none';
        if (changeEl) changeEl.style.display = 'none';
        if (lmiEl) lmiEl.style.display = 'none';
        var histChart = document.getElementById('rt-dm-hist-chart');
        var changeChart = document.getElementById('rt-dm-change-chart');
        var lmiChart = document.getElementById('rt-dm-lmi-chart');
        if (histChart && typeof Plotly !== 'undefined') Plotly.purge(histChart);
        if (changeChart && typeof Plotly !== 'undefined') Plotly.purge(changeChart);
        if (lmiChart && typeof Plotly !== 'undefined') Plotly.purge(lmiChart);
    }

    // ── GDMI Chart PNG Export ─────────────────────────────────
    var _exportPopup = null;  // currently visible popup element
    var _exportTheme = 'dark';  // persistent preference

    function _rtDismissExportPopup() {
        if (_exportPopup && _exportPopup.parentNode) {
            _exportPopup.parentNode.removeChild(_exportPopup);
        }
        _exportPopup = null;
    }

    window._rtShowExportMenu = function (chartType, btnEl) {
        // If popup already open for this button, close it
        if (_exportPopup && _exportPopup.parentNode === btnEl) {
            _rtDismissExportPopup();
            return;
        }
        _rtDismissExportPopup();

        var popup = document.createElement('div');
        popup.className = 'rt-dm-export-popup';
        popup.onclick = function (e) { e.stopPropagation(); };

        var darkBtn = document.createElement('button');
        darkBtn.className = 'export-dark';
        darkBtn.textContent = 'Dark';
        darkBtn.onclick = function () { _rtDismissExportPopup(); _rtExportDmChart(chartType, 'dark'); };

        var lightBtn = document.createElement('button');
        lightBtn.className = 'export-light';
        lightBtn.textContent = 'Light';
        lightBtn.onclick = function () { _rtDismissExportPopup(); _rtExportDmChart(chartType, 'light'); };

        popup.appendChild(darkBtn);
        popup.appendChild(lightBtn);

        // Position relative to button
        btnEl.style.position = 'relative';
        btnEl.appendChild(popup);
        _exportPopup = popup;

        // Dismiss on outside click (next tick to avoid catching the opening click)
        function dismissHandler(e) {
            if (!popup.contains(e.target) && e.target !== btnEl) {
                _rtDismissExportPopup();
                document.removeEventListener('click', dismissHandler, true);
            }
        }
        setTimeout(function () {
            document.addEventListener('click', dismissHandler, true);
        }, 50);
    };

    function _rtExportDmChart(chartType, theme) {
        if (!_rtDmEnsData || typeof Plotly === 'undefined') return;

        // Re-render the chart to ensure it matches the current slider position
        if (chartType === 'intensity') _rtRenderIntensityHist();
        else if (chartType === 'change') _rtRenderChangeHist();
        else if (chartType === 'lmi') _rtRenderLmiHist();

        // Map chart type to element ID and metadata
        var chartMap = {
            'intensity': { el: 'rt-dm-hist-chart', label: 'Intensity Distribution' },
            'change':    { el: 'rt-dm-change-chart', label: 'Intensity Change' },
            'lmi':       { el: 'rt-dm-lmi-chart', label: 'Lifetime Max Intensity' }
        };
        var info = chartMap[chartType];
        if (!info) return;

        var chartEl = document.getElementById(info.el);
        if (!chartEl || !chartEl.data) return;

        // Build descriptive title
        var stormName = (document.getElementById('ir-detail-name') || {}).textContent || '';
        var stormId = currentStormId || '';
        var initTime = _rtDmEnsData.init_time || '';
        var initFmt = '';
        if (initTime.length >= 10) {
            initFmt = initTime.substring(4, 6) + '/' + initTime.substring(6, 8) + ' ' + initTime.substring(8, 10) + 'Z';
        }

        var tauStr = '';
        if (chartType === 'intensity') {
            var taus = _rtDmEnsData.lead_times_h || [];
            tauStr = ' \u2014 +' + (taus[_rtDmHistTauIdx] || 0) + 'h';
        } else if (chartType === 'change') {
            var taus = _rtDmEnsData.lead_times_h || [];
            tauStr = ' \u2014 +' + (taus[_rtDmChangeTauIdx] || 0) + 'h (' + _rtDmChangeInt + 'h change)';
        }

        var title = 'GDMI 1K ' + info.label + ' \u2014 ' + stormName + ' (' + stormId + ')' +
                    (initFmt ? ' \u2014 Init ' + initFmt : '') + tauStr;

        // Theme-dependent colors
        var isDark = theme === 'dark';
        var bgColor = isDark ? '#0f172a' : '#ffffff';
        var textColor = isDark ? '#e2e8f0' : '#1e293b';
        var gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
        var axisColor = isDark ? '#94a3b8' : '#475569';
        var lineColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';

        // Clone data and layout from the live chart
        var data = JSON.parse(JSON.stringify(chartEl.data));
        var layout = JSON.parse(JSON.stringify(chartEl.layout));

        // Apply publication overrides (8" × 6" at 2x scale = 1536 × 1152)
        layout.title = {
            text: title,
            font: { size: 16, color: textColor, family: 'JetBrains Mono, monospace' },
            x: 0.5, xanchor: 'center', y: 0.97
        };
        layout.paper_bgcolor = bgColor;
        layout.plot_bgcolor = bgColor;
        layout.font = { family: 'JetBrains Mono, monospace', size: 14, color: axisColor };
        layout.margin = { t: 55, r: 25, b: 60, l: 60 };
        layout.height = 576;
        layout.width = 768;

        // Update axis styles
        if (layout.xaxis) {
            layout.xaxis.gridcolor = gridColor;
            layout.xaxis.tickfont = { size: 14, color: axisColor };
            if (layout.xaxis.title) layout.xaxis.title.font = { size: 15, color: textColor };
        }
        if (layout.yaxis) {
            layout.yaxis.gridcolor = gridColor;
            layout.yaxis.tickfont = { size: 14, color: axisColor };
            if (layout.yaxis.title) layout.yaxis.title.font = { size: 15, color: textColor };
        }

        // Update shapes (threshold lines) colors for light theme
        if (layout.shapes) {
            for (var si = 0; si < layout.shapes.length; si++) {
                var shape = layout.shapes[si];
                if (shape.line && shape.line.color && shape.line.color.indexOf('255,255,255') >= 0) {
                    shape.line.color = lineColor;
                }
            }
        }

        // Update annotation colors
        if (layout.annotations) {
            for (var ai = 0; ai < layout.annotations.length; ai++) {
                var ann = layout.annotations[ai];
                if (ann.font && ann.font.color === '#94a3b8') {
                    ann.font.color = axisColor;
                }
                ann.font = ann.font || {};
                ann.font.size = Math.max((ann.font.size || 9) + 2, 10);
            }
        }

        // Add "TC-ATLAS" watermark
        layout.annotations = layout.annotations || [];
        layout.annotations.push({
            text: 'TC-ATLAS | tc-atlas.com',
            xref: 'paper', yref: 'paper',
            x: 1, y: -0.12,
            showarrow: false,
            font: { size: 9, color: isDark ? '#475569' : '#94a3b8' },
            xanchor: 'right', yanchor: 'top'
        });

        // Render to temporary div and export
        var tmpDiv = document.createElement('div');
        tmpDiv.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
        document.body.appendChild(tmpDiv);

        Plotly.newPlot(tmpDiv, data, layout, { displayModeBar: false }).then(function () {
            return Plotly.toImage(tmpDiv, { format: 'png', width: 768, height: 576, scale: 2 });
        }).then(function (dataUrl) {
            // Trigger download
            var filename = 'GDMI_' + stormId + '_' + chartType;
            if (chartType !== 'lmi') {
                var taus = _rtDmEnsData.lead_times_h || [];
                var tau = chartType === 'intensity' ? taus[_rtDmHistTauIdx] : taus[_rtDmChangeTauIdx];
                filename += '_' + (tau || 0) + 'h';
            }
            filename += '_init' + initTime + '_' + theme + '.png';

            var a = document.createElement('a');
            a.href = dataUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            // Clean up temp div
            Plotly.purge(tmpDiv);
            document.body.removeChild(tmpDiv);
        }).catch(function (err) {
            console.warn('[RT Monitor] Chart export failed:', err);
            if (tmpDiv.parentNode) {
                Plotly.purge(tmpDiv);
                document.body.removeChild(tmpDiv);
            }
        });
    }

    function _rtRemoveWeatherlab() {
        _rtClearWeatherlabLayers();
        _rtClearWeatherlabIntensity();
        if (detailMap) detailMap.off('zoomend', _rtWeatherlabOnZoom);
        _rtWeatherlabData = null;
        _rtWeatherlabVisible = false;
        _rtWeatherlabMinCat = null;
        var btn = document.getElementById('rt-weatherlab-btn');
        if (btn) { btn.style.background = 'rgba(0,229,255,0.15)'; btn.title = ''; }
        var filterEl = document.getElementById('rt-weatherlab-filter');
        if (filterEl) filterEl.style.display = 'none';
    }

    // ═══════════════════════════════════════════════════════════
    //  ASCAT SCATTEROMETER WIND BARB OVERLAY
    // ═══════════════════════════════════════════════════════════

    /** Wind barb color scale by speed (knots) */
    var _ASCAT_COLORS = [
        [15,  '#60a5fa'],  // light blue: < 15 kt
        [25,  '#22c55e'],  // green: 15-25 kt
        [35,  '#eab308'],  // yellow: 25-35 kt
        [50,  '#f97316'],  // orange: 35-50 kt
        [64,  '#ef4444'],  // red: 50-64 kt
        [999, '#c026d3'],  // purple: 64+ kt (hurricane force)
    ];

    function _ascatColor(spdKt) {
        for (var i = 0; i < _ASCAT_COLORS.length; i++) {
            if (spdKt < _ASCAT_COLORS[i][0]) return _ASCAT_COLORS[i][1];
        }
        return _ASCAT_COLORS[_ASCAT_COLORS.length - 1][1];
    }

    /**
     * Build an SVG wind barb string for the given speed and direction.
     * Returns an SVG element string suitable for L.divIcon html.
     *
     * Meteorological convention: staff points toward the direction the
     * wind is coming FROM.  Feathers on the left side looking from base
     * to tip.
     */
    function _buildWindBarbSVG(speedKt, dirDeg) {
        var sz = 30;           // viewBox size
        var cx = sz / 2, cy = sz / 2;
        var staffLen = 12;     // pixels from center to tip
        var barbLen = 5;       // feather length
        var barbGap = 2.2;     // gap between feathers
        var flagH = 3;         // pennant height along staff
        var flagW = 5;         // pennant width

        var color = _ascatColor(speedKt);

        // Wind-from direction in radians (meteorological: 0° = from north, 90° = from east)
        var dirRad = (dirDeg) * Math.PI / 180;

        // Staff tip in the FROM direction (up = north = 0°)
        var sinD = Math.sin(dirRad), cosD = -Math.cos(dirRad);
        var tipX = cx + staffLen * sinD;
        var tipY = cy + staffLen * cosD;

        var paths = [];

        // Staff line
        paths.push('M' + cx.toFixed(1) + ',' + cy.toFixed(1) +
                   'L' + tipX.toFixed(1) + ',' + tipY.toFixed(1));

        // Feather encoding
        var remaining = Math.round(speedKt / 5) * 5;
        var nFlags = Math.floor(remaining / 50); remaining -= nFlags * 50;
        var nFull  = Math.floor(remaining / 10); remaining -= nFull * 10;
        var nHalf  = Math.floor(remaining / 5);

        // Perpendicular direction (left side looking from base to tip)
        var perpX = cosD;
        var perpY = -(-sinD);  // negated because SVG y-axis is inverted
        // Correct perpendicular: rotate staff direction 90° CCW
        perpX = -cosD;
        perpY = sinD;

        var pos = 0;  // distance from tip along staff

        // 50-kt pennant flags
        for (var fi = 0; fi < nFlags; fi++) {
            var frac1 = pos / staffLen;
            var fx1 = tipX + (cx - tipX) * frac1;
            var fy1 = tipY + (cy - tipY) * frac1;
            var frac2 = (pos + flagH) / staffLen;
            var fx2 = tipX + (cx - tipX) * frac2;
            var fy2 = tipY + (cy - tipY) * frac2;
            var midFrac = (pos + flagH * 0.5) / staffLen;
            var mx = tipX + (cx - tipX) * midFrac;
            var my = tipY + (cy - tipY) * midFrac;
            var outX = mx + flagW * perpX;
            var outY = my + flagW * perpY;
            // Filled triangle
            paths.push('M' + fx1.toFixed(1) + ',' + fy1.toFixed(1) +
                       'L' + outX.toFixed(1) + ',' + outY.toFixed(1) +
                       'L' + fx2.toFixed(1) + ',' + fy2.toFixed(1) + 'Z');
            pos += flagH + barbGap * 0.3;
        }

        // 10-kt full barbs
        for (var fb = 0; fb < nFull; fb++) {
            var frac = pos / staffLen;
            var bx = tipX + (cx - tipX) * frac;
            var by = tipY + (cy - tipY) * frac;
            paths.push('M' + bx.toFixed(1) + ',' + by.toFixed(1) +
                       'L' + (bx + barbLen * perpX).toFixed(1) + ',' +
                       (by + barbLen * perpY).toFixed(1));
            pos += barbGap;
        }

        // 5-kt half barbs
        for (var hb = 0; hb < nHalf; hb++) {
            // If this is the only feather, offset it slightly from the tip
            if (nFlags === 0 && nFull === 0 && pos === 0) pos = barbGap;
            var frac = pos / staffLen;
            var hx = tipX + (cx - tipX) * frac;
            var hy = tipY + (cy - tipY) * frac;
            paths.push('M' + hx.toFixed(1) + ',' + hy.toFixed(1) +
                       'L' + (hx + barbLen * 0.55 * perpX).toFixed(1) + ',' +
                       (hy + barbLen * 0.55 * perpY).toFixed(1));
            pos += barbGap;
        }

        // Combine into SVG
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + sz + '" height="' + sz +
            '" viewBox="0 0 ' + sz + ' ' + sz + '">' +
            '<path d="' + paths.join(' ') + '" stroke="' + color +
            '" stroke-width="1.5" fill="' + color + '" fill-opacity="0.3" ' +
            'stroke-linecap="round" stroke-linejoin="round"/></svg>';
        return svg;
    }

    /**
     * Load ASCAT pass list for a storm (called from openStormDetail).
     */
    function _rtLoadAscatPasses(storm) {
        var section = document.getElementById('rt-ascat-section');
        var statusEl = document.getElementById('rt-ascat-status');
        var atcfId = storm.atcf_id;

        if (!atcfId) {
            if (section) section.style.display = 'none';
            return;
        }

        // Skip if already loaded for this storm
        if (atcfId === _rtAscatLastAtcf && _rtAscatPasses) {
            if (section) section.style.display = '';
            return;
        }
        _rtAscatLastAtcf = atcfId;
        _rtAscatPasses = null;

        if (statusEl) statusEl.textContent = 'Searching...';
        if (section) section.style.display = '';

        var retries = 0;
        function _doFetch() {
            fetch(API_BASE + '/ascat/passes?atcf_id=' + encodeURIComponent(atcfId) + '&hours=12', { cache: 'no-store' })
                .then(function (r) {
                    // Retry on 404 — backend storm cache may not be warm yet
                    if (r.status === 404 && retries < 2) {
                        retries++;
                        console.log('[RT ASCAT] Storm not in cache yet, retry ' + retries + '/2 in 5s...');
                        setTimeout(_doFetch, 5000);
                        return;
                    }
                    if (!r.ok) throw new Error(r.status);
                    return r.json();
                })
                .then(function (json) {
                    if (!json) return;  // was a retry
                    _rtAscatPasses = json;

                    if (!json.passes || json.passes.length === 0) {
                        if (statusEl) statusEl.textContent = 'No passes found';
                        return;
                    }

                    if (statusEl) statusEl.textContent = json.passes.length + ' pass' + (json.passes.length > 1 ? 'es' : '');

                    // Populate pass dropdown
                    var sel = document.getElementById('rt-ascat-pass-select');
                    if (sel) {
                        sel.innerHTML = '';
                        for (var i = 0; i < json.passes.length; i++) {
                            var p = json.passes[i];
                            var opt = document.createElement('option');
                            opt.value = i;
                            opt.textContent = p.satellite + ' \u2014 ' + p.datetime_utc;
                            sel.appendChild(opt);
                        }
                    }
                })
                .catch(function (err) {
                    console.warn('[RT ASCAT] Failed to load passes:', err);
                    if (statusEl) statusEl.textContent = '';
                    if (section) section.style.display = 'none';
                });
        }
        _doFetch();
    }

    /**
     * Toggle ASCAT wind barb overlay on/off.
     */
    window._rtToggleAscatOverlay = function () {
        var btn = document.getElementById('rt-ascat-toggle-btn');
        var controls = document.getElementById('rt-ascat-controls');

        if (_rtAscatVisible) {
            _rtAscatVisible = false;
            if (btn) btn.textContent = 'ASCAT';
            if (controls) controls.style.display = 'none';
            _rtClearAscatLayers();
            return;
        }

        _rtAscatVisible = true;
        if (btn) btn.textContent = 'Hide';
        if (controls) controls.style.display = '';

        // Load winds for the selected pass
        var sel = document.getElementById('rt-ascat-pass-select');
        if (sel) {
            window._rtSelectAscatPass(sel.value);
        }
    };

    /**
     * Select and render a specific ASCAT pass.
     */
    window._rtSelectAscatPass = function (idx) {
        idx = parseInt(idx);
        if (!_rtAscatPasses || !_rtAscatPasses.passes || isNaN(idx)) return;

        var pass = _rtAscatPasses.passes[idx];
        if (!pass) return;

        var dataUrl = pass.opendap_url || pass.download_url;
        if (!dataUrl) {
            console.warn('[RT ASCAT] No data URL for pass', pass);
            return;
        }

        // Skip if already showing this pass
        if (dataUrl === _rtAscatActiveUrl && _rtAscatLayers.length > 0) return;

        _rtClearAscatLayers();

        var statusEl = document.getElementById('rt-ascat-status');
        if (statusEl) statusEl.textContent = 'Loading winds...';

        var lat = _rtAscatPasses.storm_lat;
        var lon = _rtAscatPasses.storm_lon;

        fetch(API_BASE + '/ascat/winds?data_url=' + encodeURIComponent(dataUrl) +
              '&center_lat=' + lat + '&center_lon=' + lon + '&radius_deg=8', { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (json) {
                _rtAscatActiveUrl = dataUrl;

                if (!json.winds || json.winds.length === 0) {
                    if (statusEl) statusEl.textContent = 'No wind data in region';
                    return;
                }

                if (statusEl) statusEl.textContent = json.count + ' obs \u00B7 ' + pass.satellite;

                _rtRenderAscatWinds(json.winds);
            })
            .catch(function (err) {
                console.warn('[RT ASCAT] Failed to load winds:', err);
                if (statusEl) statusEl.textContent = 'Error loading winds';
            });
    };

    /**
     * Render ASCAT wind barbs as Leaflet divIcon markers.
     */
    function _rtRenderAscatWinds(winds) {
        _rtClearAscatLayers();

        for (var i = 0; i < winds.length; i++) {
            var w = winds[i];
            if (w.speed_kt < 2.5) continue;  // calm — skip

            var svg = _buildWindBarbSVG(w.speed_kt, w.dir_deg);
            var icon = L.divIcon({
                className: 'ascat-barb-icon',
                html: svg,
                iconSize: [30, 30],
                iconAnchor: [15, 15],
            });

            var marker = L.marker([w.lat, w.lon], {
                icon: icon,
                pane: 'ascatPane',
                interactive: true,
            });
            marker.bindTooltip(
                Math.round(w.speed_kt) + ' kt from ' + Math.round(w.dir_deg) + '\u00B0',
                { direction: 'top', offset: [0, -12], className: 'ascat-tooltip' }
            );
            marker.addTo(detailMap);
            _rtAscatLayers.push(marker);
        }
    }

    /**
     * Remove all ASCAT barb markers from the map.
     */
    function _rtClearAscatLayers() {
        for (var i = 0; i < _rtAscatLayers.length; i++) {
            if (detailMap) try { detailMap.removeLayer(_rtAscatLayers[i]); } catch (e) {}
        }
        _rtAscatLayers = [];
    }

    /**
     * Full ASCAT overlay cleanup (called when switching/closing storms).
     */
    function _rtRemoveAscatOverlay() {
        _rtClearAscatLayers();
        _rtAscatPasses = null;
        _rtAscatLastAtcf = null;
        _rtAscatActiveUrl = null;
        _rtAscatVisible = false;
        var btn = document.getElementById('rt-ascat-toggle-btn');
        if (btn) btn.textContent = 'ASCAT';
        var controls = document.getElementById('rt-ascat-controls');
        if (controls) controls.style.display = 'none';
        var section = document.getElementById('rt-ascat-section');
        if (section) section.style.display = 'none';
    }

    /**
     * Remove all model overlay state (called when switching/closing storms).
     */
    function _rtRemoveModelOverlay() {
        _rtClearModelLayers();
        _rtClearModelIntensityTraces();
        _rtRemoveWeatherlab();
        _rtRemoveDmEnsemble();
        _rtModelData = null;
        _rtModelActiveCycle = null;
        _rtModelLastAtcf = null;
        _rtModelVisible = false;
        var btn = document.getElementById('rt-models-toggle-btn');
        if (btn) btn.textContent = 'Models';
        var controls = document.getElementById('rt-model-controls');
        if (controls) controls.style.display = 'none';
        var section = document.getElementById('rt-models-section');
        if (section) section.style.display = 'none';
    }

    function init() {
        initMap();
        bindEvents();

        // Initial poll
        pollActiveStorms();

        // Set up recurring poll
        pollTimer = setInterval(pollActiveStorms, POLL_INTERVAL_MS);

        // Fetch season summary (initial + recurring every 30 min)
        fetchSeasonSummary();
        seasonSummaryTimer = setInterval(fetchSeasonSummary, SEASON_SUMMARY_INTERVAL_MS);

        // Clean up timers on page unload to prevent memory leaks
        window.addEventListener('beforeunload', function () {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (globalAnimTimer) { cancelAnimationFrame(globalAnimTimer); globalAnimTimer = null; }
            if (animTimer) { cancelAnimationFrame(animTimer); animTimer = null; }
            if (seasonSummaryTimer) { clearInterval(seasonSummaryTimer); seasonSummaryTimer = null; }
        });

        _ga('ir_page_load');
        console.log('[RT Monitor] Initialized — polling every', POLL_INTERVAL_MS / 1000, 'seconds');
    }

    // ═══════════════════════════════════════════════════════════
    //  KML EXPORT
    // ═══════════════════════════════════════════════════════════

    var KML_COLORS = {
        'TD':   'ffff8800',
        'TS':   'ff00cc00',
        'Cat1': 'ff00aaff',
        'Cat2': 'ff0066ff',
        'Cat3': 'ff0000ff',
        'Cat4': 'ff0000cc',
        'Cat5': 'ff0000aa',
    };

    function _escXml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    window.downloadActiveStormKML = function () {
        if (!currentStormId) return;

        // Find the storm object
        var storm = null;
        for (var i = 0; i < stormData.length; i++) {
            if (stormData[i].atcf_id === currentStormId) {
                storm = stormData[i];
                break;
            }
        }
        if (!storm) return;

        // Fetch metadata to get the full track history
        var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(currentStormId) + '/metadata';
        fetch(url, { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (meta) {
                if (!meta || !meta.intensity_history || meta.intensity_history.length === 0) {
                    alert('No track data available for export');
                    return;
                }

                var history = meta.intensity_history;
                var name = storm.name || 'UNNAMED';
                var placemarks = '';

                // Track line
                var coords = [];
                for (var i = 0; i < history.length; i++) {
                    coords.push(history[i].lon + ',' + history[i].lat + ',0');
                }
                placemarks += '<Placemark>\n' +
                    '  <name>' + _escXml(name) + ' Track</name>\n' +
                    '  <Style><LineStyle><color>ffffffff</color><width>2</width></LineStyle></Style>\n' +
                    '  <LineString><coordinates>' + coords.join(' ') + '</coordinates></LineString>\n' +
                    '</Placemark>\n';

                // Fix placemarks
                for (var j = 0; j < history.length; j++) {
                    var p = history[j];
                    var cat = windToCategory(p.vmax_kt);
                    var color = KML_COLORS[cat] || 'ffffffff';
                    var desc = '';
                    if (p.vmax_kt != null) desc += 'Wind: ' + p.vmax_kt + ' kt\\n';
                    if (p.mslp_hpa != null) desc += 'Pressure: ' + p.mslp_hpa + ' hPa\\n';
                    desc += 'Category: ' + cat;

                    placemarks += '<Placemark>\n' +
                        '  <name>' + _escXml(p.time || '') + '</name>\n' +
                        '  <description>' + _escXml(desc) + '</description>\n' +
                        '  <Style><IconStyle><color>' + color + '</color><scale>0.5</scale>' +
                        '<Icon><href>http://maps.google.com/mapfiles/kml/shapes/shaded_dot.png</href></Icon>' +
                        '</IconStyle></Style>\n' +
                        '  <Point><coordinates>' + p.lon + ',' + p.lat + ',0</coordinates></Point>\n' +
                        '</Placemark>\n';
                }

                var kml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
                    '<kml xmlns="http://www.opengis.net/kml/2.2">\n' +
                    '<Document>\n' +
                    '  <name>' + _escXml(name + ' ' + currentStormId) + '</name>\n' +
                    '  <description>Track exported from TC-ATLAS (https://michaelfischerwx.github.io/TC-ATLAS/)</description>\n' +
                    placemarks +
                    '</Document>\n' +
                    '</kml>';

                var blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = name.replace(/\s+/g, '_') + '_' + currentStormId + '.kml';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(a.href);
            })
            .catch(function (err) {
                console.warn('[RT Monitor] KML export failed:', err.message || '');
                alert('KML export failed — could not fetch track data');
            });
    };

    // ── GeoTIFF Export ──────────────────────────────────────────
    window.downloadActiveStormGeoTIFF = function () {
        if (!currentStormId) return;

        // Use the current animation frame index (0 = newest)
        var frameIdx = animIndex || 0;

        var url = API_BASE + '/ir-monitor/storm/' + encodeURIComponent(currentStormId) +
            '/geotiff?frame_index=' + frameIdx;

        // Show feedback
        var btn = document.querySelector('.ir-kml-btn[onclick*="GeoTIFF"]');
        var origText = btn ? btn.innerHTML : '';
        if (btn) btn.innerHTML = '⏳ Fetching…';

        fetch(url, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.blob();
            })
            .then(function (blob) {
                var cd = '';  // Content-Disposition has the filename
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                // Extract filename from the blob or build one
                a.download = currentStormId + '_frame' + frameIdx + '_Tb.tif';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(a.href);
                if (btn) btn.innerHTML = origText;
            })
            .catch(function (err) {
                console.warn('[RT Monitor] GeoTIFF export failed:', err.message || '');
                alert('GeoTIFF export failed: ' + (err.message || 'unknown error'));
                if (btn) btn.innerHTML = origText;
            });
    };

    // Boot on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
