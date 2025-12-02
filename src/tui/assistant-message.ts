import { Container, Markdown, Spacer, Text } from "@evalops/tui";
import type { RenderableAssistantMessage } from "../conversation/render-model.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/** Typing indicator dot animation frames */
const TYPING_FRAMES = ["·  ", "·· ", "···", " ··", "  ·", "   "];
const TYPING_INTERVAL_MS = 150;

/**
 * Component that renders a complete assistant message.
 */
export class AssistantMessageComponent extends Container {
	private headerText: Text;
	private contentContainer: Container;
	private typingIndicator: Text | null = null;
	private typingFrame = 0;
	private typingTimer: NodeJS.Timeout | null = null;
	private isStreaming = false;

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
		this.contentContainer.clear();

		const hasPrimaryContent =
			message.textBlocks.length > 0 || message.thinkingBlocks.length > 0;
		if (hasPrimaryContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render thinking blocks first
		for (const thinking of message.thinkingBlocks) {
			this.contentContainer.addChild(this.createThinkingBlock(thinking));
			this.contentContainer.addChild(new Spacer(1));
		}

		for (const text of message.textBlocks) {
			this.contentContainer.addChild(
				new Markdown(
					text,
					undefined,
					undefined,
					undefined,
					1,
					0,
					getMarkdownTheme(),
				),
			);
		}

		const hasToolCalls = message.toolCalls.length > 0;
		if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				this.contentContainer.addChild(
					new Text(theme.fg("error", "Aborted"), 1, 0),
				);
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(
					new Text(theme.fg("error", `Error: ${errorMsg}`), 1, 0),
				);
			}
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
