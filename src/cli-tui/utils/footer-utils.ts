/**
 * Footer Utilities - Terminal footer bar layout and rendering
 *
 * This module handles the complex layout calculations needed to render an
 * informative footer bar in varying terminal widths. The footer displays:
 * - Brand/model information
 * - Token usage statistics
 * - Context window utilization
 * - Cost tracking
 * - Current working path with git branch
 * - Stage indicators (thinking, working, etc.)
 *
 * ## Layout Philosophy
 *
 * The footer uses a **priority-based truncation** system. As terminal width
 * decreases, lower-priority elements are dropped or truncated first:
 *
 * 1. Full layout: All stats + model + brand
 * 2. Drop brand, keep model
 * 3. Truncate model name
 * 4. Stats only
 *
 * ## Width Calculation Challenges
 *
 * Terminal width calculation must account for:
 * - ANSI escape sequences (colors, bold) that consume bytes but not visual space
 * - Unicode characters that may be wider than expected (emoji, CJK)
 * - Combining characters and zero-width joiners
 *
 * We use `visibleWidth()` from @evalops/tui for accurate measurements.
 *
 * ## Zone-Based Layout
 *
 * The footer is divided into "zones" with percentage-based width allocation:
 * - Badge zone: 25% for stage labels and runtime badges
 * - Path zone: Remaining space for working directory
 * - Stats zone: Right-aligned usage metrics
 *
 * Minimum widths ensure each zone remains readable even in narrow terminals.
 *
 * @module tui/utils/footer-utils
 */

import { visibleWidth } from "@evalops/tui";
import chalk from "chalk";
import type { AgentState, AssistantMessage, Usage } from "../../agent/types.js";
import {
	brand,
	metricStat,
	themePalette,
	separator as themedSeparator,
} from "../../style/theme.js";
import { getHomeDir } from "../../utils/path-expansion.js";
import {
	buildContextBadge,
	buildContextBar,
	colorizeContextPercent,
	composeBrandLabel,
} from "./footer-visual-widgets.js";
import { shimmerText } from "./shimmer.js";
import { STAGE_SHIMMER_OPTIONS } from "./stage-labels.js";

// Re-export extracted modules for backward compatibility
export { GitBranchTracker } from "./git-branch-tracker.js";
export {
	buildContextBar,
	buildCostSparkline,
	buildGitStatusGlyph,
	composeBrandLabel,
	formatRelativeTime,
	type GitStatusType,
} from "./footer-visual-widgets.js";

export const CONTEXT_HINT_THRESHOLD = 70;
export const CONTEXT_HINT_WARN_GAP = 5;
export const CONTEXT_WARN_THRESHOLD =
	CONTEXT_HINT_THRESHOLD + CONTEXT_HINT_WARN_GAP;
export const CONTEXT_DANGER_THRESHOLD = 90;
const MIN_PADDING = 2;
const MODEL_BRAND_SEPARATOR_WIDTH = 1;
const MIN_MODEL_LABEL_CHARS = 3;
const BADGE_ZONE_MIN_WIDTH = 15;
const PATH_ZONE_MIN_WIDTH = 20;
const BADGE_ZONE_PERCENT = 0.25;
const TRUNCATION_ELLIPSIS = "…";
export const FOOTER_MIN_PADDING = MIN_PADDING;
export const FOOTER_MIN_MODEL_LABEL_CHARS = MIN_MODEL_LABEL_CHARS;
export const FOOTER_MODEL_BRAND_SEPARATOR_WIDTH = MODEL_BRAND_SEPARATOR_WIDTH;

const ANSI_STRING_TERMINATORS = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const ANSI_OSC_SEQUENCE = `(?:\\u001B\\][\\s\\S]*?${ANSI_STRING_TERMINATORS})`;
const ANSI_CSI_SEQUENCE =
	"[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
const ANSI_ESCAPE_SEQUENCE = new RegExp(
	`${ANSI_OSC_SEQUENCE}|${ANSI_CSI_SEQUENCE}`,
	"g",
);

/**
 * Build a horizontal rule line using box-drawing characters.
 */
export function buildHorizontalRule(width: number): string {
	if (width <= 0) return "";
	return chalk.hex(themePalette.dim)("─".repeat(width));
}

/**
 * Build the brand line: `* composer` on left, model name on right
 */
