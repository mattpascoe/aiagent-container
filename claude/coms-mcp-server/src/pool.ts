#!/usr/bin/env node
/**
 * Render the coms peer pool as status-line rows.
 *
 * Claude Code exposes no widget API to MCP servers or hooks, so the only
 * ambient surface for this is the status line: a command whose stdout becomes
 * one row per line. `~/.claude/statusline.sh` invokes us and prints our output
 * above its own two lines.
 *
 * Deliberately heartbeat-driven, not ping-driven. The pi side pings every peer
 * to build live cards; we don't, because peers rewrite their registry entry
 * every 10s and those entries already carry `context_used_pct` and
 * `queue_depth`. Reading a handful of small JSON files gives us everything a
 * ping would, with no UDS traffic from a script that runs every 5 seconds.
 * Freshness is bounded at roughly 15s, which is fine for an at-a-glance view.
 *
 * Prints nothing at all (exit 0) when the coms layer isn't running, so the
 * status line collapses back to its normal two lines.
 */
import {
  readAllRegistryEntries,
  readAllPendingSends,
  isEntryLive,
  registryFilePath,
  type RegistryEntry,
  type PendingSendEntry,
} from "../../../src/coms-protocol/index.js";
import { resolveIdentity } from "./identity.js";

/** Heartbeat age beyond which a peer is shown as stale. Matches coms_list. */
const STALE_MS = 30_000;

/**
 * Age beyond which a pending-send record is treated as if it didn't exist,
 * even if its file hasn't been pruned yet (`sendPrompt()` prunes on its own
 * cadence, not on ours). This is the actual guarantee against showing a
 * "processing"/"waiting" badge forever for a request the agent walked away
 * from — the file-level prune is just hygiene.
 */
const PENDING_STALE_MS = 10 * 60_000;

/** Nerd-font glyphs for the three pending-request states. Same codepoints the
 * Pi-side widget uses, so the two adapters read consistently. */
const GLYPH_WAITING = ""; // clock — sent, no confirmation of peer activity yet
const GLYPH_PROCESSING = ""; // spinner — peer's own queue_depth confirms it's busy
const GLYPH_UNREACHABLE = ""; // warning triangle — pending request, peer heartbeat stale

const FG_DIM = "\x1b[2;37m";
const FG_YELLOW = "\x1b[93m";
const FG_RED = "\x1b[91m";

/** Width of the context-usage bar, in characters. */
const BAR_WIDTH = 12;

/**
 * Default foreground for the box: border, and any text without a colour of
 * its own. Peer names and bars keep their per-peer colour, so identity still
 * reads at a glance.
 *
 * Re-applied after every per-peer span, because hexFg closes with \x1b[39m
 * (reset to the terminal's default foreground) rather than back to ours.
 */
const LG = "\x1b[92m";
/** Full reset, ending each line so colour can't bleed into the next row. */
const OFF = "\x1b[0m";

const FALLBACK_PALETTE = [
  "#36F9F6",
  "#FF8B39",
  "#FEDE5D",
  "#E06C75",
  "#98C379",
  "#C678DD",
  "#61AFEF",
];

/**
 * Colour `s` with a truecolor foreground escape.
 *
 * The invalid-hex guard is load-bearing: without it a missing or malformed
 * colour yields NaN channels and emits "\x1b[38;2;NaN;NaN;NaNm", which the
 * terminal renders as literal "aN;NaN;NaNm" before the text. That was a real
 * bug on the pi side, caused by peers publishing color:"" — exactly what our
 * own adapter used to do.
 */
function hexFg(hex: string | undefined, s: string): string {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return s;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
}

