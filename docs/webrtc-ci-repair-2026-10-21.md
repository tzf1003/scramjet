# WebRTC CI stabilization and revalidation

Date: 2026-10-21. Base commit: 63568eb7292b0db337ba3b7d5d1d4a6df25b4324.

## Changes

- Retain the audio source graph and await user-initiated AudioContext resume and media playback before sampling. Give received video elements visible dimensions and foreground their page. Keep the existing per-track RTP growth, changing-pixel and audio-energy assertions.
- Serve native direct-control pages from the fixture origin. For co-located fixture peers, resolve advertised mDNS host candidates in signaling to the runner-selected IPv4 interface. PeerConnections remain native with empty ICE servers. The original local SDP remains the assertion input. The off-mode detector now requires the specific connected-path assertion, so an unavailable prerequisite fails the test.
- Enumerate Coturn descriptor symlinks individually. A descriptor disappearing during closure is expected; a live unreadable descriptor fails the snapshot. Continue correlating owned socket inodes with the configured UDP relay range and include captured diagnostics when a snapshot command fails.

## Local verification

Evidence root: /Volumes/1T/scramjet/verification/2026-10-21-ci-repair/.

| Check | Result | Evidence |
| --- | --- | --- |
| Chromium WebRTC | 29/29 | browser-full/chromium-udp.log |
| Firefox WebRTC | 25/25 | browser-full/firefox-udp.log |
| macOS Playwright WebKit WebRTC | 25/25 | webkit-full/webkit-udp.log |
| Supervised Linux IPv4 | 9/9; 5,539 TURN packets; 0 unauthorized normal packets | linux-ipv4/ |
| Supervised Linux IPv6 | 9/9; 5,580 TURN packets; 0 unauthorized normal packets | linux-ipv6/ |
| Direct packet controls | 15 unauthorized IPv6 packets detected per run; both expected-negative analyses exit 0 | linux-ipv4/negative-egress.json, linux-ipv6/negative-egress.json |
| TURN allocation lifecycle | 0 -> 2 -> 0 owned relay sockets | linux-resource/linux.log; both full Linux suites |
| Coturn authenticated peer ACLs | 36/36 | peer-acl.json |
| Native Chromium policy-loss supervisor | 2/2, browser terminated and namespace removed | supervisor/result.json |
| Policy / credential unit tests | 14/14 and 2/2 | Node test output |
| Full Core / declaration / Controller TypeScript | 0 errors | quality.log |
| Core lint | 0 errors, 168 warnings | quality.log |

The four complete browser/Linux runs share source SHA-256 1c400797913ef41ac38a74c38fd25812754bf16f1dee6c09c346ae493e87457a. Their source.json records the exact tested files and runtime bundle hashes. All four artifact manifests were read back with zero mismatches. The runs used credential TTL 3,600 seconds, data soak 15 seconds and media sampling 2.5 seconds per phase. Chromium/Firefox used the route-selected TURN address; WebKit used the explicit LAN TURN address. A preceding Firefox run against that LAN address timed out gathering relay candidates; it remains in lifecycle/ as evidence. The route-selected repeat and complete Firefox suite passed.

## CI and acceptance

At commit 24b3dded, ordinary CI run 39538768600 passed. WebRTC run 39538768686 failed in Firefox/WebKit media, WebKit native-direct prerequisites and the Linux descriptor snapshot. This repair targets those failures; the final CI result is recorded in PR #1 after the pushed revision completes.

At f75b9d08, ordinary CI run 39542543989 passed. WebRTC run 39542543970 passed quality, units, Chromium with the transport matrix, and the complete enforced job (IPv4/IPv6, ACL and supervisor). The Firefox/WebKit jobs stalled in media activation and were manually cancelled to retain diagnostics. Both had already passed their real native-direct positive controls and fail-closed checks. WebKit had completed the first two media phases before the stall.

