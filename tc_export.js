/* tc_export.js — unified download/save architecture for TC-ATLAS.
 *
 * ONE delivery path for every export (PNG / GIF / KML / CSV / JSON / NetCDF)
 * on every page. Motivation (see DEEPMIND_GRAPHICS_ROADMAP.md + memory
 * feedback_ios_png_export): iOS Safari ignores <a download>, and long async
 * export pipelines (Plotly toImage, canvas.toBlob, GIF encode) outlive the
 * tap's transient user-activation — after which navigator.share() rejects
 * with NotAllowedError and window.open() is popup-blocked, so the save
 * silently does nothing. Strategy:
 *
 *   desktop  → plain <a download> with a blob URL (works regardless of
 *              activation state).
 *   touch    → try the Web Share sheet (files) — one tap when the
 *              activation is still fresh; if share is unavailable or the
 *              activation has expired, fall back to an in-page result
 *              overlay whose Save button provides a FRESH activation.
 *
 * Usage from any page bundle (all pages load this before their own JS):
 *   TCExport.save(blobOrPromiseOrCanvasOrDataURL, 'figure.png')
 *   TCExport.savePlotly(gd, 'chart.png', {scale: 3})
 *   TCExport.saveText(kmlString, 'storm.kml', 'application/vnd.google-earth.kml+xml')
 * All return a Promise resolving to 'download' | 'shared' | 'presented'.
 */
