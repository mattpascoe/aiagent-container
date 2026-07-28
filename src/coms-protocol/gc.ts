/**
 * coms-protocol/gc.ts
 *
 * Garbage collection for filesystem artifacts that outlive their owning
 * process: orphaned Unix domain sockets. Both adapters call this from their
 * own heartbeat/keepalive tick.
 *
 * How socket liveness is determined:
 *
 * A listener's session_id (and therefore its socket path) is a fresh ulid()
 * every process boot — old session_ids are never reused. A socket file that
 * nobody is touching anymore isn't "probably dead," it's permanently dead:
 * no future process will ever bind that exact path again. The only question
 * is how to *detect* "nobody is touching it anymore" without a false
 * positive against a listener that's still alive but whose heartbeat
 * happens to be running late.
 *
 * We deliberately do NOT cross-reference the live registry for this. The
 * registry is already pruned at HEARTBEAT_STALE_MS (30s) from several
 * unrelated call sites (coms_list, coms_send, ...) — coupling socket
 * liveness to "does a registry entry currently exist" means a single
 * stalled heartbeat write gets the registry entry reaped first, and a
 * socket sweep moments later would then delete the still-live socket out
 * from under a listener that was about to recover, turning a transient
 * hiccup into a dead peer. (Caught in design review before this was
 * written — see the coms-inner-followups doc.)
 *
 * Instead, each adapter's heartbeat tick calls `touchSocket()` on its own
 * endpoint every tick, independent of the registry write. A socket's own
 * mtime then IS the liveness signal, decoupled from the registry entirely.
 * bind() itself sets the initial mtime, so a socket that hasn't had its
 * first heartbeat tick yet (still well inside SOCKET_STALE_MS) is
 * automatically protected too — the same mechanism covers both the
 * boot-race window and steady-state liveness, with nothing extra to get
 * out of sync.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { socketsRoot } from "./identity.js";
import { HEARTBEAT_STALE_MS } from "./registry.js";

/**
 * How stale a socket's mtime must be before it's considered orphaned. 2x
 * HEARTBEAT_STALE_MS (30s): one stalled heartbeat tick doesn't trigger a
 * reap, several in a row — a genuinely dead process — does. Derived from
 * the same constant the registry's own staleness check uses, not a second
 * independent number, so the two "how long is too long" definitions in this
 * codebase can't silently drift apart.
 */
export const SOCKET_STALE_MS = HEARTBEAT_STALE_MS * 2;

/**
 * Best-effort mtime refresh. Logs (doesn't throw) on failure: a silent
 * failure here is dangerous, not harmless. If utimesSync starts failing for
 * some listener (permissions drift, bind-mount quirk, ENOSPC, ...), its
 * socket's mtime quietly stops advancing — a few ticks later that SAME
 * listener's own pruneStaleSockets call reaps its own live socket, with
 * nothing in any log explaining why. Visibility here is what turns that
 * into a diagnosable problem instead of a mystery.
 */
export function touchSocket(endpoint: string): void {
	try {
		const now = new Date();
		fs.utimesSync(endpoint, now, now);
	} catch (err) {
		// ENOENT (socket already cleaned up) is expected and not worth logging;
		// anything else means the liveness signal for this socket just stopped
		// working, which is exactly what an operator needs to know about.
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== "ENOENT") {
			console.error(`[gc] touchSocket(${endpoint}) failed: ${(err as Error).message}`);
		}
	}
}

export interface PruneStaleSocketsResult {
	reaped: number;
}

/**
 * Deletes `.sock` files whose mtime is older than `staleMs`, then removes
 * any per-container socket directory left empty by that sweep. Safe to call
 * redundantly from every listener's own heartbeat tick — it's purely a
 * directory walk plus mtime checks, no coordination between callers
 * required, same shape as the existing `pruneDeadEntriesAcrossProjects`.
 */
export function pruneStaleSockets(
	comsDir: string,
	opts: { staleMs?: number } = {},
): PruneStaleSocketsResult {
	const staleMs = opts.staleMs ?? SOCKET_STALE_MS;
	const root = socketsRoot(comsDir);
	let containerDirs: string[];
	try {
		containerDirs = fs.readdirSync(root);
	} catch {
		return { reaped: 0 };
	}
	const now = Date.now();
	let reaped = 0;
	for (const containerId of containerDirs) {
		const dir = path.join(root, containerId);
		let files: string[];
		try {
			files = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith(".sock")) continue;
			const full = path.join(dir, f);
			try {
				const stat = fs.statSync(full);
				if (now - stat.mtimeMs > staleMs) {
					// unlinkSync on a still-bound UDS is "safe but misleading": the
					// bound inode keeps serving any fds the listener already
					// accepted, but the path is gone, so new peers silently can't
					// connect. The mtime check above is the only thing standing
					// between a correct reap and this — don't shorten SOCKET_STALE_MS
					// "for performance" without re-deriving that this can't fire on
					// a socket whose owner is merely a few ticks late.
					fs.unlinkSync(full);
					reaped++;
				}
			} catch {
				/* gone already, or a transient stat failure — next tick retries */
			}
		}
		// Unlink first, rmdir second, both best-effort: if a new listener binds
		// into this exact directory between the two calls, rmdir just fails
		// (ENOTEMPTY) and the next tick tries again. Not worth making atomic —
		// the directory reappearing on the next bind() is harmless.
		try {
			fs.rmdirSync(dir);
		} catch {
			/* not empty, or already gone — fine either way */
		}
	}
	return { reaped };
}
