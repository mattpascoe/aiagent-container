#!/usr/bin/env node
/**
 * MCP server exposing coms_inner tools to Claude Code.
 *
 * Transport: stdio (Claude Code spawns this process).
 * Tools: coms_list, coms_send, coms_get, coms_await.
 *
 * Lifecycle: Claude starts us on session start, kills us on session end.
 * The actual inbound listener (which holds the UDS) is a SEPARATE process
 * started by the container entrypoint — see listener.ts.
 *
 * Why split: the MCP stdio channel is owned by Claude (it's how Claude
 * talks to us). The UDS for inbound coms is owned by the listener process.
 * If we held the UDS in the MCP server, Claude terminating the MCP process
 * would orphan all inbound traffic mid-session.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  appendAudit,
  ulid,
  listDLQForSession,
  deleteFromDLQ,
  deletePendingSend,
  projectsRoot,
} from "../../../src/coms-protocol/index.js";
import { resolveIdentity, resolveSelf } from "./identity.js";
import { listPeers, sendPrompt } from "./tools.js";
import { listExchanges, exchangesDir } from "./exchanges.js";

const ident = resolveIdentity();

// Identifies this MCP process in the audit log only. It is NOT our coms
// identity — that belongs to the listener, which owns the UDS and the
// registry entry. See selfSessionId().
const mcp_instance_id = ulid();

/**
 * Our real coms session id, as registered by the listener process.
 *
 * Peers address replies to this id, so DLQ drains must use it. Resolved per
 * call because the listener may register after us. Null means the listener
 * has not registered yet — in which case nothing can be addressed to us, so
 * draining would be meaningless rather than merely empty.
 */
function selfSessionId(): string | null {
  return resolveSelf(ident)?.session_id ?? null;
}

appendAudit(ident.coms_dir, {
  event: "mcp_boot",
  session_id: mcp_instance_id,
  name: ident.name,
  project: ident.project,
  container_id: ident.container_id,
  pid: process.pid,
});

process.on("SIGTERM", () => {
  appendAudit(ident.coms_dir, {
    event: "mcp_shutdown",
    session_id: mcp_instance_id,
    reason: "SIGTERM",
  });
  process.exit(0);
});
process.on("SIGINT", () => {
  appendAudit(ident.coms_dir, {
    event: "mcp_shutdown",
    session_id: mcp_instance_id,
    reason: "SIGINT",
  });
  process.exit(0);
});

