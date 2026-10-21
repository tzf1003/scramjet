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

These measurements cover desktop automation and the supervised Linux Docker topology. Physical media devices, real mobile Safari, independent public peers, public NAT64/VPN/multihoming and hour-scale system resource acceptance retain the boundaries documented in webrtc-test-report.md.
