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
| `check-quality.mjs`            | Full Core/Controller typecheck and full Core lint                                  |
| `run-browser-suite.py`         | Disposable coturn stack + UDP/TCP/TLS browser matrix                               |
| `run-all.sh`                   | Unit + hook + real TURN relay tests                                                |
| `artifacts/`                   | Ignored test output; upload in CI                                                  |

## Quick start

Build with the repository's Node/pnpm toolchain and reused dependency cache:

```sh
rtk node tests/webrtc/check-quality.mjs
rtk pnpm exec rspack build --mode production
rtk node --experimental-strip-types --test tests/webrtc/unit/webrtc.test.ts
rtk node --test tests/webrtc/unit/credentials.test.mjs
rtk env PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers python3 tests/webrtc/run-browser-suite.py --output /Volumes/1T/scramjet/verification/browser-matrix
```

The runner uses installed Node 24 or the already-cached `node@24` executable.
It creates task-owned TURN/credential containers and handles real TURN pause,
restart and allocation observations outside the browser. `--parallel` must be 1;
concurrent connections are exercised within tests. Direct Runway execution is
suitable for filters that do not request TURN fault controls. Full WebRTC and
regression suites use this runner.

`check-quality.mjs` requires zero Core/Controller type errors and runs full Core
lint. Build/declaration errors propagate to the build's exit code. Root tools and
ambient declarations are part of the repeatable workspace setup.

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
`isolation/regression.py` covers atomic reload, altered terminal verdicts,
duplicate markers, chain policies, and extra allows outside the configured
endpoint list. Probes observe counters without adding a drop verdict.

## Secrets

`.env` and `coturn/certs/` are gitignored. The credential service and coturn
share only the HMAC secret; tests receive short-lived usernames/credentials.
Rotate `CREDENTIAL_SESSION_SECRET` separately from the TURN secret; Coturn only
reads its TURN secret at startup, while the credential service supports a
protected secret file re-read on each issuance.

## Evidence and extended validation

`isolation/run-linux-suite.py` reuses a Linux browser image and runs Chromium in
the supervised namespace; `--ipv6` selects IPv6 TURN transport. It captures both
normal egress and a deliberate direct-connect control. Positive capture analysis
requires TURN packets and no unauthorized destination; negative analysis requires
observed unauthorized traffic. Both analyses must succeed as expectations.

`evidence.py` binds runs to tracked/added source files and built runtime bundles. `manifest.json` lists the
actual output hashes, while native media, RTT, throughput, page CPU/heap metrics
and TURN socket allocation/release measurements are logged. Configure
`WEBRTC_SOAK_SECONDS`, `WEBRTC_MEDIA_SOAK_SECONDS`, and `TURN_TTL` for longer runs.

`device-probe.html` and `docs/webrtc-device-validation.md` provide a runnable
native-browser procedure for physical hardware and independent public peers.
Real mobile devices, public NAT64 and multi-network/VPN topologies require their
own recorded evidence.
