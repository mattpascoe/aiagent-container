/**
 * Tool implementations shared between the MCP server (outbound path)
 * and the listener (inbound answer path).
 *
 * These functions are pure of any Claude-specific concerns: they take a
 * resolved identity and a protocol-level transport and return
 * protocol-level results. The MCP server wraps them in tool schemas;
 * the listener calls them directly when answering an inbound prompt.
 *
 * NOTE: These implement a SIMPLER model than the Pi side because Claude
 * has no concept of an "in-process LLM" — every prompt sent via
 * `claude --print --resume` is a separate subprocess invocation. We
 * therefore:
 *   - Track our own "self" by container_id (same as Pi does)
 *   - Send a response back via a separate envelope (same wire format)
 *   - DLQ for offline peers (same)
 *   - The main difference: there's no "wait for agent_end" capture.
 *     The sender awaits a `response` envelope with matching msg_id.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ulid,
  readAllRegistryEntries,
  readAllRegistryEntriesAcrossProjects,
  pruneDeadEntries,
  pruneDeadEntriesAcrossProjects,
  resolveUniqueName,
  writeRegistryEntry,
  appendAudit,
  isEntryLive,
  registryFilePath,
  projectsRoot,
  sendEnvelope,
  writeToDLQ,
  writePendingSend,
  prunePendingSends,
  type RegistryEntry,
  type Envelope,
  type PromptEnvelope,
  type ResponseEnvelope,
  type PingEnvelope,
} from "../../../src/coms-protocol/index.js";
import { resolveSelf, type ResolvedIdentity } from "./identity.js";

export interface PeerView {
  name: string;
  container_id: string;
  session_id: string;
  model?: string;
  purpose: string;
  endpoint: string;
  color?: string;
  heartbeat_at: string;
  age_ms: number;
  live: boolean;
  project: string;
}

export interface ComsListResult {
  peers: PeerView[];
  count: number;
  project: string;
}

function viewEntry(e: RegistryEntry, project: string): PeerView {
  return {
    name: e.name,
    container_id: e.container_id,
    session_id: e.session_id,
    model: e.model || undefined,
    purpose: e.purpose,
    endpoint: e.endpoint,
    color: e.color || undefined,
    heartbeat_at: e.heartbeat_at,
    age_ms: Date.now() - new Date(e.heartbeat_at).getTime(),
    live: true, // by construction, since we just pruned dead entries
    project,
  };
}

export function listPeers(
  ident: ResolvedIdentity,
  opts: { project?: string; include_explicit?: boolean } = {},
): ComsListResult {
  const projectFilter = opts.project ?? ident.project;
  const includeExplicit = opts.include_explicit ?? false;
  const out: PeerView[] = [];

  if (projectFilter === "*") {
    pruneDeadEntriesAcrossProjects(ident.coms_dir, { staleMs: 30_000 });
    const projectsRootDir = projectsRoot(ident.coms_dir);
    let projects: string[];
    try {
      projects = fs.readdirSync(projectsRootDir);
    } catch {
      projects = [];
    }
    for (const p of projects) {
      const entries = readAllRegistryEntries(ident.coms_dir, p);
      for (const e of entries) {
        if (e.container_id === ident.container_id) continue;
        if (!includeExplicit && e.explicit) continue;
        out.push(viewEntry(e, p));
      }
    }
  } else {
    pruneDeadEntries(ident.coms_dir, projectFilter, { staleMs: 30_000 });
    const entries = readAllRegistryEntries(ident.coms_dir, projectFilter);
    for (const e of entries) {
      if (e.container_id === ident.container_id) continue;
      if (!includeExplicit && e.explicit) continue;
      out.push(viewEntry(e, projectFilter));
    }
  }
  return { peers: out, count: out.length, project: projectFilter };
}

export interface ComsSendResult {
  msg_id: string;
  target: string;
  target_container: string;
  hops: number;
  status: "delivered" | "queued" | "error";
  error?: string;
}

/**
 * Send a prompt to a named peer. If the peer's socket is unreachable,
 * the envelope is queued in their DLQ for delivery when they boot.
 */
