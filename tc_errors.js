/* ══════════════════════════════════════════════════════════════
   TC-ATLAS failed-load messages — one wording site-wide.
   ══════════════════════════════════════════════════════════════
   People see what failed and, where it helps, a Retry button. The raw
   error (exception text, HTTP status, server detail) goes to the
   console instead of the page.

     TCErrors.message(err, 'the cross-section')
       → "Couldn’t load the cross-section: the request timed out."
     TCErrors.message(err, 'the image', 'save') → "Couldn’t save the image."
     TCErrors.show(el, err, 'the cross-section', retryFn, 'explorer-status error')
       → replaces el's content with that message + a Retry button

   A server "no data" answer (e.g. "No cases match the specified
   criteria.") is shown as-is: it is the answer, not a fault. Set
   err.userMessage to show any other text verbatim.
   ══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var REASON = {
        timeout: 'the request timed out',
        busy:    'the server is busy, try again in a minute',
        offline: 'the server couldn’t be reached'
    };

    // Status from err.status, or from the messages call sites throw:
    // "HTTP 503", "GCS HTTP 404", "API error (HTTP 500)", or a bare "404".
    function _status(err) {
        if (!err) return 0;
        if (err.status) return +err.status || 0;
        var msg = String(err.message || '').trim();
        var m = msg.match(/\bHTTP\s*(\d{3})\b/) || msg.match(/^(?:GCS\s+)?(\d{3})$/);
        return m ? +m[1] : 0;
    }

    function kind(err) {
        if (!err) return 'other';
        var msg = String(err.message || err);
        if (err.name === 'AbortError' || err.name === 'TimeoutError' || /timed? ?out/i.test(msg)) return 'timeout';
        var st = _status(err);
        if (st === 404) return 'missing';
        if (st === 429 || st >= 500) return 'busy';
        if (st >= 400) return 'other';
        if (err.name === 'TypeError' && /fetch|network|load failed/i.test(msg)) return 'offline';
        return 'other';
    }

    // Server answers that ARE the user-facing result ("No matching cases",
    // "Insufficient valid profiles") rather than a fault.
    function _noDataDetail(err) {
        var msg = String((err && err.message) || '').trim();
        if (!/^(No |Insufficient )/.test(msg) || msg.length > 140) return '';
        return /[.!?]$/.test(msg) ? msg : msg + '.';
    }

    function message(err, what, verb) {
        what = what || 'this data';
        verb = verb || 'load';
        if (err && err.userMessage) return err.userMessage;
        var nd = _noDataDetail(err);
        if (nd) return nd;
        var k = kind(err);
        if (k === 'missing' && verb === 'load') return 'Couldn’t find ' + what + '.';
        return 'Couldn’t ' + verb + ' ' + what + (REASON[k] ? ': ' + REASON[k] : '') + '.';
    }

    /** For fetch chains: a non-OK Response → a rejected Error carrying
     *  .status and the server's detail (FastAPI {"detail": …}), so the
     *  message can tell "busy" from "not found" from "no data". */
    function fromResponse(r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
            var d = body && body.detail;
            if (d && typeof d !== 'string') d = JSON.stringify(d);
            var err = new Error(d || ('HTTP ' + r.status));
            err.status = r.status;
            throw err;
        });
    }

    function log(err, what) {
        try { console.warn('[TC-ATLAS] failed to load ' + (what || 'data') + ':', err); } catch (e) {}
    }

    /** Replace el's content with the message and an optional Retry button.
     *  `cls` is the container class the panel already uses for errors. */
    function show(el, err, what, retryFn, cls) {
        log(err, what);
        if (!el) return null;
        // Inline containers (status lines) get an inline message.
        var inline = /^(SPAN|P|A|LABEL|SMALL|B|STRONG|EM|TD)$/.test(el.tagName);
        var box = document.createElement(inline ? 'span' : 'div');
        box.className = (cls || 'tc-error') + ' tc-error-box';
        box.setAttribute('role', 'alert');
        var txt = document.createElement('span');
        txt.textContent = message(err, what);
        box.appendChild(txt);
        if (typeof retryFn === 'function') {
            box.appendChild(document.createTextNode(' '));
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'tc-retry';
            btn.textContent = 'Retry';
            btn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                retryFn();
            });
            box.appendChild(btn);
        }
        el.innerHTML = '';
        el.appendChild(box);
        return box;
    }

    window.TCErrors = { message: message, show: show, kind: kind, log: log, fromResponse: fromResponse };
})();
