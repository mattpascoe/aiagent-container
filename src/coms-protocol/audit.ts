/**
 * coms-protocol/audit.ts
 *
 * Append-only JSONL audit log shared by both adapters. Both the Pi
 * extension and the Claude MCP server write to
 * `<COMS_DIR>/audit.log`, one JSON object per line, no prompt bodies.
 *
 * The log is append-only and best-effort. We never throw from this
 * module — audit failures must not break the agent's main loop.
 */

import * as fs from "node:fs";
import { AuditEvent } from "./envelopes.js";
import { auditLogPath } from "./identity.js";

/**
 * Append one audit event as a JSON line. Writes are synchronous to
 * preserve ordering across processes (the shared host volume's filesystem
 * is the only thing ordering us; concurrent processes can interleave
 * writes if we go async).
 *
 * Catches and silently ignores all errors. The audit log is for debugging;
 * if the disk is full we lose audit entries but don't fail the agent.
 */
export function appendAudit(comsDir: string, event: AuditEvent): void {
	try {
		const dir = comsDir;
		// Ensure parent exists — cheap and idempotent
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch {
			/* ignore */
		}
		const line = JSON.stringify({ ...event, _at: new Date().toISOString() }) + "\n";
		fs.appendFileSync(auditLogPath(comsDir), line);
	} catch {
		/* best-effort */
	}
}