/** Deterministic colour for peers that publish none, so rows stay stable. */
function fallbackColor(sessionId: string): string {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) {
    h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

/** Trim vendor prefixes so the model column stays legible in a narrow row. */
function abbreviateModel(model: string, max = 18): string {
  // Peers that don't populate `model` would otherwise render as blank padding.
  if (!model) return "unknown";
  let m = model;
  const slash = m.lastIndexOf("/");
  if (slash >= 0) m = m.slice(slash + 1);
  if (m.startsWith("claude-")) m = m.slice("claude-".length);
  if (m.startsWith("gpt-")) m = m.slice("gpt-".length);
  return m.length > max ? m.slice(0, max) : m;
}

/** Printable width, ignoring ANSI escapes so colour never inflates the count. */
function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Truncate to `max` printable columns, preserving escapes already emitted. */
function truncateToWidth(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  let i = 0;
  while (i < s.length) {
    const esc = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    if (w >= max - 1) break;
    out += s[i];
    w++;
    i++;
  }
  // Reset so a truncated row can't leak colour into the next line.
  return `${out}…${OFF}`;
}

function pad(s: string, n: number): string {
  const w = visibleWidth(s);
  return w >= n ? s : s + " ".repeat(n - w);
}

function main(): void {
  const ident = resolveIdentity();

  let entries: RegistryEntry[];
  try {
    entries = readAllRegistryEntries(ident.coms_dir, ident.project);
  } catch {
    return; // no coms dir / unreadable — render nothing
  }

  // Gate: we only draw the box if OUR listener is registered. That is the
  // signal that the coms layer is actually running in this container; without
  // it there is nothing meaningful to show and the status line stays at two
  // lines. Cheap because the same read serves the peer list below.
  const self = entries.find((e) => e.container_id === ident.container_id);
  if (!self) return;

  const peers = entries
    .filter((e) => e.container_id !== ident.container_id)
    .filter((e) => !e.explicit)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Our own outbound requests still awaiting a reply, keyed by target. Only
  // ours (sender_container_id === us) — never render another agent's pending
  // state as if it were this session's.
  let pendingSends: PendingSendEntry[] = [];
  try {
    pendingSends = readAllPendingSends(ident.coms_dir, ident.project).filter(
      (p) =>
        p.sender_container_id === ident.container_id &&
        Date.now() - Date.parse(p.sent_at) <= PENDING_STALE_MS,
    );
  } catch {
    pendingSends = [];
  }
  const pendingByTargetContainer = new Map<string, PendingSendEntry>();
  for (const p of pendingSends) {
    const existing = pendingByTargetContainer.get(p.target_container_id);
    if (!existing || Date.parse(p.sent_at) < Date.parse(existing.sent_at)) {
      pendingByTargetContainer.set(p.target_container_id, p);
    }
  }

  const width = Number(process.env.COLUMNS) || 80;
  // Four-column margin: the status line composites our rows into its own
  // frame with its own padding, so a box sized to the raw terminal width
  // overflows and wraps. Two proved too tight in practice.
  const safeWidth = Math.max(24, width - 4);

  // Column widths adapt to the terminal. The row is otherwise a fixed ~70
  // columns, so on a narrower terminal every row hit the truncator and ended
  // in an ellipsis — shrinking the box alone can't fix that, since the box is
  // not what overflows. Drop the least informative column (the container id
  // hex) first, then tighten name and model.
  const showContainer = safeWidth >= 76;
  const nameW = safeWidth >= 64 ? 15 : 12;
  const modelW = safeWidth >= 76 ? 18 : safeWidth >= 64 ? 12 : 8;

  const label = `┏━ coms [${ident.project}] `;
  const topDashes = Math.max(0, safeWidth - visibleWidth(label) - 1);
  const top = LG + label + "━".repeat(topDashes) + "┓" + OFF;
  const bottom = LG + "┗" + "━".repeat(Math.max(0, safeWidth - 2)) + "┛" + OFF;

  const lines: string[] = [top];

  if (peers.length === 0) {
    lines.push(truncateToWidth(`${LG}  no peers connected${OFF}`, safeWidth));
  } else {
    for (const p of peers) {
      // Pass the entry's own file path: isEntryLive falls back to mtime when
      // heartbeat_at is missing or unparseable.
      const live = isEntryLive(
        p,
        registryFilePath(ident.coms_dir, ident.project, p.name),
        { staleMs: STALE_MS },
      );
      const swatch = live ? "●" : "✗";
      const color =
        p.color && /^#[0-9a-fA-F]{6}$/.test(p.color)
          ? p.color
          : fallbackColor(p.session_id);

      // Absent means unknown, per the optional-field rule in the protocol
      // README. Render "--%" — never substitute 0, which reads as "idle".
      const pct =
        typeof p.context_used_pct === "number" ? p.context_used_pct : null;
      const pctStr = pct == null ? " --%" : `${String(pct).padStart(3)}%`;

      const filled =
        pct == null
          ? 0
          : Math.max(0, Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH)));
      // LG after each hexFg span: hexFg closes with \x1b[39m (terminal
      // default), which would otherwise drop the rest of the row back to the
      // theme's foreground instead of the box's green.
      const bar =
        pct == null
          ? "-".repeat(BAR_WIDTH)
          : hexFg(color, "#".repeat(filled)) + LG + "-".repeat(BAR_WIDTH - filled);

      const namePart = hexFg(color, pad(p.name.slice(0, nameW), nameW)) + LG;
      const containerPart = showContainer
        ? ` ${pad(p.container_id ? `(${p.container_id.slice(0, 8)})` : "", 10)}`
        : "";
      const modelPart = pad(abbreviateModel(p.model, modelW), modelW);

      // Badge for "we have a request pending with this peer". Absent
      // pendingByTargetContainer entry => no badge at all, unchanged row —
      // never show activity for a peer we haven't actually messaged.
      let badge = "";
      const pending = pendingByTargetContainer.get(p.container_id);
      if (pending) {
        if (!live) {
          badge = ` ${FG_RED}${GLYPH_UNREACHABLE}${LG}`;
        } else if (typeof p.queue_depth === "number" && p.queue_depth > 0) {
          // Corroborated by the peer's own heartbeat-published queue_depth —
          // the only genuinely real "actively processing" signal available.
          badge = ` ${FG_YELLOW}${GLYPH_PROCESSING}${LG}`;
        } else {
          badge = ` ${FG_DIM}${GLYPH_WAITING}${LG}`;
        }
      }

      // Badge sits before the free-text purpose column, not after: on a
      // narrow terminal truncateToWidth cuts off the tail of the row, and
      // purpose (variable-length, least load-bearing) should be what gets
      // eaten, not a fixed-width status signal.
      const row = `${LG} ${swatch} ${namePart}${containerPart} ${modelPart} [${bar}] ${pctStr}${badge}  ${p.purpose || ""}${OFF}`;
      lines.push(truncateToWidth(row, safeWidth));
    }
  }

  lines.push(bottom);
  for (const l of lines) process.stdout.write(l + "\n");
}

try {
  main();
} catch {
  // A status line must never emit noise. Silence beats a stack trace in the
  // user's terminal on every refresh tick.
  process.exit(0);
}
