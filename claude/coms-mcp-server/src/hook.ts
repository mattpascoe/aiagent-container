#!/usr/bin/env node
/**
 * Claude Code hook: show the interactive session what peers have been asking,
 * and how the listener answered them.
 *
 * Inbound prompts are answered autonomously by the listener so peers never
 * wait on a human. This hook exists purely for visibility: at the next turn
 * boundary it reports exchanges the session hasn't seen yet.
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
  if (pending.length === 0) {
    process.stdout.write("{}");
    return;
  }

  const context = render(pending, exchangesDir(ident.coms_dir, ident.container_id));
  for (const e of pending) {
    markReported(ident.coms_dir, ident.container_id, e.msg_id);
  }

  // additionalContext only — deliberately no `decision`, so a turn is never
  // blocked or extended on account of peer chatter.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: context },
    }),
  );
}

main().catch((err) => {
  // Never wedge the session on our account.
  console.error(`[coms-hook] ${(err as Error).message}`);
  process.stdout.write("{}");
  process.exit(0);
});
