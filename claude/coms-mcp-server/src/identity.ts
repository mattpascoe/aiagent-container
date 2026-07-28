/**
 * Claude-specific identity and session persistence.
 *
 * The shared protocol module gives us container_id, project, coms_dir.
 * This module adds:
 *   - Persistent Claude session_id (so `--resume` works across inbound prompts)
 *   - Display name resolution (`--cname` from env or registry)
 *   - Path to the on-disk session file
 *
 * Storage layout:
 *   <COMS_DIR>/sessions/<container_id>/claude-session.json
 *   {
 *     "claude_session_id": "abc-123-...",
 *     "name": "alice",
 *     "purpose": "...",
 *     "updated_at": "2026-..."
 *   }
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveContainerId,
  resolveComsDir,
  defaultProjectFromCwd,
  readAllRegistryEntries,
  sessionsRoot,
} from "../../../src/coms-protocol/index.js";

export interface ClaudeSessionRecord {
  claude_session_id: string;
  name: string;
  purpose: string;
  updated_at: string; // ISO
}

export interface ResolvedIdentity {
  container_id: string;
  coms_dir: string;
  project: string;
  name: string;
  purpose: string;
  model: string | undefined;
  explicit: boolean;
  color: string | undefined;
  session_record_path: string;
}

function readEnv(envName: string): string | undefined {
  const v = process.env[envName];
  return v && v.length > 0 ? v : undefined;
}

/** Fallback colour when none is configured. Peers render this in agent lists. */
const DEFAULT_COLOR = "#D97757";

/**
 * Best available name for the model this agent runs on.
 *
 * Unlike pi — which reads the live model id from its in-process context — we
 * have no running model to interrogate: the listener is a plain node process
 * and each answer is a separate `claude` subprocess.
 *
 * Best source, checked first: <coms_dir>/sessions/<container_id>/resolved_model.txt,
 * written by statusline.sh from `.model.id` on every invocation (refreshed
 * every ~5s and on every message). That JSON field is the one place Claude
 * Code exposes the actually-resolved model id — no hook but SessionStart ever
 * receives a `model` field, there's no $CLAUDE_MODEL env var, and
 * settings.json's "model" key is often just the bare alias the user typed at
 * the /model prompt (e.g. "sonnet"), not the resolved id. That mismatch is
 * exactly what produced "anthropic/sonnet" here while every peer configured
 * another way reported "anthropic/claude-sonnet-5".
 *
 * Falls back to ANTHROPIC_MODEL, then the settings.json alias, then
 * "unknown" — unchanged from before, for sessions where the status line
 * hasn't run yet (e.g. immediately at listener boot) or isn't configured.
 *
 * A bare alias is namespaced to `anthropic/<alias>` to match the
 * `vendor/model` convention peers already use.
 */
/**
 * Exported (not just used internally by resolveIdentity) so callers that
 * need a FRESH read — not the value cached in a long-lived ResolvedIdentity
 * — can call it directly. The listener is exactly such a caller: see the
 * comment at its `ident.model` usage for why.
 */
export function resolveModel(comsDir: string, containerId: string): string {
  let raw: string | undefined;
  try {
    raw = fs
      .readFileSync(
        path.join(comsDir, "sessions", containerId, "resolved_model.txt"),
        "utf8",
      )
      .trim();
    if (!raw) raw = undefined;
  } catch {
    /* status line hasn't written one yet — fall through */
  }
  raw ??= readEnv("ANTHROPIC_MODEL");
  if (!raw) {
    try {
      const home = process.env.HOME || os.homedir();
      const settings = JSON.parse(
        fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
      ) as { model?: unknown };
      if (typeof settings.model === "string" && settings.model.length > 0) {
        raw = settings.model;
      }
    } catch {
      /* no settings file, or unreadable — fall through */
    }
  }
  if (!raw) return "unknown";
  return raw.includes("/") ? raw : `anthropic/${raw}`;
}

