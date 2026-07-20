/**
 * CompactionController - Handles context window compaction functionality
 *
 * Manages manual and automatic context compaction:
 * - Manual compaction via /compact command
 * - Auto-compaction settings via /autocompact command
 * - Pre-prompt context budget enforcement
 * - Compaction telemetry and notifications
 */

import type { CompactionStats } from "../../agent/auto-compaction.js";
import type { AgentState } from "../../agent/types.js";
import { recordCompaction } from "../../telemetry.js";
import {
	type FooterStats,
	calculateFooterStats,
	formatTokenCount,
} from "../utils/footer-utils.js";

export interface CompactionControllerDeps {
	/** Get current agent state */
	getAgentState: () => AgentState;
	/** Get session ID for telemetry */
	getSessionId: () => string;
	/** Conversation compactor instance */
	conversationCompactor: {
		compactHistory: (options?: {
			customInstructions?: string;
			auto?: boolean;
		}) => Promise<void>;
		updateSettings: (settings: { enabled?: boolean }) => void;
		isAutoCompactionEnabled: () => boolean;
		toggleAutoCompaction: () => boolean;
		getSettings: () => {
			reserveTokens: number;
			keepRecentTokens: number;
		};
	};
	/** Auto compaction monitor instance */
	autoCompactionMonitor: {
		check: (
			messages: AgentState["messages"],
			model: AgentState["model"],
		) => CompactionStats;
		recordCompaction: () => void;
		getWarningThresholds: () => { warning: number; critical: number };
	};
	/** Session context for recording artifacts */
	sessionContext: {
		recordCompactionArtifact: (data: {
			beforeTokens: number;
			afterTokens: number;
			trigger: "auto" | "manual";
		}) => void;
	};
}

export interface CompactionControllerCallbacks {
	/** Show info notification */
	showInfo: (message: string) => void;
	/** Refresh footer hint */
	refreshFooterHint: () => void;
	/** Set context warning level */
	setContextWarningLevel: (level: "none" | "warn" | "danger") => void;
}

export interface CompactionControllerOptions {
	deps: CompactionControllerDeps;
	callbacks: CompactionControllerCallbacks;
}

export class CompactionController {
	private readonly deps: CompactionControllerDeps;
	private readonly callbacks: CompactionControllerCallbacks;
	private compactionInProgress = false;

	constructor(options: CompactionControllerOptions) {
		this.deps = options.deps;
		this.callbacks = options.callbacks;
	}

	/**
	 * Check if compaction is currently in progress
	 */
	isCompacting(): boolean {
		return this.compactionInProgress;
	}

	/**
	 * Run a compaction task with proper locking
	 */
	private async runCompactionTask(work: () => Promise<void>): Promise<boolean> {
		if (this.compactionInProgress) {
			return false;
		}
		this.compactionInProgress = true;
		try {
			await work();
			return true;
		} finally {
			this.compactionInProgress = false;
		}
	}

	/**
	 * Handle /compact command for manual compaction
	 */
	async handleCompactCommand(customInstructions?: string): Promise<void> {
		if (this.compactionInProgress) {
			this.callbacks.showInfo("Already compacting history…");
			return;
		}
		const beforeStats = calculateFooterStats(this.deps.getAgentState());
		const compacted = await this.runCompactionTask(() =>
			this.deps.conversationCompactor.compactHistory({
				customInstructions,
				auto: false,
			}),
		);
		if (compacted) {
			this.recordCompactionDelta(beforeStats, "manual");
		}
	}

