#!/usr/bin/env python3
"""Wrap a Linux host namespace run with owned TURN fault injection."""
import argparse
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runner_control import run_controlled

parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
parser.add_argument("--turn-container", required=True)
parser.add_argument("command", nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ["--"] else args.command
if not command:
    parser.error("a namespace test command is required")
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
with (output / "supervised.log").open("w") as stream:
    result = run_controlled(command, output=output, turn=args.turn_container, stream=stream,
                            network_exec=[*(["sudo"] if os.geteuid() else []), "ip", "netns", "exec", os.environ.get("NETNS", "sjclient")],
                            interface=os.environ.get("NS_IF", "sjveth1"),
                            env=dict(os.environ, WEBRTC_TURN_CONTROL_DIR=str(output)))
print((output / "supervised.log").read_text())
raise SystemExit(result)
