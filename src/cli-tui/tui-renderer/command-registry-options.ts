import {
	type Container,
	type SlashCommand,
	Spacer,
	type TUI,
	Text,
} from "@evalops/tui";
import type { ActionApprovalService } from "../../agent/action-approval.js";
import type { AppMessage } from "../../agent/types.js";
import type { AboutView } from "../about-view.js";
import type { BackgroundTasksController } from "../background/background-tasks-controller.js";
import type { ChangelogView } from "../changelog-view.js";
import { handleAccessCommand } from "../commands/access-command.js";
import { handleAuditCommand } from "../commands/audit-command.js";
import type { GroupedCommandHandlers } from "../commands/grouped-command-handlers.js";
import { handleLimitsCommand } from "../commands/limits-command.js";
import { handleOtelCommand as otelHandler } from "../commands/otel-handlers.js";
import { handlePiiCommand } from "../commands/pii-command.js";
import {
	handleApprovalsCommand,
	handlePlanModeCommand,
} from "../commands/safety-handlers.js";
import type { CommandExecutionContext } from "../commands/types.js";
import {
	handleCopyCommand,
	handleInitCommand,
	handleReportCommand,
} from "../commands/utility-handlers.js";
import type { ConfigView } from "../config-view.js";
import type { FeedbackView } from "../feedback-view.js";
import type { GitView } from "../git/git-view.js";
import type { HotkeysView } from "../hotkeys-view.js";
import type { ImportExportView } from "../import-view.js";
import type { InfoView } from "../info-view.js";
import type { LspView } from "../lsp-view.js";
import type { NotificationView } from "../notification-view.js";
import type { OAuthFlowController } from "../oauth/index.js";
import type { OllamaView } from "../ollama-view.js";
import type { PlanController } from "../plan/plan-controller.js";
import type { QueuePanelController } from "../queue/index.js";
import type { RunCommandView } from "../run/run-command-view.js";
import type { FileSearchView } from "../search/file-search-view.js";
import type { ModelSelectorView } from "../selectors/model-selector-view.js";
import type { ReportSelectorView } from "../selectors/report-selector-view.js";
import type { ThemeSelectorView } from "../selectors/theme-selector-view.js";
import type { ThinkingSelectorView } from "../selectors/thinking-selector-view.js";
import type { SessionView } from "../session/session-view.js";
import type { CostView } from "../status/cost-view.js";
import type { DiagnosticsView } from "../status/diagnostics-view.js";
import type { QuotaView } from "../status/quota-view.js";
import type { TelemetryView } from "../status/telemetry-view.js";
import type { TrainingView } from "../status/training-view.js";
import type { ToolStatusView } from "../tool-status-view.js";
import type { UpdateView } from "../update-view.js";
import type { CommandRegistryOptions } from "../utils/commands/command-registry-builder.js";
import type { BranchController } from "./branch-controller.js";
import type { ClearController } from "./clear-controller.js";
import type { CompactionController } from "./compaction-controller.js";
import type { CustomCommandsController } from "./custom-commands-controller.js";
import type { UiStateController } from "./ui-state-controller.js";

