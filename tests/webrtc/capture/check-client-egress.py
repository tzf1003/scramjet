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
args = parser.parse_args()
policy = json.loads(Path(args.policy).read_text())
receipt = json.loads(Path(args.receipt).read_text())
if policy["policySha256"] != receipt["policySha256"] or policy["networkNamespace"] != receipt["networkNamespace"]:
    raise SystemExit("policy and verification receipt do not identify the same boundary")
cmd = ["tshark", "-r", args.pcap, "-T", "fields"]
for field in ["frame.number", "ip.src", "ipv6.src", "ip.dst", "ipv6.dst", "tcp.dstport", "udp.dstport"]:
    cmd += ["-e", field]
rows = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.splitlines()
clients = {args.client_ip, args.client_ipv6}
violations, turn_packets = [], {"ipv4": 0, "ipv6": 0}
for row in rows:
    values = (row.split("\t") + [""] * 7)[:7]
    number, src4, src6, dst4, dst6, tcp, udp = values
    if src4 not in clients and src6 not in clients:
        continue
    destination = dst4 or dst6
    if not tcp and not udp:  # Neighbor discovery is separately constrained by nftables.
        continue
    number_port = int(tcp or udp)
    allowed = False
    if destination in policy["proxyHosts"] and tcp and number_port in policy["proxyTcpPorts"]:
        allowed = True
    if destination in policy["turnHosts"]:
        if tcp and number_port in policy["turnTcpPorts"] or udp and (number_port == policy["turnUdpPort"] or policy["relayPorts"][0] <= number_port <= policy["relayPorts"][1]):
            allowed = True
            turn_packets["ipv6" if ipaddress.ip_address(destination).version == 6 else "ipv4"] += 1
    if destination in policy["dnsHosts"] and number_port == policy["dnsPort"]:
        allowed = True
    if not allowed:
        violations.append({"frame": number, "destination": destination, "protocol": "tcp" if tcp else "udp", "port": number_port})
result = {"runId": receipt["runId"], "policySha256": policy["policySha256"],
          "pcapSha256": hashlib.sha256(Path(args.pcap).read_bytes()).hexdigest(),
          "turnPackets": turn_packets, "unauthorizedPackets": violations, "ok": not violations and sum(turn_packets.values()) > 0}
Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
raise SystemExit(0 if result["ok"] else 1)
