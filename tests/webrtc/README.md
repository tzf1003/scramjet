# WebRTC tests

This directory contains the reproducible test environment for Scramjet's WebRTC
takeover. The browser tests themselves live in
`packages/runway/src/tests/webrtc/` because Runway discovers tests there.

## Layout

| Path                           | Purpose                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `unit/webrtc.test.ts`          | Pure policy/config/SDP/stats tests (Node type stripping)                           |
| `coturn/`                      | coturn reference configuration, entrypoint, test certificate script                |
| `server/credential-server.mjs` | coturn REST/HMAC credential service                                                |
| `docker-compose.yml`           | coturn + credential service test stack                                             |
| `start-test-stack.sh`          | Generates `.env`/certs and starts the stack                                        |
| `isolation/`                   | nftables/network-namespace policy, verifier, fault injection and Chromium policies |
| `capture/`                     | TURN/client PCAP capture and egress analysis                                       |
| `check-quality.mjs`            | TypeScript/lint regression gate against the upstream baseline                      |
| `run-browser-suite.py`         | Disposable coturn stack + UDP/TCP/TLS browser matrix                               |
| `run-all.sh`                   | Unit + hook + real TURN relay tests                                                |
| `artifacts/`                   | Ignored test output; upload in CI                                                  |

## Quick start

```sh
pnpm install
pnpm exec rspack build --mode production      # after building rewriter wasm
sh tests/webrtc/start-test-stack.sh
node --experimental-strip-types --test tests/webrtc/unit/webrtc.test.ts

cd packages/runway
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
  npx -y node@24 --experimental-strip-types --no-warnings \
  src/index.ts webrtc- --parallel 1
```

Runway's scripts use the repository's Node 24 toolchain; Node 22 cannot parse an
inline-flag regex used by the existing test infrastructure. The local test stack
explicitly enables anonymous issuance; direct Compose deployments require signed
sessions (see `docs/webrtc-deployment.md`).

## Real network behaviour

The relay test uses a real coturn allocation and a real second browser page. Both
peers use TURN so the test does not depend on host-candidate reachability. It
asserts:

- A's selected local candidate is TURN-backed (`relay`, or `prflx` with an
  authorised TURN URL and relay protocol);
- B's selected remote candidate is TURN-backed;
- text, binary, and 128 KiB DataChannel payloads round-trip (SHA-256 checked);
- an ICE restart keeps the DataChannel usable;
- only TURN URLs remain in `getConfiguration()`.

No mocked ICE/DTLS/SCTP stack is used.

## Isolation

`isolation/run-in-netns.sh` is Linux-only and needs root. It keeps the runner and
services on the host, creates a dual-stack client namespace, launches only
Chromium inside it, installs a validated default-deny policy, performs
destination-specific IPv4/IPv6/DNS probes, runs a native direct-connect negative
control, captures client egress and supervises the policy digest. It was run in a
privileged Linux container; the macOS host itself cannot create `ip netns`.
`isolation/regression.py` covers atomic reload and verifier false positives.

## Secrets

``.env` and `coturn/certs/` are gitignored. The credential service and coturn
share only the HMAC secret; tests receive short-lived usernames/credentials.
Rotate `CREDENTIAL_SESSION_SECRET` separately from the TURN secret; Coturn only
reads its TURN secret at startup, while the credential service supports a
protected secret file re-read on each issuance.
