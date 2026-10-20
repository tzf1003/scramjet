# Enforced isolation scripts

These scripts install a default-deny egress policy for a WebRTC client. They are
Linux-only (nftables). `run-in-netns.sh` requires root and creates the veth pair
and namespace; `setup-nftables.sh` can also be run inside a container namespace.

## Quick container check (works on macOS Docker)

```sh
docker compose -f tests/webrtc/isolation/docker-compose.yml up -d
C=$(docker compose -f tests/webrtc/isolation/docker-compose.yml ps -q client)
SERVER_IP=$(docker exec "$C" getent hosts server | awk '{print $1}')

# Negative control: internet is reachable before the rules.
docker exec "$C" bash -c "timeout 3 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' && echo reachable"

docker exec "$C" env SCRAMJET_HOST="$SERVER_IP" SCRAMJET_PORT=8080 \
  TURN_HOST="$SERVER_IP" TURN_PORT=80 \
  sh /repo/tests/webrtc/isolation/setup-nftables.sh

docker exec "$C" env TURN_HOST="$SERVER_IP" TURN_PORT=80 \
  UNAUTHORIZED_UDP_TARGET=1.1.1.1:19302 EVIDENCE_DIR=/repo/tests/webrtc/artifacts \
  sh /repo/tests/webrtc/isolation/verify-isolation.sh
```

Expected: verifier prints `ok:true` with `deniedAfter > deniedBefore`; the same
internet probe now times out.

## Linux namespace

```sh
sudo env SCRAMJET_HOST=10.200.0.1 SCRAMJET_PORT=4500 \
  TURN_HOST=10.200.0.1 TURN_PORT=13478 \
  UNAUTHORIZED_UDP_TARGET=1.1.1.1:19302 \
  tests/webrtc/isolation/run-in-netns.sh -- <browser command>
```

The namespace uses `10.200.0.2` (client) and `10.200.0.1` (host). Configure
coturn with `TURN_EXTERNAL_IP=10.200.0.1/<container-ip>` and include the client
peer only in `TURN_ALLOWED_PEER_IP` for tests.

## Test-only allowances

The Runway browser test needs a direct TCP path for its ephemeral signaling
server and for the browser to reach the harness. Production rules should not
allow arbitrary target ports. In the namespace, the Scramjet origin/Wisp ports
and TURN ports are the only production flows; add test-only ports explicitly for
the test harness, or run the signaling server through an allowed origin.

`ALLOW_LOOPBACK=1` is the default for local tests. Set it to `0` in production;
otherwise a local target peer can bypass the relay over loopback.

`TARGET_TCP_RANGE` is a test-only allowance for Runway's ephemeral target /
signaling ports (e.g. `10000-65535`). Do not set it in production; production
flows are Scramjet/Wisp and TURN only.

## Chromium policies

- `chromium-policy-defense-in-depth.json` (`default_public_interface_only`) hides
  private host candidates but is not a boundary.
- `chromium-policy-proxy-only.json` (`disable_non_proxied_udp`) blocks all
  non-proxied UDP and breaks TURN/UDP; it is not compatible with relay mode.

nftables is the authoritative control. Do not claim enforced isolation from a
browser policy file alone.
