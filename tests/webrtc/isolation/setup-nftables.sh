#!/bin/sh
# Install a fail-closed egress policy for a WebRTC client namespace.
#
# Required:
#   SCRAMJET_HOST, SCRAMJET_PORT, TURN_HOST, TURN_PORT
# Optional:
#   SCRAMJET_WISP_PORT (default 4501)
#   TURN_TLS_PORT (default 15349)
#   TURN_RELAY_MIN / TURN_RELAY_MAX (default 50160 / 50200)
#   DNS_HOST, DNS_PORT (default 53)
#   ALLOW_LOOPBACK (1/0, default 1 for local tests)
#   NFT_TABLE (default scramjet_webrtc)
#
# Run inside the client network namespace:
#   ip netns exec sjclient env ... ./setup-nftables.sh
set -eu

: "${SCRAMJET_HOST:?SCRAMJET_HOST is required}"
: "${SCRAMJET_PORT:?SCRAMJET_PORT is required}"
: "${TURN_HOST:?TURN_HOST is required}"
: "${TURN_PORT:?TURN_PORT is required}"

TABLE=${NFT_TABLE:-scramjet_webrtc}
WISP_PORT=${SCRAMJET_WISP_PORT:-4501}
TLS_PORT=${TURN_TLS_PORT:-15349}
RELAY_MIN=${TURN_RELAY_MIN:-50160}
RELAY_MAX=${TURN_RELAY_MAX:-50200}
ALLOW_LOOPBACK=${ALLOW_LOOPBACK:-1}

nft delete table inet "$TABLE" 2>/dev/null || true

{
	cat <<EOF
table inet $TABLE {
	chain output {
		type filter hook output priority 0; policy drop;

		ct state established,related accept
EOF
	if [ "$ALLOW_LOOPBACK" = "1" ]; then
		cat <<EOF
		oif "lo" counter accept comment "scramjet-webrtc-loopback"
EOF
	fi
	cat <<EOF
		ip daddr $SCRAMJET_HOST tcp dport { $SCRAMJET_PORT, $WISP_PORT } counter accept comment "scramjet-proxy"
		ip daddr $TURN_HOST udp dport $TURN_PORT counter accept comment "turn-udp"
		ip daddr $TURN_HOST tcp dport { $TURN_PORT, $TLS_PORT } counter accept comment "turn-tcp-tls"
		ip daddr $TURN_HOST udp dport $RELAY_MIN-$RELAY_MAX counter accept comment "turn-relay-udp"
		ip daddr $TURN_HOST tcp dport $RELAY_MIN-$RELAY_MAX counter accept comment "turn-relay-tcp"
EOF
	if [ -n "${TARGET_TCP_RANGE:-}" ]; then
		cat <<EOF
		ip daddr $SCRAMJET_HOST tcp dport $TARGET_TCP_RANGE counter accept comment "test-target-ports"
EOF
	fi
	if [ -n "${DNS_HOST:-}" ]; then
		cat <<EOF
		ip daddr $DNS_HOST udp dport ${DNS_PORT:-53} counter accept comment "dns-udp"
		ip daddr $DNS_HOST tcp dport ${DNS_PORT:-53} counter accept comment "dns-tcp"
EOF
	fi
	cat <<EOF
		counter drop comment "scramjet-webrtc-default-deny"
	}
}
EOF
} | nft -f -

echo "installed nftables table inet $TABLE"
nft list table inet "$TABLE"
