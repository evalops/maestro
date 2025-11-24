import chalk from "chalk";
import type { AgentState, AssistantMessage } from "../agent/types.js";
import {
	brand,
	contextualBadge,
	metricStat,
	themePalette,
	separator as themedSeparator,
} from "../style/theme.js";
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
	const statsParts: string[] = [];
	if (stats.totalInput)
		statsParts.push(
			metricStat(
				"▲",
				themePalette.accentCool,
				formatTokenCount(stats.totalInput),
			),
		);
	if (stats.totalOutput)
		statsParts.push(
			metricStat(
				"▼",
				themePalette.accentWarm,
				formatTokenCount(stats.totalOutput),
			),
		);
	if (stats.totalCacheRead)
		statsParts.push(
			metricStat(
				"⟲",
				themePalette.cacheRead,
				formatTokenCount(stats.totalCacheRead),
			),
		);
	if (stats.totalCacheWrite)
		statsParts.push(
			metricStat(
				"⟳",
				themePalette.cacheWrite,
				formatTokenCount(stats.totalCacheWrite),
			),
		);
	if (stats.totalCost)
		statsParts.push(
			`${chalk.hex(themePalette.cost)("$")}${chalk
				.hex(themePalette.metric)
				.bold(stats.totalCost.toFixed(3))}`,
		);

	const contextValue = Number.parseFloat(stats.contextPercent);
	statsParts.push(
		contextualBadge("ctx", contextValue, { warn: 80, danger: 90 }),
	);

	const separator = themedSeparator();
	const statsLeft = statsParts.join(separator);
	const composerGlyph = brand.glyph();
	const composerBrand = `${composerGlyph} ${brand.text()}`;
	const tonedModel = chalk.hex(themePalette.model)(modelName);
	let rightSide = `${tonedModel} ${composerBrand}`;

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
			const fallbackSpace = width - statsLeftWidth - minPadding;
			rightSide = fallbackSpace > 0 ? composerBrand : composerGlyph;
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
