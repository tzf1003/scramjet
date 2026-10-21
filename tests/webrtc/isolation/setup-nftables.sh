#!/bin/sh
# Atomically install endpoint-qualified IPv4/IPv6 egress rules.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$DIR/policy.py"
