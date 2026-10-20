#!/usr/bin/env python3
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("pcap")
parser.add_argument("--run-id", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()


def fields(display_filter, field):
    result = subprocess.run(["tshark", "-r", args.pcap, "-Y", display_filter, "-T", "fields", "-e", field], capture_output=True, text=True, check=True)
    return [line for line in result.stdout.splitlines() if line]


types = Counter(value for row in fields("stun", "stun.type") for value in row.split(","))
result = {
    "runId": args.run_id,
    "pcapSha256": hashlib.sha256(Path(args.pcap).read_bytes()).hexdigest(),
    "totalPackets": len(fields("frame", "frame.number")),
    "stunMessageTypes": dict(sorted(types.items())),
    "allocateRequests": types["0x0003"], "allocateSuccesses": types["0x0103"],
    "sendIndications": types["0x0016"], "dataIndications": types["0x0017"],
    "dtlsPackets": len(fields("dtls", "frame.number")),
}
Path(args.output).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
