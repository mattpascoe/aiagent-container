/**
 * coms-protocol/envelopes.ts
 *
 * Wire-protocol type definitions for the agent-to-agent communication layer.
 *
 * Used by:
 *   - pi/extensions/coms-inner/index.ts     (Pi adapter, runs inside the pi process)
 *   - claude/coms-mcp-server/src/*.ts       (Claude adapter, MCP server + listener)
 *
 * Wire format: newline-delimited JSON over a Unix domain socket (or named pipe
 * on Windows). Every connection is exactly one request + one response, then
 * closed. There is no persistent streaming in v1.
 *
 * Cross-container note: this protocol is container-agnostic. Both adapters
 * share `<COMS_DIR>` (typically `~/.agentharness-coms`) as a bind-mounted
 * host volume. Sockets live at
 * `<COMS_DIR>/sockets/<container_id>/<session_id>.sock`. Liveness is determined
 * by registry entry mtime + `heartbeat_at`, NOT by `process.kill(pid, 0)`
 * (which fails across PID namespaces).
 */

// ━━━ Envelope types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type EnvelopeType = "prompt" | "response" | "ping";

/**
 * Common envelope header. Every message on the wire carries these fields.
 *
 * `msg_id` is a ULID. Senders use it to correlate a `prompt` with its
 * matching `response`. Receivers echo it back in `response` envelopes.
 *
 * `hops` is incremented by each forwarder. `MAX_HOPS` (5) prevents runaway
 * A→B→A→B loops. The receiver of a `prompt` decrements nothing — it only
 * rejects if `hops >= MAX_HOPS`.
 */
export interface Envelope {
	type: EnvelopeType;
	msg_id: string;
	sender_session: string;
	sender_endpoint: string;
	hops: number;
	timestamp: string; // ISO 8601
}

export interface PromptEnvelope extends Envelope {
	type: "prompt";
	prompt: string;
	sender_name: string;
	sender_cwd: string;
	conversation_id?: string | null;
	/** Optional JSON schema the receiver should structure its response against. */
	response_schema?: Record<string, unknown> | null;
}

export interface ResponseEnvelope extends Envelope {
	type: "response";
	response: unknown;
	error?: string | null;
}

export interface PingEnvelope extends Envelope {
	type: "ping";
}

// ━━━ Acknowledgement frames ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// After every request envelope, the receiver replies with exactly one of these
// before closing the connection. This is the receiver's *transport-level*
// acknowledgement ("I got it, here is whether I'll try to handle it"). The
// *application-level* response (the answer to a prompt) arrives later as a
// separate `response` envelope sent from receiver back to sender.

export interface AckFrame {
	type: "ack";
	msg_id: string;
}

export interface NackFrame {
	type: "nack";
	msg_id: string;
	error: string;
}

// ━━━ Pong frame (response to a `ping`) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface AgentCard {
	name: string;
	purpose: string;
	model: string;
	color: string;
	// Optional: not every adapter can observe its own context usage. Pi reads
	// it in-process from the harness; the Claude adapter answers each prompt in
	// a separate stateless subprocess, so no such number exists for it.
	//
	// Omit when unknown — do NOT send 0, which reads as "idle" rather than
	// "unknown". Receivers must guard with `!= null` (not truthiness, so a real
	// 0 still displays) and apply their own fallback. See "Optional fields" in
	// this module's README.
	context_used_pct?: number;
	queue_depth: number;
}

export interface PongFrame {
	type: "pong";
	msg_id: string;
	agent_card: AgentCard;
}

// ━━━ Registry entry (filesystem, NOT on the wire) ━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Each agent writes one of these into
// `<COMS_DIR>/projects/<project>/agents/<name>.json` on session start and
// rewrites it on every heartbeat tick (every 10s by default).
//
// `pid` is informational only (helps a human looking at the file). Do NOT
// use it for liveness checks across containers — use `heartbeat_at` and/or
// file mtime instead.

