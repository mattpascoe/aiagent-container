/**
 * coms-protocol/registry.ts
 *
 * Registry I/O shared by both adapters. Each agent writes one
 * `RegistryEntry` JSON file at
 * `<COMS_DIR>/projects/<project>/agents/<name>.json` and rewrites it on
 * every heartbeat tick.
 *
 * Cross-container note: liveness is determined by
 *   1. `heartbeat_at` (ISO 8601 timestamp) — primary
 *   2. file mtime — fallback / double-check
 *
 * We deliberately do NOT use `process.kill(pid, 0)` because PIDs are
 * container-local. A Pi agent in container A with PID 4242 is invisible
 * to a Claude agent in container B; sending signal 0 to PID 4242 from
 * container B would either hit container B's PID 4242 (different
 * process) or fail with ESRCH even when the Pi agent is healthy.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	RegistryEntry,
	PendingSendEntry,
} from "./envelopes.js";
import {
	dlqDir,
	pendingSendsDir,
	projectAgentsDir,
	projectsRoot,
	registryFilePath,
} from "./identity.js";

// ━━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * An entry whose heartbeat is older than this is considered dead and
 * pruned from the pool by `pruneDeadEntries`. Should be at least 3x the
 * heartbeat interval so a single missed tick doesn't kill a healthy peer.
 */
export const HEARTBEAT_STALE_MS = 30_000;

// ━━━ Atomic write ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Writes `entry` to its canonical registry path atomically:
 *   1. Write to `<final>.tmp`
 *   2. `rename()` over the final path
 *
 * This is the same pattern disler uses. The atomicity matters because
 * readers (`coms_list`) iterate the directory concurrently and we don't
 * want them to see a half-written file.
 *
 * Creates the parent directory tree if needed.
 */
export function writeRegistryAtomic(entry: RegistryEntry, comsDir: string): string {
	const final = registryFilePath(comsDir, entry.name ? entry.name : "_", "_"); // placeholder; replaced below
	// We need project + name to compute the final path. The RegistryEntry
	// doesn't carry project (it's implied by the directory layout), so the
	// caller is expected to compute it. Override below:
	const projectDir = projectAgentsDir(comsDir, deriveProjectFromEntry(entry, comsDir));
	fs.mkdirSync(projectDir, { recursive: true });
	const realFinal = path.join(projectDir, `${entry.name}.json`);
	const tmp = `${realFinal}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
	fs.renameSync(tmp, realFinal);
	return realFinal;
}

/**
 * Writes a registry entry to an explicit (project, name) pair. Preferred
 * over `writeRegistryAtomic` because it doesn't require reverse-deriving
 * the project from the entry.
 */
export function writeRegistryEntry(
	comsDir: string,
	project: string,
	entry: RegistryEntry,
): string {
	const dir = projectAgentsDir(comsDir, project);
	fs.mkdirSync(dir, { recursive: true });
	const final = path.join(dir, `${entry.name}.json`);
	const tmp = `${final}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
	fs.renameSync(tmp, final);
	return final;
}

/**
 * Reverse-derives which project an entry belongs to. Used by the generic
 * `writeRegistryAtomic` overload above. Walks the projects root and finds
 * the first directory containing a matching `name.json`. O(projects × names)
 * but only called on boot, not in the hot path.
 */
function deriveProjectFromEntry(entry: RegistryEntry, comsDir: string): string {
	const root = projectsRoot(comsDir);
	let projects: string[];
	try {
		projects = fs.readdirSync(root);
	} catch {
		return "default";
	}
	for (const p of projects) {
		const candidate = path.join(root, p, "agents", `${entry.name}.json`);
		try {
			if (fs.statSync(candidate).isFile()) {
				// Verify it's the same session
				const raw = fs.readFileSync(candidate, "utf-8");
				const parsed = JSON.parse(raw) as RegistryEntry;
				if (parsed.session_id === entry.session_id) return p;
			}
		} catch {
			continue;
		}
	}
	return "default";
}

// ━━━ Read ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Reads all registry entries in a given project. Skips malformed files
 * silently (they might be mid-write). Returns entries with the `project`
 * field populated for convenience — callers don't need to remember which
 * project they asked for.
 */
export function readAllRegistryEntries(comsDir: string, project: string): RegistryEntry[] {
	const dir = projectAgentsDir(comsDir, project);
	if (!fs.existsSync(dir)) return [];
	const out: RegistryEntry[] = [];
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		try {
			const raw = fs.readFileSync(path.join(dir, f), "utf-8");
			const parsed = JSON.parse(raw) as RegistryEntry;
			if (parsed && typeof parsed.session_id === "string") {
				out.push(parsed);
			}
		} catch {
			// skip malformed
		}
	}
	return out;
}

