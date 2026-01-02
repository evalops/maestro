import type { Container, TUI } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	adjustBoundaryForToolResults,
	buildLocalSummary,
	buildSummarizationPrompt,
	calculateContextTokens,
	decorateSummaryText,
	findCutPoint,
	findPreviousSummary,
	getLastAssistantUsage,
} from "../../agent/compaction.js";
import type {
	AppMessage,
	AssistantMessage,
	Message,
} from "../../agent/types.js";
import {
	createRenderableMessage,
	renderMessageToPlainText,
} from "../../conversation/render-model.js";
import type { SessionManager } from "../../session/manager.js";
import { createLogger } from "../../utils/logger.js";
import type { FooterComponent } from "../footer.js";
import type { ToolExecutionComponent } from "../tool-execution.js";

const logger = createLogger("tui:conversation-compactor");

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
		const messages = [...this.options.agent.state.messages];
		const keepCount = 6;

		if (messages.length <= keepCount + 1) {
			this.options.showInfoMessage(
				"Not enough history to compact. Keep chatting!",
			);
			return;
		}

		// Calculate boundary using token-based cut point detection
		let boundary = Math.max(0, messages.length - keepCount);

		// Use token-based cut point if we have usage data
		const lastUsage = getLastAssistantUsage(messages);
		if (lastUsage) {
			const tokenBasedCut = findCutPoint(
				messages,
				0,
				messages.length,
				this.settings.keepRecentTokens,
			);
			// Use the more conservative of the two (keep more messages)
			boundary = Math.max(boundary, tokenBasedCut);
		}

		// Adjust for tool result integrity
		boundary = adjustBoundaryForToolResults(messages, boundary);

		const older = messages.slice(0, boundary);
		if (!older.length) {
			this.options.showInfoMessage("No earlier messages to compact.");
			return;
		}

		// Look for previous compaction summary (cascading summaries)
		const previousSummary = findPreviousSummary(messages);

		// Prepare messages for summarization
		const summaryInput: Message[] = [];
		if (previousSummary) {
			// Include previous summary as context for cascading
			summaryInput.push({
				role: "user",
				content: `Previous session summary:\n${previousSummary}`,
				timestamp: Date.now(),
			});
		}
		const sliceSize = Math.min(40, older.length);
		summaryInput.push(...(older.slice(-sliceSize) as Message[]));

		this.options.footer.setHint("Summarizing history…");
		let summaryMessage: AssistantMessage | null = null;
		let usedModel = false;
		let summaryText = "";

		try {
			const prompt = buildSummarizationPrompt(options?.customInstructions);
			const summary = await this.options.agent.generateSummary(
				summaryInput,
				prompt,
				"You are a careful note-taker that distills coding conversations into actionable summaries.",
			);
			const summaryRenderable = createRenderableMessage(summary as AppMessage);
			const llmText = summaryRenderable
				? renderMessageToPlainText(summaryRenderable).trim()
				: "";
			summaryText = llmText || buildLocalSummary(older as AppMessage[], 32);
			const decorated = decorateSummaryText(summaryText, older.length, true);
			summaryMessage = {
				...summary,
				content: [{ type: "text", text: decorated }],
				timestamp: Date.now(),
			};
			usedModel = true;
		} catch (error) {
			logger.warn("LLM compaction failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.options.footer.setHint(this.options.idleHint);
		}

		if (!summaryMessage) {
			summaryText = buildLocalSummary(older as AppMessage[], 32);
			const fallbackText = decorateSummaryText(
				summaryText,
				older.length,
				false,
			);
			summaryMessage = {
				role: "assistant",
				content: [{ type: "text", text: fallbackText }],
				api: this.options.agent.state.model.api,
				provider: this.options.agent.state.model.provider,
				model: this.options.agent.state.model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
		}

		// Calculate token count before compaction for metrics
		const tokensBefore = lastUsage ? calculateContextTokens(lastUsage) : 0;

		const sessionContext = this.options.sessionManager.buildSessionContext();
		const firstKeptEntryId = sessionContext.messageEntries[boundary]?.id;

		// Save compaction entry to session (for history reconstruction)
		this.options.sessionManager.saveCompaction(
			summaryText,
			boundary,
			tokensBefore,
			{
				auto: options?.auto,
				customInstructions: options?.customInstructions,
				firstKeptEntryId,
			},
		);

		const resumeMessage: AppMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: "Use the above summary to resume the plan from where we left off.",
				},
			],
			timestamp: Date.now(),
		};
		const keep = messages.slice(boundary);
		const newMessages = [summaryMessage as AppMessage, resumeMessage, ...keep];
		this.options.agent.replaceMessages(newMessages);
		this.options.sessionManager.saveMessage(summaryMessage);
		this.options.sessionManager.saveMessage(resumeMessage);

		this.options.chatContainer.clear();
		this.options.toolComponents.clear();
		this.options.renderMessages();
		this.options.showInfoMessage(
			usedModel
				? `Compacted ${older.length} messages via model summary.`
				: `Compacted ${older.length} messages with a local summary.`,
		);
	}
}