(function () {
    'use strict';
    if (window.TCExport) return;

    function isIOS() {
        return /iP(hone|od|ad)/.test(navigator.userAgent)
            || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
    }
    function isTouch() {
        return isIOS()
            || (window.matchMedia && matchMedia('(pointer: coarse)').matches);
    }

    /* ---- Print resolution -------------------------------------------
     * Canvas-produced PNGs carry no pHYs chunk, so print and publication
     * tools assume 72 dpi and blow a 2800-px figure up to a 39-inch
     * poster. Every PNG delivered through TCExport is therefore stamped
     * 300 dpi by default; pass {dpi: 0} to opt a call site out, or a
     * different number to override.
     *
     * The tag only DECLARES a resolution — savePlotly additionally
     * renders enough device pixels to back it (see PRINT_MIN_PX). Raster
     * sources (satellite imagery, map tiles) are tagged but never
     * upscaled: interpolating them would invent detail that isn't there.
     */
    var DEFAULT_PNG_DPI = 300;
    /* 300 dpi across an 8-inch figure. */
    var PRINT_MIN_PX = 2400;
    /* Guard against a pathological scale on a tiny chart. */
    var MAX_PRINT_SCALE = 8;
    /* Safari caps a canvas near 16.7 megapixels and 4096 px per side, and
     * past either limit it returns a BLANK canvas rather than throwing —
     * the export then silently produces nothing. Budget under both. */
    var MAX_CANVAS_PX = 12e6;
    var MAX_CANVAS_SIDE = 4096;
    var _CRC_TABLE = (function () {
        var t = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        var c = 0xFFFFFFFF;
        for (var i = 0; i < bytes.length; i++) {
            c = _CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    /* Returns a Promise<Blob> with the pHYs chunk set to `dpi`. Any
     * surprise (not a PNG, malformed chunk stream, no arrayBuffer
     * support) resolves to the original blob — a missing dpi tag must
     * never cost the user their download. */
    function pngWithDpi(blob, dpi) {
        if (!blob || !dpi || !blob.arrayBuffer ||
                (blob.type && blob.type !== 'image/png')) {
            return Promise.resolve(blob);
        }
        return blob.arrayBuffer().then(function (buf) {
            var src = new Uint8Array(buf);
            var SIG = [137, 80, 78, 71, 13, 10, 26, 10];
            for (var i = 0; i < 8; i++) {
                if (src[i] !== SIG[i]) return blob;
            }
            var ppm = Math.round(dpi / 0.0254);   // pixels per metre
            var phys = new Uint8Array(21);
            var dv = new DataView(phys.buffer);
            dv.setUint32(0, 9);                   // chunk data length
            phys[4] = 0x70; phys[5] = 0x48;       // 'p' 'H'
            phys[6] = 0x59; phys[7] = 0x73;       // 'Y' 's'
            dv.setUint32(8, ppm);
            dv.setUint32(12, ppm);
            phys[16] = 1;                         // unit specifier = metre
            dv.setUint32(17, crc32(phys.subarray(4, 17)));

            var out = [src.subarray(0, 8)];
            var p = 8;
            var inserted = false;
            while (p + 8 <= src.length) {
                var len = new DataView(src.buffer, src.byteOffset + p, 4)
                    .getUint32(0);
                var type = String.fromCharCode(src[p + 4], src[p + 5],
                                               src[p + 6], src[p + 7]);
                var end = p + 12 + len;
                if (end > src.length) return blob;      // malformed
                if (type !== 'pHYs') out.push(src.subarray(p, end));
                if (type === 'IHDR' && !inserted) {
                    // pHYs must appear before the first IDAT.
                    out.push(phys);
                    inserted = true;
                }
                p = end;
                if (type === 'IEND') break;
            }
            return inserted ? new Blob(out, { type: 'image/png' }) : blob;
        }).catch(function () { return blob; });
    }

    function dataURLToBlob(dataURL) {
        var parts = dataURL.split(',');
        var mime = (parts[0].match(/data:([^;]+)/) || [null, 'application/octet-stream'])[1];
        if (parts[0].indexOf('base64') !== -1) {
            var bin = atob(parts[1]);
            var arr = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            return new Blob([arr], { type: mime });
        }
        return new Blob([decodeURIComponent(parts[1])], { type: mime });
    }

    // Normalize any export source to a Promise<Blob>.
    // Accepts: Blob | Promise<Blob> | () => (Blob|Promise<Blob>) |
    //          HTMLCanvasElement | data-URL string.
    function toBlobPromise(source) {
        if (typeof source === 'function') {
            return Promise.resolve().then(source).then(toBlobPromise);
        }
        if (source && typeof source.then === 'function') {
            return source.then(toBlobPromise);
        }
        if (typeof source === 'string') {
            if (source.indexOf('data:') === 0) {
                return Promise.resolve(dataURLToBlob(source));
            }
            return Promise.reject(new Error('TCExport: unsupported string source'));
        }
        if (typeof HTMLCanvasElement !== 'undefined'
                && source instanceof HTMLCanvasElement) {
            return new Promise(function (resolve, reject) {
                source.toBlob(function (b) {
                    if (b) resolve(b);
                    else reject(new Error('TCExport: canvas.toBlob returned null'));
                }, 'image/png');
            });
        }
        return Promise.resolve(source);   // assume Blob
    }

    /* Deliver a blob via anchor (desktop / Android) or a new tab (iOS,
     * where <a download> claims support but silently no-ops).
     * Returns false when the delivery detectably failed (popup blocked). */
    function downloadOrOpen(blob, filename) {
        var url = URL.createObjectURL(blob);
        var ok = true;
        if (!isIOS()) {
            var a = document.createElement('a');
            if ('download' in a) {
                a.href = url; a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
            } else {
                ok = !!window.open(url, '_blank');
            }
        } else {
            // Opens the image/file in a new tab; user long-presses to save
            // (or the file downloads via Safari's download manager).
            // `!!w` alone is not enough: a refused window.open on iOS Safari
            // can return a truthy, already-closed Window, which would read as
            // success and suppress the caller's fresh-tap overlay.
            var w = window.open(url, '_blank');
            ok = !!(w && !w.closed);
        }
        // Generous revoke delay: the opened tab / download manager needs the
        // URL alive; once loaded they hold their own reference.
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        return ok;
    }

    /* Share-sheet-first delivery. Returns Promise<boolean> — true when the
     * file was handed off (or the user deliberately cancelled the share
     * sheet); false when delivery detectably failed and the caller should
     * fall back to the fresh-tap overlay. */
    function saveBlob(blob, filename) {
        var file = null;
        try {
            file = new File([blob], filename,
                { type: blob.type || 'application/octet-stream' });
        } catch (e) { /* older browsers without File constructor */ }
        var canShare = isTouch() && file && navigator.share
            && navigator.canShare && navigator.canShare({ files: [file] });
        if (!canShare) {
            return Promise.resolve(downloadOrOpen(blob, filename));
        }
        return navigator.share({ files: [file] }).then(function () {
            return true;
        }, function (err) {
            // AbortError = user opened the sheet and cancelled — respect it.
            if (err && err.name === 'AbortError') return true;
            // Any other rejection here means the share never happened, and on
            // touch the overwhelmingly common cause is that the tap's
            // transient activation expired during a long export.
            //
            // Do NOT fall back to downloadOrOpen: window.open needs that SAME
            // activation, so it cannot succeed either — but iOS Safari does
            // not reliably return null when it refuses. It can hand back a
            // truthy, already-dead Window, which downloadOrOpen reports as
            // success. save() then skips the fresh-tap overlay and the user
            // sees absolutely nothing happen. That silent failure is exactly
            // the reported Seasonal Panel B bug, and it only bites panels
            // whose export pipeline is slow enough to outlive the activation
            // — which is why the symptom looked page-dependent.
            //
            // Returning false sends the caller straight to the overlay, whose
            // Save button carries a brand-new activation and always works.
            return false;
        });
    }

    /* Fresh-tap result overlay: preview (for images) + Save button. The
     * Save tap is a brand-new user activation, so share/open always work
     * no matter how long the export pipeline took. */
    var _overlay = null;
    function closeOverlay() {
        if (!_overlay) return;
        if (_overlay._previewURL) URL.revokeObjectURL(_overlay._previewURL);
        if (_overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
        _overlay = null;
    }
    function present(blob, filename) {
        closeOverlay();
        var dark = document.documentElement.getAttribute('data-theme') === 'dark';
        var bg = dark ? '#151b26' : '#ffffff';
        var fg = dark ? '#e6edf6' : '#0f1623';
        var sub = dark ? '#9aa6b6' : '#5b6573';
        var border = dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,22,35,0.14)';

        var ov = document.createElement('div');
        ov.style.cssText =
            'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;' +
            'justify-content:center;background:rgba(8,12,20,0.62);padding:18px;';
        var card = document.createElement('div');
        card.style.cssText =
            'background:' + bg + ';color:' + fg + ';border:1px solid ' + border + ';' +
            'border-radius:14px;max-width:min(480px,94vw);max-height:88vh;width:100%;' +
            'display:flex;flex-direction:column;gap:10px;padding:14px;' +
            'box-shadow:0 18px 60px rgba(0,0,0,0.5);' +
            'font:500 13px/1.4 "DM Sans",-apple-system,"Helvetica Neue",Arial,sans-serif;';

        var title = document.createElement('div');
        title.textContent = 'Your file is ready';
        title.style.cssText = 'font-weight:700;font-size:14px;';
        card.appendChild(title);

        var isImage = /^image\//.test(blob.type || '');
        if (isImage) {
            var img = document.createElement('img');
            ov._previewURL = URL.createObjectURL(blob);
            img.src = ov._previewURL;
            img.alt = filename;
            img.style.cssText =
                'max-width:100%;max-height:52vh;object-fit:contain;border-radius:8px;' +
                'border:1px solid ' + border + ';background:' + (dark ? '#0d1117' : '#f4f6f9') + ';';
            card.appendChild(img);
        }

        var meta = document.createElement('div');
        meta.textContent = filename + ' · ' + (blob.size > 1048576
            ? (blob.size / 1048576).toFixed(1) + ' MB'
            : Math.max(1, Math.round(blob.size / 1024)) + ' KB');
        meta.style.cssText = 'color:' + sub + ';font-size:11.5px;';
        card.appendChild(meta);

        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = 'Close';
        closeBtn.style.cssText =
            'padding:9px 16px;border-radius:9px;border:1px solid ' + border + ';' +
            'background:transparent;color:' + sub + ';font:600 13px "DM Sans",sans-serif;cursor:pointer;';
        var saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.textContent = isTouch() ? 'Save / Share' : 'Save';
        saveBtn.style.cssText =
            'padding:9px 18px;border-radius:9px;border:none;background:#2e7dff;' +
            'color:#fff;font:700 13px "DM Sans",sans-serif;cursor:pointer;';
        row.appendChild(closeBtn);
        row.appendChild(saveBtn);
        card.appendChild(row);

        closeBtn.addEventListener('click', closeOverlay);
        ov.addEventListener('click', function (e) { if (e.target === ov) closeOverlay(); });
        saveBtn.addEventListener('click', function () {
            // Fresh user activation — share sheet / new tab are permitted now.
            saveBlob(blob, filename);
        });

        ov.appendChild(card);
        _overlay = ov;
        document.body.appendChild(ov);
    }

    /* THE entry point. Normalizes the source, then:
     *   desktop → direct anchor download,
     *   touch   → share sheet; if that detectably fails (stale activation,
     *             popup blocked) → fresh-tap overlay. */
    function save(source, filename, opts) {
        opts = opts || {};
        return toBlobPromise(source).then(function (blob) {
            if (!blob || !blob.size) {
                throw new Error('TCExport: export produced no data');
            }
            var dpi = (opts.dpi === undefined) ? DEFAULT_PNG_DPI : opts.dpi;
            return dpi ? pngWithDpi(blob, dpi) : blob;
        }).then(function (blob) {
            if (!isTouch()) {
                downloadOrOpen(blob, filename);
                return 'download';
            }
            if (opts.confirm) {           // callers may force the overlay
                present(blob, filename);
                return 'presented';
            }
            return saveBlob(blob, filename).then(function (ok) {
                if (ok) return 'shared';
                present(blob, filename);
                return 'presented';
            });
        });
    }

    /* Plotly chart → PNG. Replaces Plotly.downloadImage call sites (which
     * use <a download> internally and fail on iOS). */
    function savePlotly(gd, filename, opts) {
        opts = opts || {};
        var P = window.Plotly;
        if (!P) return Promise.reject(new Error('TCExport: Plotly not loaded'));
        var spec = { format: opts.format || 'png', scale: opts.scale || 3 };
        if (opts.width) spec.width = opts.width;
        if (opts.height) spec.height = opts.height;
        /* Raise the scale until the figure clears 300 dpi at a normal
         * print width. Plotly re-renders vectors at the export size, so
         * this buys real detail rather than interpolation, and the figure
         * looks identical — every dimension scales together. Callers that
         * need an exact pixel size pass {printReady: false}. */
        if (spec.format === 'png' && opts.printReady !== false) {
            var cssW = spec.width || gd.clientWidth || gd.offsetWidth || 0;
            if (cssW > 0) {
                spec.scale = Math.min(MAX_PRINT_SCALE,
                    Math.max(spec.scale, Math.ceil(PRINT_MIN_PX / cssW)));
            }
            /* Clamp to what the canvas backend can actually allocate. */
            var cssH = spec.height || gd.clientHeight || gd.offsetHeight || 0;
            if (cssW > 0 && cssH > 0) {
                var cap = Math.min(Math.sqrt(MAX_CANVAS_PX / (cssW * cssH)),
                                   MAX_CANVAS_SIDE / cssW,
                                   MAX_CANVAS_SIDE / cssH);
                cap = Math.floor(cap * 10) / 10;
                if (cap > 0) spec.scale = Math.max(1, Math.min(spec.scale, cap));
            }
        }
        return save(P.toImage(gd, spec), filename, opts);
    }

    function saveText(content, filename, mime) {
        return save(new Blob([content], { type: mime || 'text/plain' }), filename);
    }

    window.TCExport = {
        save: save,
        saveBlob: saveBlob,
        savePlotly: savePlotly,
        saveText: saveText,
        pngWithDpi: pngWithDpi,
        present: present,
        dataURLToBlob: dataURLToBlob,
        isIOS: isIOS,
        isTouch: isTouch,
    };
})();
