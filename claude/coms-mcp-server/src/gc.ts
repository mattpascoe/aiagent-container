#!/usr/bin/env node
/**
 * `agentharness-comms-claude gc` — on-demand cleanup of session directories
 * for containers that are, in all likelihood, never coming back.
 *
 * Deliberately NOT run automatically on the heartbeat tick, unlike socket
 * pruning (src/coms-protocol/gc.ts's pruneStaleSockets, which listener.ts
 * already calls every tick). Socket staleness is provably safe — a
 * session_id is never reused, so an untouched socket is permanently dead.
 * Session-directory staleness is a TTL heuristic on top of a real, valuable
 * invariant (claude-session.json is what lets --resume survive arbitrarily
 * long container downtime), and getting the TTL wrong is silent and
 * irreversible: the next boot for that container just starts an un-resumed
 * conversation, no crash to notice it by. That risk belongs behind an
 * explicit command, dry-run by default, not a background timer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  readAllRegistryEntriesAcrossProjects,
  sessionsRoot,
  pruneStaleSockets,
  HEARTBEAT_STALE_MS,
  type RegistryEntry,
} from "../../../src/coms-protocol/index.js";
import { resolveIdentity } from "./identity.js";

const DEFAULT_MAX_AGE_DAYS = 30;

function parseArgs(argv: string[]): { maxAgeDays: number; apply: boolean } {
  let maxAgeDays = DEFAULT_MAX_AGE_DAYS;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-age-days") {
      const v = Number(argv[i + 1]);
      if (!Number.isNaN(v) && v >= 0) maxAgeDays = v;
      i++;
    } else if (argv[i] === "--apply") {
      apply = true;
    }
  }
  return { maxAgeDays, apply };
}

/** Same shape as tools.ts's isEntryLiveFromEntry — duplicated locally to
 * avoid needing each entry's own registry file path, which
 * readAllRegistryEntriesAcrossProjects doesn't hand back. */
function isContainerLive(entry: RegistryEntry, nowMs: number): boolean {
  if (!entry.heartbeat_at) return false;
  const t = Date.parse(entry.heartbeat_at);
  return !Number.isNaN(t) && nowMs - t <= HEARTBEAT_STALE_MS;
}

/**
 * Newest mtime among a directory's immediate children — files AND
 * subdirectories alike, not recursive. Null if the directory is
 * empty/unreadable, i.e. "no basis to judge staleness by."
 */
function newestMtime(dir: string): number | null {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const f of files) {
    try {
      const stat = fs.statSync(path.join(dir, f));
      if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      /* skip — transient stat failure, next run re-evaluates */
    }
  }
  return newest;
}

function main(): void {
  // Find "gc" itself rather than assuming a fixed offset (e.g. slice(3)):
  // cli.ts's own slice count is an implementation detail this module
  // shouldn't have to track. If "gc" is missing entirely (shouldn't happen —
  // cli.ts only imports this file when argv[0] === "gc"), fall back to
  // treating everything after the binary name as args.
  const gcIdx = process.argv.indexOf("gc");
  const rest = gcIdx >= 0 ? process.argv.slice(gcIdx + 1) : process.argv.slice(2);
  const { maxAgeDays, apply } = parseArgs(rest);
  const ident = resolveIdentity();
  const comsDir = ident.coms_dir;

  console.error(
    `[gc] ${apply ? "APPLY" : "DRY RUN (pass --apply to actually delete)"} — max-age-days=${maxAgeDays}`,
  );

  // Socket sweep: provably safe (see gc.ts's header comment), so it runs
  // regardless of dry-run/apply. This just forces an immediate pass instead
  // of waiting for the next 10s heartbeat tick to get to it.
  const { reaped: socketsReaped } = pruneStaleSockets(comsDir);
  console.error(`[gc] sockets: reaped ${socketsReaped} orphaned .sock file(s)`);

  if (maxAgeDays === 0) {
    console.error("[gc] sessions: skipped (--max-age-days 0 disables session cleanup)");
    return;
  }
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();

  // A session dir is only a candidate if BOTH its mtime is stale AND its
  // container isn't currently registered anywhere — not just in our own
  // project. Double safety net: a container that's genuinely gone will fail
  // both checks; a container that's merely quiet fails only the first.
  const liveContainerIds = new Set(
    readAllRegistryEntriesAcrossProjects(comsDir)
      .filter((e) => isContainerLive(e, nowMs))
      .map((e) => e.container_id),
  );

  const root = sessionsRoot(comsDir);
  let containerDirs: string[];
  try {
    containerDirs = fs.readdirSync(root);
  } catch {
    console.error("[gc] sessions: no sessions directory found, nothing to do");
    return;
  }

  let candidates = 0;
  let deleted = 0;
  for (const containerId of containerDirs) {
    const dir = path.join(root, containerId);
    const newest = newestMtime(dir);
    if (newest === null) continue; // empty dir — nothing to judge staleness by
    const ageMs = nowMs - newest;
    if (ageMs <= maxAgeMs) continue;
    if (liveContainerIds.has(containerId)) continue; // still registered — never touch
    candidates++;
    const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
    if (apply) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        deleted++;
        console.error(`[gc] sessions: deleted ${containerId} (last touched ${ageDays}d ago)`);
      } catch (err) {
        console.error(`[gc] sessions: failed to delete ${containerId}: ${(err as Error).message}`);
      }
    } else {
      console.error(`[gc] sessions: would delete ${containerId} (last touched ${ageDays}d ago)`);
    }
  }

  console.error(
    apply
      ? `[gc] sessions: deleted ${deleted}/${candidates} stale session dir(s)`
      : `[gc] sessions: ${candidates} stale session dir(s) would be deleted — rerun with --apply to delete`,
  );
}

main();
