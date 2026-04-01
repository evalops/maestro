/**
 * UiStateController - Manages TUI visual state settings
 *
 * Extracted from TuiRenderer to consolidate UI state management including:
 * - Zen mode (minimal distraction mode)
 * - Clean mode (streaming text deduplication)
 * - Footer mode (ensemble vs solo display)
 * - Thinking blocks visibility
 *
 * This controller owns the state and persistence, providing callbacks
 * for UI updates that the parent renderer implements.
 */

import type { CleanMode } from "../../conversation/render-model.js";
import { parseCleanMode } from "../clean-mode.js";
import type { CommandExecutionContext } from "../commands/types.js";
import { type UiState, saveUiState } from "../ui-state.js";
import type { FooterMode } from "../utils/footer-utils.js";

export interface UiStateCallbacks {
	/** Called when zen mode changes - update header visibility */
	onZenModeChange: (enabled: boolean) => void;
	/** Called when footer mode changes */
	onFooterModeChange: (mode: FooterMode) => void;
	/** Called when thinking blocks visibility changes */
	onHideThinkingBlocksChange: (hidden: boolean) => void;
	/** Request a render update */
	requestRender: () => void;
}

export interface UiStateControllerOptions {
	initialCleanMode: CleanMode;
	initialFooterMode: FooterMode;
	initialZenMode: boolean;
	initialHideThinkingBlocks: boolean;
	callbacks: UiStateCallbacks;
}

export class UiStateController {
	private cleanMode: CleanMode;
	private footerMode: FooterMode;
	private zenMode: boolean;
	private hideThinkingBlocks: boolean;
	private readonly callbacks: UiStateCallbacks;

	constructor(options: UiStateControllerOptions) {
		this.cleanMode = options.initialCleanMode;
		this.footerMode = options.initialFooterMode;
		this.zenMode = options.initialZenMode;
		this.hideThinkingBlocks = options.initialHideThinkingBlocks;
		this.callbacks = options.callbacks;
	}

	// ─── Clean Mode ──────────────────────────────────────────────────────────

	getCleanMode(): CleanMode {
		return this.cleanMode;
	}

	setCleanMode(mode: CleanMode): void {
		this.cleanMode = mode;
		this.persistState({ cleanMode: mode });
	}

	handleCleanCommand(context: CommandExecutionContext): void {
		const arg = context.argumentText.trim().toLowerCase();
		if (!arg) {
			context.showInfo(
				`Clean mode is ${this.cleanMode} (streaming only). Use /clean off|soft|aggressive.`,
			);
			return;
		}

		const parsed = parseCleanMode(arg);
		if (!parsed) {
			context.showError("Usage: /clean [off|soft|aggressive]");
			return;
		}

		this.setCleanMode(parsed);
		context.showInfo(
			`Clean mode set to ${parsed}. Dedupe applies only while text streams; transcripts stay raw.`,
		);
	}

	// ─── Zen Mode ────────────────────────────────────────────────────────────

	getZenMode(): boolean {
		return this.zenMode;
	}

	setZenMode(enabled: boolean): void {
		this.zenMode = enabled;
		this.persistState({ zenMode: enabled });
		this.callbacks.onZenModeChange(enabled);
		this.callbacks.requestRender();
	}

	handleZenCommand(context: CommandExecutionContext): void {
		const arg = context.argumentText.trim().toLowerCase();
		if (!arg) {
			const newState = !this.zenMode;
			this.setZenMode(newState);
			context.showInfo(
				newState
					? "Zen mode enabled. Distractions removed."
					: "Zen mode disabled.",
			);
			return;
		}
		if (arg === "on") {
			if (this.zenMode) {
				context.showInfo("Zen mode is already on.");
				return;
			}
			this.setZenMode(true);
			context.showInfo("Zen mode enabled. Distractions removed.");
			return;
		}
		if (arg === "off") {
			if (!this.zenMode) {
				context.showInfo("Zen mode is already off.");
				return;
			}
			this.setZenMode(false);
			context.showInfo("Zen mode disabled.");
			return;
		}
		context.showError("Usage: /zen [on|off]");
	}