The follow-up activates only currently receiving tracks and bounds the activation promise to 10 seconds with audio/track playback diagnostics. Linux cross-browser CI starts a PulseAudio null sink so native AudioContexts have an output device. Local targeted Firefox and WebKit lifecycle repeats each passed 1/1 in media-bounded-local/ and media-bounded-webkit/. The complete matrix above retains its original source identity; the follow-up CI is tracked separately in PR #1.

These measurements cover desktop automation and the supervised Linux Docker topology. Physical media devices, real mobile Safari, independent public peers, public NAT64/VPN/multihoming and hour-scale system resource acceptance retain the boundaries documented in webrtc-test-report.md.

## Coordinated transport and playback lifecycle

At commit 281735d7, ordinary CI run 39544921749 passed. WebRTC run 39544921682 passed quality, units, Chromium and all three TURN transports, plus the complete enforced job. Firefox finished 24/25: one peer closed its connection after receiving the ICE-restart echo while the other was still collecting asynchronous statistics. WebKit finished 24/25: the added video track decoded RTP frames, but its playback element remained at HAVE_NOTHING. Linux packet readback recorded 7,415 IPv4 and 5,817 IPv6 authorized TURN packets, zero unauthorized normal packets, and 16 IPv6 direct-control packets per run. These artifacts identify the PR merge snapshot 59b4838118aaef256ca0ff7a9d95eb8b5b82c992.

The DataChannel fixture now retains both native connections until both results are captured, then closes both connections and signaling sockets and cancels pending timers. Cleanup waits for native channel closure and asserts both peers and channels are closed.

The Linux WebKit failure was reproduced with Playwright 1.61.0 on Ubuntu 24.04 arm64 and a PulseAudio null sink. The added video was visible and its inbound stats showed decoded 320x240 frames, while the element reported zero dimensions. Binding a fresh MediaStream containing the same receiving track after negotiation made playback available. Media activation applies that binding only to active video elements still at HAVE_NOTHING. The test continues to require growing RTP bytes/frames, changing received pixels on every video track, and nonzero received audio energy. Timeout diagnostics include video dimensions, layout, transceiver identity and inbound RTP/codec stats.

Evidence and exact source identities for the follow-up are saved under coordinated-linux-webkit-full/, coordinated-linux-firefox-full/, coordinated-final-chromium/, coordinated-final-macos-webkit/, coordinated-linux-ipv4/ and coordinated-linux-ipv6/ in the evidence root. The current PR checks record the final CI status for this revision.

## Selected candidate statistics retry

At commit 90a9ab72, PR ordinary CI run 39548359557 and WebRTC run 39548359756 both passed, including the complete cross-browser and supervised IPv4/IPv6 jobs. The separate push ordinary CI run 39548356026 failed its general Runway step. That workflow did not upload the runner's regression logs, so the failed test identity is unavailable. The workflow now retains regression artifacts on success or failure.

A connected transport can temporarily reference a candidate pair or local candidate that is absent from the native statistics snapshot. Runtime verification now checks every reported transport for confirmed unsafe evidence, then retries incomplete statistics through the existing six-attempt, 500 ms retry budget. Exhaustion closes fail-closed connections. Observed host, server-reflexive, unknown candidate types and unauthorized TURN URLs continue to close immediately, including when an earlier transport is incomplete.

Native browser regressions establish an authorized TURN DataChannel and exchange a control message before injecting statistics faults. Three transient cases cover missing pair references, missing local candidates and connected transports lacking a selected pair; recovery must retain the connection, exchange another message and resume periodic verification. The same three persistent cases require closure after six samples. Five mixed-transport unsafe cases require closure on the first sample. The existing rejected-statistics test remains enabled.

Final local verification of the statistics repair: Ubuntu 24.04 arm64 Chromium 40/40, Firefox 36/36 and WebKit 36/36; supervised Linux IPv4/IPv6 each 20/20. Normal packet analysis recorded 5,354/5,722 authorized TURN packets and zero unauthorized packets, with 15 direct-control packets detected in each family. Policy and credential unit tests passed 16/16. Core, declarations and Controller TypeScript checks passed; Core lint reported zero errors and 168 warnings. Production bundles built successfully. A supplemental isolated Runway typecheck reached an existing fixtures.ts callback-signature diagnostic and reported none in verification.ts.

