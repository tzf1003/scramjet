#!/bin/sh
# Start coturn + the credential service for the WebRTC tests.
set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$dir"

if [ ! -f .env ]; then
	secret=$(openssl rand -hex 32)
	host_ip=""
	if command -v ip >/dev/null 2>&1; then
		host_ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
	elif command -v ipconfig >/dev/null 2>&1; then
		host_ip=$(ipconfig getifaddr en0 2>/dev/null || true)
	fi
	peer_ips="172.29.0.10,172.29.0.1,127.0.0.1"
	if [ -n "$host_ip" ]; then
		peer_ips="$peer_ips,$host_ip"
	fi
	cat >.env <<EOF
TURN_STATIC_AUTH_SECRET=$secret
TURN_REALM=scramjet.webrtc
TURN_EXTERNAL_IP=127.0.0.1/172.29.0.10
TURN_ALLOWED_PEER_IP=$peer_ips
TURN_URLS=turn:127.0.0.1:13478?transport=udp,turn:127.0.0.1:13478?transport=tcp,turns:127.0.0.1:15349?transport=tcp
TURN_TTL=3600
ALLOWED_ORIGIN=*
EOF
	echo "created tests/webrtc/.env with a random TURN secret"
fi

sh coturn/generate-certs.sh
docker compose --env-file .env up -d

# Wait for the credential endpoint health check.
tries=0
until curl -fsS http://127.0.0.1:18081/healthz >/dev/null 2>&1; do
	tries=$((tries + 1))
	if [ "$tries" -gt 50 ]; then
		echo "credential service did not become healthy" >&2
		docker compose --env-file .env logs credentials >&2
		exit 1
	fi
	sleep 0.2
done

echo "WebRTC test stack is ready:"
echo "  coturn:      127.0.0.1:13478 (udp/tcp), 15349 (tls), relay 50160-50200/udp"
echo "  credentials: http://127.0.0.1:18081/turn-credentials"
