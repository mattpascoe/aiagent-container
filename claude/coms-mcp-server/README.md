# claude/coms-mcp-server

Claude Code adapter for the `agentharness-comms` cross-container agent
communication system.

## What this is

A Node.js project that gives Claude Code the ability to talk to peer agents
(other Claude instances, Pi instances, or any agent that speaks the
`coms-protocol` wire format) running in other Docker containers.

It runs as **two cooperating processes** inside each Claude container:

1. **The MCP server** — `dist/cli.js` (no subcommand). Speaks the Model
   Context Protocol over stdio. Claude Code spawns this on session start and
   connects to it as a tool provider. Exposes four tools: `coms_list`,
   `coms_send`, `coms_get`, `coms_await`. Killed by Claude on session end.

2. **The inbound listener** — `dist/cli.js listener`. A long-lived
   background process spawned by the container entrypoint *before* Claude
   itself starts. Binds a Unix domain socket at
   `<COMS_DIR>/sockets/<container_id>/<session_id>.sock`, registers itself
   in the shared registry, and accepts inbound `prompt` envelopes from
   peers. For each inbound prompt it shells out to `claude --print
   --output-format json [--resume <sid>] "<prompt>"` and sends the answer
   back as a `response` envelope.

The split is deliberate: the MCP stdio channel is owned by Claude (it's how
Claude talks to us); the UDS for inbound coms is owned by the listener.
Keeping them in separate processes means Claude terminating the MCP server
mid-session doesn't drop inbound traffic.

## Wire protocol

See `../../src/coms-protocol/`. Every envelope is newline-delimited JSON.
Connection = one request + one ack/nack reply, then close. Application-level
responses to prompts travel as separate `response` envelopes sent from
receiver back to sender on a fresh UDS connection.

## Files

```
src/
  cli.ts        # Dispatch: `cli.js` → MCP server, `cli.js listener` → listener
  server.ts     # MCP stdio server + tool schemas
  listener.ts   # Background inbound listener; shells out to `claude --print`
  tools.ts      # Shared tool impls (listPeers, sendPrompt, findProjectForPeer)
  identity.ts   # Resolves container_id, project, coms_dir; persists claude_session_id
  merge-mcp.ts  # Idempotent merge into ~/.claude.json mcpServers (called by entrypoint)
package.json    # Deps: @modelcontextprotocol/sdk
tsconfig.json   # ES2022, nodenext modules; rootDir=../../ so dist/ mirrors src layout
```

## Build

Inside the Docker image:

```sh
npm install        # NODE_ENV=development so devDeps (typescript) are installed
./node_modules/.bin/tsc
```

Output goes to `dist/` and is invoked by `.mcp.json` (Claude) and
`entrypoint.sh` (listener).

## Tool surface

| Tool | What it does |
|---|---|
| `coms_list` | Discover peers in the registry. `project="*"` scans all projects; `include_explicit=true` includes `--explicit` agents. |
| `coms_send` | Send a prompt to a named peer. Returns `msg_id`. If peer is offline, the envelope is queued in their DLQ. |
| `coms_get` | Drain DLQ entries addressed to this session. Non-blocking. |
| `coms_await` | Poll the DLQ until a `response` for one of the given `msg_ids` arrives, or timeout. |

## Configuration

All via env vars (set in `claude/Dockerfile` and/or `compose.yaml`):

| Var | Default | Purpose |
|---|---|---|
| `COMS_DIR` | `~/.agentharness-coms` | Shared host dir; bind-mounted into containers |
| `CONTAINER_ID` | `$HOSTNAME` | Override container ID |
| `AGENTHARNESS_CNAME` | `claude-<short_id>` | Default display name |
| `AGENTHARNESS_PURPOSE` | `""` | Default purpose string |
| `AGENTHARNESS_COLOR` | `""` | Default UI color hex |
| `CLAUDE_PROJECT_DIR` | cwd | Where Claude thinks the project root is (auto-set by Claude) |

CLI flags (only used by the listener subcommand):

| Flag | Purpose |
|---|---|
| `--cname=<name>` | Override display name |
| `--purpose=<text>` | Override purpose string |
| `--color=<#hex>` | Override UI color |
| `--explicit` | Mark as opt-in (excluded from default `coms_list` listings) |

## Persistence

Claude `--resume` is the whole point of having a separate listener process.
The listener extracts `session_id` from the first `claude --print` output
and saves it to `<COMS_DIR>/sessions/<container_id>/claude-session.json`.
On subsequent inbound prompts (even across container restarts) it uses
`--resume <sid>` so the inbound conversation has full context continuity.

## Security

- No filesystem writes outside `COMS_DIR` and `process.cwd()`
- The `app-firewall` (`/usr/local/lib/app-firewall.js`) blocks
  `.pi/agent`, `gh_*`, `.secrets`, `.env` paths; `~/.agentharness-coms`
  is not in the block list
- The listener does NOT exec anything other than `claude` from `$PATH`
- All env vars passed to `claude` are the inherited process env (no
  additions); secrets come from outside via mount/volume
