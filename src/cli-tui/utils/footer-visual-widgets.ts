/**
 * Footer Visual Widgets - Reusable visual components for the footer bar
 *
 * Contains context bars, sparklines, git status glyphs, and other
 * small visual elements used in footer layout.
 *
 * @module tui/utils/footer-visual-widgets
 */

import chalk from "chalk";
import { badge, brand, themePalette } from "../../style/theme.js";
import type { FooterStats } from "./footer-utils.js";
import {
	CONTEXT_DANGER_THRESHOLD,
	CONTEXT_WARN_THRESHOLD,
	formatTokenCount,
} from "./footer-utils.js";
import { type GitStatusName, gitGlyph } from "./glyphs.js";

/** Progress bar characters for visual display */
const PROGRESS_FILLED = "━";
const PROGRESS_EMPTY = "─";

// ============================================================================
// CONTEXT DISPLAY
// ============================================================================

export function buildContextBadge(stats: FooterStats): string {
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

export function colorizeContextPercent(value: number): string {
	const label = `${value.toFixed(1)}%`;
	if (value >= CONTEXT_DANGER_THRESHOLD) {
		return chalk.hex(themePalette.danger)(label);
	}
	if (value >= CONTEXT_WARN_THRESHOLD) {
		return chalk.hex(themePalette.warning)(label);
	}
	return chalk.hex(themePalette.muted)(label);
}

/**
 * Build a compact visual progress bar for context usage.
 * Uses ━ for filled and ─ for empty segments.
 */
export function buildContextBar(percent: number, width = 10): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	const empty = width - filled;

	// Color based on threshold
	let filledColor: string = themePalette.accentCool;
	if (clamped >= CONTEXT_DANGER_THRESHOLD) {
		filledColor = themePalette.danger;
	} else if (clamped >= CONTEXT_WARN_THRESHOLD) {
		filledColor = themePalette.warning;
	}

	const filledPart = chalk.hex(filledColor)(PROGRESS_FILLED.repeat(filled));
	const emptyPart = chalk.hex(themePalette.dim)(PROGRESS_EMPTY.repeat(empty));
	return `${filledPart}${emptyPart}`;
}

// ============================================================================
// COST SPARKLINE
// ============================================================================

/**
 * Build a cost sparkline showing trend direction.
 * Shows last N costs as a mini bar chart.
 */
export function buildCostSparkline(costs: number[], width = 5): string {
	if (costs.length === 0) return "";

	const recentCosts = costs.slice(-width);
	const max = Math.max(...recentCosts, 0.001); // Avoid division by zero
	const sparkChars = "▁▂▃▄▅▆▇█";

	const bars = recentCosts.map((cost) => {
		const normalized = cost / max;
		const charIndex = Math.min(
			sparkChars.length - 1,
			Math.floor(normalized * sparkChars.length),
		);
		return sparkChars[charIndex];
	});

	return chalk.hex(themePalette.cost)(bars.join(""));
}

// ============================================================================
// GIT STATUS
// ============================================================================

/** Git status type for UI display */
export type GitStatusType =
	| "clean"
	| "dirty"
	| "staged"
	| "ahead"
	| "behind"
	| "diverged";

/**
 * Build a git status glyph with color.
 * Uses centralized glyphs from glyphs.ts with ASCII fallback support.
 */
export function buildGitStatusGlyph(status: GitStatusType): string {
	const glyph = gitGlyph(status as GitStatusName);
	let color: string = themePalette.muted;

	switch (status) {
		case "clean":
			color = themePalette.success;
			break;
		case "dirty":
			color = themePalette.warning;
			break;
		case "staged":
			color = themePalette.accentCool;
			break;
		case "ahead":
		case "behind":
		case "diverged":
			color = themePalette.info;
			break;
	}

	return chalk.hex(color)(glyph);
}

// ============================================================================
// TIME FORMATTING
// ============================================================================

/**
 * Format a timestamp as relative time (e.g., "2m ago", "1h ago").
 */
export function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;

	if (diff < 0) return "now";

	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return "now";

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;

	const days = Math.floor(hours / 24);
	return `${days}d`;
}

// ============================================================================
// BRAND LABEL
// ============================================================================

export function composeBrandLabel(modelLabel: string): {
	toned: string;
	brand: string;
	glyph: string;
} {
	const tonedModel = chalk.hex(themePalette.model)(modelLabel);
	const glyph = brand.glyph();
	const brandLabel = `${glyph} ${brand.text()}`;
	return { toned: tonedModel, brand: brandLabel, glyph };
}
