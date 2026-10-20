#!/bin/sh
set -eu
TABLE=${NFT_TABLE:-scramjet_webrtc}
nft delete table inet "$TABLE" 2>/dev/null || true
echo "removed nftables table inet $TABLE"
