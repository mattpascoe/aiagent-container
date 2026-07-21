/**
 * coms-protocol/transport.ts
 *
 * Low-level socket transport primitives shared by both adapters.
 *
 * Wire format reminder: newline-delimited JSON. One connection = one request
 * + one response frame (either an AckFrame/NackFrame or a PongFrame), then
 * the connection is closed by the receiver. Application-level responses to
 * prompts travel as a separate `response` envelope sent from receiver back
 * to sender (potentially much later).
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { AckFrame, NackFrame } from "./envelopes.js";

// ━━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Maximum size of a single envelope on the wire. Protects against a
 * misbehaving sender streaming gigabytes at us. 64 KiB matches disler's
 * `coms.ts` and is generous for any reasonable prompt or response.
 */
export const LINE_CAP_BYTES = 64 * 1024;

/**
 * How long to wait when probing a socket file for liveness before declaring
 * it stale. 250ms matches disler's `coms.ts`.
 */
const STALE_PROBE_TIMEOUT_MS = 250;

/**
 * Default connect timeout when dialing a peer. If a peer is on a different
 * container that's been killed, the UDS connect itself usually fails fast
 * (ENOENT), but on rare filesystems it can hang. 2s is a safety net.
 */
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;

// ━━━ Reader: pull exactly one newline-terminated line from a socket ━━━━━━━━

/**
 * Resolves to the first complete line (without the trailing newline) read
 * from `socket`. Rejects if the connection closes before a newline arrives,
 * or if the accumulated buffer exceeds `LINE_CAP_BYTES`.
 *
 * The returned promise resolves exactly once. The caller is responsible
 * for closing the socket afterwards if needed.
 */
export function readOneLine(socket: net.Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		let settled = false;
		const onData = (chunk: Buffer) => {
			if (settled) return;
			buf += chunk.toString("utf-8");
			if (buf.length > LINE_CAP_BYTES) {
				settled = true;
				socket.removeListener("data", onData);
				reject(new Error("line too large"));
				return;
			}
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				settled = true;
				socket.removeListener("data", onData);
				resolve(buf.slice(0, nl));
			}
		};
		socket.on("data", onData);
		socket.once("error", (err) => {
			if (settled) return;
			settled = true;
			reject(err);
		});
		socket.once("close", () => {
			if (settled) return;
			settled = true;
			reject(new Error("connection closed before line received"));
		});
	});
}

// ━━━ Stale-socket probe ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Probes an existing socket file to determine whether it's still in use.
 *
 * Returns:
 *   - `"in_use"` if the file exists AND a connection succeeds (someone is
 *     listening on it right now)
 *   - `"stale"` if the file doesn't exist, the connection is refused, or
 *     the probe times out (the owning process has died but left the file
 *     behind — common after a hard kill)
 *
 * Used by `bindEndpoint` to decide whether to unlink an existing socket
 * file before binding. The 250ms timeout matters because if the owner is
 * in the middle of dying the kernel might take a moment to clean up.
 */
export function probeStaleSocket(endpoint: string): Promise<"in_use" | "stale"> {
	return new Promise((resolve) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const finish = (verdict: "in_use" | "stale") => {
			if (settled) return;
			settled = true;
			try {
				sock.destroy();
			} catch {
				/* ignore */
			}
			resolve(verdict);
		};
		const timer = setTimeout(() => finish("stale"), STALE_PROBE_TIMEOUT_MS);
		sock.once("connect", () => {
			clearTimeout(timer);
			finish("in_use");
		});
		sock.once("error", (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			if (err && err.code === "ECONNREFUSED") {
				finish("stale");
			} else {
				// ENOENT or other — treat as stale (file may be gone or unusable)
				finish("stale");
			}
		});
	});
}

// ━━━ Bind: create a listening Unix socket at `endpoint` ━━━━━━━━━━━━━━━━━━━━

/**
 * Binds `endpoint` as a Unix domain socket (or named pipe on Windows) and
 * invokes `connHandler` for each incoming connection.
 *
 * If the file already exists, probes it first:
 *   - "in_use" → rejects with a descriptive error (someone else owns it)
 *   - "stale"  → unlinks the file and proceeds
 *
 * The handler is called per-connection and is expected to close the socket
 * itself. Use `connectionTracker` (optional) to register sockets if you
 * need to close them all on shutdown.
 */
