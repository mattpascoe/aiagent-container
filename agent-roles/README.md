# agent-roles

A convention for defining reusable agent roles as single `.md` files.

Each file in this directory is **one role**. It does double duty:

1. Its **YAML frontmatter** defines the agent's cross-container coms
   identity (`name`, `description` → purpose, `color`).
2. Its **body** is the agent's system prompt.

The filename stem is the canonical role id — `reviewer.md` → role
`reviewer`.

## File format

```markdown
---
name: reviewer
description: strict code reviewer, read-only
color: "#E06C75"
---

You are a code reviewer. Read code, find problems, and report back.
Never edit files. Use read/grep/find only. Be terse.
```

Frontmatter keys (all optional, all single-line strings):

| Key | Effect |
|---|---|
| `name` | Agent name in the coms registry / pool widget |
| `description` | Becomes the agent's `purpose` in coms |
| `color` | `#RRGGBB` swatch color in the pool widget |

Anything after the closing `---` is the system prompt.

> **Note:** There is intentionally **no `model:` key.** The model is a
> launch-time choice, passed via `MODEL=` on the make target (see below).
> Keeping it out of the file means roles stay portable across models.

## Launching a role

Two harness-aware Makefile targets (run from the repo root):

```sh
# Pi — frontmatter populates coms identity automatically
make pi-role ROLE=reviewer

# Pin a model for this launch
make pi-role ROLE=reviewer MODEL=sonnet

# One-shot task (non-interactive): pass a prompt
make pi-role ROLE=tester PROMPT="run the test suite and report failures"

# Claude — body loads as the appended system prompt
make claude-role ROLE=reviewer
```

Variables:

| Var | Required | Meaning |
|---|---|---|
| `ROLE` | yes | Role file stem (`agent-roles/<ROLE>.md`) |
| `MODEL` | no | Model pattern passed to `--model` |
| `PROMPT` | no | If set, runs one-shot (`pi -p` / `claude --print`) and exits; otherwise starts an interactive/persistent session |
| `PROJECT` | no | Coms project namespace (default: basename of `WORKDIR`) |

### Projects

Agents only discover peers **in the same coms project** (unless they
explicitly scan with `coms_list project="*"`). Because the container cwd
is always `/workspace`, the Makefile defaults `PROJECT` to the basename
of the host `WORKDIR` rather than the cwd — so agents working on the same
host directory share a project automatically. To put a pi agent and a
claude agent (or several roles) into one shared project, pass the same
`PROJECT=<name>` to each:

```sh
make pi-role     ROLE=reviewer PROJECT=teamA
make claude-role ROLE=tester   PROJECT=teamA
```

## Pi vs. Claude — important asymmetry

- **Pi** reads the frontmatter from the `--append-system-prompt` file, so
  `name` / `description` / `color` populate the coms registry with no
  extra flags. One file drives everything.
- **Claude** does **not** read frontmatter. The body still loads as the
  appended system prompt, but the frontmatter block is inert (it just
  appears as a few harmless lines at the top of the prompt). Claude's
  coms identity comes from `CLAUDE_CNAME` / `CLAUDE_PURPOSE` /
  `CLAUDE_COLOR` env vars instead (see `compose.yaml`), which is a
  separate, optional mechanism.

See [`../docs/agentharness-comms.md`](../docs/agentharness-comms.md) for
the full comms usage guide.