export function sendPrompt(
  ident: ResolvedIdentity,
  targetName: string,
  prompt: string,
  opts: { project?: string; hops?: number; include_explicit?: boolean } = {},
): ComsSendResult {
  const projectFilter = opts.project ?? ident.project;
  const includeExplicit = opts.include_explicit ?? false;

  // Resolve target. Look across all projects if "*", else scope.
  //
  // Also capture our own entry here if this scan happens to pass through
  // ident.project (true whenever projectFilter is "*" or equals our own
  // project — i.e. almost always). That saves the separate full registry
  // scan resolveSelf() would otherwise do below for the same directory we
  // just read. Matched by name, same criterion resolveSelf() uses, so a
  // self-lookup this way is behaviorally identical to calling it directly.
  let candidates: { entry: RegistryEntry; project: string }[] = [];
  let selfEntry: RegistryEntry | undefined;
  if (projectFilter === "*") {
    const root = projectsRoot(ident.coms_dir);
    let projects: string[];
    try {
      projects = fs.readdirSync(root);
    } catch {
      projects = [];
    }
    for (const p of projects) {
      const entries = readAllRegistryEntries(ident.coms_dir, p);
      if (p === ident.project) {
        selfEntry = entries.find((e) => e.name === ident.name);
      }
      for (const e of entries) {
        if (e.name === targetName && (includeExplicit || !e.explicit)) {
          candidates.push({ entry: e, project: p });
        }
      }
    }
  } else {
    const entries = readAllRegistryEntries(ident.coms_dir, projectFilter);
    if (projectFilter === ident.project) {
      selfEntry = entries.find((e) => e.name === ident.name);
    }
    for (const e of entries) {
      if (e.name === targetName && (includeExplicit || !e.explicit)) {
        candidates.push({ entry: e, project: projectFilter });
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `no peer named "${targetName}" found in project "${projectFilter}"`,
    );
  }
  // Prefer the most-recent heartbeat.
  candidates.sort((a, b) => {
    return (
      new Date(b.entry.heartbeat_at).getTime() -
      new Date(a.entry.heartbeat_at).getTime()
    );
  });
  const { entry: target, project: targetProject } = candidates[0];

  const msg_id = ulid();
  const hops = opts.hops ?? 0;
  // Return address, taken from the entry our listener registered. Without
  // this the peer has nowhere to send its reply: it falls back to the DLQ
  // keyed on an empty target_session, which no drain can ever match.
  //
  // Only falls through to resolveSelf()'s own scan when the target lookup
  // above didn't happen to pass through ident.project — i.e. projectFilter
  // named some other specific project directly, not "*" and not ours.
  const self =
    selfEntry && selfEntry.session_id && selfEntry.endpoint
      ? { session_id: selfEntry.session_id, endpoint: selfEntry.endpoint }
      : resolveSelf(ident);
  if (!self) {
    throw new Error(
      `cannot send: no registry entry for "${ident.name}" in project "${ident.project}" — ` +
        `the inbound listener has not registered yet, so a reply could not be routed back`,
    );
  }
  const envelope: PromptEnvelope = {
    type: "prompt",
    msg_id,
    sender_session: self.session_id,
    sender_endpoint: self.endpoint,
    hops,
    timestamp: new Date().toISOString(),
    prompt,
    sender_name: ident.name,
    sender_cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
  };

  // Record that we're now waiting on a reply from this peer, so the (separate
  // process) status-line pool renderer can show it — see pool.ts. Written
  // regardless of delivered/queued outcome below: either way we're waiting.
  writePendingSend(ident.coms_dir, targetProject, {
    msg_id,
    sender_container_id: ident.container_id,
    sender_session_id: self.session_id,
    target_name: targetName,
    target_container_id: target.container_id,
    sent_at: envelope.timestamp,
  });
  prunePendingSends(ident.coms_dir, targetProject, 15 * 60 * 1000);

  const live = isEntryLiveFromEntry(target);
  if (!live) {
    return queuePromptDlq(ident, targetProject, target, envelope, "peer offline (heartbeat stale)");
  }
  // Try the live socket. sendEnvelope is async; fire-and-forget the wire
  // send, and return immediately with status: "delivered". If the actual
  // send fails, we audit a queued event so the operator can trace it.
  void sendEnvelope(target.endpoint, envelope, { connectTimeoutMs: 2000 }).then(
    () => {
      appendAudit(ident.coms_dir, {
        event: "outbound_prompt",
        msg_id,
        target: targetName,
        to_container: target.container_id,
        hops,
      });
    },
    (err: Error) => {
      appendAudit(ident.coms_dir, {
        event: "outbound_prompt_queued",
        msg_id,
        target: targetName,
        to_container: target.container_id,
        hops,
        reason: `send failed: ${err.message}`,
      });
      // Write to DLQ too so the listener can pick it up later.
      const dlqPath = path.join(
        ident.coms_dir,
        "projects",
        targetProject,
        "dlq",
        `${msg_id}.json`,
      );
      try {
        fs.mkdirSync(path.dirname(dlqPath), { recursive: true });
        fs.writeFileSync(dlqPath, JSON.stringify(envelope, null, 2));
      } catch {
        /* best-effort */
      }
    },
  );
  return {
    msg_id,
    target: targetName,
    target_container: target.container_id,
    hops,
    status: "delivered",
  };
}

function queuePromptDlq(
  ident: ResolvedIdentity,
  targetProject: string,
  target: RegistryEntry,
  envelope: PromptEnvelope,
  reason: string,
): ComsSendResult {
  const dlqPath = path.join(
    ident.coms_dir,
    "projects",
    targetProject,
    "dlq",
    `${envelope.msg_id}.json`,
  );
  fs.mkdirSync(path.dirname(dlqPath), { recursive: true });
  fs.writeFileSync(dlqPath, JSON.stringify(envelope, null, 2));
  appendAudit(ident.coms_dir, {
    event: "outbound_prompt_queued",
    msg_id: envelope.msg_id,
    target: target.name,
    to_container: target.container_id,
    hops: envelope.hops,
    reason,
  });
  return {
    msg_id: envelope.msg_id,
    target: target.name,
    target_container: target.container_id,
    hops: envelope.hops,
    status: "queued",
  };
}

function isEntryLiveFromEntry(entry: RegistryEntry): boolean {
  if (entry.heartbeat_at) {
    const t = Date.parse(entry.heartbeat_at);
    if (!Number.isNaN(t)) {
      return Date.now() - t <= 30_000;
    }
  }
  return false;
}

/**
 * Find the project a peer's registry file lives in (their `project` field
 * is implicit in the path). Used by the listener when it needs to write a
 * response back into a peer's DLQ.
 */
export function findProjectForPeer(
  comsDir: string,
  containerId: string,
  name: string,
): { project: string; entry: RegistryEntry } | null {
  const root = projectsRoot(comsDir);
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const p of projects) {
    const f = registryFilePath(comsDir, p, name);
    try {
      const raw = fs.readFileSync(f, "utf8");
      const parsed = JSON.parse(raw) as RegistryEntry;
      if (parsed.container_id === containerId) return { project: p, entry: parsed };
    } catch {
      continue;
    }
  }
  return null;
}
