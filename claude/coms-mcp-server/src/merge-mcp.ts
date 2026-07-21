#!/usr/bin/env node
/**
 * Bootstrap helper: idempotently merge our MCP server entry into
 * `~/.claude.json` under the `mcpServers` key.
 *
 * Why this exists:
 *   Claude Code's user-scope MCP config lives in `~/.claude.json`. We want
 *   the agentharness-comms MCP server registered there so Claude auto-
 *   connects to it on every session, in every project, without needing a
 *   project-scoped `.mcp.json` (which would either pollute the workspace
 *   or require workspace trust on first run).
 *
 *   The naive approach — `cat > ~/.claude.json <<EOF` — would clobber
 *   whatever else Claude stored in there (theme, account, recent projects,
 *   user-added MCP servers). This script MERGES instead, idempotently:
 *
 *     - If ~/.claude.json doesn't exist → create it with just our entry.
 *     - If it exists but has no `mcpServers` key → add the key.
 *     - If it exists with `mcpServers` but no `agentharness-comms` →
 *       add our entry alongside any others.
 *     - If it already has our entry → refresh it (in case our command/env
 *       changed in a new image version) but don't touch other entries.
 *
 * Atomicity: writes go to `~/.claude.json.tmp`, then `rename(2)` over the
 * target. If the script crashes mid-write, the original file is preserved.
 *
 * Errors: missing/non-writable home, unparseable JSON → exit non-zero
 * with a clear message; the entrypoint will fall through to `exec claude`
 * without our MCP server rather than blocking the whole session.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SERVER_NAME = "agentharness-comms";
const HOME = process.env.HOME || os.homedir();
const TARGET = path.join(HOME, ".claude.json");

function readJsonOrEmpty(p: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    console.error(`[merge-mcp] ${p} is not a JSON object; treating as empty`);
    return {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw new Error(`failed to read ${p}: ${e.message}`);
  }
}

function buildServerEntry(): Record<string, unknown> {
  const comsBin =
    process.env.AGENTHARNESS_COMMS_BIN ||
    "/claude/coms-mcp-server/dist/claude/coms-mcp-server/src/cli.js";
  const comsDir =
    process.env.COMS_DIR || path.join(HOME, ".agentharness-comms");
  return {
    type: "stdio",
    command: "node",
    args: [comsBin],
    env: {
      COMS_DIR: comsDir,
      AGENTHARNESS_CNAME: process.env.AGENTHARNESS_CNAME || "",
      AGENTHARNESS_PURPOSE: process.env.AGENTHARNESS_PURPOSE || "",
      AGENTHARNESS_COLOR: process.env.AGENTHARNESS_COLOR || "",
    },
  };
}

function main(): void {
  const existing = readJsonOrEmpty(TARGET);
  const existingServers =
    (existing.mcpServers as Record<string, unknown> | undefined) ?? {};

  const before = JSON.stringify(existingServers);
  const after = { ...existingServers, [SERVER_NAME]: buildServerEntry() };

  if (before === JSON.stringify(after)) {
    console.error(`[merge-mcp] ${TARGET} already up to date`);
    return;
  }

  existing.mcpServers = after;

  // Atomic write
  const tmp = `${TARGET}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
  fs.renameSync(tmp, TARGET);
  console.error(
    `[merge-mcp] wrote ${SERVER_NAME} to ${TARGET} (now ${
      Object.keys(after).length
    } server(s) registered)`,
  );
}

try {
  main();
} catch (err) {
  console.error(`[merge-mcp] FAILED: ${(err as Error).message}`);
  // Exit 0 so the entrypoint doesn't refuse to launch claude. The error
  // is logged so the operator can investigate.
  process.exit(0);
}
