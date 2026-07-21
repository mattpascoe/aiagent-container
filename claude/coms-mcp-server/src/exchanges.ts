/**
 * Exchange log: a durable record of every inbound prompt answered on this
 * container's behalf, and what was sent back.
 *
 * Inbound prompts are answered autonomously by a headless `claude --print`
 * invocation so peers get a reply with no human in the loop. The cost of that
 * autonomy is opacity — the interactive session never sees the exchange. This
 * module buys the visibility back: every prompt and reply is written to disk
 * as it happens, and a hook surfaces a digest at the next turn boundary.
 *
 * Writing to disk is the primary channel and injection is the bonus, in that
 * order deliberately. Hooks only fire at turn boundaries, so a log that
 * depended on them would go blind exactly when the session is idle — which is
 * when unattended peer traffic is most likely.
 *
 * Layout: <coms_dir>/exchanges/<container_id>/<msg_id>.json
 * Keyed by container_id because the listener writes these and the MCP server
 * and hook read them, and each of the three has its own session id.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface ExchangeRecord {
  msg_id: string;
  sender_name: string;
  sender_session: string;
  sender_endpoint: string;
  hops: number;
  prompt: string;
  /** Null while the headless agent is still working. */
  response: string | null;
  error: string | null;
  received_at: string;
  answered_at: string | null;
  elapsed_ms: number | null;
  delivery: "pending" | "delivered" | "queued" | "failed";
  /** Set once a hook has shown this to the interactive session. */
  reported_at: string | null;
}

export function exchangesDir(comsDir: string, containerId: string): string {
  return path.join(comsDir, "exchanges", containerId);
}

function recordPath(comsDir: string, containerId: string, msgId: string): string {
  return path.join(exchangesDir(comsDir, containerId), `${msgId}.json`);
}

export function writeExchange(
  comsDir: string,
  containerId: string,
  rec: ExchangeRecord,
): void {
  const dir = exchangesDir(comsDir, containerId);
  fs.mkdirSync(dir, { recursive: true });
  const final = recordPath(comsDir, containerId, rec.msg_id);
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, final);
}

export function readExchange(
  comsDir: string,
  containerId: string,
  msgId: string,
): ExchangeRecord | null {
  try {
    return JSON.parse(
      fs.readFileSync(recordPath(comsDir, containerId, msgId), "utf8"),
    ) as ExchangeRecord;
  } catch {
    return null;
  }
}

/** All recorded exchanges, oldest first. */
export function listExchanges(
  comsDir: string,
  containerId: string,
): ExchangeRecord[] {
  let files: string[];
  try {
    files = fs
      .readdirSync(exchangesDir(comsDir, containerId))
      .filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ExchangeRecord[] = [];
  for (const f of files) {
    try {
      out.push(
        JSON.parse(
          fs.readFileSync(path.join(exchangesDir(comsDir, containerId), f), "utf8"),
        ) as ExchangeRecord,
      );
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => a.received_at.localeCompare(b.received_at));
  return out;
}

/** Completed exchanges no hook has surfaced yet. */
export function listUnreported(
  comsDir: string,
  containerId: string,
): ExchangeRecord[] {
  return listExchanges(comsDir, containerId).filter(
    (e) => e.reported_at === null && e.answered_at !== null,
  );
}

export function markReported(
  comsDir: string,
  containerId: string,
  msgId: string,
): void {
  const rec = readExchange(comsDir, containerId, msgId);
  if (!rec) return;
  rec.reported_at = new Date().toISOString();
  writeExchange(comsDir, containerId, rec);
}

/**
 * Delete records older than maxAgeMs. Called on listener boot so the directory
 * doesn't grow without bound; the log is for recent visibility, not an archive.
 */
export function pruneExchanges(
  comsDir: string,
  containerId: string,
  maxAgeMs: number,
): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const rec of listExchanges(comsDir, containerId)) {
    if (new Date(rec.received_at).getTime() >= cutoff) continue;
    try {
      fs.unlinkSync(recordPath(comsDir, containerId, rec.msg_id));
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Append a human-readable line to a tailable log. Separate from the JSON
 * records so an operator can `tail -f` one file and watch traffic live.
 */
export function appendExchangeLog(
  comsDir: string,
  containerId: string,
  line: string,
): void {
  try {
    const dir = exchangesDir(comsDir, containerId);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "exchanges.log"),
      `[${new Date().toISOString()}] ${line}\n`,
    );
  } catch {
    /* best-effort */
  }
}
