import type { LargePasteEvent } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import type { AppMessage, Message } from "../../agent/types.js";
import { createLogger } from "../../utils/logger.js";
import type { NotificationView } from "../notification-view.js";
import type { SessionContext } from "../session/session-context.js";

const logger = createLogger("tui:paste-handler");

/**
 * Editor interface for paste replacement.
 */
export interface PasteEditorInterface {
	replacePasteMarker(pasteId: number, text: string): boolean;
}

/**
 * Options for the paste handler.
 */
export interface PasteHandlerOptions {
	agent: Agent;
	notificationView: NotificationView;
	sessionContext: SessionContext;
	editor: PasteEditorInterface;
	refreshFooterHint(): void;
}

/**
 * Handler for large paste events.
 *
 * When a user pastes a large block of text, this handler:
 * 1. Shows a loading indicator
 * 2. Generates a summary using the agent
 * 3. Replaces the placeholder with the summary
 */
export class PasteHandler {
	private readonly agent: Agent;
	private readonly notificationView: NotificationView;
	private readonly sessionContext: SessionContext;
	private readonly editor: PasteEditorInterface;
	private readonly refreshFooterHint: () => void;
	private pendingSummaries = new Set<number>();

	constructor(options: PasteHandlerOptions) {
		this.agent = options.agent;
		this.notificationView = options.notificationView;
		this.sessionContext = options.sessionContext;
		this.editor = options.editor;
		this.refreshFooterHint = options.refreshFooterHint;
	}

	/**
	 * Check if any paste summaries are pending.
	 */
	hasPending(): boolean {
		return this.pendingSummaries.size > 0;
	}

	/**
	 * Get count of pending paste summaries.
	 */
	pendingCount(): number {
		return this.pendingSummaries.size;
	}

	/**
	 * Handle a large paste event.
	 */
	async handleLargePaste(event: LargePasteEvent): Promise<void> {
		if (!event.content.trim()) {
			return;
		}
		if (this.pendingSummaries.has(event.pasteId)) {
			return;
		}
		this.pendingSummaries.add(event.pasteId);
		this.refreshFooterHint();
		this.notificationView.showInfo(
			`Summarizing pasted block (~${event.lineCount} lines)…`,
		);
		try {
			const summaryMessage = await this.agent.generateSummary(
				[
					{
						role: "user",
						content: [
							{
								type: "text",
								text: this.buildPasteSummaryContext(event.content),
							},
						],
						timestamp: Date.now(),
					} as Message,
				],
				this.buildPasteSummaryPrompt(event.lineCount, event.charCount),
				"You turn large clipboard snippets into concise summaries highlighting key takeaways, files, and follow-ups.",
			);
			const summaryText = this.extractTextFromMessage(
				summaryMessage as AppMessage,
			).trim();
			if (!summaryText) {
				throw new Error("Empty summary");
			}
			const decorated = this.decoratePasteSummary(
				summaryText,
				event.lineCount,
				event.charCount,
			);
			const replaced = this.editor.replacePasteMarker(event.pasteId, decorated);
			if (replaced) {
				this.notificationView.showToast(
					`Summarized pasted block (~${event.lineCount} lines)`,
					"success",
				);
				this.sessionContext.recordPasteSummaryArtifact({
					placeholder: event.marker,
					lineCount: event.lineCount,
					charCount: event.charCount,
					summaryPreview: summaryText.split("\n")[0]?.slice(0, 120) ?? "",
				});
			} else {
				this.notificationView.showInfo(
					"Generated paste summary but it was no longer needed.",
				);
			}
		} catch (error) {
			logger.error(
				"Failed to summarize pasted content",
				error instanceof Error ? error : undefined,
			);
			this.notificationView.showError(
				"Couldn't summarize pasted content. The original text will be sent.",
			);
		} finally {
			this.pendingSummaries.delete(event.pasteId);
			this.refreshFooterHint();
		}
	}

	private buildPasteSummaryPrompt(lines: number, chars: number): string {
		const formatter = new Intl.NumberFormat("en-US");
		return `Summarize the preceding clipboard snippet (~${formatter.format(
			lines,
		)} lines, ${formatter.format(chars)} chars). Provide concise bullet points highlighting what the snippet contains, key issues, and any follow-up actions. Limit to 120 words.`;
	}

	private buildPasteSummaryContext(content: string): string {
		const limit = 12000;
		if (content.length <= limit) {
			return content;
		}
		return `${content.slice(0, limit)}\n\n[truncated ${content.length - limit} additional chars]`;
	}

	private decoratePasteSummary(
		summary: string,
		lines: number,
		chars: number,
	): string {
		const formatter = new Intl.NumberFormat("en-US");
		const meta = `[[Pasted ${formatter.format(lines)} lines (~${formatter.format(
			chars,
		)} chars) summarized]]`;
		return `${meta}\n${summary.trim()}\n[[End paste summary]]`;
	}

	private extractTextFromMessage(
		message: AppMessage | null | undefined,
	): string {
		if (!message) {
			return "";
		}
		const rawContent = (message as { content?: unknown }).content;
		if (typeof rawContent === "string") {
			return rawContent;
		}
		if (!Array.isArray(rawContent)) {
			return "";
		}
		const textParts: string[] = [];
		for (const chunk of rawContent as Array<Record<string, unknown>>) {
			const typedChunk = chunk as {
				type?: unknown;
				text?: unknown;
				thinking?: unknown;
			};
			const type =
				typeof typedChunk.type === "string" ? typedChunk.type : undefined;
			if (type === "text" && typeof typedChunk.text === "string") {
				textParts.push(typedChunk.text);
			} else if (
				type === "thinking" &&
				typeof typedChunk.thinking === "string"
			) {
				textParts.push(typedChunk.thinking);
			}
		}
		return textParts.join("\n");
	}
}