export function buildBrandLine(
	width: number,
	state: Pick<AgentState, "model" | "thinkingLevel">,
): string {
	const glyph = brand.glyph();
	const name = brand.text();
	const brandLeft = `${glyph} ${name}`;
	const brandLeftWidth = visibleWidth(brandLeft);

	const modelLabel = formatModelLabel(state);
	const modelRight = chalk.hex(themePalette.model)(modelLabel);
	const modelRightWidth = visibleWidth(modelRight);

	const totalNeeded = brandLeftWidth + MIN_PADDING + modelRightWidth;
	if (totalNeeded <= width) {
		const padding = " ".repeat(
			Math.max(0, width - brandLeftWidth - modelRightWidth),
		);
		return `${brandLeft}${padding}${modelRight}`;
	}

	// Truncate model if needed
	const availableForModel = width - brandLeftWidth - MIN_PADDING;
	if (availableForModel > MIN_MODEL_LABEL_CHARS) {
		const truncated = truncateModelLabel(modelLabel, availableForModel);
		const truncatedColored = chalk.hex(themePalette.model)(truncated);
		const padding = " ".repeat(
			Math.max(0, width - brandLeftWidth - visibleWidth(truncatedColored)),
		);
		return `${brandLeft}${padding}${truncatedColored}`;
	}

	// Just brand if model doesn't fit
	return brandLeft;
}

/**
 * Build the path and stats line with pipe separators.
 * Format: ~/project (main)       +1.2k  -500  ~3.2k  |  ctx 2.3%  |  $0.04
 */
export function buildPathAndStatsLine(
	cwd: string,
	stats: FooterStats,
	width: number,
	branch: string | null,
	stageLabel: string | null,
): string {
	const pipeSep = chalk.hex(themePalette.dim)(" | ");

	// Build right side: token stats | ctx % | cost
	const statsParts: string[] = [];
	if (stats.totalInput)
		statsParts.push(
			`${chalk.hex(themePalette.accentCool)("+")}${chalk
				.hex(themePalette.text)
				.bold(formatTokenCount(stats.totalInput))}`,
		);
	if (stats.totalOutput)
		statsParts.push(
			`${chalk.hex(themePalette.accentWarm)("-")}${chalk
				.hex(themePalette.text)
				.bold(formatTokenCount(stats.totalOutput))}`,
		);
	if (stats.totalCacheRead)
		statsParts.push(
			`${chalk.hex(themePalette.cacheRead)("~")}${chalk
				.hex(themePalette.text)
				.bold(formatTokenCount(stats.totalCacheRead))}`,
		);

	const tokensGroup = statsParts.join("  ");
	// Context bar with visual progress indicator
	const contextPercent =
		stats.contextWindow > 0
			? `${buildContextBar(stats.contextPercent, 8)} ${colorizeContextPercent(stats.contextPercent)}`
			: "";
	const costLabel =
		stats.totalCost > 0
			? `${chalk.hex(themePalette.cost)("$")}${chalk
					.hex(themePalette.metric)
					.bold(stats.totalCost.toFixed(2))}`
			: "";

	const rightParts: string[] = [];
	if (tokensGroup) rightParts.push(tokensGroup);
	if (contextPercent) rightParts.push(contextPercent);
	if (costLabel) rightParts.push(costLabel);
	const rightSide = rightParts.join(pipeSep);
	const rightSideWidth = visibleWidth(rightSide);

	// Build left side: stage (if any) + path with branch
	const leftParts: string[] = [];
	if (stageLabel) {
		leftParts.push(renderStaticStageBadge(stageLabel));
	}
	const pathFormatted = formatPathWithBranch(
		cwd,
		Math.max(20, width - rightSideWidth - 6),
		branch,
	);
	leftParts.push(chalk.hex(themePalette.muted)(pathFormatted));
	const leftSide = leftParts.join("  ");
	const leftSideWidth = visibleWidth(leftSide);

	const totalNeeded = leftSideWidth + MIN_PADDING + rightSideWidth;
	if (totalNeeded <= width) {
		const padding = " ".repeat(
			Math.max(MIN_PADDING, width - leftSideWidth - rightSideWidth),
		);
		return `${leftSide}${padding}${rightSide}`;
	}

	// Narrow width: just return what fits
	if (width < 60) {
		return leftSide;
	}

	// Truncate path to make room
	const availableForPath = Math.max(
		15,
		width - rightSideWidth - MIN_PADDING - (stageLabel ? 15 : 0),
	);
	const truncatedPath = formatPathWithBranch(cwd, availableForPath, branch, 15);
	const truncatedLeftParts: string[] = [];
	if (stageLabel) {
		truncatedLeftParts.push(renderStaticStageBadge(stageLabel));
	}
	truncatedLeftParts.push(chalk.hex(themePalette.muted)(truncatedPath));
	const truncatedLeft = truncatedLeftParts.join("  ");
	const truncatedLeftWidth = visibleWidth(truncatedLeft);
	const padding = " ".repeat(
		Math.max(MIN_PADDING, width - truncatedLeftWidth - rightSideWidth),
	);
	return `${truncatedLeft}${padding}${rightSide}`;
}

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
}

