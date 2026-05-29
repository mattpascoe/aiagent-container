# syntax=docker/dockerfile:1

# ------------------------------------------------------------
# Base image
# ------------------------------------------------------------
FROM node:26-bookworm-slim AS base

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_LOGLEVEL=warn

# Create directories in one layer
RUN install -d -o node -g node \
    /home/node/.config/opencode/agent \
    /home/node/.config \
    /home/node/.npm

# ------------------------------------------------------------
# Install system dependencies
# ------------------------------------------------------------
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    git curl wget vim jq ca-certificates procps \
    build-essential python3 python3-dev && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------
# Hardening: remove SUID/SGID binaries
# ------------------------------------------------------------
RUN rm -f \
    /bin/su /usr/bin/su \
    /bin/mount /usr/bin/mount \
    /bin/umount /usr/bin/umount \
    /usr/bin/passwd /usr/bin/chsh /usr/bin/chfn \
    /usr/bin/chage /usr/bin/gpasswd /usr/bin/newgrp \
    /bin/login /usr/bin/login \
    /usr/bin/nsenter /usr/bin/unshare \
    /usr/bin/setpriv /bin/setpriv \
    && find / -xdev \( -perm -4000 -o -perm -2000 \) -type f -exec chmod a-s {} + || true

# ------------------------------------------------------------
# Build fs-vault (LD_PRELOAD syscall firewall)
# ------------------------------------------------------------
COPY src/fs-vault.c /tmp/fs-vault.c
RUN gcc -shared -fPIC -O2 /tmp/fs-vault.c -o /usr/local/lib/fs-vault.so -ldl && \
    rm /tmp/fs-vault.c && \
    echo "/usr/local/lib/fs-vault.so" > /etc/ld.so.preload

# ------------------------------------------------------------
# Application-layer firewall
# ------------------------------------------------------------
COPY src/app-firewall.js /usr/local/lib/app-firewall.js
ENV NODE_OPTIONS="--require /usr/local/lib/app-firewall.js"

# ------------------------------------------------------------
# Entrypoint
# ------------------------------------------------------------
COPY opencode/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ------------------------------------------------------------
# Release stage
# ------------------------------------------------------------
FROM base AS release

# Install opencode globally
RUN npm install -g opencode-ai --omit=dev

USER node
WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
CMD []
