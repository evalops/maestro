import type { Container, TUI } from "@evalops/tui";
import type { AgentState, AppMessage } from "../agent/types.js";
import {
	createRenderableMessage,
	isRenderableAssistantMessage,
	isRenderableToolResultMessage,
	isRenderableUserMessage,
} from "../conversation/render-model.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

interface MessageViewOptions {
	chatContainer: Container;
	ui: TUI;
	toolComponents: Set<ToolExecutionComponent>;
	pendingTools: Map<string, ToolExecutionComponent>;
	registerToolComponent: (component: ToolExecutionComponent) => void;
}

export class MessageView {
	private isFirstUserMessage = true;

	constructor(private readonly options: MessageViewOptions) {}

	addMessage(message: AppMessage): void {
		const renderable = createRenderableMessage(message, { cleanMode: "soft" });
		if (!renderable) {
			return;
		}

		if (isRenderableUserMessage(renderable)) {
			if (renderable.text) {
				const userComponent = new UserMessageComponent(
					renderable.text,
					this.isFirstUserMessage,
					renderable.raw.timestamp,
				);
				this.options.chatContainer.addChild(userComponent);
				this.isFirstUserMessage = false;
			}
			return;
		}

		if (isRenderableAssistantMessage(renderable)) {
			const assistantComponent = new AssistantMessageComponent(renderable);
			this.options.chatContainer.addChild(assistantComponent);
			for (const toolCall of renderable.toolCalls) {
				const component = new ToolExecutionComponent(
					toolCall.name,
					toolCall.arguments,
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
		this.options.toolComponents.clear();
		this.options.pendingTools.clear();
		for (const message of state.messages) {
			this.addMessage(message as AppMessage);
		}
	}
}
