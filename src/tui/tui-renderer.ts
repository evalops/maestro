import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { LargePasteEvent } from "@evalops/tui";
import type { SlashCommand } from "@evalops/tui";
import {
	CombinedAutocompleteProvider,
	Container,
	Markdown,
	ProcessTerminal,
	Spacer,
	StatusBar,
	TUI,
	Text,
	detectTerminalFeatures,
} from "@evalops/tui";
import chalk from "chalk";
import type {
	ActionApprovalDecision,
	ActionApprovalRequest,
	ActionApprovalService,
	ApprovalMode,
} from "../agent/action-approval.js";
import type { Agent } from "../agent/agent.js";
import type {
	AgentEvent,
	AgentState,
	AppMessage,
	AssistantMessage,
	Message,
	ThinkingLevel,
	ToolResultMessage,
} from "../agent/types.js";
import {
	loadCommandCatalog,
	parseCommandArgs,
	renderCommandPrompt,
	validateCommandArgs,
} from "../commands/catalog.js";
import type { CleanMode } from "../conversation/render-model.js";
import type { RegisteredModel } from "../models/registry.js";
import { getRegisteredModels } from "../models/registry.js";
import {
	getBackgroundTaskSettings,
	subscribeBackgroundTaskSettings,
} from "../runtime/background-settings.js";
import {
	type SessionModelMetadata,
	toSessionModelMetadata,
} from "../session/manager.js";
import type { SessionManager } from "../session/manager.js";
import { getTelemetryStatus } from "../telemetry.js";
import { getCurrentThemeName, setTheme } from "../theme/theme.js";
import {
	type BackgroundTaskNotification,
	backgroundTaskManager,
} from "../tools/background-tasks.js";
import { getTrainingStatus } from "../training.js";

import { composerManager } from "../composers/index.js";
import { mcpManager } from "../mcp/index.js";
import { getChangelogPath, parseChangelog } from "../update/changelog.js";
import { createLogger } from "../utils/logger.js";
import { AboutView } from "./about-view.js";
import { AgentEventRouter } from "./agent-event-router.js";
import { BashModeView } from "./bash-mode-view.js";
import { ChangelogView } from "./changelog-view.js";
import { formatCommandHelp } from "./commands/argument-parser.js";
import {
	type BackgroundRenderContext,
	handleBackgroundCommand,
} from "./commands/background-handlers.js";
import {
	type ComposerRenderContext,
	handleComposerCommand,
} from "./commands/composer-handlers.js";
import {
	type McpRenderContext,
	handleMcpCommand,
} from "./commands/mcp-handlers.js";
import type {
	CommandEntry,
	CommandExecutionContext,
} from "./commands/types.js";
import { ConfigView } from "./config-view.js";
import { ContextView } from "./context-view.js";
import { CustomEditor } from "./custom-editor.js";
import { EditorView } from "./editor-view.js";
import { FeedbackView } from "./feedback-view.js";
import { FooterComponent } from "./footer.js";
import { GitView } from "./git/git-view.js";
import { ImportExportView } from "./import-view.js";
import { InfoView } from "./info-view.js";
import { InstructionPanelComponent } from "./instruction-panel.js";
import { LoaderView } from "./loader/loader-view.js";
import { LspView } from "./lsp-view.js";
import { MessageView } from "./message-view.js";
import { NotificationView } from "./notification-view.js";
import { OllamaView } from "./ollama-view.js";
import { PlanPanelModal } from "./plan-panel-modal.js";
import { PlanView, type TodoStore, loadTodoStore } from "./plan-view.js";
import type { PromptQueue, PromptQueueEvent } from "./prompt-queue.js";
import { QueuePanelModal } from "./queue-panel-modal.js";
import { RunCommandView } from "./run/run-command-view.js";
import { RunController } from "./run/run-controller.js";
import { FileSearchView } from "./search/file-search-view.js";
import { ModelSelectorView } from "./selectors/model-selector-view.js";
import { OAuthSelectorView } from "./selectors/oauth-selector-view.js";
import { QueueModeSelectorView } from "./selectors/queue-mode-selector-view.js";
import { ReportSelectorView } from "./selectors/report-selector-view.js";
import { ThemeSelectorView } from "./selectors/theme-selector-view.js";
import { ThinkingSelectorView } from "./selectors/thinking-selector-view.js";
import { UserMessageSelectorView } from "./selectors/user-message-selector-view.js";
import { ConversationCompactor } from "./session/conversation-compactor.js";
import { SessionContext } from "./session/session-context.js";
import { SessionDataProvider } from "./session/session-data-provider.js";
import { SessionSummaryController } from "./session/session-summary-controller.js";
import { SessionSwitcherView } from "./session/session-switcher-view.js";
import { SessionView } from "./session/session-view.js";
import { CostView } from "./status/cost-view.js";
import { DiagnosticsView } from "./status/diagnostics-view.js";
import { QuotaView } from "./status/quota-view.js";
import { TelemetryView } from "./status/telemetry-view.js";
import { TrainingView } from "./status/training-view.js";
import { StreamingView } from "./streaming-view.js";
import type { ToolExecutionComponent } from "./tool-execution.js";
import { ToolOutputView } from "./tool-output-view.js";
import { ToolStatusView } from "./tool-status-view.js";
import { type UiState, loadUiState, saveUiState } from "./ui-state.js";
import { UpdateView } from "./update-view.js";
import { CommandPaletteView } from "./utils/commands/command-palette-view.js";
import { buildCommandRegistry } from "./utils/commands/command-registry-builder.js";
import {
	REVIEW_INSTRUCTIONS,
	buildReviewPrompt,
} from "./utils/commands/review-prompt.js";
import {
	type FooterHint,
	type FooterMode,
	type FooterStats,
	calculateFooterStats,
	formatTokenCount,
} from "./utils/footer-utils.js";
import { formatLink } from "./utils/links.js";
import { WelcomeAnimation } from "./welcome-animation.js";

import { handleAgentsInit } from "../cli/commands/agents.js";
import {
	getDefaultFramework,
	getFrameworkSummary,
	listFrameworks,
	resolveFrameworkPreference,
	setDefaultFramework,
	setWorkspaceFramework,
	validateFrameworkPreference,
} from "../config/framework.js";
import type { UpdateCheckResult } from "../update/check.js";
import { ApprovalController } from "./approval/approval-controller.js";
import { ModalManager } from "./modal-manager.js";
import { buildRuntimeBadges } from "./utils/runtime-badges.js";

const logger = createLogger("tui:renderer");
const SSH_RENDER_INTERVAL_MS = 50;

type TerminalCapabilities = {
	isTTY: boolean;
	columns: number;
	rows: number;
	colorLevel: number;
};

const TODO_STORE_PATH =
	process.env.COMPOSER_TODO_FILE ?? join(homedir(), ".composer", "todos.json");

/**
 * Main TUI (Terminal User Interface) renderer for the Composer coding agent.
 *
 * This class orchestrates all UI components, event handling, and user interactions.
 * It manages:
 * - Message rendering (user, assistant, tool calls)
 * - Streaming text display with markdown formatting
 * - Command palette and slash command execution
 * - Session management and switching
 * - Cost tracking and telemetry views
 * - Model selection and configuration
 * - File search and path autocomplete
 * - Git integration and status display
 *
 * The TUI uses an event-driven architecture where the Agent emits events
 * (streaming deltas, tool calls, etc.) and the TuiRenderer subscribes to
 * update the UI accordingly.
 *
 * @example
 * ```typescript
 * const renderer = new TuiRenderer({
 *   agent,
 *   sessionManager,
 *   version: "0.8.2",
 *   sessionContext: { sessionFile: "~/.composer/agent/sessions/default.jsonl" }
 * });
 *
 * await renderer.initialize();
 * renderer.setInputCallback(async (text) => {
 *   await agent.prompt(text);
 * });
 *
 * await renderer.run();
 * ```
 */
import { SmartAutocompleteProvider } from "./smart-autocomplete-provider.js";

export class TuiRenderer {
	private ui: TUI;
	private startupContainer: Container;
	private headerContainer: Container;
	private chatContainer: Container;
	private statusContainer: Container;
	private editor: CustomEditor;
	private editorContainer: Container; // Container to swap between editor and selector
	private footer: FooterComponent;
	private agent: Agent;
	private sessionManager: SessionManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private loaderView: LoaderView;
	private onInterruptCallback?: () => void;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private explicitApiKey?: string;
	private telemetryStatus = getTelemetryStatus();
	private trainingStatus = getTrainingStatus();
	private backgroundSettings = getBackgroundTaskSettings();
	private backgroundSettingsUnsubscribe?: () => void;
	private currentModelMetadata?: SessionModelMetadata;

	// Track if this is the first user message (to skip spacer)
	// Welcome animation shown before first interaction
	private welcomeAnimation: WelcomeAnimation | null = null;