Evidence is in stats-final-linux-chromium/, stats-final-linux-webkit/, stats-final-linux-firefox-ready/, stats-final-linux-ipv4/ and stats-final-linux-ipv6/. All five manifests match their hashes and all runtime bundle hashes match current artifacts. Chromium, WebKit and both isolation runs identify source 6ab81eb695f4dab4e933618a1b1e8471594ff0198a6328dd11a13a0b8d257fdd; the final Firefox run identifies c2771a742bdeeb1ed3de888a4f876a62fe2fc50bfbdfa6ab6ace17518f4eb724. The sole difference between those source sets is the general CI regression-artifact upload step. The initial Firefox full run started before PulseAudio initialization completed and failed sender audio activation; the complete repeat after audio readiness passed. Local runs used 15-second data soak, 2.5-second media sampling per phase and 3,600-second credentials.

## Audio playback source recovery

At commit 85692d62, both ordinary CI runs passed: PR run 39551126503 and push run 39551121034. Their retained Runway evidence reports 562 passed, 139 expected failures and 6 expected errors, with unexpected=0. PR WebRTC run 39551126411 passed Chromium 40/40, Firefox 36/36, WebKit 36/36, all three TURN transports and supervised IPv4/IPv6 20/20 each. The separate push WebRTC run 39551120973 finished WebKit 35/36; its sole failing case was the media/channel lifecycle.

The failing WebKit audio track was live and unmuted, with growing inbound RTP packets and energy and a running AudioContext, while its playback element remained at HAVE_NOTHING. The lifecycle fixture now extends its negotiation-settled MediaStream rebinding to active audio and video elements at HAVE_NOTHING. A regression deliberately assigns an empty playback stream to the newly receiving audio track and requires recovery to the actual native track. Growing per-track RTP, received audio RMS, changing video pixels, DataChannel exchange and teardown assertions remain in place.

The deterministic regression failed 0/1 before the audio rebinding change and passed 1/1 afterward. That reproduces the playback-source manifestation and validates recovery; it does not establish the cause of WebKit's internal state. Evidence is in media-audio-binding-negative/ and media-audio-binding-positive/.

| Final audio-fixture check | Result | Evidence |
| --- | --- | --- |
| Ubuntu 24.04 arm64 Playwright WebKit, complete WebRTC suite | 36/36 | audio-final-webkit/ |
| Ubuntu 24.04 arm64 Firefox media/channel lifecycle | 1/1 | audio-final-firefox/ |
| Ubuntu 24.04 arm64 Chromium media/channel lifecycle | 1/1 | audio-final-chromium/ |
| Supervised Linux IPv4 media/channel lifecycle | 1/1; 874 authorized TURN packets; 0 unauthorized normal packets | audio-final-ipv4/ |
| Supervised Linux IPv6 media/channel lifecycle | 1/1; 882 authorized TURN packets; 0 unauthorized normal packets | audio-final-ipv6/ |

The five final runs identify source SHA-256 80cbf358424428c2937812e03874e7a10d7c84b233685a470f5cf8d4dca2429f. Their manifests and runtime bundle hashes were read back with zero mismatches. Both packet analyses and expected-negative direct controls exited successfully. They used 3,600-second credentials and 2.5-second media sampling per phase. The complete Chromium/Firefox and 20/20 isolation matrices in the preceding section remain tied to their recorded statistics-repair source; the final fixture revision has the targeted coverage listed here.

## Final pushed-revision CI

Commit 9a241653e3fc5b0acf7df7d93b2d0b63f5ed8728 completed all four workflows successfully: PR ordinary CI 39554098403, push ordinary CI 39554094359, PR WebRTC 39554100449 and push WebRTC 39554094468. PR and push WebRTC runs passed Chromium 40/40, Firefox 36/36, WebKit 36/36, Chromium TURN/UDP/TCP/TLS 1/1 each and supervised IPv4/IPv6 20/20 each.

