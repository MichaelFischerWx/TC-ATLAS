/* ══════════════════════════════════════════════════════════════
   TC-ATLAS time labels — one UTC format site-wide.
   ══════════════════════════════════════════════════════════════
   Every page writes a UTC time the same way: day, 3-letter month,
   24-hour clock, "UTC". Archive views and saved figures add the year;
   model cycles keep forecaster shorthand for the hour.

     TCTime.utc(t)                     → "9 Oct 21:10 UTC"
     TCTime.utc(t, { year: true })     → "9 Oct 2017 21:10 UTC"
     TCTime.utc(t, { sec: true })      → "9 Oct 21:10:30 UTC"   (obs that resolve seconds)
     TCTime.utc(t, { date: false })    → "21:10 UTC"            (the date is already on screen)
     TCTime.utc(t, { zone: false })    → "9 Oct 21:10"          (ranges, columns headed "UTC")
     TCTime.utc(t, { time: false })    → "9 Oct"                (a day; "9 Oct 2017" with year)
     TCTime.cycle(t)                   → "9 Oct 12Z"            ("GFS 9 Oct 12Z", "init 9 Oct 12Z")
     TCTime.span(a, b, { year: true }) → "3–5 Sep 2017", "30 Aug – 13 Sep 2017"
     TCTime.plotly.utc etc.            → the same labels as Plotly date formats

   t may be an ISO stamp with or without an offset (none means UTC), one
   ending in " UTC", a model init "YYYYMMDDHH" (minutes and seconds
   optional), a GFS cycle "YYYYMMDD-HH", a plain "YYYYMMDD", epoch ms or a
   Date. TCTime.parse(t) returns that Date, or null. Input that can't be
   read comes back as given, so a label never reads "NaN".
   ══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    // An ISO stamp with no offset is UTC on this site: new Date() would read
    // it as local time, and Safari rejects the space-separated form.
    function parse(t) {
        if (t == null || t === '') return null;
        var d, m, s;
        if (t instanceof Date || typeof t === 'number') {
            d = new Date(t);
        } else {
            s = String(t).trim();
            if ((m = /^(\d{4})(\d{2})(\d{2})(?:-?(\d{2})(\d{2})?(\d{2})?)?$/.exec(s)) ||
                (m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(?:Z|UTC|[+-]00:?00)?$/i.exec(s))) {
                d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
            } else {
                d = new Date(s);
            }
        }
        return isNaN(d.getTime()) ? null : d;
    }

    function day(d, year) {
        return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + (year ? ' ' + d.getUTCFullYear() : '');
    }

    function utc(t, opts) {
        if (t == null || t === '') return '—';
        var d = parse(t);
        if (!d) return String(t);
        opts = opts || {};
        var parts = [];
        if (opts.date !== false) parts.push(day(d, opts.year));
        if (opts.time !== false) {
            parts.push(pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes())
                + (opts.sec ? ':' + pad2(d.getUTCSeconds()) : '') + (opts.zone === false ? '' : ' UTC'));
        }
        return parts.join(' ');
    }

    function cycle(t, opts) {
        var d = parse(t);
        if (!d) return t == null ? '' : String(t);
        var mi = d.getUTCMinutes();
        return day(d, opts && opts.year) + ' ' + pad2(d.getUTCHours()) + (mi ? ':' + pad2(mi) : '') + 'Z';
    }

    function span(a, b, opts) {
        var d1 = parse(a), d2 = parse(b) || d1, y = opts && opts.year;
        if (!d1) return '';
        if (d1.getUTCFullYear() !== d2.getUTCFullYear()) return day(d1, y) + ' – ' + day(d2, y);
        if (d1.getUTCMonth() !== d2.getUTCMonth()) return day(d1, false) + ' – ' + day(d2, y);
        if (d1.getUTCDate() !== d2.getUTCDate()) return d1.getUTCDate() + '–' + day(d2, y);
        return day(d1, y);
    }

    // Plotly (d3-time-format) spellings of the same labels; %-d is the
    // unpadded day. For hovertemplates ("%{x|" + TCTime.plotly.utc + "}"),
    // xhoverformat and tickformat.
    var plotly = {
        utc:      '%-d %b %H:%M UTC',
        utcYear:  '%-d %b %Y %H:%M UTC',
        cycle:    '%-d %b %HZ',
        day:      '%-d %b',
        dayYear:  '%-d %b %Y'
    };

    // Plotly's own date axes (default ticks and hovers) take their day/month
    // order from its locale: "Sep 5" over "2017", "18:00" over "Sep 5, 2017".
    // Switch that to "5 Sep" / "5 Sep 2017" as soon as Plotly arrives, however
    // the page loads it: already there, a <script> tag (monitor, TC-RADAR), or
    // the Global Archive's on-demand ensurePlotly().
    function plotlyDayMonth() {
        var P = window.Plotly;
        if (!P || P._tcDayMonth || typeof P.setPlotConfig !== 'function') return;
        P._tcDayMonth = true;
        P.setPlotConfig({ locales: { 'en-US': { format: { dayMonth: '%-d %b', dayMonthYear: '%-d %b %Y' } } } });
    }
    plotlyDayMonth();
    [].forEach.call(document.querySelectorAll('script[src*="plotly"]'), function (s) {
        s.addEventListener('load', plotlyDayMonth);
    });
    if (typeof window.ensurePlotly === 'function') {
        var ensure = window.ensurePlotly;
        window.ensurePlotly = function (cb) {
            return ensure().then(function (v) { plotlyDayMonth(); return cb ? cb(v) : v; });
        };
    }

    window.TCTime = { utc: utc, cycle: cycle, span: span, parse: parse, plotly: plotly };
})();
