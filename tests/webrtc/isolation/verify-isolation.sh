#!/bin/sh
# Each configured TCP/UDP/address-family probe must independently fail closed.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$DIR/verify.py"
