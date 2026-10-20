#!/bin/sh
# Verify that the installed nftables policy drops unauthorised egress.
# Run inside the same namespace as the browser.
#
# Required:
#   TURN_HOST, TURN_PORT, UNAUTHORIZED_UDP_TARGET (host:port)
# Optional:
#   UNAUTHORIZED_TCP_URL (default http://169.254.169.254/)
#   NFT_TABLE, EVIDENCE_DIR
set -eu

: "${TURN_HOST:?TURN_HOST is required}"
: "${TURN_PORT:?TURN_PORT is required}"
: "${UNAUTHORIZED_UDP_TARGET:?UNAUTHORIZED_UDP_TARGET is required}"

TABLE=${NFT_TABLE:-scramjet_webrtc}
EVIDENCE_DIR=${EVIDENCE_DIR:-}

counter_value() {
	nft list table inet "$TABLE" |
		awk '/scramjet-webrtc-default-deny/ { print $3; exit }'
}

before=$(counter_value)
if [ -z "$before" ]; then
	echo "default-deny counter not found in table inet $TABLE" >&2
	exit 1
fi

# Unauthorised UDP (a stand-in for an arbitrary STUN/direct-ICE destination).
host=${UNAUTHORIZED_UDP_TARGET%:*}
port=${UNAUTHORIZED_UDP_TARGET##*:}
# bash /dev/udp is available on the Linux test runners.
timeout 2 bash -c "printf x > /dev/udp/$host/$port" 2>/dev/null || true

# Cloud metadata / arbitrary TCP.
curl --max-time 2 -sS "${UNAUTHORIZED_TCP_URL:-http://169.254.169.254/}" \
	>/dev/null 2>&1 || true

sleep 1
after=$(counter_value)
if [ -z "$after" ]; then
	echo "could not read the default-deny counter after probes" >&2
	exit 1
fi
if [ "$after" -le "$before" ]; then
	echo "FAIL: default-deny counter did not increase ($before -> $after)" >&2
	exit 1
fi

# Positive control: the TURN TCP listener must still be reachable.
if ! timeout 3 bash -c "exec 3<>/dev/tcp/$TURN_HOST/$TURN_PORT" 2>/dev/null; then
	echo "FAIL: authorised TURN TCP port $TURN_HOST:$TURN_PORT is unreachable" >&2
	exit 1
fi

result=$(printf '{"table":"%s","deniedBefore":%s,"deniedAfter":%s,"turnHost":"%s","turnPort":%s,"ok":true}\n' \
	"$TABLE" "$before" "$after" "$TURN_HOST" "$TURN_PORT")
echo "$result"

if [ -n "$EVIDENCE_DIR" ]; then
	mkdir -p "$EVIDENCE_DIR"
	printf '%s' "$result" >"$EVIDENCE_DIR/isolation.json"
	nft list table inet "$TABLE" >"$EVIDENCE_DIR/nftables.txt"
fi
