import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { SlashCommand } from "@evalops/tui";
import {
	Container,
	Markdown,
	ProcessTerminal,
	ScrollContainer,
	Spacer,
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
	ThinkingLevel,
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
import { listOAuthProviders, loadOAuthCredentials } from "../oauth/storage.js";
import { getOpenTelemetryStatus } from "../opentelemetry.js";
import {
	getBackgroundTaskSettings,
	subscribeBackgroundTaskSettings,
} from "../runtime/background-settings.js";
import {
	type SessionModelMetadata,
	toSessionModelMetadata,
} from "../session/manager.js";
import type { SessionManager } from "../session/manager.js";
import {
	getTelemetryStatus,
	recordCompaction,
	recordSessionStart,
	recordTokenUsage,
} from "../telemetry.js";
import { getCurrentThemeName, setTheme } from "../theme/theme.js";
import {
	type BackgroundTaskNotification,
	backgroundTaskManager,
} from "../tools/background-tasks.js";
import { getTrainingStatus } from "../training.js";

import {
	AutoCompactionMonitor,
	type CompactionStats,
} from "../agent/auto-compaction.js";
import {
	SessionRecoveryManager,
	listSessionBackups,
} from "../agent/session-recovery.js";
import { composerManager } from "../composers/index.js";
import { mcpManager } from "../mcp/index.js";
import {
	type AutoVerifyService,
	type TestResult,
	formatTestResult,
	registerTestVerificationHooks,
} from "../testing/index.js";
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
	type GroupedCommandHandlers,
	createGroupedCommandHandlers,
} from "./commands/grouped-command-handlers.js";
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
import { OAuthFlowController } from "./oauth/index.js";
import { OllamaView } from "./ollama-view.js";
import { PlanPanelModal } from "./plan-panel-modal.js";
import { PlanView, type TodoStore, loadTodoStore } from "./plan-view.js";
import type { PromptQueue, PromptQueueEvent } from "./prompt-queue.js";
import { QueuePanelModal } from "./queue-panel-modal.js";
import { RunCommandView } from "./run/run-command-view.js";
import { RunController } from "./run/run-controller.js";
import { FileSearchView } from "./search/file-search-view.js";
import { ModelSelectorView } from "./selectors/model-selector-view.js";
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
import { SlashCommandMatcher, SlashCycleState } from "./slash/index.js";
import { renderStartupAnnouncements } from "./startup-announcements.js";
import { CostView } from "./status/cost-view.js";
import { DiagnosticsView } from "./status/diagnostics-view.js";
import { QuotaView } from "./status/quota-view.js";
import { TelemetryView } from "./status/telemetry-view.js";
import { TrainingView } from "./status/training-view.js";
import { StreamingView } from "./streaming-view.js";
import type { ToolExecutionComponent } from "./tool-execution.js";
import { ToolOutputView } from "./tool-output-view.js";
import { ToolStatusView } from "./tool-status-view.js";
import {
	type UiState,
	loadCommandPrefs,
	loadUiState,
	saveCommandPrefs,
	saveUiState,
} from "./ui-state.js";
import { UpdateView } from "./update-view.js";
import { CommandPaletteView } from "./utils/commands/command-palette-view.js";
import { buildCommandRegistry } from "./utils/commands/command-registry-builder.js";
import { buildReviewPrompt } from "./utils/commands/review-prompt.js";
import { SlashHintBar } from "./utils/commands/slash-hint-bar.js";
import {
	type FooterHint,
	type FooterMode,
	type FooterStats,
	calculateFooterStats,
	formatTokenCount,
} from "./utils/footer-utils.js";
import { WelcomeAnimation } from "./welcome-animation.js";

import { handleAgentsInit } from "../cli/commands/agents.js";
import { validateFrameworkPreference } from "../config/framework.js";
import type { UpdateCheckResult } from "../update/check.js";
import { ApprovalController } from "./approval/approval-controller.js";
import { parseCleanMode, readCleanModeFromEnv } from "./clean-mode.js";
import { handleFrameworkCommand as frameworkHandler } from "./commands/framework-handlers.js";
import { handleGuardianCommand as guardianHandler } from "./commands/guardian-handlers.js";
import { handleOtelCommand as otelHandler } from "./commands/otel-handlers.js";
import { InterruptController } from "./interrupt-controller.js";
import { ModalManager } from "./modal-manager.js";
import { PasteHandler } from "./paste/paste-handler.js";
import {
	type LowBandwidthConfig,
	SSH_RENDER_INTERVAL_MS,
	type TerminalCapabilities,
	isMinimalMode as checkMinimalMode,
	getLowBandwidthConfig,
	getTerminalCapabilities,
	probeTerminalBackground,
} from "./terminal/terminal-utils.js";
import { isReducedMotionEnabled, setReducedMotionEnv } from "./utils/motion.js";
import { buildRuntimeBadges } from "./utils/runtime-badges.js";

