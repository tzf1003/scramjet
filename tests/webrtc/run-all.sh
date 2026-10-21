#!/bin/sh
# Reproduce the local WebRTC test suite.
# Requires: pnpm install, a built Scramjet bundle, Docker, OpenSSL.
set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$dir/../.." && pwd)

echo "== unit policy tests =="
node --experimental-strip-types --test "$dir/unit/webrtc.test.ts"
node --test "$dir/unit/credentials.test.mjs"

echo "== quality regression gate =="
node "$dir/check-quality.mjs"

echo "== real TURN, fault injection and browser suites =="
python3 "$dir/run-browser-suite.py" --output "${WEBRTC_EVIDENCE_DIR:-$dir/artifacts/browser-matrix}"
