#!/usr/bin/env node
/**
 * CLI dispatch:
 *   agentharness-comms-claude              → run MCP server (stdio)
 *   agentharness-comms-claude listener     → run inbound listener
 *   agentharness-comms-claude --help       → usage
 *
 * The MCP server mode is the default because that's what Claude Code
 * invokes (per `.mcp.json`). The listener mode is what the container
 * entrypoint invokes before launching claude itself.
 */
const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.error(`agentharness-comms-claude — cross-container agent communication

Usage:
  agentharness-comms-claude                 Start MCP server on stdio
  agentharness-comms-claude listener        Start inbound UDS listener (foreground)
  agentharness-comms-claude hook            Hook body: inject queued inbound
                                            prompts into the interactive session
                                            (reads hook JSON on stdin)
  agentharness-comms-claude pool            Render the peer pool as status-line
                                            rows (silent if coms is inactive)
  agentharness-comms-claude merge-settings  Register the hook in ~/.claude/settings.json
  agentharness-comms-claude --help          Show this message

Environment:
  COMS_DIR             Override shared dir (default ~/.agentharness-comms)
  CONTAINER_ID         Override container ID (default: $HOSTNAME)
  AGENTHARNESS_CNAME   Default --cname when this process has no flag
  AGENTHARNESS_PURPOSE Default purpose string
  AGENTHARNESS_COLOR   Default color hex for UI
  AGENTHARNESS_PROJECT Default project namespace (else basename of cwd)

Files:
  <COMS_DIR>/sockets/<container_id>/<session_id>.sock  UDS endpoint
  <COMS_DIR>/projects/<project>/agents/<name>.json     Registry entry
  <COMS_DIR>/projects/<project>/dlq/                   Queued prompts/responses
  <COMS_DIR>/audit.log                                 Append-only JSONL log
  <COMS_DIR>/sessions/<container_id>/claude-session.json  Persisted --resume id
`);
  process.exit(0);
}

if (argv[0] === "listener") {
  await import("./listener.js");
} else if (argv[0] === "hook") {
  await import("./hook.js");
} else if (argv[0] === "pool") {
  await import("./pool.js");
} else if (argv[0] === "merge-settings") {
  await import("./merge-settings.js");
} else {
  await import("./server.js");
}
