#!/usr/bin/env bash
# check_no_emoji.sh — the site uses line icons, never emoji. Fails if a page,
# script or stylesheet puts an emoji into the UI:
#   * a pictograph (anything from the emoji planes, or a BMP character that is
#     always drawn as emoji, such as ⏳ ✅ ❌ ⭐): use an SVG icon or plain text;
#   * a symbol that has both a text and an emoji form (▶ ◀ ⏸ ↔ ↗ ⬇ ✈ ⚠ …)
#     without the text-presentation selector U+FE0E after it. iPhones draw
#     these as color emoji when the page font lacks them (DM Sans does).
#     `--fix` adds the selector: ︎ in scripts, &#xFE0E; in markup,
#     \FE0E in CSS content strings.
# Comments are skipped. Run from the repo root:
#   ./scripts/check_no_emoji.sh [--fix]
# Also runs from scripts/hooks/pre-commit.
set -u
cd "$(dirname "$0")/.."
exec python3 - "$@" <<'PY'
import glob, re, sys

FIX = '--fix' in sys.argv[1:]
EMOJI = set([0x203C, 0x2049, 0x2139, 0x231A, 0x231B, 0x2328, 0x23CF, 0x24C2, 0x25AA, 0x25AB, 0x25B6, 0x25C0,
    0x260E, 0x2611, 0x2614, 0x2615, 0x2618, 0x261D, 0x2620, 0x2622, 0x2623, 0x2626, 0x262A, 0x262E, 0x262F,
    0x2638, 0x2639, 0x263A, 0x2640, 0x2642, 0x265F, 0x2660, 0x2663, 0x2665, 0x2666, 0x2668, 0x267B, 0x267E,
    0x267F, 0x2699, 0x269B, 0x269C, 0x26A0, 0x26A1, 0x26A7, 0x26AA, 0x26AB, 0x26B0, 0x26B1, 0x26BD, 0x26BE,
    0x26C4, 0x26C5, 0x26C8, 0x26CE, 0x26CF, 0x26D1, 0x26D3, 0x26D4, 0x26E9, 0x26EA, 0x26FD, 0x2702, 0x2705,
    0x2708, 0x2709, 0x270A, 0x270B, 0x270C, 0x270D, 0x270F, 0x2712, 0x2714, 0x2716, 0x271D, 0x2721, 0x2728,
    0x2733, 0x2734, 0x2744, 0x2747, 0x274C, 0x274E, 0x2753, 0x2754, 0x2755, 0x2757, 0x2763, 0x2764, 0x2795,
    0x2796, 0x2797, 0x27A1, 0x27B0, 0x27BF, 0x2934, 0x2935, 0x2B05, 0x2B06, 0x2B07, 0x2B1B, 0x2B1C, 0x2B50,
    0x2B55, 0x3030, 0x303D, 0x3297, 0x3299]
    + list(range(0x2194, 0x219A)) + [0x21A9, 0x21AA] + list(range(0x23E9, 0x23F4)) + list(range(0x23F8, 0x23FB))
    + list(range(0x25FB, 0x25FF)) + list(range(0x2600, 0x2605)) + list(range(0x2648, 0x2654))
    + list(range(0x2692, 0x2698)) + list(range(0x26F0, 0x26F6)) + list(range(0x26F7, 0x26FB)))
ALWAYS = set([0x231A, 0x231B, 0x23E9, 0x23EA, 0x23EB, 0x23EC, 0x23F0, 0x23F3, 0x25FD, 0x25FE, 0x2614, 0x2615,
    0x267F, 0x2693, 0x26A1, 0x26AA, 0x26AB, 0x26BD, 0x26BE, 0x26C4, 0x26C5, 0x26CE, 0x26D4, 0x26EA, 0x26F2,
    0x26F3, 0x26F5, 0x26FA, 0x26FD, 0x2705, 0x270A, 0x270B, 0x2728, 0x274C, 0x274E, 0x2753, 0x2754, 0x2755,
    0x2757, 0x2795, 0x2796, 0x2797, 0x27B0, 0x27BF, 0x2B1B, 0x2B1C, 0x2B50, 0x2B55] + list(range(0x2648, 0x2654)))
