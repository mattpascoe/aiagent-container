# syntax=docker/dockerfile:1

# Start with debian
FROM debian:13.4 AS base

ENV DEBIAN_FRONTEND=noninteractive
ENV NPM_CONFIG_LOGLEVEL=warn

RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm ripgrep ffmpeg gcc libffi-dev openssh-client docker-cli xz-utils \
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
RUN gcc -shared -fPIC -O2 -Wall -Wextra /tmp/fs-vault.c -o /usr/local/lib/fs-vault.so -ldl \
    && rm /tmp/fs-vault.c \
    && echo "/usr/local/lib/fs-vault.so" > /etc/ld.so.preload

COPY hermes/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

FROM base AS release

RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

# `npm_config_install_links=false` forces npm to install `file:` deps as
# symlinks (the npm 10+ default) even on Debian's older bundled npm 9.x,
# which defaults to `install-links=true` and installs file deps as *copies*.
# The host-side package-lock.json is generated with a newer npm that uses
# symlinks, so an install-as-copy produces a hidden node_modules/.package-lock.json
# that permanently disagrees with the root lock on the @hermes/ink entry.
# That disagreement trips the TUI launcher's `_tui_need_npm_install()`
# check on every startup and triggers a runtime `npm install` that then
# fails with EACCES (node_modules/ is root-owned from build time).
ENV npm_config_install_links=false

RUN cd /usr/local/lib/hermes-agent && npm install --prefer-offline --no-audit && \
    npx playwright install --with-deps chromium --only-shell && \
    (cd web && npm install --prefer-offline --no-audit) && \
    (cd ui-tui && npm install --prefer-offline --no-audit) && \
    npm cache clean --force

# Build browser dashboard and terminal UI assets.
RUN cd /usr/local/lib/hermes-agent/web && npm run build && \
    cd ../ui-tui && npm run build

ENV HERMES_TUI_DIR=/usr/local/lib/hermes-agent/ui-tui

# Install all dependencies so we dont try to lazy load them later
RUN cd /usr/local/lib/hermes-agent && \
    /root/.local/bin/uv sync --frozen --no-install-project --extra all --extra messaging --extra anthropic --extra bedrock --extra azure-identity && \
    /root/.local/bin/uv pip install --no-cache-dir --no-deps -e "."

WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
CMD []
