#!/usr/bin/env bash
# Verify the LIVE Cloudflare cache behavior on api.tcatlas.org matches the
# intent encoded in cache_ruleset.json:
#   - cacheable endpoints must be HIT or MISS (never DYNAMIC)
#   - bypassed endpoints must be DYNAMIC
#
# IMPORTANT curl gotcha: always pass --compressed. Sending
# "Accept-Encoding: gzip" WITHOUT --compressed returns raw gzip bytes that
# look like an empty/garbage body (and silently breaks jq parsing).
set -uo pipefail

HOST="https://api.tcatlas.org"
ORIGIN="${ORIGIN:-https://tcatlas.org}"
AE="Accept-Encoding: gzip, deflate, br"
FAIL=0

# Echoes the cf-cache-status of a warmed request (one warm-up + one measured).
cache_status() {
  curl -s -o /dev/null -H "Origin: $ORIGIN" -H "$AE" "$1" >/dev/null
  sleep 0.5
  curl -s -o /dev/null -D - -H "Origin: $ORIGIN" -H "$AE" "$1" \
    | awk 'tolower($1)=="cf-cache-status:"{gsub(/\r/,"",$2); print $2; exit}'
}

# assert_cacheable NAME URL  -> PASS unless DYNAMIC
assert_cacheable() {
  local got; got=$(cache_status "$2")
  if [ "$got" = "HIT" ] || [ "$got" = "MISS" ]; then
    echo "PASS  cacheable  $1 -> $got"
  else
    echo "FAIL  cacheable  $1 -> ${got:-<none>} (want HIT/MISS)"; FAIL=1
  fi
}

# assert_bypassed NAME URL  -> PASS only if DYNAMIC
assert_bypassed() {
  local got; got=$(cache_status "$2")
  if [ "$got" = "DYNAMIC" ]; then
    echo "PASS  bypassed   $1 -> $got"
  else
    echo "FAIL  bypassed   $1 -> ${got:-<none>} (want DYNAMIC)"; FAIL=1
  fi
}

echo "== should CACHE =="
assert_cacheable "active-storms"  "$HOST/ir-monitor/active-storms"
assert_cacheable "season-summary" "$HOST/ir-monitor/season-summary"
assert_cacheable "genesis-index"  "$HOST/ir-monitor/weatherlab-genesis-clusters"
assert_cacheable "genesis-trend"  "$HOST/ir-monitor/weatherlab-genesis-trend?lat=15&lon=-50"

# Detail endpoint: derive a live cluster id from the index (skip if none active).
TCA=$(curl -s --compressed -H "Origin: $ORIGIN" -H "$AE" \
        "$HOST/ir-monitor/weatherlab-genesis-clusters" \
        | jq -r '.clusters[0].track_id // empty' 2>/dev/null)
if [ -n "$TCA" ]; then
  assert_cacheable "genesis-detail($TCA)" "$HOST/ir-monitor/weatherlab-genesis-cluster/$TCA"
else
  echo "SKIP  cacheable  genesis-detail (no active cluster right now)"
fi

# Recon: derive a live storm that HAS recon (bare /recon/realtime is a 422 -> can't
# cache-check). Skip cleanly if no active recon mission right now.
RECON=$(curl -s --compressed -H "Origin: $ORIGIN" -H "$AE" \
          "$HOST/ir-monitor/active-storms" \
          | jq -r 'first(.storms[] | select(.has_recon))
                   | if . then "atcf_id=\(.atcf_id)&hours=24&name=\(.name)&lat=\(.lat)&lon=\(.lon)" else empty end' 2>/dev/null)
if [ -n "$RECON" ]; then
  assert_cacheable "recon-realtime" "$HOST/recon/realtime?$RECON"
else
  echo "SKIP  cacheable  recon-realtime (no active recon mission right now)"
fi

echo "== should BYPASS =="
assert_bypassed "genesis-near"   "$HOST/ir-monitor/weatherlab-genesis-near?lat=15&lon=-50"
assert_bypassed "genesis-cycles" "$HOST/ir-monitor/weatherlab-genesis-cycles"

echo
if [ "$FAIL" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; fi
exit "$FAIL"
