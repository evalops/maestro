import { spawn } from "node:child_process";
import type { SlashCommand } from "@evalops/tui";
import {
	type Component,
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
import type { AgentEvent, AgentState, AppMessage } from "../agent/types.js";
import { PATHS } from "../config/constants.js";
import type { CleanMode } from "../conversation/render-model.js";
import {
	getTypeScriptHookCommands,
	setGlobalUIContext,
} from "../hooks/index.js";
import type { HookCommandContext, HookUIContext } from "../hooks/types.js";
import type { RegisteredModel } from "../models/registry.js";
import { getRegisteredModels } from "../models/registry.js";
import { listOAuthProviders, loadOAuthCredentials } from "../oauth/storage.js";
import { getOpenTelemetryStatus } from "../opentelemetry.js";
import {
	type SessionModelMetadata,
	toSessionModelMetadata,
} from "../session/manager.js";
import type { SessionManager } from "../session/manager.js";
import { getTelemetryStatus } from "../telemetry.js";
import {
	type Theme,
	getCurrentThemeName,
	setTheme,
	theme,
} from "../theme/theme.js";
import { getTrainingStatus } from "../training.js";

import { AutoCompactionMonitor } from "../agent/auto-compaction.js";
import {
	type AutoRetryController,
	createAutoRetryController,
} from "../agent/auto-retry.js";
import { SessionRecoveryManager } from "../agent/session-recovery.js";
import {
	type AutoVerifyService,
	type TestResult,
	formatTestResult,
	registerTestVerificationHooks,
} from "../testing/index.js";
import { createLogger } from "../utils/logger.js";
import { AboutView } from "./about-view.js";
import type { AgentEventRouter } from "./agent-event-router.js";
import type { ApprovalController } from "./approval/approval-controller.js";
import type { BackgroundTasksController } from "./background/background-tasks-controller.js";
import { BashModeView } from "./bash-mode-view.js";
import { ChangelogView } from "./changelog-view.js";
import { formatCommandHelp } from "./commands/argument-parser.js";
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
import {
	handleApprovalsCommand,
	handlePlanModeCommand,
} from "./commands/safety-handlers.js";
import type {
	CommandEntry,
	CommandExecutionContext,
} from "./commands/types.js";
import { handleInitCommand } from "./commands/utility-handlers.js";
import { ConfigView } from "./config-view.js";
import { ContextView } from "./context-view.js";
import { CustomEditor } from "./custom-editor.js";
import { EditorView } from "./editor-view.js";
import { FeedbackView } from "./feedback-view.js";
import { FooterComponent } from "./footer.js";
import { GitView } from "./git/git-view.js";
import { HotkeysView } from "./hotkeys-view.js";
import { ImportExportView } from "./import-view.js";
import { InfoView } from "./info-view.js";
import { InstructionPanelComponent } from "./instruction-panel.js";
import type { InterruptController } from "./interrupt-controller.js";
import type { LoaderView } from "./loader/loader-view.js";
import { LspView } from "./lsp-view.js";
import type { MessageView } from "./message-view.js";
import { NotificationView } from "./notification-view.js";
import type { OAuthFlowController } from "./oauth/index.js";
import { OllamaView } from "./ollama-view.js";
import type { PlanView } from "./plan-view.js";
import type { PlanController } from "./plan/plan-controller.js";
import type { PromptQueue } from "./prompt-queue.js";
import {
	type QueueController,
	type QueueMode,
	QueuePanelController,
} from "./queue/index.js";
import { RunCommandView } from "./run/run-command-view.js";
import { RunController } from "./run/run-controller.js";
import type { FileSearchView } from "./search/file-search-view.js";
import { BaseSelectorComponent } from "./selectors/base-selector.js";
import { ModelSelectorView } from "./selectors/model-selector-view.js";
import { QueueModeSelectorView } from "./selectors/queue-mode-selector-view.js";
import { ReportSelectorView } from "./selectors/report-selector-view.js";
import { ThemeSelectorView } from "./selectors/theme-selector-view.js";
import { ThinkingSelectorView } from "./selectors/thinking-selector-view.js";
import { TreeSelectorView } from "./selectors/tree-selector-view.js";
import { UserMessageSelectorView } from "./selectors/user-message-selector-view.js";
import { ConversationCompactor } from "./session/conversation-compactor.js";
import { SessionContext } from "./session/session-context.js";
import type { SessionDataProvider } from "./session/session-data-provider.js";
import type { SessionSummaryController } from "./session/session-summary-controller.js";
import type { SessionSwitcherView } from "./session/session-switcher-view.js";
import type { SessionView } from "./session/session-view.js";
import { SlashCommandMatcher, SlashCycleState } from "./slash/index.js";
import { renderStartupAnnouncements } from "./startup-announcements.js";
import { CostView } from "./status/cost-view.js";
import type { DiagnosticsView } from "./status/diagnostics-view.js";
import { QuotaView } from "./status/quota-view.js";
import { TelemetryView } from "./status/telemetry-view.js";
import { TrainingView } from "./status/training-view.js";
import type { StreamingView } from "./streaming-view.js";
import type { ToolExecutionComponent } from "./tool-execution.js";
import type { ToolOutputView } from "./tool-output-view.js";
import { ToolStatusView } from "./tool-status-view.js";
import {
	type AgentEventBridge,
	createAgentEventBridge,
} from "./tui-renderer/agent-event-bridge.js";
import { buildTuiCommandRegistryOptions } from "./tui-renderer/command-registry-options.js";
import { buildTuiCommandRegistry } from "./tui-renderer/command-registry.js";
import {
	type UiState,
	loadCommandPrefs,
	loadUiState,
	saveCommandPrefs,
	saveUiState,
} from "./ui-state.js";
import { UpdateView } from "./update-view.js";
import type { CommandPaletteView } from "./utils/commands/command-palette-view.js";
import { buildReviewPrompt } from "./utils/commands/review-prompt.js";
import { SlashHintBar } from "./utils/commands/slash-hint-bar.js";
import { openExternalEditor } from "./utils/external-editor.js";
import {
	type FooterHint,
	type FooterMode,
	type FooterStats,
	calculateFooterStats,
	formatTokenCount,
} from "./utils/footer-utils.js";
import { WelcomeAnimation } from "./welcome-animation.js";

import { areAnimationsDisabled } from "../config/env-vars.js";
import { validateFrameworkPreference } from "../config/framework.js";
import type { UpdateCheckResult } from "../update/check.js";
import { resolveEnvPath } from "../utils/path-expansion.js";
import { handleFrameworkCommand as frameworkHandler } from "./commands/framework-handlers.js";
import { handleGuardianCommand as guardianHandler } from "./commands/guardian-handlers.js";
import { handleOtelCommand as otelHandler } from "./commands/otel-handlers.js";
import { HookInputModal } from "./hooks/hook-input-modal.js";
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
import { createApprovalController } from "./tui-renderer/approval-setup.js";
import { createBackgroundTasksController } from "./tui-renderer/background-tasks-setup.js";
import {
	type BranchController,
	createBranchController,
} from "./tui-renderer/branch-controller.js";
import {
	type ClearController,
	createClearController,
} from "./tui-renderer/clear-controller.js";
import {
	type CompactionController,
	createCompactionController,
} from "./tui-renderer/compaction-controller.js";
import {
	type CustomCommandsController,
	createCustomCommandsController,
} from "./tui-renderer/custom-commands-controller.js";
import { attachEditorBindings } from "./tui-renderer/editor-bindings.js";
import { loadInitialTuiRendererPreferences } from "./tui-renderer/initial-preferences.js";
import {
	type InputController,
	createInputController,
} from "./tui-renderer/input-controller.js";
import { createInterruptController } from "./tui-renderer/interrupt-setup.js";
import { createLoaderView } from "./tui-renderer/loader-setup.js";
import {
	type McpEventsController,
	createMcpEventsController,
} from "./tui-renderer/mcp-events-setup.js";
import { createOAuthFlowController } from "./tui-renderer/oauth-setup.js";
import { createPlanSubsystem } from "./tui-renderer/plan-setup.js";
import { createQueueController } from "./tui-renderer/queue-setup.js";
import {
	type QuickSettingsController,
	createQuickSettingsController,
} from "./tui-renderer/quick-settings-controller.js";
import { createSessionSubsystem } from "./tui-renderer/session-setup.js";
import {
	type SessionStateController,
	createSessionStateController,
} from "./tui-renderer/session-state-controller.js";
import {
	type SlashHintController,
	createSlashHintController,
} from "./tui-renderer/slash-hint-controller.js";
import { createToolingViews } from "./tui-renderer/tooling-views-setup.js";
import {
	type UiStateController,
	createUiStateController,
} from "./tui-renderer/ui-state-setup.js";
import { createUtilityViews } from "./tui-renderer/utility-views-setup.js";
import {
	type ViewportController,
	createViewportController,
} from "./tui-renderer/viewport-controller.js";
import { buildRuntimeBadges } from "./utils/runtime-badges.js";

const logger = createLogger("tui:renderer");

const getTodoStorePath = () =>
	resolveEnvPath(process.env.COMPOSER_TODO_FILE) ?? PATHS.TODO_STORE;

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
	private loaderView: LoaderView;
	private inputController!: InputController;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private explicitApiKey?: string;
	private telemetryStatus = getTelemetryStatus();
	private trainingStatus = getTrainingStatus();
	private currentModelMetadata?: SessionModelMetadata;

	// Track if this is the first user message (to skip spacer)
	// Welcome animation shown before first interaction
	private welcomeAnimation: WelcomeAnimation | null = null;

	private readonly idleFooterHint =
		"Try /help for commands or /tools for status";
	private readonly workingFooterHint = "Working… press esc to interrupt";
	private autoCompactionMonitor: AutoCompactionMonitor;
	private autoRetryController: AutoRetryController;
	private sessionRecoveryManager: SessionRecoveryManager;
	private testVerificationService: AutoVerifyService | null = null;
	private planHint: string | null = null;
	private hookStatusByKey = new Map<string, string>();
	private hookUiContext?: HookUIContext;
	private toolOutputView: ToolOutputView;
	private commandPaletteView: CommandPaletteView;
	private slashCommands: SlashCommand[] = [];
	private commandEntries: CommandEntry[] = [];
	private recentCommands: string[] = [];
	private favoriteCommands = new Set<string>();
	private slashHintBar!: SlashHintBar;
	private slashCommandMatcher!: SlashCommandMatcher;
	private slashCycleState = new SlashCycleState();
	private planView: PlanView;
	private planController?: PlanController;
	private sessionView: SessionView;
	private sessionDataProvider: SessionDataProvider;
	private sessionSummaryController!: SessionSummaryController;
	private sessionSwitcherView!: SessionSwitcherView;
	private sessionStateController!: SessionStateController;
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
	private hotkeysView: HotkeysView;
	private trainingView: TrainingView;
	private contextView?: ContextView;
	private infoView: InfoView;
	private streamingView: StreamingView;
	private thinkingSelectorView: ThinkingSelectorView;
	private themeSelectorView: ThemeSelectorView;
	private modelSelectorView: ModelSelectorView;
	private reportSelectorView: ReportSelectorView;
	private treeSelectorView: TreeSelectorView;
	private oauthFlowController!: OAuthFlowController;
	private queueModeSelectorView: QueueModeSelectorView;
	private userMessageSelectorView: UserMessageSelectorView;
	private notificationView: NotificationView;
	private backgroundTasksController: BackgroundTasksController;
	private mcpEventsController: McpEventsController;
	private resizeHandler: () => void;
	private updateView: UpdateView;
	private configView: ConfigView;
	private costView: CostView;
	private quotaView: QuotaView;
	private runController: RunController;
	private agentEventBridge!: AgentEventBridge;
	private readonly focusEditor = (): void => {
		this.ui.setFocus(this.editor);
	};
	private agentEventRouter!: AgentEventRouter;
	private sessionContext = new SessionContext();
	private queueController: QueueController;
	private queuePanelController?: QueuePanelController;
	// Default to soft deduplication so repeated streamed lines don't appear in the TUI.
	// Users can still override via /clean or env/UI state.
	private cleanMode: CleanMode = "soft";
	private uiState: UiState = {};
	private footerMode: FooterMode = "ensemble";
	private reducedMotion = false;
	private reducedMotionForced = false;
	private zenMode = false;
	private hideThinkingBlocks = false;
	private readonly minimalMode = checkMinimalMode();
	private isAgentRunning = false;
	private approvalController?: ApprovalController;
	private approvalService: ActionApprovalService;
	private contextWarningLevel: "none" | "warn" | "danger" = "none";
	private modelScope: RegisteredModel[] = [];
	private startupChangelog?: string | null;
	private startupChangelogSummary?: string | null;
	private updateNotice?: UpdateCheckResult | null;
	private startupWarnings: FooterHint[] = [];
	private modalManager: ModalManager;
	private viewportController!: ViewportController;
	private terminalCapabilities: TerminalCapabilities =
		getTerminalCapabilities();
	private terminalFeatures = detectTerminalFeatures();
	private lowBandwidthConfig: LowBandwidthConfig = getLowBandwidthConfig();
	private interruptController!: InterruptController;
	private pasteHandler!: PasteHandler;
	private groupedHandlers?: GroupedCommandHandlers;
	private uiStateController!: UiStateController;
	private quickSettingsController!: QuickSettingsController;
	private branchController!: BranchController;
	private clearController!: ClearController;
	private compactionController!: CompactionController;
	private slashHintController!: SlashHintController;
	private customCommandsController!: CustomCommandsController;

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
			retryConfig?: import("../config/toml-config.js").RetryConfig;
		} = {},
	) {
		const initialPrefs = loadInitialTuiRendererPreferences();
		this.uiState = initialPrefs.uiState;
		const initialQueueMode: QueueMode = initialPrefs.initialQueueMode;
		if (initialPrefs.cleanMode) {
			this.cleanMode = initialPrefs.cleanMode;
		}
		if (initialPrefs.footerMode) {
			this.footerMode = initialPrefs.footerMode;
		}
		this.reducedMotion = initialPrefs.reducedMotion ?? false;
		this.reducedMotionForced = initialPrefs.reducedMotionForced;
		if (typeof initialPrefs.zenMode === "boolean") {
			this.zenMode = initialPrefs.zenMode;
		}
		if (typeof initialPrefs.hideThinkingBlocks === "boolean") {
			this.hideThinkingBlocks = initialPrefs.hideThinkingBlocks;
		}

		// Initialize UI state controller with loaded preferences
		this.uiStateController = createUiStateController({
			initialCleanMode: this.cleanMode,
			initialFooterMode: this.footerMode,
			initialZenMode: this.zenMode,
			initialHideThinkingBlocks: this.hideThinkingBlocks,
			callbacks: {
				onZenModeChange: (enabled) => {
					this.zenMode = enabled;
					if (enabled) {
						this.headerContainer?.clear();
						this.footer?.setMode("solo");
						if (this.welcomeAnimation) {
							this.dismissWelcomeAnimation();
						}
					} else {
						this.renderHeader();
						// Restore footer mode from state if zen owned it
						const currentFooterMode = this.footer?.getMode();
						if (currentFooterMode === "solo") {
							this.footer?.setMode(this.footerMode);
						}
					}
					this.viewportController.markHeaderDirty();
					this.viewportController.markFooterDirty();
					this.updateScrollViewport();
				},
				onFooterModeChange: (mode) => {
					this.footerMode = mode;
					this.footer?.setMode(mode);
					if (!this.isAgentRunning) {
						this.refreshFooterHint();
					}
					this.viewportController.markFooterDirty();
					this.updateScrollViewport();
				},
				onHideThinkingBlocksChange: (hidden) => {
					this.hideThinkingBlocks = hidden;
				},
				requestRender: () => {
					this.ui?.requestRender();
				},
			},
		});

		this.recentCommands = initialPrefs.recentCommands;
		this.favoriteCommands = initialPrefs.favoriteCommands;
		this.agent = agent;
		this.agent.setQueueMode(initialQueueMode === "all" ? "all" : "one");
		this.sessionManager = sessionManager;
		this.version = version;
		this.explicitApiKey = explicitApiKey;
		this.modelScope = options.modelScope ?? [];
		this.autoCompactionMonitor = new AutoCompactionMonitor({
			onCompactionRecommended: (stats) => {
				this.compactionController?.handleAutoCompactionRecommendation(stats);
			},
		});
		this.autoRetryController = createAutoRetryController();
		this.autoRetryController.setEventListener((event) => {
			this.handleAutoRetryEvent(event);
		});
		// Load retry config if available
		if (options.retryConfig) {
			this.autoRetryController.loadFromRetryConfig(options.retryConfig);
		}
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
		this.startupChangelog = options.startupChangelog;
		this.startupChangelogSummary = options.startupChangelogSummary;
		this.updateNotice = options.updateNotice;
		this.ui = new TUI(new ProcessTerminal(), this.terminalFeatures);
		this.configureRenderThrottle();
		this.startupContainer = new Container();
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		// Wrap chatContainer in ScrollContainer for viewport scrolling
		this.scrollContainer = new ScrollContainer(this.chatContainer, {
			stickyScroll: true,
			showIndicator: true,
			// We dynamically compute viewport height based on non-chat components.
			reservedLines: 0,
			onScroll: () => this.ui.requestRender(),
		});
		this.statusContainer = new Container();
		this.editor = new CustomEditor();
		attachEditorBindings({
			editor: this.editor,
			scrollContainer: this.scrollContainer,
			ui: this.ui,
			handlers: {
				handleLargePaste: (event) => this.pasteHandler.handleLargePaste(event),
				handleTyping: () => this.handleEditorTyping(),
				cycleModel: () => this.quickSettingsController.cycleModel(),
				toggleToolOutputs: () =>
					this.quickSettingsController.toggleToolOutputs(),
				toggleThinkingBlocks: () =>
					this.quickSettingsController.toggleThinkingBlocks(),
				openExternalEditor: () => this.handleExternalEditor(),
				suspend: () => this.handleCtrlZ(),
				handleSlashCycle: (reverse) =>
					this.slashHintController?.handleSlashCycle(reverse) ?? false,
				cycleThinkingLevel: () =>
					this.quickSettingsController.cycleThinkingLevel(),
			},
		});
		this.editorContainer = new Container(); // Container to hold editor or selector
		this.slashHintBar = new SlashHintBar();
		this.editorContainer.addChild(this.slashHintBar);
		this.editorContainer.addChild(this.editor); // Start with editor
		this.modalManager = new ModalManager(
			this.editorContainer,
			this.ui,
			this.editor,
			{
				onLayoutChange: () => {
					this.viewportController.markEditorDirty();
					this.updateScrollViewport();
				},
			},
		);
		this.footer = new FooterComponent(agent.state, this.footerMode);
		this.footer.startBranchTracking(() => this.ui.requestRender());
		this.viewportController = createViewportController({
			deps: {
				headerContainer: this.headerContainer,
				startupContainer: this.startupContainer,
				statusContainer: this.statusContainer,
				editorContainer: this.editorContainer,
				footer: this.footer,
				scrollContainer: this.scrollContainer,
				getColumns: () => process.stdout.columns ?? 80,
				getRows: () => process.stdout.rows ?? 24,
			},
		});
		this.notificationView = new NotificationView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			footer: this.footer,
		});
		this.hookUiContext = this.createHookUiContext();
		setGlobalUIContext(this.hookUiContext, true);

		// Now that all core layout containers exist, compute the initial viewport
		// sizing and wire resize handling.
		this.refreshTerminalCapabilities();
		this.resizeHandler = () => this.refreshTerminalCapabilities();
		process.stdout.on("resize", this.resizeHandler);

		this.queueController = createQueueController({
			agent: this.agent,
			notificationView: this.notificationView,
			editor: this.editor,
			initialMode: initialQueueMode,
			refreshQueuePanel: () => this.queuePanelController?.refreshPanel(),
			isAgentRunning: () => this.isAgentRunning,
			refreshFooterHint: () => this.refreshFooterHint(),
			requestRender: () => this.ui.requestRender(),
			persistUiState: (state) => this.persistUiState(state),
		});

		this.oauthFlowController = createOAuthFlowController({
			modalManager: this.modalManager,
			notificationView: this.notificationView,
			chatContainer: this.chatContainer,
			ui: this.ui,
			editor: this.editor,
			clearEditor: () => this.clearEditor(),
		});

		this.inputController = createInputController({
			deps: {
				editor: this.editor,
				getPasteHandler: () => this.pasteHandler,
				getBashModeView: () => this.bashModeView,
				getInterruptController: () => this.interruptController,
				autoRetryController: this.autoRetryController,
			},
			callbacks: {
				showInfo: (message) => this.notificationView.showInfo(message),
				stopRenderer: () => this.stop(),
				exitProcess: (code) => process.exit(code ?? 0),
			},
		});

		this.interruptController = createInterruptController({
			footer: this.footer,
			notificationView: this.notificationView,
			onInterrupt: (options) => this.inputController.notifyInterrupt(options),
			restoreQueuedPrompts: () => this.queueController.restoreQueuedPrompts(),
			getWorkingHint: () => this.workingFooterHint,
			isMinimalMode: () => this.isMinimalMode(),
			isAgentRunning: () => this.isAgentRunning,
			refreshFooterHint: () => this.refreshFooterHint(),
		});

		this.backgroundTasksController = createBackgroundTasksController({
			chatContainer: this.chatContainer,
			ui: this.ui,
			notificationView: this.notificationView,
		});

		this.surfaceStartupWarnings();
		this.approvalController = createApprovalController({
			approvalService,
			ui: this.ui,
			editor: this.editor,
			editorContainer: this.editorContainer,
			notificationView: this.notificationView,
		});
		this.approvalService = approvalService;
		this.loaderView = createLoaderView({
			ui: this.ui,
			statusContainer: this.statusContainer,
			footer: this.footer,
			lowColor: this.terminalFeatures.lowColor,
			lowUnicode: this.terminalFeatures.lowUnicode,
			disableAnimations: this.shouldDisableAnimations(),
			onLayoutChange: () => {
				this.viewportController.markStatusDirty();
				this.updateScrollViewport();
			},
		});
		const planSubsystem = createPlanSubsystem({
			filePath: getTodoStorePath(),
			chatContainer: this.chatContainer,
			ui: this.ui,
			modalManager: this.modalManager,
			notificationView: this.notificationView,
			setPlanHint: (hint) => {
				this.planHint = hint;
				this.refreshFooterHint();
			},
			onStoreChanged: (store) => this.planController?.handleStoreChanged(store),
		});
		this.planView = planSubsystem.planView;
		this.planController = planSubsystem.planController;
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
				this.editor.disableSubmit =
					disabled && !this.queueController.isEnabled();
			},
			focusEditor: () => this.focusEditor(),
			clearEditor: () => this.clearEditor(),
			stopRenderer: () => this.stop(),
			refreshFooterHint: () => this.refreshFooterHint(),
			notifyFileChanges: () => this.gitView.notifyFileChanges(),
			inMinimalMode: () => this.isMinimalMode(),
		});
		this.ui.setInterruptHandler(() => this.handleCtrlC());
		this.toolStatusView = new ToolStatusView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			getTools: () => this.agent.state.tools,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		const sessionSubsystem = createSessionSubsystem({
			agent: this.agent,
			sessionManager: this.sessionManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
			modalManager: this.modalManager,
			notificationView: this.notificationView,
			sessionContext: this.sessionContext,
			applyLoadedSessionContext: () => this.applyLoadedSessionContext(),
			onSessionLoaded: (sessionInfo) => {
				this.toolOutputView.clearTrackedComponents();
				this.renderInitialMessages(this.agent.state);
				this.footer.updateState(this.agent.state);
				this.notificationView.showInfo(
					`Loaded session ${sessionInfo.id} (${sessionInfo.messageCount} messages).`,
				);
			},
		});
		this.sessionDataProvider = sessionSubsystem.sessionDataProvider;
		this.sessionSummaryController = sessionSubsystem.sessionSummaryController;
		this.sessionView = sessionSubsystem.sessionView;
		this.sessionSwitcherView = sessionSubsystem.sessionSwitcherView;

		// Initialize paste handler
		this.pasteHandler = new PasteHandler({
			agent: this.agent,
			notificationView: this.notificationView,
			sessionContext: this.sessionContext,
			editor: this.editor,
			refreshFooterHint: () => this.refreshFooterHint(),
		});

		const utilityViews = createUtilityViews({
			agent: this.agent,
			sessionManager: this.sessionManager,
			telemetryStatus: this.telemetryStatus,
			trainingStatus: this.trainingStatus,
			version: this.version,
			explicitApiKey: this.explicitApiKey,
			chatContainer: this.chatContainer,
			ui: this.ui,
			editor: this.editor,
			modalManager: this.modalManager,
			getCurrentModelMetadata: () => this.currentModelMetadata,
			getPendingTools: () => this.pendingTools,
			toolStatusView: this.toolStatusView,
			gitView: this.gitView,
			todoStorePath: getTodoStorePath(),
			getApprovalMode: () => this.approvalService.getMode(),
			getAlertCount: () => this.footer.getUnseenAlertCount(),
			showInfoMessage: (message) => this.notificationView.showInfo(message),
			getCommands: () => this.slashCommands,
			getRecentCommands: () =>
				this.slashHintController?.getRecentCommands() ?? this.recentCommands,
			getFavoriteCommands: () =>
				this.slashHintController?.getFavoriteCommands() ??
				this.favoriteCommands,
			onToggleFavorite: (name) =>
				this.slashHintController?.toggleFavoriteCommand(name),
		});
		this.diagnosticsView = utilityViews.diagnosticsView;
		this.fileSearchView = utilityViews.fileSearchView;
		this.commandPaletteView = utilityViews.commandPaletteView;
		const toolingViews = createToolingViews({
			chatContainer: this.chatContainer,
			ui: this.ui,
			uiStateCompactTools: this.uiState.compactTools,
			pendingTools: this.pendingTools,
			lowBandwidth: this.lowBandwidthConfig,
			disableAnimations: this.shouldDisableAnimations(),
			getCleanMode: () => this.cleanMode,
			getHideThinkingBlocks: () => this.hideThinkingBlocks,
			loaderView: this.loaderView,
			runController: this.runController,
			sessionContext: this.sessionContext,
			extractText: (message) => this.extractTextFromAppMessage(message),
			clearEditor: () => this.clearEditor(),
			requestRender: () => this.ui.requestRender(),
			clearPendingTools: () => this.pendingTools.clear(),
			refreshPlanHint: () => this.planView.syncHintWithStore(),
			onAssistantMessageEnd: (message) =>
				this.autoRetryController.trackAssistantMessage(message),
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		this.toolOutputView = toolingViews.toolOutputView;
		this.messageView = toolingViews.messageView;
		this.streamingView = toolingViews.streamingView;
		this.agentEventRouter = toolingViews.agentEventRouter;
		this.sessionStateController = createSessionStateController({
			deps: {
				agent: this.agent,
				sessionManager: this.sessionManager,
				sessionContext: this.sessionContext,
				sessionRecoveryManager: this.sessionRecoveryManager,
				editor: this.editor,
				messageView: this.messageView,
				toolOutputView: this.toolOutputView,
				chatContainer: this.chatContainer,
				scrollContainer: this.scrollContainer,
				startupContainer: this.startupContainer,
				planView: this.planView,
				footer: this.footer,
				notificationView: this.notificationView,
			},
			callbacks: {
				refreshFooterHint: () => this.refreshFooterHint(),
				requestRender: () => this.ui.requestRender(),
				clearEditor: () => this.clearEditor(),
				setPlanHint: (hint) => {
					this.planHint = hint;
				},
				isAgentRunning: () => this.isAgentRunning,
			},
		});

		this.agentEventBridge = createAgentEventBridge({
			deps: {
				agent: this.agent,
				sessionManager: this.sessionManager,
				sessionRecoveryManager: this.sessionRecoveryManager,
				autoRetryController: this.autoRetryController,
				interruptController: this.interruptController,
				footer: this.footer,
				agentEventRouter: this.agentEventRouter,
			},
			callbacks: {
				ensureInitialized: () => this.init(),
				handleApprovalRequired: (request) =>
					this.handleApprovalRequired(request),
				handleApprovalResolved: (request, decision) =>
					this.handleApprovalResolved(request, decision),
				setAgentRunning: (running) => {
					this.isAgentRunning = running;
				},
				maybeShowContextWarning: (stats) => this.maybeShowContextWarning(stats),
				setCurrentModelMetadata: (metadata) => {
					this.currentModelMetadata = metadata;
				},
			},
		});

		// Initialize quick settings controller for keyboard shortcuts
		this.quickSettingsController = createQuickSettingsController({
			agent: this.agent,
			sessionManager: this.sessionManager,
			notificationView: this.notificationView,
			modelScope: this.modelScope,
			callbacks: {
				refreshFooterHint: () => this.refreshFooterHint(),
				persistUiState: () => this.persistUiState(),
				renderConversationView: () => this.renderConversationView(),
				requestRender: () => this.ui.requestRender(),
				getToolOutputCompact: () => this.toolOutputView.isCompact(),
				toggleToolOutputCompact: () => this.toolOutputView.toggleCompactMode(),
				getHideThinkingBlocks: () => this.hideThinkingBlocks,
				setHideThinkingBlocks: (hidden) => {
					this.hideThinkingBlocks = hidden;
				},
			},
		});

		// Initialize branch controller for session branching
		this.branchController = createBranchController({
			callbacks: {
				isAgentRunning: () => this.isAgentRunning,
				getMessages: () => this.agent.state.messages ?? [],
				showSelector: () => this.userMessageSelectorView.show(),
				createBranchedSession: (count) =>
					this.sessionManager.createBranchedSession(this.agent.state, count),
				setSessionFile: (path) => this.sessionManager.setSessionFile(path),
				resetConversation: (messages, seed, notification) =>
					this.resetConversation(messages, seed, notification, {
						preserveSession: true,
					}),
				addContent: (text) => {
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(text, 1, 0));
				},
				requestRender: () => this.ui.requestRender(),
			},
		});

		// Initialize clear controller for session clearing
		this.clearController = createClearController({
			callbacks: {
				abortAndWait: async () => {
					this.agent.abort();
					await this.agent.waitForIdle();
				},
				setAgentRunning: (running) => {
					this.isAgentRunning = running;
				},
				cancelQueuedPrompts: () =>
					this.queueController.cancelAll({ silent: true }),
				stopLoader: () => this.loaderView.stop(),
				clearStatusContainer: () => this.statusContainer.clear(),
				resetAgent: () => this.agent.reset(),
				resetSession: () => this.sessionManager.reset(),
				resetArtifacts: () => this.sessionContext.resetArtifacts(),
				clearToolTracking: () => this.toolOutputView.clearTrackedComponents(),
				clearChatContainer: () => this.chatContainer.clear(),
				clearScrollHistory: () => this.scrollContainer.clearHistory(),
				clearStartupContainer: () => this.startupContainer.clear(),
				syncPlanHint: () => this.planView.syncHintWithStore(),
				setPlanHint: (hint) => {
					this.planHint = hint;
				},
				clearEditor: () => this.editor.setText(""),
				clearPendingTools: () => this.pendingTools.clear(),
				clearInterruptState: () => this.interruptController.clear(),
				renderInitialMessages: (state) => this.renderInitialMessages(state),
				getAgentState: () => this.agent.state,
				updateFooterState: (state) => this.footer.updateState(state),
				refreshFooterHint: () => this.refreshFooterHint(),
				showSuccess: (msg) => this.notificationView.showToast(msg, "success"),
				showError: (msg) => {
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(msg, 1, 1));
				},
				requestRender: () => this.ui.requestRender(),
			},
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
		this.hotkeysView = new HotkeysView({
			chatContainer: this.chatContainer,
			ui: this.ui,
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
			modelScope: this.modelScope,
		});
		this.queueModeSelectorView = new QueueModeSelectorView({
			ui: this.ui,
			modalManager: this.modalManager,
			notificationView: this.notificationView,
			onModeSelected: (mode) => this.queueController.setMode(mode),
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
				this.scrollContainer.clearHistory();
				this.startupContainer.clear();
				this.planView.syncHintWithStore();
				this.planHint = null;
				this.footer.updateState(this.agent.state);
				this.refreshFooterHint();
				this.renderInitialMessages(this.agent.state);
				this.ui.requestRender();
			},
		});
		this.treeSelectorView = new TreeSelectorView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			editor: this.editor,
			modalManager: this.modalManager,
			ui: this.ui,
			notificationView: this.notificationView,
			onNavigated: () => {
				this.sessionContext.resetArtifacts();
				this.toolOutputView.clearTrackedComponents();
				this.chatContainer.clear();
				this.scrollContainer.clearHistory();
				this.startupContainer.clear();
				this.planView.syncHintWithStore();
				this.planHint = null;
				this.footer.updateState(this.agent.state);
				this.refreshFooterHint();
				this.renderInitialMessages(this.agent.state);
				this.ui.requestRender();
			},
		});
		this.queuePanelController = new QueuePanelController({
			queueController: this.queueController,
			modalManager: this.modalManager,
			ui: this.ui,
			notificationView: this.notificationView,
			queueModeSelectorView: this.queueModeSelectorView,
			chatContainer: this.chatContainer,
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
		this.compactionController = createCompactionController({
			deps: {
				getAgentState: () => this.agent.state,
				getSessionId: () => this.sessionManager.getSessionId(),
				conversationCompactor: this.conversationCompactor,
				autoCompactionMonitor: this.autoCompactionMonitor,
				sessionContext: this.sessionContext,
			},
			callbacks: {
				showInfo: (msg) => this.notificationView.showInfo(msg),
				refreshFooterHint: () => this.refreshFooterHint(),
				setContextWarningLevel: (level) => {
					this.contextWarningLevel = level;
				},
			},
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
		this.customCommandsController = createCustomCommandsController({
			cwd: process.cwd(),
			callbacks: {
				addContent: (text) => {
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(text, 1, 0));
				},
				setEditorText: (text) => this.editor.setText(text),
				showToast: (msg, type) => this.notificationView.showToast(msg, type),
				requestRender: () => this.ui.requestRender(),
			},
		});

		const registry = buildTuiCommandRegistry({
			cwd: process.cwd(),
			registryOptions: buildTuiCommandRegistryOptions({
				runCommandView: this.runCommandView,
				importExportView: this.importExportView,
				toolStatusView: this.toolStatusView,
				sessionView: this.sessionView,
				reportSelectorView: this.reportSelectorView,
				feedbackView: this.feedbackView,
				aboutView: this.aboutView,
				clearController: this.clearController,
				diagnosticsView: this.diagnosticsView,
				fileSearchView: this.fileSearchView,
				infoView: this.infoView,
				updateView: this.updateView,
				changelogView: this.changelogView,
				hotkeysView: this.hotkeysView,
				configView: this.configView,
				costView: this.costView,
				quotaView: this.quotaView,
				telemetryView: this.telemetryView,
				trainingView: this.trainingView,
				planController: this.planController,
				gitView: this.gitView,
				ollamaView: this.ollamaView,
				backgroundTasksController: this.backgroundTasksController,
				compactionController: this.compactionController,
				customCommandsController: this.customCommandsController,
				queuePanelController: this.queuePanelController,
				branchController: this.branchController,
				oauthFlowController: this.oauthFlowController,
				approvalService: this.approvalService,
				notificationView: this.notificationView,
				chatContainer: this.chatContainer,
				ui: this.ui,
				thinkingSelectorView: this.thinkingSelectorView,
				modelSelectorView: this.modelSelectorView,
				themeSelectorView: this.themeSelectorView,
				uiStateController: this.uiStateController,
				lspView: this.lspView,
				getMessages: () => this.agent.state.messages,
				createCommandContext: (ctx) => this.createCommandContext(ctx),
				handleReviewCommand: (context) => this.handleReviewCommand(context),
				handleEnhancedUndoCommand: (context) =>
					this.handleEnhancedUndoCommand(context),
				handleFooterCommand: (context) => this.handleFooterCommand(context),
				handleCompactToolsCommand: (rawInput) =>
					this.handleCompactToolsCommand(rawInput),
				handleSteerCommand: (context) => this.handleSteerCommand(context),
				handleStatsCommand: (context) => this.handleStatsCommand(context),
				handleNewChatCommand: (context) => this.handleNewChatCommand(context),
				handleTreeCommand: (_context) => this.treeSelectorView.show(),
				handleMcpCommand: (context) => this.handleMcpCommand(context),
				handleComposerCommand: (context) => this.handleComposerCommand(context),
				handleContextCommand: (context) => this.handleContextCommand(context),
				handleFrameworkCommand: (context) =>
					this.handleFrameworkCommand(context),
				handleGuardianCommand: (context) => this.handleGuardianCommand(context),
				handleWorkflowCommand: (context) => this.handleWorkflowCommand(context),
				handleChangesCommand: (context) => this.handleChangesCommand(context),
				handleCheckpointCommand: (context) =>
					this.handleCheckpointCommand(context),
				handleMemoryCommand: (context) => this.handleMemoryCommand(context),
				handleModeCommand: (context) => this.handleModeCommand(context),
				getGroupedHandlers: () => this.getGroupedHandlers(),
				refreshFooterHint: () => this.refreshFooterHint(),
				onQuit: () => {
					this.stop();
					process.exit(0);
				},
			}),
			executePromptTemplate: (promptName, userArgumentText, context) => {
				const combined = [promptName, userArgumentText]
					.filter(Boolean)
					.join(" ");
				const syntheticContext: CommandExecutionContext = {
					...context,
					argumentText: combined,
				};
				this.customCommandsController.handlePromptsCommand(syntheticContext);
			},
			logDebug: (message, meta) => logger.debug(message, meta),
		});
		const hookRegistry = this.buildHookCommandEntries(registry.commands);
		if (hookRegistry.commands.length > 0) {
			registry.entries.push(...hookRegistry.entries);
			registry.commands.push(...hookRegistry.commands);
		}

		this.commandEntries = registry.entries;
		this.slashCommands = registry.commands;
		this.slashCommandMatcher = new SlashCommandMatcher(this.slashCommands);
		this.slashHintController = createSlashHintController({
			deps: {
				slashHintBar: this.slashHintBar,
				slashCommandMatcher: this.slashCommandMatcher,
				slashCycleState: this.slashCycleState,
				getSlashCommands: () => this.slashCommands,
				getEditorText: () => this.editor.getText(),
				setEditorText: (text) => this.editor.setText(text),
				isShowingAutocomplete: () => this.editor.isShowingAutocomplete(),
			},
			callbacks: {
				persistUiState: (extra) => this.persistUiState(extra),
				requestRender: () => {
					// Slash hint updates can change editorContainer height (0 ↔ 1–2 lines).
					// Keep the scroll viewport sized so we never spill into scrollback.
					this.viewportController.markEditorDirty();
					this.updateScrollViewport({ fast: true });
					this.ui.requestRender();
				},
			},
			initialRecentCommands: this.recentCommands,
			initialFavoriteCommands: this.favoriteCommands,
		});

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

		// Keep the chat viewport within the terminal viewport. We recompute on
		// editor changes (including paste/history/backspace) so wrapping changes
		// don't push the UI into scrollback for a frame.
		const previousOnChange = this.editor.onChange;
		this.editor.onChange = (text) => {
			previousOnChange?.(text);
			this.viewportController.markEditorDirty();
			this.updateScrollViewport({ fast: true });
		};

		new EditorView({
			editor: this.editor,
			getCommandEntries: () => this.commandEntries,
			onFirstInput: () => this.dismissWelcomeAnimation(),
			onCommandExecuted: (name) =>
				this.slashHintController.recordCommandUsage(name),
			onSubmit: (text) => {
				void this.inputController.handleTextSubmit(text);
			},
			shouldInterrupt: () =>
				this.isAgentRunning || this.interruptController.isArmed(),
			onInterrupt: () => this.inputController.handleInterruptRequest(),
			onKeepPartial: () => this.inputController.handleKeepPartialRequest(),
			onCtrlC: () => this.handleCtrlC(),
			onCtrlD: () => this.inputController.handleCtrlDExit(),
			showCommandPalette: () => this.commandPaletteView.showCommandPalette(),
			showFileSearch: () => this.fileSearchView.showFileSearch(),
		});

		// Set up MCP and Composer event handlers for notifications
		this.mcpEventsController = createMcpEventsController({
			notificationView: this.notificationView,
			refreshFooterHint: () => this.refreshFooterHint(),
		});
	}

	attachPromptQueue(queue: PromptQueue): void {
		this.queueController.attach(queue);
	}

	private handleSessionRecoverCommand(context: CommandExecutionContext): void {
		this.sessionStateController.handleSessionRecoverCommand(context);
	}

	public async ensureContextBudgetBeforePrompt(): Promise<void> {
		await this.compactionController.ensureContextBudgetBeforePrompt();
	}

	/**
	 * Handle auto-retry events from the retry controller.
	 */
	private handleAutoRetryEvent(event: AgentEvent): void {
		if (event.type === "auto_retry_start") {
			const delaySec = (event.delayMs / 1000).toFixed(1);
			this.notificationView.showToast(
				`Retrying (attempt ${event.attempt}/${event.maxAttempts}) in ${delaySec}s... Press Escape to cancel.`,
				"warn",
			);
			// Mark as running again since we're retrying
			this.isAgentRunning = true;
			this.refreshFooterHint();
		} else if (event.type === "auto_retry_end") {
			if (event.success) {
				this.notificationView.showToast(
					`Retry succeeded after ${event.attempt} attempt(s).`,
					"info",
				);
			} else if (event.finalError) {
				this.notificationView.showError(
					`Retry failed after ${event.attempt} attempt(s): ${event.finalError}`,
				);
			}
			this.refreshFooterHint();
		}
	}

	private handleExternalEditor(): void {
		const result = openExternalEditor(this.ui, this.editor.getText());
		if (result.error) {
			this.notificationView.showInfo(result.error);
			return;
		}
		if (typeof result.updatedText === "string") {
			this.editor.setText(result.updatedText);
			this.ui.requestRender();
		}
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.notificationView.showInfo(
				"Suspending is not supported on Windows terminals.",
			);
			return;
		}
		process.once("SIGCONT", () => {
			this.ui.start();
			this.ui.requestRender("interactive");
		});
		this.ui.stop();
		process.kill(0, "SIGTSTP");
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
			this.welcomeAnimation = new WelcomeAnimation(
				() => this.ui.requestRender(),
				{ animate: !this.shouldDisableAnimations() },
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
			onLayoutChange: () => {
				this.viewportController.markStartupDirty();
				this.updateScrollViewport();
			},
		});

		this.ui.start();
		this.isInitialized = true;
	}

	async handleEvent(event: AgentEvent, state: AgentState): Promise<void> {
		await this.agentEventBridge.handleEvent(event, state);
	}

	renderInitialMessages(state: AgentState): void {
		this.sessionStateController.renderInitialMessages(state);
	}

	private renderConversationView(): void {
		this.sessionStateController.renderConversationView();
	}

	async getUserInput(): Promise<string> {
		return this.inputController.getUserInput();
	}

	setInterruptCallback(
		callback: (options?: { keepPartial?: boolean }) => void,
	): void {
		this.inputController.setInterruptCallback(callback);
	}

	private handleCtrlC(): void {
		if (this.bashModeView.isCommandRunning()) {
			if (this.bashModeView.abortCurrentCommand()) {
				return;
			}
		}
		this.runController.handleCtrlC();
	}

	private renderHeader(): void {
		this.headerContainer.clear();
		this.viewportController.markHeaderDirty();

		// The full instruction panel is helpful but very tall; when it pushes the UI
		// into scrollback it becomes a major source of flicker (terminals can't update
		// scrollback, so we end up full-redrawing). Default to a compact header unless
		// we have enough vertical room.
		const rows = process.stdout.rows ?? 24;
		const showFullPanel = rows >= 40;

		if (showFullPanel) {
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(
				new InstructionPanelComponent(this.version),
			);
			this.headerContainer.addChild(new Spacer(1));
			return;
		}

		const title =
			chalk.bold(`composer v${this.version}`) + chalk.gray(" · EvalOps");
		const hintParts = [
			`${chalk.gray("esc")} interrupt`,
			`${chalk.gray("ctrl+c")} clear`,
			`${chalk.gray("ctrl+k")} palette`,
			`${chalk.gray("/help")} commands`,
		];
		const hints = hintParts.join(chalk.gray("  │  "));
		this.headerContainer.addChild(new Text(`${title}\n${hints}`, 1, 0));
		this.headerContainer.addChild(new Spacer(1));
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

	private handleContextCommand(_context: CommandExecutionContext): void {
		const contextView = new ContextView({
			state: this.agent.state,
			onClose: () => this.modalManager.pop(),
		});
		this.modalManager.push(contextView);
	}

	private async handleSourcesCommand(
		context: CommandExecutionContext,
	): Promise<void> {
		try {
			const result = await this.agent.getContextSourceStatus();
			const lines: string[] = ["Context Sources Status:"];
			lines.push(
				`  Total: ${result.successCount} success, ${result.failureCount} failed (${result.totalDurationMs}ms)`,
			);
			lines.push("");

			for (const source of result.sourceStatuses) {
				const icon =
					source.status === "success"
						? "✓"
						: source.status === "empty"
							? "○"
							: source.status === "skipped"
								? "⊘"
								: "✗";
				const status =
					source.status === "success"
						? source.truncated
							? `success (truncated from ${source.originalLength} chars)`
							: "success"
						: source.status;
				const duration =
					source.durationMs > 0 ? ` (${source.durationMs}ms)` : "";
				lines.push(`  ${icon} ${source.name}: ${status}${duration}`);
				if (source.error) {
					lines.push(`      Error: ${source.error}`);
				}
			}

			context.showInfo(lines.join("\n"));
		} catch (error) {
			context.showError(
				`Failed to get context source status: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private handleFooterCommand(context: CommandExecutionContext): void {
		this.uiStateController.handleFooterCommand(context, {
			getToastHistory: (count: number) => this.footer.getToastHistory(count),
			clearAlerts: () => this.footer.clearAlerts(),
		});
	}

	private handleCompactToolsCommand(rawInput: string): void {
		this.toolOutputView.handleCompactToolsCommand(rawInput);
		this.persistUiState();
	}

	private handleSteerCommand(context: CommandExecutionContext): void {
		const text = context.argumentText.trim();
		if (!text) {
			context.showError("Usage: /steer <message>");
			return;
		}

		const wasRunning = this.isAgentRunning;
		if (wasRunning) {
			this.inputController.interruptNow({ keepPartial: false });
			this.notificationView.showToast(
				"Steering: interrupted current run",
				"warn",
			);
		}

		const entry = this.queueController.enqueuePrompt(text, { front: true });
		if (!entry) {
			context.showError("Prompt queue is not available.");
		}
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

	private persistUiState(extra?: Partial<UiState>): void {
		const recentCommands =
			this.slashHintController?.getRecentCommands() ?? this.recentCommands;
		const favoriteCommands =
			this.slashHintController?.getFavoriteCommands() ?? this.favoriteCommands;
		saveUiState({
			queueMode: this.queueController.getMode(),
			compactTools: this.toolOutputView.isCompact(),
			footerMode: this.footerMode,
			reducedMotion: this.reducedMotion,
			cleanMode: this.cleanMode,
			hideThinkingBlocks: this.hideThinkingBlocks,
			recentCommands,
			favoriteCommands: Array.from(favoriteCommands),
			...extra,
		});
		saveCommandPrefs({
			favorites: Array.from(favoriteCommands),
			recents: recentCommands,
		});
	}

	private handleFrameworkCommand(context: CommandExecutionContext): void {
		frameworkHandler(context, {
			showInfo: (msg) => this.notificationView.showInfo(msg),
			showError: (msg) => this.notificationView.showError(msg),
			showSuccess: (msg) => this.notificationView.showToast(msg, "success"),
		});
	}

	private handleNewChatCommand(context: CommandExecutionContext): void {
		this.sessionStateController.handleNewChatCommand(context);
	}

	private resetConversation(
		messages: AppMessage[],
		editorSeed?: string,
		toastMessage?: string,
		options?: { preserveSession?: boolean; persistMessages?: boolean },
	): void {
		this.sessionStateController.resetConversation(
			messages,
			editorSeed,
			toastMessage,
			options,
		);
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
		this.chatContainer.removeChild(this.welcomeAnimation);
		this.welcomeAnimation = null;
	}

	private shouldDisableAnimations(): boolean {
		// Reduced motion is a user preference (and defaults on SSH/tmux).
		// COMPOSER_DISABLE_ANIMATIONS is an explicit hard-disable switch.
		return this.reducedMotion || areAnimationsDisabled();
	}

	showError(errorMessage: string): void {
		this.notificationView.showError(errorMessage);
		this.provideFailureHints(errorMessage);
	}

	private createHookUiContext(): HookUIContext {
		return {
			select: (title, options) => this.showHookSelector(title, options),
			confirm: (title, message) => this.showHookConfirm(title, message),
			input: (title, placeholder) => this.showHookInput(title, placeholder),
			notify: (message, type) => {
				if (type === "error") {
					this.notificationView.showError(message);
					return;
				}
				const tone = type === "warning" ? "warn" : "info";
				this.notificationView.showToast(message, tone);
			},
			setStatus: (key, text) => this.setHookStatus(key, text),
			custom: (factory) => this.showHookCustom(factory),
			setEditorText: (text) => {
				this.editor.setText(text);
				this.ui.requestRender();
			},
			getEditorText: () => this.editor.getText(),
			editor: (title, prefill) => this.showHookEditor(title, prefill),
			get theme() {
				return theme;
			},
		};
	}

	private showHookSelector(
		title: string,
		options: string[],
	): Promise<string | null> {
		return new Promise((resolve) => {
			if (options.length === 0) {
				resolve(null);
				return;
			}
			const items = options.map((option) => ({
				label: option,
				value: option,
			}));
			const selector = new BaseSelectorComponent({
				items,
				visibleRows: Math.min(10, items.length),
				onSelect: (value) => {
					this.modalManager.pop();
					resolve(value);
				},
				onCancel: () => {
					this.modalManager.pop();
					resolve(null);
				},
				prepend: [new Text(theme.fg("accent", title), 1, 0), new Spacer(1)],
			});
			this.modalManager.push(selector);
		});
	}

	private showHookConfirm(title: string, message: string): Promise<boolean> {
		return new Promise((resolve) => {
			const items = [
				{ label: "Yes", value: "yes" },
				{ label: "No", value: "no" },
			];
			const selector = new BaseSelectorComponent({
				items,
				visibleRows: 2,
				onSelect: (value) => {
					this.modalManager.pop();
					resolve(value === "yes");
				},
				onCancel: () => {
					this.modalManager.pop();
					resolve(false);
				},
				prepend: [
					new Text(theme.fg("accent", title), 1, 0),
					new Text(theme.fg("muted", message), 1, 0),
					new Spacer(1),
				],
			});
			this.modalManager.push(selector);
		});
	}

	private showHookInput(
		title: string,
		placeholder?: string,
	): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = new HookInputModal({
				ui: this.ui,
				title,
				placeholder,
				onSubmit: (value) => {
					this.modalManager.pop();
					resolve(value);
				},
				onCancel: () => {
					this.modalManager.pop();
					resolve(null);
				},
			});
			this.modalManager.push(modal);
		});
	}

	private showHookEditor(
		title: string,
		prefill?: string,
	): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = new HookInputModal({
				ui: this.ui,
				title,
				prefill,
				description: "Enter to save | Esc to cancel | Shift+Enter for newline",
				onSubmit: (value) => {
					this.modalManager.pop();
					resolve(value);
				},
				onCancel: () => {
					this.modalManager.pop();
					resolve(null);
				},
			});
			this.modalManager.push(modal);
		});
	}

	private async showHookCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			done: (result: T) => void,
		) => Component | Promise<Component>,
	): Promise<T> {
		return new Promise((resolve) => {
			let resolved = false;
			const done = (result: T) => {
				if (resolved) return;
				resolved = true;
				this.modalManager.pop();
				resolve(result);
			};

			void (async () => {
				try {
					const component = await factory(this.ui, theme, done);
					const modal = component as Component & {
						onClose?: () => void;
					};
					const previousOnClose = modal.onClose;
					modal.onClose = () => {
						previousOnClose?.();
						if (!resolved) {
							done(undefined as T);
						}
					};
					this.modalManager.push(modal);
				} catch (error) {
					this.notificationView.showError(
						error instanceof Error ? error.message : "Hook custom UI failed",
					);
					resolve(undefined as T);
				}
			})();
		});
	}

	private execHookCommand(
		command: string,
		args: string[],
	): Promise<{ stdout: string; stderr: string; code: number }> {
		return new Promise((resolve) => {
			const child = spawn(command, args, {
				cwd: process.cwd(),
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
			});

			child.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			child.on("error", (error) => {
				resolve({
					stdout,
					stderr: `${stderr}\n${error.message}`,
					code: 1,
				});
			});

			child.on("close", (code) => {
				resolve({
					stdout,
					stderr,
					code: code ?? 1,
				});
			});
		});
	}

	private createHookCommandContext(): HookCommandContext {
		return {
			exec: (command, args) => this.execHookCommand(command, args),
			ui: this.hookUiContext ?? this.createHookUiContext(),
			hasUI: true,
			cwd: process.cwd(),
			sessionFile: this.sessionManager.getSessionFile(),
			isIdle: () => !this.agent.state.isStreaming,
			abort: () => this.agent.abort(),
			hasQueuedMessages: () => this.agent.getQueuedMessageCount() > 0,
			waitForIdle: () => {
				if (!this.agent.state.isStreaming) {
					return Promise.resolve();
				}
				return new Promise((resolve) => {
					const unsubscribe = this.agent.subscribe((event) => {
						if (event.type === "agent_end") {
							unsubscribe();
							resolve();
						}
					});
				});
			},
		};
	}

	private buildHookCommandEntries(existingCommands: SlashCommand[]): {
		entries: CommandEntry[];
		commands: SlashCommand[];
	} {
		const existingNames = new Set(existingCommands.map((cmd) => cmd.name));
		const entries: CommandEntry[] = [];
		const commands: SlashCommand[] = [];
		for (const command of getTypeScriptHookCommands()) {
			if (existingNames.has(command.name)) {
				logger.warn("Skipping hook command due to name conflict", {
					name: command.name,
				});
				continue;
			}
			const slashCommand: SlashCommand = {
				name: command.name,
				description: command.description ?? "Hook command",
				usage: `/${command.name} [args]`,
				tags: ["hooks"],
			};
			const matches = (input: string) =>
				input === `/${command.name}` || input.startsWith(`/${command.name} `);
			const execute = (input: string) => {
				const argumentText = input
					.replace(new RegExp(`^/${command.name}\\s*`), "")
					.trim();
				const context = this.createCommandContext({
					command: slashCommand,
					rawInput: input,
					argumentText,
				});
				if (
					argumentText === "?" ||
					argumentText === "--help" ||
					argumentText === "-h"
				) {
					context.renderHelp();
					return;
				}
				const hookContext = this.createHookCommandContext();
				const result = command.handler(argumentText, hookContext);
				if (result && typeof (result as Promise<void>).then === "function") {
					(result as Promise<void>).catch((error) => {
						context.showError(
							error instanceof Error ? error.message : String(error),
						);
					});
				}
			};
			entries.push({ command: slashCommand, matches, execute });
			commands.push(slashCommand);
			existingNames.add(command.name);
		}
		return { entries, commands };
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
				promptQueueMode: this.queueController.getMode(),
				queuedPromptCount: this.queueController.getQueuedCount(),
				hasPromptQueue: this.queueController.hasQueue(),
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
		const hints: FooterHint[] = [];
		const pushHint = (
			type: FooterHint["type"],
			message: string,
			priority: number,
		): void => {
			if (message.trim().length === 0) return;
			hints.push({ type, message, priority });
		};

		if (this.idleFooterHint) {
			pushHint("custom", this.idleFooterHint, 20);
		}
		for (const hint of this.buildOperationalHints()) {
			pushHint("custom", hint, 40);
		}
		for (const hint of this.getHookStatusHints()) {
			hints.push(hint);
		}
		const activeToast = this.footer.getActiveToast();
		if (
			activeToast &&
			(activeToast.tone === "danger" || activeToast.tone === "warn")
		) {
			pushHint("custom", `Alert: ${activeToast.message}`, 160);
		}
		if (this.startupWarnings.length > 0) {
			hints.push(...this.startupWarnings);
		}
		if (this.planHint) {
			pushHint("plan", `Plan ${this.planHint}`, 120);
		}
		const queueHint = this.queueController.buildQueueHint();
		if (queueHint) {
			pushHint("queue", queueHint, 110);
		}
		this.footer.setHints(hints);
	}

	private buildOperationalHints(): string[] {
		const hints: string[] = [];
		const backgroundCounts = this.backgroundTasksController.getCounts();
		if (backgroundCounts.running > 0 || backgroundCounts.failed > 0) {
			const runningLabel = `${backgroundCounts.running} background ${backgroundCounts.running === 1 ? "task" : "tasks"} running`;
			const failureSuffix =
				backgroundCounts.failed > 0
					? `; ${backgroundCounts.failed} failed`
					: "";
			hints.push(`${runningLabel}${failureSuffix} (use /background list)`);
		}
		if (this.compactionController?.isCompacting()) {
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

	private sanitizeHookStatusText(text: string): string {
		return text.replace(/[\r\n\t]+/g, " ");
	}

	private setHookStatus(key: string, text: string | undefined): void {
		if (!key) return;
		if (!text || text.trim().length === 0) {
			if (this.hookStatusByKey.delete(key)) {
				this.refreshFooterHint();
			}
			return;
		}
		const sanitized = this.sanitizeHookStatusText(text);
		const previous = this.hookStatusByKey.get(key);
		if (previous === sanitized) {
			return;
		}
		this.hookStatusByKey.set(key, sanitized);
		this.refreshFooterHint();
	}

	private getHookStatusHints(): FooterHint[] {
		const hints: FooterHint[] = [];
		for (const text of this.hookStatusByKey.values()) {
			hints.push({ type: "custom", message: text, priority: 130 });
		}
		return hints;
	}

	private handleEditorTyping(): void {
		this.footer.clearToast();
		this.slashHintController?.refreshSlashHintDebounced();
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
		this.sessionStateController.applyLoadedSessionContext();
	}

	private isMinimalMode(): boolean {
		return this.minimalMode;
	}

	private getGroupedHandlers(): GroupedCommandHandlers {
		if (!this.groupedHandlers) {
			this.groupedHandlers = createGroupedCommandHandlers({
				session: {
					handleNewChat: (context) => this.handleNewChatCommand(context),
					handleClear: () => this.clearController.handleClearCommand(),
					handleSessionInfo: (ctx) =>
						this.sessionView.handleSessionCommand(ctx.rawInput),
					handleSessionsList: (ctx) =>
						this.sessionView.handleSessionsCommand(ctx.rawInput),
					handleBranch: (ctx) => this.branchController.handleBranchCommand(ctx),
					handleTree: (_ctx) => this.treeSelectorView.show(),
					handleQueue: (ctx) => {
						if (this.queuePanelController) {
							this.queuePanelController.handleQueueCommand(ctx);
							return;
						}
						ctx.showInfo("Prompt queue is not available.");
					},
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
					handleBackground: (ctx) =>
						this.backgroundTasksController.handleBackgroundCommand(ctx),
					handleDiagnostics: (ctx) =>
						this.diagnosticsView.handleDiagnosticsCommand(ctx.rawInput),
					handleTelemetry: (ctx) =>
						this.telemetryView.handleTelemetryCommand(ctx),
					handleTraining: (ctx) => this.trainingView.handleTrainingCommand(ctx),
					handleOtel: (_ctx) =>
						otelHandler({
							showInfo: (msg) => this.notificationView.showInfo(msg),
						}),
					handleConfig: (ctx) => this.configView.handleConfigCommand(ctx),
					handleLsp: (ctx) => this.lspView.handleLspCommand(ctx.rawInput),
					handleMcp: (ctx) => this.handleMcpCommand(ctx),
					handleSources: (ctx) => this.handleSourcesCommand(ctx),
				},
				ui: {
					showTheme: () => this.themeSelectorView.show(),
					handleClean: (ctx) => this.uiStateController.handleCleanCommand(ctx),
					handleFooter: (ctx) => this.handleFooterCommand(ctx),
					handleZen: (ctx) => this.uiStateController.handleZenCommand(ctx),
					handleCompactTools: (ctx) =>
						this.handleCompactToolsCommand(ctx.rawInput),
					getUiState: () => ({
						...this.uiStateController.getState(),
						compactTools: this.toolOutputView?.isCompact() ?? false,
					}),
				},
				safety: {
					handleApprovals: (ctx) =>
						handleApprovalsCommand(ctx, this.approvalService, {
							showToast: (msg, type) =>
								this.notificationView.showToast(msg, type),
							refreshFooterHint: () => this.refreshFooterHint(),
							addContent: (text) => {
								this.chatContainer.addChild(new Spacer(1));
								this.chatContainer.addChild(new Text(text, 1, 0));
							},
							requestRender: () => this.ui.requestRender(),
						}),
					handlePlanMode: (ctx) =>
						handlePlanModeCommand(ctx, {
							showToast: (msg, type) =>
								this.notificationView.showToast(msg, type),
							refreshFooterHint: () => this.refreshFooterHint(),
							addContent: (text) => {
								this.chatContainer.addChild(new Spacer(1));
								this.chatContainer.addChild(new Text(text, 1, 0));
							},
							requestRender: () => this.ui.requestRender(),
						}),
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
					handleInit: (ctx) =>
						handleInitCommand(ctx, {
							showSuccess: (msg) =>
								this.notificationView.showToast(msg, "success"),
							showError: (msg) => ctx.showError(msg),
							addContent: (text) => {
								this.chatContainer.addChild(new Spacer(1));
								this.chatContainer.addChild(new Text(text, 1, 0));
							},
							requestRender: () => this.ui.requestRender(),
						}),
				},
				tools: {
					handleTools: (ctx) =>
						this.toolStatusView.handleToolsCommand(ctx.rawInput),
					handleMcp: (ctx) => this.handleMcpCommand(ctx),
					handleLsp: (ctx) => this.lspView.handleLspCommand(ctx.rawInput),
					handleWorkflow: (ctx) => this.handleWorkflowCommand(ctx),
					handleRun: (ctx) =>
						this.runCommandView.handleRunCommand(ctx.rawInput),
					handleCommands: (ctx) =>
						this.customCommandsController.handleCommandsCommand(ctx),
				},
			});
		}
		return this.groupedHandlers;
	}

	stop(): void {
		this.slashHintController?.dispose();
		this.loaderView.stop();
		this.queueController.detach();
		this.backgroundTasksController.stop();
		// Clean up MCP and composer event listeners
		this.mcpEventsController.stop();
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
		if (!this.zenMode) {
			this.renderHeader();
		}
		// Update scroll viewport on resize
		this.updateScrollViewport();
	}

	/**
	 * Updates the scroll container's viewport height based on terminal size.
	 * Called on init and resize.
	 */
	private updateScrollViewport(options: { fast?: boolean } = {}): void {
		this.viewportController.updateScrollViewport(options);
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
		// If transport exposes a light ping, use it without sending user content.
		await this.agent.probeTransport().catch((error: unknown) => {
			const message =
				error instanceof Error
					? error.message
					: "Model connectivity probe failed. Check API key and network.";
			throw new Error(message);
		});
	}
}
