import type { Container, TUI } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import type { SessionManager } from "../../session/manager.js";
import type { SessionModelMetadata } from "../../session/manager.js";
import type { TelemetryStatus } from "../../telemetry.js";
import type { TrainingStatus } from "../../training.js";
import type { GitView } from "../git/git-view.js";
import { DiagnosticsView } from "../status/diagnostics-view.js";
import type { ToolExecutionComponent } from "../tool-execution.js";

export function createDiagnosticsView(params: {
	agent: Agent;
	sessionManager: SessionManager;
	telemetryStatus: TelemetryStatus;
	trainingStatus: TrainingStatus;
	version: string;
	explicitApiKey?: string;
	chatContainer: Container;
	ui: TUI;
	getCurrentModelMetadata: () => SessionModelMetadata | undefined;
	getPendingTools: () => Map<string, ToolExecutionComponent>;
	gitView: GitView;
	todoStorePath: string;
	getApprovalMode: () => string;
	getAlertCount: () => number;
}): DiagnosticsView {
	const {
		agent,
		sessionManager,
		telemetryStatus,
		trainingStatus,
		version,
		explicitApiKey,
		chatContainer,
		ui,
		getCurrentModelMetadata,
		getPendingTools,
		gitView,
		todoStorePath,
		getApprovalMode,
		getAlertCount,
	} = params;

	const diagnosticsView = new DiagnosticsView({
		agent,
		sessionManager,
		telemetryStatus,
		trainingStatus,
		version,
		explicitApiKey,
		chatContainer,
		ui,
		getCurrentModelMetadata,
		getPendingTools,
		gitView,
		todoStorePath,
		getApprovalMode,
		getAlertCount,
		getRenderStats: () => ui.getRenderStats(),
	});
	return diagnosticsView;
}
