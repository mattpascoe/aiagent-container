# agentharness-comms — Usage Guide

How to launch and configure Pi agents that participate in cross-container
agent communication. Covers the CLI flags and frontmatter system that
populate each agent's registry entry (`~/.agentharness-comms/projects/<project>/agents/<name>.json`).

> **Scope.** This is the *user-facing* guide. For wire-protocol internals
> (envelope types, transport, registry layout, audit format) see
> [`src/coms-protocol/README.md`](../../pi/src/coms-protocol/README.md).
> For design history and implementation notes see
> [`coms-inner-plan.md`](coms-inner-plan.md).

---

## 1. Quickstart

The smallest end-to-end example — launch a Pi agent that joins the comms
pool with a custom name, purpose, and color:

```bash
pi \
  -e /pi/agent/extensions/coms-inner \
  --cname alice \
  --purpose "writes integration tests" \
  --project demo \
  --color "#FFAA8B"
```

On startup the extension will:

1. Generate a session ULID and pick a unique socket path under
   `~/.agentharness-comms/sockets/<container_id>/`.
2. Resolve the agent's identity (name, purpose, color, project).
3. Write a registry entry to
   `~/.agentharness-comms/projects/<project>/agents/<name>.json`.
4. Expose `coms_list`, `coms_send`, `coms_get`, `coms_await` to the LLM.
5. Render a pool widget in the TUI showing all peers.

Verify from any other Pi/Claude session in the same project:

```bash
coms_list                    # show peers in current project
coms_list project="demo"     # explicit project
coms_list project="*"        # scan all projects
```

---

## 2. CLI flags

All five flags below are registered by the `coms-inner` extension via
`pi.registerFlag(...)` (see `index.ts:316–334`). They must be on the
command line *after* the `-e /pi/agent/extensions/coms-inner` flag so
the extension is loaded first; otherwise pi's own parser will reject
them.

| Flag | Type | Sets (registry field) | Precedence |
|---|---|---|---|
| `--cname <name>` | string | `name` | CLI > frontmatter `name:` > `agent-XXXXXX` (auto) |
| `--purpose <text>` | string | `purpose` | CLI > frontmatter `description:` > `""` |
| `--project <name>` | string | (filesystem namespace) | CLI > `basename $(pwd)` |
| `--color #RRGGBB` | string | `color` | CLI > frontmatter `color:` > deterministic palette |
| `--explicit` | boolean | `explicit` (in `coms_list`) | CLI only; default `false` |

### Notes on individual flags

- **`--cname`** (not `--name`). `pi` already owns `--name` for session
  resume, so the extension uses a separate flag. If a name is already
  taken in the same project, the extension appends a numeric suffix and
  writes a `name_collision` audit event.
- **`--purpose`** is a free-text string with no length cap in the
  extension, but keep it short — it shows up in the pool widget and in
  every `coms_list` line.
- **`--project`** controls which `projects/<name>/` subdirectory the
  registry entry lands in. Peers in different projects can't see each
  other via `coms_list project=<x>` (use `project="*"` to scan all).
- **`--color`** must be a 6-digit hex string starting with `#`. Invalid
  values silently fall back to the deterministic palette.
