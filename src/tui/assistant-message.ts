import { Container, Markdown, Spacer, Text } from "@evalops/tui";
import type { RenderableAssistantMessage } from "../conversation/render-model.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/** Typing indicator dot animation frames */
const TYPING_FRAMES = ["·  ", "·· ", "···", " ··", "  ·", "   "];
const TYPING_INTERVAL_MS = 150;

/**
 * Component that renders a complete assistant message.
 *
 * During streaming, we reuse existing Markdown components and update their text
 * via setText() rather than clearing and recreating the entire component tree.
 * This prevents visual flickering/cascading where each delta would cause a full
 * re-render of the content.
 */
export class AssistantMessageComponent extends Container {
	private headerText: Text;
	private contentContainer: Container;
	private typingIndicator: Text | null = null;
	private typingFrame = 0;
	private typingTimer: NodeJS.Timeout | null = null;
	private isStreaming = false;

	// Track existing components for incremental updates during streaming
	private textMarkdowns: Markdown[] = [];
	private thinkingContainers: Container[] = [];
	private thinkingMarkdowns: Markdown[] = [];
	private statusText: Text | null = null;
	private topSpacer: Spacer | null = null;

	constructor(message?: RenderableAssistantMessage) {
		super();
		this.contentContainer = new Container();

		// Header with minimal style; updated per message to reflect cleaning state
		this.headerText = new Text("", 1, 0);
		this.addChild(this.headerText);

		this.addChild(this.contentContainer);

		// Add a small spacer at the bottom for separation
		this.addChild(new Spacer(1));

		if (message) {
			this.updateContent(message);
		} else {
			// No message yet - show typing indicator
			this.startTypingIndicator();
		}
	}

	startTypingIndicator(): void {
		if (this.isStreaming) return;
		this.isStreaming = true;
		this.headerText.setText(this.buildHeader(false));
		this.contentContainer.clear();
		// Reset tracked components since we cleared the container
		this.textMarkdowns = [];
		this.thinkingContainers = [];
		this.thinkingMarkdowns = [];
		this.statusText = null;
		this.topSpacer = null;

		this.contentContainer.addChild(new Spacer(1));

		this.typingIndicator = new Text(this.buildTypingLine(), 1, 0);
		this.contentContainer.addChild(this.typingIndicator);

		this.typingTimer = setInterval(() => {
			this.typingFrame = (this.typingFrame + 1) % TYPING_FRAMES.length;
			if (this.typingIndicator) {
				this.typingIndicator.setText(this.buildTypingLine());
			}
		}, TYPING_INTERVAL_MS);
	}

	stopTypingIndicator(): void {
		if (this.typingTimer) {
			clearInterval(this.typingTimer);
			this.typingTimer = null;
		}
		this.typingIndicator = null;
		this.isStreaming = false;
	}

	private buildTypingLine(): string {
		const dots = TYPING_FRAMES[this.typingFrame] ?? "···";
		return theme.fg("muted", `${dots}`);
	}

	updateContent(message: RenderableAssistantMessage): void {
		this.stopTypingIndicator();
		this.headerText.setText(this.buildHeader(message.cleaned));

		const hasPrimaryContent =
			message.textBlocks.length > 0 || message.thinkingBlocks.length > 0;

		// Manage top spacer
		if (hasPrimaryContent && !this.topSpacer) {
			this.topSpacer = new Spacer(1);
			this.contentContainer.addChild(this.topSpacer);
		} else if (!hasPrimaryContent && this.topSpacer) {
			this.contentContainer.removeChild(this.topSpacer);
			this.topSpacer = null;
		}

		// Update thinking blocks - reuse existing components where possible
		this.updateThinkingBlocks(message.thinkingBlocks);

		// Update text blocks - reuse existing Markdown components where possible
		this.updateTextBlocks(message.textBlocks);

		// Handle status text (aborted/error messages)
		this.updateStatusText(message);
	}

