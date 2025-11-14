import chalk from "chalk";
import type { AgentState, AssistantMessage } from "../agent/types.js";
import { visibleWidth } from "../tui-lib/index.js";

export interface FooterStats {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	contextPercent: string;
	lastAssistant?: AssistantMessage;
}

export function calculateFooterStats(state: AgentState): FooterStats {
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;

	for (const message of state.messages) {
		if (message.role === "assistant") {
			const assistantMsg = message as AssistantMessage;
			totalInput += assistantMsg.usage.input;
			totalOutput += assistantMsg.usage.output;
			totalCacheRead += assistantMsg.usage.cacheRead;
			totalCacheWrite += assistantMsg.usage.cacheWrite;
			totalCost += assistantMsg.usage.cost.total;
		}
	}

	const lastAssistant = state.messages
		.slice()
		.reverse()
		.find(
			(m) =>
				m.role === "assistant" &&
				(m as AssistantMessage).stopReason !== "aborted",
		) as AssistantMessage | undefined;

	const contextTokens = lastAssistant
		? lastAssistant.usage.input +
			lastAssistant.usage.output +
			lastAssistant.usage.cacheRead +
			lastAssistant.usage.cacheWrite
		: 0;
	const contextWindow = state.model.contextWindow;
	const contextPercent =
		contextWindow > 0
			? ((contextTokens / contextWindow) * 100).toFixed(1)
			: "0.0";

	return {
		totalInput,
		totalOutput,
		totalCacheRead,
		totalCacheWrite,
		totalCost,
		contextPercent,
		lastAssistant,
	};
}

export function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

export function formatPath(path: string, width: number): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	let pwd = path;
	if (home && pwd.startsWith(home)) {
		pwd = `~${pwd.slice(home.length)}`;
	}
	const maxPathLength = Math.max(20, width - 10);
	if (visibleWidth(pwd) <= maxPathLength) {
		return pwd;
	}
	const start = pwd.slice(0, Math.floor(maxPathLength / 2) - 2);
	const end = pwd.slice(-(Math.floor(maxPathLength / 2) - 1));
	return `${start}...${end}`;
}

export function buildStatsLine(
	stats: FooterStats,
	width: number,
	modelName: string,
): string {
	const statsParts = [];
	if (stats.totalInput)
		statsParts.push(
			`${chalk.hex("#9ad5ff")("▲")} ${formatTokenCount(stats.totalInput)}`,
		);
	if (stats.totalOutput)
		statsParts.push(
			`${chalk.hex("#f7b267")("▼")} ${formatTokenCount(stats.totalOutput)}`,
		);
	if (stats.totalCacheRead)
		statsParts.push(
			`${chalk.hex("#c1ffd7")("⟲")} ${formatTokenCount(stats.totalCacheRead)}`,
		);
	if (stats.totalCacheWrite)
		statsParts.push(
			`${chalk.hex("#f7b7c3")("⟳")} ${formatTokenCount(stats.totalCacheWrite)}`,
		);
	if (stats.totalCost)
		statsParts.push(
			`${chalk.hex("#ffd6a5")("$")}${stats.totalCost.toFixed(3)}`,
		);

	const contextValue = Number.parseFloat(stats.contextPercent);
	const contextBadgeColor = contextValue >= 80 ? "#ff6b6b" : "#a0aec0";
	statsParts.push(chalk.hex(contextBadgeColor)(`ctx ${stats.contextPercent}%`));

	const statsLeft = statsParts.join(" ");
	const composerBrand = chalk.hex("#7c3aed")("♪ composer");
	let rightSide = `${modelName} ${composerBrand}`;

	const statsLeftWidth = visibleWidth(statsLeft);
	const rightWidth = visibleWidth(rightSide);
	const minPadding = 2;
	const totalNeeded = statsLeftWidth + minPadding + rightWidth;

	if (totalNeeded > width) {
		const brandWidth = visibleWidth(composerBrand);
		const availableForModel =
			width - statsLeftWidth - minPadding - brandWidth - 1;
		if (availableForModel > 3) {
			const truncated = modelName.substring(0, availableForModel);
			rightSide = `${truncated} ${composerBrand}`;
		} else if (width - statsLeftWidth - minPadding >= brandWidth) {
			rightSide = composerBrand;
		} else {
			rightSide = "";
		}
	}

	if (!rightSide) {
		return statsLeft;
	}
	const padding = " ".repeat(
		Math.max(0, width - statsLeftWidth - visibleWidth(rightSide)),
	);
	return statsLeft + padding + rightSide;
}
