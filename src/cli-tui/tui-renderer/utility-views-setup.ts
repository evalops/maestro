import type { Container, SlashCommand, TUI } from "@evalops/tui";
import type { Agent } from "../../agent/agent.js";
import type { SessionManager } from "../../session/manager.js";
import type { SessionModelMetadata } from "../../session/manager.js";
import type { TelemetryStatus } from "../../telemetry.js";
import type { TrainingStatus } from "../../training.js";
import type { CustomEditor } from "../custom-editor.js";
import type { GitView } from "../git/git-view.js";
import type { ModalManager } from "../modal-manager.js";
import { FileSearchView } from "../search/file-search-view.js";
import { DiagnosticsView } from "../status/diagnostics-view.js";
import type { ToolExecutionComponent } from "../tool-execution.js";
import type { ToolStatusView } from "../tool-status-view.js";
import { CommandPaletteView } from "../utils/commands/command-palette-view.js";

export function createUtilityViews(params: {
	agent: Agent;
	sessionManager: SessionManager;
	telemetryStatus: TelemetryStatus;
	trainingStatus: TrainingStatus;
	version: string;
	explicitApiKey?: string;
	chatContainer: Container;
	ui: TUI;
	editor: CustomEditor;
	modalManager: ModalManager;
	getCurrentModelMetadata: () => SessionModelMetadata | undefined;
	getPendingTools: () => Map<string, ToolExecutionComponent>;
	toolStatusView: ToolStatusView;
	gitView: GitView;
	todoStorePath: string;
	getApprovalMode: () => string;
	getAlertCount: () => number;
	showInfoMessage: (message: string) => void;
	getCommands: () => SlashCommand[];
	getRecentCommands: () => string[];
	getFavoriteCommands: () => Set<string>;
	onToggleFavorite: (name: string) => void;
}): {
	diagnosticsView: DiagnosticsView;
	fileSearchView: FileSearchView;
	commandPaletteView: CommandPaletteView;
} {
	const {
		agent,
		sessionManager,
		telemetryStatus,
		trainingStatus,
		version,
		explicitApiKey,
		chatContainer,
		ui,
		editor,
		modalManager,
		getCurrentModelMetadata,
		getPendingTools,
		toolStatusView,
		gitView,
		todoStorePath,
		getApprovalMode,
		getAlertCount,
		showInfoMessage,
		getCommands,
		getRecentCommands,
		getFavoriteCommands,
		onToggleFavorite,
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
		toolStatusView,
		gitView,
		todoStorePath,
		getApprovalMode,
		getAlertCount,
	});

	const fileSearchView = new FileSearchView({
		editor,
		modalManager,
		chatContainer,
		ui,
		showInfoMessage,
	});

	const commandPaletteView = new CommandPaletteView({
		editor,
		modalManager,
		ui,
		getCommands,
		getRecentCommands,
		getFavoriteCommands,
		onToggleFavorite,
	});

	return { diagnosticsView, fileSearchView, commandPaletteView };
}
