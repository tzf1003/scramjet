# WebRTC Deployment Guide

This guide deploys **relay** mode (web-only TURN takeover) and the optional
**enforced** mode (TURN + OS network isolation). Read
`docs/webrtc-architecture.md` and `docs/webrtc-security.md` first.

## 1. Components

| Component                            | Purpose                                            | Reference files                                          |
| ------------------------------------ | -------------------------------------------------- | -------------------------------------------------------- |
| Scramjet controller + service worker | Injects the WebRTC policy and proxies page traffic | `packages/core`, `packages/controller`                   |
| coturn                               | TURN/UDP, TURN/TCP, TURN/TLS relay                 | `tests/webrtc/coturn`, `tests/webrtc/docker-compose.yml` |
| credential service                   | Issues HMAC time-limited TURN credentials          | `tests/webrtc/server/credential-server.mjs`              |
| nftables/namespace scripts           | Enforced egress boundary                           | `tests/webrtc/isolation`                                 |

## 2. Configure coturn

1. Generate a shared secret and a TLS certificate:

   ```sh
   openssl rand -hex 32                       # TURN_STATIC_AUTH_SECRET
   sh tests/webrtc/coturn/generate-certs.sh   # local test certificate
   ```

   Production: mount a real certificate/key at `/etc/coturn/certs/turn.crt` and
   `turn.key`. Never commit private keys.

2. Copy `tests/webrtc/.env.example` to `tests/webrtc/.env`, set the secret, the
   externally reachable TURN address, and `TURN_URLS`.

   `TURN_EXTERNAL_IP` uses coturn's `public/private` form:
   - `127.0.0.1/172.29.0.10` for local Docker tests;
   - `203.0.113.10/10.0.0.10` for a NATed host with a public address.

3. Start it:

   ```sh
   docker compose -f tests/webrtc/docker-compose.yml --env-file tests/webrtc/.env up -d
   docker compose -f tests/webrtc/docker-compose.yml --env-file tests/webrtc/.env ps
   ```

4. Firewall the relay port range and the TURN listeners. Only the client
   namespace should reach them. Keep the coturn CLI disabled (`no-cli` is set).

5. Verify an allocation with real TURN (inside the coturn container for local
   tests):

   ```sh
   CREDS=$(curl -s http://127.0.0.1:18081/turn-credentials)
   U=$(printf '%s' "$CREDS" | jq -r .username)
   W=$(printf '%s' "$CREDS" | jq -r .credential)
   docker exec <coturn-container> turnutils_uclient -u "$U" -w "$W" \
     -p 13478 -n 3 -m 1 -e 172.29.0.10 -r 3480 172.29.0.10
   ```

   The test stack publishes non-standard host ports (13478/15349/50160-50200) to
   avoid conflicts with host services. Change them together in `.env`, the
   compose file, `turnserver.conf`, and the client TURN URLs.

### Private destination policy

`tests/webrtc/coturn/turnserver.conf` denies loopback, RFC1918, link-local,
multicast, documentation, and metadata ranges. This prevents the relay from
being used to reach the client's LAN or a cloud metadata service. Tests that need
a local peer pass `TURN_ALLOWED_PEER_IP`; production should leave it empty.

### Quotas

`total-quota`, `user-quota`, `max-bps`, and lifetime values are deliberately
conservative. Tune them to the deployment. Do not enable anonymous relay.

## 3. Credential endpoint

Serve `tests/webrtc/server/credential-server.mjs` with Node 22+:

```sh
TURN_STATIC_AUTH_SECRET=... \
TURN_URLS='turns:turn.example.com:5349?transport=tcp,turn:turn.example.com:3478?transport=udp' \
TURN_TTL=3600 PORT=8081 \
node tests/webrtc/server/credential-server.mjs
```

Reverse-proxy it on the **same origin** as the Scramjet controller at
`/turn-credentials`. Same-origin avoids CORS and keeps the credential path out of
the proxied URL namespace. The service returns:

```json
{
	"urls": ["turn:turn.example.com:3478?transport=udp"],
	"username": "1700003600:opaque-id",
	"credential": "<base64-hmac>",
	"ttl": 3600
}
```

The HMAC secret stays in the service/coturn environment. Do not put it in the
browser config, the repository, or logs.

## 4. Enable relay mode in Scramjet

