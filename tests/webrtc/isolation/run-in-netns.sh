#!/bin/bash
# Supervise an isolated browser while the runner/services stay on the host.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "run-in-netns.sh must run as root" >&2; exit 1; fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NETNS=${NETNS:-sjclient}
HOST_IF=${HOST_IF:-sjveth0}
NS_IF=${NS_IF:-sjveth1}
HOST_IP=${HOST_IP:-10.200.0.1}
NS_IP=${NS_IP:-10.200.0.2}
HOST_IPV6=${HOST_IPV6:-fd42:736a:1::1}
NS_IPV6=${NS_IPV6:-fd42:736a:1::2}
: "${SCRAMJET_HOST:=$HOST_IP}"
: "${SCRAMJET_PORT:=4500}"
: "${TURN_HOST:=$HOST_IP}"
: "${TURN_PORT:=13478}"
export SCRAMJET_HOST SCRAMJET_PORT TURN_HOST TURN_PORT
export WEBRTC_RUN_ID=${WEBRTC_RUN_ID:-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')}
if ip netns list | awk '{print $1}' | grep -Fxq "$NETNS" || ip link show "$HOST_IF" >/dev/null 2>&1; then
 echo "isolation namespace/interface already exists; choose a task-owned name" >&2; exit 1
fi
shift_args=("$@")
if [ "${shift_args[0]:-}" = "--" ]; then shift_args=("${shift_args[@]:1}"); fi
if [ "${#shift_args[@]}" -eq 0 ]; then echo "a host-side test command is required" >&2; exit 1; fi
: "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:?set the installed Chromium executable path}"
STAGING=$(mktemp -d)
RUN_PID=""
CAPTURE_PID=""
NAT_ADDED=0
NAT6_ADDED=0
FORWARD_BEFORE=""
FORWARD6_BEFORE=""
cleanup() {
 set +e
 if [ -n "$RUN_PID" ]; then kill "$RUN_PID" 2>/dev/null; fi
 if [ -n "$CAPTURE_PID" ]; then kill -INT "$CAPTURE_PID" 2>/dev/null; wait "$CAPTURE_PID" 2>/dev/null; fi
 ip netns pids "$NETNS" | xargs -r kill 2>/dev/null
 ip netns del "$NETNS" 2>/dev/null
 ip link del "$HOST_IF" 2>/dev/null
 if [ "$NAT_ADDED" = 1 ]; then
  iptables -t nat -D POSTROUTING -s "$NS_IP/32" -j MASQUERADE
  iptables -D FORWARD -s "$NS_IP/32" -j ACCEPT
  iptables -D FORWARD -d "$NS_IP/32" -j ACCEPT
 fi
 if [ "$NAT6_ADDED" = 1 ]; then
  ip6tables -t nat -D POSTROUTING -s "$NS_IPV6/128" -j MASQUERADE
  ip6tables -D FORWARD -s "$NS_IPV6/128" -j ACCEPT
  ip6tables -D FORWARD -d "$NS_IPV6/128" -j ACCEPT
 fi
  if [ -n "$FORWARD_BEFORE" ]; then printf '%s\n' "$FORWARD_BEFORE" >/proc/sys/net/ipv4/ip_forward; fi
 if [ -n "$FORWARD6_BEFORE" ]; then printf '%s\n' "$FORWARD6_BEFORE" >/proc/sys/net/ipv6/conf/all/forwarding; fi
 rm -rf "$STAGING"
}
trap cleanup EXIT INT TERM
ip netns add "$NETNS"
ip link add "$HOST_IF" type veth peer name "$NS_IF"
ip link set "$NS_IF" netns "$NETNS"
ip addr add "$HOST_IP/24" dev "$HOST_IF"
ip -6 addr add "$HOST_IPV6/64" dev "$HOST_IF" nodad
ip link set "$HOST_IF" up
ip netns exec "$NETNS" ip addr add "$NS_IP/24" dev "$NS_IF"
ip netns exec "$NETNS" ip -6 addr add "$NS_IPV6/64" dev "$NS_IF" nodad
ip netns exec "$NETNS" ip link set "$NS_IF" up
ip netns exec "$NETNS" ip link set lo up
ip netns exec "$NETNS" ip route add default via "$HOST_IP"
ip netns exec "$NETNS" ip -6 route add default via "$HOST_IPV6"
if [ "${MASQUERADE:-0}" = 1 ]; then
 FORWARD_BEFORE=$(cat /proc/sys/net/ipv4/ip_forward)
 printf '1\n' >/proc/sys/net/ipv4/ip_forward
 iptables -t nat -A POSTROUTING -s "$NS_IP/32" -j MASQUERADE
 iptables -I FORWARD -s "$NS_IP/32" -j ACCEPT
 iptables -I FORWARD -d "$NS_IP/32" -j ACCEPT
 NAT_ADDED=1

 if [ -n "${TURN_HOST_V6:-}" ]; then
  FORWARD6_BEFORE=$(cat /proc/sys/net/ipv6/conf/all/forwarding)
  printf '1\n' >/proc/sys/net/ipv6/conf/all/forwarding
  ip6tables -t nat -A POSTROUTING -s "$NS_IPV6/128" -j MASQUERADE
  ip6tables -I FORWARD -s "$NS_IPV6/128" -j ACCEPT
  ip6tables -I FORWARD -d "$NS_IPV6/128" -j ACCEPT
  NAT6_ADDED=1

 fi
fi
# A browser process tree can only enter this namespace through this root-owned wrapper.
cat >"$STAGING/chromium" <<'EOF'
#!/bin/bash
set -euo pipefail
exec ip netns exec "$WEBRTC_NETNS" "$PLAYWRIGHT_CHROMIUM_EXECUTABLE" "$@"
EOF
chmod 700 "$STAGING/chromium"
export WEBRTC_NETNS="$NETNS" RUNWAY_BROWSER_EXECUTABLE="$STAGING/chromium"
export RUNWAY_HARNESS_HOST="$HOST_IP" RUNWAY_TEST_HOST="$HOST_IP" RUNWAY_TURN_HOST="$TURN_HOST"
export RUNWAY_CHROMIUM_ARGS="${RUNWAY_CHROMIUM_ARGS:-} --no-sandbox --unsafely-treat-insecure-origin-as-secure=http://$HOST_IP:$SCRAMJET_PORT"
export SCRAMJET_EXTRA_TCP_PORTS="${SCRAMJET_EXTRA_TCP_PORTS:-18081,18083}"
export WEBRTC_SIGNAL_PORT="${WEBRTC_SIGNAL_PORT:-18083}"
export UNAUTHORIZED_TCP_URL="${UNAUTHORIZED_TCP_URL:-http://$HOST_IP:18084/}"
export UNAUTHORIZED_UDP_TARGET="${UNAUTHORIZED_UDP_TARGET:-$HOST_IP:18084}"
export UNAUTHORIZED_IPV6_TCP_URL="${UNAUTHORIZED_IPV6_TCP_URL:-http://[$HOST_IPV6]:18084/}"
export UNAUTHORIZED_IPV6_UDP_TARGET="${UNAUTHORIZED_IPV6_UDP_TARGET:-[$HOST_IPV6]:18084}"
export UNAUTHORIZED_DNS_TARGET="${UNAUTHORIZED_DNS_TARGET:-$HOST_IP:53}"
export REQUIRE_IPV6=1 ALLOW_LOOPBACK=0
ip netns exec "$NETNS" sh "$SCRIPT_DIR/setup-nftables.sh"
ip netns exec "$NETNS" sh "$SCRIPT_DIR/verify-isolation.sh"
if [ "${WEBRTC_DIRECT_CONTROL:-1}" = 1 ]; then
 node "$SCRIPT_DIR/browser-control.mjs"
 ip netns exec "$NETNS" sh "$SCRIPT_DIR/verify-isolation.sh"
fi
EXPECTED_DIGEST=$(ip netns exec "$NETNS" python3 "$SCRIPT_DIR/policy.py" digest)
export WEBRTC_TEST_MODE=enforced
export WEBRTC_EVIDENCE_DIR=${EVIDENCE_DIR:-$STAGING}
if [ -n "${EVIDENCE_DIR:-}" ]; then
 mkdir -p "$EVIDENCE_DIR"
 ip netns exec "$NETNS" tcpdump -U -i any -nn -w "$EVIDENCE_DIR/client.pcap" >/dev/null 2>&1 &
 CAPTURE_PID=$!
fi
"${shift_args[@]}" &
RUN_PID=$!
# Loss or mutation of the attested policy terminates both the browser and the run.
while kill -0 "$RUN_PID" 2>/dev/null; do
 CURRENT_DIGEST=$(ip netns exec "$NETNS" python3 "$SCRIPT_DIR/policy.py" digest 2>/dev/null) || CURRENT_DIGEST=invalid
 if [ "$CURRENT_DIGEST" != "$EXPECTED_DIGEST" ]; then
  ip netns pids "$NETNS" | xargs -r kill 2>/dev/null || true
  kill "$RUN_PID" 2>/dev/null || true
  wait "$RUN_PID" 2>/dev/null || true
  RUN_PID=""
  echo "network isolation policy changed; supervised browser stopped" >&2
  exit 1
 fi
 sleep 0.5
done
set +e
wait "$RUN_PID"
RESULT=$?
RUN_PID=""
set -e
ip netns exec "$NETNS" sh "$SCRIPT_DIR/verify-isolation.sh"
exit "$RESULT"
