#!/usr/bin/env bash
# check_corner_shadow_tokens.sh — fail if a stylesheet hard-codes a corner
# radius or an elevation shadow instead of using the UI-standard tokens
# (phase 5, defined in tc_radar_styles.css :root):
#   corners  var(--radius-xs) 2 px data graphics (slider tracks, colorbars,
#            legend swatches) · var(--radius-sm) 4 px inputs and small badges ·
#            var(--radius) 6 px buttons and controls · var(--radius-lg) 10 px
#            panels and cards · var(--radius-pill) chips · plus 0 and 50 %.
#            Two-to-four-value corners (segment ends) use the same tokens.
#   shadows  var(--shadow-1) raised · var(--shadow-2) floating (menus,
#            popovers, tooltips) · var(--shadow-3) overlay (modals).
#            Only neutral drop shadows are checked; focus rings, inset borders,
#            colored glows, upward shadows and the strong (alpha >= 0.3) shadows
#            under labels on imagery are allowed as written.
#
# Scans every top-level stylesheet. Run from the repo root:
#   ./scripts/check_corner_shadow_tokens.sh
# Also runs from scripts/hooks/pre-commit.
set -u
cd "$(dirname "$0")/.."
exec python3 - <<'PY'
import glob, re, sys

RADIUS_OK = re.compile(r'^(0|50%|inherit|unset|initial|var\(--(radius(-xs|-sm|-lg|-pill)?|btn-r|ga-r(-lg)?)\))$')
COLOR = r'(?:rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|var\([^)]*\)|[a-z]+)'

def neutral_drop(layer):
    """True for a neutral (black / near-black) drop shadow with alpha < 0.3."""
    if 'inset' in layer:
        return False
    cm = re.search(COLOR + r'\s*$', layer)
    col = cm.group(0).replace(' ', '').lower() if cm else ''
    m = re.match(r'rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)', col)
    if m:
        r, g, b = (int(m.group(i)) for i in (1, 2, 3))
        if max(r, g, b) - min(r, g, b) > 30 or max(r, g, b) > 60:
            return False
        if m.group(4) is not None and float(m.group(4)) >= 0.3:
            return False
    elif col not in ('#000', '#000000', 'black'):
        return False
    nums = [float(x) for x in re.findall(r'(-?\d*\.?\d+)(?:px)?\b', re.sub(COLOR, '', layer))]
    nums += [0.0] * (4 - len(nums))
    x, y, blur, spread = nums[:4]
    return blur > 0 and y >= 0

bad = []
for path in sorted(glob.glob('*.css')):
    text = open(path, encoding='utf-8').read()
    clean = re.sub(r'/\*.*?\*/', lambda m: ' ' * len(m.group(0)), text, flags=re.S)
    for m in re.finditer(r'(?<![-\w])(border(?:-(?:top|bottom)-(?:left|right))?-radius)\s*:\s*([^;}]+)', clean):
        v = ' '.join(m.group(2).replace('!important', '').split())
        if not all(RADIUS_OK.match(p) for p in v.split()):
            bad.append('%s:%d  %s: %s' % (path, clean.count('\n', 0, m.start()) + 1, m.group(1), v))
    for m in re.finditer(r'(?<![-\w])box-shadow\s*:\s*([^;}]+)', clean):
        v = ' '.join(m.group(1).replace('!important', '').split())
        if v.startswith('var(') or v in ('none', 'inherit', 'unset', 'initial'):
            continue
        sel = clean[:m.start()].rsplit('{', 1)[0].rsplit('}', 1)[-1]
        if 'marker' in sel:
            continue
        layers = [p.strip() for p in re.split(r',(?![^()]*\))', v)]
        if all(neutral_drop(l) for l in layers):
            bad.append('%s:%d  box-shadow: %s' % (path, clean.count('\n', 0, m.start()) + 1, v))

if bad:
    print('Hard-coded corners or elevation shadows (use the --radius-* / --shadow-* tokens):')
    for b in bad:
        print('    ' + b)
    sys.exit(1)
print('OK: every stylesheet corner and elevation shadow uses the tokens.')
PY
