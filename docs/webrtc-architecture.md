# Scramjet WebRTC Architecture

Status: implementation design for the WebRTC takeover work in this fork.

## 1. Scope and non-goals

Scramjet is a service-worker based HTTP/WebSocket proxy. It rewrites documents,
JavaScript, URLs and worker scripts, and routes fetch/WebSocket traffic through a
`ProxyTransport` (Wisp or another transport implementation). It does **not** own the
browser's network stack.

WebRTC is different from every other browser API Scramjet virtualises:

- ICE gathering and connectivity checks are performed by the browser's native ICE
  agent, not by page JavaScript.
- The DTLS/SRTP/SCTP stack runs in the browser process, below page JavaScript.
- A JavaScript hook can choose ICE servers and ICE transport policy, but it cannot
  inspect or proxy raw ICE/DTLS/SRTP packets.

Consequences:

1. **A WebRTC JavaScript hook is not a network boundary.** It is a configuration
   enforcement layer. Network isolation must be enforced by the browser/OS
   (section 3).
2. **Wisp cannot carry native WebRTC.** Wisp 0.4.1 does implement a UDP extension
   (`src/extensions.mjs`, `src/server/net.mjs`), and its server can create UDP
   sockets. However:
   - Scramjet's `ProxyTransport` interface exposes only `request()` and
     `connect()` (WebSocket). It has no datagram API.
   - Even with a datagram API, Chromium/Firefox/Safari WebRTC does not expose a
     hook to replace its native ICE UDP socket with a JavaScript transport. Doing
     so requires patching the browser network service or shipping a full
     libwebrtc/WASM stack (ICE + DTLS + SRTP + SCTP).
   - Therefore `relay`/`enforced` modes use real TURN, not Wisp, and this document
     does not call TURN "Wisp full tunnel".
3. Media capture is a local device capability. Forcing a relay changes the network
   path, not where `getUserMedia`/`getDisplayMedia` capture happens.

## 2. Repository audit (baseline `b14b709a`)

The fork was compared against `MercuryWorkshop/scramjet` `main` at the same commit.
`git diff HEAD upstream/main` is empty. Upstream has no WebRTC implementation.

Relevant mechanisms:

| Area                   | Location                                                                | Finding                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client bootstrap/hooks | `packages/core/src/client/client.ts`                                    | `hook()` loads every `client/{dom,worker,shared}/**/*.ts` module, sorted by `order`; modules run before page scripts.                                       |
| Hook primitives        | `ScramjetClient.Proxy` / `Trap`                                         | Function/constructor proxies and property traps; preserves `prototype` identity.                                                                            |
| Injection timing       | `packages/core/src/shared/rewriters/html.ts`                            | Injection scripts are prepended to `<head>` (or document start for quirky docs).                                                                            |
| Realm coverage         | `packages/controller/src/inject.ts`, `client/dom/element.ts`            | Client is installed in top-level documents, proxied iframes, `about:blank`/`srcdoc` subcontexts (`hookSubcontext`), and workers (`getWorkerInjectScripts`). |
| WebSocket hook         | `packages/core/src/client/shared/requests/websocket.ts`                 | Full fake WebSocket over `ProxyTransport`; no UDP/datagram path.                                                                                            |
| Transports             | `packages/controller/src/index.ts`, `@mercuryworkshop/proxy-transports` | `request()` + `connect()` only. No UDP.                                                                                                                     |
| Wisp                   | `@mercuryworkshop/wisp-js@0.4.1`                                        | UDP extension exists server/client-side; unused by Scramjet.                                                                                                |
| Config                 | `packages/core/src/types.ts`, `packages/core/src/index.ts`              | `ScramjetConfig` is JSON-serialised into every injected realm; ideal for a trusted WebRTC policy snapshot.                                                  |
| Tests                  | `packages/runway`                                                       | Playwright + Scramjet harness, adversarial JS tests, `basicTest`/`htmlTest`/`playwrightTest`.                                                               |
| Existing WebRTC code   | —                                                                       | None. `runway/src/tests/adversarial/modern-apis.ts` only asserts `typeof RTCPeerConnection === "function"`.                                                 |

### Capability matrix before this work