- **`--explicit`** hides the agent from `coms_list` when `include_explicit`
  is left at its default `false`. Pass `include_explicit=true` to
  enumerate explicit agents. Use this for agents that should only be
  addressable by exact name (e.g. a sensitive code-review agent that
  shouldn't appear in casual peer listings).

### Worked examples

```bash
# A long-running reviewer in a specific project
pi -e /pi/agent/extensions/coms-inner \
   --cname reviewer \
   --purpose "strict code reviewer, read-only" \
   --project auth-refactor \
   --color "#E06C75" \
   --tools read,grep,find,ls

# An explicit agent that only responds when addressed by exact name
pi -e /pi/agent/extensions/coms-inner \
   --cname secrets-auditor \
   --purpose "audits for credential leaks" \
   --project demo \
   --explicit

# Inspect it (note the project filter and the explicit flag)
coms_list project="demo" include_explicit=true
```

---

## 3. The frontmatter system

If you don't pass `--purpose`/`--cname`/`--color` on the command line,
the extension reads those fields from **YAML frontmatter in the file
passed to `--system-prompt` or `--append-system-prompt`**. It does
**not** read frontmatter from `AGENTS.md` or from any other file the
harness auto-discovers.

This is the part that's easy to miss, because most users' mental model
is "role metadata goes in AGENTS.md." It doesn't, for these three
fields — they're parsed out of the system-prompt file specifically.

### The scanned file

The extension scans `process.argv` for the first occurrence of either
flag and reads the `.md` file at that path
(`index.ts:234–262`):

```ts
function findSystemPromptPath(argv: string[]): string | null {
    const scan = (flag: string): string | null => {
        for (let i = 0; i < argv.length; i++) {
            if (argv[i] === flag && i + 1 < argv.length) {
                const candidate = argv[i + 1];
                if (candidate.endsWith(".md") && fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }
        return null;
    };
    return scan("--system-prompt") ?? scan("--append-system-prompt");
}
```

Both flags are scanned, but **`--system-prompt` wins if both are present.**

### The supported schema

The parser (`index.ts:198–225`) is intentionally minimal. It recognizes
**only three keys**, all flat `key: value` strings:

| Key | Maps to registry field |
|---|---|
| `name` | `name` (overridden by `--cname` if present) |
| `description` | `purpose` (overridden by `--purpose` if present) |
| `color` | `color` (overridden by `--color` if present) |

### Authoring rules

Based on the actual parser implementation:

- **YAML must be at the top of the file**, wrapped in `---` markers:
  ```markdown
  ---
  name: alice
  description: writes integration tests
  color: "#FFAA8B"
  ---

  # Role
  ...
  ```
- **Values are single-line strings.** No nested mappings, no lists, no
  multi-line scalars (`|`, `>`, etc.).
- **Quotes are stripped** if the value is wrapped in matching `"..."` or
  `'...'`. Both work.
- **Unknown keys are silently ignored.** No warning, no error.
- **Malformed frontmatter** (no closing `---`, bad marker placement)
  causes `parseFrontmatter` to return `{ body: raw }` — meaning the
  whole file becomes the system prompt body and the three fields stay
  empty.
- **Empty file, missing file, or no frontmatter at all** all resolve to
  empty `purpose` (and missing name/color).

### Worked example with frontmatter

Role file at `./agents/reviewer.md`:

```markdown
---
name: reviewer
description: strict code reviewer, never modifies files
color: "#E06C75"
---

You are a code reviewer. Your job is to read code, find problems, and
report back. You must not edit any files. Use the `read`, `grep`, and
`find` tools only. Be terse.
```

Launch:

```bash
pi -e /pi/agent/extensions/coms-inner \
   --append-system-prompt ./agents/reviewer.md \
   --tools read,grep,find \
   --project demo
```

Resulting registry entry (at `~/.agentharness-comms/projects/demo/agents/reviewer.json`):

```json
{
  "name": "reviewer",
  "purpose": "strict code reviewer, never modifies files",
  "color": "#E06C75",
  "model": "anthropic/claude-sonnet-5",
  "explicit": false,
  ...
}
```

To override any of those three fields without editing the role file,
just add the corresponding CLI flag:

```bash
pi ... --append-system-prompt ./agents/reviewer.md \
       --purpose "second-pass review for the auth refactor"
# → purpose becomes "second-pass review for the auth refactor"
# → name and color still come from frontmatter
```

---

## 4. Role files (the `agent-roles/` convention)

Rather than hand-assembling `--append-system-prompt` invocations, the
repo defines a convention: a top-level `agent-roles/` directory where
each `.md` file is one reusable role. The file's frontmatter drives the
coms identity and its body is the system prompt — exactly the mechanism
described in §3, packaged as a convention.

```
agent-roles/
├── README.md      # the convention itself
├── reviewer.md    # one role per file
└── tester.md
```

Each file looks like:

```markdown
---
name: reviewer
description: strict code reviewer, read-only
color: "#E06C75"
---

You are a strict, senior code reviewer. ...
```

There is deliberately **no `model:` frontmatter key** — the model is a
launch-time choice, not a property of the role (see below).

### Launching a role

Two harness-aware Makefile targets run from the repo root:

```sh
make pi-role     ROLE=reviewer
make pi-role     ROLE=reviewer MODEL=sonnet
make pi-role     ROLE=tester   PROMPT="run the suite"   # one-shot, then exit
make pi-role     ROLE=reviewer PROJECT=teamA            # join a shared project
make claude-role ROLE=reviewer
```

| Var | Required | Meaning |
|---|---|---|
| `ROLE` | yes | Role file stem → `agent-roles/<ROLE>.md` |
| `MODEL` | no | Passed through to `--model` |
| `PROMPT` | no | If set → one-shot (`pi -p` / `claude --print`); if omitted → interactive/persistent session |
| `PROJECT` | no | Coms project namespace (default: basename of `WORKDIR`) |

The targets are thin pass-throughs: they translate `ROLE` into an
`--append-system-prompt agent-roles/<ROLE>.md` flag and add `--project`,
`--model`, and one-shot flags as needed. No frontmatter parsing happens
in the Makefile. Pi's entrypoint auto-loads all extensions, so no `-e`
flag is needed.

### Projects and the `WORKDIR` default

Inside every container the working directory is always `/workspace`, so
if agents defaulted to `basename(cwd)` they would **all** land in a
project literally called `workspace` — regardless of which host
directory they're actually operating on. To avoid that, the Makefile
defaults `PROJECT` to the basename of the host `WORKDIR`:

```makefile
export PROJECT ?= $(notdir $(abspath $(WORKDIR)))
```

So `make pi-role ROLE=reviewer WORKDIR=/opt/dev/myapp` puts the agent in
project `myapp`, and agents launched against the same `WORKDIR` share a
project and can discover each other. Override explicitly with
`PROJECT=<name>` to group agents across different working directories
(e.g. a pi agent and a claude agent collaborating on one task).

- **pi**: `--project` is read directly by the `coms-inner` extension.
- **claude**: the Makefile passes `AGENTHARNESS_PROJECT`, which the
  Claude adapter's `resolveIdentity()` honors (CLI `--project` > env
  `AGENTHARNESS_PROJECT` > basename of cwd).

