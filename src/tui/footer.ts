import type { AgentState, AssistantMessage } from "../agent/types.js";
import { visibleWidth } from "../tui-lib/index.js";
import chalk from "chalk";

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
		// Calculate cumulative usage from all assistant messages
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of this.state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		// Get last assistant message for context percentage calculation (skip aborted messages)
		const lastAssistantMessage = this.state.messages
			.slice()
			.reverse()
			.find(
				(m) =>
					m.role === "assistant" &&
					(m as AssistantMessage).stopReason !== "aborted",
			) as AssistantMessage | undefined;

		// Calculate context percentage from last message (input + output + cacheRead + cacheWrite)
		const contextTokens = lastAssistantMessage
			? lastAssistantMessage.usage.input +
				lastAssistantMessage.usage.output +
				lastAssistantMessage.usage.cacheRead +
				lastAssistantMessage.usage.cacheWrite
			: 0;
		const contextWindow = this.state.model.contextWindow;
		const contextPercent =
			contextWindow > 0
				? ((contextTokens / contextWindow) * 100).toFixed(1)
				: "0.0";

		// Format token counts (similar to web-ui)
		const formatTokens = (count: number): string => {
			if (count < 1000) return count.toString();
			if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
			return `${Math.round(count / 1000)}k`;
		};

		// Replace home directory with ~
		let pwd = process.cwd();
		const home = process.env.HOME || process.env.USERPROFILE;
		if (home && pwd.startsWith(home)) {
			pwd = `~${pwd.slice(home.length)}`;
		}

		// Truncate path if too long to fit width
		const maxPathLength = Math.max(20, width - 10); // Leave some margin
		if (pwd.length > maxPathLength) {
			const start = pwd.slice(0, Math.floor(maxPathLength / 2) - 2);
			const end = pwd.slice(-(Math.floor(maxPathLength / 2) - 1));
			pwd = `${start}...${end}`;
		}

		// Build stats line
		const statsParts = [];
		if (totalInput)
			statsParts.push(
				`${chalk.hex("#9ad5ff")("▲")} ${formatTokens(totalInput)}`,
			);
		if (totalOutput)
			statsParts.push(
				`${chalk.hex("#f7b267")("▼")} ${formatTokens(totalOutput)}`,
			);
		if (totalCacheRead)
			statsParts.push(
				`${chalk.hex("#c1ffd7")("⟲")} ${formatTokens(totalCacheRead)}`,
			);
		if (totalCacheWrite)
			statsParts.push(
				`${chalk.hex("#f7b7c3")("⟳")} ${formatTokens(totalCacheWrite)}`,
			);
		if (totalCost)
			statsParts.push(`${chalk.hex("#ffd6a5")("$")}${totalCost.toFixed(3)}`);

		const contextBadgeColor =
			Number.parseFloat(contextPercent) >= 80 ? "#ff6b6b" : "#a0aec0";
		statsParts.push(chalk.hex(contextBadgeColor)(`ctx ${contextPercent}%`));

		const statsLeft = statsParts.join(" ");

		// Add model name and composer branding on the right side
		const composerBrand = chalk.hex("#7c3aed")("♪ composer");
		let modelName = this.state.model.id;
		const rightSide = `${modelName} ${composerBrand}`;
		
		const statsLeftWidth = visibleWidth(statsLeft);
		const rightSideWidth = visibleWidth(rightSide);

		// Calculate available space for padding (minimum 2 spaces between stats and right side)
		const minPadding = 2;
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate model name
			const brandWidth = visibleWidth(composerBrand);
			const availableForModel = width - statsLeftWidth - minPadding - brandWidth - 1;
			if (availableForModel > 3) {
				// Truncate model name to fit, keep composer branding
				modelName = modelName.substring(0, availableForModel);
				const truncatedRight = `${modelName} ${composerBrand}`;
				const padding = " ".repeat(
					width - statsLeftWidth - visibleWidth(truncatedRight),
				);
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for model name, just show composer branding
				const availableForBrand = width - statsLeftWidth - minPadding;
				if (availableForBrand >= brandWidth) {
					const padding = " ".repeat(width - statsLeftWidth - brandWidth);
					statsLine = statsLeft + padding + composerBrand;
				} else {
					// Not enough space for anything on right
					statsLine = statsLeft;
				}
			}
		}

		let pathLine = chalk.gray(pwd);
		if (this.activeStage) {
			const baseBadge = `● ${this.activeStage}`;
			const available = Math.max(
				0,
				width - visibleWidth(pathLine) - 2,
			);
			if (available > 0) {
				const trimmedBadge = this.truncateToWidth(baseBadge, available);
				if (trimmedBadge) {
					const badge = chalk.hex("#f1c0e8")(trimmedBadge);
					pathLine = `${pathLine}  ${badge}`;
				}
			}
		}

		const lines = [pathLine, chalk.gray(statsLine)];
		if (this.statusHint) {
			const hintLabel = this.truncateToWidth(
				`tip: ${this.statusHint}`,
				width,
			);
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
}