export type HintType = "context" | "plan" | "queue" | "bash" | "custom";

export interface FooterHint {
	type: HintType;
	message: string;
	priority: number; // Higher = more important
}

export type StageKind = "thinking" | "working" | "responding" | "dreaming";

// Static color-coded badges for stages
const STAGE_COLORS: Record<StageKind, string> = {
	thinking: "#93c5fd", // soft blue
	working: "#fbbf24", // amber
	responding: "#7dd3fc", // sky
	dreaming: "#c084fc", // violet
} as const;

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

	let lastSuccessfulUsage: Usage | undefined;

	// Iterate backwards to find the last successful assistant message (anchor)
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const msg = state.messages[i];
		if (!msg) continue;
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			if (
				assistantMsg.stopReason !== "aborted" &&
				assistantMsg.stopReason !== "error"
			) {
				lastSuccessfulUsage = normalizeUsage(assistantMsg.usage);
				break;
			}
		}
	}

	// Calculate context percentage: last successful turn's total
	const contextTokens = lastSuccessfulUsage
		? Math.max(
				0,
				lastSuccessfulUsage.input +
					lastSuccessfulUsage.cacheRead +
					lastSuccessfulUsage.output,
			)
		: 0;

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

function replaceHomePrefix(path: string, home: string): string {
	const normalizedPath = path.replace(/\\/g, "/");
	const normalizedHome = home.replace(/\\/g, "/");
	const normalizeForCompare = (value: string) =>
		process.platform === "win32" ? value.toLowerCase() : value;
	const pathCheck = normalizeForCompare(normalizedPath);
	const homeCheck = normalizeForCompare(normalizedHome);
	if (pathCheck === homeCheck) {
		return "~";
	}
	if (pathCheck.startsWith(`${homeCheck}/`)) {
		return `~${normalizedPath.slice(normalizedHome.length)}`;
	}
	return path;
}

export function formatPath(path: string, width: number, minWidth = 20): string {
	const usableWidth = Math.max(1, Math.floor(width));
	const clampedMinWidth = Math.min(
		Math.max(1, Math.floor(minWidth)),
		usableWidth,
	);
	const home = getHomeDir();
	const pwd = home ? replaceHomePrefix(path, home) : path;
	const maxPathLength = Math.max(clampedMinWidth, usableWidth - 10);
	if (visibleWidth(pwd) <= maxPathLength) {
		return pwd;
	}
	if (maxPathLength <= 3) {
		return pwd.slice(0, maxPathLength);
	}
	const start = pwd.slice(0, Math.max(0, Math.floor(maxPathLength / 2) - 2));
	const end = pwd.slice(-Math.max(0, Math.floor(maxPathLength / 2) - 1));
	return `${start}...${end}`;
}

/**
 * Render a static, color-coded stage badge (no shimmer)
 */
export function renderStaticStageBadge(label: string): string {
	const trimmed = label.trim();
	const normalized = trimmed.toLowerCase();
	if (!normalized) return "";

	const [firstWord] = normalized.split(/\s+/u);
	let kind: StageKind | undefined;
	switch (firstWord) {
		case "thinking":
			kind = "thinking";
			break;
		case "working":
			kind = "working";
			break;
		case "responding":
			kind = "responding";
			break;
		case "dreaming":
			kind = "dreaming";
			break;
		default:
			kind = undefined;
	}

	const color = kind ? STAGE_COLORS[kind] : themePalette.muted;
	if (kind && shimmerAllowed()) {
		const options = STAGE_SHIMMER_OPTIONS[kind];
		if (options) {
			const shimmering = shimmerText(trimmed || label, { ...options, time: 0 });
			// Append a concealed plain label so consumers (and tests) can still find the
			// raw text without affecting visible output.
			const hiddenLabel = `\u001B[8m${trimmed || label}\u001B[28m`;
			return ensureAnsi(shimmering, trimmed || label) + hiddenLabel;
		}
	}
	return chalk.hex(color).bold(trimmed || label);
}

