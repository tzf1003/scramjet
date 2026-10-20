#!/bin/sh
# Generate a self-signed TLS certificate for local coturn tests. Never commit
# the generated key. Production deployments must mount a real certificate.
set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/certs
mkdir -p "$dir"

if [ -f "$dir/turn.crt" ] && [ -f "$dir/turn.key" ]; then
	echo "certificates already exist in $dir"
	exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes \
	-keyout "$dir/turn.key" \
	-out "$dir/turn.crt" \
	-days 30 \
	-subj "/CN=localhost" \
	-addext "subjectAltName=DNS:localhost,DNS:turn.local,IP:127.0.0.1,IP:::1" \
	>/dev/null 2>&1

echo "wrote $dir/turn.crt and $dir/turn.key (test-only, 30 days)"
