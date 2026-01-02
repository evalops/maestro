import { Container, Spacer, type TUI, Text } from "@evalops/tui";
import type { AgentState, AppMessage } from "../agent/types.js";
import {
	createRenderableMessage,
	isRenderableAssistantMessage,
	isRenderableToolResultMessage,
	isRenderableUserMessage,
} from "../conversation/render-model.js";
import { getTypeScriptHookMessageRenderer } from "../hooks/index.js";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { HookMessageComponent } from "./hook-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

interface MessageViewOptions {
	chatContainer: Container;
	ui: TUI;
	toolComponents: Set<ToolExecutionComponent>;
	pendingTools: Map<string, ToolExecutionComponent>;
	registerToolComponent: (component: ToolExecutionComponent) => void;
	disableAnimations?: boolean;
	getZenMode?: () => boolean;
	getHideThinkingBlocks?: () => boolean;
}

/** Centered dot separator for zen mode */
function createZenSeparator(): Container {
	const container = new Container();
	container.addChild(new Spacer(1));
	const terminalWidth = process.stdout.columns ?? 80;
	const dots = "·  ·  ·";
	const padding = Math.max(0, Math.floor((terminalWidth - dots.length) / 2));
	container.addChild(
		new Text(theme.fg("dim", " ".repeat(padding) + dots), 0, 0),
	);
	container.addChild(new Spacer(1));
	return container;
}

export class MessageView {
	private isFirstUserMessage = true;
	private messageCount = 0;

	constructor(private readonly options: MessageViewOptions) {}

	private isZenMode(): boolean {
		return this.options.getZenMode?.() ?? false;
	}

	private shouldHideThinkingBlocks(): boolean {
		return this.options.getHideThinkingBlocks?.() ?? false;
	}

	addMessage(message: AppMessage): void {
		if (message.role === "branchSummary") {
			const hookMessage = {
				role: "hookMessage" as const,
				customType: "branchSummary",
				content: `Branch summary:\\n\\n${message.summary}`,
				display: true,
				details: { fromId: message.fromId },
				timestamp: message.timestamp,
			};
			if (this.isZenMode() && this.messageCount > 0) {
				this.options.chatContainer.addChild(createZenSeparator());
			}
			const renderer = getTypeScriptHookMessageRenderer(hookMessage.customType);
			const component = new HookMessageComponent(hookMessage, renderer);
			this.options.chatContainer.addChild(component);
			this.messageCount++;
			return;
		}
		if (message.role === "compactionSummary") {
			const hookMessage = {
				role: "hookMessage" as const,
				customType: "compactionSummary",
				content: `Compaction summary:\\n\\n${message.summary}`,
				display: true,
				details: { tokensBefore: message.tokensBefore },
				timestamp: message.timestamp,
			};
			if (this.isZenMode() && this.messageCount > 0) {
				this.options.chatContainer.addChild(createZenSeparator());
			}
			const renderer = getTypeScriptHookMessageRenderer(hookMessage.customType);
			const component = new HookMessageComponent(hookMessage, renderer);
			this.options.chatContainer.addChild(component);
			this.messageCount++;
			return;
		}
		if (message.role === "hookMessage") {
			if (!message.display) {
				return;
			}
			if (this.isZenMode() && this.messageCount > 0) {
				this.options.chatContainer.addChild(createZenSeparator());
			}
			const renderer = getTypeScriptHookMessageRenderer(message.customType);
			const component = new HookMessageComponent(message, renderer);
			this.options.chatContainer.addChild(component);
			this.messageCount++;
			return;
		}

		const renderable = createRenderableMessage(message);
		if (!renderable) {
			return;
		}

		if (isRenderableUserMessage(renderable)) {
			if (renderable.text) {
				// Add zen separator between messages (not before first)
				if (this.isZenMode() && this.messageCount > 0) {
					this.options.chatContainer.addChild(createZenSeparator());
				}
				const userComponent = new UserMessageComponent(
					renderable.text,
					this.isFirstUserMessage,
					renderable.raw.timestamp,
				);
				this.options.chatContainer.addChild(userComponent);
				this.isFirstUserMessage = false;
				this.messageCount++;
			}
			return;
		}

		if (isRenderableAssistantMessage(renderable)) {
			// Add zen separator before assistant messages
			if (this.isZenMode() && this.messageCount > 0) {
				this.options.chatContainer.addChild(createZenSeparator());
			}
			// Filter out thinking blocks if hidden
			const messageToRender = this.shouldHideThinkingBlocks()
				? { ...renderable, thinkingBlocks: [] }
				: renderable;
			const assistantComponent = new AssistantMessageComponent(
				messageToRender,
				{
					disableAnimations: this.options.disableAnimations,
				},
			);
			this.options.chatContainer.addChild(assistantComponent);
			this.messageCount++;
			for (const toolCall of renderable.toolCalls) {
				const component = new ToolExecutionComponent(
					toolCall.name,
					toolCall.arguments,
					{ disableAnimations: this.options.disableAnimations },
				);
				this.options.chatContainer.addChild(component);
				this.options.registerToolComponent(component);
				this.options.pendingTools.set(toolCall.id, component);
				if (
					renderable.stopReason === "aborted" ||
					renderable.stopReason === "error"
				) {
					const errorMessage =
						renderable.stopReason === "aborted"
							? "Operation aborted"
							: renderable.errorMessage || "Error";
					component.updateResult({
						content: [{ type: "text", text: errorMessage }],
						isError: true,
					});
				}
			}
			return;
		}

		if (isRenderableToolResultMessage(renderable)) {
			const component = this.options.pendingTools.get(renderable.toolCallId);
			if (component) {
				component.updateResult({
					content: renderable.raw.content,
					details: renderable.raw.details,
					isError: renderable.raw.isError,
				});
				this.options.pendingTools.delete(renderable.toolCallId);
			}
		}
	}

	renderInitialMessages(state: AgentState): void {
		this.isFirstUserMessage = true;
		this.messageCount = 0;
		this.options.toolComponents.clear();
		this.options.pendingTools.clear();
		for (const message of state.messages) {
			this.addMessage(message as AppMessage);
		}
	}
}
