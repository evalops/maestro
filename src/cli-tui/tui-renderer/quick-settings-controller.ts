/**
 * QuickSettingsController - Handles keyboard shortcut-triggered settings
 *
 * Manages quick toggle and cycle actions triggered by keyboard shortcuts:
 * - Ctrl+P: Cycle through available models
 * - Ctrl+O: Toggle tool output compact mode
 * - Ctrl+T: Toggle thinking blocks visibility
 * - Shift+Tab: Cycle thinking level (when not in slash completion)
 */

import type { Agent } from "../../agent/agent.js";
import type { ThinkingLevel } from "../../agent/types.js";
import type { RegisteredModel } from "../../models/registry.js";
import { getRegisteredModels } from "../../models/registry.js";
import type {
	SessionManager,
	SessionModelMetadata,
} from "../../session/manager.js";
import { toSessionModelMetadata } from "../../session/manager.js";
import type { NotificationView } from "../notification-view.js";

export interface QuickSettingsCallbacks {
	/** Called after settings change to refresh footer */
	refreshFooterHint: () => void;
	/** Called to persist UI state after changes */
	persistUiState: () => void;
	/** Called to re-render conversation (for thinking blocks toggle) */
	renderConversationView: () => void;
	/** Called to request UI render */
	requestRender: () => void;
	/** Get current tool output compact mode */
	getToolOutputCompact: () => boolean;
	/** Toggle tool output compact mode and return new state */
	toggleToolOutputCompact: () => boolean;
	/** Get current thinking blocks hidden state */
	getHideThinkingBlocks: () => boolean;
	/** Set thinking blocks hidden state */
	setHideThinkingBlocks: (hidden: boolean) => void;
}

export interface QuickSettingsControllerOptions {
	agent: Agent;
	sessionManager: SessionManager;
	notificationView: NotificationView;
	modelScope: RegisteredModel[];
	callbacks: QuickSettingsCallbacks;
}

export class QuickSettingsController {
	private readonly agent: Agent;
	private readonly sessionManager: SessionManager;
	private readonly notificationView: NotificationView;
	private readonly modelScope: RegisteredModel[];
	private readonly callbacks: QuickSettingsCallbacks;
	private isCyclingModel = false;

	constructor(options: QuickSettingsControllerOptions) {
		this.agent = options.agent;
		this.sessionManager = options.sessionManager;
		this.notificationView = options.notificationView;
		this.modelScope = options.modelScope;
		this.callbacks = options.callbacks;
	}

	// ─── Tool Outputs ─────────────────────────────────────────────────────────

	toggleToolOutputs(): void {
		const compact = this.callbacks.toggleToolOutputCompact();
		this.notificationView.showToast(
			compact ? "Tool outputs collapsed." : "Tool outputs expanded.",
			"info",
		);
		this.callbacks.refreshFooterHint();
		this.callbacks.persistUiState();
	}

	// ─── Thinking Blocks ──────────────────────────────────────────────────────

	toggleThinkingBlocks(): void {
		const current = this.callbacks.getHideThinkingBlocks();
		this.callbacks.setHideThinkingBlocks(!current);
		this.notificationView.showToast(
			!current ? "Thinking blocks hidden." : "Thinking blocks visible.",
			"info",
		);
		// Re-render conversation to apply the change
		this.callbacks.renderConversationView();
		this.callbacks.requestRender();
		this.callbacks.persistUiState();
	}

	// ─── Thinking Level ───────────────────────────────────────────────────────

	cycleThinkingLevel(): void {
		const model = this.agent.state.model as RegisteredModel | undefined;
		if (!model?.reasoning) {
			this.notificationView.showInfo(
				"Current model does not support thinking levels.",
			);
			return;
		}
		const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
		const current = this.agent.state.thinkingLevel || "off";
		const index = levels.indexOf(current);
		// Safe: levels is a non-empty constant array and modulo ensures valid index
		const nextLevel = levels[(index + 1) % levels.length]!;
		this.agent.setThinkingLevel(nextLevel);
		this.sessionManager.saveThinkingLevelChange(nextLevel);
		this.notificationView.showInfo(`Thinking level: ${nextLevel}`);
		this.callbacks.refreshFooterHint();
	}

	// ─── Model Cycling ────────────────────────────────────────────────────────

	async cycleModel(): Promise<void> {
		if (this.isCyclingModel) {
			return;
		}
		this.isCyclingModel = true;
		try {
			const candidates =
				this.modelScope.length > 0
					? this.modelScope
					: (getRegisteredModels() as RegisteredModel[]);
			if (candidates.length === 0) {
				this.notificationView.showInfo("No models available to cycle.");
				return;
			}
			if (candidates.length === 1) {
				this.notificationView.showInfo(
					"Only one model in scope. Add more via --models to enable cycling.",
				);
				return;
			}
			const current = this.agent.state.model;
			let index = candidates.findIndex(
				(model) =>
					model.id === current.id && model.provider === current.provider,
			);
			if (index === -1) {
				index = -1;
			}
			// Safe: candidates is verified non-empty above and modulo ensures valid index
			const nextModel = candidates[(index + 1) % candidates.length]!;
			this.agent.setModel(nextModel);
			this.sessionManager.saveModelChange(
				`${nextModel.provider}/${nextModel.id}`,
				toSessionModelMetadata(nextModel) as SessionModelMetadata,
			);
			const label = nextModel.name ?? nextModel.id;
			this.notificationView.showToast(`Model: ${label}`, "success");
			this.callbacks.refreshFooterHint();
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: String(error ?? "Unknown error");
			this.notificationView.showError(`Failed to cycle model: ${message}`);
		} finally {
			this.isCyclingModel = false;
		}
	}
}

export function createQuickSettingsController(
	options: QuickSettingsControllerOptions,
): QuickSettingsController {
	return new QuickSettingsController(options);
}
