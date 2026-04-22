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
import { createHotkeysCommandHandler } from "../commands/hotkeys-command.js";
import { handleLimitsCommand } from "../commands/limits-command.js";
import { handleOtelCommand as otelHandler } from "../commands/otel-handlers.js";
import { createPackageCommandHandler } from "../commands/package-handlers.js";
import { handlePiiCommand } from "../commands/pii-command.js";
import {
	handleApprovalsCommand,
	handlePlanModeCommand,
} from "../commands/safety-handlers.js";
import type {
	CommandExecutionContext,
	CommandHandlers,
	CommandRegistryOptions,
} from "../commands/types.js";
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
import type { BranchController } from "./branch-controller.js";
import type { ClearController } from "./clear-controller.js";
import {
	type CommandSuiteRuntimeDeps,
	buildCommandSuiteHandlers,
} from "./command-suite-wiring.js";
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
	commandSuite: CommandSuiteRuntimeDeps;
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

	const handlers: CommandHandlers = {
		thinking: (_context) => deps.getThinkingSelectorView().show(),
		model: (_context) => deps.getModelSelectorView().show(),
		theme: (_context) => deps.getThemeSelectorView().show(),
		exportSession: async (context) =>
			deps.getImportExportView().handleExportCommand(context.rawInput),
		shareSession: async (context) =>
			deps.getImportExportView().handleShareCommand(context.rawInput),
		tools: (context) =>
			deps.getToolStatusView().handleToolsCommand(context.rawInput),
		toolHistory: (context) => deps.handleToolHistoryCommand(context),
		skills: (context) => deps.handleSkillsCommand(context),
		importConfig: (context) =>
			deps.getImportExportView().handleImportCommand(context.rawInput),
		session: (context) =>
			deps.sessionView.handleSessionCommand(context.rawInput),
		sessions: (context) =>
			deps.sessionView.handleSessionsCommand(context.rawInput),
		report: (context) =>
			handleReportCommand(context, {
				showBugReport: () => deps.getFeedbackView().handleBugCommand(),
				showFeedback: () => deps.getFeedbackView().handleFeedbackCommand(),
				showReportSelector: () => deps.getReportSelectorView().show(),
			}),
		about: (_context) => deps.getAboutView().handleAboutCommand(),
		history: (context) => deps.handleHistoryCommand(context),
		clear: async (_context) =>
			await deps.getClearController().handleClearCommand(),
		status: (_context) => deps.getDiagnosticsView().handleStatusCommand(),
		review: (context) => deps.handleReviewCommand(context),
		undoChanges: (context) => deps.handleEnhancedUndoCommand(context),
		mention: (context) =>
			deps.getFileSearchView().handleMentionCommand(context.rawInput),
		access: (context) => handleAccessCommand(context),
		pii: (context) => handlePiiCommand(context),
		audit: (context) => handleAuditCommand(context),
		limits: (context) => handleLimitsCommand(context),
		help: (_context) => deps.getInfoView().showHelp(),
		update: (_context) => deps.getUpdateView().handleUpdateCommand(),
		changelog: (_context) => deps.getChangelogView().handleChangelogCommand(),
		hotkeys: (context) =>
			createHotkeysCommandHandler({
				showHotkeys: () => deps.getHotkeysView().handleHotkeysCommand(),
			})(context),
		package: (context) =>
			createPackageCommandHandler({
				cwd: process.cwd(),
				addContent,
				requestRender,
			})(context),
		config: (context) => deps.getConfigView().handleConfigCommand(context),
		cost: (context) => deps.getCostView().handleCostCommand(context),
		quota: (context) => deps.getQuotaView().handleQuotaCommand(context),
		telemetry: (context) =>
			deps.getTelemetryView().handleTelemetryCommand(context),
		otel: (_context) =>
			otelHandler({
				showInfo: (msg) => deps.notificationView.showInfo(msg),
			}),
		training: (context) =>
			deps.getTrainingView().handleTrainingCommand(context),
		stats: (context) => deps.handleStatsCommand(context),
		plan: (context) => {
			if (deps.planController) {
				deps.planController.handlePlanCommand(context);
				return;
			}
			context.showInfo("Plan panel is not available.");
		},
		preview: (context) => deps.gitView.handlePreviewCommand(context.rawInput),
		run: (context) =>
			deps.getRunCommandView().handleRunCommand(context.rawInput),
		ollama: (context) =>
			deps.getOllamaView().handleOllamaCommand(context.rawInput),
		diagnostics: (context) =>
			deps.getDiagnosticsView().handleDiagnosticsCommand(context.rawInput),
		background: (context) =>
			deps.backgroundTasksController.handleBackgroundCommand(context),
		compact: (context) => {
			const customInstructions = context.rawInput
				.replace(/^\/compact\s*/i, "")
				.trim();
			return deps.compactionController.handleCompactCommand(
				customInstructions || undefined,
			);
		},
		autocompact: (context) =>
			deps.compactionController.handleAutocompactCommand(context.rawInput),
		footer: (context) => deps.handleFooterCommand(context),
		compactTools: (context) => deps.handleCompactToolsCommand(context.rawInput),
		steer: (context) => deps.handleSteerCommand(context),
		commands: (context) =>
			deps.getCustomCommandsController().handleCommandsCommand(context),
		queue: (context) => {
			const queuePanelController = deps.getQueuePanelController();
			if (queuePanelController) {
				queuePanelController.handleQueueCommand(context);
				return;
			}
			context.showInfo("Prompt queue is not available.");
		},
		branch: (context) =>
			deps.getBranchController().handleBranchCommand(context),
		tree: (context) => deps.handleTreeCommand(context),
		quit: (_context) => deps.onQuit(),
		approvals: (context) =>
			handleApprovalsCommand(context, deps.approvalService, {
				showToast: (msg, type) => deps.notificationView.showToast(msg, type),
				refreshFooterHint: () => deps.refreshFooterHint(),
				addContent,
				requestRender,
			}),
		planMode: (context) =>
			handlePlanModeCommand(context, {
				showToast: (msg, type) => deps.notificationView.showToast(msg, type),
				refreshFooterHint: () => deps.refreshFooterHint(),
				addContent,
				requestRender,
			}),
		newChat: (context) => deps.handleNewChatCommand(context),
		initAgents: (context) =>
			handleInitCommand(context, {
				showSuccess: (msg) => deps.notificationView.showToast(msg, "success"),
				showError: (msg) => context.showError(msg),
				addContent,
				requestRender,
			}),
		mcp: (context) => deps.handleMcpCommand(context),
		composer: (context) => deps.handleComposerCommand(context),
		login: (context) =>
			deps.oauthFlowController.handleLoginCommand(context.argumentText, (msg) =>
				context.showError(msg),
			),
		logout: (context) =>
			deps.oauthFlowController.handleLogoutCommand(
				context.argumentText,
				(msg) => context.showError(msg),
				(msg) => context.showInfo(msg),
			),
		zen: (context) => deps.uiStateController.handleZenCommand(context),
		context: (context) => deps.handleContextCommand(context),
		lsp: (context) => deps.getLspView().handleLspCommand(context.rawInput),
		framework: (context) => deps.handleFrameworkCommand(context),
		clean: (context) => deps.uiStateController.handleCleanCommand(context),
		guardian: (context) => deps.handleGuardianCommand(context),
		workflow: (context) => deps.handleWorkflowCommand(context),
		changes: (context) => deps.handleChangesCommand(context),
		checkpoint: (context) => deps.handleCheckpointCommand(context),
		memory: (context) => deps.handleMemoryCommand(context),
		mode: (context) => deps.handleModeCommand(context),
		prompts: (context) =>
			deps.getCustomCommandsController().handlePromptsCommand(context),
		copy: (context) =>
			handleCopyCommand(
				context,
				{ getMessages: () => deps.getMessages() },
				{
					showInfo: (msg) => context.showInfo(msg),
					showError: (msg) => context.showError(msg),
				},
			),
	};
	let commandSuiteHandlers: ReturnType<
		typeof buildCommandSuiteHandlers
	> | null = null;

	return {
		getRunScriptCompletions: (prefix) =>
			deps.getRunCommandView().getRunScriptCompletions(prefix),
		createContext: (ctx) => deps.createCommandContext(ctx),
		handlers,
		getCommandSuiteHandlers: () => {
			commandSuiteHandlers ??= buildCommandSuiteHandlers({
				handlers,
				...deps.commandSuite,
			});
			return commandSuiteHandlers;
		},
	};
}
