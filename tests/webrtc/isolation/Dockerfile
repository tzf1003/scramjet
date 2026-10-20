FROM node:24-bookworm-slim AS node24
FROM mcr.microsoft.com/playwright:v1.61.0-noble
USER root
COPY --from=node24 /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends nftables iproute2 tcpdump python3 iptables && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["/bin/bash"]
