import type { Container, TUI } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import { buildCompactionHookContext } from "../../agent/compaction-hooks.js";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	performCompaction,
} from "../../agent/compaction.js";
import type { AppMessage, AssistantMessage } from "../../agent/types.js";
import {
	createRenderableMessage,
	renderMessageToPlainText,
} from "../../conversation/render-model.js";
import type { SessionManager } from "../../session/manager.js";
import type { FooterComponent } from "../footer.js";
import type { ToolExecutionComponent } from "../tool-execution.js";

interface ConversationCompactorOptions {
	agent: Agent;
	sessionManager: SessionManager;
	chatContainer: Container;
	ui: TUI;
	footer: FooterComponent;
	idleHint: string;
	toolComponents: Set<ToolExecutionComponent>;
	renderMessages: () => void;
	showInfoMessage: (message: string) => void;
}

/**
 * Options for compactHistory operation.
 */
export interface CompactHistoryOptions {
	/** Custom instructions to focus the summary (e.g., "Focus on database changes") */
	customInstructions?: string;
	/** Whether this is an auto-triggered compaction (vs manual /compact) */
	auto?: boolean;
}

export class ConversationCompactor {
	private settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS };

	constructor(private readonly options: ConversationCompactorOptions) {}

	/**
	 * Get current compaction settings.
	 */
	getSettings(): CompactionSettings {
		return { ...this.settings };
	}

	/**
	 * Update compaction settings.
	 */
	updateSettings(updates: Partial<CompactionSettings>): void {
		this.settings = { ...this.settings, ...updates };
	}

	/**
	 * Toggle auto-compaction on/off.
	 * @returns The new enabled state
	 */
	toggleAutoCompaction(): boolean {
		this.settings.enabled = !this.settings.enabled;
		return this.settings.enabled;
	}

	/**
	 * Check if auto-compaction is enabled.
	 */
	isAutoCompactionEnabled(): boolean {
		return this.settings.enabled;
	}

	/**
	 * Compact conversation history by summarizing older messages.
	 *
	 * Uses token-based cut point detection to determine how much to keep,
	 * preserves turn integrity, and supports cascading summaries.
	 *
	 * @param options - Optional configuration for this compaction
	 */
	async compactHistory(options?: CompactHistoryOptions): Promise<void> {
		this.options.footer.setHint("Summarizing history…");

		try {
			const result = await performCompaction({
				agent: this.options.agent,
				sessionManager: this.options.sessionManager,
				auto: options?.auto,
				trigger: options?.auto ? "auto" : "manual",
				hookContext: buildCompactionHookContext(
					this.options.sessionManager,
					process.cwd(),
				),
				customInstructions: options?.customInstructions,
				renderSummaryText: (summary: AssistantMessage) => {
					const renderable = createRenderableMessage(summary as AppMessage);
					return renderable ? renderMessageToPlainText(renderable).trim() : "";
				},
			});

			if (!result.success) {
				this.options.showInfoMessage(
					result.error === "Not enough history to compact"
						? "Not enough history to compact. Keep chatting!"
						: (result.error ?? "No earlier messages to compact."),
				);
				return;
			}

			this.options.chatContainer.clear();
			this.options.toolComponents.clear();
			this.options.renderMessages();
			this.options.showInfoMessage(
				`Compacted ${result.compactedCount} messages.`,
			);
		} finally {
			this.options.footer.setHint(this.options.idleHint);
		}
	}
}