The PR enforced artifacts recorded 5,462 IPv4 and 7,473 IPv6 authorized TURN packets; the push artifacts recorded 5,599 and 6,022. Normal captures contained zero unauthorized packets, while each expected-negative direct control detected 16 unauthorized packets. All 18 downloaded manifests matched their recorded hashes. The final WebRTC artifacts identify source SHA-256 80cbf358424428c2937812e03874e7a10d7c84b233685a470f5cf8d4dca2429f. Ordinary CI retained 562 passed, 139 expected failures and 6 expected errors with expected=158, actual=145, unexpected=0, fixed=13.

The related-address review concern was probed with distinct Linux client and Coturn addresses. Chromium 149.0.7827.0, Firefox 151.0 and Playwright WebKit 26.5 each established an authorized TURN DataChannel and exchanged a real echo. Chromium/WebKit exposed raddr 0.0.0.0; Firefox exposed the TURN endpoint as its related address. Native local-candidate stats omitted relatedAddress, and candidate/SDP records did not contain the distinct client address. The concern was not reproduced in this controlled UDP topology and remains open for other browser versions or public NAT behavior. Probe records are retained under /Volumes/1T/scramjet/verification/2026-10-21-ci-repair/.

## Immutable configuration and supervised browser identity

The final local hardening test artifacts record source SHA-256 `683815d0ac67690e8b194b984b4b2a7715446c10f34e53ebae292aa8006efc15` and the implementation patch SHA-256 `0a0524c7f07cbd2aceca943e9730756597477d28803b0c9cdde527157042640b`. Browser and isolation `source.json` records include the runtime bundle hashes; each manifest was checked against the files on disk with zero mismatches.

The policy snapshot now clones and freezes the normalized WebRTC configuration, including ICE server entries and URL arrays, so later realm initialization inherits the same immutable policy. The regression suite covers mutation attempts against relay and enforced settings. Supervised Chromium runs as UID/GID 65534 with empty capability sets and `no_new_privs`. Fault tests confirm renderer seccomp filters and denied nftables mutation, and verify that the supervisor terminates the browser and removes the namespace after both a removed policy table and an injected allow rule.

| Final local hardening check | Result | Evidence |
| --- | --- | --- |
| Policy unit tests | 15/15 | security-handoff-unit.log |
| TURN credential unit tests | 2/2 | security-handoff-credentials.log |
| Core, declarations and Controller TypeScript checks | 0 errors | security-handoff-quality.log |
| Core lint | 0 errors, 168 warnings | security-handoff-quality.log |
| macOS Chromium relay suite | 42/42 | security-browser/ |
| macOS Firefox relay suite | 38/38 | security-browser/ |
| macOS WebKit relay suite with default route TURN address | 16/38 | security-browser/ |
| macOS WebKit relay suite with LAN TURN address | 38/38 | security-webkit-lan-ready/ |
| Cross-browser policy snapshot matrix | 2/2 per Chromium, Firefox and WebKit | security-snapshot-final/ |
| Supervised Linux IPv4 enforced suite | 22/22; 7,324 TURN packets; 0 unauthorized normal packets | security-ipv4/ |
| Supervised Linux IPv6 enforced suite | 22/22; 5,495 TURN packets; 0 unauthorized normal packets | security-ipv6/ |
| Direct packet negative controls | 15 unauthorized IPv6 packets detected per run; expected-negative analyses exit 0 | security-ipv4/, security-ipv6/ |
| Policy-loss supervisor fault cases | 2/2; browser terminated and namespace removed | security-supervisor-2/ |

The first macOS WebKit run used the default route-selected TURN address and timed out on relay gathering and direct-connect prerequisites. Repeating the same suite against the reachable LAN TURN address completed 38/38; this records the route-specific local environment result and does not alter the platform acceptance scope above. The WebKit result is Playwright WebKit on macOS, not physical iOS Safari. Full run records, browser output, packet captures and supervisor receipts are in `/Volumes/1T/scramjet/verification/2026-10-21-ci-repair/`.

