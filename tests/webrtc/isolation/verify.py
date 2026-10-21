#!/usr/bin/env python3
"""Assert each unauthorized endpoint is blocked and emit a namespace-bound receipt."""
import errno
import ipaddress
import json
import os
import secrets
import socket
import subprocess
import sys
import time
from urllib.parse import urlsplit
from policy import command, digest, table_name, address, port, specification


def deny_anchor(name):
    items = json.loads(command("nft", "--json", "list", "table", "inet", name).stdout)["nftables"]
    chains = [item["chain"] for item in items if "chain" in item]
    if len(chains) != 1 or any(chains[0].get(key) != value for key, value in {
        "family": "inet", "table": name, "name": "output", "type": "filter",
        "hook": "output", "policy": "drop",
    }.items()):
        raise ValueError("expected a single default-drop output base chain")
    rules = [item["rule"] for item in items if "rule" in item]
    markers = [rule for rule in rules if rule.get("comment") == "scramjet-webrtc-default-deny"]
    if len(markers) != 1 or not rules or markers[0] != rules[-1]:
        raise ValueError("expected one final default-deny rule")
    rule = markers[0]
    if rule.get("chain") != "output" or rule.get("table") != name or rule.get("family") != "inet":
        raise ValueError("default-deny rule is outside the output chain")
    expressions = rule.get("expr", [])
    if len(expressions) != 2 or set(expressions[0]) != {"counter"} or expressions[1] != {"drop": None}:
        raise ValueError("default-deny must be an unconditional counter followed by drop")
    return rule["handle"]


def verify_allowlist(name):
    items = json.loads(command("nft", "--json", "list", "table", "inet", name).stdout)["nftables"]
    chains = [item["chain"] for item in items if "chain" in item]
    if chains[0].get("prio") != 0:
        raise ValueError("output chain priority differs from the installed policy")
    def normalize(value):
        if isinstance(value, dict):
            if "counter" in value:
                return {"counter": {}}
            if "set" in value:
                return {"set": sorted(value["set"], key=str)}
            return {key: normalize(item) for key, item in value.items() if key not in ("handle", "index")}
        if isinstance(value, list):
            return [normalize(item) for item in value]
        return value
    actual = [normalize(item["rule"]) for item in items if "rule" in item]
    _, expected, _ = specification()
    if actual != normalize(expected):
        raise ValueError("output rules differ from the configured endpoint allowlist")


def udp_target(value):
    parsed = urlsplit("udp://" + value)
    if parsed.hostname is None or parsed.port is None:
        raise ValueError("UDP targets must be IP:port or [IPv6]:port")
    return ipaddress.ip_address(parsed.hostname), parsed.port


def tcp_target(value):
    parsed = urlsplit(value)
    if parsed.hostname is None:
        raise ValueError("TCP probe URL needs an IP address")
    return ipaddress.ip_address(parsed.hostname), parsed.port or (443 if parsed.scheme == "https" else 80)


def probe(name, protocol, host, number):
    family = socket.AF_INET6 if host.version == 6 else socket.AF_INET
    command("ip", "-6" if host.version == 6 else "-4", "route", "get", str(host))
    anchor = deny_anchor(name)
    marker = "sj-probe-" + secrets.token_hex(8)
    family_name = "ip6" if host.version == 6 else "ip"
    # Observe this destination without changing its verdict. The existing final
    # drop must enforce denial; instrumentation must never make a bad policy pass.
    command("nft", "insert", "rule", "inet", name, "output", "position", str(anchor),
            family_name, "daddr", str(host), protocol, "dport", str(number), "counter", "comment", marker)
    handle = None
    try:
        def observation():
            items = json.loads(command("nft", "--json", "list", "table", "inet", name).stdout)["nftables"]
            rule = next(item["rule"] for item in items if item.get("rule", {}).get("comment") == marker)
            packets = next(expr["counter"]["packets"] for expr in rule["expr"] if "counter" in expr)
            return rule["handle"], packets
        handle, before = observation()
        with socket.socket(family, socket.SOCK_DGRAM if protocol == "udp" else socket.SOCK_STREAM) as sock:
            sock.settimeout(0.8)
            try:
                if protocol == "tcp":
                    sock.connect((str(host), number))
                    raise ValueError(f"unauthorized TCP endpoint is reachable: {host}:{number}")
                sock.sendto(secrets.token_bytes(24), (str(host), number))
                sock.recvfrom(65535)
                raise ValueError(f"unauthorized UDP endpoint replied: {host}:{number}")
            except (TimeoutError, socket.timeout):
                pass
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EPERM):
                    raise ValueError(f"probe did not demonstrate a firewall drop: {error}") from error
        _, after = observation()
        if after <= before:
            raise ValueError(f"{protocol}/IPv{host.version} probe was not dropped by its destination-specific rule")
        return {"protocol": protocol, "family": host.version, "host": str(host), "port": number,
                "deniedBefore": before, "deniedAfter": after, "blocked": True}
    finally:
        if handle is not None:
            command("nft", "delete", "rule", "inet", name, "output", "handle", str(handle))