def pictograph(cp): return cp >= 0x1F000 or cp in ALWAYS
VS15 = ('︎', '\\ufe0e', '\\uFE0E', '&#xfe0e;', '&#xFE0E;', '&#65038;', '\\fe0e', '\\FE0E')
VS16 = re.compile(r'️|\\u[Ff][Ee]0[Ff]|&#x[Ff][Ee]0[Ff];|&#65039;|\\[Ff][Ee]0[Ff] ?')
CHAR = re.compile(r'&#(\d+);|&#x([0-9a-fA-F]+);|\\u\{([0-9a-fA-F]+)\}|\\u([dD][89abAB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|[ -㏿\U0001F000-\U0001FAFF]')

def segments(text, kind):
    """(start, end, kind) for the parts of a file that hold UI text: string
    literals in scripts, everything but comments in markup and stylesheets."""
    out = []
    if kind == 'html':
        pos = 0
        for m in re.finditer(r'<!--.*?-->|<script\b[^>]*>(.*?)</script>|<style\b[^>]*>(.*?)</style>', text, re.S | re.I):
            out.append((pos, m.start(), 'markup'))
            if m.group(1) is not None: out += [(a + m.start(1), b + m.start(1), k) for a, b, k in segments(m.group(1), 'js')]
            elif m.group(2) is not None: out += [(a + m.start(2), b + m.start(2), k) for a, b, k in segments(m.group(2), 'css')]
            pos = m.end()
        out.append((pos, len(text), 'markup'))
        return out
    if kind == 'css':
        pos = 0
        for m in re.finditer(r'/\*.*?\*/', text, re.S):
            out.append((pos, m.start(), 'css')); pos = m.end()
        out.append((pos, len(text), 'css'))
        return out
    i, n, q, start = 0, len(text), None, 0          # js: string literals only
    while i < n:
        c = text[i]
        if q is None:
            if text.startswith('//', i): j = text.find('\n', i); i = n if j < 0 else j; continue
            if text.startswith('/*', i): j = text.find('*/', i + 2); i = n if j < 0 else j + 2; continue
            if c in '\'"`': q, start = c, i + 1
            i += 1; continue
        if c == '\\': i += 2; continue
        if c == q or (c == '\n' and q != '`'):
            out.append((start, i, 'js')); q = None
        i += 1
    return out

def selector_for(kind, form):
    if kind == 'js': return '&#xFE0E;' if form.startswith('&#') else '\\uFE0E'
    if kind == 'css': return '\\FE0E '
    return '&#xFE0E;'

bad, fixed = [], 0
files = sorted(f for f in glob.glob('*.html') + glob.glob('*.js') + glob.glob('*.css')
               if not f.endswith('.min.js') and not f.startswith('ir_context_preview'))
for path in files:
    text = open(path, encoding='utf-8').read()
    kind = 'html' if path.endswith('.html') else 'css' if path.endswith('.css') else 'js'
    edits = []
    for a, b, k in segments(text, kind):
        for m in CHAR.finditer(text, a, b):
            if m.group(1): cp = int(m.group(1))
            elif m.group(2): cp = int(m.group(2), 16)
            elif m.group(3): cp = int(m.group(3), 16)
            elif m.group(4):    # surrogate pair written as two \\u escapes
                cp = 0x10000 + ((int(m.group(4), 16) - 0xD800) << 10) + (int(m.group(5), 16) - 0xDC00)
            elif m.group(6): cp = int(m.group(6), 16)
            else: cp = ord(m.group(0))
            if cp not in EMOJI and cp < 0x1F000: continue
            line = text.count('\n', 0, m.start()) + 1
            if pictograph(cp):
                bad.append('%s:%d  U+%04X %s  pictograph: use an SVG icon or text' % (path, line, cp, chr(cp))); continue
            rest = text[m.end():m.end() + 9]
            if rest.startswith(VS15): continue
            v16 = VS16.match(text, m.end())
            if FIX:
                edits.append((m.end(), v16.end() if v16 else m.end(), selector_for(k, m.group(0))))
            else:
                bad.append('%s:%d  U+%04X %s  needs U+FE0E (run with --fix)' % (path, line, cp, chr(cp)))
    if edits:
        for s0, s1, ins in sorted(edits, reverse=True): text = text[:s0] + ins + text[s1:]
        open(path, 'w', encoding='utf-8').write(text); fixed += len(edits)
if FIX: print('added the text-presentation selector in %d places' % fixed)
if bad:
    print('Emoji in the UI (the site uses line icons):')
    for b in bad: print('    ' + b)
    sys.exit(1)
print('OK: no emoji in pages, scripts or stylesheets.')
PY