## Bounded runner execution and coordinated fixture teardown

Date: 2026-10-21. Repair baseline: `f042b859d448496da1713fce5ececee0b22a78d5`.

Concurrent native peers now retain their PeerConnections and signaling WebSockets until both peers' receive and statistics results settle, then close the resources together. HTTP fixture teardown calls `server.close` and closes open or unfinished requests; the WebRTC fixture completes that teardown even when its stop hook fails. Opt-in `RUNWAY_PROGRESS=1` logs identify worker, test and lifecycle stage, and both browser runners enable them.

The Python runner launches the test in an owned process session and bounds idle time and total runtime. A timeout returns exit code 124 and writes a `*.watchdog.json` diagnostic containing the reason, elapsed and idle time, limits, process ID and log name. Teardown sends TERM and then KILL to the owned process session, including surviving descendants. TURN and network control commands have bounded execution, and teardown preserves the control-action record.

The default allowance is `max(WEBRTC_SOAK_SECONDS, 10 * WEBRTC_MEDIA_SOAK_SECONDS)`. The idle limit is `300 + allowance` seconds and the total limit is `1800 + 2 * allowance` seconds. `WEBRTC_RUN_IDLE_TIMEOUT_SECONDS` and `WEBRTC_RUN_TIMEOUT_SECONDS` override those limits. Soak durations, timeouts and the termination grace period must be finite positive values. WebRTC CI runs the HTTP-fixture disposal and Python watchdog regressions.

The runner-repair local source SHA-256 is `ebe6ed72074197be4f0d28ebdc9aeb3d9271cd87405acd393150411c3a98f395`. Evidence is under `/Volumes/1T/scramjet/verification/2026-10-21-ci-repair/runner-watchdog/`.

| Local check | Result | Evidence |
| --- | --- | --- |
| Node unit tests | 18/18 | Retained unit-test output |
| Python runner tests | 5/5 | Retained runner-test output |
| Core, declarations and Controller TypeScript | 0 errors | Retained quality output |
| Core lint | 0 errors, 168 warnings | Retained quality output |
| macOS Chromium WebRTC suite | 42/42 | `chromium-final/` |
| macOS Firefox WebRTC suite | 38/38 | `firefox-final/` |
| macOS Playwright WebKit WebRTC suite | 38/38 | `webkit-current-lan/` |
| Supervised Linux IPv4 enforced suite | 22/22; 6,258 TURN packets; 0 unauthorized normal packets | `linux-ipv4-final/` |
| Supervised Linux IPv6 enforced suite | 22/22; 5,564 TURN packets; 0 unauthorized normal packets | `linux-ipv6-final/` |
| Expected-negative direct controls | 15 unauthorized packets detected for IPv4 and 16 for IPv6; both analyses exited 0 | Both final Linux evidence directories |
| Manifest and runtime-bundle readback | All five manifests and runtime-bundle hashes match the current artifacts | `local-manifest-readback.json` |

The runs used 15-second data soak, 2.5-second media sampling per phase and 120-second TURN credentials. Their recorded source identities match the digest above.

An earlier WebKit run in `webkit-final/` used a previously valid LAN address after the interface changed. Relay candidate gathering was unavailable, and the run was manually interrupted with exit code 130. Full-suite WebKit coverage is the completed 38/38 repeat in `webkit-current-lan/`; the interrupted run remains a diagnostic audit record.

The runner repair was pushed as `39d803c11e5241f46482e127b196776d4dd7633c`. PR and push ordinary CI runs `39595599725` and `39595592797`, and WebRTC runs `39595599668` and `39595592916`, completed successfully. These results apply to the runner-repair revision.

## Guarded constructor references and native function compatibility

Repair baseline: `39d803c11e5241f46482e127b196776d4dd7633c`.