	// ─── Footer Mode ─────────────────────────────────────────────────────────

	getFooterMode(): FooterMode {
		return this.footerMode;
	}

	setFooterMode(mode: FooterMode): void {
		if (this.zenMode) {
			// Zen mode owns the footer; ignore external mode changes
			return;
		}
		this.footerMode = mode;
		this.persistState({ footerMode: mode });
		this.callbacks.onFooterModeChange(mode);
		this.callbacks.requestRender();
	}

	handleFooterCommand(
		context: CommandExecutionContext,
		footerApi: {
			getToastHistory: (
				count: number,
			) => Array<{ tone: string; message: string }>;
			clearAlerts: () => void;
		},
	): void {
		if (this.zenMode) {
			context.showInfo(
				'Footer mode is controlled by Zen mode. Turn Zen off with "/zen off" to change the footer style.',
			);
			return;
		}

		const tokens = context.argumentText
			.trim()
			.toLowerCase()
			.split(/\s+/)
			.filter((token) => token.length > 0);

		if (tokens.length === 0 || tokens[0] === "help") {
			context.showInfo(
				`Footer mode is ${this.describeFooterMode(this.footerMode)}. Use "/footer ensemble" for the full Maestro Ensemble or "/footer solo" for the minimal Solo style.`,
			);
			return;
		}

		if (tokens[0] === "history") {
			const history = footerApi
				.getToastHistory(5)
				.map((t) => `${t.tone}: ${t.message}`)
				.join("\n");
			context.showInfo(history || "No recent footer alerts (toasts).");
			return;
		}

		if (tokens[0] === "clear") {
			footerApi.clearAlerts();
			context.showInfo("Footer alerts cleared.");
			this.callbacks.requestRender();
			return;
		}

		let candidate = tokens[0];
		if (candidate === "mode" || candidate === "set" || candidate === "style") {
			candidate = tokens[1] ?? "";
		}
		const parsed = this.parseFooterMode(candidate ?? "");
		if (!parsed) {
			context.showError(
				"Footer mode must be either 'ensemble' (rich) or 'solo' (minimal).",
			);
			return;
		}
		if (parsed === this.footerMode) {
			context.showInfo(
				`Footer already using ${this.describeFooterMode(parsed)} mode.`,
			);
			return;
		}
		this.setFooterMode(parsed);
		context.showInfo(
			`Footer switched to ${this.describeFooterMode(parsed)} mode.`,
		);
	}

	private parseFooterMode(value: string): FooterMode | null {
		switch (value) {
			case "ensemble":
			case "rich":
			case "classic":
			case "full":
				return "ensemble";
			case "solo":
			case "minimal":
			case "lean":
			case "lite":
				return "solo";
			default:
				return null;
		}
	}

	private describeFooterMode(mode: FooterMode): string {
		return mode === "ensemble" ? "Ensemble (rich)" : "Solo (minimal)";
	}

	// ─── Thinking Blocks ─────────────────────────────────────────────────────

	getHideThinkingBlocks(): boolean {
		return this.hideThinkingBlocks;
	}

	setHideThinkingBlocks(hidden: boolean): void {
		this.hideThinkingBlocks = hidden;
		this.persistState({ hideThinkingBlocks: hidden });
		this.callbacks.onHideThinkingBlocksChange(hidden);
	}

	toggleThinkingBlocks(): void {
		this.setHideThinkingBlocks(!this.hideThinkingBlocks);
	}

	// ─── Aggregated State ────────────────────────────────────────────────────

	/**
	 * Get the current UI state for display or grouped command handlers
	 */
	getState(): {
		zenMode: boolean;
		cleanMode: CleanMode;
		footerMode: FooterMode;
	} {
		return {
			zenMode: this.zenMode,
			cleanMode: this.cleanMode,
			footerMode: this.footerMode,
		};
	}

	// ─── Persistence ─────────────────────────────────────────────────────────

	private persistState(partial: Partial<UiState>): void {
		saveUiState(partial);
	}
}
