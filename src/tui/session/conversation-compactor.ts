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

		const boundary = Math.max(0, messages.length - keepCount);
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
			console.warn("LLM compaction failed:", error);
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
		const meta = fromModel
			? "_Model-generated summary of prior discussion._"
			: "_Local summary of prior discussion (model unavailable)._";
		return `${meta}\n\n${text}\n\n(Compacted ${compactedCount} messages on ${new Date().toLocaleString()})`;
	}

	private truncateText(text: string, limit = 160): string {
		if (text.length <= limit) return text;
		return `${text.slice(0, limit - 1).trim()}…`;
	}
}