The runtime now routes the prototype constructor, native store, constructor cache and shared unproxy registry through the same guarded WebRTC constructor and method references. The native implementations remain captured in the runtime closure. Global, prototype, property-descriptor, Reflect, bound-function, subclass and cached-reference construction all apply the configured relay or enforced policy. The guarded native store also retains policy checks for `setConfiguration`, `setLocalDescription`, `restartIce` and `close`.

Guarded functions retain their native display strings in a weak registry consumed by the existing `Function.prototype.toString` hook. Constructor identity, descriptor flags, subclass prototypes, native error types and function strings are checked against an unproxied native control. The test matrix covers off, relay, verified enforced, missing credentials and missing isolation. A real TURN DataChannel created through the prototype constructor exchanges messages before and after ICE restart. The fixture waits up to five seconds for asynchronous native local-candidate statistics before asserting relay candidates.

Evidence root: `/Volumes/1T/scramjet/verification/2026-10-21-constructor/`.

| Check | Result | Evidence |
| --- | --- | --- |
| macOS Chromium complete WebRTC suite | 48/48 | `browser-verified/chromium-udp.log` |
| macOS Firefox complete WebRTC suite | 44/44 | `firefox-verified/firefox-udp.log` |
| macOS Playwright WebKit complete WebRTC suite | 44/44 | `browser-verified/webkit-udp.log` |
| Supervised Linux IPv4 enforced suite | 23/23; 5,500 authorized TURN packets; 0 unauthorized normal packets | `linux-ipv4-verified/` |
| Supervised Linux IPv6 enforced suite | 23/23; 5,454 authorized TURN packets; 0 unauthorized normal packets | `linux-ipv6-verified/` |
| Expected-negative direct controls | 15 unauthorized packets detected per run; both expected-negative analyses exited 0 | Both verified Linux directories |
| Node policy, credential and HTTP-fixture unit tests | 18/18 | `units-precommit.log` |
| Python runner tests | 5/5 | `python-precommit.log` |
| Core, declarations and Controller TypeScript | 0 errors | `quality-precommit.log` |
| Core lint | 0 errors, 169 warnings | `quality-precommit.log` |
| Node 24 package validation | 5/5 | `package-node24-final.log` |
| Source, runtime bundle and artifact-manifest readback | All four verified run directories match the tested source and current bundles | `final-readback.json` |

The tested source SHA-256 is `9c39d9b9bd78ebde4af4cfadb2f4ef377978124e115c772f8273b8fc91a8caf3`. Each run records the baseline Git SHA plus the exact source-file and runtime-bundle hashes; the source digest includes this constructor repair. The committed source files preserve those exact bytes. Runs used 120-second TURN credentials, 15-second data soak and 2.5-second media sampling per phase. Chromium/WebKit used the reachable LAN TURN address and Firefox used the route-selected address.

A supplemental full Runway typecheck still reports three diagnostics in unchanged files: `testcommon.ts` (`shouldUpgradeCallback` server option), `fixtures.ts` (server-close callback signature) and `helpers.ts` (`number | void` result). It reports none in the constructor repair files. The diagnostic output is retained in `runway-typecheck-final.log`.