def verify():
    name = table_name()
    initial = digest(name)
    deny_anchor(name)
    verify_allowlist(name)
    targets = [("tcp", *tcp_target(os.environ.get("UNAUTHORIZED_TCP_URL", "http://169.254.169.254/"))),
               ("udp", *udp_target(os.environ["UNAUTHORIZED_UDP_TARGET"]))]
    v6tcp = os.environ.get("UNAUTHORIZED_IPV6_TCP_URL")
    v6udp = os.environ.get("UNAUTHORIZED_IPV6_UDP_TARGET")
    if os.environ.get("REQUIRE_IPV6", "0") == "1" and not (v6tcp and v6udp):
        raise ValueError("IPv6 TCP and UDP probes are required")
    if v6tcp:
        targets.append(("tcp", *tcp_target(v6tcp)))
    if v6udp:
        targets.append(("udp", *udp_target(v6udp)))
    if os.environ.get("UNAUTHORIZED_DNS_TARGET"):
        targets.append(("udp", *udp_target(os.environ["UNAUTHORIZED_DNS_TARGET"])))
        targets.append(("tcp", *udp_target(os.environ["UNAUTHORIZED_DNS_TARGET"])))
    if os.environ.get("UNAUTHORIZED_IPV6_DNS_TARGET"):
        for protocol in ("udp", "tcp"):
            targets.append((protocol, *udp_target(os.environ["UNAUTHORIZED_IPV6_DNS_TARGET"])))
    if os.environ.get("UNAUTHORIZED_RELAY_PROBE_TARGET"):
        targets.append(("udp", *udp_target(os.environ["UNAUTHORIZED_RELAY_PROBE_TARGET"])))
    probes = [probe(name, protocol, host, number) for protocol, host, number in targets]
    for key in ("TURN_HOST", "TURN_HOST_V6"):
        host = address(key, key == "TURN_HOST")
        if host is not None:
            family = socket.AF_INET6 if host.version == 6 else socket.AF_INET
            with socket.socket(family, socket.SOCK_STREAM) as turn_probe:
                turn_probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                turn_probe.settimeout(2)
                source_port = int(os.environ.get("TURN_PROBE_SOURCE_PORT", "0"))
                turn_probe.bind(("::" if host.version == 6 else "0.0.0.0", source_port))
                turn_probe.connect((str(host), port("TURN_PORT", 13478)))

    if digest(name) != initial:
        raise ValueError("network policy changed during verification")
    result = {"policyVersion": 3, "table": name, "policySha256": initial,
              "networkNamespace": os.readlink("/proc/self/ns/net"),
              "verifiedAt": time.time(), "runId": os.environ.get("WEBRTC_RUN_ID", secrets.token_hex(12)),
              "probes": probes, "ok": True}
    print(json.dumps(result))
    directory = os.environ.get("EVIDENCE_DIR")
    if directory:
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "isolation.json"), "w") as output:
            json.dump(result, output, indent=2)


if __name__ == "__main__":
    try:
        verify()
    except (ValueError, KeyError, OSError, RuntimeError) as error:
        print("FAIL: " + str(error), file=sys.stderr)
        sys.exit(1)
