import { visibleWidth } from "@evalops/tui";
import chalk from "chalk";
import type { AgentState } from "../agent/types.js";
import {
	buildSoloStatsLine,
	buildStatsLine,
	calculateFooterStats,
	formatPath,
	resolveFooterHint,
} from "./utils/footer-utils.js";
import type { FooterMode, FooterStats } from "./utils/footer-utils.js";
import { shimmerText } from "./utils/shimmer.js";
import type { ShimmerOptions } from "./utils/shimmer.js";

const SHIMMER_STAGE_OPTIONS: Record<string, ShimmerOptions> = {
	responding: {
		padding: 2,
		bandWidth: 2,
		sweepSeconds: 2.1,
		intensityScale: 0.65,
		baseColor: "#f5cbe6",
		highlightColor: "#ffffff",
		bold: false,
	},
	thinking: {
		padding: 2,
		bandWidth: 2.5,
		sweepSeconds: 2.4,
		intensityScale: 0.55,
		baseColor: "#cbd5f5",
		highlightColor: "#ffffff",
		bold: false,
	},
	working: {
		padding: 2,
		bandWidth: 1.8,
		sweepSeconds: 1.6,
		intensityScale: 0.75,
		baseColor: "#fde68a",
		highlightColor: "#fff7ed",
		bold: false,
	},
};

/**
 * Footer component that shows pwd, token stats, and context usage
 */
export class FooterComponent {
	private state: AgentState;
	private activeStage: string | null = null;
	private statusHint: string | null = null;
	private runtimeBadges: string[] = [];
	private mode: FooterMode;

	constructor(state: AgentState, mode: FooterMode = "ensemble") {
		this.state = state;
		this.mode = mode;
	}

	updateState(state: AgentState): void {
		this.state = state;
	}

	setRuntimeBadges(badges: string[]): void {
		this.runtimeBadges = badges;
	}

	setStage(stage: string | null): void {
		this.activeStage = stage;
	}

	setHint(hint: string | null): void {
		this.statusHint = hint;
	}

	setMode(mode: FooterMode): void {
		this.mode = mode;
	}

	getMode(): FooterMode {
		return this.mode;
	}

	render(width: number): string[] {
		const stats = calculateFooterStats(this.state);
		if (this.mode === "solo") {
			return this.renderSoloFooter(stats, width);
		}
		const pathLine = this.renderPathLine(width);
		const statsLine = buildStatsLine(stats, width, this.state);

		const lines = [pathLine, chalk.gray(statsLine)];
		const hintSource = resolveFooterHint(stats, this.statusHint);
		if (hintSource) {
			const hintLabel = this.truncateToWidth(`tip: ${hintSource}`, width);
			lines.push(chalk.hex("#94a3b8")(hintLabel));
		}

		return lines;
	}

	private truncateToWidth(text: string, width: number): string {
		if (width <= 0) return "";
		if (visibleWidth(text) <= width) return text;
		if (width === 1) return text.slice(0, 1);
		let result = text;
		while (visibleWidth(result) > width - 1 && result.length > 0) {
			result = result.slice(0, -1);
		}
		return `${result.trimEnd()}…`;
	}

	private renderPathLine(width: number): string {
		const pathLine = chalk.gray(formatPath(process.cwd(), width));
		const badges: string[] = [];
		if (this.activeStage) {
			badges.push(this.renderStageLabel(this.activeStage));
		}
		for (const badge of this.runtimeBadges) {
			badges.push(chalk.hex("#94a3b8")(badge));
		}
		if (badges.length === 0) {
			return pathLine;
		}
		const suffix = badges.join("  ");
		const available = Math.max(0, width - visibleWidth(pathLine) - 2);
		if (available <= 0) {
			return pathLine;
		}
		const trimmedSuffix = this.truncateToWidth(suffix, available);
		if (!trimmedSuffix) {
			return pathLine;
		}
		return `${pathLine}  ${trimmedSuffix}`;
	}

	private renderStageLabel(label: string): string {
		const trimmed = label.trim();
		if (!trimmed) return "";
		const normalized = trimmed.toLowerCase();
		for (const [stage, options] of Object.entries(SHIMMER_STAGE_OPTIONS)) {
			if (normalized.startsWith(stage)) {
				return shimmerText(trimmed.toUpperCase(), options);
			}
		}
		return chalk.hex("#f1c0e8")(trimmed.toUpperCase());
	}

	private renderSoloFooter(stats: FooterStats, width: number): string[] {
		const pathLine = chalk.gray(formatPath(process.cwd(), width));
		const statsLine = buildSoloStatsLine(stats, width, this.state);
		return [pathLine, chalk.gray(statsLine)];
	}
}