/**
 * Read CLI args (e.g. `--cname=alice`) from process.argv.
 * Only used by the listener subcommand, not the MCP server.
 */
function readCliFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === `--${name}`) {
      const next = process.argv[i + 1];
      return next && !next.startsWith("--") ? next : "true";
    }
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

export function resolveIdentity(opts?: {
  project?: string;
  name?: string;
  purpose?: string;
  model?: string;
  explicit?: boolean;
  color?: string;
}): ResolvedIdentity {
  const container_id = resolveContainerId();
  const coms_dir = resolveComsDir();
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const project =
    opts?.project ??
    readCliFlag("project") ??
    readEnv("AGENTHARNESS_PROJECT") ??
    defaultProjectFromCwd(cwd);
  const name =
    opts?.name ??
    readCliFlag("cname") ??
    readEnv("AGENTHARNESS_CNAME") ??
    `claude-${container_id.slice(0, 6)}`;
  const purpose =
    opts?.purpose ??
    readCliFlag("purpose") ??
    readEnv("AGENTHARNESS_PURPOSE") ??
    "";
  const model = opts?.model ?? resolveModel(coms_dir, container_id);
  const explicitFlag = readCliFlag("explicit");
  const explicit =
    opts?.explicit ?? (explicitFlag === "true" || explicitFlag === "");
  // Always resolve to a real colour. Publishing "" is worse than publishing a
  // default: peers that don't guard against the empty string render garbage
  // from it, which is exactly the NaN-colour bug the pi side had to fix.
  const color =
    opts?.color ??
    readCliFlag("color") ??
    readEnv("AGENTHARNESS_COLOR") ??
    DEFAULT_COLOR;
  const session_record_path = path.join(
    sessionsRoot(coms_dir),
    container_id,
    "claude-session.json",
  );
  return {
    container_id,
    coms_dir,
    project,
    name,
    purpose,
    model,
    explicit,
    color,
    session_record_path,
  };
}

export interface SelfEndpoint {
  session_id: string;
  endpoint: string;
}

/**
 * Look up the registry entry the *listener* process wrote for us.
 *
 * The MCP server and the listener are separate processes (see the server.ts
 * header) but share one identity. The listener owns the UDS and registers
 * `<project>/agents/<name>.json`; we borrow its session_id and endpoint so
 * that (a) outbound envelopes carry a return address peers can actually
 * reach, and (b) DLQ drains match what peers addressed to us.
 *
 * Never mint our own id here. A locally-generated session_id is one no peer
 * has ever seen, so replies addressed to us would never match it.
 *
 * Resolved on every call rather than cached at boot: the listener may
 * register after we start, and it rewrites the entry on each heartbeat.
 * Returns null if the listener has not registered yet.
 */
export function resolveSelf(ident: ResolvedIdentity): SelfEndpoint | null {
  try {
    const mine = readAllRegistryEntries(ident.coms_dir, ident.project).find(
      (e) => e.name === ident.name,
    );
    if (!mine?.session_id || !mine.endpoint) return null;
    return { session_id: mine.session_id, endpoint: mine.endpoint };
  } catch {
    return null;
  }
}

export function loadSessionRecord(
  session_record_path: string,
  fallback: { name: string; purpose: string },
): ClaudeSessionRecord {
  try {
    const raw = fs.readFileSync(session_record_path, "utf8");
    const parsed = JSON.parse(raw) as ClaudeSessionRecord;
    return parsed;
  } catch {
    return {
      claude_session_id: "",
      name: fallback.name,
      purpose: fallback.purpose,
      updated_at: new Date(0).toISOString(),
    };
  }
}

export function saveSessionRecord(
  session_record_path: string,
  rec: ClaudeSessionRecord,
): void {
  fs.mkdirSync(path.dirname(session_record_path), { recursive: true });
  const tmp = `${session_record_path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, session_record_path);
}