| Capability                           | State                    | Root cause                                                       |
| ------------------------------------ | ------------------------ | ---------------------------------------------------------------- |
| `RTCPeerConnection` API              | Native, unhooked         | No module                                                        |
| Relay-enforced ICE                   | Missing                  | No config/hook                                                   |
| Remote ICE server suppression        | Missing                  | No hook                                                          |
| `setConfiguration` re-arm protection | Missing                  | No hook                                                          |
| Credential issuance                  | Missing                  | No TURN deployment                                               |
| Selected candidate pair verification | Missing                  | No diagnostics                                                   |
| Cross-realm coverage                 | Available infrastructure | Hooks run per realm, but no WebRTC policy                        |
| Worker WebRTC                        | Native where supported   | Client injected for proxied/blob workers; no policy              |
| DataChannel/media                    | Native                   | Untouched by this work                                           |
| Wisp UDP for WebRTC                  | Not possible             | Transport + browser network stack boundary                       |
| OS-level egress control              | Missing                  | Deployment concern, scripts added under `tests/webrtc/isolation` |

## 3. Modes

Runtime configuration lives in `ScramjetConfig.webrtc` and is set by the trusted
controller, never by the proxied page. A page can call the WebRTC APIs but cannot
change the policy snapshot.

```ts
type WebrtcMode = "off" | "relay" | "enforced";

interface ScramjetWebrtcConfig {
	mode: WebrtcMode;
	iceServers: {
		urls: string | string[];
		username?: string;
		credential?: string;
	}[];
	credentialEndpoint: string | null;
	credentialRefreshRatio: number; // 0.1 .. 0.95
	failClosed: boolean;
	diagnostics: boolean;
	networkIsolationVerified: boolean;
}
```

| Mode       | API behaviour                                                                                                                                                   | Network boundary                                                | Intended use                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| `off`      | No hook installed                                                                                                                                               | None                                                            | Default; unchanged Scramjet behaviour |
| `relay`    | Force `iceTransportPolicy: "relay"`, replace all ICE servers with the authorised TURN set, reject non-relay local candidates/pairs                              | TURN only as far as the browser obeys; **not** an OS boundary   | Web-only deployments, development     |
| `enforced` | Same as `relay`, plus refuses to operate unless `networkIsolationVerified` is attested, and closes any connection whose selected local candidate is not TURN-backed | TURN only **and** OS/browser policy must block all other egress | Controlled Linux browser/container    |

`relay` is honest about its limit: a malicious page cannot re-enable direct ICE
through the hooked APIs, but an unpatched browser vulnerability or a realm the hook
does not cover is outside a JavaScript-only boundary.

`enforced` does not magically create isolation. `networkIsolationVerified` is an
attestation by the deployment that the nftables/namespace setup in
`tests/webrtc/isolation` was applied and verified. The client adds runtime
fail-closed checks (candidate type and selected pair) on top. If the attestation is
missing, PeerConnection construction fails; the code does not silently fall back to
`relay` or direct.

## 4. Client hook design

New module: `packages/core/src/client/shared/requests/webrtc.ts` (shared, so it runs
in windows and workers; module is a no-op when `mode === "off"`).

It intentionally hooks only the network policy surface:

- `RTCPeerConnection` constructor and `webkitRTCPeerConnection` alias (when present)
- `RTCPeerConnection.prototype.setConfiguration`
- `RTCPeerConnection.prototype.setLocalDescription` (validate emitted candidates)
- `RTCPeerConnection.prototype.restartIce` (credential freshness bookkeeping)
- `RTCPeerConnection.prototype.close` (registry cleanup)

Not hooked: `createOffer`, `createAnswer`, `setRemoteDescription`,
`addIceCandidate`, `addTrack`, `removeTrack`, `addTransceiver`,
`createDataChannel`, `getStats`, and all events. These keep native Promise,
exception, event and `instanceof` semantics. `getStats` output is never rewritten.

Per-connection state is kept in a `WeakMap`; there is no per-instance wrapper object
and no fake candidate/connection state.

### 4.1 Configuration enforcement

At construction and on every `setConfiguration` call:

- `iceTransportPolicy` is forced to `"relay"`.
- `iceServers` is replaced by the controller-authorised TURN servers.
- Non-network fields (`bundlePolicy`, `rtcpMuxPolicy`, `iceCandidatePoolSize`,
  `certificates`, `peerIdentity`) are preserved.
- Page-supplied STUN servers and direct-ICE policies are discarded, not merged.

`getConfiguration()` is native and therefore reports the configuration the browser
actually uses (relay + authorised TURN).

### 4.2 Candidate and pair verification

Defence in depth, not SDP rewriting:

- Every local SDP is parsed after `setLocalDescription`. If any
  `a=candidate:... typ host|srflx|prflx` is present in relay/enforced mode, the
  connection is closed and the promise rejects. SDP is never edited to hide a leak.
