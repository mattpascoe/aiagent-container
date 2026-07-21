# coms-inner — Pi adapter for cross-container agent communication

Pi extension that lets a Pi Coding Agent instance discover and message
peer agents (other Pi instances + Claude Code instances) across Docker
containers on the same host.

## What it does

When loaded into a Pi session, this extension:

1. Generates a unique session ID (ULID) and resolves a unique socket path:
   ```
   <COMS_DIR>/sockets/<HOSTNAME>/<session_id>.sock
   ```
   The `HOSTNAME` is the short Docker container ID by default, so socket
   paths never collide across containers.

2. Binds that socket and listens for inbound envelopes (prompt / response /
   ping) using the shared wire protocol from `src/coms-protocol/`.

3. Writes a registry entry to
   `<COMS_DIR>/projects/<project>/agents/<name>.json` and heartbeats it
   every 10s so peers can see this agent is alive.

4. Exposes four tools to the LLM:
   - `coms_list` — discover peers
   - `coms_send` — send a prompt, get a `msg_id`
   - `coms_get` — non-blocking poll on `msg_id`
   - `coms_await` — block until reply lands or timeout

5. Renders a live pool widget above the editor showing all peers with
   their names, models, container IDs, and context-window usage.

6. Captures inbound prompts: when a peer sends a `prompt` envelope, the
   extension injects it as a follow-up message into the receiver's
   next turn, then on `agent_end` automatically packages the final
   assistant response and ships it back as a `response` envelope.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `COMS_DIR` | `~/.agentharness-coms` | Shared directory (bind-mounted across containers) |
| `HOSTNAME` / `CONTAINER_ID` | — | Container ID baked into socket paths |
| `PI_COMS_MAX_HOPS` | `5` | Max forwarding depth for prompts |
| `PI_COMS_TIMEOUT_MS` | `1800000` | Default `coms_await` timeout (30 min) |
| `PI_COMS_PING_INTERVAL_MS` | `10000` | How often to refresh peer cards |
| `PI_COMS_KEEPALIVE_INTERVAL_MS` | `10000` | How often to rewrite the registry entry |

## CLI flags (registered by this extension)

All five flags below are registered via `pi.registerFlag(...)` (see
`index.ts:316–334`). They must appear **after** the
`-e /pi/agent/extensions/coms-inner` flag on the command line, so the
extension is loaded before pi's parser sees them; otherwise pi rejects
the invocation with "Unknown options".

| Flag | Type | Sets (registry field) | Precedence |
|---|---|---|---|
| `--cname <name>` | string | `name` | CLI > frontmatter `name:` > `agent-XXXXXX` (auto) |
| `--purpose <text>` | string | `purpose` | CLI > frontmatter `description:` > `""` |
| `--project <name>` | string | (filesystem namespace) | CLI > `basename $(pwd)` |
| `--color #RRGGBB` | string | `color` | CLI > frontmatter `color:` > deterministic palette |
| `--explicit` | boolean | `explicit` (in `coms_list`) | CLI only; default `false` |

Notes:

- **`--cname`** (not `--name`). `pi` already owns `--name` for session
  resume. If the chosen name is already taken in the same project, the
  extension appends a numeric suffix and writes a `name_collision`
  audit event.
- **`--purpose`** is a free-text string. Keep it short — it shows up in
  the pool widget and in every `coms_list` line.
- **`--project`** controls which `projects/<name>/` subdirectory the
  registry entry lands in. Peers in different projects can't see each
  other via `coms_list project=<x>` (use `project="*"` to scan all).
- **`--color`** must be a 6-digit hex string starting with `#`. Invalid
  values silently fall back to the deterministic palette.
- **`--explicit`** hides the agent from `coms_list` when `include_explicit`
  is left at its default `false`. Pass `include_explicit=true` to
  enumerate explicit agents. Use this for agents that should only be
  addressable by exact name.

## Frontmatter (fallback for `--cname`, `--purpose`, `--color`)

If you don't pass `--cname` / `--purpose` / `--color` on the command
line, the extension reads those fields from **YAML frontmatter in the
file passed to `--system-prompt` or `--append-system-prompt`**. It does
**not** read frontmatter from `AGENTS.md` or from any other file the
harness auto-discovers.

The scanned file is whichever `.md` path appears first after
`--system-prompt` or `--append-system-prompt` on the command line
(`--system-prompt` wins if both are present). See `index.ts:234–262`.

### Supported schema

The parser (`index.ts:198–225`) is intentionally minimal — only three
keys, all flat `key: value` strings:

| Key | Maps to registry field |
|---|---|
| `name` | `name` (overridden by `--cname` if present) |
| `description` | `purpose` (overridden by `--purpose` if present) |
| `color` | `color` (overridden by `--color` if present) |

### Authoring rules

- YAML must be at the top of the file, wrapped in `---` markers.
- Values are single-line strings. No nested mappings, no lists, no
  multi-line scalars (`|`, `>`, etc.).
- Quotes are stripped if the value is wrapped in matching `"..."` or
  `'...'`.
- Unknown keys are silently ignored.
- Malformed frontmatter (missing closing `---`) causes the parser to
  treat the whole file as the system prompt body; the three fields
  stay empty.

### Worked example

Role file at `./roles/reviewer.md`:

```markdown
---
name: reviewer
description: strict code reviewer, never modifies files
color: "#E06C75"
---

You are a code reviewer. Use only the `read`, `grep`, and `find` tools.
```

Launch:

```sh
pi -e /pi/agent/extensions/coms-inner \
   --append-system-prompt ./roles/reviewer.md \
   --tools read,grep,find \
   --project demo
```

Resulting registry entry will have `name: "reviewer"`,
`purpose: "strict code reviewer, never modifies files"`, and
`color: "#E06C75"`. To override any of those without editing the role
file, just add the corresponding CLI flag — it wins over the
frontmatter.

## Build / typecheck

```sh
NODE_ENV=development npm install
./node_modules/.bin/tsc --noEmit
```

`NODE_ENV=development` is required because the Docker build environment
sets `NODE_ENV=production` globally, which makes npm skip devDependencies.

`npm install` symlinks `@earendil-works/pi-coding-agent` and `typebox`
from the global install — these are needed to resolve the extension's
imports during typechecking.

## Runtime install

In the container image, this extension is mounted at
`/pi/agent/extensions/coms-inner/` and loaded by `pi/entrypoint.sh`
which iterates over `/pi/agent/extensions/*/index.ts`.

## Cross-container requirements

- The shared directory `~/.agentharness-coms` must be bind-mounted into
  every container at the same absolute path.
- The UID inside every container must match (the project's `Makefile`
  enforces this via `HOST_UID` / `HOST_GID`).
- The Claude side of this protocol is implemented by
  `claude/coms-mcp-server/` (separate component).

## Security interaction with project sandboxes

- `src/fs-vault.c` (LD_PRELOAD): blocks `auth.json` paths. The coms
  registry lives under `~/.agentharness-coms/`, not `auth.json`. No
  conflict.
- `src/app-firewall.js` (NODE_OPTIONS): blocks `.pi/agent`, `gh_*`,
  `.secrets`, `.env` paths. The coms registry uses
  `~/.agentharness-coms/`, none of which match. No conflict.

## Files

- `index.ts` — the extension (~1400 LOC)
- `package.json`, `tsconfig.json` — for typechecking

## See also

- [`../../docs/agentharness-comms.md`](../../docs/agentharness-comms.md) —
  full user-facing usage guide (launch examples, orchestrator patterns,
  troubleshooting).
- [`../../docs/coms-inner-plan.md`](../../docs/coms-inner-plan.md) —
  design and implementation history.
