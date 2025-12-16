import type { Container, TUI } from "@evalops/tui";
import type { AppMessage, AssistantMessage } from "../../agent/types.js";
import type { CleanMode } from "../../conversation/render-model.js";
import { AgentEventRouter } from "../agent-event-router.js";
import type { LoaderView } from "../loader/loader-view.js";
import { MessageView } from "../message-view.js";
import type { RunController } from "../run/run-controller.js";
import type { SessionContext } from "../session/session-context.js";
import { StreamingView } from "../streaming-view.js";
import type { LowBandwidthConfig } from "../terminal/terminal-utils.js";
import type { ToolExecutionComponent } from "../tool-execution.js";
import { ToolOutputView } from "../tool-output-view.js";

export function createToolingViews(params: {
	chatContainer: Container;
	ui: TUI;
	uiStateCompactTools?: boolean;
	pendingTools: Map<string, ToolExecutionComponent>;
	lowBandwidth: LowBandwidthConfig;
	getCleanMode: () => CleanMode;
	getHideThinkingBlocks: () => boolean;
	loaderView: LoaderView;
	runController: RunController;
	sessionContext: SessionContext;
	extractText: (message: AppMessage) => string;
	clearEditor: () => void;
	requestRender: () => void;
	clearPendingTools: () => void;
	refreshPlanHint: () => void;
	onAssistantMessageEnd: (message: AssistantMessage) => void;
	showInfoMessage: (message: string) => void;
}): {
	toolOutputView: ToolOutputView;
	messageView: MessageView;
	streamingView: StreamingView;
	agentEventRouter: AgentEventRouter;
} {
	const {
		chatContainer,
		ui,
		uiStateCompactTools,
		pendingTools,
		lowBandwidth,
		getCleanMode,
		getHideThinkingBlocks,
		loaderView,
		runController,
		sessionContext,
		extractText,
		clearEditor,
		requestRender,
		clearPendingTools,
		refreshPlanHint,
		onAssistantMessageEnd,
		showInfoMessage,
	} = params;

	const toolOutputView = new ToolOutputView({
		ui,
		showInfoMessage,
	});
	if (typeof uiStateCompactTools === "boolean") {
		toolOutputView.setCompactMode(uiStateCompactTools, true);
	}

	const messageView = new MessageView({
		chatContainer,
		ui,
		toolComponents: toolOutputView.getTrackedComponents(),
		pendingTools,
		registerToolComponent: (component) =>
			toolOutputView.registerToolComponent(component),
		getHideThinkingBlocks,
	});

	const streamingView = new StreamingView({
		chatContainer,
		pendingTools,
		toolOutputView,
		lowBandwidth,
		getCleanMode,
		getHideThinkingBlocks,
	});

	const agentEventRouter = new AgentEventRouter({
		messageView,
		streamingView,
		loaderView,
		runController,
		sessionContext,
		extractText,
		clearEditor,
		requestRender,
		clearPendingTools,
		refreshPlanHint,
		onAssistantMessageEnd,
	});

	return { toolOutputView, messageView, streamingView, agentEventRouter };
}