	private readonly idleFooterHint =
		"Try /help for commands or /tools for status";
	private readonly workingFooterHint = "Working… press esc to interrupt";
	private readonly autoCompactThreshold = 85;
	private readonly autoCompactMinimumMessages = 10;
	private planHint: string | null = null;
	private toolOutputView: ToolOutputView;
	private commandPaletteView: CommandPaletteView;
	private slashCommands: SlashCommand[] = [];
	private commandEntries: CommandEntry[] = [];
	private planView: PlanView;
	private sessionView: SessionView;
	private sessionDataProvider: SessionDataProvider;
	private sessionSummaryController!: SessionSummaryController;
	private sessionSwitcherView!: SessionSwitcherView;
	private importExportView: ImportExportView;
	private runCommandView: RunCommandView;
	private bashModeView: BashModeView;
	private gitView: GitView;
	private toolStatusView: ToolStatusView;
	private diagnosticsView: DiagnosticsView;
	private telemetryView: TelemetryView;
	private ollamaView: OllamaView;
	private lspView: LspView;
	private fileSearchView: FileSearchView;
	private conversationCompactor: ConversationCompactor;
	private messageView: MessageView;
	private feedbackView: FeedbackView;
	private aboutView: AboutView;
	private changelogView: ChangelogView;
	private trainingView: TrainingView;
	private contextView?: ContextView;
	private infoView: InfoView;
	private streamingView: StreamingView;
	private thinkingSelectorView: ThinkingSelectorView;
	private themeSelectorView: ThemeSelectorView;
	private modelSelectorView: ModelSelectorView;
	private reportSelectorView: ReportSelectorView;
	private oauthLoginView?: OAuthSelectorView;
	private oauthLogoutView?: OAuthSelectorView;
	private queueModeSelectorView: QueueModeSelectorView;
	private userMessageSelectorView: UserMessageSelectorView;
	private queuePanelModal?: QueuePanelModal;
	private planPanelModal?: PlanPanelModal;
	private notificationView: NotificationView;
	private backgroundTaskNotificationCleanup?: () => void;
	private mcpConnectedHandler?: (data: { name: string; tools: number }) => void;
	private mcpDisconnectedHandler?: (data: { name: string }) => void;
	private mcpToolsChangedHandler?: (data: { name: string }) => void;
	private mcpProgressHandler?: (data: {
		name: string;
		progress: number;
		total?: number;
		message?: string;
	}) => void;
	private mcpLogHandler?: (data: {
		name: string;
		level: string;
		data: unknown;
	}) => void;
	private mcpToolsChangedTimeout?: ReturnType<typeof setTimeout>;
	private composerActivatedHandler?: (composer: { name: string }) => void;
	private composerDeactivatedHandler?: (composer: { name: string }) => void;
	private updateView: UpdateView;
	private configView: ConfigView;
	private costView: CostView;
	private quotaView: QuotaView;
	private runController: RunController;
	private readonly focusEditor = (): void => {
		this.ui.setFocus(this.editor);
	};
	private agentEventRouter!: AgentEventRouter;
	private sessionContext = new SessionContext();
	private promptQueue?: PromptQueue;
	private promptQueueUnsubscribe?: () => void;
	private queuedPromptCount = 0;
	private queueEnabled = false;
	private promptQueueMode: "one" | "all" = "all";
	private cleanMode: CleanMode = "off";
	private nextQueuedPreview: string | null = null;
	private uiState: UiState = {};
	private footerMode: FooterMode = "ensemble";
	private zenMode = false;
	private readonly minimalMode =
		process.env.COMPOSER_TUI_MINIMAL === "1" ||
		process.env.COMPOSER_TUI_MINIMAL?.toLowerCase() === "true" ||
		typeof process.env.SSH_TTY === "string" ||
		typeof process.env.SSH_CONNECTION === "string";
	private isAgentRunning = false;
	private approvalController?: ApprovalController;
	private approvalService: ActionApprovalService;
	private interruptArmed = false;
	private interruptTimeout: NodeJS.Timeout | null = null;
	private compactionInProgress = false;
	private pendingPasteSummaries = new Set<number>();
	private contextWarningLevel: "none" | "warn" | "danger" = "none";
	private modelScope: RegisteredModel[] = [];
	private startupChangelog?: string | null;
	private startupChangelogSummary?: string | null;
	private updateNotice?: UpdateCheckResult | null;
	private startupWarnings: FooterHint[] = [];
	private isCyclingModel = false;
	private isOAuthFlowActive = false;
	private modalManager: ModalManager;
	private terminalCapabilities: TerminalCapabilities = {
		isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
		columns: process.stdout.columns ?? 80,
		rows: process.stdout.rows ?? 24,
		colorLevel: chalk.level || 0,
	};
	private terminalFeatures = detectTerminalFeatures();
	private lowBandwidthConfig = {
		enabled:
			process.env.COMPOSER_TUI_LOW_BW === "1" ||
			process.env.COMPOSER_TUI_LOW_BW?.toLowerCase() === "true" ||
			Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY),
		batchIntervalMs:
			Number.parseInt(process.env.COMPOSER_TUI_LOW_BW_BATCH_MS ?? "", 10) ||
			120,
		scrollbackLimit:
			Number.parseInt(process.env.COMPOSER_TUI_SCROLLBACK ?? "", 10) || 600,
	};

	constructor(
		agent: Agent,
		sessionManager: SessionManager,
		version: string,
		approvalService: ActionApprovalService,
		explicitApiKey?: string,
		options: {
			modelScope?: RegisteredModel[];
			startupChangelog?: string | null;
			startupChangelogSummary?: string | null;
			updateNotice?: UpdateCheckResult | null;
		} = {},
	) {
		this.uiState = loadUiState();
		if (this.uiState.queueMode) {
			this.promptQueueMode = this.uiState.queueMode;
		}
		if (this.uiState.cleanMode) {
			this.cleanMode = this.uiState.cleanMode;
		}
		const envCleanMode = this.readCleanModeFromEnv();
		if (envCleanMode) {
			this.cleanMode = envCleanMode;
		}
		if (this.uiState.footerMode) {
			this.footerMode = this.uiState.footerMode;
		}
		if (typeof this.uiState.zenMode === "boolean") {
			this.zenMode = this.uiState.zenMode;
		}
		this.agent = agent;
		this.sessionManager = sessionManager;
		this.version = version;
		this.explicitApiKey = explicitApiKey;
		this.modelScope = options.modelScope ?? [];
		this.backgroundSettingsUnsubscribe = subscribeBackgroundTaskSettings(
			(settings) => {
				this.backgroundSettings = settings;
			},
		);
		this.startupChangelog = options.startupChangelog;
		this.startupChangelogSummary = options.startupChangelogSummary;
		this.updateNotice = options.updateNotice;
		this.ui = new TUI(new ProcessTerminal(), this.terminalFeatures);
		this.configureRenderThrottle();
		this.refreshTerminalCapabilities();
		process.stdout.on("resize", () => this.refreshTerminalCapabilities());
		this.startupContainer = new Container();
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.statusContainer = new Container();
		this.editor = new CustomEditor();
		this.editor.onLargePaste = (event) => {
			void this.handleLargePaste(event);
		};
		this.editor.onTyping = () => {
			this.handleEditorTyping();
		};
		this.editor.onShiftTab = () => {
			this.cycleThinkingLevel();
		};
		this.editor.onCtrlP = () => {
			void this.cycleModel();
		};
		this.editor.onCtrlO = () => {
			this.toggleToolOutputs();
		};
		this.editorContainer = new Container(); // Container to hold editor or selector
		this.editorContainer.addChild(this.editor); // Start with editor
		this.modalManager = new ModalManager(
			this.editorContainer,
			this.ui,
			this.editor,
		);
		this.footer = new FooterComponent(agent.state, this.footerMode);
		this.footer.startBranchTracking(() => this.ui.requestRender());
		this.notificationView = new NotificationView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			footer: this.footer,
		});
		this.surfaceStartupWarnings();
		this.registerBackgroundTaskNotifications();
		this.approvalController = new ApprovalController({
			approvalService,
			ui: this.ui,
			editor: this.editor,
			editorContainer: this.editorContainer,
			notificationView: this.notificationView,
		});
		this.approvalService = approvalService;
		this.loaderView = new LoaderView({
			ui: this.ui,
			statusContainer: this.statusContainer,
			footer: this.footer,
			lowColor: this.terminalFeatures.lowColor,
			lowUnicode: this.terminalFeatures.lowUnicode,
		});
		this.planView = new PlanView({
			filePath: TODO_STORE_PATH,
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
			setPlanHint: (hint) => {
				this.planHint = hint;
				this.refreshFooterHint();
			},
			onStoreChanged: (store) => this.handlePlanStoreChanged(store),
		});
		this.planView.syncHintWithStore();
		this.runCommandView = new RunCommandView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		this.gitView = new GitView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
			showToast: (message, tone) =>
				this.notificationView.showToast(message, tone),
			modalManager: this.modalManager,
		});
		this.runController = new RunController({
			loaderView: this.loaderView,
			footer: this.footer,
			ui: this.ui,
			workingHint: this.workingFooterHint,
			setEditorDisabled: (disabled) => {
				this.editor.disableSubmit = disabled && !this.queueEnabled;
			},
			focusEditor: () => this.focusEditor(),
			clearEditor: () => this.clearEditor(),
			stopRenderer: () => this.stop(),
			refreshFooterHint: () => this.refreshFooterHint(),
			notifyFileChanges: () => this.gitView.notifyFileChanges(),
			inMinimalMode: () => this.isMinimalMode(),
		});
		this.ui.setInterruptHandler(() => this.runController.handleCtrlC());
		this.toolStatusView = new ToolStatusView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			getTools: () => this.agent.state.tools,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		this.sessionDataProvider = new SessionDataProvider(this.sessionManager);
		this.sessionSummaryController = new SessionSummaryController({
			agent: this.agent,
			sessionManager: this.sessionManager,
			sessionDataProvider: this.sessionDataProvider,
			showInfo: (message) => this.notificationView.showInfo(message),
			showError: (message) => this.notificationView.showError(message),
		});
		this.sessionView = new SessionView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
			sessionDataProvider: this.sessionDataProvider,
			openSessionSwitcher: () => this.sessionSwitcherView.show(),
			summarizeSession: (session) =>
				this.sessionSummaryController.summarize(session),
			applyLoadedSessionContext: () => this.applyLoadedSessionContext(),
			showInfoMessage: (message) => this.notificationView.showInfo(message),
			onSessionLoaded: (sessionInfo) => {
				this.toolOutputView.clearTrackedComponents();
				this.renderInitialMessages(this.agent.state);
				this.footer.updateState(this.agent.state);
				this.notificationView.showInfo(
					`Loaded session ${sessionInfo.id} (${sessionInfo.messageCount} messages).`,
				);
			},
			sessionContext: this.sessionContext,
		});
		this.sessionSwitcherView = new SessionSwitcherView({
			sessionDataProvider: this.sessionDataProvider,
			modalManager: this.modalManager,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
			loadSession: (session) => this.sessionView.loadSessionFromItem(session),
			summarizeSession: (session) =>
				this.sessionSummaryController.summarize(session),
		});
		this.diagnosticsView = new DiagnosticsView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			telemetryStatus: this.telemetryStatus,
			trainingStatus: this.trainingStatus,
			version: this.version,
			explicitApiKey: this.explicitApiKey,
			chatContainer: this.chatContainer,
			ui: this.ui,
			getCurrentModelMetadata: () => this.currentModelMetadata,
			getPendingTools: () => this.pendingTools,
			toolStatusView: this.toolStatusView,
			gitView: this.gitView,
			todoStorePath: TODO_STORE_PATH,
			getApprovalMode: () => this.approvalService.getMode(),
			getAlertCount: () => this.footer.getUnseenAlertCount(),
		});
		this.fileSearchView = new FileSearchView({
			editor: this.editor,
			modalManager: this.modalManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		this.commandPaletteView = new CommandPaletteView({
			editor: this.editor,
			modalManager: this.modalManager,
			ui: this.ui,
			getCommands: () => this.slashCommands,
		});
		this.toolOutputView = new ToolOutputView({
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		if (typeof this.uiState.compactTools === "boolean") {
			this.toolOutputView.setCompactMode(this.uiState.compactTools, true);
		}
		this.messageView = new MessageView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			toolComponents: this.toolOutputView.getTrackedComponents(),
			pendingTools: this.pendingTools,
			registerToolComponent: (component) =>
				this.toolOutputView.registerToolComponent(component),
		});
		this.streamingView = new StreamingView({
			chatContainer: this.chatContainer,
			pendingTools: this.pendingTools,
			toolOutputView: this.toolOutputView,
			lowBandwidth: this.lowBandwidthConfig,
			getCleanMode: () => this.cleanMode,
		});
		this.agentEventRouter = new AgentEventRouter({
			messageView: this.messageView,
			streamingView: this.streamingView,
			loaderView: this.loaderView,
			runController: this.runController,
			sessionContext: this.sessionContext,
			extractText: (message) => this.extractTextFromAppMessage(message),
			clearEditor: () => this.clearEditor(),
			requestRender: () => this.ui.requestRender(),
			clearPendingTools: () => this.pendingTools.clear(),
			refreshPlanHint: () => this.planView.syncHintWithStore(),
		});
		this.importExportView = new ImportExportView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
			applyLoadedSessionContext: () => this.applyLoadedSessionContext(),
			recordShareArtifact: (filePath) =>
				this.sessionContext.recordShareArtifact(filePath),
		});
		this.feedbackView = new FeedbackView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
			toolStatusView: this.toolStatusView,
			gitView: this.gitView,
			version: this.version,
			getApprovalMode: () => this.approvalService.getMode(),
		});
		this.aboutView = new AboutView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			gitView: this.gitView,
			chatContainer: this.chatContainer,
			ui: this.ui,
			version: this.version,
			telemetryStatus: () => this.describeTelemetryStatus(),
			getApprovalMode: () => this.approvalService.getMode(),
		});
		this.changelogView = new ChangelogView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showError: (message: string) => this.notificationView.showError(message),
		});
		this.infoView = new InfoView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			getSlashCommands: () => this.slashCommands,
			isInteractive: () => this.terminalCapabilities.isTTY,
		});
		this.thinkingSelectorView = new ThinkingSelectorView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			modalManager: this.modalManager,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		this.themeSelectorView = new ThemeSelectorView({
			currentTheme: () => getCurrentThemeName(),
			modalManager: this.modalManager,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
			onThemeChange: () => this.ui.requestRender(),
		});
		this.modelSelectorView = new ModelSelectorView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			modalManager: this.modalManager,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		this.queueModeSelectorView = new QueueModeSelectorView({
			ui: this.ui,
			modalManager: this.modalManager,
			notificationView: this.notificationView,
			onModeSelected: (mode) => this.setQueueMode(mode),
		});
		this.reportSelectorView = new ReportSelectorView({
			modalManager: this.modalManager,
			ui: this.ui,
			onSelect: (type) => {
				if (type === "bug") {
					this.feedbackView.handleBugCommand();
				} else {
					this.feedbackView.handleFeedbackCommand();
				}
			},
		});
		this.userMessageSelectorView = new UserMessageSelectorView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			editor: this.editor,
			modalManager: this.modalManager,
			ui: this.ui,
			notificationView: this.notificationView,
			onBranchCreated: () => {
				// Complete UI cleanup after branching (same as resetConversation)
				this.sessionContext.resetArtifacts();
				this.toolOutputView.clearTrackedComponents();
				this.chatContainer.clear();
				this.startupContainer.clear();
				this.planView.syncHintWithStore();
				this.planHint = null;
				this.footer.updateState(this.agent.state);
				this.refreshFooterHint();
				this.renderInitialMessages(this.agent.state);
				this.ui.requestRender();
			},
		});
		this.queuePanelModal = new QueuePanelModal({
			onClose: () => {
				this.modalManager.pop();
			},
			onCancel: (id) => {
				if (this.promptQueue) {
					const removed = this.promptQueue.cancel(id);
					if (removed) {
						this.notificationView.showToast(
							`Cancelled queued prompt #${id}`,
							"success",
						);
						this.updateQueuedPromptCount();
						this.refreshQueuePanel();
						this.refreshFooterHint();
					}
				}
			},
			onToggleMode: () => {
				const newMode = this.promptQueueMode === "all" ? "one" : "all";
				this.setQueueMode(newMode);
				this.refreshQueuePanel();
			},
		});
		this.planPanelModal = new PlanPanelModal({
			onClose: () => {
				this.modalManager.pop();
			},
			onNavigate: (delta) => {
				this.planPanelModal?.navigateTasks(delta);
				this.ui.requestRender();
			},
			onToggleComplete: () => {
				this.handlePlanPanelToggleComplete();
			},
			onMoveTask: (direction) => {
				this.handlePlanPanelMoveTask(direction);
			},
		});
		this.conversationCompactor = new ConversationCompactor({
			agent: this.agent,
			sessionManager: this.sessionManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
			footer: this.footer,
			idleHint: this.idleFooterHint,
			toolComponents: this.toolOutputView.getTrackedComponents(),
			renderMessages: () => this.renderInitialMessages(this.agent.state),
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		this.updateView = new UpdateView({
			currentVersion: this.version,
			chatContainer: this.chatContainer,
			ui: this.ui,
			showError: (message) => this.notificationView.showError(message),
		});
		this.configView = new ConfigView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showError: (message) => this.notificationView.showError(message),
			showInfo: (message) => this.notificationView.showInfo(message),
		});
		this.costView = new CostView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfo: (message) => this.notificationView.showInfo(message),
			showError: (message) => this.notificationView.showError(message),
		});
		this.quotaView = new QuotaView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfo: (message) => this.notificationView.showInfo(message),
			showError: (message) => this.notificationView.showError(message),
			getSessionTokenUsage: () => {
				const stats = calculateFooterStats(this.agent.state);
				return stats.totalInput + stats.totalOutput;
			},
		});
		this.telemetryView = new TelemetryView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfo: (message) => this.notificationView.showInfo(message),
			showError: (message) => this.notificationView.showError(message),
			onStatusChanged: (status) => {
				this.telemetryStatus = status;
				this.diagnosticsView.setTelemetryStatus(status);
			},
		});
		this.trainingView = new TrainingView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfo: (message) => this.notificationView.showInfo(message),
			showError: (message) => this.notificationView.showError(message),
			onStatusChanged: (status) => {
				this.trainingStatus = status;
				this.diagnosticsView.setTrainingStatus(status);
			},
		});
		this.ollamaView = new OllamaView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
			showErrorMessage: (message) => this.notificationView.showError(message),
			getRegisteredModels: () => getRegisteredModels(),
			onUseModel: (model) => {
				this.agent.setModel(model);
				this.sessionManager.saveModelChange(
					`${model.provider}/${model.id}`,
					toSessionModelMetadata(model),
				);
				this.notificationView.showToast(`Switched to ${model.id}`, "success");
				this.ui.requestRender();
			},
		});
		this.lspView = new LspView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfo: (message) => this.notificationView.showInfo(message),
			showError: (message) => this.notificationView.showError(message),
		});

		const registry = buildCommandRegistry({
			getRunScriptCompletions: (prefix: string) =>
				this.runCommandView.getRunScriptCompletions(prefix),
			createContext: (ctx) => this.createCommandContext(ctx),
			showThinkingSelector: (_context) => this.thinkingSelectorView.show(),
			showModelSelector: (_context) => this.modelSelectorView.show(),
			showThemeSelector: (_context) => this.themeSelectorView.show(),
			handleExportSession: async (context) =>
				this.importExportView.handleExportCommand(context.rawInput),
			handleShareSession: async (context) =>
				this.importExportView.handleShareCommand(context.rawInput),
			handleTools: (context) =>
				this.toolStatusView.handleToolsCommand(context.rawInput),
			handleImportConfig: (context) =>
				this.importExportView.handleImportCommand(context.rawInput),
			handleSession: (context) =>
				this.sessionView.handleSessionCommand(context.rawInput),
			handleSessions: (context) =>
				this.sessionView.handleSessionsCommand(context.rawInput),
			handleReport: (context) => this.handleReportCommand(context),
			handleAbout: (_context) => this.aboutView.handleAboutCommand(),
			handleClear: async (_context) => await this.handleClearCommand(),
			showStatus: (_context) => this.diagnosticsView.handleStatusCommand(),
			handleReview: (context) => this.handleReviewCommand(context),
			handleUndo: (context) => this.gitView.handleUndoCommand(context.rawInput),
			handleMention: (context) =>
				this.fileSearchView.handleMentionCommand(context.rawInput),
			showHelp: (_context) => this.infoView.showHelp(),
			handleUpdate: (_context) => this.updateView.handleUpdateCommand(),
			handleChangelog: (_context) =>
				this.changelogView.handleChangelogCommand(),
			handleConfig: (context) => this.configView.handleConfigCommand(context),
			handleCost: (context) => this.costView.handleCostCommand(context),
			handleQuota: (context) => this.quotaView.handleQuotaCommand(context),
			handleTelemetry: (context) =>
				this.telemetryView.handleTelemetryCommand(context),
			handleTraining: (context) =>
				this.trainingView.handleTrainingCommand(context),
			handleStats: (context) => this.handleStatsCommand(context),
			handlePlan: (context) => this.handlePlanCommand(context),
			handlePreview: (context) =>
				this.gitView.handlePreviewCommand(context.rawInput),
			handleRun: (context) =>
				this.runCommandView.handleRunCommand(context.rawInput),
			handleOllama: (context) =>
				this.ollamaView.handleOllamaCommand(context.rawInput),
			handleDiagnostics: (context) =>
				this.diagnosticsView.handleDiagnosticsCommand(context.rawInput),
			handleBackground: (context) => this.handleBackgroundCommand(context),
			handleCompact: (_context) => this.handleCompactCommand(),
			handleFooter: (context) => this.handleFooterCommand(context),
			handleCompactTools: (context) =>
				this.handleCompactToolsCommand(context.rawInput),
			handleCommands: (context) => this.handleCommandsCommand(context),
			handleQueue: (context) => this.handleQueueCommand(context),
			handleBranch: (context) => this.handleBranchCommand(context),
			handleLogin: (context) => this.handleLoginCommand(context),
			handleLogout: (context) => this.handleLogoutCommand(context),
			handleQuit: (_context) => {
				this.stop();
				process.exit(0);
			},
			handleApprovals: (context) => this.handleApprovalsCommand(context),
			handlePlanMode: (context) => this.handlePlanModeCommand(context),
			handleNewChat: (context) => this.handleNewChatCommand(context),
			handleInitAgents: (context) => this.handleInitCommand(context),
			handleMcp: (context) => this.handleMcpCommand(context),
			handleComposer: (context) => this.handleComposerCommand(context),
			handleZen: (context) => this.handleZenCommand(context),
			handleContext: (context) => this.handleContextCommand(context),
			handleLsp: (context) => this.lspView.handleLspCommand(context.rawInput),
			handleFramework: (context) => this.handleFrameworkCommand(context),
			handleClean: (context) => this.handleCleanCommand(context),
		});

		this.commandEntries = registry.entries;
		this.slashCommands = registry.commands;

		const autocompleteProvider = new SmartAutocompleteProvider(
			this.slashCommands,
			process.cwd(),
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
		this.bashModeView = new BashModeView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
			onStateChange: () => this.refreshFooterHint(),
			editor: this.editor,
			defaultAutocomplete: autocompleteProvider,
		});
		new EditorView({
			editor: this.editor,
			getCommandEntries: () => this.commandEntries,
			onFirstInput: () => this.dismissWelcomeAnimation(),
			onSubmit: (text) => {
				void this.handleTextSubmit(text);
			},
			shouldInterrupt: () => this.isAgentRunning || this.interruptArmed,
			onInterrupt: () => this.handleInterruptRequest(),
			onCtrlC: () => this.runController.handleCtrlC(),
			showCommandPalette: () => this.commandPaletteView.showCommandPalette(),
			showFileSearch: () => this.fileSearchView.showFileSearch(),
		});

		// Listen for MCP server connections to show notifications
		this.mcpConnectedHandler = ({ name, tools }) => {
			this.notificationView.showToast(
				`MCP server "${name}" connected (${tools} tools)`,
				"success",
			);
			this.refreshFooterHint();
		};
		this.mcpDisconnectedHandler = ({ name }) => {
			this.notificationView.showToast(
				`MCP server "${name}" disconnected`,
				"warn",
			);
			this.refreshFooterHint();
		};
		mcpManager.on("connected", this.mcpConnectedHandler);
		mcpManager.on("disconnected", this.mcpDisconnectedHandler);

		// Listen for tool list changes (debounced to avoid spam)
		const pendingToolsChangedServers = new Set<string>();
		this.mcpToolsChangedHandler = ({ name }) => {
			pendingToolsChangedServers.add(name);
			this.refreshFooterHint();
			if (this.mcpToolsChangedTimeout)
				clearTimeout(this.mcpToolsChangedTimeout);
			this.mcpToolsChangedTimeout = setTimeout(() => {
				const servers = Array.from(pendingToolsChangedServers);
				pendingToolsChangedServers.clear();
				const msg =
					servers.length === 1
						? `MCP server "${servers[0]}" tools updated`
						: `MCP servers updated: ${servers.join(", ")}`;
				this.notificationView.showToast(msg, "info");
			}, 500);
		};
		mcpManager.on("tools_changed", this.mcpToolsChangedHandler);

		// Listen for progress notifications
		this.mcpProgressHandler = ({ name, progress, total, message }) => {
			let msg: string;
			if (total && total > 0) {
				// Determinate progress - show percentage
				const percent = Math.min(
					100,
					Math.max(0, Math.round((progress / total) * 100)),
				);
				msg = message
					? `${name}: ${message} (${percent}%)`
					: `${name}: ${percent}%`;
			} else {
				// Indeterminate progress - skip percentage, show message only
				msg = message ? `${name}: ${message}` : `${name}: in progress`;
			}
			this.notificationView.showToast(msg, "info");
		};
		mcpManager.on("progress", this.mcpProgressHandler);

		// Listen for log messages
		this.mcpLogHandler = ({ name, level, data }) => {
			// Only show warnings and errors as toasts
			if (level === "warning" || level === "error") {
				// Safe JSON.stringify that handles undefined and circular refs
				let msg: string;
				if (typeof data === "string") {
					msg = data;
				} else if (data === undefined || data === null) {
					msg = String(data);
				} else {
					try {
						msg = JSON.stringify(data);
					} catch {
						msg = "[Unserializable data]";
					}
				}
				// Use substring to avoid breaking multi-byte characters
				msg = msg.substring(0, 100);
				this.notificationView.showToast(
					`[${name}] ${msg}`,
					level === "error" ? "warn" : "info",
				);
			}
		};
		mcpManager.on("log", this.mcpLogHandler);

		// Listen for composer activation changes
		this.composerActivatedHandler = (composer) => {
			this.notificationView.showToast(
				`Composer "${composer.name}" activated`,
				"success",
			);
			this.refreshFooterHint();
		};
		this.composerDeactivatedHandler = (composer) => {
			this.notificationView.showToast(
				`Composer "${composer.name}" deactivated`,
				"info",
			);
			this.refreshFooterHint();
		};
		composerManager.on("activated", this.composerActivatedHandler);
		composerManager.on("deactivated", this.composerDeactivatedHandler);
	}

	attachPromptQueue(queue: PromptQueue): void {
		this.promptQueue = queue;
		this.queueEnabled = this.promptQueueMode === "all";
		this.promptQueueUnsubscribe?.();
		this.promptQueueUnsubscribe = queue.subscribe((event) =>
			this.handlePromptQueueEvent(event),
		);
	}

	public async ensureContextBudgetBeforePrompt(): Promise<void> {
		if (this.compactionInProgress) {
			return;
		}
		const state = this.agent.state;
		if (!state?.model?.contextWindow) {
			return;
		}
		if (state.messages.length < this.autoCompactMinimumMessages) {
			return;
		}
		const stats = calculateFooterStats(state);
		if (
			!stats.contextWindow ||
			stats.contextPercent < this.autoCompactThreshold
		) {
			return;
		}
		const percentLabel = stats.contextPercent.toFixed(1);
		this.notificationView.showInfo(
			`Context ${percentLabel}% full – compacting history before sending prompt…`,
		);
		const compacted = await this.runCompactionTask(() =>
			this.conversationCompactor.compactHistory(),
		);
		if (compacted) {
			this.recordCompactionDelta(stats, "auto");
		}
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		await this.detectAndApplyTerminalTheme();
		this.runConnectivityProbe().catch((error) => {
			const msg =
				error instanceof Error
					? error.message
					: "Model connectivity probe failed.";
			this.notificationView.showError(msg);
		});

		// Setup UI layout
		this.ui.addChild(this.headerContainer);

		if (this.zenMode) {
			this.footer.setMode("solo");
		} else {
			this.renderHeader();
		}

		// Show welcome animation initially (can be disabled in minimal mode)
		if (!this.isMinimalMode() && !this.zenMode) {
			this.welcomeAnimation = new WelcomeAnimation(() =>
				this.ui.requestRender(),
			);
			this.chatContainer.addChild(this.welcomeAnimation);
		}

		this.ui.addChild(this.startupContainer);
		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.statusContainer);

		this.ui.addChild(new Spacer(1));
		this.ui.addChild(this.editorContainer); // Use container that can hold editor or selector
		this.refreshFooterHint();
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);
		this.renderStartupAnnouncements();

		// Start the UI
		this.ui.start();
		this.isInitialized = true;
	}

	private renderStartupAnnouncements(): void {
		this.startupContainer.clear();
		let announced = false;
		if (this.updateNotice) {
			const latest = this.updateNotice.latestVersion ?? "";
			const current = this.updateNotice.currentVersion;
			const notes = this.updateNotice.notes;
			const source = this.updateNotice.sourceUrl;
			const headline = chalk.hex("#f59e0b")(
				`Update available: v${latest || "unknown"}`,
			);
			const currentLine = chalk.dim(`Current version: v${current}`);
			const installLine = `${chalk.dim("Update with")} ${chalk.cyan(
				"npm install -g @evalops/composer",
			)}`;
			const noteLine = notes ? chalk.dim(notes) : null;
			const sourceLine = source
				? chalk.dim(`Source: ${formatLink(source, "changelog")}`)
				: null;
			const message = [headline, currentLine, installLine, noteLine, sourceLine]
				.filter(Boolean)
				.join("\n");
			this.startupContainer.addChild(new Spacer(1));
			this.startupContainer.addChild(new Text(message, 1, 0));
			announced = true;
		}

		if (this.startupChangelog) {
			const header = chalk.bold.cyan("What's new");
			this.startupContainer.addChild(new Spacer(1));
			this.startupContainer.addChild(
				new Text(`${header}\n${this.startupChangelog}`, 1, 0),
			);
			announced = true;
		} else if (this.startupChangelogSummary) {
			const line = `${chalk.bold.cyan("What's new")}: ${
				this.startupChangelogSummary
			} ${chalk.dim("(see CHANGELOG.md)")}`;
			this.startupContainer.addChild(new Spacer(1));
			this.startupContainer.addChild(new Text(line.trim(), 1, 0));
			const hintLine = chalk.dim("Hints: /changelog /model /thinking");
			this.startupContainer.addChild(new Text(hintLine, 1, 0));
			announced = true;
		} else if (!announced) {
			const example = chalk.dim(
				`Try: ${chalk.cyan(
					"/review src/tui/tui-renderer.ts — summarize rendering flow",
				)}`,
			);
			this.startupContainer.addChild(new Spacer(1));
			this.startupContainer.addChild(new Text(example, 1, 0));
			announced = true;
		}

		if (this.modelScope.length > 0) {
			const names = this.modelScope.map((model) => model.name ?? model.id);
			const header = chalk.bold("Model scope");
			const scopeLines = [
				`${header}: ${names.join(", ")}`,
				chalk.dim("Press Ctrl+P to cycle scoped models."),
			];
			this.startupContainer.addChild(new Spacer(1));
			this.startupContainer.addChild(new Text(scopeLines.join("\n"), 1, 0));
			announced = true;
		}

		if (announced) {
			this.ui.requestRender();
		} else {
			this.startupContainer.clear();
		}
	}

	async handleEvent(event: AgentEvent, state: AgentState): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}
		if (event.type === "action_approval_required") {
			this.handleApprovalRequired(event.request);
			return;
		}
		if (event.type === "action_approval_resolved") {
			this.handleApprovalResolved(event.request, event.decision);
			return;
		}
		if (event.type === "agent_start") {
			this.isAgentRunning = true;
		} else if (event.type === "agent_end") {
			this.isAgentRunning = false;
			this.clearInterruptArm();
		}

		// Update footer with current stats
		this.footer.updateState(state);
		const stats = calculateFooterStats(state);
		this.maybeShowContextWarning(stats);
		this.currentModelMetadata = toSessionModelMetadata(
			state.model as RegisteredModel,
		);

		this.agentEventRouter.handle(event);
	}

	renderInitialMessages(state: AgentState): void {
		this.footer.updateState(state);
		this.messageView.renderInitialMessages(state);
		this.ui.requestRender();
	}

	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private async handleTextSubmit(text: string): Promise<void> {
		if (this.pendingPasteSummaries.size > 0) {
			this.notificationView.showInfo(
				"Still summarizing pasted content — please wait a moment.",
			);
			return;
		}
		if (await this.bashModeView.tryHandleInput(text)) {
			return;
		}
		if (this.onInputCallback) {
			this.onInputCallback(text);
		}
	}

	setInterruptCallback(callback: () => void): void {
		this.onInterruptCallback = callback;
	}

	private handleInterruptRequest(): void {
		if (!this.isAgentRunning && !this.interruptArmed) {
			return;
		}
		if (!this.interruptArmed) {
			this.armInterrupt();
			return;
		}
		this.executeInterrupt();
	}

	private armInterrupt(): void {
		this.interruptArmed = true;
		if (this.interruptTimeout) {
			clearTimeout(this.interruptTimeout);
		}
		if (!this.isMinimalMode()) {
			this.notificationView.showInfo("Press Esc again within 5s to interrupt.");
		}
		this.footer.setHint("Esc again within 5s to interrupt");
		this.interruptTimeout = setTimeout(() => {
			this.clearInterruptArm();
		}, 5000);
	}

	private executeInterrupt(): void {
		this.clearInterruptArm();
		this.notificationView.showToast("Interrupted current run", "warn");
		if (this.onInterruptCallback) {
			this.onInterruptCallback();
		}
		this.restoreQueuedPromptIfAny();
	}

	private restoreQueuedPromptIfAny(): void {
		if (!this.promptQueue) {
			return;
		}
		const snapshot = this.promptQueue.getSnapshot();
		// Bring active back plus pending onto the editor, newest last
		const messages: string[] = [];
		if (snapshot.active) {
			messages.push(snapshot.active.text);
		}
		for (const entry of snapshot.pending) {
			messages.push(entry.text);
		}
		if (!messages.length) {
			return;
		}
		const restored = messages.join("\n\n");
		this.promptQueue.cancelAll?.({ silent: true });
		this.promptQueue.clearActive?.();
		this.editor.setText(restored);
		this.notificationView.showToast(
			`Restored ${messages.length} queued prompt${messages.length === 1 ? "" : "s"} to the editor.`,
			"info",
		);
		this.updateQueuedPromptCount();
		this.refreshFooterHint();
	}

	private clearInterruptArm(): void {
		if (this.interruptTimeout) {
			clearTimeout(this.interruptTimeout);
			this.interruptTimeout = null;
		}
		if (this.interruptArmed) {
			this.interruptArmed = false;
			if (this.isAgentRunning) {
				this.footer.setHint(this.workingFooterHint);
			} else {
				this.refreshFooterHint();
			}
		}
	}

	private async runCompactionTask(work: () => Promise<void>): Promise<boolean> {
		if (this.compactionInProgress) {
			return false;
		}
		this.compactionInProgress = true;
		try {
			await work();
			return true;
		} finally {
			this.compactionInProgress = false;
		}
	}

	private async handleCompactCommand(): Promise<void> {
		if (this.compactionInProgress) {
			this.notificationView.showInfo("Already compacting history…");
			return;
		}
		const beforeStats = calculateFooterStats(this.agent.state);
		const compacted = await this.runCompactionTask(() =>
			this.conversationCompactor.compactHistory(),
		);
		if (compacted) {
			this.recordCompactionDelta(beforeStats, "manual");
		}
	}

	private setZenMode(enabled: boolean): void {
		this.zenMode = enabled;
		this.persistUiState({ zenMode: enabled });

		if (enabled) {
			this.headerContainer.clear();
			this.footer.setMode("solo");
			if (this.welcomeAnimation) {
				this.dismissWelcomeAnimation();
			}
		} else {
			this.renderHeader();
			// Restore footer mode from state if zen owned it; otherwise keep user's choice
			const currentFooterMode = this.footer.getMode();
			if (currentFooterMode === "solo") {
				this.footer.setMode(this.footerMode);
			}
		}
		this.ui.requestRender();
	}

	private renderHeader(): void {
		this.headerContainer.clear();
		this.headerContainer.addChild(new Spacer(1));
		this.headerContainer.addChild(new InstructionPanelComponent(this.version));
		this.headerContainer.addChild(new Spacer(1));
	}

	private handleZenCommand(context: CommandExecutionContext): void {
		const arg = context.argumentText.trim().toLowerCase();
		if (!arg) {
			const newState = !this.zenMode;
			this.setZenMode(newState);
			context.showInfo(
				newState
					? "Zen mode enabled. Distractions removed."
					: "Zen mode disabled.",
			);
			return;
		}
		if (arg === "on") {
			if (this.zenMode) {
				context.showInfo("Zen mode is already on.");
				return;
			}
			this.setZenMode(true);
			context.showInfo("Zen mode enabled. Distractions removed.");
			return;
		}
		if (arg === "off") {
			if (!this.zenMode) {
				context.showInfo("Zen mode is already off.");
				return;
			}
			this.setZenMode(false);
			context.showInfo("Zen mode disabled.");
			return;
		}
		context.showError("Usage: /zen [on|off]");
	}

	private handleCleanCommand(context: CommandExecutionContext): void {
		const arg = context.argumentText.trim().toLowerCase();
		if (!arg) {
			context.showInfo(
				`Clean mode is ${this.cleanMode} (streaming only). Use /clean off|soft|aggressive.`,
			);
			return;
		}

		const parsed = this.parseCleanMode(arg);
		if (!parsed) {
			context.showError("Usage: /clean [off|soft|aggressive]");
			return;
		}

		this.cleanMode = parsed;
		this.persistUiState({ cleanMode: parsed });
		context.showInfo(
			`Clean mode set to ${parsed}. Dedupe applies only while text streams; transcripts stay raw.`,
		);
	}

	private handleContextCommand(_context: CommandExecutionContext): void {
		const contextView = new ContextView({
			state: this.agent.state,
			onClose: () => this.modalManager.pop(),
		});
		this.modalManager.push(contextView);
	}

	private handleFooterCommand(context: CommandExecutionContext): void {
		if (this.zenMode) {
			context.showInfo(
				'Footer mode is controlled by Zen mode. Turn Zen off with "/zen off" to change the footer style.',
			);
			return;
		}

		const tokens = context.argumentText
			.trim()
			.toLowerCase()
			.split(/\s+/)
			.filter((token) => token.length > 0);

		if (tokens.length === 0 || tokens[0] === "help") {
			context.showInfo(
				`Footer mode is ${this.describeFooterMode(this.footerMode)}. Use "/footer ensemble" for the full Composer Ensemble or "/footer solo" for the minimal Solo style.`,
			);
			return;
		}

		if (tokens[0] === "history") {
			const history = this.footer
				.getToastHistory(5)
				.map((t) => `${t.tone}: ${t.message}`)
				.join("\n");
			context.showInfo(history || "No recent footer alerts (toasts).");
			return;
		}

		if (tokens[0] === "clear") {
			this.footer.clearAlerts();
			context.showInfo("Footer alerts cleared.");
			this.ui.requestRender();
			return;
		}

		let candidate = tokens[0];
		if (candidate === "mode" || candidate === "set" || candidate === "style") {
			candidate = tokens[1] ?? "";
		}
		const parsed = this.parseFooterMode(candidate);
		if (!parsed) {
			context.showError(
				"Footer mode must be either 'ensemble' (rich) or 'solo' (minimal).",
			);
			return;
		}
		if (parsed === this.footerMode) {
			context.showInfo(
				`Footer already using ${this.describeFooterMode(parsed)} mode.`,
			);
			return;
		}
		this.setFooterMode(parsed);
		context.showInfo(
			`Footer switched to ${this.describeFooterMode(parsed)} mode.`,
		);
	}

	private setFooterMode(mode: FooterMode): void {
		if (this.zenMode) {
			// Zen mode owns the footer; ignore external mode changes
			return;
		}
		this.footerMode = mode;
		this.footer.setMode(mode);
		this.persistUiState({ footerMode: mode });
		if (!this.isAgentRunning) {
			this.refreshFooterHint();
		}
		this.ui.requestRender();
	}

	private parseFooterMode(value: string): FooterMode | null {
		switch (value) {
			case "ensemble":
			case "rich":
			case "classic":
			case "full":
				return "ensemble";
			case "solo":
			case "minimal":
			case "lean":
			case "lite":
				return "solo";
			default:
				return null;
		}
	}

	private describeFooterMode(mode: FooterMode): string {
		return mode === "ensemble" ? "Ensemble (rich)" : "Solo (minimal)";
	}

	private handleCompactToolsCommand(rawInput: string): void {
		this.toolOutputView.handleCompactToolsCommand(rawInput);
		this.persistUiState();
	}

	private clearInProgress = false;

	private async handleClearCommand(): Promise<void> {
		// Prevent concurrent clear operations
		if (this.clearInProgress) {
			return;
		}
		this.clearInProgress = true;

		try {
			// Abort any in-flight agent work
			this.agent.abort();
			await this.agent.waitForIdle();

			// Reset running flag immediately so the UI reflects idle state while agent_end propagates
			this.isAgentRunning = false;

			// Cancel any queued prompts
			this.promptQueue?.cancelAll?.({ silent: true });
			this.nextQueuedPreview = null;
			this.updateQueuedPromptCount();

			// Stop loading animation if present
			this.loaderView.stop();
			this.statusContainer.clear();

			// Reset agent and session
			this.agent.reset();
			this.sessionManager.reset();

			// Reset session artifacts and tool tracking
			this.sessionContext.resetArtifacts();
			this.toolOutputView.clearTrackedComponents();

			// Clear all UI containers
			this.chatContainer.clear();
			this.startupContainer.clear();

			// Reset plan state
			this.planView.syncHintWithStore();
			this.planHint = null;

			// Clear editor input
			this.editor.setText("");

			// Clear pending tools
			this.pendingTools.clear();

			// Clear interrupt state if armed
			if (this.interruptArmed) {
				if (this.interruptTimeout) {
					clearTimeout(this.interruptTimeout);
				}
				this.interruptArmed = false;
				this.interruptTimeout = null;
			}

			// Reset message view state and render initial messages
			this.renderInitialMessages(this.agent.state);

			// Update footer and refresh hints
			this.footer.updateState(this.agent.state);
			this.refreshFooterHint();

			// Show success confirmation
			this.notificationView.showToast(
				"Context cleared - started fresh session",
				"success",
			);
		} catch (error) {
			// On error, ensure UI is in a consistent state
			this.loaderView.stop();
			this.statusContainer.clear();

			const errorMsg = error instanceof Error ? error.message : String(error);
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(`✗ Error clearing context: ${errorMsg}`, 1, 1),
			);
		} finally {
			this.clearInProgress = false;
			this.ui.requestRender();
		}
	}

	private handleReportCommand(context: CommandExecutionContext): void {
		const parsedType = context.parsedArgs?.type;
		const inlineArg = context.argumentText.trim().split(/\s+/)[0] ?? "";
		const candidate =
			typeof parsedType === "string" && parsedType.length > 0
				? parsedType.toLowerCase()
				: inlineArg.toLowerCase();

		if (candidate === "bug") {
			this.feedbackView.handleBugCommand();
			return;
		}
		if (candidate === "feedback") {
			this.feedbackView.handleFeedbackCommand();
			return;
		}
		if (candidate.length > 0) {
			context.showError('Report type must be "bug" or "feedback".');
			context.renderHelp();
			return;
		}
		this.reportSelectorView.show();
	}

	private async handleReviewCommand(
		_context: CommandExecutionContext,
	): Promise<void> {
		if (this.isAgentRunning) {
			this.notificationView.showInfo(
				"Wait for the current run to finish before starting /review.",
			);
			return;
		}
		const reviewContext = this.gitView.getReviewContext();
		if (!reviewContext.ok) {
			this.notificationView.showError(
				reviewContext.error ?? "Failed to collect git data for review.",
			);
			return;
		}
		const hasDiff =
			reviewContext.stagedDiff.trim().length > 0 ||
			reviewContext.worktreeDiff.trim().length > 0;
		if (!hasDiff) {
			this.notificationView.showInfo("Working tree clean. Nothing to review.");
			return;
		}

		const prompt = buildReviewPrompt(reviewContext);
		try {
			await this.agent.prompt(prompt);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error ?? "unknown");
			this.notificationView.showError(
				`/review failed to run: ${message.slice(0, 200)}`,
			);
		}
	}

	private async handleStatsCommand(
		_context: CommandExecutionContext,
	): Promise<void> {
		this.diagnosticsView.handleStatusCommand();
		const costContext = this.createSyntheticContext("cost", "today");
		this.costView.handleCostCommand(costContext);
	}

	private clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	private toggleToolOutputs(): void {
		const compact = this.toolOutputView.toggleCompactMode();
		this.notificationView.showToast(
			compact ? "Tool outputs collapsed." : "Tool outputs expanded.",
			"info",
		);
		this.refreshFooterHint();
		this.persistUiState();
	}

	private handlePromptQueueEvent(event: PromptQueueEvent): void {
		if (!this.promptQueue) {
			return;
		}
		if (event.type === "error") {
			const message = this.describeError(event.error);
			this.showError(`Prompt #${event.entry.id} failed: ${message}`);
		}
		if (event.type === "enqueue" && !event.willRunImmediately) {
			this.notificationView.showInfo(
				`Queued prompt #${event.entry.id} (${event.pendingCount} pending)`,
			);
		}
		if (event.type === "cancel") {
			this.notificationView.showInfo(
				`Removed queued prompt #${event.entry.id}`,
			);
		}
		this.updateQueuedPromptCount();
		this.refreshQueuePanel();
		if (!this.isAgentRunning) {
			this.refreshFooterHint();
		}
		this.ui.requestRender();
	}

	private handleApprovalRequired(request: ActionApprovalRequest): void {
		this.approvalController?.enqueue(request);
		const component = this.pendingTools.get(request.id);
		component?.setPendingStatus(request.reason ?? "Awaiting approval");
		this.ui.requestRender();
	}

	private handleApprovalResolved(
		request: ActionApprovalRequest,
		decision: ActionApprovalDecision,
	): void {
		this.approvalController?.resolve(request, decision);
		const component = this.pendingTools.get(request.id);
		component?.setPendingStatus(null);
		this.ui.requestRender();
	}

	private updateQueuedPromptCount(): void {
		if (!this.promptQueue) {
			this.queuedPromptCount = 0;
			this.nextQueuedPreview = null;
			return;
		}
		const snapshot = this.promptQueue.getSnapshot();
		this.queuedPromptCount = snapshot.pending.length;
		const next = snapshot.pending[0];
		this.nextQueuedPreview = next ? this.formatQueuedText(next.text, 60) : null;
	}

	private handleQueueCommand(context: CommandExecutionContext): void {
		if (!this.promptQueue) {
			context.showInfo("Prompt queue is not available.");
			return;
		}
		const args = context.argumentText.trim();
		if (!args || args === "list") {
			// Show modal instead of rendering to chat
			this.showQueuePanel();
			return;
		}
		const [action, idText] = args.split(/\s+/, 2);
		if (action === "mode") {
			const mode = (idText ?? "").toLowerCase();
			if (!mode) {
				// No mode specified - show interactive selector
				this.queueModeSelectorView.show(this.promptQueueMode);
				return;
			}
			if (mode !== "one" && mode !== "all") {
				context.showError('Mode must be "one" or "all".');
				return;
			}
			// setQueueMode already calls showToast, persistUiState, and refreshFooterHint
			this.setQueueMode(mode);
			return;
		}
		if (action === "cancel") {
			const id = Number.parseInt(idText ?? "", 10);
			if (!Number.isFinite(id)) {
				context.showError("Provide a numeric prompt id to cancel.");
				return;
			}
			const removed = this.promptQueue.cancel(id);
			if (!removed) {
				context.showError(`No queued prompt #${id} to cancel.`);
				return;
			}
			this.notificationView.showToast(
				`Cancelled queued prompt #${id}`,
				"success",
			);
			this.updateQueuedPromptCount();
			if (!this.isAgentRunning) {
				this.refreshFooterHint();
			}
			return;
		}
		context.renderHelp();
	}

	private handleBackgroundCommand(context: CommandExecutionContext): void {
		handleBackgroundCommand(
			this.backgroundSettings,
			this._createBackgroundRenderContext(context),
		);
	}

	private _createBackgroundRenderContext(
		context: CommandExecutionContext,
	): BackgroundRenderContext {
		return {
			argumentText: context.argumentText,
			addContent: (content: string) => {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(content, 1, 0));
			},
			showInfo: (message: string) => {
				this.notificationView.showInfo(message);
			},
			showError: (message: string) => {
				this.notificationView.showError(message);
			},
			renderHelp: () => {
				context.renderHelp();
			},
			requestRender: () => {
				this.ui.requestRender();
			},
		};
	}

	private showQueuePanel(): void {
		if (!this.promptQueue || !this.queuePanelModal) {
			return;
		}
		const snapshot = this.promptQueue.getSnapshot();
		this.queuePanelModal.setData(
			snapshot.active ?? null,
			snapshot.pending,
			this.promptQueueMode,
		);
		this.modalManager.push(this.queuePanelModal);
	}

	private refreshQueuePanel(): void {
		if (!this.promptQueue || !this.queuePanelModal) {
			return;
		}
		const snapshot = this.promptQueue.getSnapshot();
		this.queuePanelModal.setData(
			snapshot.active ?? null,
			snapshot.pending,
			this.promptQueueMode,
		);
		if (this.modalManager.getActiveModal() === this.queuePanelModal) {
			this.ui.requestRender();
		}
	}

	private handlePlanCommand(context: CommandExecutionContext): void {
		const args = context.argumentText.trim();
		if (!args || args === "list") {
			// Show modal instead of rendering to chat
			this.showPlanPanel();
			return;
		}
		// Delegate to plan view for other commands (new, add, complete, etc.)
		this.planView.handlePlanCommand(context.rawInput);
	}

	private showPlanPanel(): void {
		if (!this.planPanelModal) {
			return;
		}
		const store = loadTodoStore(TODO_STORE_PATH);
		this.planPanelModal.setData(store);
		this.modalManager.push(this.planPanelModal);
	}

	private handlePlanStoreChanged(store: TodoStore): void {
		if (!this.planPanelModal) {
			return;
		}
		this.planPanelModal.setData(store);
		if (this.modalManager.getActiveModal() === this.planPanelModal) {
			this.ui.requestRender();
		}
	}

	private handlePlanPanelToggleComplete(): void {
		if (!this.planPanelModal) {
			return;
		}
		const selectedGoal = this.planPanelModal.getSelectedGoal();
		const selectedTask = this.planPanelModal.getSelectedTask();
		if (!selectedGoal || !selectedTask) {
			this.notificationView.showInfo("Select a task to toggle.");
			return;
		}
		this.planView.toggleTaskCompletion(selectedGoal.key, selectedTask.id);
	}

	private handlePlanPanelMoveTask(direction: "up" | "down"): void {
		if (!this.planPanelModal) {
			return;
		}
		const selectedGoal = this.planPanelModal.getSelectedGoal();
		const selectedTask = this.planPanelModal.getSelectedTask();
		if (!selectedGoal || !selectedTask) {
			return;
		}
		// Move the task in the store
		this.planView.moveTask(selectedGoal.key, selectedTask.id, direction);

		// Adjust selection to follow the moved task
		const delta = direction === "up" ? -1 : 1;
		this.planPanelModal.navigateTasks(delta);
	}

	private setQueueMode(mode: "one" | "all"): void {
		this.promptQueueMode = mode;
		this.queueEnabled = mode === "all";
		if (this.isAgentRunning) {
			this.editor.disableSubmit = !this.queueEnabled;
		}
		this.persistUiState();
		this.notificationView.showToast(
			mode === "all"
				? "Queue mode set to all: prompts will enqueue while the model is running."
				: "Queue mode set to one: submissions pause until the current run finishes.",
			"success",
		);
		this.refreshFooterHint();
	}

	private persistUiState(extra?: Partial<UiState>): void {
		saveUiState({
			queueMode: this.promptQueueMode,
			compactTools: this.toolOutputView.isCompact(),
			footerMode: this.footerMode,
			cleanMode: this.cleanMode,
			...extra,
		});
	}

	private parseCleanMode(value: string): CleanMode | null {
		const normalized = value.toLowerCase();
		if (
			normalized === "off" ||
			normalized === "disable" ||
			normalized === "0"
		) {
			return "off";
		}
		if (
			normalized === "on" ||
			normalized === "true" ||
			normalized === "soft" ||
			normalized === "1"
		) {
			return "soft";
		}
		if (normalized === "aggressive") {
			return "aggressive";
		}
		return null;
	}

	private readCleanModeFromEnv(): CleanMode | null {
		const raw = process.env.COMPOSER_TUI_CLEAN;
		if (!raw) return null;
		return this.parseCleanMode(raw);
	}

	private handleBranchCommand(context: CommandExecutionContext): void {
		if (this.isAgentRunning) {
			context.showError(
				"Wait for the current run to finish before branching the session.",
			);
			return;
		}
		const messages = this.agent.state.messages ?? [];
		const userMessages = messages
			.map((msg, index) => ({ msg, index }))
			.filter(({ msg }) => (msg as any)?.role === "user");
		if (userMessages.length === 0) {
			context.showInfo("No user messages available to branch from yet.");
			return;
		}

		const arg = context.argumentText.trim();
		if (!arg) {
			// No argument - show interactive selector
			this.userMessageSelectorView.show();
			return;
		}
		if (arg === "list") {
			this.renderBranchList(userMessages);
			return;
		}

		const targetIndex = Number.parseInt(arg, 10);
		if (!Number.isFinite(targetIndex) || targetIndex < 1) {
			context.showError("Provide a valid user message number to branch from.");
			return;
		}
		if (targetIndex > userMessages.length) {
			context.showError(
				`Only ${userMessages.length} user message${userMessages.length === 1 ? "" : "s"} available.`,
			);
			return;
		}

		const selection = userMessages[targetIndex - 1];
		const slice = messages.slice(0, selection.index);
		const editorSeed = this.extractUserText(selection.msg as AppMessage);
		this.resetConversation(
			slice,
			editorSeed,
			`Branched to new session before user message #${targetIndex}.`,
		);
	}

	private renderBranchList(
		userMessages: Array<{ msg: AppMessage; index: number }>,
	): void {
		const lines: string[] = ["User messages (use /branch <number>):"];
		userMessages.forEach(({ msg }, userIndex) => {
			const created = this.getMessageTimestamp(msg);
			const preview = this.extractUserTextPreview(msg as AppMessage);
			const meta = created ? ` • ${created}` : "";
			lines.push(`${userIndex + 1}. ${preview}${meta}`);
		});
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.ui.requestRender();
	}

	private getMessageTimestamp(message: AppMessage): string | null {
		const ts = (message as any)?.timestamp;
		if (!ts || typeof ts !== "number") return null;
		try {
			return new Date(ts).toLocaleString();
		} catch {
			return null;
		}
	}

	private extractUserText(message: AppMessage): string {
		const content = (message as any).content;
		if (typeof content === "string") {
			return content;
		}
		if (Array.isArray(content)) {
			const textBlock = content.find(
				(block) => block && (block as any).type === "text",
			) as { text?: string } | undefined;
			return textBlock?.text ?? "";
		}
		return "";
	}

	private extractUserTextPreview(message: AppMessage): string {
		const text = this.extractUserText(message).replace(/\s+/g, " ").trim();
		if (!text) return "(empty)";
		return text.length > 80 ? `${text.slice(0, 77)}…` : text;
	}

	private handleApprovalsCommand(context: CommandExecutionContext): void {
		const arg = context.argumentText.trim().toLowerCase();
		if (arg) {
			if (!["auto", "prompt", "fail"].includes(arg)) {
				context.showError('Mode must be one of "auto", "prompt", or "fail".');
				context.renderHelp();
				return;
			}
			this.approvalService.setMode(arg as ApprovalMode);
			this.notificationView.showToast(
				`Switched approval mode to ${arg}.`,
				"success",
			);
			this.refreshFooterHint();
		}
		const pending = this.approvalService.getPendingRequests();
		const pendingSummary = pending.length
			? `Pending approvals (${pending.length}):${pending
					.slice(0, 5)
					.map((req) => `\n• ${req.toolName} – ${req.reason ?? "awaiting"}`)
					.join("")}`
			: "No pending approval requests.";
		const summaryLines = [
			`Approval mode: ${this.approvalService.getMode()}`,
			pendingSummary,
		];
		if (pending.length > 5) {
			summaryLines.push(
				`Showing first 5 of ${pending.length}. Use the approvals panel to review all.`,
			);
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(summaryLines.join("\n"), 1, 0));
		this.ui.requestRender();
	}

	private handlePlanModeCommand(context: CommandExecutionContext): void {
		const arg = context.argumentText.trim().toLowerCase();
		if (arg) {
			if (!["on", "off"].includes(arg)) {
				context.showError('Plan mode must be "on" or "off".');
				return;
			}
			process.env.COMPOSER_PLAN_MODE = arg === "on" ? "1" : "0";
			this.notificationView.showToast(
				`Plan mode ${arg === "on" ? "enabled" : "disabled"}.`,
				"success",
			);
			this.refreshFooterHint();
		}
		const status =
			process.env.COMPOSER_PLAN_MODE === "1" ? "enabled" : "disabled";
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(`Plan mode is ${status}.`, 1, 0));
		this.ui.requestRender();
	}

	private handleFrameworkCommand(context: CommandExecutionContext): void {
		const parts = context.argumentText
			.split(/\s+/)
			.map((p) => p.trim())
			.filter(Boolean);

		const flags = new Set(parts.filter((p) => p.startsWith("-")));
		const value = parts.find((p) => !p.startsWith("-"));
		const targetWorkspace = flags.has("--workspace") || flags.has("-w");
		const targetLabel = targetWorkspace ? "workspace" : "user";

		if (!value) {
			const pref = resolveFrameworkPreference();
			const current = pref.id ?? "none";
			const scopeHint = targetWorkspace ? "(workspace) " : "";
			this.notificationView.showInfo(
				`${scopeHint}Default framework: ${current} (source: ${pref.source})`,
			);
			return;
		}

		const normalized = value.toLowerCase();
		if (normalized === "list") {
			const items = listFrameworks()
				.map((f) => `${f.id} — ${f.summary}`)
				.join("\n");
			this.notificationView.showInfo(`Available frameworks:\n${items}`);
			return;
		}

		const setter = targetWorkspace
			? setWorkspaceFramework
			: setDefaultFramework;

		if (normalized === "none" || normalized === "off") {
			try {
				setter(null);
				this.notificationView.showToast(
					`Default framework cleared for ${targetLabel} scope`,
					"success",
				);
			} catch (error) {
				this.notificationView.showError(
					error instanceof Error ? error.message : String(error),
				);
			}
			return;
		}

		const info = getFrameworkSummary(normalized);
		try {
			setter(normalized);
			const summary =
				info?.summary ?? `Preferred framework set to ${normalized}.`;
			this.notificationView.showToast(
				`${summary} (scope: ${targetLabel})`,
				"success",
			);
		} catch (error) {
			this.notificationView.showError(
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	private handleCommandsCommand(context: CommandExecutionContext): void {
		const arg = context.argumentText.trim();
		const [action, ...rest] = arg.split(/\s+/).filter(Boolean);
		const catalog = loadCommandCatalog(process.cwd());
		if (!action || action === "list") {
			if (catalog.length === 0) {
				context.showInfo(
					"No commands found in ~/.composer/commands or .composer/commands.",
				);
				return;
			}
			const lines = catalog.map(
				(cmd) =>
					`• ${cmd.name} – ${cmd.description ?? "(no description)"} (${cmd.source})`,
			);
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
			this.ui.requestRender();
			return;
		}
		if (action !== "run") {
			context.showError(
				"Usage: /commands list | /commands run <name> arg=value ...",
			);
			return;
		}
		const name = rest.shift();
		if (!name) {
			context.showError("Specify a command name to run.");
			return;
		}
		const cmd = catalog.find((c) => c.name === name);
		if (!cmd) {
			context.showError(`Command ${name} not found.`);
			return;
		}
		const args = parseCommandArgs(rest);
		const validation = validateCommandArgs(cmd, args);
		if (validation) {
			context.showError(validation);
			return;
		}
		const prompt = renderCommandPrompt(cmd, args);
		this.editor.setText(prompt);
		this.notificationView.showToast(
			`Inserted command "${cmd.name}" into the composer. Edit then submit.`,
			"info",
		);
		this.ui.requestRender();
	}

	private handleNewChatCommand(context: CommandExecutionContext): void {
		if (this.isAgentRunning) {
			context.showError(
				"Wait for the current run to finish before starting a new chat.",
			);
			return;
		}
		this.resetConversation([], undefined, "Started a new chat session.");
	}

	private resetConversation(
		messages: AppMessage[],
		editorSeed?: string,
		toastMessage?: string,
	): void {
		this.sessionManager.startFreshSession();
		this.agent.clearMessages();
		this.sessionContext.resetArtifacts();
		this.toolOutputView.clearTrackedComponents();
		this.chatContainer.clear();
		this.startupContainer.clear();
		this.planView.syncHintWithStore();
		this.planHint = null;
		for (const message of messages) {
			this.agent.appendMessage(message);
		}
		this.footer.updateState(this.agent.state);
		this.refreshFooterHint();
		this.renderInitialMessages(this.agent.state);
		if (editorSeed !== undefined) {
			this.editor.setText(editorSeed);
		} else {
			this.clearEditor();
		}
		if (toastMessage) {
			this.notificationView.showToast(toastMessage, "success");
		}
	}

	private handleInitCommand(context: CommandExecutionContext): void {
		try {
			const targetArg = context.argumentText.trim() || undefined;
			const createdPath = handleAgentsInit(targetArg, { force: false });
			const relativePath = relative(process.cwd(), createdPath);
			const displayPath =
				relativePath && !relativePath.startsWith("..") && relativePath !== ""
					? `./${relativePath}`
					: createdPath;
			this.notificationView.showToast(
				`Scaffolded ${displayPath}. Update it before your next run.`,
				"success",
			);
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(
					`Created AGENTS instructions at ${displayPath}. Customize it with project-specific guidance to improve future sessions.`,
					1,
					0,
				),
			);
			this.ui.requestRender();
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Failed to scaffold AGENTS file.";
			context.showError(message);
		}
	}

	private handleMcpCommand(context: CommandExecutionContext): void {
		handleMcpCommand(this._createMcpRenderContext(context));
	}

	private _createMcpRenderContext(
		context: CommandExecutionContext,
	): McpRenderContext {
		return {
			rawInput: context.rawInput,
			addContent: (content: string) => {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(content, 1, 0));
			},
			showError: (message: string) => {
				this.notificationView.showError(message);
			},
			requestRender: () => {
				this.ui.requestRender();
			},
		};
	}

	private handleComposerCommand(context: CommandExecutionContext): void {
		handleComposerCommand(this._createComposerRenderContext(context));
	}

	private _createComposerRenderContext(
		context: CommandExecutionContext,
	): ComposerRenderContext {
		return {
			rawInput: context.rawInput,
			cwd: process.cwd(),
			addContent: (content: string) => {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(content, 1, 0));
			},
			requestRender: () => {
				this.ui.requestRender();
			},
		};
	}

	private renderQueueList(): void {
		if (!this.promptQueue) {
			return;
		}
		const snapshot = this.promptQueue.getSnapshot();
		const lines: string[] = [];
		const modeLabel =
			this.promptQueueMode === "all"
				? "all (submissions enqueue while running)"
				: "one-at-a-time (submissions paused while running)";
		lines.push(`Mode: ${modeLabel}`);
		if (snapshot.active) {
			lines.push(
				`Active: #${snapshot.active.id} – ${this.formatQueuedText(snapshot.active.text)}`,
			);
		}
		if (snapshot.pending.length === 0) {
			lines.push("No queued prompts.");
		} else {
			lines.push("Pending prompts:");
			snapshot.pending.forEach((entry, index) => {
				lines.push(
					`${index + 1}. #${entry.id} – ${this.formatQueuedText(entry.text)}`,
				);
			});
			lines.push(
				"Use /queue cancel <id> to remove a prompt. Use /queue mode <one|all> to change behavior.",
			);
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.ui.requestRender();
	}

	private formatQueuedText(message: string, maxLength = 80): string {
		const singleLine = message.replace(/\s+/g, " ").trim();
		if (singleLine.length <= maxLength) {
			return singleLine || "(empty message)";
		}
		return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
	}

	private createCommandContext({
		command,
		rawInput,
		argumentText,
		parsedArgs,
	}: {
		command: SlashCommand;
		rawInput: string;
		argumentText: string;
		parsedArgs?: Record<string, unknown>;
	}): CommandExecutionContext {
		return {
			command,
			rawInput,
			argumentText,
			parsedArgs,
			showInfo: (message: string) => this.notificationView.showInfo(message),
			showError: (message: string) => this.notificationView.showError(message),
			renderHelp: () => this.renderCommandHelp(command),
		};
	}

	private createSyntheticContext(
		commandName: string,
		argumentText: string,
	): CommandExecutionContext {
		const command = this.getSlashCommandByName(commandName);
		return {
			command,
			rawInput: `/${commandName}${argumentText ? ` ${argumentText}` : ""}`,
			argumentText,
			showInfo: (message: string) => this.notificationView.showInfo(message),
			showError: (message: string) => this.notificationView.showError(message),
			renderHelp: () => this.renderCommandHelp(command),
		};
	}

	private getSlashCommandByName(name: string): SlashCommand {
		return (
			this.slashCommands.find(
				(command) => command.name.toLowerCase() === name.toLowerCase(),
			) ?? { name }
		);
	}

	private describeTelemetryStatus(): string {
		const status = this.telemetryStatus;
		const base = status.enabled ? "enabled" : "disabled";
		const details: string[] = [];
		if (status.runtimeOverride) {
			details.push(`override=${status.runtimeOverride}`);
		} else if (status.reason) {
			details.push(status.reason);
		}
		if (status.sampleRate !== 1) {
			details.push(`sample=${status.sampleRate}`);
		}
		return details.length > 0 ? `${base} (${details.join(", ")})` : base;
	}

	private renderCommandHelp(command: SlashCommand): void {
		const help = formatCommandHelp(command);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(help, 1, 0));
		this.ui.requestRender();
	}

	private dismissWelcomeAnimation(): void {
		if (!this.welcomeAnimation) {
			return;
		}
		this.welcomeAnimation.stop();
		this.chatContainer.clear();
		this.welcomeAnimation = null;
	}

	showError(errorMessage: string): void {
		this.notificationView.showError(errorMessage);
		this.provideFailureHints(errorMessage);
	}

	public refreshFooterHint(): void {
		const sandboxMode =
			this.agent.state.sandboxMode ?? process.env.COMPOSER_SANDBOX ?? null;
		const sandboxRequested = Boolean(sandboxMode);
		const sandboxActive =
			Boolean(this.agent.state.sandboxEnabled) ||
			Boolean(this.agent.state.sandbox);
		this.footer.setRuntimeBadges(
			buildRuntimeBadges({
				approvalMode: this.approvalService.getMode(),
				promptQueueMode: this.promptQueueMode,
				queuedPromptCount: this.queuedPromptCount,
				hasPromptQueue: Boolean(this.promptQueue),
				thinkingLevel: this.agent.state.thinkingLevel,
				sandboxMode,
				isSafeMode: process.env.COMPOSER_SAFE_MODE === "1",
				sandboxRequestedButMissing: sandboxRequested && !sandboxActive,
				alertCount: this.footer.getUnseenAlertCount(),
			}),
		);
		if (this.isAgentRunning) {
			return;
		}
		const hints: string[] = [
			this.idleFooterHint,
			...this.buildOperationalHints(),
		];
		const activeToast = this.footer.getActiveToast();
		if (
			activeToast &&
			(activeToast.tone === "danger" || activeToast.tone === "warn")
		) {
			hints.push(`Alert: ${activeToast.message}`);
		}
		if (this.startupWarnings.length > 0) {
			hints.push(...this.startupWarnings.map((w) => w.message));
		}
		if (this.planHint) {
			hints.push(`Plan ${this.planHint}`);
		}
		const queueHint = this.buildQueueHint();
		if (queueHint) {
			hints.push(queueHint);
		}
		this.footer.setHint(hints.filter(Boolean).join(" • "));
	}

	private buildOperationalHints(): string[] {
		const hints: string[] = [];
		const backgroundCounts = this.getBackgroundTaskCounts();
		if (backgroundCounts.running > 0 || backgroundCounts.failed > 0) {
			const runningLabel = `${backgroundCounts.running} background ${backgroundCounts.running === 1 ? "task" : "tasks"} running`;
			const failureSuffix =
				backgroundCounts.failed > 0
					? `; ${backgroundCounts.failed} failed`
					: "";
			hints.push(`${runningLabel}${failureSuffix} (use /background list)`);
		}
		if (this.compactionInProgress) {
			hints.push("Compacting history…");
		}
		if (this.pendingPasteSummaries.size > 0) {
			hints.push("Summarizing pasted text…");
		}
		if (this.bashModeView?.isActive()) {
			hints.push("Bash mode active — type exit to leave");
		}
		return hints;
	}

	private handleEditorTyping(): void {
		this.footer.clearToast();
		this.ui.requestRender();
	}

	private surfaceStartupWarnings(): void {
		const warning = validateFrameworkPreference();
		if (!warning) return;
		this.startupWarnings.push({
			type: "custom",
			message: warning,
			priority: 140,
		});
		this.footer.setToast(warning, "warn");
	}

	private buildQueueHint(): string | null {
		if (this.isAgentRunning) {
			return null;
		}
		if (this.nextQueuedPreview) {
			return `Next queued: ${this.nextQueuedPreview}`;
		}
		if (this.queuedPromptCount > 0) {
			return `${this.queuedPromptCount} queued ${this.queuedPromptCount === 1 ? "prompt" : "prompts"}`;
		}
		return null;
	}

	private getBackgroundTaskCounts(): { running: number; failed: number } {
		const tasks = backgroundTaskManager.getTasks();
		let running = 0;
		let failed = 0;
		for (const task of tasks) {
			if (task.status === "running" || task.status === "restarting") {
				running++;
			}
			if (task.status === "failed") {
				failed++;
			}
		}
		return { running, failed };
	}

	private cycleThinkingLevel(): void {
		const model = this.agent.state.model as RegisteredModel | undefined;
		if (!model?.reasoning) {
			this.notificationView.showInfo(
				"Current model does not support thinking levels.",
			);
			return;
		}
		const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
		const current = this.agent.state.thinkingLevel || "off";
		const index = levels.indexOf(current);
		const nextLevel = levels[(index + 1) % levels.length];
		this.agent.setThinkingLevel(nextLevel);
		this.sessionManager.saveThinkingLevelChange(nextLevel);
		this.notificationView.showInfo(`Thinking level: ${nextLevel}`);
		this.refreshFooterHint();
	}

	private async cycleModel(): Promise<void> {
		if (this.isCyclingModel) {
			return;
		}
		this.isCyclingModel = true;
		try {
			const candidates =
				this.modelScope.length > 0
					? this.modelScope
					: (getRegisteredModels() as RegisteredModel[]);
			if (candidates.length === 0) {
				this.notificationView.showInfo("No models available to cycle.");
				return;
			}
			if (candidates.length === 1) {
				this.notificationView.showInfo(
					"Only one model in scope. Add more via --models to enable cycling.",
				);
				return;
			}
			const current = this.agent.state.model;
			let index = candidates.findIndex(
				(model) =>
					model.id === current.id && model.provider === current.provider,
			);
			if (index === -1) {
				index = -1;
			}
			const nextModel = candidates[(index + 1) % candidates.length];
			this.agent.setModel(nextModel);
			this.sessionManager.saveModelChange(
				`${nextModel.provider}/${nextModel.id}`,
				toSessionModelMetadata(nextModel),
			);
			const label = nextModel.name ?? nextModel.id;
			this.notificationView.showToast(`Model: ${label}`, "success");
			this.refreshFooterHint();
		} catch (error) {
			this.notificationView.showError(
				`Failed to cycle model: ${this.describeError(error)}`,
			);
		} finally {
			this.isCyclingModel = false;
		}
	}

	public extractTextFromAppMessage(message: AppMessage): string {
		const rawContent = (message as { content?: unknown }).content;
		if (typeof rawContent === "string") {
			return rawContent;
		}
		if (!Array.isArray(rawContent)) {
			return "";
		}
		const textParts: string[] = [];
		for (const chunk of rawContent as Array<Record<string, unknown>>) {
			const typedChunk = chunk as {
				type?: unknown;
				text?: unknown;
				thinking?: unknown;
			};
			const type =
				typeof typedChunk.type === "string" ? typedChunk.type : undefined;
			if (type === "text" && typeof typedChunk.text === "string") {
				textParts.push(typedChunk.text);
			} else if (
				type === "thinking" &&
				typeof typedChunk.thinking === "string"
			) {
				textParts.push(typedChunk.thinking);
			}
		}
		return textParts.join("\n");
	}

	private maybeShowContextWarning(stats: FooterStats): void {
		if (!stats.contextWindow) {
			this.contextWarningLevel = "none";
			return;
		}
		const percent = stats.contextPercent;
		let nextLevel: "none" | "warn" | "danger" = "none";
		if (percent >= 90) {
			nextLevel = "danger";
		} else if (percent >= 70) {
			nextLevel = "warn";
		}
		if (nextLevel === this.contextWarningLevel) {
			return;
		}
		if (nextLevel === "none") {
			this.contextWarningLevel = "none";
			return;
		}
		const label = `${formatTokenCount(stats.contextTokens)}/${formatTokenCount(
			stats.contextWindow,
		)}`;
		if (nextLevel === "warn") {
			this.notificationView.showToast(
				`Context ${percent.toFixed(1)}% used (${label}). Consider /compact before your next prompt.`,
				"info",
			);
		} else {
			this.notificationView.showToast(
				`Context ${percent.toFixed(1)}% used (${label}). Composer will auto-compact soon.`,
				"warn",
			);
		}
		this.contextWarningLevel = nextLevel;
	}

	private recordCompactionDelta(
		before: FooterStats,
		trigger: "auto" | "manual",
	): void {
		const after = calculateFooterStats(this.agent.state);
		if (after.contextTokens === before.contextTokens) {
			return;
		}
		this.sessionContext.recordCompactionArtifact({
			beforeTokens: before.contextTokens,
			afterTokens: after.contextTokens,
			trigger,
		});
		const beforeLabel = formatTokenCount(before.contextTokens);
		const afterLabel = formatTokenCount(after.contextTokens);
		const prefix = trigger === "auto" ? "Auto-" : "";
		this.notificationView.showInfo(
			`${prefix}compact reduced context ${beforeLabel} → ${afterLabel}.`,
		);
	}

	private describeError(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}
		return String(error ?? "Unknown error");
	}

	private provideFailureHints(message: string): void {
		const normalized = message.toLowerCase();
		const hints: string[] = [];
		if (/(api key|credential|unauthorized|forbidden|token)/.test(normalized)) {
			hints.push("Check credentials with /diag keys");
		}
		if (/(context|token|length|window)/.test(normalized)) {
			hints.push("Use /compact or /share to trim history");
		}
		if (/(tool|bash|edit|read)/.test(normalized)) {
			hints.push("Inspect failures via /tools failures");
		}
		if (!hints.length) {
			return;
		}
		this.notificationView.showInfo(`Hint: ${hints.join(" • ")}`);
	}

	private async handleLargePaste(event: LargePasteEvent): Promise<void> {
		if (!event.content.trim()) {
			return;
		}
		if (this.pendingPasteSummaries.has(event.pasteId)) {
			return;
		}
		this.pendingPasteSummaries.add(event.pasteId);
		this.refreshFooterHint();
		this.notificationView.showInfo(
			`Summarizing pasted block (~${event.lineCount} lines)…`,
		);
		try {
			const summaryMessage = await this.agent.generateSummary(
				[
					{
						role: "user",
						content: [
							{
								type: "text",
								text: this.buildPasteSummaryContext(event.content),
							},
						],
						timestamp: Date.now(),
					} as Message,
				],
				this.buildPasteSummaryPrompt(event.lineCount, event.charCount),
				"You turn large clipboard snippets into concise summaries highlighting key takeaways, files, and follow-ups.",
			);
			const summaryText = this.extractTextFromAppMessage(
				summaryMessage as AppMessage,
			).trim();
			if (!summaryText) {
				throw new Error("Empty summary");
			}
			const decorated = this.decoratePasteSummary(
				summaryText,
				event.lineCount,
				event.charCount,
			);
			const replaced = this.editor.replacePasteMarker(event.pasteId, decorated);
			if (replaced) {
				this.notificationView.showToast(
					`Summarized pasted block (~${event.lineCount} lines)`,
					"success",
				);
				this.sessionContext.recordPasteSummaryArtifact({
					placeholder: event.marker,
					lineCount: event.lineCount,
					charCount: event.charCount,
					summaryPreview: summaryText.split("\n")[0]?.slice(0, 120) ?? "",
				});
			} else {
				this.notificationView.showInfo(
					"Generated paste summary but it was no longer needed.",
				);
			}
		} catch (error) {
			logger.error(
				"Failed to summarize pasted content",
				error instanceof Error ? error : undefined,
			);
			this.notificationView.showError(
				"Couldn't summarize pasted content. The original text will be sent.",
			);
		} finally {
			this.pendingPasteSummaries.delete(event.pasteId);
			this.refreshFooterHint();
		}
	}

	private buildPasteSummaryPrompt(lines: number, chars: number): string {
		const formatter = new Intl.NumberFormat("en-US");
		return `Summarize the preceding clipboard snippet (~${formatter.format(
			lines,
		)} lines, ${formatter.format(chars)} chars). Provide concise bullet points highlighting what the snippet contains, key issues, and any follow-up actions. Limit to 120 words.`;
	}

	private buildPasteSummaryContext(content: string): string {
		const limit = 12000;
		if (content.length <= limit) {
			return content;
		}
		return `${content.slice(0, limit)}\n\n[truncated ${content.length - limit} additional chars]`;
	}

	private decoratePasteSummary(
		summary: string,
		lines: number,
		chars: number,
	): string {
		const formatter = new Intl.NumberFormat("en-US");
		const meta = `[[Pasted ${formatter.format(lines)} lines (~${formatter.format(
			chars,
		)} chars) summarized]]`;
		return `${meta}\n${summary.trim()}\n[[End paste summary]]`;
	}

	private applyLoadedSessionContext(): void {
		this.sessionContext.resetArtifacts();
		const thinking = this.sessionManager.loadThinkingLevel();
		if (thinking) {
			this.agent.setThinkingLevel(thinking as ThinkingLevel);
		}
		const modelKey = this.sessionManager.loadModel();
		if (modelKey) {
			const [provider, modelId] = modelKey.split("/");
			if (provider && modelId) {
				const nextModel = getRegisteredModels().find(
					(entry) => entry.provider === provider && entry.id === modelId,
				);
				if (nextModel) {
					this.agent.setModel(nextModel);
				}
			}
		}
	}

	private isMinimalMode(): boolean {
		return this.minimalMode;
	}

	private registerBackgroundTaskNotifications(): void {
		if (this.backgroundTaskNotificationCleanup) {
			return;
		}
		const handler = (payload: BackgroundTaskNotification) => {
			if (!this.backgroundSettings.notificationsEnabled) {
				return;
			}
			const tone = payload.level === "warn" ? "warn" : "info";
			const reason = payload.reason ? ` (${payload.reason})` : "";
			const command =
				payload.command.length > 40
					? `${payload.command.slice(0, 37)}…`
					: payload.command;
			this.notificationView.showToast(
				`Background task ${payload.taskId} ${payload.message} – ${command}${reason}`,
				tone,
			);
		};
		backgroundTaskManager.on("notification", handler);
		this.backgroundTaskNotificationCleanup = () => {
			backgroundTaskManager.off("notification", handler);
		};
	}

	stop(): void {
		this.loaderView.stop();
		this.promptQueueUnsubscribe?.();
		this.promptQueueUnsubscribe = undefined;
		this.backgroundTaskNotificationCleanup?.();
		this.backgroundTaskNotificationCleanup = undefined;
		this.backgroundSettingsUnsubscribe?.();
		this.backgroundSettingsUnsubscribe = undefined;
		// Clean up MCP and composer event listeners
		if (this.mcpConnectedHandler) {
			mcpManager.off("connected", this.mcpConnectedHandler);
			this.mcpConnectedHandler = undefined;
		}
		if (this.mcpDisconnectedHandler) {
			mcpManager.off("disconnected", this.mcpDisconnectedHandler);
			this.mcpDisconnectedHandler = undefined;
		}
		if (this.mcpToolsChangedHandler) {
			mcpManager.off("tools_changed", this.mcpToolsChangedHandler);
			this.mcpToolsChangedHandler = undefined;
		}
		if (this.mcpToolsChangedTimeout) {
			clearTimeout(this.mcpToolsChangedTimeout);
			this.mcpToolsChangedTimeout = undefined;
		}
		if (this.mcpProgressHandler) {
			mcpManager.off("progress", this.mcpProgressHandler);
			this.mcpProgressHandler = undefined;
		}
		if (this.mcpLogHandler) {
			mcpManager.off("log", this.mcpLogHandler);
			this.mcpLogHandler = undefined;
		}
		if (this.composerActivatedHandler) {
			composerManager.off("activated", this.composerActivatedHandler);
			this.composerActivatedHandler = undefined;
		}
		if (this.composerDeactivatedHandler) {
			composerManager.off("deactivated", this.composerDeactivatedHandler);
			this.composerDeactivatedHandler = undefined;
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
		this.footer.dispose();
	}

	private async handleLoginCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		// Prevent concurrent OAuth flows
		if (this.isOAuthFlowActive) {
			context.showError(
				"An OAuth flow is already in progress. Please complete or cancel it first.",
			);
			return;
		}

		// Set flag immediately to prevent race condition during async operations
		this.isOAuthFlowActive = true;

		const args = context.argumentText.trim().toLowerCase();

		// Parse argument: can be either "mode" or "provider:mode"
		let requestedProvider: string | undefined;
		let selectedMode = "pro";
		const validModes = ["pro", "console"];

		if (args) {
			// Check if format is provider:mode
			if (args.includes(":")) {
				const parts = args.split(":").map((s) => s.trim());
				requestedProvider = parts[0];
				const mode = parts[1];
				if (mode && !validModes.includes(mode)) {
					this.isOAuthFlowActive = false;
					context.showError(
						`Invalid mode: ${mode}. Valid modes: ${validModes.join(", ")}`,
					);
					return;
				}
				selectedMode = mode && validModes.includes(mode) ? mode : "pro";
			} else {
				// Single argument - could be mode or provider
				if (validModes.includes(args)) {
					selectedMode = args;
				} else {
					requestedProvider = args;
				}
			}
		}

		// Import OAuth system
		const { getOAuthProviders, login, migrateOAuthCredentials } = await import(
			"../oauth/index.js"
		);

		// Migrate old credentials if needed
		await migrateOAuthCredentials();

		// Get available providers
		const providers = getOAuthProviders().filter((p) => p.available);

		if (providers.length === 0) {
			this.isOAuthFlowActive = false;
			context.showError("No OAuth providers available");
			return;
		}

		// If only one provider or specific provider requested, use it directly
		if (providers.length === 1 || requestedProvider) {
			const provider = requestedProvider
				? providers.find(
						(p) =>
							p.id === requestedProvider || p.id.includes(requestedProvider),
					)
				: providers[0];

			if (!provider) {
				this.isOAuthFlowActive = false;
				context.showError(`Unknown provider: ${requestedProvider}`);
				return;
			}

			await this.performOAuthLogin(provider.id as any, selectedMode, context);
			return;
		}

		// Multiple providers - show selector
		// Always create new selector to avoid stale closure over selectedMode and context
		this.oauthLoginView = new OAuthSelectorView({
			modalManager: this.modalManager,
			ui: this.ui,
			mode: "login",
			onProviderSelected: async (providerId) => {
				try {
					await this.performOAuthLogin(providerId, selectedMode, context);
				} finally {
					this.isOAuthFlowActive = false;
				}
			},
			onCancel: () => {
				this.isOAuthFlowActive = false;
				this.notificationView.showInfo("Login cancelled");
			},
		});

		this.oauthLoginView.show();
	}

	private async performOAuthLogin(
		providerId: "anthropic" | "openai" | "github-copilot",
		mode: string,
		context: CommandExecutionContext,
	): Promise<void> {
		const { login } = await import("../oauth/index.js");
		const { execFile } = await import("node:child_process");

		// Flag is already set by handleLoginCommand, no need to set again
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`Logging in to ${providerId}...`, 1, 0),
		);
		this.ui.requestRender();

		try {
			await login(providerId, {
				mode: mode as "pro" | "console" | undefined,
				onAuthUrl: (url: string) => {
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text("Opening browser to:", 1, 0));
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(url, 1, 0));
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(
						new Text(
							"Paste the authorization code below (or type 'cancel' to abort):",
							1,
							0,
						),
					);
					this.ui.requestRender();

					// Auto-open browser using execFile for security
					const openCmd =
						process.platform === "darwin"
							? "open"
							: process.platform === "win32"
								? "cmd"
								: "xdg-open";
					const args =
						process.platform === "win32"
							? ["/c", "start", "", url] // Empty string after 'start' prevents URL from being treated as window title
							: [url];
					execFile(openCmd, args, (error) => {
						if (error) {
							this.notificationView.showInfo(
								"Could not auto-open browser. Please copy the URL manually.",
							);
						}
					});
				},
				onPromptCode: async () => {
					const originalOnSubmit = this.editor.onSubmit;
					return new Promise<string>((resolve, reject) => {
						const timeout = setTimeout(
							() => {
								reject(new Error("OAuth flow timed out after 5 minutes"));
							},
							5 * 60 * 1000,
						); // 5 minute timeout

						this.editor.onSubmit = (text) => {
							const trimmedText = text.trim();

							// Handle cancellation
							if (trimmedText.toLowerCase() === "cancel") {
								clearTimeout(timeout);
								this.clearEditor();
								reject(new Error("OAuth flow cancelled by user"));
								return;
							}

							// Basic authorization code validation
							// Allow alphanumeric, underscore, hyphen, and # (for Anthropic's code#state format)
							if (
								trimmedText.length < 10 ||
								!/^[a-zA-Z0-9_#-]+$/.test(trimmedText)
							) {
								this.notificationView.showError(
									"Invalid authorization code format. Please try again or type 'cancel'.",
								);
								this.clearEditor();
								// Don't clear timeout - allow user to retry
								return;
							}

							clearTimeout(timeout);
							this.clearEditor();
							resolve(trimmedText);
						};
					}).finally(() => {
						// Always restore original handler in finally block
						this.editor.onSubmit = originalOnSubmit;
					});
				},
			});

			this.notificationView.showToast(
				`Successfully authenticated with ${providerId}!`,
				"success",
			);
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(
					`Authentication complete. ${providerId} OAuth credentials saved.`,
					1,
					0,
				),
			);
			this.ui.requestRender();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Login failed";

			// Provide better error context
			let errorDetail = message;
			if (message.includes("timeout")) {
				errorDetail = "OAuth flow timed out after 5 minutes. Please try again.";
			} else if (message.includes("cancel")) {
				errorDetail = "OAuth flow cancelled by user.";
			} else if (message.includes("Invalid") || message.includes("failed")) {
				errorDetail = `${message}. The authorization code may be expired or invalid.`;
			}

			context.showError(errorDetail);
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(`Login failed: ${errorDetail}`, 1, 0),
			);
			this.ui.requestRender();
		} finally {
			this.isOAuthFlowActive = false;
		}
	}

	private async handleLogoutCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		// Check if OAuth flow is already active
		if (this.isOAuthFlowActive) {
			context.showError(
				"An OAuth flow is already in progress. Please complete or cancel it first.",
			);
			return;
		}

		// Set flag immediately to prevent race condition during async operations
		this.isOAuthFlowActive = true;

		const args = context.argumentText.trim().toLowerCase();
		const requestedProvider = args || null;

		// Import OAuth system
		const { listOAuthProviders, logout } = await import("../oauth/index.js");

		// Get logged-in providers
		const loggedInProviders = listOAuthProviders();

		if (loggedInProviders.length === 0) {
			this.isOAuthFlowActive = false;
			context.showInfo("No OAuth providers logged in. Use /login first.");
			return;
		}

		// If specific provider requested or only one logged in, use it directly
		if (loggedInProviders.length === 1 || requestedProvider) {
			const provider = requestedProvider
				? loggedInProviders.find(
						(p) => p === requestedProvider || p.includes(requestedProvider),
					)
				: loggedInProviders[0];

			if (!provider) {
				this.isOAuthFlowActive = false;
				context.showError(`Not logged in to: ${requestedProvider}`);
				return;
			}

			await this.performOAuthLogout(provider as any, context);
			this.isOAuthFlowActive = false;
			return;
		}

		// Multiple providers - show selector
		// Always create new selector to avoid stale closure over context
		this.oauthLogoutView = new OAuthSelectorView({
			modalManager: this.modalManager,
			ui: this.ui,
			mode: "logout",
			onProviderSelected: async (providerId) => {
				try {
					await this.performOAuthLogout(providerId, context);
				} finally {
					this.isOAuthFlowActive = false;
				}
			},
			onCancel: () => {
				this.isOAuthFlowActive = false;
				this.notificationView.showInfo("Logout cancelled");
			},
		});

		this.oauthLogoutView.show();
	}

	private async detectAndApplyTerminalTheme(): Promise<void> {
		const auto = process.env.COMPOSER_TUI_AUTO_THEME;
		if (auto === "0" || auto === "false") return;
		const detected = await probeTerminalBackground();
		if (!detected) return;
		const current = getCurrentThemeName();
		if (current !== "dark" && current !== "light") return;
		if (detected === current) return;
		const { success } = setTheme(detected);
		if (success) {
			this.ui.requestRender();
		}
	}

	private configureRenderThrottle(): void {
		const envValue = process.env.COMPOSER_TUI_RENDER_INTERVAL_MS;
		let interval = Number.parseInt(envValue ?? "", 10);
		if (!Number.isFinite(interval)) {
			if (process.env.SSH_CONNECTION || process.env.SSH_TTY) {
				interval = SSH_RENDER_INTERVAL_MS;
			} else {
				interval = 0;
			}
		}
		this.ui.setMinRenderInterval(Math.max(0, interval));
	}

	private refreshTerminalCapabilities(): void {
		this.terminalCapabilities = {
			isTTY: Boolean(process.stdout.isTTY && process.stdin.isTTY),
			columns: process.stdout.columns ?? 80,
			rows: process.stdout.rows ?? 24,
			colorLevel: chalk.level || 0,
		};
	}

	private async runConnectivityProbe(): Promise<void> {
		// Fast, no-network probe: ensure a model is selected and transport is configured.
		const state = this.agent.state;
		if (!state?.model) {
			throw new Error("No default model configured. Use /model to select one.");
		}
		// If transport exposes a light ping, use it without sending user content
		const transport: any = (this.agent as any).transport;
		if (transport?.ping) {
			await transport.ping().catch((error: any) => {
				const message =
					error?.message ??
					"Model connectivity probe failed. Check API key and network.";
				throw new Error(message);
			});
		}
	}

	private async performOAuthLogout(
		providerId: "anthropic" | "openai" | "github-copilot",
		context: CommandExecutionContext,
	): Promise<void> {
		try {
			const { logout } = await import("../oauth/index.js");
			await logout(providerId);

			this.notificationView.showToast(
				`${providerId} OAuth credentials removed`,
				"success",
			);
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(
					`Logged out from ${providerId}. OAuth credentials removed.`,
					1,
					0,
				),
			);
			this.ui.requestRender();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Logout failed";
			context.showError(message);
		}
	}
}

