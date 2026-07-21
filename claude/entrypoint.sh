#!/bin/sh
# Claude container entrypoint.
#
# Responsibilities (in order):
#   1. Restore latest ~/.claude.json from the backup volume so the
#      interactive session is pre-configured (auth, projects, etc.).
#   2. Merge our MCP server entry into ~/.claude.json under the
#      `mcpServers` key (idempotent — preserves any user-added servers).
#   3. Start the agentharness-comms inbound listener in the background.
#      The listener binds a UDS and writes to the shared registry so
#      peer agents in other containers can find us. It must be running
#      BEFORE claude starts (so peers sending prompts during boot get
#      DLQ'd correctly).
#   4. exec claude "$@" — replacing this shell so claude is PID 1 and
#      SIGTERM reaches it directly.
#   5. On exit (SIGTERM/SIGINT to claude), the trap kills the listener.
#
# Why ~/.claude.json and not /workspace/.mcp.json?
#   Claude Code reads user-scope MCP server configs from ~/.claude.json
#   (the `mcpServers` key). It does NOT read arbitrary .mcp.json files
#   from ~/.claude/ or anywhere else. Putting the entry in
#   ~/.claude.json means:
#     - Applies to every project automatically (no workspace trust needed).
#     - Doesn't pollute the git workspace with a .mcp.json file.
#     - Survives `make SVC=claude WORKDIR=/different/project run`.
#   The bootstrap is idempotent: see coms-mcp-server/src/merge-mcp.ts.
set -e

COMS_BIN_DIR="$(dirname "${AGENTHARNESS_COMMS_BIN:-/claude/coms-mcp-server/dist/claude/coms-mcp-server/src/cli.js}")"
# merge-mcp.js sits next to cli.js (same dir) because the tsc build preserves
# the src/ layout under dist/.
MERGE_MCP_BIN="${COMS_BIN_DIR}/merge-mcp.js"

# ---------------------------------------------------------------------------
# 1. Restore last .claude.json from the backups volume
# ---------------------------------------------------------------------------
latest=$(find ~/.claude/backups -maxdepth 1 -type f -printf '%T@ %p\n' \
    | sort -nr \
    | head -1 \
    | cut -d' ' -f2-)

if [ -n "$latest" ]; then
    cp "$latest" ~/.claude.json
fi

# ---------------------------------------------------------------------------
# 2. Merge our MCP server entry into ~/.claude.json (idempotent)
# ---------------------------------------------------------------------------
# This handles all the clean-state scenarios:
#   - ~/.claude.json doesn't exist → creates it with our entry.
#   - exists but no `mcpServers` key → adds the key + our entry.
#   - exists with `mcpServers` but no `agentharness-comms` → adds ours.
#   - exists with our entry → refreshes ours (in case image changed).
#   - merge-mcp.js fails for any reason → logs but does NOT block claude.
if [ -x "$(command -v node)" ] && [ -f "$MERGE_MCP_BIN" ]; then
    echo "[entrypoint] merging MCP server entry into ~/.claude.json"
    node "$MERGE_MCP_BIN" || echo "[entrypoint] WARN: MCP merge failed; continuing without auto-connect"
else
    echo "[entrypoint] WARN: merge-mcp.js not found at $MERGE_MCP_BIN; MCP server will not auto-register"
fi

# ---------------------------------------------------------------------------
# 3. Register the inbound-delivery hook in ~/.claude/settings.json (idempotent)
# ---------------------------------------------------------------------------
# Inbound prompts are queued by the listener and injected into the interactive
# session by a Stop / UserPromptSubmit hook. Without this registration the
# prompts still queue safely, but nothing surfaces them until a coms_get.
# Merges rather than overwrites — ~/.claude is bind-mounted from the host and
# holds the user's real settings.
COMS_BIN="${AGENTHARNESS_COMMS_BIN:-/claude/coms-mcp-server/dist/claude/coms-mcp-server/src/cli.js}"

if [ -x "$(command -v node)" ] && [ -f "$COMS_BIN" ]; then
    echo "[entrypoint] registering coms inbound hook in ~/.claude/settings.json"
    node "$COMS_BIN" merge-settings || echo "[entrypoint] WARN: hook registration failed; inbound prompts will queue but not auto-surface"
fi

# ---------------------------------------------------------------------------
# 4. Start the agentharness-comms inbound listener in the background
# ---------------------------------------------------------------------------

if [ -x "$(command -v node)" ] && [ -f "$COMS_BIN" ]; then
    echo "[entrypoint] starting agentharness-comms listener: $COMS_BIN"
    # Persist listener logs to ~/.agentharness-comms/logs/<cname>.log
    mkdir -p "${COMS_DIR:-/home/node/.agentharness-comms}/logs"
    CNAME="${AGENTHARNESS_CNAME:-claude-$(hostname | head -c 6)}"
    nohup node "$COMS_BIN" listener \
        --cname="$CNAME" \
        > "${COMS_DIR:-/home/node/.agentharness-comms}/logs/${CNAME}.log" 2>&1 &
    LISTENER_PID=$!
    echo "[entrypoint] listener pid=$LISTENER_PID"

    # Trap signals to clean up the listener when claude exits
    cleanup() {
        echo "[entrypoint] killing listener pid=$LISTENER_PID"
        kill -TERM "$LISTENER_PID" 2>/dev/null || true
        wait "$LISTENER_PID" 2>/dev/null || true
    }
    trap cleanup TERM INT EXIT
else
    echo "[entrypoint] WARNING: agentharness-comms listener not started (node=$0 COMS_BIN=$COMS_BIN)"
fi

# ---------------------------------------------------------------------------
# 5. Exec claude
# ---------------------------------------------------------------------------
exec claude "$@"