/**
 * Reads all registry entries across all projects. Used by `coms_list`
 * when no project filter is set.
 */
export function readAllRegistryEntriesAcrossProjects(comsDir: string): RegistryEntry[] {
	const root = projectsRoot(comsDir);
	let projects: string[];
	try {
		projects = fs.readdirSync(root);
	} catch {
		return [];
	}
	const out: RegistryEntry[] = [];
	for (const p of projects) {
		try {
			if (!fs.statSync(path.join(root, p)).isDirectory()) continue;
		} catch {
			continue;
		}
		out.push(...readAllRegistryEntries(comsDir, p));
	}
	return out;
}

// ━━━ Remove ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Best-effort unlink of a registry file. Silent on ENOENT.
 */
export function removeRegistryEntry(comsDir: string, project: string, name: string): void {
	try {
		fs.unlinkSync(registryFilePath(comsDir, project, name));
	} catch {
		/* best-effort */
	}
}

// ━━━ Liveness: heartbeat-based pruning ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface LivenessCheckOptions {
	nowMs?: number;
	staleMs?: number;
}

/**
 * Returns true if the entry's heartbeat is fresh. An entry is "alive" if:
 *   1. `heartbeat_at` parses as a date and is within `staleMs` of `nowMs`, OR
 *   2. `heartbeat_at` is missing (older entry, pre-heartbeat) but the file
 *      mtime is within `staleMs` of `nowMs`.
 *
 * Why both? Older entries written before the heartbeat field was added
 * still need to be considered. New entries always have a fresh
 * `heartbeat_at` because the heartbeat interval (10s) is well below
 * `staleMs` (30s).
 */
export function isEntryLive(
	entry: RegistryEntry,
	filePath: string,
	opts: LivenessCheckOptions = {},
): boolean {
	const nowMs = opts.nowMs ?? Date.now();
	const staleMs = opts.staleMs ?? HEARTBEAT_STALE_MS;

	if (entry.heartbeat_at) {
		const t = Date.parse(entry.heartbeat_at);
		if (!Number.isNaN(t)) {
			return nowMs - t <= staleMs;
		}
	}

	// Fallback to mtime
	try {
		const stat = fs.statSync(filePath);
		return nowMs - stat.mtimeMs <= staleMs;
	} catch {
		return false;
	}
}

/**
 * Reads all entries in a project, removes the dead ones, and returns the
 * live set. Idempotent — safe to call repeatedly.
 */
export function pruneDeadEntries(
	comsDir: string,
	project: string,
	opts: LivenessCheckOptions = {},
): RegistryEntry[] {
	const dir = projectAgentsDir(comsDir, project);
	if (!fs.existsSync(dir)) return [];
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	const live: RegistryEntry[] = [];
	for (const f of files) {
		const full = path.join(dir, f);
		try {
			const raw = fs.readFileSync(full, "utf-8");
			const parsed = JSON.parse(raw) as RegistryEntry;
			if (!parsed || typeof parsed.session_id !== "string") continue;
			if (isEntryLive(parsed, full, opts)) {
				live.push(parsed);
			} else {
				try {
					fs.unlinkSync(full);
				} catch {
					/* best-effort */
				}
			}
		} catch {
			// malformed — leave it alone, next read may rescue it
		}
	}
	return live;
}

export function pruneDeadEntriesAcrossProjects(
	comsDir: string,
	opts: LivenessCheckOptions = {},
): RegistryEntry[] {
	const root = projectsRoot(comsDir);
	let projects: string[];
	try {
		projects = fs.readdirSync(root);
	} catch {
		return [];
	}
	const out: RegistryEntry[] = [];
	for (const p of projects) {
		try {
			if (!fs.statSync(path.join(root, p)).isDirectory()) continue;
		} catch {
			continue;
		}
		out.push(...pruneDeadEntries(comsDir, p, opts));
	}
	return out;
}

// ━━━ Name collision resolution ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Returns a name that doesn't collide with any LIVE registered agent in
 * the given project. Stale entries are pruned first.
 *
 * If `desiredName` is taken, appends `-2`, `-3`, etc. This matches disler's
 * behavior exactly.
 */
export function resolveUniqueName(comsDir: string, project: string, desiredName: string): string {
	const liveEntries = pruneDeadEntries(comsDir, project);
	const liveNames = new Set(liveEntries.map((e) => e.name));
	if (!liveNames.has(desiredName)) return desiredName;
	let n = 2;
	while (liveNames.has(`${desiredName}${n}`)) n++;
	return `${desiredName}${n}`;
}

