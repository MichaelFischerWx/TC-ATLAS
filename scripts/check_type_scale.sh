#!/usr/bin/env bash
# check_type_scale.sh — fail if a stylesheet sets a font size off the site's
# type scale (the UI standard, phase 3): 9 10 11 12 13 14 16 18 20 24 28 32
# 40 48 px, plus 56 px for hero numerals, written in px or rem (rem = px/16).
# 9 px is for text inside maps, legends and charts; 10 px is the floor for
# everything else (that part needs a reviewer — the script can't tell).
# em, %, keywords, clamp(), var() and calc() sizes are not checked.
#
# Scans every top-level stylesheet and the <style> blocks of the pages that
# carry their own CSS. Font sizes written inline by scripts are not covered.
#
# Run from the repo root:  ./scripts/check_type_scale.sh
# Also runs from scripts/hooks/pre-commit.
set -u
cd "$(dirname "$0")/.."
exec python3 - <<'PY'
import glob, re, sys

STEPS = {9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56}
PAGES_WITH_CSS = ['index.html', '404.html', 'changelog.html']
SIZE = re.compile(
    r'(?:font-size\s*:\s*|(?<![-\w])font\s*:\s*'
    r'(?:(?:italic|normal|oblique|small-caps|\d{3}|bold|lighter|bolder)\s+)*)'
    r'(\d*\.?\d+)(px|rem)\b')


def scan(path, text, start=0, end=None):
    out = []
    for m in SIZE.finditer(text, start, len(text) if end is None else end):
        px = float(m.group(1)) * (16 if m.group(2) == 'rem' else 1)
        if round(px, 3) not in STEPS:
            line = text.count('\n', 0, m.start()) + 1
            out.append('%s:%d  %s%s (%gpx)' % (path, line, m.group(1), m.group(2), round(px, 2)))
    return out


bad = []
for path in sorted(glob.glob('*.css')):
    bad += scan(path, open(path, encoding='utf-8').read())
for path in PAGES_WITH_CSS:
    try:
        text = open(path, encoding='utf-8').read()
    except OSError:
        continue
    for m in re.finditer(r'<style[^>]*>(.*?)</style>', text, flags=re.S):
        bad += scan(path, text, m.start(1), m.end(1))

if bad:
    print('OFF-SCALE font sizes (allowed: %s px):' % ' '.join(str(s) for s in sorted(STEPS)))
    for b in bad:
        print('    ' + b)
    sys.exit(1)
print('OK: every stylesheet font size is on the type scale.')
PY
