import type { Container } from "@evalops/tui";
import { Text } from "@evalops/tui";
import type { AssistantMessage } from "../agent/types.js";
import {
	type CleanMode,
	toRenderableAssistantMessage,
} from "../conversation/render-model.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import type { ToolOutputView } from "./tool-output-view.js";

interface StreamingViewOptions {
	chatContainer: Container;
	toolOutputView: ToolOutputView;
	pendingTools: Map<string, ToolExecutionComponent>;
	disableAnimations?: boolean;
	lowBandwidth: {
		enabled: boolean;
		batchIntervalMs: number;
		scrollbackLimit: number;
	};
	getCleanMode: () => CleanMode;
	getHideThinkingBlocks?: () => boolean;
}

export class StreamingView {
	private streamingComponent: AssistantMessageComponent | null = null;
	private bufferedMessages: AssistantMessage[] = [];
	private flushTimer: NodeJS.Timeout | null = null;

	constructor(private readonly options: StreamingViewOptions) {}

	beginAssistantMessage(message: AssistantMessage): void {
		this.streamingComponent = new AssistantMessageComponent(undefined, {
			disableAnimations: this.options.disableAnimations,
		});
		this.options.chatContainer.addChild(this.streamingComponent);
		this.streamingComponent.updateContent(this.renderStreaming(message));
	}

	updateAssistantMessage(message: AssistantMessage): void {
		if (!this.streamingComponent) return;
		if (this.options.lowBandwidth.enabled) {
			this.bufferedMessages.push(message);
			this.scheduleFlush();
		} else {
			this.applyUpdate(message);
		}
		for (const content of message.content) {
			if (content.type === "toolCall") {
				this.ensureToolComponent(
					content.id,
					content.name,
					content.arguments ?? {},
				);
				this.updatePartialArgs(content.id, content.arguments ?? {});
			}
		}
	}

	finishAssistantMessage(message: AssistantMessage): void {
		if (!this.streamingComponent) return;
		if (this.options.lowBandwidth.enabled && this.bufferedMessages.length) {
			for (const buffered of this.bufferedMessages) {
				this.applyUpdate(buffered);
			}
			this.bufferedMessages = [];
		}
		// Final render respects the configured clean mode so duplicate lines are
		// collapsed consistently between streaming and final views.
		const cleanMode = this.options.getCleanMode();
		const mode: CleanMode = cleanMode ?? "off";
		let renderable = toRenderableAssistantMessage(message, { cleanMode: mode });
		// Filter out thinking blocks if hidden
		if (this.options.getHideThinkingBlocks?.()) {
			renderable = { ...renderable, thinkingBlocks: [] };
		}
		this.streamingComponent.updateContent(renderable);
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

	ensureToolComponent(
		toolCallId: string,
		name: string,
		args: Record<string, unknown>,
	): void {
		if (this.options.pendingTools.has(toolCallId)) {
			const component = this.options.pendingTools.get(toolCallId);
			component?.updateArgs(args);
			return;
		}
		this.options.chatContainer.addChild(new Text("", 0, 0));
		const component = new ToolExecutionComponent(name, args, {
			disableAnimations: this.options.disableAnimations,
		});
		this.options.chatContainer.addChild(component);
		this.options.pendingTools.set(toolCallId, component);
		this.options.toolOutputView.registerToolComponent(component);
	}

	updatePartialArgs(toolCallId: string, args: Record<string, unknown>): void {
		const component = this.options.pendingTools.get(toolCallId);
		if (!component) return;
		component.updatePartialArgs(args);
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
		// Remove the in-progress assistant block to avoid stale content when force-stopping.
		this.options.chatContainer.removeChild(this.streamingComponent);
		this.streamingComponent = null;
		this.bufferedMessages = [];
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			const batch = this.bufferedMessages.splice(0);
			if (!this.streamingComponent) return;
			for (const msg of batch) {
				this.applyUpdate(msg);
			}
			this.trimScrollback();
		}, this.options.lowBandwidth.batchIntervalMs);
	}

	private applyUpdate(message: AssistantMessage): void {
		if (!this.streamingComponent) return;
		this.streamingComponent.updateContent(this.renderStreaming(message));
	}

	private trimScrollback(): void {
		if (!this.options.lowBandwidth.enabled) return;
		const limit = this.options.lowBandwidth.scrollbackLimit;
		if (!Number.isFinite(limit) || limit <= 0) return;
		const container = this.options.chatContainer;
		if (container.children.length <= limit) return;
		const removeCount = container.children.length - limit;
		container.children.splice(0, removeCount);
	}

	private renderStreaming(message: AssistantMessage) {
		const cleanMode = this.options.getCleanMode();
		const mode: CleanMode = cleanMode ?? "off";
		const renderable = toRenderableAssistantMessage(message, {
			cleanMode: mode,
		});
		// Filter out thinking blocks if hidden
		if (this.options.getHideThinkingBlocks?.()) {
			return { ...renderable, thinkingBlocks: [] };
		}
		return renderable;
	}
}
