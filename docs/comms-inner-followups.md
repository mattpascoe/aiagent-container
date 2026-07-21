# agentharness-comms followups

Tracked issues and improvements identified during the initial build.
Each item has a status and a short context block so a future session
(or another contributor) can pick it up without re-deriving the
context.

Status legend: `open` (not started) · `in-progress` · `done` · `wontfix`

---

## 1. ~~`.mcp.json` location — move to user-scope `~/.claude.json`~~ ✅ done

**Was:** entrypoint wrote `/workspace/.mcp.json` (project-scoped, lands
in git if workspace is a git repo, requires workspace trust on first run).

**Now:** entrypoint calls `node .../merge-mcp.js` which idempotently
merges our entry under `~/.claude.json`'s `mcpServers` key. Claude Code
reads user-scope MCP configs from `~/.claude.json` only — it does NOT
read arbitrary `.mcp.json` files in `~/.claude/`.

**Bootstrap scenarios handled** (all verified):
| State of `~/.claude.json` | Action |
|---|---|
| Doesn't exist | Create with our entry |
| Exists, no `mcpServers` key | Add key + our entry, preserve everything else |
| Exists, has `mcpServers`, no `agentharness-comms` | Append our entry |
| Exists, has our entry | Refresh ours (in case image changed) |
| Exists, malformed JSON | Log + exit 0 (preserve original; entrypoint proceeds) |
| Idempotent re-run | Says "already up to date", no write |

**Atomicity:** writes go to `~/.claude.json.tmp` then `rename(2)`.

**Files:**
- `claude/coms-mcp-server/src/merge-mcp.ts` — bootstrap helper
- `claude/entrypoint.sh` — calls merge-mcp.js before starting claude
- `claude/Dockerfile` — builds merge-mcp.js as part of `tsc`

**Decided against:** option C (writing `~/.claude/.agentharness.mcp.json`
plus a hook to import it). Claude Code doesn't natively support "import
another MCP file" — would have required a custom UserPromptSubmit or
SessionStart hook just to copy the file, which is more moving parts
than the merge approach.

---

## 2. Per-service `--explicit` flag on Claude side

**Status:** open

**Context:** the Pi extension honors `--explicit` and filters those
peers out of default `coms_list` listings. The Claude listener respects
`AGENTHARNESS_CNAME`/`PURPOSE`/`COLOR` env vars but has no equivalent of
`--explicit` — the entrypoint just passes `--cname`, not `--explicit`.

**What needs to happen:**
1. Add `--explicit` parsing to `claude/coms-mcp-server/src/identity.ts`
   (`resolveIdentity` already has the flag detection but it's not wired
   through to the registry entry's `explicit` field — verified by
   reading the smoke test output: `"explicit": false` is always written).
2. In `claude/entrypoint.sh`, add a `AGENTHARNESS_EXPLICIT` env var and
   pass `--explicit` to the listener if set.
3. In `compose.yaml`, add an `AGENTHARNESS_EXPLICIT` env var per service
   with a sensible default (probably `""` / unset).

**Why it matters:** if you launch a one-off claude session for a
specific purpose (e.g. "lint-bot"), you don't want it appearing in
every other agent's default `coms_list` output.

---

## 3. `--resume` requires a prior session — cold first prompt

**Status:** open (design call needed)

**Context:** the Claude listener only passes `--resume <sid>` to
`claude --print` after it has captured a `session_id` from a previous
invocation. The persisted `claude-session.json` survives container
restarts but NOT host reboots that wipe the bind-mount. So:

- First inbound prompt on a fresh container: cold (no `--resume`). The
  `claude --print` invocation runs without prior context, returns a
  `session_id`, which we persist.
- Subsequent inbound prompts in the same container lifetime: warm
  (`--resume` works, conversation has continuity).
- After container restart but bind-mount preserved: warm (we read the
  saved `session_id` from `~/.agentharness-comms/sessions/<cid>/`).
- After bind-mount wipe: cold again.

**What needs to happen:**
Two possible directions — pick one based on how invasive you want the
change to be:

A. **Accept the cold-start as-is.** Document it. Most inbound prompts
   are self-contained ("what time is it?", "explain X") and don't need
   prior context. Conversation continuity is a bonus for users who send
   multiple related prompts.

B. **Seed the session with a warm-up prompt.** On listener boot, before
   accepting any real inbound prompts, spawn one self-directed
   `claude --print "intro: ..."` to create a session_id. Slight cost
   (one extra LLM call per container boot) but every inbound prompt is
   then warm.

C. **Skip `--resume` but include prior conversation context.** Capture
   all inbound prompts and outbound responses, store as a transcript,
   and prepend to each new `claude --print` invocation. More work,
   higher fidelity, doesn't rely on Claude's session machinery.

My recommendation is **A** unless you have a specific use case that
needs B/C.

---

## 4. No retry on `claude --print` timeout

**Status:** open

**Context:** `claude/coms-mcp-server/src/listener.ts` has a 120-second
hard timeout on each `claude --print` invocation. On timeout, we send
an error response back to the peer and audit the failure. We do NOT
retry.

**What needs to happen:**
- If you want retries: add retry logic around the `runClaude()` call
  in `listener.ts`. Exponential backoff, max 2-3 attempts.
- If 120s is too short for some prompts: make it configurable via env
  var (e.g. `AGENTHARNESS_CLAUDE_TIMEOUT_MS=180000`).

**Why we didn't add it initially:** wanted to keep the first version
simple. A timeout that fires is almost always a real bug (the prompt
hung the model), not a transient network issue, so retrying might mask
real problems.

---

## 5. Default `AGENTHARNESS_CNAME` is `claude-<short_id>` from hostname

**Status:** open (decide on naming convention)

**Context:** the entrypoint derives `AGENTHARNESS_CNAME` from the
container's hostname: `claude-$(hostname | head -c 6)`. Two containers
on the same host with different hostnames get different names (good).
Two containers on the same host with the SAME hostname (unusual but
possible if you override) collide → `claude-<id>-2` via
`resolveUniqueName`. The Pi side derives from `basename $(pwd)` if no
`--cname` is passed, so Pi↔Pi naming is by workspace.

**What needs to happen:**
Decide on a consistent naming scheme:
- All agents derive from hostname (simplest, but doesn't tell you
  which project they're working on)
- All agents derive from cwd (only works if container cwd is stable
  per project)
- Both, with hostname as a disambiguator suffix (e.g.
  `workspace-claude-<host6>`)
- Let the user always set it explicitly via env (current behavior,
  but with a less generic default)

If you pick option 1, the entrypoint default should switch from
`basename $cwd` to `claude-<hostname6>` on the Pi side too. Currently
the Pi side uses cwd (via the extension's own default) which is
inconsistent.

---

## Build summary

- Status as of `2026-07-20`: items 1 done, 2-5 open
- Estimated effort to close 2-5: ~30-60 minutes total
- Priority order if you want to tackle them: 3 (design call) > 2 (5 min
  fix) > 5 (5 min fix) > 4 (only if a real prompt hits the timeout)
