#!/bin/sh
# Capture TURN control + relay traffic while running a test command, then print
# a tshark summary. Requires Docker and the coturn container from
# tests/webrtc/docker-compose.yml.
#
# Usage:
#   sh tests/webrtc/capture/capture-turn.sh -- \
#     env TURN_CREDENTIALS_URL=... pnpm --dir packages/runway test webrtc-relay-datachannel
set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pcap=${PCAP:-$dir/turn.pcap}
container=${COTURN_CONTAINER:-scramjet-webrtc-coturn-1}
capture=sj-capture

if [ "${1:-}" = "--" ]; then
	shift
fi
if [ "$#" -eq 0 ]; then
	echo "capture-turn.sh requires a command after --" >&2
	exit 1
fi

mkdir -p "$dir"
docker rm -f "$capture" >/dev/null 2>&1 || true

cleanup() {
	docker kill -s INT "$capture" >/dev/null 2>&1 || true
	sleep 1
	docker rm -f "$capture" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run -d --name "$capture" \
	--network "container:$container" \
	--cap-add NET_ADMIN --cap-add NET_RAW \
	-v "$dir:/capture" \
	nicolaka/netshoot \
	tcpdump -i any -nn -w /capture/$(basename "$pcap") \
	'udp or tcp port 13478 or tcp port 15349 or udp portrange 50160-50200'
sleep 1

"$@"

cleanup
trap - EXIT INT TERM
sleep 1

echo "captured $pcap"
docker run --rm -v "$dir:/capture" nicolaka/netshoot sh -c "
	pcap=/capture/$(basename "$pcap")
	echo \"total=\$(tshark -r \$pcap -T fields -e frame.number | wc -l)\"
	echo 'stun types:'
	tshark -r \$pcap -Y stun -T fields -e stun.type | sort | uniq -c
	echo \"dtls=\$(tshark -r \$pcap -Y dtls -T fields -e frame.number | wc -l)\"
	echo \"relay_udp=\$(tshark -r \$pcap -Y 'udp.port>=50160 && udp.port<=50200' -T fields -e frame.number | wc -l)\"
	echo \"turn_tcp=\$(tshark -r \$pcap -Y 'tcp.port==13478' -T fields -e frame.number | wc -l)\"
	echo \"turn_tls=\$(tshark -r \$pcap -Y 'tcp.port==15349' -T fields -e frame.number | wc -l)\"
" | tee "$dir/summary.txt"
