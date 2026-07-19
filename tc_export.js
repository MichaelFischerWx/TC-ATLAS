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
            ok = !!window.open(url, '_blank');
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
            // NotAllowedError (stale activation) or anything else → fallback.
            return downloadOrOpen(blob, filename);
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
        present: present,
        dataURLToBlob: dataURLToBlob,
        isIOS: isIOS,
        isTouch: isTouch,
    };
})();
