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
| Direct packet controls | 15 unauthorized packets detected in each family; both expected-negative analyses exit 0 | linux-ipv4/negative-egress.json, linux-ipv6/negative-egress.json |
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

At commit 281735d7, ordinary CI run 39544921749 passed. WebRTC run 39544921682 passed quality, units, Chromium and all three TURN transports, plus the complete enforced job. Firefox finished 24/25: one peer closed its connection after receiving the ICE-restart echo while the other was still collecting asynchronous statistics. WebKit finished 24/25: the added video track decoded RTP frames, but its playback element remained at HAVE_NOTHING. Linux packet readback recorded 7,415 IPv4 and 5,817 IPv6 authorized TURN packets, zero unauthorized normal packets, and 16 detected direct-control packets per family. These artifacts identify the PR merge snapshot 59b4838118aaef256ca0ff7a9d95eb8b5b82c992.

The DataChannel fixture now retains both native connections until both results are captured, then closes both connections and signaling sockets and cancels pending timers. Cleanup waits for native channel closure and asserts both peers and channels are closed.

The Linux WebKit failure was reproduced with Playwright 1.61.0 on Ubuntu 24.04 arm64 and a PulseAudio null sink. The added video was visible and its inbound stats showed decoded 320x240 frames, while the element reported zero dimensions. Binding a fresh MediaStream containing the same receiving track after negotiation made playback available. Media activation applies that binding only to active video elements still at HAVE_NOTHING. The test continues to require growing RTP bytes/frames, changing received pixels on every video track, and nonzero received audio energy. Timeout diagnostics include video dimensions, layout, transceiver identity and inbound RTP/codec stats.

Evidence and exact source identities for the follow-up are saved under coordinated-linux-webkit-full/, coordinated-linux-firefox-full/, coordinated-final-chromium/, coordinated-final-macos-webkit/, coordinated-linux-ipv4/ and coordinated-linux-ipv6/ in the evidence root. The current PR checks record the final CI status for this revision.

## Selected candidate statistics retry

At commit 90a9ab72, PR ordinary CI run 39548359557 and WebRTC run 39548359756 both passed, including the complete cross-browser and supervised IPv4/IPv6 jobs. The separate push ordinary CI run 39548356026 failed its general Runway step. That workflow did not upload the runner's regression logs, so the failed test identity is unavailable. The workflow now retains regression artifacts on success or failure.

A connected transport can temporarily reference a candidate pair or local candidate that is absent from the native statistics snapshot. Runtime verification now checks every reported transport for confirmed unsafe evidence, then retries incomplete statistics through the existing six-attempt, 500 ms retry budget. Exhaustion closes fail-closed connections. Observed host, server-reflexive, unknown candidate types and unauthorized TURN URLs continue to close immediately, including when an earlier transport is incomplete.

Native browser regressions establish an authorized TURN DataChannel and exchange a control message before injecting statistics faults. Three transient cases cover missing pair references, missing local candidates and connected transports lacking a selected pair; recovery must retain the connection, exchange another message and resume periodic verification. The same three persistent cases require closure after six samples. Five mixed-transport unsafe cases require closure on the first sample. The existing rejected-statistics test remains enabled.

Final local verification of the statistics repair: Ubuntu 24.04 arm64 Chromium 40/40, Firefox 36/36 and WebKit 36/36; supervised Linux IPv4/IPv6 each 20/20. Normal packet analysis recorded 5,354/5,722 authorized TURN packets and zero unauthorized packets, with 15 direct-control packets detected in each family. Policy and credential unit tests passed 16/16. Core, declarations and Controller TypeScript checks passed; Core lint reported zero errors and 168 warnings. Production bundles built successfully. A supplemental isolated Runway typecheck reached an existing fixtures.ts callback-signature diagnostic and reported none in verification.ts.

Evidence is in stats-final-linux-chromium/, stats-final-linux-webkit/, stats-final-linux-firefox-ready/, stats-final-linux-ipv4/ and stats-final-linux-ipv6/. All five manifests match their hashes and all runtime bundle hashes match current artifacts. Chromium, WebKit and both isolation runs identify source 6ab81eb695f4dab4e933618a1b1e8471594ff0198a6328dd11a13a0b8d257fdd; the final Firefox run identifies c2771a742bdeeb1ed3de888a4f876a62fe2fc50bfbdfa6ab6ace17518f4eb724. The sole difference between those source sets is the general CI regression-artifact upload step. The initial Firefox full run started before PulseAudio initialization completed and failed sender audio activation; the complete repeat after audio readiness passed. Local runs used 15-second data soak, 2.5-second media sampling per phase and 3,600-second credentials.