export async function bindEndpoint(
	endpoint: string,
	connHandler: (socket: net.Socket) => void,
	connectionTracker?: ConnectionTracker,
): Promise<net.Server> {
	if (process.platform !== "win32" && fs.existsSync(endpoint)) {
		const verdict = await probeStaleSocket(endpoint);
		if (verdict === "in_use") {
			throw new Error(`coms: endpoint already in use (${endpoint})`);
		}
		try {
			fs.unlinkSync(endpoint);
		} catch {
			// best-effort
		}
	}

	// Ensure parent directory exists for the socket file
	try {
		fs.mkdirSync(path.dirname(endpoint), { recursive: true });
	} catch {
		// best-effort
	}

	return new Promise<net.Server>((resolve, reject) => {
		const server = net.createServer((socket) => {
			if (connectionTracker) connectionTracker.add(socket);
			socket.on("close", () => {
				if (connectionTracker) connectionTracker.delete(socket);
			});
			connHandler(socket);
		});
		server.once("error", reject);
		server.listen(endpoint, () => {
			server.removeListener("error", reject);
			resolve(server);
		});
	});
}

// ━━━ Send: dial a peer, write one envelope, read one reply ━━━━━━━━━━━━━━━━━

export interface SendOptions {
	connectTimeoutMs?: number;
}

/**
 * Connects to `endpoint`, writes `envelope` as a single JSON line, and
 * resolves with the receiver's reply (a single JSON frame).
 *
 * The reply can be:
 *   - an `ack` / `nack` frame (for prompt/response send confirmations)
 *   - a `pong` frame (for ping)
 *
 * For application-level responses to prompts, the receiver will *also*
 * open a separate connection back to us and send a `response` envelope —
 * this function does NOT wait for that. Use the registry + `pendingReplies`
 * pattern to correlate response envelopes with their request msg_ids.
 *
 * Rejects on:
 *   - connect timeout (`DEFAULT_CONNECT_TIMEOUT_MS`, overridable)
 *   - receiver nack (rejects with the nack's `error` string)
 *   - any socket/protocol error
 */
export function sendEnvelope<T = unknown>(
	endpoint: string,
	envelope: unknown,
	opts: SendOptions = {},
): Promise<T> {
	const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
	return new Promise((resolve, reject) => {
		const sock = net.createConnection({ path: endpoint });
		let settled = false;
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			try {
				sock.destroy();
			} catch {
				/* ignore */
			}
			reject(err);
		};

		const connectTimer = setTimeout(() => {
			fail(new Error(`connect timeout after ${connectTimeoutMs}ms (${endpoint})`));
		}, connectTimeoutMs);

		sock.once("error", fail);
		sock.once("connect", async () => {
			clearTimeout(connectTimer);
			try {
				sock.write(JSON.stringify(envelope) + "\n");
				const line = await readOneLine(sock);
				const parsed = JSON.parse(line) as { type?: string; error?: string };
				try {
					sock.end();
				} catch {
					/* ignore */
				}
				if (settled) return;
				settled = true;
				if (parsed && parsed.type === "nack") {
					reject(new Error(parsed.error || "nack"));
				} else {
					resolve(parsed as T);
				}
			} catch (err) {
				fail(err instanceof Error ? err : new Error(String(err)));
			}
		});
	});
}

// ━━━ Reply helpers: write an ack/nack and close ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function writeAck(socket: net.Socket, msgId: string): void {
	const frame: AckFrame = { type: "ack", msg_id: msgId };
	try {
		socket.write(JSON.stringify(frame) + "\n");
	} catch {
		/* ignore */
	}
	try {
		socket.end();
	} catch {
		/* ignore */
	}
}

export function writeNack(socket: net.Socket, msgId: string, error: string): void {
	const frame: NackFrame = { type: "nack", msg_id: msgId, error };
	try {
		socket.write(JSON.stringify(frame) + "\n");
	} catch {
		/* ignore */
	}
	try {
		socket.end();
	} catch {
		/* ignore */
	}
}

// ━━━ Connection tracker ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Lets a server register all accepted sockets so they can be force-closed
// on shutdown. Without this, in-flight connections can keep the event loop
// alive past the point where the agent wants to exit.

export class ConnectionTracker {
	private sockets = new Set<net.Socket>();

	add(socket: net.Socket): void {
		this.sockets.add(socket);
	}

	delete(socket: net.Socket): void {
		this.sockets.delete(socket);
	}

	destroyAll(): void {
		for (const s of this.sockets) {
			try {
				s.destroy();
			} catch {
				/* ignore */
			}
		}
		this.sockets.clear();
	}
}
