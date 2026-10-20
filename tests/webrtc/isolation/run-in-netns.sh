#!/bin/bash
# Create a client network namespace with a fail-closed egress policy and run a
# command inside it. Linux only; needs root and iproute2/nftables.
#
# Example:
#   sudo env TURN_HOST=10.200.0.1 TURN_PORT=13478 \
#     UNAUTHORIZED_UDP_TARGET=1.1.1.1:19302 \
#     SCRAMJET_HOST=10.200.0.1 SCRAMJET_PORT=4500 \
#     ./run-in-netns.sh -- <command>
#
# The namespace address is 10.200.0.2, the host side is 10.200.0.1. Services
# reachable from the namespace must listen on 0.0.0.0 (or 10.200.0.1).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
	echo "run-in-netns.sh must run as root" >&2
	exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NETNS=${NETNS:-sjclient}
HOST_IF=${HOST_IF:-sjveth0}
NS_IF=${NS_IF:-sjveth1}
HOST_IP=${HOST_IP:-10.200.0.1}
NS_IP=${NS_IP:-10.200.0.2}
: "${SCRAMJET_HOST:=10.200.0.1}"
: "${SCRAMJET_PORT:=4500}"
: "${TURN_HOST:=10.200.0.1}"
: "${TURN_PORT:=13478}"
export SCRAMJET_HOST SCRAMJET_PORT TURN_HOST TURN_PORT

cleanup() {
	set +e
	ip netns del "$NETNS" 2>/dev/null
	ip link del "$HOST_IF" 2>/dev/null
}
trap cleanup EXIT INT TERM

cleanup
ip netns add "$NETNS"
ip link add "$HOST_IF" type veth peer name "$NS_IF"
ip link set "$NS_IF" netns "$NETNS"
ip addr add "$HOST_IP/24" dev "$HOST_IF"
ip link set "$HOST_IF" up
ip netns exec "$NETNS" ip addr add "$NS_IP/24" dev "$NS_IF"
ip netns exec "$NETNS" ip link set "$NS_IF" up
ip netns exec "$NETNS" ip link set lo up
ip netns exec "$NETNS" ip route add default via "$HOST_IP"
sysctl -qw net.ipv4.ip_forward=1

# Optional NAT for external TURN/public peers.
if [ "${MASQUERADE:-0}" = "1" ]; then
	iptables -t nat -C POSTROUTING -s "$NS_IP/32" -j MASQUERADE 2>/dev/null ||
		iptables -t nat -A POSTROUTING -s "$NS_IP/32" -j MASQUERADE
fi

ip netns exec "$NETNS" env \
	SCRAMJET_HOST="$SCRAMJET_HOST" SCRAMJET_PORT="$SCRAMJET_PORT" \
	SCRAMJET_WISP_PORT="${SCRAMJET_WISP_PORT:-4501}" \
	TURN_HOST="$TURN_HOST" TURN_PORT="$TURN_PORT" \
	TURN_TLS_PORT="${TURN_TLS_PORT:-15349}" \
	TURN_RELAY_MIN="${TURN_RELAY_MIN:-50160}" \
	TURN_RELAY_MAX="${TURN_RELAY_MAX:-50200}" \
	DNS_HOST="${DNS_HOST:-}" ALLOW_LOOPBACK="${ALLOW_LOOPBACK:-1}" \
	TARGET_TCP_RANGE="${TARGET_TCP_RANGE:-}" \
	sh "$SCRIPT_DIR/setup-nftables.sh"

if [ "${SKIP_VERIFY:-0}" != "1" ]; then
	ip netns exec "$NETNS" env \
		TURN_HOST="$TURN_HOST" TURN_PORT="$TURN_PORT" \
		UNAUTHORIZED_UDP_TARGET="${UNAUTHORIZED_UDP_TARGET:-1.1.1.1:19302}" \
		EVIDENCE_DIR="${EVIDENCE_DIR:-}" \
		sh "$SCRIPT_DIR/verify-isolation.sh"
fi

shift_args=("$@")
if [ "${shift_args[0]:-}" = "--" ]; then
	shift_args=("${shift_args[@]:1}")
fi
if [ "${#shift_args[@]}" -eq 0 ]; then
	echo "no command given; namespace is ready until this script exits" >&2
	exit 0
fi

ip netns exec "$NETNS" env \
	RUNWAY_HARNESS_HOST="$HOST_IP" RUNWAY_TEST_HOST="$HOST_IP" \
	RUNWAY_TURN_HOST="$TURN_HOST" \
	"${shift_args[@]}"
