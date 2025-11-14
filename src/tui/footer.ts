import chalk from "chalk";
import type { AgentState } from "../agent/types.js";
import { visibleWidth } from "../tui-lib/index.js";
import {
	calculateFooterStats,
	buildStatsLine,
	formatPath,
} from "./footer-utils.js";

/**
 * Footer component that shows pwd, token stats, and context usage
 */
export class FooterComponent {
	private state: AgentState;
	private activeStage: string | null = null;
	private statusHint: string | null = null;

	constructor(state: AgentState) {
		this.state = state;
	}

	updateState(state: AgentState): void {
		this.state = state;
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
		const contextValue = Number.parseFloat(stats.contextPercent);
		const highContextHint =
			contextValue >= 80
				? "Context nearly full – consider /compact or /export"
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
		let pathLine = chalk.gray(formatPath(process.cwd(), width));
		if (!this.activeStage) {
			return pathLine;
		}
		const baseBadge = `● ${this.activeStage}`;
		const available = Math.max(0, width - visibleWidth(pathLine) - 2);
		if (available <= 0) {
			return pathLine;
		}
		const trimmedBadge = this.truncateToWidth(baseBadge, available);
		if (!trimmedBadge) {
			return pathLine;
		}
		const badge = chalk.hex("#f1c0e8")(trimmedBadge);
		return `${pathLine}  ${badge}`;
	}
}