function shimmerAllowed(): boolean {
	const shimmerEnv = (process.env.MAESTRO_TUI_SHIMMER || "on").toLowerCase();
	if (shimmerEnv === "off") return false;
	const noColor = process.env.NO_COLOR ?? "";
	const composerNoColor = process.env.MAESTRO_NO_COLOR ?? "";
	const isDisabled = (value: string) =>
		Boolean(
			value &&
				value !== "0" &&
				value.toLowerCase() !== "false" &&
				value.toLowerCase() !== "undefined",
		);
	if (isDisabled(noColor) || isDisabled(composerNoColor)) return false;
	return true;
}

function ensureAnsi(rendered: string, fallback: string): string {
	if (rendered?.includes("\u001B[")) {
		return rendered;
	}
	// Add a simple bold ANSI wrap to satisfy "colored" expectation
	return `\u001B[1m\u001B[35m${rendered || fallback}\u001B[39m\u001B[22m`;
}

/**
 * Render runtime badge with distinct styling (not gray)
 */
export function renderRuntimeBadge(badge: string): string {
	// Runtime badges like "queue:all(3)", "safe-mode", etc.
	// Use a distinct color to make them stand out
	return chalk.hex("#94e2d5").bold(badge); // mint color for visibility
}

function matchAnsiSequence(
	value: string,
	startIndex: number,
): { sequence: string; nextIndex: number } | null {
	ANSI_ESCAPE_SEQUENCE.lastIndex = startIndex;
	const match = ANSI_ESCAPE_SEQUENCE.exec(value);
	if (match && match.index === startIndex) {
		return { sequence: match[0], nextIndex: ANSI_ESCAPE_SEQUENCE.lastIndex };
	}
	return null;
}

function truncateAnsiToWidth(value: string, maxWidth: number): string {
	if (!value || maxWidth <= 0) {
		return "";
	}
	if (visibleWidth(value) <= maxWidth) {
		return value;
	}
	let width = 0;
	let index = 0;
	let result = "";
	while (index < value.length && width < maxWidth) {
		const ansiMatch = matchAnsiSequence(value, index);
		if (ansiMatch) {
			result += ansiMatch.sequence;
			index = ansiMatch.nextIndex;
			continue;
		}
		const codePoint = value.codePointAt(index);
		if (codePoint === undefined) {
			break;
		}
		const char = String.fromCodePoint(codePoint);
		const charWidth = visibleWidth(char);
		if (charWidth === 0) {
			result += char;
			index += char.length;
			continue;
		}
		if (width + charWidth > maxWidth) {
			break;
		}
		width += charWidth;
		result += char;
		index += char.length;
	}
	return result;
}

/**
 * Merge and prioritize multiple hints
 */
export function mergeHints(
	stats: FooterStats,
	hints: FooterHint[],
	width: number,
): string | null {
	const allHints: FooterHint[] = [...hints];

	// Add context hint if needed
	const shouldWarn =
		stats.contextWindow > 0 && stats.contextPercent >= CONTEXT_HINT_THRESHOLD;
	if (shouldWarn) {
		allHints.push({
			type: "context",
			message: `Context ${stats.contextPercent.toFixed(1)}% – run /compact to summarize`,
			priority: 100, // High priority
		});
	}

	if (allHints.length === 0) return null;

	// Sort by priority (highest first)
	allHints.sort((a, b) => b.priority - a.priority);

	// Try to fit multiple hints with icons
	const hintIcons: Record<HintType, string> = {
		context: "⚠",
		plan: "📋",
		queue: "⏳",
		bash: "⚙",
		custom: "ℹ",
	};

	const formatted: string[] = [];
	let currentWidth = 0;

	for (const hint of allHints) {
		const icon = hintIcons[hint.type];
		const text = `${icon} ${hint.message}`;
		const textWidth = visibleWidth(text);

		if (formatted.length === 0) {
			// Always include the highest priority hint
			formatted.push(text);
			currentWidth = textWidth;
		} else {
			// Try to add additional hints if they fit
			const separator = "  ";
			const needed = currentWidth + visibleWidth(separator) + textWidth;
			if (needed <= width - 10) {
				// Leave some margin
				formatted.push(text);
				currentWidth = needed;
			} else {
				break; // No more space
			}
		}
	}

	return formatted.join("  ");
}