	/**
	 * Handle /autocompact command for toggling auto-compaction
	 */
	handleAutocompactCommand(rawInput: string): void {
		const parts = rawInput.trim().split(/\s+/);
		const arg = parts[1]?.toLowerCase();

		if (arg === "on" || arg === "true" || arg === "enable") {
			this.deps.conversationCompactor.updateSettings({ enabled: true });
			this.callbacks.showInfo("Auto-compaction enabled.");
		} else if (arg === "off" || arg === "false" || arg === "disable") {
			this.deps.conversationCompactor.updateSettings({ enabled: false });
			this.callbacks.showInfo("Auto-compaction disabled.");
		} else if (arg === "status" || !arg) {
			const enabled = this.deps.conversationCompactor.isAutoCompactionEnabled();
			const settings = this.deps.conversationCompactor.getSettings();
			this.callbacks.showInfo(
				`Auto-compaction: ${enabled ? "enabled" : "disabled"}\n` +
					`Reserve tokens: ${settings.reserveTokens}\n` +
					`Keep recent tokens: ${settings.keepRecentTokens}`,
			);
		} else {
			// Toggle
			const newState = this.deps.conversationCompactor.toggleAutoCompaction();
			this.callbacks.showInfo(
				`Auto-compaction ${newState ? "enabled" : "disabled"}.`,
			);
		}
	}

	/**
	 * Ensure context is within budget before sending a prompt.
	 * Called before each user prompt to auto-compact if needed.
	 */
	async ensureContextBudgetBeforePrompt(): Promise<void> {
		if (this.compactionInProgress) {
			return;
		}
		const state = this.deps.getAgentState();
		if (!state?.model?.contextWindow) {
			return;
		}

		// Use AutoCompactionMonitor for rate-limited context checking
		const compactionStats = this.deps.autoCompactionMonitor.check(
			state.messages,
			state.model,
		);

		if (!compactionStats.shouldCompact) {
			return;
		}

		const percentLabel = compactionStats.usagePercent.toFixed(1);
		this.callbacks.showInfo(
			`Context ${percentLabel}% full – compacting history before sending prompt…`,
		);
		const footerStats = calculateFooterStats(state);
		const compacted = await this.runCompactionTask(() =>
			this.deps.conversationCompactor.compactHistory(),
		);
		if (compacted) {
			this.deps.autoCompactionMonitor.recordCompaction();
			this.recordCompactionDelta(footerStats, "auto");
		}
	}

	/**
	 * Handle auto-compaction recommendation from the monitor.
	 * Updates context warning level based on usage.
	 */
	handleAutoCompactionRecommendation(stats: CompactionStats): void {
		const thresholds = this.deps.autoCompactionMonitor.getWarningThresholds();
		if (stats.usagePercent >= thresholds.critical) {
			this.callbacks.setContextWarningLevel("danger");
		} else if (stats.usagePercent >= thresholds.warning) {
			this.callbacks.setContextWarningLevel("warn");
		} else {
			this.callbacks.setContextWarningLevel("none");
		}
		this.callbacks.refreshFooterHint();
	}

	/**
	 * Record compaction telemetry and show notification
	 */
	private recordCompactionDelta(
		before: FooterStats,
		trigger: "auto" | "manual",
	): void {
		const state = this.deps.getAgentState();
		const after = calculateFooterStats(state);
		if (after.contextTokens === before.contextTokens) {
			return;
		}
		this.deps.sessionContext.recordCompactionArtifact({
			beforeTokens: before.contextTokens,
			afterTokens: after.contextTokens,
			trigger,
		});
		// Record compaction telemetry
		recordCompaction(this.deps.getSessionId(), {
			model: state.model
				? `${state.model.provider}/${state.model.id}`
				: undefined,
			provider: state.model?.provider,
			trigger,
			tokensBefore: before.contextTokens,
			tokensAfter: after.contextTokens,
		});
		const beforeLabel = formatTokenCount(before.contextTokens);
		const afterLabel = formatTokenCount(after.contextTokens);
		const prefix = trigger === "auto" ? "Auto-" : "";
		this.callbacks.showInfo(
			`${prefix}compact reduced context ${beforeLabel} → ${afterLabel}.`,
		);
	}
}

export function createCompactionController(
	options: CompactionControllerOptions,
): CompactionController {
	return new CompactionController(options);
}
