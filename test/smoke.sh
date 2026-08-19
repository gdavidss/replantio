#!/bin/bash
# Deep-link smoke test: the one path that fails silently if the app breaks.
# Usage: test/smoke.sh [port]   (starts its own server if the port is free)
set -u
PORT=${1:-8899}
DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if ! curl -s -o /dev/null "http://localhost:$PORT/index.html"; then
  (cd "$DIR" && python3 -m http.server "$PORT" >/dev/null 2>&1) &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT
  sleep 1
fi

DOM=$("$CHROME" --headless=new --disable-gpu --virtual-time-budget=30000 \
  --user-data-dir="$(mktemp -d)" --dump-dom \
  "http://localhost:$PORT/index.html#a=-22.65,-47.65,-22.55,-47.55" 2>/dev/null)

fail=0
for needle in "loc-title" "sp-head" "site-fig" "section-h"; do
  if ! grep -q "$needle" <<<"$DOM"; then
    echo "SMOKE FAIL: '$needle' missing from rendered DOM"
    fail=1
  fi
done
if grep -q "Analyzing area\|Analisando" <<<"$DOM"; then
  echo "SMOKE FAIL: analysis never completed (still on loading state)"
  fail=1
fi
[ $fail -eq 0 ] && echo "smoke ok: deep link renders a full analysis"
exit $fail