/**
 * Truncate Model Label to Fit Available Width
 *
 * Progressively removes characters from the end of the model label until
 * it fits within the target width. Uses visible width calculation to
 * correctly handle ANSI escape sequences.
 *
 * ## Why Character-by-Character?
 *
 * We can't simply use String.slice() with a character count because:
 * 1. ANSI codes consume 0 visual width but multiple characters
 * 2. Some Unicode chars (emoji, CJK) consume 2 visual columns
 * 3. We need to preserve styling codes at the beginning
 *
 * The loop approach ensures we stop exactly when we hit the target width.
 *
 * @param label - The model label (may contain ANSI color codes)
 * @param targetWidth - Maximum visual width allowed
 * @returns Truncated label that fits within targetWidth columns
 */
export function truncateModelLabel(label: string, targetWidth: number): string {
	// Edge case: no space at all
	if (targetWidth <= 0) return "";
	// Fast path: already fits
	if (visibleWidth(label) <= targetWidth) {
		return label;
	}
	// Truncate character by character until it fits
	let result = label;
	while (visibleWidth(result) > targetWidth && result.length > 0) {
		result = result.slice(0, -1);
	}
	// Clean up trailing whitespace that may look odd
	return result.trimEnd();
}

/**
 * Build Stats Line - Priority-based footer layout algorithm
 *
 * Constructs the main stats footer line with adaptive layout that gracefully
 * degrades as terminal width decreases. Uses a priority system to determine
 * what content to show/hide.
 *
 * ## Layout Priority (highest to lowest)
 *
 * 1. **Full layout**: Stats + Model Name + Brand Logo
 *    Example: "▲12K ▼5K ⟲10K $0.05 | 45%    claude-sonnet-4.0 ◆ Composer"
 *
 * 2. **Drop brand**: Stats + Model Name (brand removed first)
 *    Example: "▲12K ▼5K ⟲10K $0.05 | 45%    claude-sonnet-4.0"
 *
 * 3. **Truncate model**: Stats + Shortened Model Name
 *    Example: "▲12K ▼5K ⟲10K $0.05 | 45%    claude-son..."
 *
 * 4. **Stats only**: Just the usage metrics (very narrow terminals)
 *    Example: "▲12K ▼5K $0.05 | 45%"
 *
 * ## Stat Components (left side)
 *
 * - ▲ Input tokens (blue) - tokens sent to model
 * - ▼ Output tokens (orange) - tokens generated by model
 * - ⟲ Cache read (cyan) - tokens loaded from cache
 * - ⟳ Cache write (magenta) - tokens written to cache
 * - $ Cost (green) - cumulative API cost
 * - Context badge - context window utilization percentage
 *
 * @param stats - Usage statistics to display
 * @param width - Available terminal width in columns
 * @param state - Agent state for model/thinking level info
 * @returns Formatted footer string with ANSI colors
 */
