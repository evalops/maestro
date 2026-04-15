import type {
	AgentEvent,
	AppMessage,
	AssistantMessage,
} from "../agent/types.js";
import type { LoaderView } from "./loader/loader-view.js";
import type { MessageView } from "./message-view.js";
import type { RunController } from "./run/run-controller.js";
import type { SessionContext } from "./session/session-context.js";
import type { StreamingView } from "./streaming-view.js";

interface AgentEventRouterOptions {
	messageView: MessageView;
	streamingView: StreamingView;
	loaderView: LoaderView;
	runController: RunController;
	sessionContext: SessionContext;
	extractText: (message: AppMessage) => string;
	clearEditor: () => void;
	requestRender: () => void;
	clearPendingTools: () => void;
	refreshPlanHint: () => void;
	onAssistantMessageEnd?: (message: AssistantMessage) => void;
}

export class AgentEventRouter {
	constructor(private readonly options: AgentEventRouterOptions) {}

	handle(event: AgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.options.runController.handleAgentStart();
				return;

			case "turn_start":
				this.options.sessionContext.beginTurn();
				this.options.loaderView.beginTurn();
				return;

			case "message_start":
				this.handleMessageStart(event);
				return;

			case "message_update":
				if (event.message.role === "assistant") {
					this.options.streamingView.updateAssistantMessage(
						event.message as AssistantMessage,
					);
					this.options.requestRender();
				}
				return;

			case "message_end":
				this.handleMessageEnd(event);
				return;

			case "turn_end":
				this.options.sessionContext.completeTurn(
					event.message.role === "assistant"
						? this.options.extractText(event.message as AppMessage)
						: undefined,
				);
				this.options.loaderView.completeTurn();
				return;

			case "tool_execution_start":
				this.options.loaderView.registerToolStage(
					event.toolCallId,
					event.toolName,
					event.args,
					event.summaryLabel,
				);
				this.options.sessionContext.recordToolUsage(event.toolName);
				this.options.sessionContext.recordToolStart(
					event.toolCallId,
					event.toolName,
					event.args,
				);
				this.options.streamingView.ensureToolComponent(
					event.toolCallId,
					event.toolName,
					event.args,
					{
						displayName: event.displayName,
						summaryLabel: event.summaryLabel,
					},
				);
				this.options.requestRender();
				return;

			case "tool_execution_end":
				this.options.streamingView.resolveToolResult(
					event.toolCallId,
					event.result,
				);
				this.options.sessionContext.recordToolEnd(
					event.toolCallId,
					event.toolName,
					event.result,
					event.isError,
				);
				this.options.requestRender();
				this.options.loaderView.markToolComplete(event.toolCallId);
				if (event.toolName === "todo") {
					this.options.refreshPlanHint();
				}
				return;

			case "tool_execution_update":
				this.options.streamingView.updateToolPartialResult(
					event.toolCallId,
					event.partialResult,
				);
				this.options.requestRender();
				return;

			case "status":
				if (event.details.kind === "tool_execution_summary") {
					return;
				}
				this.options.loaderView.showRuntimeStatus(event.status, event.details);
				this.options.requestRender();
				return;

			case "compaction":
				this.options.loaderView.showCompactionNotice(Boolean(event.auto));
				this.options.requestRender();
				return;

			case "error":
				this.options.loaderView.showRuntimeError(event.message);
				this.options.requestRender();
				return;

			case "tool_batch_summary":
				this.options.loaderView.showToolBatchSummary(event.summary);
				this.options.requestRender();
				return;

			case "agent_end":
				this.options.runController.handleAgentEnd(() => {
					this.options.streamingView.forceStopStreaming();
					this.options.clearPendingTools();
				});
				return;
		}
	}

	private handleMessageStart(
		event: AgentEvent & { type: "message_start" },
	): void {
		if (event.message.role === "user") {
			const text = this.options.extractText(event.message as AppMessage);
			this.options.sessionContext.setLastUserMessage(text);
			this.options.sessionContext.recordPrompt(text);
			this.options.messageView.addMessage(event.message as AppMessage);
			this.options.clearEditor();
			this.options.requestRender();
			return;
		}
		if (event.message.role === "assistant") {
			this.options.streamingView.beginAssistantMessage(
				event.message as AssistantMessage,
			);
			this.options.loaderView.setStreamingActive(true);
			this.options.loaderView.maybeTransitionToResponding();
			this.options.requestRender();
		}
	}

	private handleMessageEnd(event: AgentEvent & { type: "message_end" }): void {
		if (event.message.role === "user") {
			return;
		}
		if (event.message.role !== "assistant") {
			this.options.messageView.addMessage(event.message as AppMessage);
			this.options.requestRender();
			return;
		}
		if (event.message.role === "assistant") {
			this.options.loaderView.setStreamingActive(false);
			const assistantMsg = event.message as AssistantMessage;
			this.options.sessionContext.setLastAssistantMessage(
				this.options.extractText(event.message as AppMessage),
			);
			this.options.streamingView.finishAssistantMessage(assistantMsg);
			// Notify about assistant message for retry tracking
			this.options.onAssistantMessageEnd?.(assistantMsg);
		}
		if (
			event.message.role === "assistant" &&
			event.message.stopReason &&
			event.message.stopReason !== "toolUse"
		) {
			this.options.loaderView.maybeTransitionToResponding();
		}
		this.options.requestRender();
	}
}
