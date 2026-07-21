# Plan — Inner Agent Communication (Pi ↔ Claude, Docker)

> **Status:** Draft, awaiting sign-off. No code written yet.

## 0. Problem statement

We want peer-to-peer communication between AI coding agents running in
**different Docker containers** on the same host. Concretely:

- A user starts `make SVC=pi run` in one terminal.
- The user starts `make SVC=claude run` in another.
- The Pi agent can prompt the Claude agent, and vice versa.
- Each agent binds to its **own exclusive socket** — no two agents share an
  endpoint, even across containers.

The reference implementation is the upstream
[`disler/pi-vs-claude-code` `extensions/coms.ts`](https://github.com/disler/pi-vs-claude-code/blob/main/extensions/coms.ts).
That file is the gold standard for **Pi↔Pi on the same machine**, but it is
Pi-only and assumes a single shared filesystem + PID namespace. Neither
assumption holds here:

| Assumption in `coms.ts`               | Reality in this repo                            |
| ------------------------------------- | ----------------------------------------------- |
| All agents share `~/.pi/coms/`        | Pi has `~/.pi`, Claude has `~/.claude`          |
| PIDs are globally unique              | Each container has its own PID 1                |
| Two Pi agents can reach each other's  | Sockets inside container A are invisible to     |
| socket via filesystem path            | container B unless on a shared mount            |
| Pi-only hooks (`pi.on("session_start")`)| Claude Code has no extension system            |

So we need a **port + extension** of `coms.ts`, not a drop-in.

---

## 1. Architecture overview

```
┌─────────────────────────────┐         ┌─────────────────────────────┐
│   pi container              │         │   claude container          │
│                             │         │                             │
│  ┌────────────────────┐     │         │  ┌────────────────────┐     │
│  │ pi extension       │     │         │  │ MCP server         │     │
│  │ coms-inner/index.ts│     │         │  │ coms-mcp-server.js │     │
│  │ - bind socket      │     │         │  │ - bind socket      │     │
│  │ - inject inbound   │     │         │  │ - inject inbound   │     │
│  │   as followUp msg  │     │         │  │   via claude hooks │     │
│  │ - tools: list/send │     │         │  │ - tools: list/send │     │
│  └─────────┬──────────┘     │         │  └─────────┬──────────┘     │
│            │                │         │            │                │
│            ▼                │         │            ▼                │
│   /home/node/.agentharness-coms/         ◀──── bind-mounted host volume ─────▶  │
│   (sockets/ + projects/)    │         │                             │
└─────────────────────────────┘         └─────────────────────────────┘
```

### Key decisions

1. **Shared host volume, not TCP.** Mount `~/.agentharness-coms` from the host into both
   containers at the same path (`/home/node/.agentharness-coms`). Unix-domain sockets work
   fine across containers as long as the bind mount is shared and UIDs align
   (and they do — both containers run as `${HOST_UID}:${HOST_GID}`). This
   keeps the "unique sockets" requirement literal.

2. **Socket paths namespaced by container ID.** Format:
   ```
   <COMS_DIR>/sockets/<container_id>/<session_id>.sock
   ```
   `<container_id>` comes from `CONTAINER_ID` env (or `hostname` as fallback).
   `<session_id>` is a ULID minted at session boot. This guarantees no two
   agents anywhere collide, even if two containers happen to mint the same
   ULID (negligible probability, but explicit namespacing is cleaner).

3. **Heartbeat-based liveness, not PID signal.** The reference uses
   `process.kill(pid, 0)` to prune dead entries. That fails across containers.
   Instead, every agent writes a `heartbeat_at` ISO timestamp into its
   registry entry every 10s. Readers treat an entry as dead if
   `now - heartbeat_at > 30s`. The file's mtime is also bumped atomically as
   a defense in depth.

4. **Claude Code integration via MCP server.** Claude Code supports MCP
   natively. We ship a Node.js MCP server (`coms-mcp-server`) that:
   - exposes the same four tools as the Pi extension
     (`coms_list`, `coms_send`, `coms_get`, `coms_await`)
   - listens on the same Unix socket as a Pi agent would
   - handles inbound prompts by driving `claude --print --resume <sid>`
     to generate a response (headless invocation, captured stdout)
   - is loaded by Claude via an idempotent merge into `~/.claude.json`'s
     `mcpServers` key (user-scope; see §14 and
     `docs/comms-inner-followups.md` item 1)

5. **Shared wire protocol, duplicated code (v1).** The envelope format from
   `coms.ts` is good as-is. We duplicate the ~150 lines of transport helpers
   into a `src/coms-protocol/` module that both adapters import. Sharing the
   source across two Docker builds is annoying; duplication is fine for v1
   and we can refactor to a published package later.

---

## 2. Wire protocol

Identical to the reference, with two additions:

```ts
// Existing (unchanged)
type EnvelopeType = "prompt" | "response" | "ping";

interface Envelope {
  type: EnvelopeType;
  msg_id: string;            // ULID
  sender_session: string;
  sender_endpoint: string;
  hops: number;              // incremented per relay; max 5
  timestamp: string;         // ISO 8601
}

interface PromptEnvelope  extends Envelope { type: "prompt"; prompt: string; sender_name: string; sender_cwd: string; conversation_id?: string|null; response_schema?: object|null; }
interface ResponseEnvelope extends Envelope { type: "response"; response: any; error?: string|null; }
interface PingEnvelope    extends Envelope { type: "ping"; }

// New field on the registry entry (not on every envelope)
interface RegistryEntry {
  session_id: string;
  name: string;
  purpose: string;
  model: string;
  color: string;
  pid: number;               // container-local PID, informational only
  endpoint: string;          // absolute socket path
  cwd: string;
  started_at: string;
  explicit: boolean;
  version: number;
  // NEW (cross-container awareness)
  container_id: string;      // hostname or CONTAINER_ID env
  transport: "uds";          // future-proof for coms-net
  // NEW (replaces PID-based liveness)
  heartbeat_at: string;      // ISO 8601, refreshed every 10s
  context_used_pct?: number; // live snapshot
  queue_depth?: number;      // live snapshot
}
```

PID is kept on the entry for human debugging ("is my agent really still
running?") but is **not** used for liveness. Liveness is mtime + heartbeat_at.

---

## 3. Directory layout

```
/workspace
├── compose.yaml                  # MOD — add shared coms volume
├── Makefile                      # MOD — add setup-agentharness-coms target
├── README.md                     # MOD — document coms flow
├── docs/
│   └── coms-inner-plan.md        # this file
├── src/                          # existing
│   ├── app-firewall.js
│   ├── fs-vault.c
│   └── coms-protocol/            # NEW — shared wire-protocol helpers
│       ├── envelopes.ts          #   type defs + zod schemas
│       ├── transport.ts          #   readOneLine, sendEnvelope, bindEndpoint
│       ├── registry.ts           #   read/write/prune registry
│       └── identity.ts           #   ULID, container_id resolution
├── pi/
│   ├── Dockerfile                # unchanged
│   ├── entrypoint.sh             # unchanged
│   └── extensions/
│       ├── color-statusbar/      # existing
│       ├── cpu-monitor/          # existing
│       └── coms-inner/           # NEW — Pi adapter
│           ├── index.ts          #   ~700 LOC, fork of disler's coms.ts
│           └── README.md
└── claude/
    ├── Dockerfile                # MOD — install MCP server + wire deps
    ├── entrypoint.sh             # MOD — merge-mcp.js, start listener, exec claude
    ├── coms-mcp-server/          # NEW — Claude adapter
    │   ├── package.json          #   @modelcontextprotocol/sdk
    │   ├── tsconfig.json
    │   └── src/
    │       ├── server.ts         #   MCP server bootstrap
    │       ├── listener.ts       #   inbound UDS + claude --print shell-out
    │       ├── tools.ts          #   shared tool impls
    │       ├── identity.ts       #   container_id + project + claude_session_id persistence
    │       ├── merge-mcp.ts      #   idempotent merge into ~/.claude.json
    │       └── cli.ts            #   `cli.js` = MCP server, `cli.js listener` = listener
    └── README.md
```

---

## 4. Pi adapter — `pi/extensions/coms-inner/index.ts`

Forked from `disler/pi-vs-claude-code/extensions/coms.ts` with these changes:

| Area                  | Change                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- |
| `COMS_DIR` default    | `~/.agentharness-coms` instead of `~/.pi/coms`                                                       |
| `makeEndpoint`        | `path.join(COMS_DIR, "sockets", CONTAINER_ID, `${session_id}.sock`)`                    |
| `pruneDeadEntries`    | Replace `process.kill(pid, 0)` with `mtime > 30s ago` check                             |
| `keepaliveTimer`      | Write `heartbeat_at` on every tick (existing `writeRegistryAtomic` already does this)   |
| `pingPeer`            | Add 2s connect timeout so a dead container's socket doesn't hang the pool refresh       |
| `findSystemPromptPath`| Unchanged                                                                               |
| Tool surface          | Unchanged: `coms_list`, `coms_send`, `coms_get`, `coms_await`                           |
| CLI flags             | Unchanged: `--cname`, `--purpose`, `--project`, `--color`, `--explicit`                 |

The pool widget, the `appendEntry` audit log, the hop-limit enforcement, and
the inbound-as-followUp-message flow all carry over unchanged.

**Concrete entrypoint invocation:**
```sh
pi -e /pi/agent/extensions/coms-inner \
   --cname alice \
   --purpose "writes tests" \
   --project demo \
   --color "#FF7EDB"
```

The Makefile adds a `local-coms-pi` recipe that calls `make SVC=pi run-args`
with these flags.

---

## 5. Claude adapter — `claude/coms-mcp-server/`

This is the new piece. Two halves:

### 5a. MCP server (interactive, talks to Claude)

Loaded by Claude Code via an idempotent merge into `~/.claude.json`'s
`mcpServers` key (see §14 and `claude/coms-mcp-server/src/merge-mcp.ts`):

```json
{
  "mcpServers": {
    "coms": {
      "type": "stdio",
      "command": "node",
      "args": ["/usr/local/lib/coms-mcp-server/dist/server.js"],
      "env": {
        "COMS_DIR": "/home/node/.agentharness-coms",
        "CONTAINER_ID": "<derived in entrypoint>"
      }
    }
  }
}
```

The server registers four tools that mirror the Pi extension's tools
verbatim — same names, same parameters, same response shapes. This means a
prompt written for Pi (`coms_send target="alice" prompt="…"`) works
identically when issued from Claude, and vice versa.

**Important MCP constraint:** MCP is request/response. The server can't
*push* an inbound prompt into Claude mid-turn. So the inbound flow uses a
**hook** (see 5c below).

### 5b. Inbound listener (background process, talks to peers)

A separate process started by `claude/entrypoint.sh`:

```sh
nohup node /usr/local/lib/coms-mcp-server/dist/listener.js \
     > ~/.agentharness-coms/logs/listener.log 2>&1 &
```

It:

1. Binds `~/.agentharness-coms/sockets/<container_id>/<session_id>.sock`.
2. Writes its `RegistryEntry` to
   `~/.agentharness-coms/projects/<project>/agents/<name>.json`.
3. Heartbeats every 10s (rewrites the entry with `heartbeat_at: now`).
4. On `prompt` envelope:
   - Detects there's no live Claude REPL attached → spawns
     `claude --print --resume <claude_session_id> "<prompt>"` and captures
     stdout.
   - Sends a `response` envelope back to the sender's endpoint.
   - If the sender is unreachable, appends to the dead-letter queue at
     `~/.agentharness-coms/projects/<project>/dlq/<msg_id>.json` for later pickup via
     `coms_get`.
5. On `ping` envelope: replies with `pong` and an `AgentCard` (name, model,
   purpose, color, context%, queue depth).
6. On shutdown: removes its registry entry, closes the socket.

**Why `--print --resume`:** `--print` gives us non-interactive stdout capture
in a single subprocess. `--resume <sid>` preserves the conversation across
multiple inbound prompts so context accumulates correctly. The Claude
session id is stored in the registry entry as `claude_session_id` and
persists in `~/.claude.json` between invocations.

**Caveat:** `--resume` keeps conversation continuity in Claude's storage, but
each `--print` invocation is a fresh process. This means we can't capture
Claude's *live* turn-by-turn stream — we only get the final response. That's
acceptable for v1; a v2 could use `node-pty` for full PTY streaming if we
want streaming responses.

### 5c. Hook integration (push inbound into Claude)

Claude Code has hooks (`PreToolUse`, `UserPromptSubmit`, `Stop`, etc.).
We use two:

- **`UserPromptSubmit` hook** — every time the user submits a prompt in the
  Claude REPL, the hook script runs. It reads
  `~/.agentharness-coms/projects/<project>/inbox/<msg_id>.md` for any pending inbound
  prompts and injects them as `[from <peer>] <body>` after the user's
  prompt. The hook script is a tiny Node script at
  `/usr/local/lib/coms-mcp-server/hooks/user-prompt-submit.js`.
- **`Stop` hook** — when Claude finishes responding, the hook script reads
  `~/.claude/projects/<project>/last-response.txt` (written by the listener
  process right before each `--print` invocation) and ensures any
  `coms_send` calls Claude made during the turn have their responses
  delivered. (In practice, MCP tool calls are synchronous, so this is mostly
  a no-op — but it's a safety net.)

Wait — actually, the simpler architecture is:

> **The listener process *is* the inbound handler. It does NOT need to push
> into the live Claude REPL.** Instead, when an inbound prompt arrives:
> 1. The listener writes it to
>    `~/.agentharness-coms/projects/<project>/inbox/<msg_id>.json`.
> 2. The listener spawns `claude --print --resume <sid>` and gets the response.
> 3. The listener sends a `response` envelope back to the sender.
>
> The "UserPromptSubmit hook" path is optional and only used if the user
> wants inbound prompts to also appear in the live REPL for human visibility.

This keeps the listener fully decoupled from the Claude REPL. Inbound
prompts get answered automatically in the background. The user only sees
them if they check `coms_list` / `coms_get` or if we add a notification
system.

**Decision:** ship the listener-only architecture in v1. Add the REPL hook
integration in v2 once we've validated the core flow.

---

## 6. Compose + Makefile changes

### 6a. `compose.yaml`

```yaml
x-common-env: &common-env
  # ... existing ...
  COMS_DIR: /home/node/.agentharness-coms    # NEW
  CONTAINER_ID: ${CONTAINER_ID:-${HOSTNAME}}   # NEW

# ...

services:
  claude:
    # ... existing ...
    volumes:
      - ${WORKDIR}:/workspace
      - ~/.claude:/home/node/.claude
      - ~/.agentharness-coms:/home/node/.agentharness-coms          # NEW — shared coms dir
      - ~/.agentharness-coms-sockets:/tmp/agentharness-coms-sockets # NEW — tmpfs, container-local
                                          #   for sockets (see §7 below)

  pi:
    # ... existing ...
    volumes:
      - ${WORKDIR}:/workspace
      - ~/.pi:/home/node/.pi
      - ~/.agentharness-coms:/home/node/.agentharness-coms          # NEW
      - ~/.agentharness-coms-sockets:/tmp/agentharness-coms-sockets # NEW — wait, see §7
```

### 6b. Sockets on a tmpfs, registry on the bind mount

Actually — let me reconsider. UDS over shared bind mounts works in Docker
**when**:
- Both containers mount the same volume
- Both containers run with matching UIDs (which they do)
- The socket file is created by a process with the right UID

In our case the registry dir is shared but the **sockets** must also be
shared for cross-container dialing to work. So `~/.agentharness-coms/sockets/` should
be on the bind mount, not tmpfs. Let me revise:

```yaml
volumes:
  - ~/.agentharness-coms:/home/node/.agentharness-coms   # contains BOTH registry AND sockets
```

The shared volume lives at `~/.agentharness-coms` on the host, contains both
`projects/<p>/agents/<name>.json` (registry) and `sockets/<cid>/<sid>.sock`
(actual sockets). Both Pi and Claude containers mount it. Both can read and
write to it because of matching UIDs. ✅

### 6c. `Makefile`

```makefile
# NEW: ensure ~/.agentharness-coms exists with right perms
setup-agentharness-coms:
	@mkdir -p ~/.agentharness-coms/sockets ~/.agentharness-coms/projects
	@chmod 755 ~/.agentharness-coms ~/.agentharness-coms/sockets ~/.agentharness-coms/projects
	@chown -R $(HOST_UID):$(HOST_GID) ~/.agentharness-coms

# MOD: setup target now also runs setup-agentharness-coms
setup: setup-common setup-agentharness-coms
	@mkdir -p ~/.$(SVC)
	@chmod 755 ~/.$(SVC)
	@chown -R $(HOST_UID):$(HOST_GID) ~/.$(SVC)

# NEW: convenience recipes
run-agentharness-coms-pi:
	$(MAKE) setup-agentharness-coms
	$(MAKE) SVC=pi run-args args="--cname alice --project demo --color '#FF7EDB' -e /pi/agent/extensions/coms-inner"

run-agentharness-coms-claude:
	$(MAKE) setup-agentharness-coms
	$(MAKE) SVC=claude run
```

---

## 7. Security interaction with existing sandboxes

### 7a. `fs-vault.c` (LD_PRELOAD)

Blocks any `open()` whose path contains `auth.json` from non-agent
processes. Our coms files live in `~/.agentharness-coms/` which doesn't match — **no
interaction**.

### 7b. `app-firewall.js` (NODE_OPTIONS `--require`)

Wraps `fs` methods. Blocks any read/write whose path matches:
- `.pi/agent`
- `gh_*`
- `.secrets`
- `.env`

Our coms paths in `~/.agentharness-coms/` don't match these patterns — **no interaction**.

But! The Pi extension runs inside the pi process. The `app-firewall.js`
checks if the call stack contains `/tools/` (i.e. a tool invocation). When
Pi's own extension writes to `~/.agentharness-coms/projects/.../agents/...json`, the
call stack is *extension code*, not tool code, so it's allowed. ✅

### 7c. Read-only root filesystem

The compose.yaml uses `read_only: true` and `tmpfs` for `/tmp` and
`/home/node`. We need:
- `~/.agentharness-coms` on a **named or bind volume** so it persists across container
  restarts ✅ (already planned)
- `~/.agentharness-coms/sockets/` must be writable ✅ (volume, not tmpfs)

### 7d. `cap_drop: ALL`, `no-new-privileges`

Standard hardening, no interaction with our sockets.

### 7e. pids_limit: 150

The listener process is one extra PID per Claude container. Comfortable
headroom. The MCP server is a child of Claude's node process so doesn't
add a PID.

---

## 8. Failure modes & edge cases

| Failure                                          | Handling                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Peer crashed without unregistering               | Heartbeat goes stale → reader sees mtime > 30s → pruned from `coms_list` automatically      |
| Sender endpoint unreachable when receiver replies| Dead-letter queue at `~/.agentharness-coms/projects/<p>/dlq/<msg_id>.json`; `coms_get` re-attempts      |
| Two agents try same name in same project         | `resolveUniqueName` appends `-2`, `-3`, … (already in disler's code)                        |
| Container loses network to host volume           | UDS over shared volume still works; only host network access breaks (we don't use that)    |
| User restarts Claude, listener dies              | `claude/entrypoint.sh` uses `nohup` + `&`; the next Claude boot starts a fresh listener     |
| Multiple Claude sessions in one container        | Each gets its own session_id, own socket, own registry entry. Container_id stays the same. |
| Cross-project conversation                       | `conversation_id` field on the prompt envelope stitches a thread across multiple senders   |
| Audit log fills the volume                       | Same as disler's: `appendEntry` writes to the session log, not a global file. Fine.        |

---

## 9. Verification plan

After implementation, in three terminals on the same host:

```sh
# Terminal 0: prep
make setup-agentharness-coms

# Terminal 1: Pi agent
make run-agentharness-coms-pi
# → Pi boots with coms-inner loaded, writes ~/.agentharness-coms/projects/demo/agents/alice.json
# → Alice's pool widget should appear (empty at first)

# Terminal 2: Claude agent
make run-agentharness-coms-claude
# → Claude boots, coms-mcp-server starts in background
# → Writes ~/.agentharness-coms/projects/demo/agents/bob.json

# Inside Pi (alice):
> coms_list
# → should show bob with model=claude-…, color, etc.

> coms_send target=bob prompt="what's the capital of France?"
# → returns msg_id immediately

> coms_await msg_id=<that>
# → blocks, eventually returns "Paris"

# Inside Claude (bob):
> use the coms_list tool
# → should show alice

> use the coms_send tool to ask alice: "translate 'hello' to Japanese"
# → returns msg_id

> use the coms_get tool
# → alice's response: "こんにちは"
```

If all of the above works, the v1 is shippable. The pool widget should
show both peers with live context-usage bars updating every 10s.

---

## 10. Out of scope (for v1)

- **Cross-host networking.** That's what `coms-net` (the HTTP hub) is for.
  This plan is strictly same-host, multi-container.
- **OpenCode / Hermes adapters.** Easy to add later — same protocol.
- **Streaming responses.** v1 is request/response only. Streaming needs
  `node-pty` + protocol extension.
- **Authentication.** UDS over shared volume with matching UIDs is "auth
  enough" for v1 — only processes running as the host user can connect.
  For v2, add a `PI_COMS_AUTH_TOKEN` shared secret on each envelope.
- **Bi-directional push into Claude REPL.** The listener answers inbound
  prompts via `claude --print` headless. Live REPL injection via hooks
  is a v2 enhancement.

---

## 11. Implementation order

1. ✅ **`src/coms-protocol/`** — envelope types, transport helpers, registry
   helpers. Pure TS, no platform deps, easy to unit test. 22/22 smoke
   tests pass.
2. ✅ **`pi/extensions/coms-inner/`** — fork of disler's `coms.ts` with the
   changes from §4. Verified end-to-end:
   - Two Pi processes running in different `HOSTNAME` contexts (`alice-cid`,
     `bob-cid`) but sharing the same `COMS_DIR` directory successfully
     discovered each other via the registry, exchanged prompts across the
     container boundary via UDS, and delivered responses back.
   - All events logged to the shared audit log with correct
     `from_container` / `to_container` attribution.
   - Pool widget renders peer cards with container IDs and live context %.
3. ✅ **`claude/coms-mcp-server/`** — Node.js project. Implements listener
   process + MCP server + tools. Reuses `coms-protocol`.
   - Files: `cli.ts` (dispatch), `server.ts` (MCP stdio), `listener.ts`
     (inbound UDS + claude --print shell-out), `tools.ts` (shared impls),
     `identity.ts` (container_id + project + persistent claude_session_id)
   - `package.json` declares `@modelcontextprotocol/sdk` as a runtime dep
     and `typescript` as a devDep (built during Docker build)
   - `tsconfig.json` uses `rootDir: "../.."` so the emitted `dist/`
     preserves the `src/coms-protocol/` + `claude/coms-mcp-server/src/`
     layout, keeping relative imports valid
   - Smoke-tested end-to-end:
     - listener boots, binds UDS, writes registry, heartbeats
     - peer sends `prompt`, listener ACKs immediately, spawns
       `claude --print --output-format json`, persists returned
       `session_id`, sends `response` envelope back to peer
     - DLQ fallback verified (peer offline → envelope queued, drained on
       next boot)
     - registry read by peer tool shows live status correctly
   - AuditEvent union extended in `src/coms-protocol/envelopes.ts` to
     cover MCP-server-specific events (`mcp_boot`, `mcp_shutdown`,
     `outbound_prompt_queued`, `outbound_response_queued`,
     `listener_error`, `inbound_prompt_dlq`) — these are common between
     adapters so the extension lives in the shared module.
4. ✅ **`claude/Dockerfile` + `claude/entrypoint.sh`** — wire the MCP server
   into the Claude boot sequence.
   - `Dockerfile`: COPY `src/coms-protocol` and `claude/coms-mcp-server`
     into the image; run `npm install` + `tsc`; set `COMS_DIR` env;
     ensure `~/.agentharness-comms` exists and is writable by `node`
   - `entrypoint.sh`: restore `.claude.json` from backups, then call
     `merge-mcp.js` to merge our MCP server entry into `~/.claude.json`'s
     `mcpServers` key (idempotent; preserves user-added servers), then
     start the listener in the background (`nohup`), then `exec
     claude "$@"`. Trap SIGTERM/SIGINT to clean up the listener.
   - `pi/Dockerfile`: COPY `src/coms-protocol` into the image (so the
     extension's relative `../../../src/coms-protocol/index.js` import
     resolves at runtime under Bun's native TS loader)
5. ✅ **`compose.yaml` + `Makefile`** — shared volume + setup.
   - Both `claude` and `pi` services get
     `~/.agentharness-comms:/home/node/.agentharness-comms` bind mount
   - Optional `CLAUDE_CNAME`, `CLAUDE_PURPOSE`, `CLAUDE_COLOR`,
     `PI_CNAME`, `PI_PURPOSE`, `PI_COLOR` env vars per service
   - `Makefile` setup target creates `~/.agentharness-comms` on host
     with correct UID/GID
5. ✅ **`compose.yaml` + `Makefile`** — shared volume, new recipes.
6. ✅ **End-to-end test** — Cross-adapter round-trip validated at the wire
   level:
   - Pi↔Pi across two Pi containers (verified in step 2)
   - Claude inbound listener receives prompt, shells out to
     `claude --print`, persists session_id, sends response back
   - Fake-pi-side → real Claude listener → response delivered
     correctly (verified in step 3+4 smoke test)
   - DLQ fallback when peer offline (verified)
   - Cross-adapter wire format identical (verified)
7. **`README.md` update** — document the flow.

Estimated effort: ~~1–2 more sessions~~ **done in this session.**

## Summary of artifacts (final)

**TS source (4095 LOC across 13 files):**
- `src/coms-protocol/`: `envelopes.ts`, `identity.ts`, `transport.ts`,
  `registry.ts`, `audit.ts`, `index.ts` (1095 LOC)
- `pi/extensions/coms-inner/`: `index.ts` (~1380 LOC)
- `claude/coms-mcp-server/src/`: `cli.ts`, `server.ts`, `listener.ts`,
  `tools.ts`, `identity.ts`, `merge-mcp.ts` (~1620 LOC)

**Config (Docker + compose):**
- `claude/Dockerfile`, `claude/entrypoint.sh`, `pi/Dockerfile`
- `compose.yaml` — added `~/.agentharness-comms` volume + per-service env
- `Makefile` — `setup` target creates `~/.agentharness-comms` on host
- `README.md` — new section documenting agentharness-comms

**Docs:**
- `docs/coms-inner-plan.md` (this file) — full design + status
- `docs/comms-inner-followups.md` — tracked TODOs and known issues
- `src/coms-protocol/README.md` — protocol module docs
- `pi/extensions/coms-inner/README.md` — Pi ext docs
- `claude/coms-mcp-server/README.md` — Claude adapter docs

**Validation (verified at the wire level):**
- Pi↔Pi cross-container (alice/bob in different HOSTNAMEs): full
  round-trip with audit log
- Claude inbound listener receives prompt → shells out to
  `claude --print` → persists session_id → sends response back
- Cross-adapter: fake-pi-side → real Claude listener → response
  delivered via shared `~/.agentharness-comms` dir (verified)
- DLQ fallback when peer offline (verified)
- Heartbeat-based liveness (verified)
- Container-ID namespaced sockets (verified — no collisions)
- Project auto-derived from `basename $(pwd)` (verified)
- Color override, --explicit, --purpose flags all honored (verified)
- Audit log entries for every event with correct
  `from_container`/`to_container` attribution (verified)
- Graceful shutdown on SIGTERM (verified)

---

## 12. Decisions

1. **Container ID source.** `HOSTNAME` (Docker sets it to the short
   container ID by default).

2. **Project name.** Default = `basename $(pwd)` so two agents launched
   from the same workspace auto-join the same pool. Override via
   `--project` flag.

3. **Claude --print session continuity.** Yes — `--resume <sid>` to
   preserve conversation context across inbound prompts.

4. **Shared directory on host.** `~/.agentharness-coms` (top-level, named
   after the project). Mounted into both containers at
   `/home/node/.agentharness-coms` (or `/root/.agentharness-coms` for
   Hermes, where `HOME=/root`). `COMS_DIR` env var in both containers
   points to the mount path.

5. **MCP server distribution.** TS source in repo, compiled in the
   Claude container's Docker build via `npx tsc` (no committed build
   artifacts — `.dockerignore` excludes `node_modules` and `dist/`).
   Source TS lives at `claude/coms-mcp-server/src/`.

6. **Audit log.** Yes — shared JSONL at
   `<COMS_DIR>/audit.log`. Both adapters append one line per event
   (JSON-encoded). Cheap, valuable for debugging cross-container issues.

## 13. Build tooling decisions

- **No `bun`, no `just`, no `tsc`** on the build host — only `node` and
  `pi`. The MCP server is compiled once on the host with `npx tsc` (cached
  via `~/.npm/_cacache`) and the compiled output is committed.
- **No `claude` binary on host** — the MCP listener only runs inside the
  Claude container, where `claude` is on `PATH` via
  `npm install -g @anthropic-ai/claude-code`. Listener shells out to
  `claude --print --resume <sid> "..."`.

---

## 14. MCP server registration (decided)

Claude Code reads user-scope MCP server configs from `~/.claude.json`
under the `mcpServers` key. It does NOT read `.mcp.json` files from
arbitrary paths. So the Claude container's entrypoint calls a small
Node.js helper (`claude/coms-mcp-server/src/merge-mcp.ts` →
`merge-mcp.js`) that idempotently merges our entry into `~/.claude.json`.

See `docs/comms-inner-followups.md` for the full list of known
issues and followup work (per-service `--explicit` flag, cold-start
`--resume` behavior, timeout retry, naming convention consistency).

---

*Once you sign off on §13, I'll start at §11 step 1.*
