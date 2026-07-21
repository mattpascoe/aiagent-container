/**
 * coms-inner — Pi adapter for cross-container agent communication
 *
 * Peer-to-peer messaging between AI coding agents across Docker containers
 * on the same host, sharing `~/.agentharness-coms` as a bind-mounted volume.
 *
 * Each agent listens on a unique Unix domain socket at
 * `<COMS_DIR>/sockets/<container_id>/<session_id>.sock`. Container ID is
 * taken from the `HOSTNAME` env var (Docker sets this to the short
 * container ID by default). This guarantees no two agents anywhere collide,
 * even across containers.
 *
 * Discovery: agents write `RegistryEntry` JSON files to
 * `<COMS_DIR>/projects/<project>/agents/<name>.json`. The project name
 * defaults to `basename $(pwd)` so two agents in the same workspace
 * auto-join the same pool; override with `--project`.
 *
 * Liveness: each agent rewrites its registry entry every 10s with a
 * fresh `heartbeat_at` timestamp. Readers treat entries as dead if the
 * heartbeat is older than 30s. This works across containers where
 * `process.kill(pid, 0)` would fail (each container has its own PID 1).
 *
 * Wire format: newline-delimited JSON over Unix domain sockets. One
 * connection = one envelope + one reply frame, then closed. The shared
 * protocol module (`src/coms-protocol/`) defines the envelope types.
 *
 * Tools exposed:
 *   - coms_list  — discover peers in the pool
 *   - coms_send  — send a prompt to a peer; returns msg_id
 *   - coms_get   — non-blocking poll on msg_id
 *   - coms_await — block until reply lands or timeout fires
 *
 * CLI flags:
 *   --cname <name>     Override agent name (default: frontmatter or auto)
 *   --purpose <text>   Override agent purpose (default: frontmatter)
 *   --project <name>   Project namespace (default: basename cwd)
 *   --color <#RRGGBB>  Agent color in pool widget (default: palette)
 *   --explicit         Hide this agent from auto-discovery
 *
 * Usage:
 *   pi -e /pi/agent/extensions/coms-inner \
 *      --cname alice --purpose "writes tests" --project demo
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
	Theme,
	AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	// Wire types
	Envelope,
	PromptEnvelope,
	ResponseEnvelope,
	PingEnvelope,
	PongFrame,
	AgentCard,
	RegistryEntry,
	// Identity / paths
	ulid,
	resolveContainerId,
	resolveComsDir,
	defaultProjectFromCwd,
	makeEndpoint,
	registryFilePath,
	projectAgentsDir,
	projectsRoot,
	// Transport
	bindEndpoint,
	readOneLine,
	sendEnvelope,
	writeAck,
	writeNack,
	ConnectionTracker,
	// Registry
	writeRegistryEntry,
	readAllRegistryEntries,
	readAllRegistryEntriesAcrossProjects,
	pruneDeadEntries,
	pruneDeadEntriesAcrossProjects,
	removeRegistryEntry,
	resolveUniqueName,
	writeToDLQ,
	listDLQForSession,
	// Audit
	appendAudit,
	// Validators
	isValidEnvelope,
} from "../../../src/coms-protocol/index.ts";

// ━━━ Configuration ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COMS_DIR = resolveComsDir();
const CONTAINER_ID = resolveContainerId();

const MAX_HOPS = Number(process.env.PI_COMS_MAX_HOPS) || 5;
const TIMEOUT_MS = Number(process.env.PI_COMS_TIMEOUT_MS) || 1_800_000; // 30 min
const PING_INTERVAL_MS = Number(process.env.PI_COMS_PING_INTERVAL_MS) || 10_000;
const KEEPALIVE_INTERVAL_MS = Number(process.env.PI_COMS_KEEPALIVE_INTERVAL_MS) || 10_000;
const HEARTBEAT_STALE_MS = 30_000;

const FALLBACK_PALETTE = [
	"#72F1B8", "#36F9F6", "#FF7EDB", "#FEDE5D",
	"#C792EA", "#FF8B39", "#4D9DE0", "#FFAA8B",
];

// ━━━ Internal state shapes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface Identity {
	session_id: string;
	name: string;
	purpose: string;
	color: string;
	project: string;
	explicit: boolean;
	cwd: string;
	model: string;
	endpoint: string;
	registryFile: string;
	container_id: string;
}

interface PeerCard {
	name: string;
	purpose: string;
	model: string;
	color: string;
	// number | null, not number: AgentCard.context_used_pct is optional in the
	// protocol (some adapters, e.g. Claude's stateless-subprocess bridge, have
	// no such number to report). null means "unknown" — never coerce to 0,
	// which would misread as "idle" in the widget. Guard downstream reads with
	// `!= null`, not truthiness.
	context_used_pct: number | null;
	queue_depth: number;
	staleCount: number;
	lastSeenMs: number;
}

interface PendingReply {
	resolve: (value: { response?: unknown; error?: string | null }) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout | null;
	promise: Promise<{ response?: unknown; error?: string | null }>;
	result?: { response?: unknown; error?: string | null };
	target_name?: string;
	created_at: string;
}

interface InboundContext {
	msg_id: string;
	hops: number;
	sender_endpoint: string;
	sender_session: string;
	sender_name: string;
	sender_container: string;
	sender_cwd: string;
	response_schema: Record<string, unknown> | null;
	fulfilled: boolean;
}

// ━━━ Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function nowIso(): string {
	return new Date().toISOString();
}

function isValidHex(hex: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(hex);
}

function hexFg(hex: string | undefined, s: string): string {
	// Guard against missing/invalid colors: an invalid hex would yield NaN
	// channels and emit a broken "\x1b[38;2;NaN;NaN;NaNm" sequence that the
	// terminal prints as literal garbage (e.g. "aN;NaN;NaNm") before the text.
	if (!hex || !isValidHex(hex)) return s;
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

function currentContextPct(ctx: ExtensionContext | null | undefined): number | undefined {
	// Per coms-protocol: omit context_used_pct when genuinely unknown (no
	// model, no context window, no post-compaction usage yet) rather than
	// substituting 0, which reads as "idle" to receivers.
	const usage = ctx?.getContextUsage()?.percent;
	return usage != null ? Math.round(usage) : undefined;
}

function fallbackColor(sessionId: string): string {
	// Deterministic color from session ID for the case where neither a CLI
	// --color nor a system-prompt frontmatter color is provided.
	let h = 0;
	for (let i = 0; i < sessionId.length; i++) {
		h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
	}
	return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

function abbreviateModel(model: string): string {
	// Peers that don't report a model (e.g. bridges that don't populate the
	// registry `model` field) would otherwise render as blank padding —
	// show an explicit placeholder instead so the column stays legible.
	if (!model) return "unknown";
	let m = model;
	if (m.startsWith("claude-")) m = m.slice("claude-".length);
	if (m.startsWith("gpt-")) m = m.slice("gpt-".length);
	if (m.length > 28) m = m.slice(0, 28);
	return m;
}

function parseFrontmatter(raw: string): {
	name?: string;
	description?: string;
	color?: string;
	body: string;
} {
	const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return { body: raw };
	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			let val = line.slice(idx + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			frontmatter[key] = val;
		}
	}
	return {
		name: frontmatter.name,
		description: frontmatter.description,
		color: frontmatter.color,
		body: match[2],
	};
}

function findSystemPromptPath(argv: string[]): string | null {
	// Scan argv for --system-prompt or --append-system-prompt. These are
	// pi-builtin flags (not extension-registered) so we still scan argv
	// directly. First valid match wins per preference order.
	const scan = (flag: string): string | null => {
		for (let i = 0; i < argv.length; i++) {
			if (argv[i] === flag && i + 1 < argv.length) {
				const candidate = argv[i + 1];
				if (candidate.endsWith(".md")) {
					try {
						if (fs.existsSync(candidate)) {
							return candidate;
						}
					} catch {
						// fall through
					}
				}
			}
		}
		return null;
	};
	return scan("--system-prompt") ?? scan("--append-system-prompt");
}

function readFrontmatterFromArgv(argv: string[]): {
	name?: string;
	description?: string;
	color?: string;
} {
	// (fs already imported at top)
	const p = findSystemPromptPath(argv);
	if (!p) return {};
	try {
		const raw = fs.readFileSync(p, "utf-8");
		const { name, description, color } = parseFrontmatter(raw);
		return { name, description, color };
	} catch {
		return {};
	}
}

interface CliFlags {
	name?: string;
	purpose?: string;
	project?: string;
	color?: string;
	explicit?: boolean;
}

function readCliFlags(pi: ExtensionAPI): CliFlags {
	const name = pi.getFlag("cname") as string | undefined;
	const purpose = pi.getFlag("purpose") as string | undefined;
	const project = pi.getFlag("project") as string | undefined;
	const color = pi.getFlag("color") as string | undefined;
	const explicit = pi.getFlag("explicit") as boolean | undefined;
	return {
		name: name && String(name).length > 0 ? String(name) : undefined,
		purpose: purpose && String(purpose).length > 0 ? String(purpose) : undefined,
		project: project && String(project).length > 0 ? String(project) : undefined,
		color: color && String(color).length > 0 ? String(color) : undefined,
		explicit: explicit === true,
	};
}

function listProjects(): string[] {
	// (fs already imported at top)
	// (path already imported at top)
	const root = projectsRoot(COMS_DIR);
	try {
		return fs.readdirSync(root).filter((d: string) => {
			try {
				return fs.statSync(path.join(root, d)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		return [];
	}
}

// ━━━ Default export ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function (pi: ExtensionAPI) {
	// ━━ Register CLI flags so pi's parser accepts them. ━━━━━━━━━━━━━━━━━━
	// Without these, pi 0.73+ rejects the invocation with "Unknown options:
	// --cname, --project, ..." before this extension's hooks ever fire.
	// Note: agent name flag is `--cname` because pi's harness owns `--name`
	// and uses it for session resume.
	pi.registerFlag("cname", {
		description: "Override agent name (otherwise from frontmatter or auto-generated).",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("purpose", {
		description: "Override agent purpose (otherwise from frontmatter description).",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("project", {
		description: "Project namespace for peer discovery (default: basename of cwd).",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("color", {
		description: "Hex color #RRGGBB for the pool widget (default: frontmatter or palette).",
		type: "string",
		default: undefined,
	});
	pi.registerFlag("explicit", {
		description: "Hide this agent from auto-discovery; only addressable by exact name.",
		type: "boolean",
		default: false,
	});

	// ━━ Mutable state (per extension instance). ━━━━━━━━━━━━━━━━━━━━━━━━━━
	let identity: Identity | null = null;
	const peerCards = new Map<string, PeerCard>();
	const pendingReplies = new Map<string, PendingReply>();
	const inboundQueue = new Map<string, InboundContext>();
	let server: ReturnType<typeof import("node:net").createServer> | null = null;
	let pingTimer: NodeJS.Timeout | null = null;
	let keepaliveTimer: NodeJS.Timeout | null = null;
	let displayProject: string | null = null;
	let includeExplicit = false;
	let currentCtx: ExtensionContext | null = null;
	let currentInbound: InboundContext | null = null;
	const tracker = new ConnectionTracker();

	// ━━ Connection handler ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	function connHandler(socket: import("node:net").Socket): void {
		tracker.add(socket);
		socket.on("close", () => tracker.delete(socket));

		let buf = "";
		let handled = false;
		const onData = (chunk: Buffer) => {
			if (handled) return;
			buf += chunk.toString("utf-8");
			if (buf.length > 64 * 1024) {
				handled = true;
				socket.removeListener("data", onData);
				writeNack(socket, "", "line too large");
				return;
			}
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			handled = true;
			socket.removeListener("data", onData);
			const line = buf.slice(0, nl);
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				writeNack(socket, "", "malformed envelope");
				return;
			}
			if (!isValidEnvelope(parsed)) {
				const mid =
					parsed && typeof parsed === "object" && typeof (parsed as any).msg_id === "string"
						? (parsed as any).msg_id
						: "";
				writeNack(socket, mid, "malformed envelope");
				return;
			}
			try {
				if (parsed.type === "prompt") {
					handlePrompt(socket, parsed as PromptEnvelope);
				} else if (parsed.type === "response") {
					handleResponse(socket, parsed as ResponseEnvelope);
				} else if (parsed.type === "ping") {
					handlePing(socket, parsed as PingEnvelope);
				} else {
					writeNack(socket, parsed.msg_id, "unknown type");
				}
			} catch (err) {
				appendAudit(COMS_DIR, {
					event: "hops_exceeded",
					msg_id: parsed.msg_id,
					hops: parsed.hops,
				});
				writeNack(socket, parsed.msg_id, `internal error: ${err instanceof Error ? err.message : String(err)}`);
			}
		};
		socket.on("data", onData);
		socket.once("error", () => {
			try {
				socket.destroy();
			} catch {
				/* ignore */
			}
		});
	}

	function handlePrompt(socket: import("node:net").Socket, env: PromptEnvelope): void {
		// Hop limit check — reject if we'd be forwarding too many times.
		if (typeof env.hops !== "number" || env.hops >= MAX_HOPS) {
			appendAudit(COMS_DIR, { event: "hops_exceeded", msg_id: env.msg_id, hops: env.hops });
			writeNack(socket, env.msg_id, `hops exceeded (${env.hops} >= ${MAX_HOPS})`);
			return;
		}

		const inbound: InboundContext = {
			msg_id: env.msg_id,
			hops: env.hops,
			sender_endpoint: env.sender_endpoint,
			sender_session: env.sender_session,
			sender_name: env.sender_name,
			sender_container: parseContainerFromEndpoint(env.sender_endpoint),
			sender_cwd: env.sender_cwd,
			response_schema: env.response_schema ?? null,
			fulfilled: false,
		};
		inboundQueue.set(env.msg_id, inbound);
		currentInbound = inbound;

		// Inject as a follow-up message into the receiver's next turn.
		try {
			pi.sendMessage(
				{
					customType: "coms-inbound",
					content: `[from ${env.sender_name} @ ${env.sender_cwd} (container ${inbound.sender_container})]\n\n${env.prompt}`,
					display: true,
					details: {
						msg_id: env.msg_id,
						sender_session: env.sender_session,
						sender_container: inbound.sender_container,
						response_schema: env.response_schema ?? null,
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			inboundQueue.delete(env.msg_id);
			currentInbound = null;
			writeNack(socket, env.msg_id, "internal error: sendMessage failed");
			return;
		}

		writeAck(socket, env.msg_id);
		appendAudit(COMS_DIR, {
			event: "inbound_prompt",
			msg_id: env.msg_id,
			sender: env.sender_session,
			hops: env.hops,
			from_container: inbound.sender_container,
		});
	}

	function handleResponse(socket: import("node:net").Socket, env: ResponseEnvelope): void {
		const pending = pendingReplies.get(env.msg_id);
		if (pending) {
			if (pending.timer) {
				try {
					clearTimeout(pending.timer);
				} catch {
					/* ignore */
				}
				pending.timer = null;
			}
			pending.result = { response: env.response, error: env.error ?? null };
			try {
				pending.resolve(pending.result);
			} catch {
				/* ignore */
			}
			// Note: don't delete — coms_get may still want to poll.
		} else {
			appendAudit(COMS_DIR, { event: "orphan_response", msg_id: env.msg_id });
		}
		writeAck(socket, env.msg_id);
	}

	function handlePing(socket: import("node:net").Socket, _env: PingEnvelope): void {
		const ctx = currentCtx;
		const ident = identity;
		const pct = currentContextPct(ctx);
		const card: AgentCard = {
			name: ident?.name ?? "unknown",
			purpose: ident?.purpose ?? "",
			model: ctx?.model?.id ?? ident?.model ?? "unknown",
			color: ident?.color ?? "#36F9F6",
			...(pct != null ? { context_used_pct: pct } : {}),
			queue_depth: inboundQueue.size,
		};
		const pong: PongFrame = { type: "pong", msg_id: _env.msg_id, agent_card: card };
		try {
			socket.write(JSON.stringify(pong) + "\n");
		} catch {
			/* ignore */
		}
		try {
			socket.end();
		} catch {
			/* ignore */
		}
	}

	/**
	 * Pull the container ID out of an endpoint path. The format is
	 * `<COMS_DIR>/sockets/<container_id>/<session_id>.sock`. We extract
	 * the second-to-last path component. Returns "unknown" if the path
	 * doesn't match the expected shape.
	 */
	function parseContainerFromEndpoint(endpoint: string): string {
		// (path already imported at top)
		const norm = endpoint.replace(/\\\\\.\\pipe\\/g, "");
		const parts = norm.split(path.sep).filter(Boolean);
		// Walk back from the end: .../sockets/<container_id>/<session_id>.sock
		const idx = parts.lastIndexOf("sockets");
		if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
		// Fallback: try second-to-last component
		if (parts.length >= 2) return parts[parts.length - 2];
		return "unknown";
	}

	// ━━ session_start: resolve identity, bind socket, install widget ━━━━━━
	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;

		// 1. Resolve identity from CLI flags > frontmatter > defaults.
		const flags = readCliFlags(pi);
		const fm = readFrontmatterFromArgv(process.argv);

		const project = flags.project || defaultProjectFromCwd(ctx.cwd || process.cwd());
		const explicit = flags.explicit === true;
		const session_id = ulid();

		const defaultName = `pi-${session_id.slice(-6)}`;
		const desiredName = flags.name || fm.name || defaultName;
		const name = resolveUniqueName(COMS_DIR, project, desiredName);
		if (name !== desiredName) {
			appendAudit(COMS_DIR, { event: "name_collision", desired: desiredName, assigned: name, project });
		}

		const purpose = flags.purpose || fm.description || "";

		// Color: CLI > frontmatter > deterministic fallback. Validate hex.
		let color = fallbackColor(session_id);
		if (fm.color && isValidHex(fm.color)) color = fm.color;
		if (flags.color && isValidHex(flags.color)) color = flags.color;

		const endpoint = makeEndpoint(COMS_DIR, CONTAINER_ID, session_id);
		const cwd = ctx.cwd || process.cwd();
		const model = ctx.model?.id ?? "unknown";

		// 2. Ensure storage dirs exist.
		try {
			// (path already imported at top)
			// (fs already imported at top)
			fs.mkdirSync(projectAgentsDir(COMS_DIR, project), { recursive: true });
			fs.mkdirSync(path.dirname(endpoint), { recursive: true });
			try {
				fs.chmodSync(COMS_DIR, 0o700);
			} catch {
				/* best-effort */
			}
		} catch (err) {
			ctx.ui?.notify?.(
				`\uef60 coms-inner: failed to create dirs — ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			return;
		}

		// 3. Bind the endpoint.
		try {
			server = await bindEndpoint(endpoint, connHandler, tracker);
		} catch (err) {
			ctx.ui?.notify?.(
				`\uef60 coms-inner: bind failed — ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			return;
		}

		// 4. Write the registry entry.
		const entry: RegistryEntry = {
			session_id,
			name,
			purpose,
			model,
			color,
			pid: process.pid,
			endpoint,
			cwd,
			started_at: nowIso(),
			explicit,
			version: 1,
			container_id: CONTAINER_ID,
			transport: "uds",
			heartbeat_at: nowIso(),
			...(currentContextPct(ctx) != null ? { context_used_pct: currentContextPct(ctx) } : {}),
			queue_depth: 0,
		};
		let registryFile: string;
		try {
			registryFile = writeRegistryEntry(COMS_DIR, project, entry);
		} catch (err) {
			ctx.ui?.notify?.(
				`\uef60 coms-inner: registry write failed — ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			try {
				server?.close();
			} catch {
				/* ignore */
			}
			return;
		}

		identity = {
			session_id,
			name,
			purpose,
			color,
			project,
			explicit,
			cwd,
			model,
			endpoint,
			registryFile,
			container_id: CONTAINER_ID,
		};
		displayProject = project;
		includeExplicit = false;

		appendAudit(COMS_DIR, { event: "boot", session_id, name, project, container_id: CONTAINER_ID });

		// 5. Surface presence in the UI.
		try {
			// Force the nerd-font satellite icon to render white regardless of
			// theme/terminal default fg — only the icon glyph is colored, the rest
			// of the status text keeps the footer's normal (dim) styling.
			ctx.ui.setStatus("coms", `\x1b[97m\x1b[39m ${name}@${project}`);
			installPoolWidget(ctx);
			ctx.ui.notify(
				`\uef60 coms ready · ${name}@${project} · container ${CONTAINER_ID}`,
				"info",
			);
		} catch {
			// hasUI may be false (RPC / print mode) — non-fatal.
		}

		// 6. Start ping + heartbeat cycles.
		pingTimer = setInterval(() => {
			refreshPool().catch(() => {});
		}, PING_INTERVAL_MS);
		try {
			(pingTimer as any).unref?.();
		} catch {
			/* ignore */
		}

		keepaliveTimer = setInterval(() => {
			if (!identity) return;
			try {
				// (fs already imported at top)
				const live: RegistryEntry = {
					session_id: identity.session_id,
					name: identity.name,
					purpose: identity.purpose,
					model: ctx?.model?.id ?? identity.model,
					color: identity.color,
					pid: process.pid,
					endpoint: identity.endpoint,
					cwd: identity.cwd,
					started_at: identity.session_id === identity.session_id ? nowIso() : identity.session_id,
					explicit: identity.explicit,
					version: 1,
					container_id: identity.container_id,
					transport: "uds",
					heartbeat_at: nowIso(),
					...(currentContextPct(ctx) != null ? { context_used_pct: currentContextPct(ctx) } : {}),
					queue_depth: inboundQueue.size,
				};
				// Detect missing-registry BEFORE writing so the self_heal audit
				// only fires when something actually went wrong (file unlinked
				// under us).
				const missingBeforeWrite = !fs.existsSync(identity.registryFile);
				writeRegistryEntry(COMS_DIR, identity.project, live);
				if (missingBeforeWrite) {
					appendAudit(COMS_DIR, {
						event: "self_heal",
						session_id: identity.session_id,
						reason: "registry file missing",
					});
				}
			} catch {
				/* best-effort */
			}
		}, KEEPALIVE_INTERVAL_MS);
		try {
			(keepaliveTimer as any).unref?.();
		} catch {
			/* ignore */
		}

		// Kick one ping cycle immediately so the widget populates fast.
		refreshPool().catch(() => {});
	});

	// ━━ Pool widget ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	function renderPool(width: number, _theme: Theme): string[] {
		const projectFilter = displayProject ?? identity?.project ?? "default";
		const registryEntries =
			projectFilter === "*"
				? readAllRegistryEntriesAcrossProjects(COMS_DIR)
				: readAllRegistryEntries(COMS_DIR, projectFilter);

		interface Row {
			name: string;
			container: string;
			model: string;
			color: string;
			purpose: string;
			pct: number | null;
			pending: boolean;
			stale: boolean;
		}
		const rows: Row[] = [];
		const seenSessions = new Set<string>();

		for (const [sid, card] of peerCards.entries()) {
			if (identity && sid === identity.session_id) continue;
			seenSessions.add(sid);
			rows.push({
				name: card.name,
				container: "",
				model: card.model,
				color: card.color && isValidHex(card.color) ? card.color : fallbackColor(sid),
				purpose: card.purpose,
				pct: card.context_used_pct,
				pending: false,
				stale: card.staleCount >= 3,
			});
		}

		const seenNames = new Set(rows.map((r) => r.name));
		for (const entry of registryEntries) {
			if (identity && entry.session_id === identity.session_id) continue;
			if (!includeExplicit && entry.explicit) continue;
			if (seenSessions.has(entry.session_id)) continue;
			if (seenNames.has(entry.name)) continue;
			rows.push({
				name: entry.name,
				container: entry.container_id,
				model: entry.model,
				color: entry.color && isValidHex(entry.color) ? entry.color : fallbackColor(entry.session_id),
				purpose: entry.purpose,
				// Peers that don't answer ping/pong (no live PeerCard) still land
				// here; fall back to whatever the registry entry itself reports
				// (heartbeat-refreshed by well-behaved adapters) instead of always
				// showing "--%" even when a real value is available.
				pct: typeof entry.context_used_pct === "number" ? entry.context_used_pct : null,
				pending: true,
				stale: false,
			});
		}

		// Reserve a small safety margin: pi's tui composites our lines into a
		// wider frame, and an off-by-one visible width can crash the whole tui
		// with "Rendered line N exceeds terminal width". Truncating to
		// (width - 2) leaves room for any tui chrome without sacrificing
		// usable space.
		const safeWidth = Math.max(20, width - 2);
		// Build top border so its visible width equals safeWidth exactly.
		// `┏━ coms [project] ━…━┓` — compute the dash run to fill the rest based
		// on the label's actual visible width (handles box-drawing chars correctly).
		const topLabel = `┏━ coms [${projectFilter}] `;
		const topDashes = Math.max(0, safeWidth - visibleWidth(topLabel) - 1); // -1 for closing ┓
		const topBorder = topLabel + "━".repeat(topDashes) + "┓";
		const botDashes = Math.max(0, safeWidth - 2); // ┗ + ┛
		const bottomBorder = "┗" + "━".repeat(botDashes) + "┛";

		if (rows.length === 0) {
			return [topBorder, truncateToWidth("  no peers connected", safeWidth, "…"), bottomBorder];
		}

		rows.sort((a, b) => a.name.localeCompare(b.name));

		const lines: string[] = [topBorder];
		for (const r of rows) {
			const pctStr = r.pct == null ? "  --%" : `${String(r.pct).padStart(4)}%`;
			const filled = Math.max(0, Math.min(15, Math.round(((r.pct ?? 0) / 100) * 15)));
			const empty = 15 - filled;
			const bar = r.pending
				? "-".repeat(15)
				: hexFg(r.color, "#".repeat(filled)) + "-".repeat(empty);

			const swatch = r.pending ? "○" : r.stale ? "✗" : "●";
			const namePart = r.name.padEnd(14);
			const containerPart = r.container ? ` (${r.container.slice(0, 8)})` : "";
			const modelPart = abbreviateModel(r.model).padEnd(28);
			const row =
				` ${swatch} ${hexFg(r.color, namePart)}${containerPart}  ${modelPart} [${bar}] ${pctStr}  ${r.purpose || ""}`;
			lines.push(truncateToWidth(row, safeWidth, "…"));
		}
		lines.push(bottomBorder);
		return lines;
	}

	function installPoolWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWidget("coms-inner-pool", (_tui: unknown, theme: Theme) => ({
				render(width: number): string[] {
					return renderPool(width, theme);
				},
			}) as any, { placement: "belowEditor" } as any);
		} catch {
			// non-fatal
		}
	}

	// ━━ Ping cycle: refresh peer cards ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	async function pingPeer(endpoint: string): Promise<AgentCard | null> {
		if (!identity) return null;
		const env: PingEnvelope = {
			type: "ping",
			msg_id: ulid(),
			sender_session: identity.session_id,
			sender_endpoint: identity.endpoint,
			hops: 0,
			timestamp: nowIso(),
		};
		try {
			const reply = (await sendEnvelope(endpoint, env)) as PongFrame;
			if (reply && reply.type === "pong" && reply.agent_card) {
				return reply.agent_card;
			}
		} catch {
			/* peer unreachable */
		}
		return null;
	}

	async function refreshPool(): Promise<void> {
		if (!identity) return;
		const projectFilter = displayProject ?? identity.project;
		const live =
			projectFilter === "*"
				? pruneDeadEntriesAcrossProjects(COMS_DIR, { staleMs: HEARTBEAT_STALE_MS })
				: pruneDeadEntries(COMS_DIR, projectFilter, { staleMs: HEARTBEAT_STALE_MS });

		const peers = live.filter(
			(e) => e.session_id !== identity!.session_id && (includeExplicit || !e.explicit),
		);

		const results = await Promise.allSettled(
			peers.map(async (peer) => {
				const pong = await pingPeer(peer.endpoint);
				return { peer, pong };
			}),
		);

		const seenSessions = new Set<string>();
		let changed = false;

		for (const r of results) {
			if (r.status === "fulfilled" && r.value.pong) {
				const { peer, pong } = r.value;
				seenSessions.add(peer.session_id);
				const prev = peerCards.get(peer.session_id);
				const next: PeerCard = {
					...pong,
					// AgentCard.context_used_pct is optional; normalize absent to null
					// rather than letting `undefined` slip through (and never default
					// to 0 — that reads as "idle" in the widget, not "unknown").
					context_used_pct: pong.context_used_pct ?? null,
					staleCount: 0,
					lastSeenMs: Date.now(),
				};
				if (
					!prev ||
					prev.name !== next.name ||
					prev.model !== next.model ||
					prev.color !== next.color ||
					prev.context_used_pct !== next.context_used_pct ||
					prev.queue_depth !== next.queue_depth
				) {
					peerCards.set(peer.session_id, next);
					changed = true;
				}
			}
		}

		// Bump staleCount for any peer we didn't see this cycle; drop after 6 misses.
		for (const [sid, card] of peerCards.entries()) {
			if (!seenSessions.has(sid)) {
				card.staleCount += 1;
				if (card.staleCount > 6) {
					peerCards.delete(sid);
				}
				changed = true;
			}
		}

		if (changed && currentCtx?.hasUI) installPoolWidget(currentCtx);
	}

	// ━━ Target resolution ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	function resolveTarget(target: string): RegistryEntry | null {
		// Prefer exact name match within our project.
		if (identity) {
			const local = pruneDeadEntries(COMS_DIR, identity.project, { staleMs: HEARTBEAT_STALE_MS });
			const byName = local.find((e) => e.name === target);
			if (byName) return byName;
		}
		// Then fall back to scanning all projects by session_id.
		for (const proj of listProjects()) {
			const entries = pruneDeadEntries(COMS_DIR, proj, { staleMs: HEARTBEAT_STALE_MS });
			const bySession = entries.find((e) => e.session_id === target);
			if (bySession) return bySession;
		}
		// Then by name across all projects.
		for (const proj of listProjects()) {
			const entries = pruneDeadEntries(COMS_DIR, proj, { staleMs: HEARTBEAT_STALE_MS });
			const byName = entries.find((e) => e.name === target);
			if (byName) return byName;
		}
		return null;
	}

	// ━━ DLQ: pick up responses delivered while we were offline ━━━━━━━━━━━
	function drainDLQForSession(): void {
		if (!identity) return;
		const items = listDLQForSession(COMS_DIR, identity.project, identity.session_id);
		for (const item of items) {
			const pending = pendingReplies.get(item.msg_id);
			if (pending) {
				const env = item.envelope as ResponseEnvelope;
				pending.result = { response: env.response, error: env.error ?? null };
				try {
					pending.resolve(pending.result);
				} catch {
					/* ignore */
				}
			}
			appendAudit(COMS_DIR, { event: "dlq_drain", msg_id: item.msg_id, status: "delivered" });
			try {
				fs.unlinkSync(path.join(
					dlqDir(COMS_DIR, identity.project),
					`${item.msg_id}.json`,
				));
			} catch {
				/* best-effort */
			}
		}
	}

	function dlqDir(comsDir: string, project: string): string {
		return path.join(comsDir, "projects", project, "dlq");
	}

	// ━━ Tools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.registerTool({
		name: "coms_list",
		label: "Coms List",
		description:
			"List peer agents discoverable via coms. Returns names, models, container IDs, and live context-window usage. " +
			"Use project='*' to scan all projects. include_explicit=true reveals agents marked --explicit.",
		parameters: Type.Object({
			project: Type.Optional(Type.String({ description: "Project name, or '*' for all projects. Defaults to caller's project." })),
			include_explicit: Type.Optional(Type.Boolean({ description: "Include agents launched with --explicit. Default false." })),
		}),
		async execute(_callId, params): Promise<AgentToolResult<{ agents: Array<Record<string, unknown>>; project: string }>> {
			const includeExp = params.include_explicit === true;
			const projectFilter = params.project ?? identity?.project ?? "default";
			const projects = projectFilter === "*" ? listProjects() : [projectFilter];

			const collected: { entry: RegistryEntry; project: string }[] = [];
			for (const proj of projects) {
				for (const entry of pruneDeadEntries(COMS_DIR, proj, { staleMs: HEARTBEAT_STALE_MS })) {
					if (entry.explicit && !includeExp) continue;
					if (identity && entry.session_id === identity.session_id) continue;
					collected.push({ entry, project: proj });
				}
			}

			const pongs = await Promise.allSettled(collected.map((c) => pingPeer(c.entry.endpoint)));

			const agents = collected.map((c, i) => {
				const r = pongs[i];
				const pong = r.status === "fulfilled" ? r.value : null;
				return {
					name: c.entry.name,
					session_id: c.entry.session_id,
					container_id: c.entry.container_id,
					purpose: c.entry.purpose,
					model: c.entry.model,
					cwd: c.entry.cwd,
					project: c.project,
					alive: pong != null,
					context_used_pct: pong?.context_used_pct ?? null,
					color: c.entry.color,
				};
			});

			const lines =
				agents.length === 0
					? "No peer agents found."
					: agents
							.map((a) => {
								const ctxStr = a.context_used_pct != null ? ` ${a.context_used_pct}%` : " ?%";
								const live = a.alive ? "●" : "✗";
								const containerTag = a.container_id ? ` [${String(a.container_id).slice(0, 12)}]` : "";
								return `${live} ${a.name}${containerTag} (${a.model})${ctxStr}${a.purpose ? ` — ${a.purpose}` : ""}`;
							})
							.join("\n");

			return {
				content: [{ type: "text" as const, text: `${agents.length} peer(s):\n${lines}` }],
				details: { agents, project: projectFilter },
			};
		},
	});

	pi.registerTool({
		name: "coms_send",
		label: "Coms Send",
		description:
			"Send a prompt to a peer agent. Returns synchronously with a msg_id once the receiver acks. " +
			"Use coms_get (non-blocking) or coms_await (blocking) with the msg_id to retrieve the response. " +
			"Throws if the receiver is unreachable or rejects the envelope.",
		parameters: Type.Object({
			target: Type.String({ description: "Peer name (preferred, scoped to your project) or session_id (global)." }),
			prompt: Type.String({ description: "The prompt to send." }),
			conversation_id: Type.Optional(Type.String()),
			response_schema: Type.Optional(Type.Any({ description: "Optional JSON Schema describing the expected response shape." })),
		}),
		async execute(_callId, params): Promise<AgentToolResult<{ msg_id: string; target: string; hops: number }>> {
			if (!identity) throw new Error("coms-inner not initialised");
			const target = resolveTarget(params.target);
			if (!target) throw new Error(`coms-inner: no live agent matching "${params.target}"`);

			const hops = currentInbound ? currentInbound.hops + 1 : 0;
			if (hops >= MAX_HOPS) throw new Error(`coms-inner: hop limit reached (${hops} >= ${MAX_HOPS})`);

			const msg_id = ulid();
			const env: PromptEnvelope = {
				type: "prompt",
				msg_id,
				sender_session: identity.session_id,
				sender_endpoint: identity.endpoint,
				sender_name: identity.name,
				sender_cwd: identity.cwd,
				hops,
				timestamp: nowIso(),
				prompt: params.prompt,
				conversation_id: params.conversation_id ?? null,
				response_schema: (params.response_schema as Record<string, unknown> | undefined) ?? null,
			};

			await sendEnvelope(target.endpoint, env);

			let resolveFn!: (v: { response?: unknown; error?: string | null }) => void;
			let rejectFn!: (e: Error) => void;
			const promise = new Promise<{ response?: unknown; error?: string | null }>((res, rej) => {
				resolveFn = res;
				rejectFn = rej;
			});
			const entry: PendingReply = {
				resolve: resolveFn,
				reject: rejectFn,
				timer: null,
				promise,
				target_name: target.name,
				created_at: nowIso(),
			};
			entry.timer = setTimeout(() => {
				if (entry.result) return;
				entry.result = { error: "timeout" };
				try {
					entry.resolve(entry.result);
				} catch {
					/* ignore */
				}
			}, TIMEOUT_MS);
			try {
				(entry.timer as any).unref?.();
			} catch {
				/* ignore */
			}
			pendingReplies.set(msg_id, entry);

			appendAudit(COMS_DIR, {
				event: "outbound_prompt",
				msg_id,
				target: target.name,
				to_container: target.container_id,
				hops,
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `coms_send → ${target.name} [container ${target.container_id}]\nmsg_id ${msg_id}\nhops ${hops}`,
					},
				],
				details: { msg_id, target: target.name, hops },
			};
		},
	});

	pi.registerTool({
		name: "coms_get",
		label: "Coms Get",
		description:
			"Non-blocking poll of a pending coms_send reply. Returns status pending|complete|error and (when complete) the response.",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_send." }),
		}),
		async execute(_callId, params): Promise<AgentToolResult<{ status: string; response?: unknown; error?: string | null }>> {
			const entry = pendingReplies.get(params.msg_id);
			if (!entry) {
				return {
					content: [{ type: "text" as const, text: `coms_get: unknown msg_id ${params.msg_id}` }],
					details: { status: "error", error: "unknown msg_id" },
				};
			}
			if (entry.result) {
				const r = entry.result;
				const text = r.error
					? `coms_get: error — ${r.error}`
					: `coms_get: complete\n${typeof r.response === "string" ? r.response : JSON.stringify(r.response, null, 2)}`;
				return {
					content: [{ type: "text" as const, text }],
					details: { status: "complete", response: r.response, error: r.error ?? null },
				};
			}
			return {
				content: [{ type: "text" as const, text: `coms_get: pending` }],
				details: { status: "pending" },
			};
		},
	});

	pi.registerTool({
		name: "coms_await",
		label: "Coms Await",
		description:
			"Block until a pending coms_send reply lands or the timeout fires. Default timeout 30 minutes (PI_COMS_TIMEOUT_MS).",
		parameters: Type.Object({
			msg_id: Type.String({ description: "msg_id returned by coms_send." }),
			timeout_ms: Type.Optional(Type.Number({ description: "Override the default timeout (ms)." })),
		}),
		async execute(_callId, params): Promise<AgentToolResult<{ response?: unknown; error?: string }>> {
			// Drain the DLQ first in case a reply landed while we were offline.
			drainDLQForSession();

			const entry = pendingReplies.get(params.msg_id);
			if (!entry) {
				return {
					content: [{ type: "text" as const, text: `coms_await: unknown msg_id ${params.msg_id}` }],
					details: { error: "unknown msg_id" },
				};
			}
			const timeoutMs = typeof params.timeout_ms === "number" && params.timeout_ms > 0
				? params.timeout_ms
				: TIMEOUT_MS;

			const timed = new Promise<{ error: string }>((resolve) => {
				const t = setTimeout(() => resolve({ error: "timeout" }), timeoutMs);
				try {
					(t as any).unref?.();
				} catch {
					/* ignore */
				}
			});

			const winner = await Promise.race([entry.promise, timed]);
			if ((winner as any).error) {
				return {
					content: [{ type: "text" as const, text: `coms_await: error — ${(winner as any).error}` }],
					details: { error: (winner as any).error },
				};
			}
			const resp = (winner as any).response;
			return {
				content: [
					{
						type: "text" as const,
						text: typeof resp === "string" ? resp : JSON.stringify(resp, null, 2),
					},
				],
				details: { response: resp },
			};
		},
	});

	// ━━ agent_end: capture assistant output and dispatch reply ━━━━━━━━━━━
	pi.on("agent_end", async (_event, ctx) => {
		const inbound = [...inboundQueue.values()].reverse().find((i) => !i.fulfilled);
		if (!inbound || !identity) return;

		// Walk the session branch for the most recent assistant message text.
		let lastAssistantText = "";
		try {
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "message") {
					const m = entry.message as any;
					if (m && m.role === "assistant") {
						if (typeof m.content === "string") {
							lastAssistantText = m.content;
						} else if (Array.isArray(m.content)) {
							lastAssistantText = m.content
								.filter((b: any) => b && b.type === "text")
								.map((b: any) => b.text)
								.join("\n");
						}
					}
				}
			}
		} catch {
			/* sessionManager may not be available in all modes */
		}

		let payload: unknown = lastAssistantText;
		let error: string | null = null;
		if (inbound.response_schema && typeof inbound.response_schema === "object") {
			try {
				payload = JSON.parse(lastAssistantText);
			} catch {
				error = "response not valid JSON";
				payload = null;
			}
		}

		const respEnv: ResponseEnvelope = {
			type: "response",
			msg_id: inbound.msg_id,
			sender_session: identity.session_id,
			sender_endpoint: identity.endpoint,
			hops: 0,
			timestamp: nowIso(),
			response: payload,
			error,
		};

		try {
			await sendEnvelope(inbound.sender_endpoint, respEnv);
			appendAudit(COMS_DIR, { event: "outbound_response", msg_id: inbound.msg_id, target: inbound.sender_session, to_container: inbound.sender_container });
		} catch {
			// Sender unreachable — stash in DLQ so they can pick it up on next poll.
			try {
				writeToDLQ(COMS_DIR, identity.project, {
					msg_id: inbound.msg_id,
					target_session: inbound.sender_session,
					envelope: respEnv,
					stored_at: nowIso(),
					expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
				});
				appendAudit(COMS_DIR, { event: "dlq_write", msg_id: inbound.msg_id, reason: "sender unreachable" });
			} catch {
				/* best-effort */
			}
		}

		inbound.fulfilled = true;
		inboundQueue.delete(inbound.msg_id);
		if (currentInbound && currentInbound.msg_id === inbound.msg_id) currentInbound = null;
	});

	// ━━ /coms slash command ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	pi.registerCommand("coms-inner", {
		description: "Force-refresh the coms-inner pool widget (or filter with --all / --project <name>)",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const trimmed = (args ?? "").trim();
			if (trimmed.includes("--all")) {
				includeExplicit = !includeExplicit;
				try {
					ctx.ui.notify(`coms-inner: include_explicit = ${includeExplicit}`, "info");
				} catch {
					/* ignore */
				}
			}
			const projectMatch = trimmed.match(/--project\s+(\S+)/);
			if (projectMatch) {
				displayProject = projectMatch[1];
				try {
					ctx.ui.notify(`coms-inner: displaying project ${displayProject}`, "info");
				} catch {
					/* ignore */
				}
			}
			await refreshPool();
		},
	});

	// ━━ Clean shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	let shuttingDown = false;
	async function cleanShutdown(): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		if (pingTimer) {
			try {
				clearInterval(pingTimer);
			} catch {
				/* ignore */
			}
			pingTimer = null;
		}
		if (keepaliveTimer) {
			try {
				clearInterval(keepaliveTimer);
			} catch {
				/* ignore */
			}
			keepaliveTimer = null;
		}
		tracker.destroyAll();
		if (server) {
			try {
				server.close();
			} catch {
				/* ignore */
			}
			server = null;
		}
		if (identity) {
			try {
				// (fs already imported at top)
				if (process.platform !== "win32") {
					try {
						fs.unlinkSync(identity.endpoint);
					} catch {
						/* ignore */
					}
				}
				removeRegistryEntry(COMS_DIR, identity.project, identity.name);
				appendAudit(COMS_DIR, { event: "shutdown", session_id: identity.session_id, reason: "normal" });
			} catch {
				/* best-effort */
			}
		}
		if (currentCtx?.hasUI) {
			try {
				(currentCtx.ui as any).setWidget?.("coms-inner-pool", undefined);
			} catch {
				/* ignore */
			}
		}
	}

	pi.on("session_shutdown", async () => {
		await cleanShutdown();
	});
	process.on("SIGINT", () => {
		void cleanShutdown();
	});
	process.on("SIGTERM", () => {
		void cleanShutdown();
	});
}