	private updateThinkingBlocks(thinkingBlocks: string[]): void {
		// Update existing thinking blocks
		for (let i = 0; i < thinkingBlocks.length; i++) {
			if (i < this.thinkingMarkdowns.length) {
				// Reuse existing markdown component
				this.thinkingMarkdowns[i].setText(thinkingBlocks[i]);
			} else {
				// Create new thinking block
				const container = this.createThinkingBlock(thinkingBlocks[i]);
				this.thinkingContainers.push(container);
				// Extract the Markdown component from the container (it's the second child)
				const markdown = container.children[1] as Markdown;
				this.thinkingMarkdowns.push(markdown);
				// Insert before text blocks
				const insertIndex = this.topSpacer ? 1 + i * 2 : i * 2;
				this.contentContainer.children.splice(insertIndex, 0, container);
				this.contentContainer.children.splice(
					insertIndex + 1,
					0,
					new Spacer(1),
				);
			}
		}

		// Remove excess thinking blocks
		while (this.thinkingContainers.length > thinkingBlocks.length) {
			const container = this.thinkingContainers.pop();
			this.thinkingMarkdowns.pop();
			if (container) {
				// Remove the container and its following spacer
				const idx = this.contentContainer.children.indexOf(container);
				if (idx !== -1) {
					this.contentContainer.children.splice(idx, 2); // Remove container and spacer
				}
			}
		}
	}

	private updateTextBlocks(textBlocks: string[]): void {
		// Update existing text markdown components
		for (let i = 0; i < textBlocks.length; i++) {
			if (i < this.textMarkdowns.length) {
				// Reuse existing markdown component
				this.textMarkdowns[i].setText(textBlocks[i]);
			} else {
				// Create new markdown component
				const markdown = new Markdown(
					textBlocks[i],
					undefined,
					undefined,
					undefined,
					1,
					0,
					getMarkdownTheme(),
				);
				this.textMarkdowns.push(markdown);
				// Insert before status text if it exists, otherwise at end
				if (this.statusText) {
					const statusIdx = this.contentContainer.children.indexOf(
						this.statusText,
					);
					this.contentContainer.children.splice(statusIdx, 0, markdown);
				} else {
					this.contentContainer.addChild(markdown);
				}
			}
		}

		// Remove excess text markdown components
		while (this.textMarkdowns.length > textBlocks.length) {
			const markdown = this.textMarkdowns.pop();
			if (markdown) {
				this.contentContainer.removeChild(markdown);
			}
		}
	}

	private updateStatusText(message: RenderableAssistantMessage): void {
		const hasToolCalls = message.toolCalls.length > 0;
		let newStatusText: string | null = null;

		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				newStatusText = theme.fg("error", "Aborted");
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				newStatusText = theme.fg("error", `Error: ${errorMsg}`);
			}
		}

		if (newStatusText) {
			if (this.statusText) {
				this.statusText.setText(newStatusText);
			} else {
				this.statusText = new Text(newStatusText, 1, 0);
				this.contentContainer.addChild(this.statusText);
			}
		} else if (this.statusText) {
			this.contentContainer.removeChild(this.statusText);
			this.statusText = null;
		}
	}

	private createThinkingBlock(text: string): Container {
		const container = new Container();

		// Dashed header line
		const headerLine = theme.fg("dim", `-- thinking ${"-".repeat(40)}`);
		container.addChild(new Text(headerLine, 1, 0));

		// Thinking content (dimmed, indented)
		container.addChild(
			new Markdown(
				text,
				undefined,
				undefined,
				undefined,
				2, // Indent
				0,
				getMarkdownTheme(),
			),
		);

		// Dashed footer line
		const footerLine = theme.fg("dim", "-".repeat(53));
		container.addChild(new Text(footerLine, 1, 0));

		return container;
	}

	private buildHeader(cleaned: boolean): string {
		const brand = theme.fg("accent", "* COMPOSER");
		const base = `${brand} ${theme.fg("muted", "· response")}`;
		return cleaned ? `${base} ${theme.fg("muted", "· cleaned")}` : base;
	}
}
