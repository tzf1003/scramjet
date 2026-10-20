#!/bin/sh
# Reproduce the local WebRTC test suite.
# Requires: pnpm install, a built Scramjet bundle, Docker, OpenSSL.
set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$dir/../.." && pwd)

echo "== unit policy tests =="
node --experimental-strip-types --test "$dir/unit/webrtc.test.ts"

echo "== coturn + credential service =="
sh "$dir/start-test-stack.sh"

echo "== browser suite (Chromium) =="
(
	cd "$root/packages/runway"
	WEBRTC_FAKE_MEDIA=1 WEBRTC_EXPOSE_HOST_CANDIDATES=1 \
		TURN_CREDENTIALS_URL="${TURN_CREDENTIALS_URL:-http://127.0.0.1:18081/turn-credentials}" \
		PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/tmp/pw-browsers}" \
		npx -y node@24 --experimental-strip-types --no-warnings \
		src/index.ts webrtc- --parallel 1
)

echo "== browser suite (Firefox, no media/worker) =="
(
	cd "$root/packages/runway"
	RUNWAY_BROWSER=firefox WEBRTC_EXPOSE_HOST_CANDIDATES=1 \
		TURN_CREDENTIALS_URL="${TURN_CREDENTIALS_URL:-http://127.0.0.1:18081/turn-credentials}" \
		PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/tmp/pw-browsers}" \
		npx -y node@24 --experimental-strip-types --no-warnings \
		src/index.ts webrtc- --parallel 1
)

echo "== browser suite (WebKit, no media/worker) =="
(
	cd "$root/packages/runway"
	RUNWAY_BROWSER=webkit WEBRTC_EXPOSE_HOST_CANDIDATES=1 \
		TURN_CREDENTIALS_URL="${TURN_CREDENTIALS_URL:-http://127.0.0.1:18081/turn-credentials}" \
		PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/tmp/pw-browsers}" \
		npx -y node@24 --experimental-strip-types --no-warnings \
		src/index.ts webrtc- --parallel 1
)