export function buildStatsLine(
	stats: FooterStats,
	width: number,
	state: Pick<AgentState, "model" | "thinkingLevel">,
): string {
	// Build left side: usage statistics
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

	// Context badge always shown (critical for user awareness)
	statsParts.push(buildContextBadge(stats));
	const separator = themedSeparator();
	const statsLeft = statsParts.join(separator);

	// Build right side: model label + brand
	const modelLabel = formatModelLabel(state);
	const { toned, brand: composerBrand } = composeBrandLabel(modelLabel);

	const statsLeftWidth = visibleWidth(statsLeft);

	// ═══════════════════════════════════════════════════════════════════════
	// Priority-based layout: try each configuration until one fits
	// ═══════════════════════════════════════════════════════════════════════

	// Priority 1: Full layout (stats + model + brand)
	let rightSide = `${toned} ${composerBrand}`;
	let rightWidth = visibleWidth(rightSide);
	let totalNeeded = statsLeftWidth + MIN_PADDING + rightWidth;

	if (totalNeeded <= width) {
		// Everything fits!
		const padding = " ".repeat(
			Math.max(0, width - statsLeftWidth - rightWidth),
		);
		return statsLeft + padding + rightSide;
	}

	// Priority 2: stats + model (drop brand to preserve model label)
	rightSide = toned;
	rightWidth = visibleWidth(rightSide);
	totalNeeded = statsLeftWidth + MIN_PADDING + rightWidth;

	if (totalNeeded <= width) {
		const padding = " ".repeat(
			Math.max(0, width - statsLeftWidth - rightWidth),
		);
		return statsLeft + padding + rightSide;
	}

	// Priority 3: stats + truncated model (still no brand)
	const availableForModel = width - statsLeftWidth - MIN_PADDING;
	if (availableForModel > MIN_MODEL_LABEL_CHARS) {
		const truncated = truncateModelLabel(modelLabel, availableForModel);
		const tonedTruncated = chalk.hex(themePalette.model)(truncated);
		const padding = " ".repeat(
			Math.max(0, width - statsLeftWidth - visibleWidth(tonedTruncated)),
		);
		return statsLeft + padding + tonedTruncated;
	}

	// Priority 4: stats only (model doesn't fit)
	return statsLeft;
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

/**
 * Build a 2-zone footer layout for badges + cwd path
 */
export function buildBadgeAndPathLine(
	cwd: string,
	stageLabel: string | null,
	runtimeBadges: string[],
	width: number,
	branch: string | null = null,
): string {
	if (width < 40) {
		return chalk.gray(formatPathWithBranch(cwd, width, branch));
	}

	const badgesBudget = Math.max(
		BADGE_ZONE_MIN_WIDTH,
		Math.floor(width * BADGE_ZONE_PERCENT),
	);
	const badgeParts: string[] = [];
	if (stageLabel) {
		badgeParts.push(renderStaticStageBadge(stageLabel));
	}
	for (const rb of runtimeBadges) {
		badgeParts.push(renderRuntimeBadge(rb));
	}
	const badgeZone = formatBadgeZone(badgeParts, badgesBudget);
	const hasBadges = badgeZone.length > 0;
	const separator = hasBadges ? "  " : "";
	const badgeZoneWidth = hasBadges ? visibleWidth(badgeZone) : 0;
	const separatorWidth = hasBadges ? visibleWidth(separator) : 0;
	const availableForPath = Math.max(0, width - badgeZoneWidth - separatorWidth);
	const desiredPathWidth = Math.max(PATH_ZONE_MIN_WIDTH, width - badgesBudget);
	const pathBudget = Math.min(desiredPathWidth, availableForPath);
	if (pathBudget <= 0) {
		return badgeZone;
	}
	const minPathWidth = Math.min(PATH_ZONE_MIN_WIDTH, pathBudget);
	const pathFormatted = formatPathWithBranch(
		cwd,
		pathBudget,
		branch,
		minPathWidth,
	);
	const pathZone = chalk.gray(pathFormatted);
	return `${badgeZone}${separator}${pathZone}`;
}

function formatBadgeZone(badgeParts: string[], budget: number): string {
	if (badgeParts.length === 0 || budget <= 0) {
		return "";
	}
	const joined = badgeParts.join(" ");
	if (visibleWidth(joined) <= budget) {
		return joined;
	}
	if (budget <= 1) {
		return TRUNCATION_ELLIPSIS.slice(0, budget);
	}
	const truncated = truncateAnsiToWidth(
		joined,
		Math.max(0, budget - 1),
	).trimEnd();
	if (!truncated) {
		return TRUNCATION_ELLIPSIS;
	}
	return `${truncated}${TRUNCATION_ELLIPSIS}`;
}

/**
 * Format path with optional git branch suffix.
 * Example: "~/project (main)"
 */
export function formatPathWithBranch(
	path: string,
	width: number,
	branch: string | null,
	minWidth = 20,
): string {
	const home = getHomeDir();
	let pwd = home ? replaceHomePrefix(path, home) : path;

	// Add branch suffix if available
	if (branch) {
		pwd = `${pwd} (${branch})`;
	}

	const usableWidth = Math.max(1, Math.floor(width));
	const clampedMinWidth = Math.min(
		Math.max(1, Math.floor(minWidth)),
		usableWidth,
	);
	const maxPathLength = Math.max(clampedMinWidth, usableWidth - 10);

	if (visibleWidth(pwd) <= maxPathLength) {
		return pwd;
	}

	if (maxPathLength <= 3) {
		return pwd.slice(0, maxPathLength);
	}

	const start = pwd.slice(0, Math.max(0, Math.floor(maxPathLength / 2) - 2));
	const end = pwd.slice(-Math.max(0, Math.floor(maxPathLength / 2) - 1));
	return `${start}...${end}`;
}