// ━━━ Dead-letter queue ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Used when a sender wants to deliver a `response` envelope back to an
// original requester but the requester's socket is unreachable. The
// response is stashed here; the requester's next `coms_get` call picks it
// up transparently.

export interface DLQEntry {
	msg_id: string;
	target_session: string;
	envelope: unknown; // the response envelope we'd have sent
	stored_at: string; // ISO 8601
	expires_at: string; // ISO 8601 — typically 24h after stored_at
}

export function writeToDLQ(comsDir: string, project: string, entry: DLQEntry): void {
	const dir = dlqDir(comsDir, project);
	fs.mkdirSync(dir, { recursive: true });
	const final = path.join(dir, `${entry.msg_id}.json`);
	const tmp = `${final}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
	fs.renameSync(tmp, final);
}

export function readFromDLQ(comsDir: string, project: string, msgId: string): DLQEntry | null {
	const final = path.join(dlqDir(comsDir, project), `${msgId}.json`);
	try {
		const raw = fs.readFileSync(final, "utf-8");
		return JSON.parse(raw) as DLQEntry;
	} catch {
		return null;
	}
}

export function deleteFromDLQ(comsDir: string, project: string, msgId: string): void {
	try {
		fs.unlinkSync(path.join(dlqDir(comsDir, project), `${msgId}.json`));
	} catch {
		/* best-effort */
	}
}

export function listDLQForSession(comsDir: string, project: string, sessionId: string): DLQEntry[] {
	const dir = dlqDir(comsDir, project);
	if (!fs.existsSync(dir)) return [];
	const out: DLQEntry[] = [];
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		try {
			const raw = fs.readFileSync(path.join(dir, f), "utf-8");
			const parsed = JSON.parse(raw) as DLQEntry;
			if (parsed.target_session === sessionId) out.push(parsed);
		} catch {
			/* skip */
		}
	}
	return out;
}

// ━━━ Pending sends ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// One file per in-flight outbound send, so the (separate-process) status-line
// renderer can tell "we're waiting on a reply from peer X" without any shared
// memory with the MCP server. See `PendingSendEntry` in envelopes.ts.

export function writePendingSend(comsDir: string, project: string, entry: PendingSendEntry): void {
	const dir = pendingSendsDir(comsDir, project);
	fs.mkdirSync(dir, { recursive: true });
	const final = path.join(dir, `${entry.msg_id}.json`);
	const tmp = `${final}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
	fs.renameSync(tmp, final);
}

/** Best-effort unlink. No-op if the msg_id has no pending record (e.g. it's a
 * reply to a prompt we answered, not one we sent). */
export function deletePendingSend(comsDir: string, project: string, msgId: string): void {
	if (!msgId) return;
	try {
		fs.unlinkSync(path.join(pendingSendsDir(comsDir, project), `${msgId}.json`));
	} catch {
		/* best-effort */
	}
}

export function readAllPendingSends(comsDir: string, project: string): PendingSendEntry[] {
	const dir = pendingSendsDir(comsDir, project);
	if (!fs.existsSync(dir)) return [];
	const out: PendingSendEntry[] = [];
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		try {
			const raw = fs.readFileSync(path.join(dir, f), "utf-8");
			const parsed = JSON.parse(raw) as PendingSendEntry;
			if (parsed && typeof parsed.msg_id === "string") out.push(parsed);
		} catch {
			/* skip malformed */
		}
	}
	return out;
}

/**
 * Deletes pending-send records older than `maxAgeMs`. Called opportunistically
 * from `sendPrompt()` so an agent that sends and then never checks again
 * doesn't leave a file behind forever. This is hygiene, not the correctness
 * guarantee — the renderer applies its own staleness cutoff too, since a file
 * can exist for up to one send-cycle before this prune next runs.
 */
export function prunePendingSends(comsDir: string, project: string, maxAgeMs: number): void {
	const dir = pendingSendsDir(comsDir, project);
	let files: string[];
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return;
	}
	const now = Date.now();
	for (const f of files) {
		const full = path.join(dir, f);
		try {
			const raw = fs.readFileSync(full, "utf-8");
			const parsed = JSON.parse(raw) as PendingSendEntry;
			const t = Date.parse(parsed.sent_at);
			if (Number.isNaN(t) || now - t > maxAgeMs) {
				fs.unlinkSync(full);
			}
		} catch {
			/* malformed or mid-write — leave it, next prune may rescue/remove it */
		}
	}
}