const logger = createLogger("tui:renderer");

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
	private scrollContainer: ScrollContainer;
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
	private onInterruptCallback?: (options?: { keepPartial?: boolean }) => void;

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
	private autoCompactionMonitor: AutoCompactionMonitor;
	private sessionRecoveryManager: SessionRecoveryManager;
	private testVerificationService: AutoVerifyService | null = null;
	private sessionStartTime: number | null = null;
	private sessionTelemetryRecorded = false;
	private planHint: string | null = null;
	private toolOutputView: ToolOutputView;
	private commandPaletteView: CommandPaletteView;
	private slashCommands: SlashCommand[] = [];
	private commandEntries: CommandEntry[] = [];
	private recentCommands: string[] = [];
	private favoriteCommands = new Set<string>();
	private slashHintBar!: SlashHintBar;
	private slashCommandMatcher!: SlashCommandMatcher;
	private slashCycleState = new SlashCycleState();
	private slashHintDebounce?: NodeJS.Timeout;
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
	private oauthFlowController!: OAuthFlowController;
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
	private resizeHandler: () => void;
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
	// Default to soft deduplication so repeated streamed lines don't appear in the TUI.
	// Users can still override via /clean or env/UI state.
	private cleanMode: CleanMode = "soft";
	private nextQueuedPreview: string | null = null;
	private uiState: UiState = {};
	private footerMode: FooterMode = "ensemble";
	private reducedMotion = false;
	private reducedMotionForced = false;
	private zenMode = false;
	private readonly minimalMode = checkMinimalMode();
	private isAgentRunning = false;
	private approvalController?: ApprovalController;
	private approvalService: ActionApprovalService;
	private compactionInProgress = false;
	private contextWarningLevel: "none" | "warn" | "danger" = "none";
	private modelScope: RegisteredModel[] = [];
	private startupChangelog?: string | null;
	private startupChangelogSummary?: string | null;
	private updateNotice?: UpdateCheckResult | null;
	private startupWarnings: FooterHint[] = [];
	private isCyclingModel = false;
	private modalManager: ModalManager;
	private terminalCapabilities: TerminalCapabilities =
		getTerminalCapabilities();
	private terminalFeatures = detectTerminalFeatures();
	private lowBandwidthConfig: LowBandwidthConfig = getLowBandwidthConfig();
	private interruptController!: InterruptController;
	private pasteHandler!: PasteHandler;
	private groupedHandlers?: GroupedCommandHandlers;

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
		const envCleanMode = readCleanModeFromEnv();
		if (envCleanMode) {
			this.cleanMode = envCleanMode;
		}
		if (this.uiState.footerMode) {
			this.footerMode = this.uiState.footerMode;
		}
		const envReducedMotion = isReducedMotionEnabled();
		if (typeof this.uiState.reducedMotion === "boolean") {
			this.reducedMotion = this.uiState.reducedMotion;
		} else {
			this.reducedMotion = envReducedMotion;
		}
		if (envReducedMotion && this.uiState.reducedMotion !== false) {
			this.reducedMotionForced = true;
		}
		setReducedMotionEnv(this.reducedMotion);
		if (typeof this.uiState.zenMode === "boolean") {
			this.zenMode = this.uiState.zenMode;
		}
		if (Array.isArray(this.uiState.recentCommands)) {
			this.recentCommands = [...this.uiState.recentCommands];
		}
		if (Array.isArray(this.uiState.favoriteCommands)) {
			for (const name of this.uiState.favoriteCommands) {
				this.favoriteCommands.add(name);
			}
		}
		const diskPrefs = loadCommandPrefs();
		if (diskPrefs.recents.length > 0) {
			this.recentCommands = diskPrefs.recents;
		}
		for (const fav of diskPrefs.favorites) {
			this.favoriteCommands.add(fav);
		}
		this.agent = agent;
		this.agent.setQueueMode(this.promptQueueMode === "all" ? "all" : "one");
		this.sessionManager = sessionManager;
		this.version = version;
		this.explicitApiKey = explicitApiKey;
		this.modelScope = options.modelScope ?? [];
		this.autoCompactionMonitor = new AutoCompactionMonitor({
			onCompactionRecommended: (stats) => {
				this.handleAutoCompactionRecommendation(stats);
			},
		});
		this.sessionRecoveryManager = new SessionRecoveryManager();
		// Initialize test verification with auto-test hooks
		this.testVerificationService = registerTestVerificationHooks(
			process.cwd(),
			{
				onTestComplete: (result) => {
					this.handleTestVerificationResult(result);
				},
			},
		);
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
		this.resizeHandler = () => this.refreshTerminalCapabilities();
		process.stdout.on("resize", this.resizeHandler);
		this.startupContainer = new Container();
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		// Wrap chatContainer in ScrollContainer for viewport scrolling
		this.scrollContainer = new ScrollContainer(this.chatContainer, {
			stickyScroll: true,
			showIndicator: true,
			reservedLines: 6, // Header, status, editor, footer
			onScroll: () => this.ui.requestRender(),
		});
		this.statusContainer = new Container();
		this.editor = new CustomEditor();
		this.editor.onLargePaste = (event) => {
			void this.pasteHandler.handleLargePaste(event);
		};
		this.editor.onTyping = () => {
			this.handleEditorTyping();
		};
		this.editor.onCtrlP = () => {
			void this.cycleModel();
		};
		this.editor.onCtrlO = () => {
			this.toggleToolOutputs();
		};
		this.editor.onTab = () => this.handleSlashCycle(false);
		this.editor.onShiftTab = () => {
			// reverse cycle; if not handled, fall back to thinking level cycle
			const handled = this.handleSlashCycle(true);
			if (handled) return true;
			this.cycleThinkingLevel();
			return true;
		};
		// Handle scroll shortcuts (PageUp, PageDown, Ctrl+U, Ctrl+D, etc.)
		this.editor.onShortcut = (shortcut: string) => {
			switch (shortcut) {
				case "pageup":
					this.scrollContainer.pageUp();
					this.ui.requestRender();
					return true;
				case "pagedown":
					this.scrollContainer.pageDown();
					this.ui.requestRender();
					return true;
				case "ctrl+u":
					this.scrollContainer.halfPageUp();
					this.ui.requestRender();
					return true;
				case "ctrl+d":
					this.scrollContainer.halfPageDown();
					this.ui.requestRender();
					return true;
				case "ctrl+home":
					this.scrollContainer.scrollToTop();
					this.ui.requestRender();
					return true;
				case "ctrl+end":
					this.scrollContainer.scrollToBottom();
					this.ui.requestRender();
					return true;
				case "ctrl+k":
					// Command palette - handled elsewhere
					return false;
				case "at":
					// File search - handled elsewhere
					return false;
				case "k":
					// Keep partial during interrupt - handled elsewhere
					return false;
				default:
					return false;
			}
		};
		this.editorContainer = new Container(); // Container to hold editor or selector
		this.slashHintBar = new SlashHintBar();
		this.editorContainer.addChild(this.slashHintBar);
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

		// Initialize OAuth flow controller
		const editorRef = this.editor;
		this.oauthFlowController = new OAuthFlowController({
			modalManager: this.modalManager,
			notificationView: this.notificationView,
			renderContext: {
				chatContainer: this.chatContainer,
				ui: this.ui,
				requestRender: () => this.ui.requestRender(),
			},
			editorCallbacks: {
				clearEditor: () => this.clearEditor(),
				getText: () => editorRef.getText(),
				setText: (text) => editorRef.setText(text),
				get onSubmit() {
					return editorRef.onSubmit;
				},
				set onSubmit(handler) {
					editorRef.onSubmit = handler;
				},
			},
		});

		// Initialize interrupt controller
		this.interruptController = new InterruptController({
			footer: this.footer,
			notificationView: this.notificationView,
			callbacks: {
				onInterrupt: (options) => this.onInterruptCallback?.(options),
				restoreQueuedPrompts: () => this.restoreQueuedPromptIfAny(),
				getWorkingHint: () => this.workingFooterHint,
				isMinimalMode: () => this.isMinimalMode(),
				isAgentRunning: () => this.isAgentRunning,
				refreshFooterHint: () => this.refreshFooterHint(),
			},
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

		// Initialize paste handler
		this.pasteHandler = new PasteHandler({
			agent: this.agent,
			notificationView: this.notificationView,
			sessionContext: this.sessionContext,
			editor: this.editor,
			refreshFooterHint: () => this.refreshFooterHint(),
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
			getRecentCommands: () => this.recentCommands,
			getFavoriteCommands: () => this.favoriteCommands,
			onToggleFavorite: (name) => this.toggleFavoriteCommand(name),
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
			otelStatus: () => getOpenTelemetryStatus(),
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
			getRecentCommands: () => this.recentCommands,
			getFavoriteCommands: () => this.favoriteCommands,
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
			handleUndo: (context) => this.handleEnhancedUndoCommand(context),
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
			handleOtel: (context) => this.handleOtelCommand(context),
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
			handleCompact: (context) => {
				// Extract custom instructions from rawInput (e.g., "/compact Focus on API changes")
				const customInstructions = context.rawInput
					.replace(/^\/compact\s*/i, "")
					.trim();
				return this.handleCompactCommand(customInstructions || undefined);
			},
			handleAutocompact: (context) =>
				this.handleAutocompactCommand(context.rawInput),
			handleFooter: (context) => this.handleFooterCommand(context),
			handleCompactTools: (context) =>
				this.handleCompactToolsCommand(context.rawInput),
			handleCommands: (context) => this.handleCommandsCommand(context),
			handleQueue: (context) => this.handleQueueCommand(context),
			handleBranch: (context) => this.handleBranchCommand(context),
			handleLogin: (context) =>
				this.oauthFlowController.handleLoginCommand(
					context.argumentText,
					(msg) => context.showError(msg),
				),
			handleLogout: (context) =>
				this.oauthFlowController.handleLogoutCommand(
					context.argumentText,
					(msg) => context.showError(msg),
					(msg) => context.showInfo(msg),
				),
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
			handleGuardian: (context) => this.handleGuardianCommand(context),
			handleWorkflow: (context) => this.handleWorkflowCommand(context),
			handleChanges: (context) => this.handleChangesCommand(context),
			handleCheckpoint: (context) => this.handleCheckpointCommand(context),
			handleMemory: (context) => this.handleMemoryCommand(context),
			handleMode: (context) => this.handleModeCommand(context),
			// Grouped command handlers
			handleSessionCommand: (context) =>
				this.handleGroupedSessionCommand(context),
			handleDiagCommand: (context) => this.handleGroupedDiagCommand(context),
			handleUiCommand: (context) => this.handleGroupedUiCommand(context),
			handleSafetyCommand: (context) =>
				this.handleGroupedSafetyCommand(context),
			handleGitCommand: (context) => this.handleGroupedGitCommand(context),
			handleAuthCommand: (context) => this.handleGroupedAuthCommand(context),
			handleUsageCommand: (context) => this.handleGroupedUsageCommand(context),
			handleUndoCommand: (context) => this.handleGroupedUndoCommand(context),
			handleConfigCommand: (context) =>
				this.handleGroupedConfigCommand(context),
			handleToolsCommand: (context) => this.handleGroupedToolsCommand(context),
		});

		this.commandEntries = registry.entries;
		this.slashCommands = registry.commands;
		this.slashCommandMatcher = new SlashCommandMatcher(this.slashCommands);

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
			onCommandExecuted: (name) => this.recordCommandUsage(name),
			onSubmit: (text) => {
				void this.handleTextSubmit(text);
			},
			shouldInterrupt: () =>
				this.isAgentRunning || this.interruptController.isArmed(),
			onInterrupt: () => this.handleInterruptRequest(),
			onKeepPartial: () => this.handleKeepPartialRequest(),
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

	private handleSessionRecoverCommand(context: CommandExecutionContext): void {
		const backups = listSessionBackups();
		if (!backups.length) {
			context.showInfo("No session backups available to recover.");
			return;
		}

		// Prefer backup for current cwd, fall back to most recent overall
		const cwd = process.cwd();
		const backup =
			backups.find((b) => b.cwd === cwd) ??
			backups.sort(
				(a, b) =>
					new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
			)[0];

		if (!backup) {
			context.showInfo("No session backups available to recover.");
			return;
		}

		this.resetConversation(
			backup.messages,
			undefined,
			`Recovered session ${backup.sessionId.slice(0, 8)} from backup.`,
			{ persistMessages: true },
		);
		this.sessionRecoveryManager.markRecovered("manual_recovery");
	}

	public async ensureContextBudgetBeforePrompt(): Promise<void> {
		if (this.compactionInProgress) {
			return;
		}
		const state = this.agent.state;
		if (!state?.model?.contextWindow) {
			return;
		}

		// Use AutoCompactionMonitor for rate-limited context checking
		const compactionStats = this.autoCompactionMonitor.check(
			state.messages,
			state.model,
		);

		if (!compactionStats.shouldCompact) {
			return;
		}

		const percentLabel = compactionStats.usagePercent.toFixed(1);
		this.notificationView.showInfo(
			`Context ${percentLabel}% full – compacting history before sending prompt…`,
		);
		const footerStats = calculateFooterStats(state);
		const compacted = await this.runCompactionTask(() =>
			this.conversationCompactor.compactHistory(),
		);
		if (compacted) {
			this.autoCompactionMonitor.recordCompaction();
			this.recordCompactionDelta(footerStats, "auto");
		}
	}

	/**
	 * Handle auto-compaction recommendation from the monitor.
	 */
	private handleAutoCompactionRecommendation(stats: CompactionStats): void {
		// Update context warning level based on usage
		const thresholds = this.autoCompactionMonitor.getWarningThresholds();
		if (stats.usagePercent >= thresholds.critical) {
			this.contextWarningLevel = "danger";
		} else if (stats.usagePercent >= thresholds.warning) {
			this.contextWarningLevel = "warn";
		} else {
			this.contextWarningLevel = "none";
		}
		this.refreshFooterHint();
	}

	/**
	 * Handle test verification result.
	 * Shows a notification with test results - success is brief, failures are detailed.
	 */
	private handleTestVerificationResult(result: TestResult): void {
		if (result.success) {
			// Show brief success notification
			this.notificationView.showInfo(
				`✓ Tests passed: ${result.passedTests}/${result.totalTests} (${result.durationMs}ms)`,
			);
		} else {
			// Show detailed failure notification
			const formatted = formatTestResult(result);
			this.notificationView.showError(formatted);

			// If we have specific failures, add them to the context for the agent
			if (result.failures.length > 0) {
				const failureSummary = result.failures
					.slice(0, 3)
					.map((f) => `• ${f.testName}: ${f.errorMessage.split("\n")[0]}`)
					.join("\n");
				logger.warn("Test failures detected", {
					failedTests: result.failedTests,
					failures: failureSummary,
				});
			}
		}
	}

	/**
	 * Record token usage telemetry from the latest assistant messages.
	 */
	private recordTokenUsageFromMessages(state: AgentState): void {
		// Find the most recent assistant message with usage info
		for (let i = state.messages.length - 1; i >= 0; i--) {
			const message = state.messages[i];
			if (message.role === "assistant" && message.usage) {
				recordTokenUsage(
					this.sessionManager.getSessionId(),
					{
						input: message.usage.input,
						output: message.usage.output,
						cacheRead: message.usage.cacheRead,
						cacheWrite: message.usage.cacheWrite,
					},
					{
						model: state.model
							? `${state.model.provider}/${state.model.id}`
							: undefined,
						provider: state.model?.provider,
					},
				);
				break;
			}
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
		// Use scrollContainer instead of chatContainer directly for scrolling support
		this.ui.addChild(this.scrollContainer);
		this.ui.addChild(this.statusContainer);

		// Disable TUI's auto-clipping since ScrollContainer handles viewport
		this.ui.setAutoClip(false);
		// Set initial viewport height
		this.updateScrollViewport();

		this.ui.addChild(new Spacer(1));
		this.ui.addChild(this.editorContainer); // Use container that can hold editor or selector
		this.refreshFooterHint();
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);
		renderStartupAnnouncements({
			container: this.startupContainer,
			ui: this.ui,
			updateNotice: this.updateNotice,
			startupChangelog: this.startupChangelog,
			startupChangelogSummary: this.startupChangelogSummary,
			modelScope: this.modelScope,
		});

		// Start the UI
		this.ui.start();
		this.isInitialized = true;
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
			// Start session recovery tracking if not already started
			if (!this.sessionRecoveryManager.getCurrentBackup()) {
				this.sessionRecoveryManager.startSession({
					sessionId: this.sessionManager.getSessionId(),
					systemPrompt: state.systemPrompt,
					modelId: state.model
						? `${state.model.provider}/${state.model.id}`
						: undefined,
					cwd: process.cwd(),
				});
			}
			// Record session start telemetry (once per session)
			if (!this.sessionTelemetryRecorded) {
				this.sessionStartTime = Date.now();
				this.sessionTelemetryRecorded = true;
				recordSessionStart(this.sessionManager.getSessionId(), {
					model: state.model
						? `${state.model.provider}/${state.model.id}`
						: undefined,
					provider: state.model?.provider,
				});
			}
		} else if (event.type === "agent_end") {
			this.isAgentRunning = false;
			this.interruptController.clear();
			// Update session recovery with latest messages
			this.sessionRecoveryManager.updateMessages([...state.messages]);
			// Record token usage from the latest assistant message
			this.recordTokenUsageFromMessages(state);
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
		if (this.pasteHandler.hasPending()) {
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

	setInterruptCallback(
		callback: (options?: { keepPartial?: boolean }) => void,
	): void {
		this.onInterruptCallback = callback;
	}

	private handleInterruptRequest(): void {
		this.interruptController.handleInterruptRequest();
	}

	/**
	 * Handle 'k' key press to keep partial response during interrupt.
	 * Only works when interrupt is armed.
	 * @returns true if the key was handled (interrupt was armed), false otherwise
	 */
	handleKeepPartialRequest(): boolean {
		return this.interruptController.handleKeepPartialRequest();
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

	private async handleCompactCommand(
		customInstructions?: string,
	): Promise<void> {
		if (this.compactionInProgress) {
			this.notificationView.showInfo("Already compacting history…");
			return;
		}
		const beforeStats = calculateFooterStats(this.agent.state);
		const compacted = await this.runCompactionTask(() =>
			this.conversationCompactor.compactHistory({
				customInstructions,
				auto: false,
			}),
		);
		if (compacted) {
			this.recordCompactionDelta(beforeStats, "manual");
		}
	}

	private handleAutocompactCommand(rawInput: string): void {
		const parts = rawInput.trim().split(/\s+/);
		const arg = parts[1]?.toLowerCase();

		if (arg === "on" || arg === "true" || arg === "enable") {
			this.conversationCompactor.updateSettings({ enabled: true });
			this.notificationView.showInfo("Auto-compaction enabled.");
		} else if (arg === "off" || arg === "false" || arg === "disable") {
			this.conversationCompactor.updateSettings({ enabled: false });
			this.notificationView.showInfo("Auto-compaction disabled.");
		} else if (arg === "status" || !arg) {
			const enabled = this.conversationCompactor.isAutoCompactionEnabled();
			const settings = this.conversationCompactor.getSettings();
			this.notificationView.showInfo(
				`Auto-compaction: ${enabled ? "enabled" : "disabled"}\n` +
					`Reserve tokens: ${settings.reserveTokens}\n` +
					`Keep recent tokens: ${settings.keepRecentTokens}`,
			);
		} else {
			// Toggle
			const newState = this.conversationCompactor.toggleAutoCompaction();
			this.notificationView.showInfo(
				`Auto-compaction ${newState ? "enabled" : "disabled"}.`,
			);
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

	private async handleGuardianCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		await guardianHandler(context, {
			showSuccess: (msg) => this.notificationView.showToast(msg, "success"),
			showWarning: (msg) => this.notificationView.showToast(msg, "warn"),
			showError: (msg) => this.notificationView.showError(msg),
			addContent: (content) =>
				this.chatContainer.addChild(new Markdown(content)),
			requestRender: () => this.ui.requestRender(),
		});
	}

	private async handleWorkflowCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		const { handleWorkflowCommand } = await import(
			"./commands/workflow-handlers.js"
		);
		// Build tool map from agent state
		const toolMap = new Map(
			(this.agent.state.tools ?? []).map((t) => [t.name, t]),
		);
		await handleWorkflowCommand({
			rawInput: context.rawInput,
			cwd: process.cwd(),
			tools: toolMap,
			addContent: (content) => {
				this.chatContainer.addChild(new Markdown(content));
			},
			showError: (message) => this.notificationView.showError(message),
			showInfo: (message) => this.notificationView.showInfo(message),
			showSuccess: (message) =>
				this.notificationView.showToast(message, "success"),
			requestRender: () => this.ui.requestRender(),
		});
	}

	private async handleEnhancedUndoCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		const { handleEnhancedUndoCommand } = await import(
			"./commands/undo-handlers.js"
		);
		handleEnhancedUndoCommand({
			rawInput: context.rawInput,
			addContent: (content) => {
				this.chatContainer.addChild(new Markdown(content));
			},
			showError: (message) => this.notificationView.showError(message),
			showInfo: (message) => this.notificationView.showInfo(message),
			showSuccess: (message) =>
				this.notificationView.showToast(message, "success"),
			requestRender: () => this.ui.requestRender(),
		});
	}

	private async handleChangesCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		const { handleChangesCommand } = await import(
			"./commands/undo-handlers.js"
		);
		handleChangesCommand({
			rawInput: context.rawInput,
			addContent: (content) => {
				this.chatContainer.addChild(new Markdown(content));
			},
			showError: (message) => this.notificationView.showError(message),
			showInfo: (message) => this.notificationView.showInfo(message),
			showSuccess: (message) =>
				this.notificationView.showToast(message, "success"),
			requestRender: () => this.ui.requestRender(),
		});
	}

	private async handleCheckpointCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		const { handleCheckpointCommand } = await import(
			"./commands/undo-handlers.js"
		);
		handleCheckpointCommand({
			rawInput: context.rawInput,
			addContent: (content) => {
				this.chatContainer.addChild(new Markdown(content));
			},
			showError: (message) => this.notificationView.showError(message),
			showInfo: (message) => this.notificationView.showInfo(message),
			showSuccess: (message) =>
				this.notificationView.showToast(message, "success"),
			requestRender: () => this.ui.requestRender(),
		});
	}

	private async handleMemoryCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		const { handleMemoryCommand } = await import(
			"./commands/memory-handlers.js"
		);
		handleMemoryCommand({
			rawInput: context.rawInput,
			cwd: process.cwd(),
			sessionId: this.agent.state.session?.id,
			addContent: (content) => {
				this.chatContainer.addChild(new Markdown(content));
			},
			showError: (message) => this.notificationView.showError(message),
			showInfo: (message) => this.notificationView.showInfo(message),
			showSuccess: (message) =>
				this.notificationView.showToast(message, "success"),
			requestRender: () => this.ui.requestRender(),
		});
	}

	private async handleModeCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		const { createModeCommandHandler } = await import(
			"./commands/handlers/mode-handler.js"
		);
		const handler = createModeCommandHandler({
			onModeChange: (_mode, model) => {
				// Could update agent config here in the future
				this.notificationView.showToast(`Model: ${model}`, "info");
			},
		});
		handler(context);
	}

	private handleCleanCommand(context: CommandExecutionContext): void {
		const arg = context.argumentText.trim().toLowerCase();
		if (!arg) {
			context.showInfo(
				`Clean mode is ${this.cleanMode} (streaming only). Use /clean off|soft|aggressive.`,
			);
			return;
		}

		const parsed = parseCleanMode(arg);
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

	private handleOtelCommand(_context: CommandExecutionContext): void {
		otelHandler({ showInfo: (msg) => this.notificationView.showInfo(msg) });
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
			this.interruptController.clear();

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
		this.agent.setQueueMode(mode === "all" ? "all" : "one");
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

	private recordCommandUsage(name: string): void {
		// maintain uniqueness and recency
		this.recentCommands = [
			name,
			...this.recentCommands.filter((n) => n !== name),
		].slice(0, 20);
		this.persistUiState({
			recentCommands: this.recentCommands,
			favoriteCommands: Array.from(this.favoriteCommands),
		});
		this.refreshSlashHint();
		this.ui.requestRender();
	}

	private toggleFavoriteCommand(name: string): void {
		if (this.favoriteCommands.has(name)) {
			this.favoriteCommands.delete(name);
		} else {
			this.favoriteCommands.add(name);
		}
		this.persistUiState({
			recentCommands: this.recentCommands,
			favoriteCommands: Array.from(this.favoriteCommands),
		});
	}

	private handleSlashCycle(reverse = false): boolean {
		const text = this.editor.getText().trim();
		if (!text.startsWith("/")) return false;

		const [commandToken, ...restTokens] = text.split(/\s+/);
		const query = (commandToken ?? "/").slice(1).toLowerCase();
		const matches = this.getSlashMatches(query);

		if (matches.length === 0) return false;

		const replacement = this.slashCycleState.cycle(query, matches, reverse);
		if (!replacement) return false;

		const rest =
			restTokens && restTokens.length > 0 ? ` ${restTokens.join(" ")}` : " ";
		this.editor.setText(`/${replacement}${rest}`);
		this.refreshSlashHint();
		this.ui.requestRender();
		return true;
	}

	private getSlashMatches(query: string): SlashCommand[] {
		return this.slashCommandMatcher.getMatches(query, {
			favorites: this.favoriteCommands,
			recents: new Set(this.recentCommands),
		});
	}

	private persistUiState(extra?: Partial<UiState>): void {
		saveUiState({
			queueMode: this.promptQueueMode,
			compactTools: this.toolOutputView.isCompact(),
			footerMode: this.footerMode,
			reducedMotion: this.reducedMotion,
			cleanMode: this.cleanMode,
			recentCommands: this.recentCommands,
			favoriteCommands: Array.from(this.favoriteCommands),
			...extra,
		});
		saveCommandPrefs({
			favorites: Array.from(this.favoriteCommands),
			recents: this.recentCommands,
		});
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
			.filter(({ msg }) => "role" in msg && msg.role === "user");
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
		const newSessionFile = this.sessionManager.createBranchedSession(
			this.agent.state,
			slice.length,
		);
		this.sessionManager.setSessionFile(newSessionFile);
		this.resetConversation(
			slice,
			editorSeed,
			`Branched to new session before user message #${targetIndex}.`,
			{ preserveSession: true },
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
		const ts = "timestamp" in message ? message.timestamp : undefined;
		if (!ts || typeof ts !== "number") return null;
		try {
			return new Date(ts).toLocaleString();
		} catch {
			return null;
		}
	}

	private extractUserText(message: AppMessage): string {
		const content = "content" in message ? message.content : undefined;
		if (typeof content === "string") {
			return content;
		}
		if (Array.isArray(content)) {
			const textBlock = content.find(
				(block): block is { type: "text"; text: string } =>
					block != null &&
					typeof block === "object" &&
					"type" in block &&
					block.type === "text",
			);
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
		frameworkHandler(context, {
			showInfo: (msg) => this.notificationView.showInfo(msg),
			showError: (msg) => this.notificationView.showError(msg),
			showSuccess: (msg) => this.notificationView.showToast(msg, "success"),
		});
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
		options?: { preserveSession?: boolean; persistMessages?: boolean },
	): void {
		if (!options?.preserveSession) {
			this.sessionManager.startFreshSession();
		}
		this.agent.clearMessages();
		this.sessionContext.resetArtifacts();
		this.toolOutputView.clearTrackedComponents();
		this.chatContainer.clear();
		this.startupContainer.clear();
		this.planView.syncHintWithStore();
		this.planHint = null;
		for (const message of messages) {
			this.agent.appendMessage(message);
			if (options?.persistMessages) {
				this.sessionManager.saveMessage(message);
			}
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
				reducedMotion: this.reducedMotion,
				compactForced: this.minimalMode,
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
		if (this.pasteHandler?.hasPending()) {
			hints.push("Summarizing pasted text…");
		}
		if (this.bashModeView?.isActive()) {
			hints.push("Bash mode active — type exit to leave");
		}
		return hints;
	}

	private handleEditorTyping(): void {
		this.footer.clearToast();
		this.refreshSlashHintDebounced();
		this.ui.requestRender();
	}

	private refreshSlashHint(): void {
		if (!this.slashHintBar) return;
		if (this.editor.isShowingAutocomplete()) {
			this.slashHintBar.clear();
			return;
		}
		const text = this.editor.getText();
		this.slashHintBar.update(
			text,
			this.slashCommands,
			new Set(this.recentCommands),
			this.favoriteCommands,
		);
	}

	private refreshSlashHintDebounced(): void {
		if (this.slashHintDebounce) {
			clearTimeout(this.slashHintDebounce);
		}
		this.slashHintDebounce = setTimeout(() => {
			this.refreshSlashHint();
		}, 30);
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
		// Record compaction telemetry
		recordCompaction(this.sessionManager.getSessionId(), {
			model: this.agent.state.model
				? `${this.agent.state.model.provider}/${this.agent.state.model.id}`
				: undefined,
			provider: this.agent.state.model?.provider,
			trigger,
			tokensBefore: before.contextTokens,
			tokensAfter: after.contextTokens,
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

	private getGroupedHandlers(): GroupedCommandHandlers {
		if (!this.groupedHandlers) {
			this.groupedHandlers = createGroupedCommandHandlers({
				session: {
					handleNewChat: (context) => this.handleNewChatCommand(context),
					handleClear: () => this.handleClearCommand(),
					handleSessionInfo: (ctx) =>
						this.sessionView.handleSessionCommand(ctx.rawInput),
					handleSessionsList: (ctx) =>
						this.sessionView.handleSessionsCommand(ctx.rawInput),
					handleBranch: (ctx) => this.handleBranchCommand(ctx),
					handleQueue: (ctx) => this.handleQueueCommand(ctx),
					handleExport: (ctx) =>
						this.importExportView.handleExportCommand(ctx.rawInput),
					handleShare: (ctx) =>
						this.importExportView.handleShareCommand(ctx.rawInput),
					handleRecover: (ctx) => this.handleSessionRecoverCommand(ctx),
				},
				diag: {
					handleStatus: () => this.diagnosticsView.handleStatusCommand(),
					handleAbout: () => this.aboutView.handleAboutCommand(),
					handleContext: (ctx) => this.handleContextCommand(ctx),
					handleStats: (ctx) => this.handleStatsCommand(ctx),
					handleBackground: (ctx) => this.handleBackgroundCommand(ctx),
					handleDiagnostics: (ctx) =>
						this.diagnosticsView.handleDiagnosticsCommand(ctx.rawInput),
					handleTelemetry: (ctx) =>
						this.telemetryView.handleTelemetryCommand(ctx),
					handleTraining: (ctx) => this.trainingView.handleTrainingCommand(ctx),
					handleOtel: (ctx) => this.handleOtelCommand(ctx),
					handleConfig: (ctx) => this.configView.handleConfigCommand(ctx),
					handleLsp: (ctx) => this.lspView.handleLspCommand(ctx.rawInput),
					handleMcp: (ctx) => this.handleMcpCommand(ctx),
				},
				ui: {
					showTheme: () => this.themeSelectorView.show(),
					handleClean: (ctx) => this.handleCleanCommand(ctx),
					handleFooter: (ctx) => this.handleFooterCommand(ctx),
					handleZen: (ctx) => this.handleZenCommand(ctx),
					handleCompactTools: (ctx) =>
						this.handleCompactToolsCommand(ctx.rawInput),
					getUiState: () => ({
						zenMode: this.zenMode,
						cleanMode: this.cleanMode,
						footerMode: this.footerMode,
						compactTools: this.toolOutputView?.isCompact() ?? false,
					}),
				},
				safety: {
					handleApprovals: (ctx) => this.handleApprovalsCommand(ctx),
					handlePlanMode: (ctx) => this.handlePlanModeCommand(ctx),
					handleGuardian: (ctx) => this.handleGuardianCommand(ctx),
					getSafetyState: () => ({
						approvalMode: process.env.COMPOSER_APPROVALS ?? "prompt",
						planMode: process.env.COMPOSER_PLAN_MODE === "1",
						guardianEnabled: true,
					}),
				},
				git: {
					handleDiff: (ctx) => this.gitView.handlePreviewCommand(ctx.rawInput),
					handleReview: (ctx) => this.handleReviewCommand(ctx),
					runGitCommand: async (cmd: string) => {
						const { execSync } = await import("node:child_process");
						return execSync(cmd, { encoding: "utf-8" });
					},
				},
				auth: {
					handleLogin: (ctx) =>
						this.oauthFlowController.handleLoginCommand(
							ctx.argumentText,
							(msg) => ctx.showError(msg),
						),
					handleLogout: (ctx) =>
						this.oauthFlowController.handleLogoutCommand(
							ctx.argumentText,
							(msg) => ctx.showError(msg),
							(msg) => ctx.showInfo(msg),
						),
					getAuthState: () => this.getActualAuthState(),
				},
				usage: {
					handleCost: (ctx) => this.costView.handleCostCommand(ctx),
					handleQuota: (ctx) => this.quotaView.handleQuotaCommand(ctx),
					handleStats: (ctx) => this.handleStatsCommand(ctx),
				},
				undo: {
					handleUndo: (ctx) => this.handleEnhancedUndoCommand(ctx),
					handleCheckpoint: (ctx) => this.handleCheckpointCommand(ctx),
					handleChanges: (ctx) => this.handleChangesCommand(ctx),
					getUndoState: () => ({
						canUndo: true,
						undoCount: 0,
						checkpoints: [],
					}),
				},
				config: {
					handleConfig: (ctx) => this.configView.handleConfigCommand(ctx),
					handleImport: (ctx) =>
						this.importExportView.handleImportCommand(ctx.rawInput),
					handleFramework: (ctx) => this.handleFrameworkCommand(ctx),
					handleComposer: (ctx) => this.handleComposerCommand(ctx),
					handleInit: (ctx) => this.handleInitCommand(ctx),
				},
				tools: {
					handleTools: (ctx) =>
						this.toolStatusView.handleToolsCommand(ctx.rawInput),
					handleMcp: (ctx) => this.handleMcpCommand(ctx),
					handleLsp: (ctx) => this.lspView.handleLspCommand(ctx.rawInput),
					handleWorkflow: (ctx) => this.handleWorkflowCommand(ctx),
					handleRun: (ctx) =>
						this.runCommandView.handleRunCommand(ctx.rawInput),
					handleCommands: (ctx) => this.handleCommandsCommand(ctx),
				},
			});
		}
		return this.groupedHandlers;
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
		// End session recovery tracking and create final backup
		this.sessionRecoveryManager.endSession();
		// Stop test verification service
		this.testVerificationService?.stop();
		this.footer.dispose();
		process.stdout.off("resize", this.resizeHandler);
	}

	/**
	 * Get the actual OAuth authentication state by checking stored credentials.
	 * Returns info about which provider the user is authenticated with.
	 */
	private getActualAuthState(): {
		authenticated: boolean;
		provider?: string;
		mode?: string;
	} {
		const providers = listOAuthProviders();

		if (providers.length === 0) {
			return { authenticated: false };
		}

		// Get the primary provider (prefer current model provider if authenticated)
		const currentProvider = this.agent.state.model?.provider;
		let activeProvider = providers[0];

		// If we're using a provider that has OAuth credentials, use that one
		if (currentProvider && providers.includes(currentProvider)) {
			activeProvider = currentProvider;
		}

		// Load credentials to get metadata (like mode)
		const credentials = loadOAuthCredentials(activeProvider);
		const mode = credentials?.metadata?.mode as string | undefined;

		return {
			authenticated: true,
			provider: activeProvider,
			mode,
		};
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
		// Update scroll viewport on resize
		this.updateScrollViewport();
	}

	/**
	 * Updates the scroll container's viewport height based on terminal size.
	 * Called on init and resize.
	 */
	private updateScrollViewport(): void {
		const rows = process.stdout.rows ?? 24;
		this.scrollContainer.setViewportHeight(rows);
	}

	/**
	 * Handles scroll keyboard shortcuts.
	 * @returns true if the input was handled as a scroll command
	 */
	handleScrollInput(data: string): boolean {
		return this.scrollContainer.handleInput(data);
	}

	/**
	 * Scrolls to the bottom of the chat and re-enables sticky scroll.
	 */
	scrollToBottom(): void {
		this.scrollContainer.scrollToBottom();
		this.ui.requestRender();
	}

	/**
	 * Scrolls up by one page.
	 */
	scrollPageUp(): void {
		this.scrollContainer.pageUp();
		this.ui.requestRender();
	}

	/**
	 * Scrolls down by one page.
	 */
	scrollPageDown(): void {
		this.scrollContainer.pageDown();
		this.ui.requestRender();
	}

	private async runConnectivityProbe(): Promise<void> {
		// Fast, no-network probe: ensure a model is selected and transport is configured.
		const state = this.agent.state;
		if (!state?.model) {
			throw new Error("No default model configured. Use /model to select one.");
		}
		// If transport exposes a light ping, use it without sending user content
		const transport = (
			this.agent as unknown as { transport?: { ping?: () => Promise<void> } }
		).transport;
		if (transport?.ping) {
			await transport.ping().catch((error: unknown) => {
				const message =
					error instanceof Error
						? error.message
						: "Model connectivity probe failed. Check API key and network.";
				throw new Error(message);
			});
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// GROUPED COMMAND HANDLERS
	// ═══════════════════════════════════════════════════════════════════════════

	private async handleGroupedSessionCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		await this.getGroupedHandlers().handleSession(context);
	}

	private async handleGroupedDiagCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		await this.getGroupedHandlers().handleDiag(context);
	}

	private async handleGroupedUiCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		await this.getGroupedHandlers().handleUi(context);
	}

	private async handleGroupedSafetyCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		await this.getGroupedHandlers().handleSafety(context);
	}

	private async handleGroupedGitCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		await this.getGroupedHandlers().handleGit(context);
	}

	private async handleGroupedAuthCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		await this.getGroupedHandlers().handleAuth(context);
	}

	private async handleGroupedUsageCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		await this.getGroupedHandlers().handleUsage(context);
	}

	private async handleGroupedUndoCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		await this.getGroupedHandlers().handleUndo(context);
	}

	private async handleGroupedConfigCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		await this.getGroupedHandlers().handleConfig(context);
	}

	private async handleGroupedToolsCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		await this.getGroupedHandlers().handleTools(context);
	}
}
