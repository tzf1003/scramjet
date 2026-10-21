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
CREDENTIAL_SESSION_SECRET=... \
TURN_URLS='turns:turn.example.com:5349?transport=tcp,turn:turn.example.com:3478?transport=udp' \
TURN_TTL=120 PORT=8081 \
node tests/webrtc/server/credential-server.mjs
```

Reverse-proxy it on the **same origin** as the Scramjet controller at
`/turn-credentials`. Same-origin avoids CORS and keeps the credential path out of
the proxied URL namespace. The service returns:

```json
{
	"urls": ["turn:turn.example.com:3478?transport=udp"],
	"username": "1700000000:opaque-id",
	"credential": "<base64-hmac>",
	"ttl": 120
}
```

The HMAC secret stays in the service/coturn environment. Do not put it in the
browser config, the repository, or logs.

The endpoint requires an authenticated session by default. The application backend
calls the exported `signCredentialSession(userId, sessionSecret, expirySeconds)`
after its own login succeeds, and sets the returned token in the same-origin
`__Host-scramjet-turn-session` cookie with `HttpOnly; Secure; SameSite=Strict; Path=/`.
The Controller and injected client use `credentials: "same-origin"`; this cookie
stays outside the proxied page's virtual cookie jar. Backend integrations can use
the same signed token as a Bearer credential. Keep `CREDENTIAL_SESSION_SECRET`
separate from the TURN secret.

`CREDENTIAL_RATE_LIMIT` defaults to 30 issuances per minute per source address and
per authenticated user. The service rejects malformed paths, expired sessions,
and inaccessible/invalid revocation state. For multiple service replicas, enforce
an aggregate limit at the authenticated reverse proxy as well.

Set `CREDENTIAL_REVOKED_USERS_FILE` to a server-side JSON array of revoked user IDs;
replace the file atomically. Revocation stops new issuance immediately. Existing
TURN bearer credentials remain usable until their TTL; 120 seconds is the default.
Immediate termination of every existing allocation requires restarting Coturn
after replacing the TURN secret. Stop issuance during that operation, replace the
shared secret in both services, recreate Coturn, then resume issuance. This also
terminates active calls; applications should reconnect and renegotiate using fresh
credentials. `TURN_STATIC_AUTH_SECRET_FILE` lets the credential service reread a
protected secret file on each issuance. The Coturn process reads its configured
secret at startup. Restart the credential service when rotating the session key.

`start-test-stack.sh` explicitly enables `ALLOW_ANONYMOUS_TEST_ONLY=1` for its local
or CI fixtures. Direct Compose deployments default to authenticated mode. Use the
authenticated configuration above for deployed services.

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
expiry and applies them to live connections. When credentials or TURN URLs change
on a connected peer, it calls native `restartIce()`. The application must handle
`negotiationneeded` and exchange the resulting offer/answer; the Hook does not
supply application signaling. If refreshed configuration cannot be applied, or
credentials expire before refresh, fail-closed/enforced connections close. If the endpoint is unavailable, new
PeerConnections throw `NotSupportedError` and never fall back to direct ICE.

The injected policy is deeply frozen, including its ICE-server URL arrays, and
the client locks the references used for subcontext inheritance. Browser TURN
username/password pairs remain visible to page JavaScript through native
`getConfiguration()`, the injected configuration and the credential endpoint.
Issue them per session with short TTLs, quotas, peer ACLs and revocation; keep
server signing secrets on the server. A deployment requiring browser bearer
credentials to be hidden from proxied JavaScript needs a privileged/native broker.

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
2. Start the host-side Runway services and supervise Chromium through the launcher:

   ```sh
    CHROMIUM_EXECUTABLE=$(pnpm --dir packages/runway exec node --input-type=module \
      -e 'import {chromium} from "playwright"; console.log(chromium.executablePath())')
    sudo env PATH="$PATH" SCRAMJET_HOST=10.200.0.1 SCRAMJET_PORT=4500 \
     TURN_HOST=10.200.0.1 TURN_PORT=13478 \
      PLAYWRIGHT_CHROMIUM_EXECUTABLE="$CHROMIUM_EXECUTABLE" \
      TURN_CREDENTIALS_URL=http://10.200.0.1:18081/turn-credentials \
      EVIDENCE_DIR="$PWD/tests/webrtc/artifacts/enforced" \
      tests/webrtc/isolation/run-in-netns.sh -- \
      pnpm --dir packages/runway test webrtc-relay-datachannel --parallel 1
   ```

   `run-in-netns.sh` creates `10.200.0.2` (client) and `10.200.0.1` (host),
   installs nftables atomically, runs IPv4/IPv6 and DNS probes, and executes the
   test command on the host. Only Chromium is launched inside the namespace.
   The host runs the Harness, Wisp, target and signaling services. Explicit
   permitted service ports default to 4500, 4501, 18081 and 18083. Broad ephemeral
   port allowances and unrestricted established-flow allowances are not used.
   The launcher performs a real native-browser direct-connect negative control,
   captures client packets and stops the run if its attested rule digest changes.
   Root, Python 3, iproute2, nftables, tcpdump and `setpriv` are required for
   setup/supervision. Chromium runs as UID/GID 65534 by default (override with
   `WEBRTC_BROWSER_UID`/`WEBRTC_BROWSER_GID`, both non-root), with supplementary
   groups/capabilities cleared, `no_new_privs` set and its native sandbox enabled.
   A root-owned wrapper supplies a private browser-writable profile and rejects
   sandbox-disabling flags. The host must support unprivileged user namespaces;
   unsupported sandbox startup fails the run. Plain-HTTP secure-origin exceptions
   are for the local test harness; use HTTPS for deployment.

   Container images share the host kernel and its AppArmor policy. Ubuntu 23.10+
   may restrict the unprivileged user namespaces needed by Chromium; deployments
   on these hosts need an AppArmor profile that permits the browser's user
   namespaces. The enforced-isolation CI job uses an Ubuntu 22.04 host and probes
   user-namespace creation under the browser's UID and capability restrictions
   before running the suites.

3. Configure coturn's external address for that namespace:
   `TURN_EXTERNAL_IP=10.200.0.1/<container-ip>`, and include the client's peer
   address in `TURN_ALLOWED_PEER_IP` only for tests.
4. Set `networkIsolationVerified: true` **only after** step 2's verifier passes.
   Without it the client refuses to create any PeerConnection.

`relay` mode remains available for browsers that cannot be placed behind this
boundary, with this explicit limit: JavaScript hooks cannot stop an unpatched
browser or an uninjected realm from using direct UDP.

The launcher uses `10.200.0.2` and `fd42:736a:1::2` for the client, and the
corresponding `.1`/`::1` addresses for host services. Set `TURN_HOST_V6` and provide
IPv6 TURN URLs to test an IPv6-reachable Coturn. `MASQUERADE=1` enables task-scoped
IPv4 forwarding/NAT (and IPv6 when `TURN_HOST_V6` is set), restoring the previous
forwarding state at cleanup. Use this only in an owned test runner/container.
Configure explicit `DNS_HOST`/`DNS_HOST_V6` resolver addresses when hostname
resolution is required; other DNS egress remains blocked. The JavaScript flag is
a deployment attestation, not a browser API that can inspect kernel rules.

The launcher retains its static IPv6 addresses during a link outage. The outer
fault runner also restores the original addresses and default routes before
rebuilding the signaling transport and native peers. In a multi-interface TURN
deployment, set explicit Coturn `--relay-ip` addresses and matching external-IP
mappings. The Linux test runner pins its IPv4/IPv6 relay bindings so a server
restart cannot select the client's temporary veth as a new allocation interface.

For an existing isolated deployment, `setup-nftables.sh` can install the same
policy directly. Its transaction validates addresses, ports and identifiers and
preserves the previous policy on failure. `verify-isolation.sh` validates the complete generated endpoint allowlist and
uses temporary counter-only observations before the final deny. Extra rules,
changed verdicts, duplicate markers or a different base-chain policy fail
verification.
Do not run that mutating verifier concurrently with the launcher's policy monitor.

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

# Real TURN DataChannel/media/concurrency tests through the Scramjet harness
# (the repository's Runway script needs Node 24)
cd packages/runway
WEBRTC_FAKE_MEDIA=1 WEBRTC_EXPOSE_HOST_CANDIDATES=1 \
  TURN_CREDENTIALS_URL=http://127.0.0.1:18081/turn-credentials \
  npx -y node@24 --experimental-strip-types --no-warnings \
  src/index.ts webrtc- --parallel 1
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

## 8. Acceptance runners and recovery

The shared TURN fault suite runs with one test worker; its individual tests cover
multiple simultaneous PeerConnections and DataChannels. The runner rejects a
larger `--parallel` value because stopping that shared TURN would invalidate
unrelated tests. `run-browser-suite.py` owns and removes only its test containers.

```sh
rtk env PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers python3 tests/webrtc/run-browser-suite.py --output /Volumes/1T/scramjet/verification/browser-matrix
rtk docker build -f tests/webrtc/isolation/Dockerfile -t scramjet-webrtc-linux-verification:local .
rtk python3 tests/webrtc/isolation/run-linux-suite.py --output /Volumes/1T/scramjet/verification/linux-ipv4
rtk python3 tests/webrtc/isolation/run-linux-suite.py --ipv6 --output /Volumes/1T/scramjet/verification/linux-ipv6
```

`TURN_CLIENT_RELAY_RANGE=0` is the installer default: the client can reach only
the authorized TURN listeners. `TURN_CLIENT_RELAY_RANGE=1` explicitly authorizes
UDP to the **same TURN addresses** within `TURN_RELAY_MIN..TURN_RELAY_MAX`. The
shared-Coturn integration/NAT topology uses this bounded allowance. Its value is
included as `clientRelayRange` in `policy.json` and honored by the packet analyzer.
The TURN-side firewall must allow its relay range in either case. Peer forwarding
ACLs and authentication remain enforced by Coturn.

After a TURN restart, applications rebuild a failed native PeerConnection and
DataChannel and exchange fresh descriptions. After a network interface or tunnel
failure, restore the network boundary first, then restore the application's
signaling transport. The reference Harness initializes a fresh Libcurl transport
and passes it to `Controller.setTransport()` before rebuilding peers. Existing
failed SCTP channels are not reused as proof of recovery. The namespace runner
restores the exact owned IPv4/IPv6 addresses and routes after its deliberate link
fault; rules remain installed throughout.

Each runner writes a source hash (including added files), Git revision, run ID,
commands/results and artifact hashes. Linux runs include a normal client capture
and a separate native direct-connect negative-control capture. The analyzer must
accept the normal capture and detect unauthorized traffic in the control capture.
See `webrtc-device-validation.md` for real-device and public-network procedures.
