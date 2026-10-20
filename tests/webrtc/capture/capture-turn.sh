#!/bin/sh
# Capture task-owned TURN traffic and always retain diagnostics from failed tests.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUTPUT=${WEBRTC_EVIDENCE_DIR:-$DIR}
RUN_ID=${WEBRTC_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}
CONTAINER=${COTURN_CONTAINER:-scramjet-webrtc-coturn-1}
CAPTURE=sj-capture-$RUN_ID
if [ "${1:-}" = "--" ]; then shift; fi
if [ "$#" -eq 0 ]; then echo "capture-turn.sh requires a test command" >&2; exit 1; fi
mkdir -p "$OUTPUT"
cleanup() {
 docker kill -s INT "$CAPTURE" >/dev/null 2>&1 || true
 docker wait "$CAPTURE" >/dev/null 2>&1 || true
 docker rm "$CAPTURE" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker run -d --name "$CAPTURE" --network "container:$CONTAINER" \
 --cap-add NET_RAW -v "$OUTPUT:/capture" nicolaka/netshoot \
 tcpdump -U -i any -nn -w /capture/turn.pcap 'udp or tcp' >/dev/null
sleep 1
set +e
WEBRTC_RUN_ID="$RUN_ID" WEBRTC_EVIDENCE_DIR="$OUTPUT" "$@"
RESULT=$?
set -e
cleanup
trap - EXIT INT TERM
docker run --rm -v "$OUTPUT:/capture" -v "$DIR:/scripts:ro" nicolaka/netshoot \
 python3 /scripts/summarize-pcap.py /capture/turn.pcap --run-id "$RUN_ID" --output /capture/pcap-summary.json
exit "$RESULT"