- ICE candidate events are inspected; a non-relay local candidate closes the
  connection.
- On connected/completed, native `getStats()` is polled a few times. The selected
  candidate pair's **local** candidate must be TURN-backed: `candidateType:
  "relay"`, or `candidateType: "prflx"` with a `url` of `turn:`/`turns:` and a
  `relayProtocol`. Browsers can report a relayed transport as prflx; accepting it
  only with the TURN URL preserves fail-closed behaviour. Anything else closes the
  connection in relay/enforced mode.
- Failures are logged through `dbg.error` when diagnostics are enabled. No synthetic
  success events are dispatched.

### 4.3 Credentials

TURN credentials are short-lived HMAC credentials (coturn REST API):

- Preferred path: the trusted controller calls the credential endpoint during its
  `ready` sequence and puts the resolved `iceServers` into `ScramjetConfig` before
  any frame is created. This removes the async race at first PeerConnection.
- Fallback path: the client hook fetches `credentialEndpoint` at hook init. If a
  page constructs a PeerConnection before credentials exist, `failClosed` throws a
  `NotSupportedError` instead of allowing direct ICE.
- Refreshes are scheduled at `ttl * credentialRefreshRatio`. Refreshed credentials
  are applied to live connections with native `setConfiguration`; ICE restart or
  renegotiation picks them up for new allocations. Expired credentials never cause
  a direct-ICE fallback.

The shared secret exists only in the coturn/credential service environment. The
client receives username/credential/ttl only.

## 5. Realm coverage

The hook is a normal `shared/` client module, so it runs wherever the Scramjet
client runs:

- top-level document
- same-origin and cross-origin proxied iframes
- `about:blank` and `srcdoc` subcontexts created through `hookSubcontext`
- page reloads/navigations
- dynamically created iframes
- proxied classic/module workers, shared workers, and blob workers that pass
  through the service worker (worker clients receive the same JSON config)

A realm that never receives the Scramjet client (for example a browser extension
content script, a sandboxed opaque-origin document outside the proxy, or a native
WebRTC implementation in a worker type that cannot be injected) is out of the
JavaScript hook's coverage. `enforced` mode therefore relies on the network layer
for the actual boundary; `tests/webrtc/isolation` blocks direct egress for every
process in the client namespace.

## 6. TURN deployment boundary

Coturn is the relay. It is not a proxy for HTTP and it is not Wisp.

- TURN/UDP, TURN/TCP and TURN/TLS (TLS certificates mounted at runtime)
- Restricted relay port range
- HMAC time-limited credentials (`use-auth-secret`)
- Private/loopback/metadata destination denylist by default; explicit allowlist for
  test peers
- Rate/quota limits and no anonymous relay

`docs/webrtc-deployment.md` contains the reproducible deployment.

## 7. Test architecture

| Layer             | Location                                    | What it proves                                                                                                            |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Pure unit         | `tests/webrtc/unit`                         | Config sanitisation, credential parsing, SDP candidate parsing, selected-pair evaluation                                  |
| Scramjet hook     | `packages/runway/src/tests/webrtc`          | Hooks are installed in real Chromium realms; API semantics preserved; direct config attempts are neutralised; fail-closed |
| TURN integration  | `packages/runway/src/tests/webrtc` + coturn | Real ICE/DTLS/SCTP through coturn: DataChannel, media, ICE restart, concurrency                                           |
| Network isolation | `tests/webrtc/isolation`                    | nftables blocks direct UDP/STUN; negative control detects leaks                                                           |
| Capture           | `tests/webrtc/capture`                      | PCAP + coturn/selected-pair JSON evidence                                                                                 |

No mock ICE/DTLS stack is used. Tests that cannot run in a given environment are
reported as unverified, not passed.

## 8. Failure semantics

| Condition                                         | Behaviour                                                                  |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `relay`/`enforced`, no TURN servers, `failClosed` | PeerConnection constructor throws `NotSupportedError`                      |
| TURN unreachable                                  | Native ICE fails; connection never reaches `connected`; no direct fallback |
| Invalid/expired credentials                       | TURN allocation fails; refresh attempts; no direct fallback                |
| Non-relay local candidate in SDP                  | `setLocalDescription` rejects, connection closed                           |
| Non-relay selected pair                           | Connection closed and error logged                                         |
| `enforced` without attestation                    | PeerConnection constructor throws `NotSupportedError`                      |
| Credential endpoint fetch fails                   | Retry with backoff; new connections fail closed until resolved             |