export interface TuiCommandRegistryDeps {
	getRunCommandView: () => RunCommandView;
	getToolStatusView: () => ToolStatusView;
	sessionView: SessionView;
	getClearController: () => ClearController;
	getDiagnosticsView: () => DiagnosticsView;
	planController?: PlanController;
	gitView: GitView;
	backgroundTasksController: BackgroundTasksController;
	compactionController: CompactionController;
	getCustomCommandsController: () => CustomCommandsController;
	getBranchController: () => BranchController;
	oauthFlowController: OAuthFlowController;
	approvalService: ActionApprovalService;
	notificationView: NotificationView;
	chatContainer: Container;
	ui: TUI;
	uiStateController: UiStateController;
	getImportExportView: () => ImportExportView;
	getReportSelectorView: () => ReportSelectorView;
	getFeedbackView: () => FeedbackView;
	getAboutView: () => AboutView;
	getInfoView: () => InfoView;
	getUpdateView: () => UpdateView;
	getChangelogView: () => ChangelogView;
	getHotkeysView: () => HotkeysView;
	getConfigView: () => ConfigView;
	getCostView: () => CostView;
	getQuotaView: () => QuotaView;
	getTelemetryView: () => TelemetryView;
	getTrainingView: () => TrainingView;
	getOllamaView: () => OllamaView;
	getThinkingSelectorView: () => ThinkingSelectorView;
	getModelSelectorView: () => ModelSelectorView;
	getThemeSelectorView: () => ThemeSelectorView;
	getLspView: () => LspView;
	getFileSearchView: () => FileSearchView;
	getQueuePanelController: () => QueuePanelController | null;
	getMessages: () => AppMessage[];
	createCommandContext: (ctx: {
		command: SlashCommand;
		rawInput: string;
		argumentText: string;
		parsedArgs?: Record<string, unknown>;
	}) => CommandExecutionContext;
	handleReviewCommand: (context: CommandExecutionContext) => void;
	handleHistoryCommand: (context: CommandExecutionContext) => void;
	handleToolHistoryCommand: (context: CommandExecutionContext) => void;
	handleSkillsCommand: (context: CommandExecutionContext) => void;
	handleEnhancedUndoCommand: (context: CommandExecutionContext) => void;
	handleFooterCommand: (context: CommandExecutionContext) => void;
	handleCompactToolsCommand: (rawInput: string) => void;
	handleSteerCommand: (context: CommandExecutionContext) => void;
	handleStatsCommand: (context: CommandExecutionContext) => void;
	handleNewChatCommand: (
		context: CommandExecutionContext,
	) => void | Promise<void>;
	handleTreeCommand: (context: CommandExecutionContext) => void;
	handleMcpCommand: (context: CommandExecutionContext) => void;
	handleComposerCommand: (context: CommandExecutionContext) => void;
	handleContextCommand: (context: CommandExecutionContext) => void;
	handleFrameworkCommand: (context: CommandExecutionContext) => void;
	handleGuardianCommand: (context: CommandExecutionContext) => void;
	handleWorkflowCommand: (context: CommandExecutionContext) => void;
	handleChangesCommand: (context: CommandExecutionContext) => void;
	handleCheckpointCommand: (context: CommandExecutionContext) => void;
	handleMemoryCommand: (context: CommandExecutionContext) => void;
	handleModeCommand: (context: CommandExecutionContext) => void;
	getGroupedHandlers: () => GroupedCommandHandlers;
	refreshFooterHint: () => void;
	onQuit: () => void;
}

