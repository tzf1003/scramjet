#!/usr/bin/env python3
import argparse
import hashlib
import ipaddress
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("pcap")
parser.add_argument("--policy", required=True)
parser.add_argument("--receipt", required=True)
parser.add_argument("--client-ip", default="10.200.0.2")
parser.add_argument("--client-ipv6", default="fd42:736a:1::2")
parser.add_argument("--output", required=True)
parser.add_argument("--expect-unauthorized", action="store_true")
args = parser.parse_args()
policy = json.loads(Path(args.policy).read_text())
receipt = json.loads(Path(args.receipt).read_text())
if not receipt.get("ok") or not policy.get("installed"):
    raise SystemExit("a successful installation and verification receipt are required")
if policy["policySha256"] != receipt["policySha256"] or policy["networkNamespace"] != receipt["networkNamespace"]:
    raise SystemExit("policy and verification receipt do not identify the same boundary")
cmd = ["tshark", "-r", args.pcap, "-T", "fields"]
for field in ["frame.number", "ip.src", "ipv6.src", "ip.dst", "ipv6.dst", "tcp.dstport", "udp.dstport", "sll.pkttype", "icmpv6.type", "ipv6.hlim"]:
    cmd += ["-e", field]
rows = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.splitlines()
clients = {args.client_ip, args.client_ipv6}
violations, turn_packets = [], {"ipv4": 0, "ipv6": 0}
sources = set()
for row in rows:
    values = (row.split("\t") + [""] * 10)[:10]
    number, src4, src6, dst4, dst6, tcp, udp, packet_type, icmp6, hop_limit = values
    # Capture direction also covers addresses introduced by a new NIC/VPN.
    # The source fallback supports older Ethernet captures from known clients.
    if packet_type != "4" and not (packet_type == "" and (src4 in clients or src6 in clients)):
        continue
    if not src4 and not src6:  # ARP has no IP payload.
        continue
    sources.add(src4 or src6)
    destination = dst4 or dst6
    if not tcp and not udp:
        if src6 and icmp6 in ("135", "136") and hop_limit == "255":
            continue  # Same neighbor-discovery exception as the installed policy.
        violations.append({"frame": number, "destination": destination, "protocol": "other-ip"})
        continue
    number_port = int(tcp or udp)
    allowed = False
    if destination in policy["proxyHosts"] and tcp and number_port in policy["proxyTcpPorts"]:
        allowed = True
    if destination in policy["turnHosts"]:
        udp_ports = policy.get("turnUdpPorts")
        # Old receipts describe the legacy client relay-range allowance.
        relay_range_allowed = (policy.get("clientRelayRange", False) or udp_ports is None) and policy["relayPorts"][0] <= number_port <= policy["relayPorts"][1]
        allowed_udp = number_port in udp_ports or relay_range_allowed if udp_ports is not None else (number_port == policy["turnUdpPort"] or relay_range_allowed)
        if tcp and number_port in policy["turnTcpPorts"] or udp and allowed_udp:
            allowed = True
            turn_packets["ipv6" if ipaddress.ip_address(destination).version == 6 else "ipv4"] += 1
    if destination in policy["dnsHosts"] and number_port == policy["dnsPort"]:
        allowed = True
    if not allowed:
        violations.append({"frame": number, "destination": destination, "protocol": "tcp" if tcp else "udp", "port": number_port})
result = {"runId": receipt["runId"], "policySha256": policy["policySha256"],
          "pcapSha256": hashlib.sha256(Path(args.pcap).read_bytes()).hexdigest(),
          "clientSources": sorted(sources), "turnPackets": turn_packets, "unauthorizedPackets": violations,
          "ok": not violations and sum(turn_packets.values()) > 0}
Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
raise SystemExit(0 if (bool(violations) if args.expect_unauthorized else result["ok"]) else 1)
