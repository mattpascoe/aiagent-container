# syntax=docker/dockerfile:1

# Need at least node in context. Using a debian system as well.
FROM node:22-bookworm-slim AS base

ARG WORKSPACE_PATH=/workspace
ARG REAL_USER=node
ARG HOST_UID=1000
ARG HOST_GID=1000

ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive
ENV NPM_CONFIG_LOGLEVEL=warn

RUN mkdir -p /home/node/.pi/agent \
    /home/node/.config \
    /home/node/.npm && \
    chown -R node:node /home/node/.pi \
    /home/node/.config \
    /home/node/.npm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    vim \
    ca-certificates \
    procps \
    build-essential \
    python3 \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# System Hardening: Purge Privilege Escalation Vectors
# -----------------------------------------------------------------------------
RUN rm -f /bin/su /usr/bin/su /bin/mount /usr/bin/mount /bin/umount /usr/bin/umount \
    /usr/bin/passwd /usr/bin/chsh /usr/bin/chfn /usr/bin/chage /usr/bin/gpasswd \
    /usr/bin/newgrp /bin/login /usr/bin/login /usr/bin/nsenter /usr/bin/unshare \
    /usr/bin/setpriv /bin/setpriv \
    && find / -xdev \( -perm -4000 -o -perm -2000 \) -type f -exec chmod a-s {} + || true

# -----------------------------------------------------------------------------
# The Global Syscall Firewall (LD_PRELOAD) - Blocks Child Processes
# -----------------------------------------------------------------------------
COPY src/fs-vault.c /tmp/fs-vault.c
RUN gcc -shared -fPIC -O2 /tmp/fs-vault.c -o /usr/local/lib/fs-vault.so -ldl \
    && rm /tmp/fs-vault.c \
    && echo "/usr/local/lib/fs-vault.so" > /etc/ld.so.preload

# -----------------------------------------------------------------------------
# Comprehensive Application-Layer Firewall (V8 Hook)
# -----------------------------------------------------------------------------
COPY src/app-firewall.js /usr/local/lib/app-firewall.js

# Force Node.js to load the firewall before initializing the agent
ENV NODE_OPTIONS="--require /usr/local/lib/app-firewall.js"

COPY pi/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

FROM base AS release

RUN npm install -g @earendil-works/pi-coding-agent

# These must also be defined in your pi settings.json
# TODO: do I want or need these here.. maybe they just go in .pi/extensions in the repo?
#RUN pi install npm:@llblab/pi-telegram
#RUN pi install npm:@e9n/pi-channels

USER node

WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
CMD []
