import type { AssistantMessage } from "../agent/types.js";
import type { Container } from "../tui-lib/index.js";
import { Text } from "../tui-lib/index.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import type { ToolOutputView } from "./tool-output-view.js";

interface StreamingViewOptions {
	chatContainer: Container;
	toolOutputView: ToolOutputView;
	pendingTools: Map<string, ToolExecutionComponent>;
}

export class StreamingView {
	private streamingComponent: AssistantMessageComponent | null = null;

	constructor(private readonly options: StreamingViewOptions) {}

	beginAssistantMessage(message: AssistantMessage): void {
		this.streamingComponent = new AssistantMessageComponent();
		this.options.chatContainer.addChild(this.streamingComponent);
		this.streamingComponent.updateContent(message);
	}

	updateAssistantMessage(message: AssistantMessage): void {
		if (!this.streamingComponent) return;
		this.streamingComponent.updateContent(message);
		for (const content of message.content) {
			if (content.type === "toolCall") {
				this.ensureToolComponent(content.id, content.name, content.arguments);
			}
		}
	}

	finishAssistantMessage(message: AssistantMessage): void {
		if (!this.streamingComponent) return;
		this.streamingComponent.updateContent(message);
		if (message.stopReason === "aborted" || message.stopReason === "error") {
			const errorMessage =
				message.stopReason === "aborted"
					? "Operation aborted"
					: message.errorMessage || "Error";
			for (const component of this.options.pendingTools.values()) {
				component.updateResult({
					content: [{ type: "text", text: errorMessage }],
					isError: true,
				});
			}
			this.options.pendingTools.clear();
		}
		this.streamingComponent = null;
	}

	ensureToolComponent(toolCallId: string, name: string, args: any): void {
		if (this.options.pendingTools.has(toolCallId)) {
			const component = this.options.pendingTools.get(toolCallId);
			component?.updateArgs(args);
			return;
		}
		this.options.chatContainer.addChild(new Text("", 0, 0));
		const component = new ToolExecutionComponent(name, args);
		this.options.chatContainer.addChild(component);
		this.options.pendingTools.set(toolCallId, component);
		this.options.toolOutputView.registerToolComponent(component);
	}

	resolveToolResult(
		toolCallId: string,
		result: Parameters<ToolExecutionComponent["updateResult"]>[0],
	): void {
		const component = this.options.pendingTools.get(toolCallId);
		if (!component) return;
		component.updateResult(result);
		this.options.pendingTools.delete(toolCallId);
	}

	forceStopStreaming(): void {
		if (!this.streamingComponent) return;
		this.options.chatContainer.removeChild(this.streamingComponent);
		this.streamingComponent = null;
	}
}
