import type { Container, TUI } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import type {
	AppMessage,
	AssistantMessage,
	Message,
} from "../../agent/types.js";
import {
	buildConversationModel,
	createRenderableMessage,
	isRenderableAssistantMessage,
	isRenderableToolResultMessage,
	isRenderableUserMessage,
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

export class ConversationCompactor {
	constructor(private readonly options: ConversationCompactorOptions) {}

	async compactHistory(): Promise<void> {
		const messages = [...this.options.agent.state.messages];
		const keepCount = 6;
		if (messages.length <= keepCount + 1) {
			this.options.showInfoMessage(
				"Not enough history to compact. Keep chatting!",
			);
			return;
		}

		let boundary = Math.max(0, messages.length - keepCount);
		boundary = this.adjustBoundaryForToolResults(
			messages as Message[],
			boundary,
		);
		const older = messages.slice(0, boundary);
		if (!older.length) {
			this.options.showInfoMessage("No earlier messages to compact.");
			return;
		}

		const sliceSize = Math.min(40, older.length);
		const summaryInput = older.slice(-sliceSize) as Message[];
		this.options.footer.setHint("Summarizing history…");
		let summaryMessage: AssistantMessage | null = null;
		let usedModel = false;
		try {
			const prompt = this.buildSummarizationPrompt(summaryInput.length);
			const summary = await this.options.agent.generateSummary(
				summaryInput,
				prompt,
				this.buildSummarizationSystemPrompt(),
			);
			const summaryRenderable = createRenderableMessage(summary as AppMessage);
			const llmText = summaryRenderable
				? renderMessageToPlainText(summaryRenderable).trim()
				: "";
			const decorated = this.decorateSummaryText(
				llmText || this.buildCompactSummary(summaryInput),
				older.length,
				true,
			);
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
			const fallbackText = this.decorateSummaryText(
				this.buildCompactSummary(older),
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

	private buildCompactSummary(messages: Message[]): string {
		const lines: string[] = [];
		let exchange = 1;
		const renderables = buildConversationModel(messages as AppMessage[]);
		for (const renderable of renderables) {
			const text = renderMessageToPlainText(renderable).trim();
			if (!text) continue;
			const truncated = this.truncateText(text, 180);
			if (isRenderableUserMessage(renderable)) {
				lines.push(`• User ${exchange}: ${truncated}`);
			} else if (isRenderableAssistantMessage(renderable)) {
				lines.push(`  ↳ Assistant: ${truncated}`);
				exchange += 1;
			} else if (isRenderableToolResultMessage(renderable)) {
				lines.push(
					`  ↳ Tool ${renderable.toolName}: ${this.truncateText(
						renderMessageToPlainText(renderable),
						160,
					)}`,
				);
			}
			if (lines.length >= 32) break;
		}
		if (!lines.length) {
			return "(conversation summary placeholder: no textual content to compact)";
		}
		return `Conversation summary generated at ${new Date().toLocaleString()}\n${lines.join("\n")}`;
	}

	private buildSummarizationPrompt(messageCount: number): string {
		return `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;
	}

	private buildSummarizationSystemPrompt(): string {
		return "You are a careful note-taker that distills coding conversations into actionable summaries.";
	}

	private decorateSummaryText(
		text: string,
		compactedCount: number,
		fromModel: boolean,
	): string {
		// OAI-style handoff prefix that tells the resuming model it's continuing work
		const handoffPrefix = fromModel
			? "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\n\n"
			: "_Local summary of prior discussion (model unavailable)._\n\n";
		return `${handoffPrefix}${text}\n\n(Compacted ${compactedCount} messages on ${new Date().toLocaleString()})`;
	}

	private truncateText(text: string, limit = 160): string {
		if (text.length <= limit) return text;
		return `${text.slice(0, limit - 1).trim()}…`;
	}

	private adjustBoundaryForToolResults(
		messages: Message[],
		boundary: number,
	): number {
		let adjusted = boundary;
		const seenToolCalls = new Set<string>();
		const missingToolCalls = new Set<string>();
		// Tool executions in Composer always follow the pattern: assistant toolCall content
		// followed by a separate toolResult message. We rely on that ordering when walking
		// backwards from the boundary; if we encounter a toolResult whose toolCall was trimmed,
		// we pull the boundary back until the originating assistant message is kept.
		const processAssistantMessage = (message: Message) => {
			if (message.role !== "assistant") return;
			for (const part of message.content ?? []) {
				if (part?.type === "toolCall") {
					seenToolCalls.add(part.id);
					if (missingToolCalls.has(part.id)) {
						missingToolCalls.delete(part.id);
					}
				}
			}
		};
		const processToolResultMessage = (message: Message) => {
			if (message.role !== "toolResult") return;
			if (!seenToolCalls.has(message.toolCallId)) {
				missingToolCalls.add(message.toolCallId);
			}
		};

		for (const message of messages.slice(adjusted)) {
			processAssistantMessage(message);
			processToolResultMessage(message);
		}

		while (missingToolCalls.size > 0 && adjusted > 0) {
			adjusted -= 1;
			const candidate = messages[adjusted];
			processAssistantMessage(candidate);
			processToolResultMessage(candidate);
		}

		return adjusted;
	}
}
