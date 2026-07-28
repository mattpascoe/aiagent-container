# Need at least node in context. Using a debian system as well.
FROM node:26-bookworm-slim AS base

ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive
ENV NPM_CONFIG_LOGLEVEL=warn

RUN mkdir -p \
    /home/node/.config \
    /home/node/.npm && \
    chown -R node:node \
    /home/node/.config \
    /home/node/.npm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    vim \
    jq \
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

COPY claude/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

FROM base AS release

RUN npm install -g @anthropic-ai/claude-code

# -----------------------------------------------------------------------------
# agentharness-comms (cross-container agent communication)
#
# Wires Claude Code into the shared ~/.agentharness-comms directory so it
# can talk to peer agents in other containers. Two pieces:
#
#   1. `claude/coms-mcp-server/` — MCP server (stdio) + inbound listener.
#      Built during image build so no committed JS artifacts in the repo.
#      Imports the shared wire protocol from `src/coms-protocol/`.
#
#   2. `src/coms-protocol/` — the protocol module itself. Vendored into the
#      image at the same relative path so the compiled listener's
#      `../../../src/coms-protocol/index.js` import resolves at runtime.
#
# NODE_ENV=development is required so devDependencies (typescript) are
# installed; NODE_ENV=production at runtime is fine.
#
# After `tsc`, prune rather than `rm -rf node_modules`: the compiled server
# imports `@modelcontextprotocol/sdk` bare at runtime, so wiping node_modules
# outright leaves the MCP server unable to start (ERR_MODULE_NOT_FOUND).
# -----------------------------------------------------------------------------
COPY agent-roles /agent-roles
COPY src/coms-protocol /src/coms-protocol
COPY claude/coms-mcp-server /claude/coms-mcp-server
RUN cd /claude/coms-mcp-server \
    && NODE_ENV=development npm install \
    && ./node_modules/.bin/tsc \
    && npm prune --omit=dev \
    && rm -f package-lock.json
ENV AGENTHARNESS_COMMS_BIN=/claude/coms-mcp-server/dist/claude/coms-mcp-server/src/cli.js

# Ensure the shared coms dir exists and is writable by `node` (the runtime
# user). `~/.agentharness-comms` is bind-mounted from the host in
# compose.yaml, so this only matters for builds / dev runs without mounts.
RUN mkdir -p /home/node/.agentharness-comms \
    && chown -R node:node /home/node/.agentharness-comms
ENV COMS_DIR=/home/node/.agentharness-comms

USER node

WORKDIR /workspace

# Better to do an entrypoint.sh style script but I dont want to mess with that for now
# This copies in whatever the last .claude.json file was so we dont always have to go through initial setup
ENTRYPOINT ["/entrypoint.sh"]
CMD []
