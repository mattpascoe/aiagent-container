/**
 * CPU Monitor Extension
 *
 * Shows CPU usage in the bottom status bar, updating every 5 seconds.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";

export default function (pi: ExtensionAPI) {
	let updateInterval: ReturnType<typeof setInterval> | undefined;
	let lastCpuInfo = os.cpus();
	let lastIdleTime = 0;
	let lastTotalTime = 0;

	// Calculate CPU usage between intervals
	const getCpuUsage = (): number => {
		const cpus = os.cpus();
		let totalIdle = 0;
		let totalTick = 0;

		for (const cpu of cpus) {
			for (const type in cpu.times) {
				// @ts-expect-error - dynamic property access
				totalTick += cpu.times[type];
			}
			totalIdle += cpu.times.idle;
		}

		const idleDiff = totalIdle - lastIdleTime;
		const totalDiff = totalTick - lastTotalTime;

		lastIdleTime = totalIdle;
		lastTotalTime = totalTick;
		lastCpuInfo = cpus;

		if (totalDiff === 0) return 0;

		const usage = 100 - (100 * idleDiff) / totalDiff;
		return Math.round(usage);
	};

	// Update the status bar with current CPU usage
	const updateStatus = (ctx: Parameters<Parameters<typeof ctx.ui.setStatus>[1]>[0]) => {
		const cpuCount = os.cpus().length;
		const usage = getCpuUsage();

		// Simple plain text first
		const cpuText = `CPU: ${usage}% (${cpuCount} cores)`;
		ctx.ui.setStatus("cpu-monitor", cpuText);
	};

	pi.on("session_start", async (_event, ctx) => {
		// Initialize CPU baseline
		lastCpuInfo = os.cpus();
		let totalIdle = 0;
		let totalTick = 0;
		for (const cpu of lastCpuInfo) {
			for (const type in cpu.times) {
				// @ts-expect-error - dynamic property access
				totalTick += cpu.times[type];
			}
			totalIdle += cpu.times.idle;
		}
		lastIdleTime = totalIdle;
		lastTotalTime = totalTick;

		// Initial status
		updateStatus(ctx);

		// Update every 5 seconds
		updateInterval = setInterval(() => {
			updateStatus(ctx);
		}, 5000);
	});

	pi.on("session_shutdown", () => {
		if (updateInterval) {
			clearInterval(updateInterval);
			updateInterval = undefined;
		}
	});
}
