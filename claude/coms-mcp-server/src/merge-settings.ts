#!/usr/bin/env node
/**
 * Bootstrap helper: idempotently register the coms hook in
 * `~/.claude/settings.json` under `hooks.Stop` and `hooks.UserPromptSubmit`.
 *
 * Sibling of merge-mcp.ts, and the same reasoning applies — `~/.claude` is
 * bind-mounted from the host (see compose.yaml), so this file holds the user's
 * real settings: theme, model, statusLine, their own hooks. Clobbering it would
 * destroy state that has nothing to do with us. So we merge:
 *
 *   - no settings.json            → create with just our hook
 *   - no `hooks` key              → add it
 *   - hooks exist, ours absent    → append alongside, preserving theirs
 *   - ours already present        → refresh the command (image paths can move
 *                                   between versions) without duplicating
 *
 * Identification: we match our own entries by the AGENTHARNESS_HOOK_MARKER
 * substring in the command, not by array position, so reordering or
 * user-added hooks never confuse us.
 *
 * Atomicity: write to a tmp file, then rename(2) over the target.
 *
 * Failure is non-fatal by design — exit 0 and log. A session without inbound
 * delivery is degraded; a session that refuses to launch is broken.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOOK_MARKER = "agentharness-comms-hook";
const HOME = process.env.HOME || os.homedir();
const SETTINGS = path.join(HOME, ".claude", "settings.json");
const EVENTS = ["Stop", "UserPromptSubmit"] as const;

interface HookCommand {
  type: string;
  command: string;
}
interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

function readJsonOrEmpty(p: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    console.error(`[merge-settings] ${p} is not a JSON object; treating as empty`);
    return {};
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw new Error(`failed to read ${p}: ${e.message}`);
  }
}

function hookCommand(): string {
  const bin =
    process.env.AGENTHARNESS_COMMS_BIN ||
    "/claude/coms-mcp-server/dist/claude/coms-mcp-server/src/cli.js";
  // The marker is what makes this entry recognisably ours on the next run.
  return `node ${bin} hook # ${HOOK_MARKER}`;
}

function isOurs(m: HookMatcher): boolean {
  return (m.hooks ?? []).some((h) => (h.command ?? "").includes(HOOK_MARKER));
}

function main(): void {
  const settings = readJsonOrEmpty(SETTINGS);
  const hooks = (settings.hooks as Record<string, HookMatcher[]> | undefined) ?? {};
  const before = JSON.stringify(hooks);

  for (const event of EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const theirs = existing.filter((m) => !isOurs(m));
    hooks[event] = [
      ...theirs,
      { hooks: [{ type: "command", command: hookCommand() }] },
    ];
  }

  if (before === JSON.stringify(hooks)) {
    console.error(`[merge-settings] ${SETTINGS} already up to date`);
    return;
  }

  settings.hooks = hooks;
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const tmp = `${SETTINGS}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, SETTINGS);
  console.error(
    `[merge-settings] registered coms hook for ${EVENTS.join(", ")} in ${SETTINGS}`,
  );
}

try {
  main();
} catch (err) {
  console.error(`[merge-settings] FAILED: ${(err as Error).message}`);
  process.exit(0);
}
