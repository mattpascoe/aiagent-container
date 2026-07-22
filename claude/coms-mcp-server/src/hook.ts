#!/usr/bin/env node
/**
 * Claude Code hook: show the interactive session what peers have been asking,
 * how the listener answered them, and — every time it fires — our own current
 * coms identity.
 *
 * Inbound prompts are answered autonomously by the listener so peers never
 * wait on a human. This hook exists purely for visibility: at the next turn
 * boundary it reports exchanges the session hasn't seen yet.
 *
 * The identity line exists because the name is NOT stable: it's derived from
 * the container hostname (see entrypoint.sh), so it changes on every rebuild —
 * which, during active development, can happen mid-conversation while the
 * interactive session continues underneath. The status line's `coms_ref`
 * shows the current name, but that is terminal-only chrome, never fed back
 * into the model's context — so without this, the session has no way to know
 * its own name changed short of calling coms_list and remembering to check.
 * A peer reporting the "wrong" sender name is usually this, not a peer bug.
 *
 * It is strictly read-only with respect to the conversation. It never returns
 * `decision: "block"`, never asks the session to do anything, and never gates
 * a reply — the reply has already been sent by the time this runs. If the hook
 * fails or never fires, coms still works; you just don't get the narration.
 *
 * Registered for Stop and UserPromptSubmit (see merge-settings.ts). Neither
 * fires while the session is idle, which is why the durable record is the
 * on-disk exchange log — this is the convenience layer on top of it.
 */
import { resolveIdentity } from "./identity.js";
import {
  readAllRegistryEntries,
  type RegistryEntry,
} from "../../../src/coms-protocol/index.js";
import {
  listUnreported,
  markReported,
  exchangesDir,
  type ExchangeRecord,
} from "./exchanges.js";

interface HookInput {
  hook_event_name?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(""));
  });
}

function truncate(s: string, max: number): string {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/**
 * Keep this compact. It lands in the session's context on every turn where
 * traffic occurred, so it summarises and points at the log rather than
 * reproducing whole conversations.
 */
function render(entries: ExchangeRecord[], logDir: string): string {
  const lines = [
    entries.length === 1
      ? "Agent coms: 1 message was answered automatically since your last turn."
      : `Agent coms: ${entries.length} messages were answered automatically since your last turn.`,
    "",
  ];
  for (const e of entries) {
    const status =
      e.delivery === "delivered"
        ? `${e.elapsed_ms ?? "?"}ms`
        : `${e.delivery}${e.error ? `: ${truncate(e.error, 80)}` : ""}`;
    lines.push(`• from ${e.sender_name || "(unnamed)"} [${e.msg_id}] (${status})`);
    lines.push(`    asked:   ${truncate(e.prompt, 220)}`);
    lines.push(`    replied: ${truncate(e.response ?? "", 220)}`);
  }
  lines.push("");
  lines.push(
    `Full text: ${logDir}/exchanges.log (and one JSON record per msg_id alongside it). ` +
      "This is a notification only — the replies have already been sent, and nothing is " +
      "expected of you. Mention it to the user only if it is relevant to what they are doing.",
  );
  return lines.join("\n");
}

/**
 * Find our own registry entry, the way pool.ts does. Its presence is what
 * "coms is active" means: the listener has bound its socket and registered.
 * Absent that, `ident.name` is only the name we'd register under whenever the
 * listener does come up — reporting it as current would be a guess, not a
 * fact, so we say nothing rather than risk telling the session a name that
 * isn't actually live yet.
 */
function findSelf(
  comsDir: string,
  project: string,
  containerId: string,
): RegistryEntry | null {
  try {
    return (
      readAllRegistryEntries(comsDir, project).find(
        (e) => e.container_id === containerId,
      ) ?? null
    );
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: HookInput = {};
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    /* tolerate a malformed or empty payload */
  }
  const event = input.hook_event_name === "Stop" ? "Stop" : "UserPromptSubmit";

  const ident = resolveIdentity();
  const pending = listUnreported(ident.coms_dir, ident.container_id);
  const self = findSelf(ident.coms_dir, ident.project, ident.container_id);

  // Identity is reported only on UserPromptSubmit, not Stop. Originally this
  // ran on both, unconditionally, so it never went stale — but in practice
  // Stop can fire repeatedly with no new user input in between (e.g. a
  // multi-turn tool loop with nobody typing), and on Stop there is nothing
  // else to say, so every one of those turns was 100% identity-line noise.
  // UserPromptSubmit is the boundary that actually matters: it fires right
  // before I would next act on the name, which is the only time staleness
  // could cause a real mistake.
  const showIdentity = event === "UserPromptSubmit" && !!self;

  if (pending.length === 0 && !showIdentity) {
    process.stdout.write("{}");
    return;
  }

  const parts: string[] = [];
  if (showIdentity && self) {
    parts.push(`Your current coms identity: ${self.name}@${ident.project}`);
  }
  if (pending.length > 0) {
    parts.push(render(pending, exchangesDir(ident.coms_dir, ident.container_id)));
    for (const e of pending) {
      markReported(ident.coms_dir, ident.container_id, e.msg_id);
    }
  }

  // additionalContext only — deliberately no `decision`, so a turn is never
  // blocked or extended on account of peer chatter or identity bookkeeping.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: parts.join("\n\n"),
      },
    }),
  );
}

main().catch((err) => {
  // Never wedge the session on our account.
  console.error(`[coms-hook] ${(err as Error).message}`);
  process.stdout.write("{}");
  process.exit(0);
});