export interface RegistryEntry {
	session_id: string;
	name: string;
	purpose: string;
	model: string;
	color: string;
	pid: number;
	endpoint: string; // absolute socket path
	cwd: string;
	started_at: string; // ISO 8601
	explicit: boolean;
	version: number;

	// Cross-container awareness (new vs disler's coms.ts)
	container_id: string; // typically os.hostname()
	transport: "uds"; // future-proof for coms-net style http transport

	// Heartbeat-based liveness (new vs disler's coms.ts)
	heartbeat_at: string; // ISO 8601; refreshed every heartbeat tick
	context_used_pct?: number; // live snapshot, optional for back-compat
	queue_depth?: number; // live snapshot
}

// ━━━ Shared audit log line shape ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Both adapters append one JSON line per notable event to
// `<COMS_DIR>/audit.log`. We deliberately keep this append-only and never
// include prompt bodies (PII concern). msg_id + sender + hops is enough to
// reconstruct the conversation graph if you ever need to.

export type AuditEvent =
	// Core lifecycle (both adapters)
	| { event: "boot"; session_id: string; name: string; project: string; container_id: string }
	| { event: "shutdown"; session_id: string; reason: string }
	| { event: "mcp_boot"; session_id: string; name: string; project: string; container_id: string; pid?: number }
	| { event: "mcp_shutdown"; session_id: string; reason: string }
	// Registry
	| { event: "registry_write"; session_id: string; path: string; reason: string }
	| { event: "self_heal"; session_id: string; reason: string }
	| { event: "name_collision"; desired: string; assigned: string; project: string }
	// Wire events
	| { event: "inbound_prompt"; msg_id: string; sender: string; hops: number; from_container: string; from_session?: string }
	| { event: "outbound_prompt"; msg_id: string; target: string; to_container: string; hops: number }
	| { event: "outbound_prompt_queued"; msg_id: string; target: string; to_container: string; hops: number; reason: string }
	| { event: "outbound_response"; msg_id: string; target: string; to_container: string; in_reply_to?: string; elapsed_ms?: number }
	| { event: "outbound_response_queued"; msg_id: string; in_reply_to: string; target: string; to_container: string; reason: string }
	| { event: "orphan_response"; msg_id: string }
	| { event: "hops_exceeded"; msg_id: string; hops: number }
	| { event: "listener_error"; msg_id: string; error: string }
	| { event: "inbound_prompt_dlq"; msg_id: string; from: string; from_container: string }
	// DLQ
	| { event: "dlq_write"; msg_id: string; reason: string }
	| { event: "dlq_drain"; msg_id: string; status: "delivered" | "expired" }
	// Listener lifecycle
	| { event: "listener_spawn"; session_id: string; pid: number; command: string }
	| { event: "listener_exit"; session_id: string; code: number | null; signal: string | null }
	// Misc
	| { event: string; [k: string]: unknown };

// ━━━ Type guards ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function isValidEnvelope(obj: unknown): obj is Envelope {
	if (!obj || typeof obj !== "object") return false;
	const e = obj as Record<string, unknown>;
	return (
		typeof e.type === "string" &&
		(e.type === "prompt" || e.type === "response" || e.type === "ping") &&
		typeof e.msg_id === "string" &&
		typeof e.sender_session === "string" &&
		typeof e.sender_endpoint === "string" &&
		typeof e.hops === "number" &&
		typeof e.timestamp === "string"
	);
}

export function isPromptEnvelope(obj: unknown): obj is PromptEnvelope {
	return isValidEnvelope(obj) && obj.type === "prompt";
}

export function isResponseEnvelope(obj: unknown): obj is ResponseEnvelope {
	return isValidEnvelope(obj) && obj.type === "response";
}

export function isPingEnvelope(obj: unknown): obj is PingEnvelope {
	return isValidEnvelope(obj) && obj.type === "ping";
}
