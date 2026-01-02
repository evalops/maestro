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
	runCommandView: RunCommandView;
	importExportView: ImportExportView;
	toolStatusView: ToolStatusView;
	sessionView: SessionView;
	reportSelectorView: ReportSelectorView;
	feedbackView: FeedbackView;
	aboutView: AboutView;
	clearController: ClearController;
	diagnosticsView: DiagnosticsView;
	fileSearchView: FileSearchView;
	infoView: InfoView;
	updateView: UpdateView;
	changelogView: ChangelogView;
	hotkeysView: HotkeysView;
	configView: ConfigView;
	costView: CostView;
	quotaView: QuotaView;
	telemetryView: TelemetryView;
	trainingView: TrainingView;
	planController?: PlanController;
	gitView: GitView;
	ollamaView: OllamaView;
	backgroundTasksController: BackgroundTasksController;
	compactionController: CompactionController;
	customCommandsController: CustomCommandsController;
	queuePanelController?: QueuePanelController;
	branchController: BranchController;
	oauthFlowController: OAuthFlowController;
	approvalService: ActionApprovalService;
	notificationView: NotificationView;
	chatContainer: Container;
	ui: TUI;
	thinkingSelectorView: ThinkingSelectorView;
	modelSelectorView: ModelSelectorView;
	themeSelectorView: ThemeSelectorView;
	uiStateController: UiStateController;
	lspView: LspView;
	getMessages: () => AppMessage[];
	createCommandContext: (ctx: {
		command: SlashCommand;
		rawInput: string;
		argumentText: string;
		parsedArgs?: Record<string, unknown>;
	}) => CommandExecutionContext;
	handleReviewCommand: (context: CommandExecutionContext) => void;
	handleEnhancedUndoCommand: (context: CommandExecutionContext) => void;
	handleFooterCommand: (context: CommandExecutionContext) => void;
	handleCompactToolsCommand: (rawInput: string) => void;
	handleStatsCommand: (context: CommandExecutionContext) => void;
	handleNewChatCommand: (context: CommandExecutionContext) => void;
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
			deps.runCommandView.getRunScriptCompletions(prefix),
		createContext: (ctx) => deps.createCommandContext(ctx),
		showThinkingSelector: (_context) => deps.thinkingSelectorView.show(),
		showModelSelector: (_context) => deps.modelSelectorView.show(),
		showThemeSelector: (_context) => deps.themeSelectorView.show(),
		handleExportSession: async (context) =>
			deps.importExportView.handleExportCommand(context.rawInput),
		handleShareSession: async (context) =>
			deps.importExportView.handleShareCommand(context.rawInput),
		handleTools: (context) =>
			deps.toolStatusView.handleToolsCommand(context.rawInput),
		handleImportConfig: (context) =>
			deps.importExportView.handleImportCommand(context.rawInput),
		handleSession: (context) =>
			deps.sessionView.handleSessionCommand(context.rawInput),
		handleSessions: (context) =>
			deps.sessionView.handleSessionsCommand(context.rawInput),
		handleReport: (context) =>
			handleReportCommand(context, {
				showBugReport: () => deps.feedbackView.handleBugCommand(),
				showFeedback: () => deps.feedbackView.handleFeedbackCommand(),
				showReportSelector: () => deps.reportSelectorView.show(),
			}),
		handleAbout: (_context) => deps.aboutView.handleAboutCommand(),
		handleClear: async (_context) =>
			await deps.clearController.handleClearCommand(),
		showStatus: (_context) => deps.diagnosticsView.handleStatusCommand(),
		handleReview: (context) => deps.handleReviewCommand(context),
		handleUndo: (context) => deps.handleEnhancedUndoCommand(context),
		handleMention: (context) =>
			deps.fileSearchView.handleMentionCommand(context.rawInput),
		handleAccess: (context) => handleAccessCommand(context),
		handlePii: (context) => handlePiiCommand(context),
		handleAudit: (context) => handleAuditCommand(context),
		showHelp: (_context) => deps.infoView.showHelp(),
		handleUpdate: (_context) => deps.updateView.handleUpdateCommand(),
		handleChangelog: (_context) => deps.changelogView.handleChangelogCommand(),
		handleHotkeys: (_context) => deps.hotkeysView.handleHotkeysCommand(),
		handleConfig: (context) => deps.configView.handleConfigCommand(context),
		handleCost: (context) => deps.costView.handleCostCommand(context),
		handleQuota: (context) => deps.quotaView.handleQuotaCommand(context),
		handleTelemetry: (context) =>
			deps.telemetryView.handleTelemetryCommand(context),
		handleOtel: (_context) =>
			otelHandler({
				showInfo: (msg) => deps.notificationView.showInfo(msg),
			}),
		handleTraining: (context) =>
			deps.trainingView.handleTrainingCommand(context),
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
			deps.runCommandView.handleRunCommand(context.rawInput),
		handleOllama: (context) =>
			deps.ollamaView.handleOllamaCommand(context.rawInput),
		handleDiagnostics: (context) =>
			deps.diagnosticsView.handleDiagnosticsCommand(context.rawInput),
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
		handleCommands: (context) =>
			deps.customCommandsController.handleCommandsCommand(context),
		handleQueue: (context) => {
			if (deps.queuePanelController) {
				deps.queuePanelController.handleQueueCommand(context);
				return;
			}
			context.showInfo("Prompt queue is not available.");
		},
		handleBranch: (context) =>
			deps.branchController.handleBranchCommand(context),
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
		handleLsp: (context) => deps.lspView.handleLspCommand(context.rawInput),
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
			deps.customCommandsController.handlePromptsCommand(context),
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
