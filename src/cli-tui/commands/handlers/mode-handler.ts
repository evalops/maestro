/**
 * Mode Command Handler.
 *
 * Implements the /mode slash command for switching agent operating modes.
 *
 * Usage:
 *   /mode              - Show current mode
 *   /mode smart        - Switch to smart mode (opus, best quality)
 *   /mode rush         - Switch to rush mode (sonnet, faster)
 *   /mode free         - Switch to free mode (haiku, cheapest)
 *   /mode suggest      - Get mode suggestion for current task
 */

import {
	type AgentMode,
	formatModeDisplay,
	getAllModes,
	getCurrentMode,
	getModeConfig,
	getModelForMode,
	parseMode,
	setCurrentMode,
	suggestMode,
} from "../../../agent/modes.js";
import type { CommandExecutionContext } from "../types.js";

export interface ModeCommandDeps {
	/** Get the current user message/task for suggestion */
	getCurrentTask?: () => string | null;
	/** Callback when mode changes */
	onModeChange?: (mode: AgentMode, model: string) => void;
}

/**
 * Create the mode command handler.
 */
export function createModeCommandHandler(deps: ModeCommandDeps = {}) {
	return function handleModeCommand(ctx: CommandExecutionContext): void {
		const arg = ctx.argumentText.trim().toLowerCase();

		// No argument - show current mode
		if (!arg) {
			showCurrentMode(ctx);
			return;
		}

		// Help
		if (arg === "help" || arg === "?") {
			showModeHelp(ctx);
			return;
		}

		// List all modes
		if (arg === "list" || arg === "all") {
			showAllModes(ctx);
			return;
		}

		// Suggest mode for current task
		if (arg === "suggest" || arg === "auto") {
			const task = deps.getCurrentTask?.() ?? "";
			const suggested = suggestMode(task);
			const config = getModeConfig(suggested);
			ctx.showInfo(
				`Suggested mode: ${config.displayName}\n` +
					`Reason: ${config.description}\n` +
					`Use /mode ${suggested} to switch`,
			);
			return;
		}

		// Parse and switch mode
		const newMode = parseMode(arg);
		if (newMode) {
			setCurrentMode(newMode);
			const model = getModelForMode(newMode);
			const config = getModeConfig(newMode);

			ctx.showInfo(
				`Mode: ${config.displayName}\n` +
					`Model: ${model}\n` +
					`Thinking: ${config.enableThinking ? "enabled" : "disabled"}\n` +
					`Cost: ${formatCostLevel(config.costMultiplier)} | Speed: ${formatSpeedLevel(config.speedHint)}`,
			);

			// Notify callback
			deps.onModeChange?.(newMode, model);
		} else {
			ctx.showError(`Unknown mode: ${arg}`);
			showModeHelp(ctx);
		}
	};
}

function showCurrentMode(ctx: CommandExecutionContext): void {
	const mode = getCurrentMode();
	const config = getModeConfig(mode);
	const model = getModelForMode(mode);

	ctx.showInfo(
		`Current Mode: ${config.displayName}\n${config.description}\n\nModel: ${model}\nThinking: ${config.enableThinking ? "enabled" : "disabled"}\nCost: ${formatCostLevel(config.costMultiplier)} | Speed: ${formatSpeedLevel(config.speedHint)}\n\nUse /mode <name> to switch modes`,
	);
}

function showAllModes(ctx: CommandExecutionContext): void {
	const modes = getAllModes();
	const current = getCurrentMode();

	const lines = ["Available Modes:", ""];
	for (const { mode, config } of modes) {
		const marker = mode === current ? "▶" : " ";
		const model = getModelForMode(mode);
		lines.push(
			`${marker} ${config.displayName.padEnd(8)} ${config.description}`,
		);
		lines.push(`          Model: ${model}`);
	}

	lines.push("", "Use /mode <name> to switch");
	ctx.showInfo(lines.join("\n"));
}

function showModeHelp(ctx: CommandExecutionContext): void {
	ctx.showInfo(`Mode Commands:
  /mode              Show current mode
  /mode smart        Best quality (opus, thinking enabled)
  /mode rush         Fast responses (sonnet, no thinking)
  /mode free         Cost-effective (haiku, minimal)
  /mode list         Show all available modes
  /mode suggest      Get mode suggestion for current task

Modes affect model selection, thinking, and cost/speed tradeoffs.`);
}

function formatCostLevel(multiplier: number): string {
	if (multiplier >= 0.9) return "$$$$";
	if (multiplier >= 0.5) return "$$$";
	if (multiplier >= 0.2) return "$$";
	return "$";
}

function formatSpeedLevel(hint: number): string {
	if (hint >= 9) return "⚡⚡⚡";
	if (hint >= 7) return "⚡⚡";
	if (hint >= 5) return "⚡";
	return "🐢";
}

/**
 * Get completions for mode command.
 */
export function getModeCompletions(
	prefix: string,
): Array<{ label: string; description: string }> {
	const modes = getAllModes();
	const completions: Array<{ label: string; description: string }> = [];

	for (const { mode, config } of modes) {
		if (mode.startsWith(prefix.toLowerCase())) {
			completions.push({
				label: mode,
				description: config.description,
			});
		}
	}

	// Add special commands
	if ("suggest".startsWith(prefix.toLowerCase())) {
		completions.push({
			label: "suggest",
			description: "Get mode suggestion for current task",
		});
	}
	if ("list".startsWith(prefix.toLowerCase())) {
		completions.push({
			label: "list",
			description: "Show all available modes",
		});
	}

	return completions;
}
