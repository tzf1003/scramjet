# WebRTC Test Report

Executed: 2026-10-20. This report contains only observed results from this
checkout. Anything not executed is marked **UNVERIFIED**.

## 1. Environment

- macOS 27.0.0 arm64, Node.js 22.23.2 for build, Node.js 24.22.0 for Runway
- Docker 29.8.2 (OrbStack), coturn 4.6.3-alpine, node:22-alpine
- Playwright 1.61.0: Chromium 149, Firefox, WebKit 26.5 (installed under
  `/tmp/pw-browsers`)
- Scramjet bundles built from this checkout with the rewriter wasm built from
  `packages/core/rewriter`

Runner note: the repository's Runway test script needs Node 24; Node 22 cannot
parse an inline-flag regex used by the existing test infrastructure.

## 2. Unit policy tests

```sh
node --experimental-strip-types --test tests/webrtc/unit/webrtc.test.ts
```

Result: **PASS 11/11**.

Covered: config normalisation, off-mode isolation, TURN-only URL validation,
credential endpoint/expiry validation, page-config sanitisation (STUN/attacker
servers removed, policy forced to relay), SDP candidate parsing, credential
payload parsing, selected candidate-pair evaluation including transport-ID and
candidate-pair fallbacks.

## 3. Coturn and credential service

```sh
sh tests/webrtc/start-test-stack.sh
```

Observed:

- coturn listeners: 13478/UDP, 13478/TCP, 15349/TCP; relay range 50160-50200/UDP.
- credential service `/turn-credentials` returns TURN URLs, HMAC username,
  credential and `ttl=3600`.
- HMAC verified independently with the server-side secret: **matches**.
- `turnutils_uclient` + `turnutils_peer` through coturn with those credentials:
  `tot_send_msgs=6, tot_recv_msgs=6`, `Total lost packets 0 (0.000000%)`.

This validates coturn REST auth and relay forwarding, independent of the browser.

## 4. Browser suite results

Commands (base):

```sh
cd packages/runway
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
  RUNWAY_BROWSER=<chromium|firefox|webkit> \
  WEBRTC_FAKE_MEDIA=1 WEBRTC_EXPOSE_HOST_CANDIDATES=1 \
  TURN_CREDENTIALS_URL=http://127.0.0.1:18081/turn-credentials \
  npx -y node@24 --experimental-strip-types --no-warnings \
  src/index.ts webrtc- --parallel 1
```

### Chromium — PASS 15/15

- relay/concurrency: two concurrent PeerConnections, ordered + unordered
  (`maxRetransmits: 0`) + negotiated DataChannels, 64 KiB payload, backpressure
  drain
- credentials: client fetch and controller prefetch
- cross-origin iframe (target origins `a.test` and `b.test`)
- hook: relay config enforcement, authorised TURN only, `setConfiguration`
  neutralised, prototype/`instanceof` preserved
- fail-closed: no credentials; enforced mode without attestation; TURN
  unreachable (8 s, never connected, only relay/no candidates)
- enforced mode with attestation (runtime policy)
- local SDP has no direct candidates
- same-origin iframe
- `about:blank` and `srcdoc` realms
- worker realm (Chromium exposes only `RTCDataChannel` in dedicated workers; the
  test verifies the realm is intact and would enforce WebRTC if present)
- real TURN DataChannel: text, 4 KiB binary, 128 KiB text all round-tripped;
  SHA-256 matched; ICE restart kept the channel open; selected local candidate is
  TURN-backed
- real TURN media: synthetic but real browser tracks (animated canvas video +
  oscillator audio), audio+video tracks, B decoded >10 frames and received
  > 100 kB, selected pair TURN-backed. Peer B runs in a separate page so media
  > capture cannot starve its evaluation.

### Firefox — PASS 13/13

All Chromium tests except media and worker-realm (browser filter):

- hooks, credentials, cross-origin iframe, `about:blank`/`srcdoc`, fail-closed,
  concurrency, real TURN DataChannel + ICE restart.

Firefox media capture with Playwright fake devices is **UNVERIFIED**.

### WebKit (Playwright) — PASS 13/13

