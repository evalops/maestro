import { visibleWidth } from "@evalops/tui";
import chalk from "chalk";
import type { AgentState } from "../agent/types.js";
import {
	buildBadgeAndPathLine,
	buildSoloStatsLine,
	buildStatsLine,
	calculateFooterStats,
	formatPath,
	mergeHints,
} from "./utils/footer-utils.js";
import type {
	FooterHint,
	FooterMode,
	FooterStats,
} from "./utils/footer-utils.js";

// Re-export FooterHint for external use
export type { FooterHint, HintType } from "./utils/footer-utils.js";

/**
 * Footer component that shows pwd, token stats, and context usage
 */
export class FooterComponent {
	private state: AgentState;
	private activeStage: string | null = null;
	private hints: FooterHint[] = [];
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
		// Legacy method - convert single hint to hints array
		if (hint) {
			this.hints = [{ type: "custom", message: hint, priority: 150 }];
		} else {
			this.hints = [];
		}
	}

	setHints(hints: FooterHint[]): void {
		this.hints = hints;
	}

	addHint(hint: FooterHint): void {
		this.hints.push(hint);
	}

	clearHints(): void {
		this.hints = [];
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

		// Use new 3-zone layout
		const pathLine = buildBadgeAndPathLine(
			process.cwd(),
			this.activeStage,
			this.runtimeBadges,
			width,
		);
		const statsLine = buildStatsLine(stats, width, this.state);

		const lines = [pathLine, chalk.gray(statsLine)];

		// Use new multi-hint system
		const mergedHint = mergeHints(stats, this.hints, width);
		if (mergedHint) {
			const truncated = this.truncateToWidth(mergedHint, width);
			lines.push(chalk.hex("#94a3b8")(truncated));
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

	private renderSoloFooter(stats: FooterStats, width: number): string[] {
		const pathLine = chalk.gray(formatPath(process.cwd(), width));
		const statsLine = buildSoloStatsLine(stats, width, this.state);
		return [pathLine, chalk.gray(statsLine)];
	}
}
