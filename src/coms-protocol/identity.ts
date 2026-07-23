/**
 * coms-protocol/identity.ts
 *
 * Identity helpers shared by both adapters. Generates session IDs, resolves
 * container IDs, and computes socket paths.
 *
 * Importing this module has no side effects — all functions are pure.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generates a ULID (sortable, 26-char Crockford base32).
 * Lexicographically sortable by the time component (first 10 chars), then
 * 16 chars of randomness. Good enough for unique session identifiers across
 * containers — collision odds are negligible.
 */
export function ulid(): string {
	const time = Date.now();
	const rand = crypto.randomBytes(10);
	let timeStr = "";
	let t = time;
	for (let i = 9; i >= 0; i--) {
		timeStr = CROCKFORD[t % 32] + timeStr;
		t = Math.floor(t / 32);
	}
	let randStr = "";
	let bits = 0;
	let value = 0;
	for (const byte of rand) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			randStr += CROCKFORD[(value >> bits) & 31];
		}
	}
	return (timeStr + randStr).slice(0, 26);
}

/**
 * Resolves the container ID for this process.
 *
 * Priority:
 *   1. `CONTAINER_ID` env var (lets compose.yaml inject an explicit value)
 *   2. `HOSTNAME` env var (Docker sets this to the short container ID by
 *      default — 12 hex chars)
 *   3. `os.hostname()` as a final fallback (covers non-Docker runs and dev)
 *
 * Note: `HOSTNAME` is set inside every Docker container, so option 2 is the
 * common case. Option 1 is for explicit override (e.g. when running two
 * agents inside one container for testing).
 */
export function resolveContainerId(): string {
	return (
		process.env.CONTAINER_ID ||
		process.env.HOSTNAME ||
		os.hostname() ||
		"unknown"
	);
}

/**
 * Resolves the shared coms directory.
 *
 * Priority:
 *   1. `COMS_DIR` env var (set in compose.yaml; takes precedence)
 *   2. `~/.agentharness-coms` on the host (mounted into containers)
 *
 * Inside containers, `COMS_DIR` should always be set so we don't depend on
 * `$HOME` being correct (Hermes runs as root with HOME=/root; Pi runs as
 * node with HOME=/home/node).
 */
export function resolveComsDir(): string {
	if (process.env.COMS_DIR && process.env.COMS_DIR.length > 0) {
		return process.env.COMS_DIR;
	}
	return path.join(os.homedir(), ".agentharness-coms");
}

/**
 * Computes the absolute socket path for a given session.
 *
 * Format: `<COMS_DIR>/sockets/<container_id>/<session_id>.sock`
 *
 * Namespacing by `container_id` guarantees that even if two containers
 * somehow minted the same ULID, their socket files would not collide. The
 * directory layout is one level deep — `<container_id>/<session_id>.sock` —
 * which keeps `ls` of the sockets dir readable when many containers are
 * active.
 *
 * On Windows we use named pipes (`\\.\pipe\pi-coms-<sid>`) since Unix
 * domain sockets aren't natively supported. Windows containers are out of
 * scope for v1; this branch exists for completeness so the codebase
 * doesn't break if someone runs it locally on Windows.
 */
export function makeEndpoint(comsDir: string, containerId: string, sessionId: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\pi-coms-${sessionId}`;
	}
	return path.join(comsDir, "sockets", containerId, `${sessionId}.sock`);
}

/**
 * Computes the registry file path for a given (project, name) pair.
 *
 * Format: `<COMS_DIR>/projects/<project>/agents/<name>.json`
 */
export function registryFilePath(comsDir: string, project: string, name: string): string {
	return path.join(comsDir, "projects", project, "agents", `${name}.json`);
}

/**
 * Computes the registry directory for a project.
 */
export function projectAgentsDir(comsDir: string, project: string): string {
	return path.join(comsDir, "projects", project, "agents");
}

/**
 * Computes the projects root directory.
 */
export function projectsRoot(comsDir: string): string {
	return path.join(comsDir, "projects");
}

/**
 * Computes the dead-letter queue directory for a project. If a sender
 * cannot reach a receiver when delivering a response, the response is
 * stashed here so `coms_get` can pick it up later.
 */
export function dlqDir(comsDir: string, project: string): string {
	return path.join(comsDir, "projects", project, "dlq");
}

/**
 * Computes the pending-sends directory for a project — one file per
 * in-flight outbound send, keyed by msg_id. See `PendingSendEntry`.
 */
export function pendingSendsDir(comsDir: string, project: string): string {
	return path.join(comsDir, "projects", project, "pending");
}

/**
 * Computes the audit log path (shared, append-only JSONL).
 */
export function auditLogPath(comsDir: string): string {
	return path.join(comsDir, "audit.log");
}

/**
 * Computes the logs directory (for adapter-internal logs, distinct from
 * the shared audit log).
 */
export function logsDir(comsDir: string): string {
	return path.join(comsDir, "logs");
}

/**
 * Resolves a project name from the current working directory if not set
 * explicitly. Falls back to "default" if cwd is unavailable.
 *
 * Two agents launched from `/workspace` automatically join the same pool
 * because they derive the same project name (`workspace`). Use the
 * `--project` CLI flag to override.
 */
export function defaultProjectFromCwd(cwd?: string): string {
	const dir = cwd || process.cwd() || "";
	const base = path.basename(dir);
	if (!base || base === "/" || base === ".") return "default";
	// Sanitize: project names become directory names, so no slashes/colons
	return base.replace(/[/\\:]+/g, "_");
}
