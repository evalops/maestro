import { Container, Markdown, Spacer, Text } from "@evalops/tui";
import type { RenderableAssistantMessage } from "../conversation/render-model.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/**
 * Component that renders a complete assistant message.
 */
export class AssistantMessageComponent extends Container {
	private headerText: Text;
	private contentContainer: Container;

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
		}
	}

	updateContent(message: RenderableAssistantMessage): void {
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
		// Thinking header
		container.addChild(new Text(theme.fg("dim", "⚡ Thinking..."), 1, 0));

		// Thinking content (dimmed)
		container.addChild(
			new Markdown(
				text,
				undefined,
				undefined,
				undefined,
				2, // Indent
				0,
				getMarkdownTheme(), // We might want a specific dimmed theme here
			),
		);
		return container;
	}

	private buildHeader(cleaned: boolean): string {
		const base = `${theme.fg("accent", "COMPOSER")} ${theme.fg("muted", "· response")}`;
		return cleaned ? `${base} ${theme.fg("muted", "· cleaned")}` : base;
	}
}