The local constructor-repair matrix is complete. CI for the pushed constructor revision is tracked in [PR #1](https://github.com/tzf1003/scramjet/pull/1). Acceptance covers desktop automation and the supervised Docker/Linux network namespace. Playwright WebKit on macOS does not establish real iOS Safari coverage. Further deployment acceptance covers Windows/Android, physical cameras and microphones and permission flows, independent public peers, public NAT64/VPN/multihoming, production TURN TLS certificates, Firefox/WebKit TLS, hour-scale soak, performance and resource curves. Kernel controls provide the authoritative enforced egress boundary.

## Native statistics sampling and popup initialization

For commit `4967e6f2097e390e99cd0fc3141acd562f4caeb6`, ordinary push CI `39612182864` and PR CI `39612190568` passed. Push WebRTC run `39612182922` passed all jobs. PR WebRTC run `39612190605` passed quality, units, Chromium, TURN transports and supervised IPv4/IPv6 isolation; Firefox and WebKit each finished 43/44. Firefox failed the constructor ICE-restart candidate assertion, and WebKit timed out loading the second tab's proxied test document. Downloaded diagnostics are retained in `/Volumes/1T/scramjet/verification/2026-10-21-constructor/ci-readback/`.

The constructor regression previously waited for a candidate in one native `getStats()` result, then asserted a second result. ICE restart can change entries between these snapshots. It now polls `readDataPeer()` for up to five seconds and asserts the exact sample that met the readiness condition. Relay candidate types, emitted SDP candidates and real DataChannel echoes before and after restart remain required.

The popup regression now selects the harness's explicit manual-navigation option. It asserts that the ready harness has not navigated a proxied frame, then installs that tab's fixture mapping and WebRTC policy before its first target navigation. This removes concurrent automatic restoration and explicit navigation from the fixture. Normal harness reloads retain automatic restoration. A failed second-tab load includes captured tab errors. The previous CI timeout did not reproduce in the initial local WebKit run, so the diagnosis is based on the startup ordering in the harness rather than a deterministic reproduction of that timeout.

`waitForProxiedFrame()` now passes its timeout as Playwright's third argument. Each readiness attempt is bounded to two seconds or the remaining 20-second deadline. This makes the existing outer deadline effective when the target document does not initialize.

The final local runs identify source SHA-256 `4355c8433a4e4884848a2e0de4ddeae6adefea06387743920cb767d6239eab7f`. Evidence is retained under `/Volumes/1T/scramjet/verification/2026-10-21-tab-lifecycle/`.

| Final sampling and popup check | Result | Evidence |
| --- | --- | --- |
| macOS Chromium complete WebRTC suite | 48/48 | `verified-chromium-firefox/chromium-udp.log` |
| macOS Firefox complete WebRTC suite | 44/44 | `verified-chromium-firefox/firefox-udp.log` |
| macOS Playwright WebKit complete WebRTC suite | 44/44 | `verified-webkit/webkit-udp.log` |
| Core, declarations and Controller TypeScript | 0 errors | `quality.log` |
| Core lint | 0 errors, 169 warnings | `quality.log` |
| Source, runtime bundle and artifact-manifest readback | Both run directories match; 20 manifest entries checked; 0 mismatches | `final-readback.json` |

These runs used 120-second TURN credentials, 15-second data soak and 2.5-second media sampling per phase. Chromium/Firefox used the route-selected TURN address; WebKit used the current reachable LAN address. The final complete matrix includes native DataChannel exchange, constructor ICE restart, cross-origin/top-level-tab coverage, credential renewal, TURN failure, media lifecycle and selected-candidate fault cases.

Intermediate diagnostics remain in the same evidence root: `final-chromium-firefox/` records the earlier popup initialization attempt failing Firefox service-worker control, and `manual-firefox/` records an initial cross-origin child readiness timeout. The diagnostic repeat and final full matrix passed. These records retain their own source identities and are separate from the final matrix above.

A supplemental scoped Runway TypeScript invocation reports four diagnostics on unchanged statements: the data-URL import in `coverage.ts`, the asynchronous `onServer` return type, the server-close callback in `fixtures.ts`, and the optional port result in `helpers.ts`. The main Core/declaration/Controller quality gate passed. The scoped diagnostics are retained in `runway-typecheck.log`.

The earlier 23/23 IPv4/IPv6 packet-isolation results remain bound to constructor-repair source `9c39d9b9bd78ebde4af4cfadb2f4ef377978124e115c772f8273b8fc91a8caf3`. This follow-up changes browser test fixtures and the test harness. Current-revision Linux isolation and TURN transport CI results are pending; pushing this follow-up will trigger those checks in PR #1. Deployment acceptance retains the physical-device, public-network, additional-platform and soak boundaries listed above.
