# Enforced isolation evidence (2026-10-20)

Run ID: `9399d0a7725946bfb824f2a162f8a5af`

Environment: privileged Linux container, dual-stack veth namespace, Chromium
inside the namespace, Harness/Wisp/coturn/credential service on the host side.

- `policy.json`: endpoint-qualified policy identity and allowed endpoints.
- `isolation.json`: IPv4/IPv6 TCP/UDP and unsigned DNS probes; each destination
  increments its own drop counter and is blocked.
- `browser-direct-control.json`: native direct WebRTC fails while isolation is
  active and succeeds after the test removes the policy (negative control).
- `client-egress.json`: client-side PCAP analysis; 592 IPv6 TURN packets
  observed, no unauthorised packets, policy/receipt/run identity correlated.
- `nftables.txt`: installed ruleset.

The raw client PCAP is retained outside git. The Runway DataChannel + ICE
Restart test passed under `WEBRTC_TEST_MODE=enforced` in the same namespace.
