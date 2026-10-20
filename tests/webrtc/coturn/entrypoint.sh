#!/bin/sh
set -eu

: "${TURN_STATIC_AUTH_SECRET:?TURN_STATIC_AUTH_SECRET is required}"

set -- -c /etc/coturn/turnserver.conf \
	--static-auth-secret="$TURN_STATIC_AUTH_SECRET" \
	--realm="${TURN_REALM:-scramjet.webrtc}" \
	--listening-port="${TURN_LISTENING_PORT:-3478}" \
	--tls-listening-port="${TURN_TLS_PORT:-5349}" \
	--min-port="${TURN_MIN_PORT:-49160}" \
	--max-port="${TURN_MAX_PORT:-49200}"

if [ -n "${TURN_EXTERNAL_IP:-}" ]; then
	set -- "$@" "--external-ip=$TURN_EXTERNAL_IP"
fi

if [ -n "${TURN_ALLOWED_PEER_IP:-}" ]; then
	old_ifs=$IFS
	IFS=,
	for peer in $TURN_ALLOWED_PEER_IP; do
		if [ -n "$peer" ]; then
			set -- "$@" "--allowed-peer-ip=$peer"
		fi
	done
	IFS=$old_ifs
fi

if [ -n "${TURN_EXTRA_ARGS:-}" ]; then
	# Intentional word splitting for operator-supplied CLI flags.
	# shellcheck disable=SC2086
	set -- "$@" $TURN_EXTRA_ARGS
fi

exec turnserver "$@"
