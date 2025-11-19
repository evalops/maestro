import { visibleWidth } from "@evalops/tui";
import chalk from "chalk";
import type { AgentState, AssistantMessage, Usage } from "../agent/types.js";
import {
	badge,
	brand,
	metricStat,
	themePalette,
	separator as themedSeparator,
} from "../style/theme.js";

export interface FooterStats {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	contextTokens: number;
	contextWindow: number;
	contextPercent: number;
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
			const usage = normalizeUsage(assistantMsg.usage);
			totalInput += usage.input;
			totalOutput += usage.output;
			totalCacheRead += usage.cacheRead;
			totalCacheWrite += usage.cacheWrite;
			totalCost += usage.cost.total;
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

	// Calculate context percentage: last turn's input (fresh + cached) + all accumulated outputs
	// This represents the actual conversation size, not the sum of all API calls
	const lastUsage = normalizeUsage(lastAssistant?.usage);
	const contextTokens = Math.max(
		0,
		lastUsage.input + lastUsage.cacheRead + totalOutput,
	);
	const contextWindow = state.model.contextWindow ?? 0;
	const contextPercent =
		contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

	return {
		totalInput,
		totalOutput,
		totalCacheRead,
		totalCacheWrite,
		totalCost,
		contextTokens,
		contextWindow,
		contextPercent,
		lastAssistant,
	};
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

export function normalizeUsage(usage?: Usage): Usage {
	if (!usage) {
		return ZERO_USAGE;
	}
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		cost: {
			input: usage.cost?.input ?? 0,
			output: usage.cost?.output ?? 0,
			cacheRead: usage.cost?.cacheRead ?? 0,
			cacheWrite: usage.cost?.cacheWrite ?? 0,
			total: usage.cost?.total ?? 0,
		},
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

	const contextValue = Number.isFinite(stats.contextPercent)
		? stats.contextPercent
		: 0;
	const warnThreshold = 75;
	const dangerThreshold = 90;
	const variant =
		contextValue >= dangerThreshold
			? "danger"
			: contextValue >= warnThreshold
				? "warn"
				: "info";
	const tokensLabel = stats.contextWindow
		? `${formatTokenCount(stats.contextTokens)}/${formatTokenCount(stats.contextWindow)}`
		: formatTokenCount(stats.contextTokens);
	const contextLabel = `ctx ${tokensLabel} (${contextValue.toFixed(1)}%)`;
	statsParts.push(badge(contextLabel, undefined, variant));

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