```ts
import { Controller } from "@mercuryworkshop/scramjet-controller";

const controller = new Controller({
	serviceworker,
	transport,
	scramjetConfig: {
		webrtc: {
			mode: "relay",
			// Prefetch result is filled in by controller.wait(); an empty list is fine
			// when credentialEndpoint is set.
			iceServers: [],
			credentialEndpoint: "/turn-credentials",
			iceServersExpiresAt: null,
			credentialRefreshRatio: 0.8,
			failClosed: true,
			diagnostics: false,
			networkIsolationVerified: false,
		},
	},
});

// Do not create frames before this resolves: the controller prefetches
// credentials so the first PeerConnection has a usable ICE config.
await controller.wait();
```

The controller resolves the credential endpoint during `ready`; every injected
realm receives a JSON snapshot. The client hook also refreshes credentials before
expiry and applies them to live connections. If the endpoint is unavailable, new
PeerConnections throw `NotSupportedError` and never fall back to direct ICE.

Environment-name mapping used by deployment tooling:

| Variable                            | Runtime field                                               |
| ----------------------------------- | ----------------------------------------------------------- |
| `WEBRTC_MODE`                       | `webrtc.mode`                                               |
| `WEBRTC_TURN_URLS`                  | credential service `TURN_URLS` / `webrtc.iceServers[].urls` |
| `WEBRTC_CREDENTIAL_ENDPOINT`        | `webrtc.credentialEndpoint`                                 |
| `WEBRTC_FAIL_CLOSED`                | `webrtc.failClosed`                                         |
| `WEBRTC_DIAGNOSTICS`                | `webrtc.diagnostics`                                        |
| `WEBRTC_NETWORK_ISOLATION_VERIFIED` | `webrtc.networkIsolationVerified`                           |

## 5. Enforced mode

Enforced mode adds a hard attestation and runtime pair checks, but the actual
boundary is the kernel:

1. Run the browser in a dedicated network namespace (or container) with only the
   Scramjet origin and TURN endpoints reachable.
2. Install the policy inside that namespace:

   ```sh
   sudo env SCRAMJET_HOST=10.200.0.1 SCRAMJET_PORT=4500 \
     TURN_HOST=10.200.0.1 TURN_PORT=13478 \
     UNAUTHORIZED_UDP_TARGET=1.1.1.1:19302 \
     tests/webrtc/isolation/run-in-netns.sh -- <browser/test command>
   ```

   `run-in-netns.sh` creates `10.200.0.2` (client) and `10.200.0.1` (host),
   installs nftables, runs `verify-isolation.sh`, then executes the command.

3. Configure coturn's external address for that namespace:
   `TURN_EXTERNAL_IP=10.200.0.1/<container-ip>`, and include the client's peer
   address in `TURN_ALLOWED_PEER_IP` only for tests.
4. Set `networkIsolationVerified: true` **only after** step 2's verifier passes.
   Without it the client refuses to create any PeerConnection.

`relay` mode remains available for browsers that cannot be placed behind this
boundary, with this explicit limit: JavaScript hooks cannot stop an unpatched
browser or an uninjected realm from using direct UDP.

### Chromium policy

`tests/webrtc/isolation/chromium-policy-defense-in-depth.json` uses
`default_public_interface_only` and can be dropped into
`/etc/opt/chrome/policies/managed/`. It hides private host candidates and is
defence in depth only.

`chromium-policy-proxy-only.json` uses `disable_non_proxied_udp`, which blocks
non-proxied UDP and therefore **breaks TURN/UDP**. It is not compatible with relay
mode and is not the enforced-mode mechanism. Do not present either policy as a
substitute for nftables.

## 6. Verification commands

```sh
# Unit policy tests
node --experimental-strip-types --test tests/webrtc/unit/webrtc.test.ts

# Real TURN DataChannel/media tests through the Scramjet harness
cd packages/runway
TURN_CREDENTIALS_URL=http://127.0.0.1:18081/turn-credentials \
  pnpm test webrtc-relay --parallel 1
```

Set `RUNWAY_BROWSER=firefox|webkit` to run the same suite in another Playwright
browser. Playwright WebKit is not real iOS Safari; see the test report.

## 7. Operational troubleshooting

| Symptom                                        | Check                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `NotSupportedError: no valid TURN credentials` | credential endpoint reachable, controller configured, `await controller.wait()`                                 |
| Connection never leaves `checking`             | TURN host/port reachable, credentials valid, relay range open, peer not denied by coturn                        |
| `unauthorised ICE server survived`             | a second WebRTC hook or browser policy is rewriting `getConfiguration`; remove the conflicting extension/policy |
| `selected local candidate is host`             | browser ignored `iceTransportPolicy`; stop and use enforced mode with nftables                                  |
| TURN/TLS fails in tests                        | self-signed certificate not trusted; use test launch flags or a real certificate                                |