async function probeTerminalBackground(): Promise<"dark" | "light" | null> {
	if (!process.stdout.isTTY || !process.stdin.isTTY) return null;

	const prevRaw = process.stdin.isRaw;
	return await new Promise((resolve) => {
		let settled = false;
		const cleanup = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			try {
				if (process.stdin.setRawMode && prevRaw === false) {
					process.stdin.setRawMode(false);
				}
			} catch {
				// ignore
			}
			process.stdin.off("data", handler);
		};

		const timeout = setTimeout(() => {
			cleanup();
			resolve(null);
		}, 300);

		const handler = (data: Buffer) => {
			const escIndex = data.indexOf(0x1b);
			if (escIndex === -1) return;
			const slice = data.slice(escIndex);
			const text = slice.toString();
			const start = text.indexOf("]11;");
			if (start === -1) return;
			const payloadStart = start + 4;
			const end = text.indexOf("\u0007", payloadStart);
			if (end === -1) return;
			const color = text.slice(payloadStart, end);
			const luminance = parseLuminance(color);
			cleanup();
			resolve(luminance);
		};

		try {
			if (process.stdin.setRawMode && prevRaw === false) {
				process.stdin.setRawMode(true);
			}
		} catch {
			resolve(null);
			return;
		}

		process.stdin.on("data", handler);
		process.stdout.write("\u001b]11;?\u0007");
	});
}

function parseLuminance(color: string): "dark" | "light" | null {
	let r = 0;
	let g = 0;
	let b = 0;
	if (color.startsWith("rgb:")) {
		const parts = color.substring(4).split("/");
		r = Number.parseInt(parts[0] ?? "0", 16) >> 8;
		g = Number.parseInt(parts[1] ?? "0", 16) >> 8;
		b = Number.parseInt(parts[2] ?? "0", 16) >> 8;
	} else if (color.startsWith("#")) {
		r = Number.parseInt(color.substring(1, 3) || "0", 16);
		g = Number.parseInt(color.substring(3, 5) || "0", 16);
		b = Number.parseInt(color.substring(5, 7) || "0", 16);
	} else if (color.startsWith("rgb(")) {
		const parts = color.substring(4, color.length - 1).split(",");
		r = Number.parseInt(parts[0] ?? "0", 10);
		g = Number.parseInt(parts[1] ?? "0", 10);
		b = Number.parseInt(parts[2] ?? "0", 10);
	} else {
		return null;
	}

	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance > 0.5 ? "light" : "dark";
}