export function buildTuiCommandRegistryOptions(
	deps: TuiCommandRegistryDeps,
): CommandRegistryOptions {
	const addContent = (text: string): void => {
		deps.chatContainer.addChild(new Spacer(1));
		deps.chatContainer.addChild(new Text(text, 1, 0));
	};

	const requestRender = (): void => {
		deps.ui.requestRender();
	};

	return {
		getRunScriptCompletions: (prefix) =>
			deps.getRunCommandView().getRunScriptCompletions(prefix),
		createContext: (ctx) => deps.createCommandContext(ctx),
		showThinkingSelector: (_context) => deps.getThinkingSelectorView().show(),
		showModelSelector: (_context) => deps.getModelSelectorView().show(),
		showThemeSelector: (_context) => deps.getThemeSelectorView().show(),
		handleExportSession: async (context) =>
			deps.getImportExportView().handleExportCommand(context.rawInput),
		handleShareSession: async (context) =>
			deps.getImportExportView().handleShareCommand(context.rawInput),
		handleTools: (context) =>
			deps.getToolStatusView().handleToolsCommand(context.rawInput),
		handleToolHistory: (context) => deps.handleToolHistoryCommand(context),
		handleSkills: (context) => deps.handleSkillsCommand(context),
		handleImportConfig: (context) =>
			deps.getImportExportView().handleImportCommand(context.rawInput),
		handleSession: (context) =>
			deps.sessionView.handleSessionCommand(context.rawInput),
		handleSessions: (context) =>
			deps.sessionView.handleSessionsCommand(context.rawInput),
		handleReport: (context) =>
			handleReportCommand(context, {
				showBugReport: () => deps.getFeedbackView().handleBugCommand(),
				showFeedback: () => deps.getFeedbackView().handleFeedbackCommand(),
				showReportSelector: () => deps.getReportSelectorView().show(),
			}),
		handleAbout: (_context) => deps.getAboutView().handleAboutCommand(),
		handleHistory: (context) => deps.handleHistoryCommand(context),
		handleClear: async (_context) =>
			await deps.getClearController().handleClearCommand(),
		showStatus: (_context) => deps.getDiagnosticsView().handleStatusCommand(),
		handleReview: (context) => deps.handleReviewCommand(context),
		handleUndo: (context) => deps.handleEnhancedUndoCommand(context),
		handleMention: (context) =>
			deps.getFileSearchView().handleMentionCommand(context.rawInput),
		handleAccess: (context) => handleAccessCommand(context),
		handlePii: (context) => handlePiiCommand(context),
		handleAudit: (context) => handleAuditCommand(context),
		handleLimits: (context) => handleLimitsCommand(context),
		showHelp: (_context) => deps.getInfoView().showHelp(),
		handleUpdate: (_context) => deps.getUpdateView().handleUpdateCommand(),
		handleChangelog: (_context) =>
			deps.getChangelogView().handleChangelogCommand(),
		handleHotkeys: (_context) => deps.getHotkeysView().handleHotkeysCommand(),
		handleConfig: (context) =>
			deps.getConfigView().handleConfigCommand(context),
		handleCost: (context) => deps.getCostView().handleCostCommand(context),
		handleQuota: (context) => deps.getQuotaView().handleQuotaCommand(context),
		handleTelemetry: (context) =>
			deps.getTelemetryView().handleTelemetryCommand(context),
		handleOtel: (_context) =>
			otelHandler({
				showInfo: (msg) => deps.notificationView.showInfo(msg),
			}),
		handleTraining: (context) =>
			deps.getTrainingView().handleTrainingCommand(context),
		handleStats: (context) => deps.handleStatsCommand(context),
		handlePlan: (context) => {
			if (deps.planController) {
				deps.planController.handlePlanCommand(context);
				return;
			}
			context.showInfo("Plan panel is not available.");
		},
		handlePreview: (context) =>
			deps.gitView.handlePreviewCommand(context.rawInput),
		handleRun: (context) =>
			deps.getRunCommandView().handleRunCommand(context.rawInput),
		handleOllama: (context) =>
			deps.getOllamaView().handleOllamaCommand(context.rawInput),
		handleDiagnostics: (context) =>
			deps.getDiagnosticsView().handleDiagnosticsCommand(context.rawInput),
		handleBackground: (context) =>
			deps.backgroundTasksController.handleBackgroundCommand(context),
		handleCompact: (context) => {
			const customInstructions = context.rawInput
				.replace(/^\/compact\s*/i, "")
				.trim();
			return deps.compactionController.handleCompactCommand(
				customInstructions || undefined,
			);
		},
		handleAutocompact: (context) =>
			deps.compactionController.handleAutocompactCommand(context.rawInput),
		handleFooter: (context) => deps.handleFooterCommand(context),
		handleCompactTools: (context) =>
			deps.handleCompactToolsCommand(context.rawInput),
		handleSteer: (context) => deps.handleSteerCommand(context),
		handleCommands: (context) =>
			deps.getCustomCommandsController().handleCommandsCommand(context),
		handleQueue: (context) => {
			const queuePanelController = deps.getQueuePanelController();
			if (queuePanelController) {
				queuePanelController.handleQueueCommand(context);
				return;
			}
			context.showInfo("Prompt queue is not available.");
		},
		handleBranch: (context) =>
			deps.getBranchController().handleBranchCommand(context),
		handleTree: (context) => deps.handleTreeCommand(context),
		handleLogin: (context) =>
			deps.oauthFlowController.handleLoginCommand(context.argumentText, (msg) =>
				context.showError(msg),
			),
		handleLogout: (context) =>
			deps.oauthFlowController.handleLogoutCommand(
				context.argumentText,
				(msg) => context.showError(msg),
				(msg) => context.showInfo(msg),
			),
		handleQuit: (_context) => deps.onQuit(),
		handleApprovals: (context) =>
			handleApprovalsCommand(context, deps.approvalService, {
				showToast: (msg, type) => deps.notificationView.showToast(msg, type),
				refreshFooterHint: () => deps.refreshFooterHint(),
				addContent,
				requestRender,
			}),
		handlePlanMode: (context) =>
			handlePlanModeCommand(context, {
				showToast: (msg, type) => deps.notificationView.showToast(msg, type),
				refreshFooterHint: () => deps.refreshFooterHint(),
				addContent,
				requestRender,
			}),
		handleNewChat: (context) => deps.handleNewChatCommand(context),
		handleInitAgents: (context) =>
			handleInitCommand(context, {
				showSuccess: (msg) => deps.notificationView.showToast(msg, "success"),
				showError: (msg) => context.showError(msg),
				addContent,
				requestRender,
			}),
		handleMcp: (context) => deps.handleMcpCommand(context),
		handleComposer: (context) => deps.handleComposerCommand(context),
		handleZen: (context) => deps.uiStateController.handleZenCommand(context),
		handleContext: (context) => deps.handleContextCommand(context),
		handleLsp: (context) =>
			deps.getLspView().handleLspCommand(context.rawInput),
		handleFramework: (context) => deps.handleFrameworkCommand(context),
		handleClean: (context) =>
			deps.uiStateController.handleCleanCommand(context),
		handleGuardian: (context) => deps.handleGuardianCommand(context),
		handleWorkflow: (context) => deps.handleWorkflowCommand(context),
		handleChanges: (context) => deps.handleChangesCommand(context),
		handleCheckpoint: (context) => deps.handleCheckpointCommand(context),
		handleMemory: (context) => deps.handleMemoryCommand(context),
		handleMode: (context) => deps.handleModeCommand(context),
		handlePrompts: (context) =>
			deps.getCustomCommandsController().handlePromptsCommand(context),
		handleCopy: (context) =>
			handleCopyCommand(
				context,
				{ getMessages: () => deps.getMessages() },
				{
					showInfo: (msg) => context.showInfo(msg),
					showError: (msg) => context.showError(msg),
				},
			),
		handleSessionCommand: (context) =>
			deps.getGroupedHandlers().handleSession(context),
		handleDiagCommand: (context) =>
			deps.getGroupedHandlers().handleDiag(context),
		handleUiCommand: (context) => deps.getGroupedHandlers().handleUi(context),
		handleSafetyCommand: (context) =>
			deps.getGroupedHandlers().handleSafety(context),
		handleGitCommand: (context) => deps.getGroupedHandlers().handleGit(context),
		handleAuthCommand: (context) =>
			deps.getGroupedHandlers().handleAuth(context),
		handleUsageCommand: (context) =>
			deps.getGroupedHandlers().handleUsage(context),
		handleUndoCommand: (context) =>
			deps.getGroupedHandlers().handleUndo(context),
		handleConfigCommand: (context) =>
			deps.getGroupedHandlers().handleConfig(context),
		handleToolsCommand: (context) =>
			deps.getGroupedHandlers().handleTools(context),
	};
}