const server = new Server(
  {
    name: "agentharness-comms",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "coms_list",
      description:
        "List peer agents currently registered in the shared agentharness-comms pool. " +
        "By default returns peers in your project that are not marked explicit. " +
        "Use project='*' to scan all projects; include_explicit=true to include --explicit agents.",
      inputSchema: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "Project name to scope the listing. Default: your own project. Use '*' for all projects.",
          },
          include_explicit: {
            type: "boolean",
            description: "If true, include agents launched with --explicit.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "coms_send",
      description:
        "Send a prompt to a named peer. Returns a msg_id. Combine with coms_await to wait for the reply. " +
        "If the target is offline, the prompt is queued in their DLQ and delivered when they boot.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Peer name (as set via --cname).",
          },
          prompt: {
            type: "string",
            description: "The message to send.",
          },
          project: {
            type: "string",
            description: "Project to scope target lookup. Default: your project.",
          },
          include_explicit: {
            type: "boolean",
            description: "If true, allow targeting --explicit agents.",
          },
        },
        required: ["target", "prompt"],
        additionalProperties: false,
      },
    },
    {
      name: "coms_get",
      description:
        "Poll for any inbound messages or pending replies addressed to this session. Non-blocking. " +
        "Returns immediately with whatever is available (possibly empty). " +
        "Drains DLQ entries targeting this session.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "coms_await",
      description:
        "Block until a response arrives for one of the given msg_ids, or timeout. " +
        "Returns the matching response envelope on success.",
      inputSchema: {
        type: "object",
        properties: {
          msg_ids: {
            type: "array",
            items: { type: "string" },
            description: "List of msg_ids to wait for replies to.",
          },
          timeout_ms: {
            type: "number",
            description: "Maximum time to wait in milliseconds. Default 30000.",
          },
        },
        required: ["msg_ids"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "coms_list": {
        const a = (args ?? {}) as { project?: string; include_explicit?: boolean };
        const result = listPeers(ident, a);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "coms_send": {
        const a = args as {
          target: string;
          prompt: string;
          project?: string;
          include_explicit?: boolean;
        };
        const result = sendPrompt(ident, a.target, a.prompt, a);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      case "coms_get": {
        // Drain DLQ for our session — this is how we receive responses
        // that were queued because we were offline when the peer replied.
        const sid = selfSessionId();
        const dlqEntries = sid
          ? listDLQForSession(ident.coms_dir, ident.project, sid)
          : [];
        const envelopes = dlqEntries.map((e) => e.envelope);
        for (const e of dlqEntries) {
          deleteFromDLQ(ident.coms_dir, ident.project, e.msg_id);
          // No-op if this drained envelope isn't a reply to something we sent
          // (e.g. it's addressed to us for another reason) — see the
          // best-effort guard in deletePendingSend itself.
          deletePendingSend(ident.coms_dir, ident.project, e.msg_id);
        }
        // Also report recent inbound exchanges the listener answered on our
        // behalf. Those replies have already been sent — this is visibility
        // into what was said, not a queue of work.
        const recent = listExchanges(ident.coms_dir, ident.container_id)
          .slice(-10)
          .map((e) => ({
            msg_id: e.msg_id,
            from: e.sender_name,
            received_at: e.received_at,
            elapsed_ms: e.elapsed_ms,
            delivery: e.delivery,
            prompt: e.prompt,
            response: e.response,
            error: e.error,
          }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  envelopes,
                  count: envelopes.length,
                  timed_out: false,
                  recent_inbound: recent,
                  exchange_log: `${exchangesDir(ident.coms_dir, ident.container_id)}/exchanges.log`,
                  ...(sid
                    ? {}
                    : {
                        warning:
                          `no registry entry for "${ident.name}" in project "${ident.project}" — ` +
                          `the inbound listener is not running, so nothing can be addressed to us`,
                      }),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      case "coms_await": {
        const a = args as { msg_ids: string[]; timeout_ms?: number };
        const timeout = a.timeout_ms ?? 30_000;
        const result = await awaitResponseImpl(a.msg_ids, timeout);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
      default:
        return {
          content: [{ type: "text", text: `unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        { type: "text", text: `error: ${(err as Error).message}` },
      ],
      isError: true,
    };
  }
});

/**
 * How often to re-check the DLQ while awaiting a reply. This is pure added
 * latency on top of however long the peer actually takes to answer — there's
 * no way to be notified the instant a file appears (that would be fs.watch,
 * deliberately not used yet: unreliable on some Docker/overlay filesystems),
 * so every tick we don't check is time a reply could have been sitting there
 * already. 75ms keeps the tax small without turning this into a busy-loop.
 */
const AWAIT_POLL_MS = 75;

/**
 * Poll the DLQ until either a matching response arrives or timeout. Because
 * we don't hold an inbound UDS connection from this MCP-server side (the
 * listener does), responses from peers land in our project's DLQ and we
 * drain them here.
 */
async function awaitResponseImpl(
  msgIds: string[],
  timeoutMs: number,
): Promise<{
  response: unknown;
  envelope: unknown;
  timed_out: boolean;
  waited_ms: number;
}> {
  const deadline = Date.now() + timeoutMs;
  const start = Date.now();
  const want = new Set(msgIds);
  const sid = selfSessionId();
  if (!sid) {
    return {
      response: null,
      envelope: null,
      timed_out: true,
      waited_ms: 0,
    };
  }
  while (Date.now() < deadline) {
    const remaining = Math.max(100, deadline - Date.now());
    // Scan the DLQ for this session.
    const entries = listDLQForSession(ident.coms_dir, ident.project, sid);
    for (const e of entries) {
      const env = e.envelope as { msg_id?: string; in_reply_to?: string } | null;
      if (env && (want.has(env.msg_id ?? "") || want.has(env.in_reply_to ?? ""))) {
        deleteFromDLQ(ident.coms_dir, ident.project, e.msg_id);
        deletePendingSend(ident.coms_dir, ident.project, env.msg_id ?? env.in_reply_to ?? "");
        return {
          response: env,
          envelope: env,
          timed_out: false,
          waited_ms: Date.now() - start,
        };
      }
      // Leave non-matching entries alone. listDLQForSession already scopes
      // to our own session, so these are messages genuinely addressed to us
      // that simply aren't the reply we're blocking on — deleting them here
      // would silently destroy traffic coms_get is expected to return.
    }
    await new Promise((r) => setTimeout(r, Math.min(AWAIT_POLL_MS, remaining)));
  }
  return {
    response: null,
    envelope: null,
    timed_out: true,
    waited_ms: Date.now() - start,
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
