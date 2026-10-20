#!/usr/bin/env python3
"""Install one endpoint-qualified nftables transaction and describe its identity."""
import hashlib
import ipaddress
import json
import os
import re
import subprocess
import sys


def command(*args, data=None, check=True):
    result = subprocess.run(args, input=data, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or "command failed: " + args[0])
    return result


def table_name():
    name = os.environ.get("NFT_TABLE", "scramjet_webrtc")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", name):
        raise ValueError("NFT_TABLE must be an nftables identifier")
    return name


def address(name, required=False):
    raw = os.environ.get(name, "")
    if not raw:
        if required:
            raise ValueError(name + " is required")
        return None
    return ipaddress.ip_address(raw)


def port(name, default):
    raw = os.environ.get(name, str(default))
    if not raw.isascii() or not raw.isdigit() or not 1 <= int(raw) <= 65535:
        raise ValueError(name + " must be a port between 1 and 65535")
    return int(raw)


def digest(name):
    value = json.loads(command("nft", "--stateless", "--json", "list", "table", "inet", name).stdout)
    def stable(item):
        if isinstance(item, dict):
            return {key: stable(val) for key, val in item.items() if key not in ("handle", "packets", "bytes")}
        if isinstance(item, list):
            return [stable(val) for val in item]
        return item
    return hashlib.sha256(json.dumps(stable(value), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def install():
    name = table_name()
    proxy = [address("SCRAMJET_HOST", True), address("SCRAMJET_HOST_V6")]
    turn = [address("TURN_HOST", True), address("TURN_HOST_V6")]
    dns = [address("DNS_HOST"), address("DNS_HOST_V6")]
    proxy_ports = [port("SCRAMJET_PORT", 4500), port("SCRAMJET_WISP_PORT", 4501)]
    for raw in filter(None, os.environ.get("SCRAMJET_EXTRA_TCP_PORTS", "").split(",")):
        if not raw.isascii() or not raw.isdigit() or not 1 <= int(raw) <= 65535:
            raise ValueError("SCRAMJET_EXTRA_TCP_PORTS must contain explicit port numbers")
        proxy_ports.append(int(raw))
    if os.environ.get("TARGET_TCP_RANGE"):
        raise ValueError("TARGET_TCP_RANGE is unsupported; authorize explicit service ports instead")
    turn_port = port("TURN_PORT", 13478)
    tls_port = port("TURN_TLS_PORT", 15349)
    low, high = port("TURN_RELAY_MIN", 50160), port("TURN_RELAY_MAX", 50200)
    if low > high:
        raise ValueError("TURN_RELAY_MIN must not exceed TURN_RELAY_MAX")
    loopback = os.environ.get("ALLOW_LOOPBACK", "0")
    if loopback not in ("0", "1"):
        raise ValueError("ALLOW_LOOPBACK must be 0 or 1")
    lines = []
    if command("nft", "list", "table", "inet", name, check=False).returncode == 0:
        lines.append("delete table inet " + name)
    lines += ["table inet " + name + " {", "chain output {", "type filter hook output priority 0; policy drop;"]
    if loopback == "1":
        lines.append('oif "lo" counter accept comment "scramjet-webrtc-loopback"')
    # Permit neighbor discovery, not arbitrary IPv6 data or echo traffic.
    lines.append('meta l4proto ipv6-icmp ip6 hoplimit 255 icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert } accept')
    def allow(host, protocol, ports, label):
        if host is not None:
            family = "ip6" if host.version == 6 else "ip"
            lines.append(f'{family} daddr {host} {protocol} dport {ports} counter accept comment "{label}"')
    for host in proxy:
        allow(host, "tcp", "{ " + ", ".join(map(str, sorted(set(proxy_ports)))) + " }", "scramjet-proxy")
    for host in turn:
        allow(host, "udp", str(turn_port), "turn-udp")
        allow(host, "tcp", f"{{ {turn_port}, {tls_port} }}", "turn-tcp-tls")
        allow(host, "udp", f"{low}-{high}", "turn-relay-udp")
    for host in dns:
        for protocol in ("udp", "tcp"):
            allow(host, protocol, str(port("DNS_PORT", 53)), "dns-" + protocol)
    # Every packet remains destination-qualified, including established flows.
    lines += ['counter drop comment "scramjet-webrtc-default-deny"', "}", "}"]
    batch = "\n".join(lines) + "\n"
    command("nft", "--check", "--file", "-", data=batch)
    command("nft", "--file", "-", data=batch)
    result = {"policyVersion": 2, "table": name, "policySha256": digest(name),
              "networkNamespace": os.readlink("/proc/self/ns/net"), "installed": True,
              "proxyHosts": [str(host) for host in proxy if host is not None], "proxyTcpPorts": proxy_ports,
              "turnHosts": [str(host) for host in turn if host is not None], "turnUdpPort": turn_port,
              "turnTcpPorts": [turn_port, tls_port], "relayPorts": [low, high],
              "dnsHosts": [str(host) for host in dns if host is not None], "dnsPort": port("DNS_PORT", 53)}
    print(json.dumps(result))
    directory = os.environ.get("EVIDENCE_DIR")
    if directory:
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "policy.json"), "w") as output:
            json.dump(result, output, indent=2)
        with open(os.path.join(directory, "nftables.txt"), "w") as output:
            output.write(command("nft", "list", "table", "inet", name).stdout)


if __name__ == "__main__":
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "digest":
            print(digest(table_name()))
        else:
            install()
    except (ValueError, OSError, RuntimeError) as error:
        print("WebRTC isolation: " + str(error), file=sys.stderr)
        sys.exit(1)
