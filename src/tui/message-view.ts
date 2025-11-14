import type {
	AgentState,
	AppMessage,
	AssistantMessage,
	ToolResultMessage,
} from "../agent/types.js";
import type { Container, TUI } from "../tui-lib/index.js";
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
		if (message.role === "user") {
			const userMsg = message as any;
			let textContent = "";
			if (typeof userMsg.content === "string") {
				textContent = userMsg.content;
			} else if (Array.isArray(userMsg.content)) {
				const textBlocks = userMsg.content.filter(
					(c: any) => c.type === "text",
				);
				textContent = textBlocks.map((c: any) => c.text).join("");
			}
			if (textContent) {
				const userComponent = new UserMessageComponent(
					textContent,
					this.isFirstUserMessage,
				);
				this.options.chatContainer.addChild(userComponent);
				this.isFirstUserMessage = false;
			}
		} else if (message.role === "assistant") {
			const assistantMsg = message as AssistantMessage;
			const assistantComponent = new AssistantMessageComponent(assistantMsg);
			this.options.chatContainer.addChild(assistantComponent);
			for (const content of assistantMsg.content) {
				if (content.type === "toolCall") {
					const component = new ToolExecutionComponent(
						content.name,
						content.arguments,
					);
					this.options.chatContainer.addChild(component);
					this.options.registerToolComponent(component);
					this.options.pendingTools.set(content.id, component);
					if (
						assistantMsg.stopReason === "aborted" ||
						assistantMsg.stopReason === "error"
					) {
						const errorMessage =
							assistantMsg.stopReason === "aborted"
								? "Operation aborted"
								: assistantMsg.errorMessage || "Error";
						component.updateResult({
							content: [{ type: "text", text: errorMessage }],
							isError: true,
						});
					}
				}
			}
		} else if (message.role === "toolResult") {
			const toolResult = message as ToolResultMessage;
			const component = this.options.pendingTools.get(toolResult.toolCallId);
			if (component) {
				component.updateResult({
					content: toolResult.content,
					details: toolResult.details,
					isError: toolResult.isError,
				});
				this.options.pendingTools.delete(toolResult.toolCallId);
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
