# Supervised WebRTC isolation

`run-in-netns.sh` runs the host-side test process and launches only Chromium in a
fresh dual-stack Linux network namespace. It needs root, Python 3, nftables,
iproute2, tcpdump and `setpriv`. Setup and supervision retain root; Chromium runs
with a non-root UID/GID, zero capabilities, `no_new_privs`, a private profile and
its native sandbox enabled. User-namespace sandbox support is required. See
`docs/webrtc-deployment.md` for the complete command.

The policy permits only explicitly configured proxy, credential/signaling, TURN
and optional DNS endpoints. There is no broad established-connection exception.
Rule updates are atomic. Invalid replacement rules keep the prior boundary.

The launcher verifies IPv4/IPv6 TCP and UDP, unauthorized DNS, a real native-browser
connection that fails with isolation enabled, and the same direct connection that
succeeds when the test temporarily removes isolation. It restores and reverifies
the policy before starting the application suite. A namespace/ruleset digest
identifies each receipt; the supervisor stops Chromium when the digest changes.

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to the installed browser, `TURN_HOST` to the
reachable IPv4 relay, and optionally `TURN_HOST_V6` to its IPv6 listener. The test
command receives `WEBRTC_TEST_MODE=enforced`, a browser wrapper executable and
explicit service ports. Configure `SCRAMJET_EXTRA_TCP_PORTS` for additional trusted
services; port ranges are rejected. `ALLOW_LOOPBACK` defaults to 0.

`MASQUERADE=1` can be used in a disposable test container when Coturn is on another
container subnet. Cleanup removes only the task-owned namespace/interface/NAT
rules and restores prior forwarding state. Existing namespace/interface names are
rejected, preserving other running tests.

Fault-injection regression:

```sh
docker run --rm --network none --cap-add NET_ADMIN \
  -v "$PWD/tests/webrtc/isolation:/isolation:ro" \
  nicolaka/netshoot python3 /isolation/regression.py
```

Artifacts: `policy.json`, `isolation.json`, `browser-direct-control.json`,
`client.pcap` and Runway JSON. All use the same run ID. After the run, inspect the
client capture with `tests/webrtc/capture/check-client-egress.py`; it correlates
policy and receipt identity, requires observed TURN packets and fails on
unauthorized IPv4/IPv6 TCP/UDP destination packets.

Chromium policy JSON files provide additional browser policy guidance. The
`disable_non_proxied_udp` policy blocks TURN/UDP, so the compatible isolation
boundary is the supervised network namespace and nftables policy.
