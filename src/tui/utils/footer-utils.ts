import { visibleWidth } from "@evalops/tui";
import chalk from "chalk";
import type { AgentState, AssistantMessage, Usage } from "../../agent/types.js";
import {
	badge,
	brand,
	metricStat,
	themePalette,
	separator as themedSeparator,
} from "../../style/theme.js";

export const CONTEXT_HINT_THRESHOLD = 70;
export const CONTEXT_HINT_WARN_GAP = 5;
export const CONTEXT_WARN_THRESHOLD =
	CONTEXT_HINT_THRESHOLD + CONTEXT_HINT_WARN_GAP;
export const CONTEXT_DANGER_THRESHOLD = 90;
const MIN_PADDING = 2;
const MODEL_BRAND_SEPARATOR_WIDTH = 1;
const MIN_MODEL_LABEL_CHARS = 3;

export const FOOTER_MIN_PADDING = MIN_PADDING;
export const FOOTER_MIN_MODEL_LABEL_CHARS = MIN_MODEL_LABEL_CHARS;
export const FOOTER_MODEL_BRAND_SEPARATOR_WIDTH = MODEL_BRAND_SEPARATOR_WIDTH;

export type FooterMode = "ensemble" | "solo";

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

export function formatModelLabel(
	state: Pick<AgentState, "model" | "thinkingLevel">,
): string {
	const modelId = state.model?.id ?? "no-model";
	if (!state.model?.reasoning) {
		return modelId;
	}
	const thinkingLevel = state.thinkingLevel || "off";
	return thinkingLevel === "off" ? modelId : `${modelId} • ${thinkingLevel}`;
}

export function resolveFooterHint(
	stats: FooterStats,
	explicitHint?: string | null,
): string | null {
	const shouldWarn =
		stats.contextWindow > 0 && stats.contextPercent >= CONTEXT_HINT_THRESHOLD;
	if (shouldWarn) {
		return `Context ${stats.contextPercent.toFixed(1)}% – run /compact to summarize`;
	}
	return explicitHint ?? null;
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

function buildContextBadge(stats: FooterStats): string {
	const contextValue = Number.isFinite(stats.contextPercent)
		? stats.contextPercent
		: 0;
	const variant =
		contextValue >= CONTEXT_DANGER_THRESHOLD
			? "danger"
			: contextValue >= CONTEXT_WARN_THRESHOLD
				? "warn"
				: "info";
	const tokensLabel = stats.contextWindow
		? `${formatTokenCount(stats.contextTokens)}/${formatTokenCount(stats.contextWindow)}`
		: formatTokenCount(stats.contextTokens);
	const contextLabel = `ctx ${tokensLabel} (${contextValue.toFixed(1)}%)`;
	return badge(contextLabel, undefined, variant);
}

function colorizeContextPercent(value: number): string {
	const label = `${value.toFixed(1)}%`;
	if (value >= CONTEXT_DANGER_THRESHOLD) {
		return chalk.hex(themePalette.danger)(label);
	}
	if (value >= CONTEXT_WARN_THRESHOLD) {
		return chalk.hex(themePalette.warning)(label);
	}
	return chalk.hex(themePalette.muted)(label);
}

function composeBrandLabel(modelLabel: string): {
	toned: string;
	brand: string;
	glyph: string;
} {
	const tonedModel = chalk.hex(themePalette.model)(modelLabel);
	const glyph = brand.glyph();
	const brandLabel = `${glyph} ${brand.text()}`;
	return { toned: tonedModel, brand: brandLabel, glyph };
}

export function truncateModelLabel(label: string, targetWidth: number): string {
	if (targetWidth <= 0) return "";
	if (visibleWidth(label) <= targetWidth) {
		return label;
	}
	let result = label;
	while (visibleWidth(result) > targetWidth && result.length > 0) {
		result = result.slice(0, -1);
	}
	return result.trimEnd();
}

export function buildStatsLine(
	stats: FooterStats,
	width: number,
	state: Pick<AgentState, "model" | "thinkingLevel">,
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

	statsParts.push(buildContextBadge(stats));
	const separator = themedSeparator();
	const statsLeft = statsParts.join(separator);
	const modelLabel = formatModelLabel(state);
	const {
		toned,
		brand: composerBrand,
		glyph: composerGlyph,
	} = composeBrandLabel(modelLabel);
	let rightSide = `${toned} ${composerBrand}`;

	const statsLeftWidth = visibleWidth(statsLeft);
	const rightWidth = visibleWidth(rightSide);
	const totalNeeded = statsLeftWidth + MIN_PADDING + rightWidth;

	if (totalNeeded > width) {
		const brandWidth = visibleWidth(composerBrand);
		const availableForModel =
			width -
			statsLeftWidth -
			MIN_PADDING -
			brandWidth -
			MODEL_BRAND_SEPARATOR_WIDTH;
		if (availableForModel > MIN_MODEL_LABEL_CHARS) {
			const truncated = truncateModelLabel(modelLabel, availableForModel);
			const tonedTruncated = chalk.hex(themePalette.model)(truncated);
			rightSide = `${tonedTruncated} ${composerBrand}`;
		} else if (width - statsLeftWidth - MIN_PADDING >= brandWidth) {
			rightSide = composerBrand;
		} else {
			const fallbackSpace = width - statsLeftWidth - MIN_PADDING;
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

export function buildSoloStatsLine(
	stats: FooterStats,
	width: number,
	state: Pick<AgentState, "model" | "thinkingLevel">,
): string {
	const statsParts: string[] = [];
	if (stats.totalInput)
		statsParts.push(`↑${formatTokenCount(stats.totalInput)}`);
	if (stats.totalOutput)
		statsParts.push(`↓${formatTokenCount(stats.totalOutput)}`);
	if (stats.totalCacheRead)
		statsParts.push(`R${formatTokenCount(stats.totalCacheRead)}`);
	if (stats.totalCacheWrite)
		statsParts.push(`W${formatTokenCount(stats.totalCacheWrite)}`);
	if (stats.totalCost) statsParts.push(`$${stats.totalCost.toFixed(3)}`);

	const contextValue = Number.isFinite(stats.contextPercent)
		? stats.contextPercent
		: 0;
	statsParts.push(colorizeContextPercent(contextValue));
	const statsLeft = statsParts.join(" ");
	const rightSide = formatModelLabel(state);
	if (!rightSide) {
		return statsLeft;
	}
	const statsLeftWidth = visibleWidth(statsLeft);
	const rightWidth = visibleWidth(rightSide);
	const totalNeeded = statsLeftWidth + MIN_PADDING + rightWidth;

	if (totalNeeded <= width) {
		const padding = " ".repeat(
			Math.max(MIN_PADDING, width - statsLeftWidth - rightWidth),
		);
		return statsLeft + padding + rightSide;
	}

	const availableForRight = width - statsLeftWidth - MIN_PADDING;
	if (availableForRight > MIN_MODEL_LABEL_CHARS) {
		const truncated = truncateModelLabel(rightSide, availableForRight);
		const padding = " ".repeat(
			Math.max(MIN_PADDING, width - statsLeftWidth - visibleWidth(truncated)),
		);
		return statsLeft + padding + truncated;
	}
	return statsLeft;
}
