import chalk from "chalk";
import type { AgentState } from "../agent/types.js";
import { isSafeModeEnabled } from "../safety/safe-mode.js";
import { visibleWidth } from "../tui-lib/index.js";
import {
	buildStatsLine,
	calculateFooterStats,
	formatPath,
} from "./footer-utils.js";

/**
 * Footer component that shows pwd, token stats, and context usage
 */
export class FooterComponent {
	private state: AgentState;
	private activeStage: string | null = null;
	private statusHint: string | null = null;
	private safeModeIcon: string | null = null;

	constructor(state: AgentState) {
		this.state = state;
		this.safeModeIcon = isSafeModeEnabled() ? "🛡️" : null;
	}

	updateState(state: AgentState): void {
		this.state = state;
		this.safeModeIcon = isSafeModeEnabled() ? "🛡️" : null;
	}

	setStage(stage: string | null): void {
		this.activeStage = stage;
	}

	setHint(hint: string | null): void {
		this.statusHint = hint;
	}

	render(width: number): string[] {
		const stats = calculateFooterStats(this.state);
		const pathLine = this.renderPathLine(width);
		const statsLine = buildStatsLine(stats, width, this.state.model.id);

		const lines = [pathLine, chalk.gray(statsLine)];
		const contextValue = stats.contextPercent;
		const highContextHint =
			stats.contextWindow > 0 && contextValue >= 70
				? `Context ${contextValue.toFixed(1)}% – run /compact to summarize`
				: null;
		const hintSource = highContextHint || this.statusHint;
		if (hintSource) {
			const hintLabel = this.truncateToWidth(`tip: ${hintSource}`, width);
			lines.push(chalk.hex("#94a3b8")(hintLabel));
		}

		// Return lines with optional hint
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
			badges.push(chalk.hex("#f1c0e8")(this.activeStage));
		}
		if (this.safeModeIcon) {
			badges.push(chalk.hex("#f472b6")(this.safeModeIcon));
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
}