Same 13 tests as Firefox. On WebKit the selected candidate-pair report can lack
`transport.selectedCandidatePairId`; the runner falls back to the nominated
succeeded `candidate-pair`. This is a stats-reading fallback, not a policy
relaxation.

Playwright WebKit is **not** iOS Safari. iOS Safari is **UNVERIFIED**.

## 5. TURN transports

Each run used the same real DataChannel + ICE restart test.

| Transport                                                                      | Browser  | Result            |
| ------------------------------------------------------------------------------ | -------- | ----------------- |
| TURN/UDP (`turn:…?transport=udp`)                                              | Chromium | **PASS** (15.9 s) |
| TURN/TCP (`turn:…?transport=tcp`)                                              | Chromium | **PASS** (15.9 s) |
| TURN/TCP                                                                       | Firefox  | **PASS**          |
| TURN/TCP                                                                       | WebKit   | **PASS**          |
| TURN/TLS (`turns:…?transport=tcp`, self-signed cert + `WEBRTC_INSECURE_TLS=1`) | Chromium | **PASS** (15.9 s) |

The TLS run used a test-only self-signed certificate and Chromium's
`--ignore-certificate-errors`. Production must use a trusted certificate.
Firefox/WebKit TURN/TLS with a self-signed test certificate is **UNVERIFIED**
(browsers do not share Chromium's ignore-certificate flag for WebRTC).

## 6. Enforced mode runtime check

```sh
WEBRTC_TEST_MODE=enforced … pnpm test webrtc-relay-datachannel
```

Result: **PASS** (Chromium, real TURN DataChannel + ICE restart). The hook
requires `networkIsolationVerified=true`, forces relay, and accepts only
TURN-backed selected pairs.

This proves the client-side runtime gate. It is **not** proof of kernel network
isolation; that is covered separately below.

## 7. Network isolation (Linux nftables)

Environment: two Linux containers on an isolated Docker network. The client
container has `NET_ADMIN`/`NET_RAW`. It is a real Linux network namespace; the
scripts are the same ones intended for `ip netns`/CI.

Commands (abridged):

```sh
docker compose -f tests/webrtc/isolation/docker-compose.yml up -d
# inside client:
SCRAMJET_HOST=<server-ip> SCRAMJET_PORT=8080 \
  TURN_HOST=<server-ip> TURN_PORT=80 TURN_TLS_PORT=443 \
  sh /repo/tests/webrtc/isolation/setup-nftables.sh
TURN_HOST=<server-ip> TURN_PORT=80 \
  UNAUTHORIZED_UDP_TARGET=1.1.1.1:19302 \
  sh /repo/tests/webrtc/isolation/verify-isolation.sh
```

Observed:

- Before rules: `1.1.1.1:443` reachable (negative control).
- After rules: `1.1.1.1:443` blocked (connection timed out).
- Default-deny counter: `0 -> 3` after the unauthorised UDP/TCP probes.
- Authorised TURN TCP port `<server-ip>:80`: reachable.
- Verifier output: `{"table":"scramjet_webrtc","deniedBefore":0,"deniedAfter":3,
"turnHost":"192.168.97.3","turnPort":80,"ok":true}`.
- Evidence: `docs/webrtc-evidence/isolation.json`,
  `docs/webrtc-evidence/nftables.txt`.

### Browser inside a network namespace

The full browser-in-`ip netns` run is Linux-only. This macOS environment has no
passwordless root and cannot run `ip netns`, so it is **UNVERIFIED locally**. The
reproducible commands and a CI job are provided
(`tests/webrtc/isolation/run-in-netns.sh`, `.github/workflows/webrtc.yml`). The
job fails if the verifier fails; it is not skipped.

The container-level verifier above proves the ruleset itself drops unauthorised
egress and permits the TURN port. It does not prove a specific browser emits no
packets on other interfaces; that is what the Linux CI netns job adds.

## 8. Packet capture

Capture was taken in coturn's network namespace while the Chromium DataChannel +
ICE restart test ran:

```sh
tcpdump -i any -nn -w /capture/turn.pcap \
  'udp or tcp port 13478 or tcp port 15349 or udp portrange 50160-50200'
```

Observed (tshark):

| Metric                             | Count |
| ---------------------------------- | ----- |
| total packets                      | 1483  |
| STUN binding requests              | 32    |
| STUN Allocate requests             | 34    |
| STUN Allocate successes (`0x0103`) | 8     |
| STUN CreatePermission requests     | 21    |
| STUN ChannelBind requests          | 2     |
| TURN UDP control packets           | 653   |
| TURN TCP control packets           | 345   |
| TURN/TLS packets                   | 39    |
| relay UDP packets (50160-50200)    | 567   |
| DTLS packets                       | 449   |

The capture contains only coturn-side control/relay traffic. DTLS plus relay UDP
proves the media/DataChannel path traversed the TURN relay. Raw PCAP is not
committed (contains addresses); the summary is
`docs/webrtc-evidence/pcap-summary.json`.

## 9. Candidate verification semantics

Chromium and Firefox can report the selected local candidate as `prflx` even when
the transport is a TURN allocation. The stats entry then carries
`url="turn:…"` and `relayProtocol`, and the related address is the TURN server.
The client accepts:

- `candidateType === "relay"`, or
- `candidateType === "prflx"` **and** `url` starts with `turn:`/`turns:` **and**
  `relayProtocol` is present.

It rejects `host`/`srflx`/`prflx` without a TURN URL. Non-relay local SDP
candidates also cause `setLocalDescription` to reject and the connection to close.
No SDP is rewritten to hide a leak.

## 10. Browser / platform matrix

| Platform                         | Hook + config                       | DataChannel via TURN | ICE restart        | Media               |
| -------------------------------- | ----------------------------------- | -------------------- | ------------------ | ------------------- |
| Chromium 149 (Playwright, macOS) | PASS                                | PASS (UDP/TCP/TLS)   | PASS               | PASS (fake devices) |
| Firefox (Playwright, macOS)      | PASS                                | PASS (UDP/TCP)       | PASS               | UNVERIFIED          |
| WebKit 26.5 (Playwright, macOS)  | PASS                                | PASS (UDP/TCP)       | PASS               | UNVERIFIED          |
| Linux Chromium in netns          | UNVERIFIED locally; CI job provided | UNVERIFIED locally   | UNVERIFIED locally | UNVERIFIED locally  |
| Android Chrome                   | UNVERIFIED                          | UNVERIFIED           | UNVERIFIED         | UNVERIFIED          |
| iOS Safari                       | UNVERIFIED                          | UNVERIFIED           | UNVERIFIED         | UNVERIFIED          |

No mobile result is inferred from desktop Playwright.

## 11. Existing test baseline (not WebRTC)

Three non-WebRTC Runway tests fail in this macOS environment:

- `postmessage-event-meta-sanity`
- `postmessage-self-event-meta-sanity`
- `websockets-sanity`

They were reproduced with the **published** `@mercuryworkshop/scramjet@2.0.67-alpha.2`
`dist/scramjet.js` as well as with this build. The failing files
(`postmessage.ts`, `websockets.ts`, their client hooks) were not modified by this
work. They are pre-existing/environmental failures, not a WebRTC regression.
Scramjet sanity suite otherwise: 61 passed, 4 failed (3 above + 1 already in
`failing_tests.json`).

## 12. Known gaps

1. Full browser-in-netns execution was not possible on this macOS host; Linux CI
   instructions/scripts are supplied.
2. TURN/TLS with a self-signed certificate is only verified in Chromium
   (test-only certificate override). Real certificate deployment is documented
   but not executed here.
3. Firefox/WebKit media with synthetic devices is unverified.
4. Worker WebRTC: Chromium has no `RTCPeerConnection` in dedicated workers; the
   test verifies the injected realm and would enforce if the API exists. Firefox
   worker WebRTC is not tested.
5. Multiple top-level tabs are represented by concurrent PeerConnections and
   separate realms; no separate browser-tab test was executed.
6. IPv6 bypass is blocked by the `inet` table policy but an IPv6-capable client
   namespace was not available locally. The Linux CI job should enable IPv6 and
   run `verify-isolation.sh`; otherwise treat IPv6 as **UNVERIFIED**.