### Pi vs. Claude asymmetry

- **Pi** reads the role file's frontmatter, so `name` / `purpose` /
  `color` populate the coms registry automatically. One file drives
  everything.
- **Claude** does **not** read frontmatter. The body still loads as the
  appended system prompt, but the frontmatter block is inert — it just
  appears as a few harmless lines at the top of the prompt (this is an
  accepted tradeoff, not a bug). Claude's coms identity comes from the
  `CLAUDE_CNAME` / `CLAUDE_PURPOSE` / `CLAUDE_COLOR` env vars wired in
  `compose.yaml`, which is a separate, optional mechanism.

See [`../agent-roles/README.md`](../../agent-roles/README.md) for the
authoring reference.

---

## 5. Precedence summary

For each of the three frontmatter-driven fields:

```
CLI flag  >  frontmatter in system-prompt file  >  default
```

Concretely:

| Field | CLI | Frontmatter | Default |
|---|---|---|---|
| `name` | `--cname foo` | `name: foo` | `agent-XXXXXX` (last 6 of ULID) |
| `purpose` | `--purpose "..."` | `description: ...` | `""` |
| `color` | `--color #RRGGBB` | `color: "#RRGGBB"` | deterministic palette |
| `project` | `--project foo` | — | `basename $(pwd)` |
| `explicit` | `--explicit` | — | `false` |

Note that **`project` and `explicit` have no frontmatter source** —
they're CLI-only or defaulted.

---

## 6. Common patterns

### Single-agent baseline

The default. Just launch pi normally; the extension auto-loads at
session start and assigns a name, no purpose, default project, palette
color.

```bash
pi
# → registers as agent-XXXXXX in project=$(basename $PWD)
```

### Specialist with locked-down toolset

A read-only reviewer. `--tools` here is a pi flag (not a coms flag) but
it's the right combination:

```bash
pi -e /pi/agent/extensions/coms-inner \
   --append-system-prompt ./roles/reviewer.md \
   --tools read,grep,find,ls \
   --project code-review
```

`roles/reviewer.md` carries the frontmatter `description:` so the agent
shows up in `coms_list` as "strict code reviewer, never modifies files"
and other agents know what to expect.

