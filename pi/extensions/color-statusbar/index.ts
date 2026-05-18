/**
 * Claude-style Status Bar Extension
 *
 * Replicates the Claude Code status line appearance in pi using native TypeScript.
 * Provides a two-line status display in the footer.
 *
 * Layout:
 *   Line 1: /path/to/cwd (branch) [flags] | model • effort ~thinking
 *   Line 2: ↑tok ↓tok Rcache $cost ctx %/size | [extension statuses]
 *
 * Install: Copy to ~/.pi/agent/extensions/claude-statusbar/index.ts
 * Reload:  /reload
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, Theme } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";

interface TokenStats {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

interface FooterState {
	tokens: TokenStats;
	contextPct: number;
	contextSize: number;
	gitFlags: string;
}

// Format number as compact k-suffix string (like bash script)
// 1000+ shows "1.5k", 10k+ shows "15k", 100k+ shows "150k"
function fmtK(n: number): string {
	if (n >= 1000) {
		const k = n / 1000;
		if (k >= 100) return `${Math.round(k)}k`;
		if (k >= 10) return `${Math.round(k)}k`;
		// Show one decimal: 1.5k, but 1.0k becomes 1k
		const formatted = k.toFixed(1);
		return formatted.endsWith(".0k") ? `${Math.round(k)}k` : formatted;
	}
	return `${n}`;
}

// Get color key based on percentage thresholds
// 80%+ = red (error), 50%+ = yellow (warning), else = dim
function getPctColorKey(pct: number): string {
	if (pct >= 80) return "error";
	if (pct >= 50) return "warning";
	return "dim";
}

// Get color key for effort levels
function getEffortColorKey(effort: string): string {
	switch (effort) {
		case "low":    return "dim";
		case "medium": return "warning";
		case "high":   return "warning"; // orange in original, using warning
		case "xhigh":  return "error";
		case "max":    return "error";
		default:       return "dim";
	}
}

// Truncate string to width, appending ellipsis if needed
function fitToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "…");
}

// Format thinking level for display
function formatEffort(level: string): string {
	switch (level) {
		case "minimal": return "min";
		case "xhigh":   return "xhigh";
		case "max":     return "max";
		default:        return level;
	}
}

// Fetch git status flags asynchronously
async function fetchGitFlags(pi: ExtensionAPI, cwd: string, tui: TUI, state: FooterState): Promise<void> {
	try {
		const result = await pi.exec("git", ["status", "--porcelain"], { cwd, timeout: 2000 });
		const stdout = result?.stdout ?? "";
		let flags = "";
		// Staged changes: +, Modified in index: !, Untracked: ?
		if (/^[MADRC]/m.test(stdout)) flags += "+";
		if (/^.[MD]/m.test(stdout)) flags += "!";
		if (/\?\?/m.test(stdout)) flags += "?";
		state.gitFlags = flags;
		tui.requestRender();
	} catch {
		// Ignore git errors
	}
}

// Update token stats from session branch
function updateTokens(ctx: ExtensionContext, state: FooterState): void {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const m = entry.message as AssistantMessage;
			input += m.usage.input;
			output += m.usage.output;
			cacheRead += m.usage.cacheRead ?? 0;
			cost += m.usage.cost.total ?? 0;
		}
	}

	state.tokens = { input, output, cacheRead, cost };
}

export default function (pi: ExtensionAPI) {
	// State shared across renders
	const state: FooterState = {
		tokens: { input: 0, output: 0, cacheRead: 0, cost: 0 },
		contextPct: 0,
		contextSize: 0,
		gitFlags: "",
	};

	// ============================================
	// Session lifecycle events
	// ============================================

	pi.on("session_start", async (_event, ctx) => {
		updateTokens(ctx, state);
		// Initial git status fetch
		void fetchGitFlags(pi, ctx.cwd, ctx.ui as unknown as TUI, state);
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateTokens(ctx, state);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") {
			updateTokens(ctx, state);
			const usage = ctx.getContextUsage();
			if (usage) {
				state.contextPct = usage.percent ?? 0;
				state.contextSize = usage.contextWindow ?? 0;
			}
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const usage = ctx.getContextUsage();
		if (usage) {
			state.contextPct = usage.percent ?? 0;
			state.contextSize = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
		}
	});

	// ============================================
	// Custom footer rendering
	// ============================================

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
			// Subscribe to git branch changes to trigger re-render
			const unsub = footerData.onBranchChange(() => {
				void fetchGitFlags(pi, ctx.cwd, tui, state);
				tui.requestRender();
			});

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					// ============================================
					// LINE 1: /path/to/cwd (branch) [flags] | model • effort ~thinking
					// ============================================

					// CWD with ~ substitution for home
					const home = process.env.HOME ?? "";
					let cwd = ctx.cwd;
					if (home && cwd.startsWith(home)) {
						cwd = `~${cwd.slice(home.length)}`;
					}

					let line1 = theme.fg("success", theme.bold(cwd));

					// Git branch
					const branch = footerData.getGitBranch();
					if (branch) {
						line1 += ` ${theme.fg("warning", `(${branch})`)}`;

						// Git status flags
						if (state.gitFlags) {
							line1 += ` ${theme.fg("warning", `[${state.gitFlags}]`)}`;
						}
					}

					// Model name (use accent for cyan-like color from original)
					if (ctx.model) {
						const modelName = ctx.model.displayName ?? ctx.model.id;
						line1 += `  |  ${theme.fg("accent", theme.bold(modelName))}`;
					}

					// Effort level
					const effort = pi.getThinkingLevel();
					if (effort && effort !== "off") {
						const effStr = formatEffort(effort);
						const effColor = getEffortColorKey(effort);
						line1 += ` ${theme.fg("dim", "•")} ${theme.fg(effColor, effStr)}`;
					}

					// Thinking indicator (only for higher levels)
					if (effort && effort !== "off" && effort !== "minimal" && effort !== "low") {
						line1 += ` ${theme.fg("accent", "~thinking")}`;
					}

					// ============================================
					// LINE 2: ↑tok ↓tok Rcache $cost ctx %/size [extension statuses]
					// ============================================

					const { input, output, cacheRead, cost } = state.tokens;
					const ctxPct = Math.round(state.contextPct);
					const ctxSize = state.contextSize;
					const ctxColor = getPctColorKey(ctxPct);

					const fmtInput = fmtK(input);
					const fmtOutput = fmtK(output);
					const fmtCache = fmtK(cacheRead);
					const fmtCtx = fmtK(ctxSize);

					// Use accent for arrow symbols (cyan from original)
					let line2 = `${theme.fg("accent", `↑${fmtInput}`)} `;
					// Use accent for down arrow too
					line2 += `${theme.fg("accent", `↓${fmtOutput}`)} `;
					// Rcache in dim gray
					line2 += `${theme.fg("dim", `R${fmtCache}`)} `;
					// Cost in success green
					line2 += `${theme.fg("success", `$${cost.toFixed(3)}`)} `;
					// Context %/size with color based on percentage
					line2 += `ctx ${theme.fg(ctxColor, `${ctxPct}%`)}${theme.fg("dim", `/${fmtCtx}`)}`;

					// Include extension statuses from setStatus()
					const extStatuses = footerData.getExtensionStatuses();
					if (extStatuses.size > 0) {
						const statusParts: string[] = [];
						for (const [key, value] of extStatuses) {
							if (key !== "model") {
								statusParts.push(theme.fg("muted", value));
							}
						}
						if (statusParts.length > 0) {
							line2 += `  | ${statusParts.join(" · ")}`;
						}
					}

					// Truncate both lines to fit terminal width
					line1 = fitToWidth(line1, width);
					line2 = fitToWidth(line2, width);

					return [line1, line2];
				},
			};
		});
	});
}
