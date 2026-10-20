# WebRTC tests

This directory contains the reproducible test environment for Scramjet's WebRTC
takeover. The browser tests themselves live in
`packages/runway/src/tests/webrtc/` because Runway discovers tests there.

## Layout

| Path                           | Purpose                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `unit/webrtc.test.ts`          | Pure policy/config/SDP/stats tests (Node type stripping)             |
| `coturn/`                      | coturn reference configuration, entrypoint, test certificate script  |
| `server/credential-server.mjs` | coturn REST/HMAC credential service                                  |
| `docker-compose.yml`           | coturn + credential service test stack                               |
| `start-test-stack.sh`          | Generates `.env`/certs and starts the stack                          |
| `isolation/`                   | nftables/network-namespace fail-closed scripts and Chromium policies |
| `run-all.sh`                   | Unit + hook + real TURN relay tests                                  |
| `artifacts/`                   | Ignored test output; upload in CI                                    |

## Quick start

```sh
pnpm install
pnpm exec rspack build --mode production      # after building rewriter wasm
sh tests/webrtc/start-test-stack.sh
node --experimental-strip-types --test tests/webrtc/unit/webrtc.test.ts

cd packages/runway
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
  pnpm test webrtc-hook --parallel 1

TURN_CREDENTIALS_URL=http://127.0.0.1:18081/turn-credentials \
  PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers \
  pnpm test webrtc-relay --parallel 1
```

Runway's scripts use the repository's Node 24 toolchain; Node 22 cannot parse an
inline-flag regex used by the existing test infrastructure.

## Real network behaviour

The relay test uses a real coturn allocation and a real second browser page. It
asserts:

- A's selected local candidate is `relay`;
- B sees A's candidate as `relay`;
- text, binary, and 128 KiB DataChannel payloads round-trip (SHA-256 checked);
- an ICE restart keeps the DataChannel usable;
- only TURN URLs remain in `getConfiguration()`.

No mocked ICE/DTLS/SCTP stack is used.

## Isolation

`isolation/run-in-netns.sh` is Linux-only and needs root. It creates a client
namespace, installs a default-deny nftables output policy, verifies that a probe
increments the drop counter, checks the authorised TURN TCP port, then runs the
given command in the namespace. macOS cannot run this; the local result is
reported as unverified.

## Secrets

`.env` and `coturn/certs/` are gitignored. The credential service and coturn
share only the HMAC secret; tests receive short-lived usernames/credentials.
