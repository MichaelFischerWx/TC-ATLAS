#!/usr/bin/env bash
# check_version_tokens.sh — fail if any shared asset is referenced under more
# than one ?v= cache token across the production HTML pages (drift means
# cross-page cache misses: the same bytes get downloaded once per token).
# Also catches a preload/script tag token mismatch, since both count as
# references to the same file.
#
# Run from the repo root:  ./scripts/check_version_tokens.sh
# Add new shared files to FILES as they grow page-spanning references.
set -u
cd "$(dirname "$0")/.."

PAGES="index.html realtime_ir.html global_archive.html explorer.html tc_climatology.html climatology_globe.html"
FILES="theme.js tc_export.js tc_radar_styles.css realtime_tdr_styles.css vol3d.js skewt.js lflet_gl.js global_archive_styles.css realtime_ir.js global_archive.js tc_radar_app.js tc_climatology.js satellite.js realtime_tdr.js satellite_styles.css realtime_ir_styles.css"

fail=0
for f in $FILES; do
    # Match src/href references like  foo.js?v=TOKEN  (quote or " delimited)
    tokens=$(grep -ho "${f}?v=[0-9A-Za-z.]*" $PAGES 2>/dev/null | sort -u)
    n=$(printf '%s\n' "$tokens" | sed '/^$/d' | wc -l | tr -d ' ')
    if [ "$n" -gt 1 ]; then
        echo "DRIFT: $f referenced under $n tokens:"
        printf '%s\n' "$tokens" | sed 's/^/    /'
        for t in $tokens; do
            grep -n "$t" $PAGES | sed 's/^/        /'
        done
        fail=1
    fi
done

# The IBTrACS data files use a shared ?vYYYYMMDD (no '=') key across pages
# AND inside JS loaders (global_archive.js DATA_VER, tc_radar_app.js
# IBTRACS_DATA_VER, realtime_seasonal.js literals). One key = one cache entry.
ib=$(grep -ho "ibtracs[a-z_0-9]*\.json?v[0-9]*" $PAGES *.js 2>/dev/null | grep -o "?v[0-9]*$" | sort -u)
ibn=$(printf '%s\n' "$ib" | sed '/^$/d' | wc -l | tr -d ' ')
ibv=$(grep -ho "DATA_VER = 'v[0-9]*'" global_archive.js tc_radar_app.js 2>/dev/null | grep -o "v[0-9]*" | sort -u)
ibvn=$(printf '%s\n' "$ibv" | sed '/^$/d' | wc -l | tr -d ' ')
if [ "$ibn" -gt 1 ] || [ "$ibvn" -gt 1 ]; then
    echo "DRIFT: IBTrACS cache keys disagree:"
    printf '    literal URLs: %s\n' "$(echo $ib)"
    printf '    DATA_VER consts: %s\n' "$(echo $ibv)"
    fail=1
fi

if [ "$fail" -eq 0 ]; then
    echo "OK: all shared-asset ?v= tokens agree across pages."
fi
exit $fail
