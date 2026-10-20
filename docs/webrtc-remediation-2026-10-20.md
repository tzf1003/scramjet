# WebRTC Remediation Report (2026-10-20)

This report records the fixes applied after `docs/webrtc-completion-audit-2026-10-20.md`.
The audit was taken at `f116bf59`; all code and tests below are in the working tree
after the remediation.

## F01 — Authorised TURN list could be replaced

Fixed by:

- Capturing every runtime helper used by the policy at module load:
  `Array.prototype` methods, `Object`, `Reflect`, `RegExp`, `String`, `Symbol.iterator`.
- Building WebIDL sequences with an own iterator that yields only validated
  values (`sequence()` in `packages/core/src/shared/webrtc.ts`).
- Replacing `.map()`, `.some()` and `for...of` over policy arrays with indexed
  loops and captured functions.
- Verifying the native `getConfiguration()` immediately after construction and
  after every `setConfiguration`; any unauthorised URL closes the connection.

Regression tests `webrtc-hook-protected-policy-relay` and
`webrtc-hook-protected-policy-enforced` poison `Array.prototype.map`,
`Array.prototype[Symbol.iterator]`, `WeakMap.prototype.get`, `Set.prototype.has`
and `Function.prototype.call`; both pass in Chromium, Firefox and WebKit.

## F02 — Failed rule reload removed the old policy

`tests/webrtc/isolation/policy.py` builds the complete delete/create batch,
validates it with `nft --check`, then applies it in one `nft --file` transaction.
If validation fails, the previous table is untouched.

`tests/webrtc/isolation/regression.py` reproduces the invalid-update case and
verifies the original policy still passes verification. Result:
`atomicReload: true`.

## F03 — Verifier false positive

`tests/webrtc/isolation/verify.py` no longer relies on the aggregate drop counter.
For every configured IPv4/IPv6 TCP and UDP probe it inserts a temporary
destination-qualified counter/drop rule immediately before the default-deny rule,
performs the probe, requires that exact counter to increase, and removes the rule.
An earlier allow rule cannot satisfy the check.

`regression.py` deliberately inserts an unauthorised TCP and UDP allow rule and
requires verification to fail:
`tcpFalsePositiveRejected: true`, `udpFalsePositiveRejected: true`.

## F04 — Enforced browser CI topology

The runner and services stay on the host; `run-in-netns.sh` creates a dual-stack
namespace and launches only Chromium inside it through a root-owned wrapper. It:

- installs and verifies the endpoint-qualified policy;
- runs a real native-browser direct-connection control that must fail while
  isolated;
- removes the policy, requires the same direct connection to succeed, then
  restores and re-verifies policy;
- captures client packets and stops the browser if the attested policy digest
  changes;
- fails if IPv4/IPv6 TCP/UDP/DNS probes are not blocked.

Executed in a privileged Linux container with Chromium 1219:

- `nativeDirectBlocked: true`
- `removedIsolationDirectDetected: true`
- Runway `webrtc-relay-datachannel-ice-restart`: **PASS** under
  `WEBRTC_TEST_MODE=enforced`
- client capture: 592 IPv6 TURN packets, **0 unauthorised packets**,
  `ok: true`

Evidence: `/Volumes/1T/scramjet/verification/2026-10-20-remediation/current-linux-isolation/`
(client PCAP is not committed; `client-egress.json`, `policy.json`,
`isolation.json`, `browser-direct-control.json` are copied to
`docs/webrtc-evidence/`).

## F05 — Unverifiable selected candidate pair kept running

`verifySelectedPair` now:

- checks every selected transport, not just the first;
- rejects missing/incomplete transports and unsupported `RTCStatsReport`;
- times out individual `getStats` calls;
- closes the connection after bounded retries when fail-closed/enforced;
- rechecks periodically after success;
- validates that every relay/prflx candidate's `url` is in the authorised list.

Regression `webrtc-relay-stats-failure-closes-real-connection` establishes a real
relay DataChannel, then injects `getStats` rejection and requires both endpoints
to close. It passes.

## F06 — Type and quality gates

- Controller timer guard fixed.
- `tests/webrtc/check-quality.mjs` compares current TypeScript diagnostics with
  the `b14b709a` baseline; it fails on every introduced error and fully lints the
  two WebRTC modules.
- Result: core 66 baseline errors / 66 current, controller 19/19,
  `introduced: []`; WebRTC lint exit 0 (warnings only).

## F07 — Credential abuse/lifecycle

`credential-server.mjs` now provides:

- authenticated signed sessions (Bearer or `__Host-scramjet-turn-session` cookie);
- enforced TTL bounds, exact route/method handling and Origin checks;
- per-IP and per-user issuance rate limits;
- revocation file checked on each issuance;
- secret-file rotation without restarting the credential service;
- a separate session-signing secret from the coturn secret;
- tests for 401/404/429/403/503 and rotation.

The local/CI launcher explicitly enables `ALLOW_ANONYMOUS_TEST_ONLY=1`; direct
Compose deployments require authenticated sessions.

## F08 — Health-check port

Compose now probes the same `18081` listener the service uses. The recreated test
stack reports `healthy`.

## F09 — `setConfiguration(null)` compatibility

`sanitizeRtcConfiguration` treats `null`, `undefined`, empty dictionaries and
functions as valid WebIDL dictionary inputs and always applies the relay policy.
`webrtc-hook-alias-and-webidl-dictionaries` covers the constructor and
`setConfiguration()` with no argument, `null`, `undefined`, `{}` and a function.

## F10 — PCAP labels and client evidence

- `0x0003` is labelled Allocate request (16), `0x0016` Send indication (35);
  counts now note that a frame can contain multiple STUN messages.
- Added `tests/webrtc/capture/check-client-egress.py`, which correlates policy
  hash, receipt, run ID and PCAP, requires observed TURN packets and rejects
  unauthorised IPv4/IPv6 TCP/UDP destinations.
- The netns run produced `turnPackets: {ipv4: 0, ipv6: 592}` and
  `unauthorizedPackets: []`.

## F11 — Coturn security baseline

Compose is pinned to
`coturn/coturn:4.18.0-r0@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3`.
The image includes the IPv6/NAT64 peer ACL hardening after the 4.13.0 advisory
range. IPv4/IPv6 TURN URLs and ACL behavior are exercised by the isolation stack;
a complete public NAT64/IPv6 deployment remains environment-dependent and is
not claimed.

## Verification snapshot

| Check                                 | Result                           |
| ------------------------------------- | -------------------------------- |
| WebRTC unit tests (policy)            | 14/14                            |
| Credential service tests              | 2/2                              |
| Chromium WebRTC suite                 | 21/21                            |
| Firefox WebRTC suite                  | 18/18                            |
| WebKit WebRTC suite                   | 18/18                            |
| TURN/UDP                              | PASS                             |
| TURN/TCP                              | PASS                             |
| TURN/TLS (test certificate, Chromium) | PASS                             |
| Linux enforced netns + direct control | PASS                             |
| Isolation fault injection             | PASS                             |
| Client egress capture                 | 592 TURN packets, 0 unauthorised |
| Type/lint regression gate             | PASS (no introduced errors)      |

The existing non-WebRTC Runway failures (`postmessage-*`, `websockets-sanity`)
remain reproducible with the published bundle in this environment and are not
counted as remediated WebRTC findings. Mobile, real screen capture, long-duration
performance/soak, and public multi-host/NAT64 matrices remain unverified.