### Orchestrator + worker pair

The orchestrator (you) launches with full tools; the worker is scoped.

```bash
# Terminal A — worker
pi -e /pi/agent/extensions/coms-inner \
   --cname test-runner \
   --purpose "runs pytest and reports results" \
   --project demo

# Terminal B — orchestrator (your session)
pi -e /pi/agent/extensions/coms-inner

# From the orchestrator:
coms_list                                       # see test-runner
coms_send target=test-runner prompt="run the suite, return failures"
coms_await msg_id=...                            # block for results
```

### Don't pass large state via prompt

Agents in different containers have separate `~/.pi/agent/` directories
and no shared filesystem beyond `~/.agentharness-comms/`. Passing a
10MB file path doesn't work — the other agent can't read it. Either:

- Pass content inline in the `coms_send` prompt.
- Have the worker write into its own `cwd` and report the path back.
- Mount a shared host directory into both containers' workspaces.

---

## 7. What `purpose` actually does

`purpose` is purely a display string. It surfaces in three places and
nothing else:

1. **The registry file** at
   `~/.agentharness-comms/projects/<project>/agents/<name>.json`. Visible
   to anyone with filesystem access to that path.
2. **The pool widget** rendered above the editor
   (`index.ts:1019`):
   ```
   ● test-runner (anthropic/claude-sonnet-5) [████████░░] 78%  runs pytest and reports results
   ```
3. **`coms_list` tool output** — both the structured card and any
   human-readable summary lines.

It is **not** used for filtering, routing, ACLs, or matching — `coms_send`
addresses peers by `name`, not by `purpose`. So treat it as a label
for humans and LLMs to read, not a routing key.

If you need to filter peers by intent at the LLM level, the agent has
to call `coms_list` and reason about the `purpose` strings itself.

---

## 8. Troubleshooting

### "Unknown options: --purpose" at startup
The extension isn't loaded yet at parse time. Make sure
`-e /pi/agent/extensions/coms-inner` appears **before** the
`--purpose` (or other coms flag) on the command line. The container
entrypoint (`/entrypoint.sh`) loads all extensions from
`/pi/agent/extensions/*/index.ts` automatically; if you're running pi
manually outside the harness, pass `-e` explicitly.

### `purpose` is empty in the registry even though I set `--purpose`
Check that the value isn't being shadowed by a frontmatter `description:`
in a system-prompt file. CLI > frontmatter is the *intended* precedence,
so this shouldn't happen — but if you have BOTH `--purpose "foo"` and
a system-prompt file with `description: "bar"`, the CLI value wins
and you should see `"purpose": "foo"`. If you see `"bar"`, the CLI
flag isn't reaching the extension (re-check argv ordering).

### My agent shows up in the wrong project
You didn't pass `--project` and your `cwd` doesn't match what you
expected. The project defaults to `basename $(pwd)`. Either `cd` first
or pass `--project` explicitly.

### I can't see my agent in `coms_list`
- Different projects. Try `coms_list project="*"`.
- You launched with `--explicit`. Try
  `coms_list include_explicit=true`.
- The agent crashed. Check `~/.agentharness-comms/audit.log` and the
  agent's own session log.

### Frontmatter changes aren't taking effect
The frontmatter is read once at `session_start`. Editing the role file
and sending the agent a follow-up message won't reload it — you have
to restart the session.

---

## 9. Cross-references

- **Extension source** (single source of truth for flag wiring and
  frontmatter parsing): `/pi/agent/extensions/coms-inner/index.ts`
  - Header doc with CLI flag summary: lines 30–45
  - Frontmatter parser: lines 198–225
  - Argv scanner: lines 234–262
  - Flag registration: lines 316–334
  - Identity resolution in `session_start`: lines 540–610
- **Role convention**: [`../agent-roles/README.md`](../../agent-roles/README.md)
  and the `pi-role` / `claude-role` Makefile targets
- **Wire protocol**: `/pi/src/coms-protocol/README.md`
- **Design history**: [`coms-inner-plan.md`](coms-inner-plan.md)
- **Followup work**: [`comms-inner-followups.md`](comms-inner-followups.md)
- **Project README**: `/workspace/README.md` (high-level overview of
  the agentharness-comms system)
