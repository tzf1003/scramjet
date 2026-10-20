# Scramjet WebRTC Security Model

## 1. Threat model

Assets:

- the client's real IP address and local network reachability;
- the Linux relay's egress identity and TURN credentials;
- integrity of media/DataChannel traffic;
- the Scramjet proxy origin and its service worker.

Adversaries:

- a malicious proxied page (or third-party script/iframe) trying to bypass relaying;
- a malicious page-supplied ICE configuration (`stun:`, public TURN, `iceTransportPolicy: "all"`);
- a compromised or unavailable TURN service;
- a hostile peer that advertises host/private candidates;
- a browser implementation that ignores policy or has an unhooked realm.

Out of scope for a JavaScript-only deployment: a browser 0-day that ignores
`iceTransportPolicy`, a malicious browser extension with WebRTC privileges, or a
user explicitly starting a non-proxied browser. Those require the enforced
OS/browser boundary.

## 2. Trust boundary

```
proxied page JS  ──(hook: config policy only)──  browser ICE agent  ──TURN──  peer
        │                                             │
        └── cannot proxy ICE/DTLS/SRTP packets ───────┘
```

The hook is a **policy** control:

- direct ICE is disabled by `iceTransportPolicy: "relay"`;
- only authorised TURN servers are configured;
- every local candidate/pair is checked, and violations close the connection.

It is **not** a packet filter. A JavaScript environment cannot stop the browser
process from emitting UDP if the browser decides to. That is why:

- `relay` mode is documented as "Web-only Relay Mode", not isolation;
- `enforced` mode requires a network-layer boundary (nftables/network namespace,
  container egress rules, or equivalent) and refuses to operate without an explicit
  `networkIsolationVerified` attestation;
- network tests include a negative control: with isolation disabled, the same test
  must observe a direct/non-relay path. If the negative control cannot observe it,
  the isolation result is not accepted.

## 3. Allowed flows (Enforced Isolation Mode)

For a client namespace, the only permitted WebRTC-related flows are:

| Source      | Destination      | Protocol/port   | Purpose                                        |
| ----------- | ---------------- | --------------- | ---------------------------------------------- |
| client      | Scramjet origin  | TCP (443/HTTP)  | page, fetch, WebSocket                         |
| client      | TURN server      | UDP/TCP 3478    | TURN allocation, relay traffic                 |
| client      | TURN server      | TCP 5349        | TURN/TLS                                       |
| client      | TURN relay range | UDP 49160-49200 | relayed media/data to the allocated relay port |
| TURN server | target peer      | per allocation  | relayed media/data                             |

All other UDP, including STUN to arbitrary servers and direct ICE to peer host
candidates, is dropped and counted. TCP egress other than the Scramjet origin and
TURN ports is dropped. IPv6 is handled by a separate `inet6` table with the same
policy; an IPv6-only direct path is therefore not an escape hatch.

DNS is resolved through the configured resolver only (or hosts entries are used).
If TURN URLs use hostnames, the resolver is explicitly allowed; otherwise the
deployment uses IP literals.

## 4. Coturn hardening

- `use-auth-secret` with HMAC-SHA1 time-limited credentials; no static user
  database for clients.
- Secret only in the server environment, never in the repository or client config.
- Relay port range restricted; `no-cli`; quotas/limits configured.
- Default `denied-peer-ip` ranges: loopback, private IPv4/IPv6, link-local,
  multicast, cloud metadata addresses. Tests that need a local peer use an explicit
  `allowed-peer-ip` entry; production should relay only to public peers.
- TLS certificate/key are mounted at runtime and never committed.
- The credential endpoint validates method/parameters, issues short TTLs and never
  logs the secret.

## 5. Fail-closed rules

| Event                                                     | Required behaviour                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| TURN down                                                 | Connection fails; no host/srflx/prflx candidate is emitted or accepted                |
| TURN credentials invalid/expired                          | Connection/allocation fails; refresh is attempted; no direct fallback                 |
| Credential endpoint down                                  | New connections throw/never connect; retries with backoff                             |
| Page calls `setConfiguration({iceTransportPolicy:"all"})` | Sanitised to `relay` + authorised servers; native `getConfiguration()` confirms       |
| Non-relay candidate in local SDP                          | Reject `setLocalDescription`, close connection                                        |
| Non-relay selected pair                                   | Close connection, log a security error                                                |
| `enforced` without verified isolation                     | Refuse construction (`NotSupportedError`)                                             |
| Browser lacks the hook coverage                           | Network rules still drop direct egress; enforcement fails closed at the network layer |

## 6. Known limitations and non-claims

1. **Wisp is not used for WebRTC.** Wisp UDP exists, but the browser's ICE stack
   cannot be routed through it without browser changes or a WASM WebRTC stack.
   TURN is a separate relay, not a Wisp tunnel.
2. **Hook coverage is not universal.** Any realm that does not receive the
   Scramjet client is outside the JavaScript policy. Enforced mode depends on the
   network boundary for these cases.
3. **Media capture is local.** Camera/microphone/screen capture are not proxied
   and are not evidence of egress location.
4. **`relay` mode is not OS isolation.** It is the strongest web-only control, but
   an unpatched browser or extension can bypass JavaScript hooks.
5. **Browser policy flags are defence in depth.** Chromium's
   `WebRtcIPHandlingPolicy=disable_non_proxied_udp` prevents non-proxied UDP and
   would break TURN/UDP; it is therefore not presented as a TURN-compatible
   isolation mechanism. `default_public_interface_only` can reduce host-candidate
   exposure but does not block direct egress. nftables is the authoritative control.
6. **IPv6 must be blocked separately.** An IPv4-only ruleset is insufficient.
7. **TURN credentials are bearer credentials for their TTL.** TLS to the TURN
   server is recommended where the network is untrusted; coturn still authenticates
   allocations with HMAC.

## 7. Verification requirements

An enforced-mode claim requires all of:

1. nftables rules installed and counters observed after a deliberate probe.
2. Negative control: with rules removed, a direct path is detected.
3. Positive path: selected candidate pair local candidate is TURN-backed (`relay`, or `prflx` with a TURN URL), and the relay
   egress is observed at the peer/TURN side.
4. Fail-closed: blocking TURN yields no connection.
5. IPv6 probe and cross-realm/iframe probe.
6. Evidence persisted (JSON + PCAP/logs) and referenced by
   `docs/webrtc-test-report.md`.

Without 1-6, the mode is reported as unverified.
