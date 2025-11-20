import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { LargePasteEvent } from "@evalops/tui";
import type { SlashCommand } from "@evalops/tui";
import {
	CombinedAutocompleteProvider,
	Container,
	ProcessTerminal,
	Spacer,
	TUI,
	Text,
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
import type { RegisteredModel } from "../models/registry.js";
import { getRegisteredModels } from "../models/registry.js";
import {
	type SessionModelMetadata,
	toSessionModelMetadata,
} from "../session/manager.js";
import type { SessionManager } from "../session/manager.js";
import { getTelemetryStatus } from "../telemetry.js";
import { AboutView } from "./about-view.js";
import { AgentEventRouter } from "./agent-event-router.js";
import { BashModeView } from "./bash-mode-view.js";
import { CommandPaletteView } from "./command-palette-view.js";
import { buildCommandRegistry } from "./command-registry-builder.js";
import { formatCommandHelp } from "./commands/argument-parser.js";
import type {
	CommandEntry,
	CommandExecutionContext,
} from "./commands/types.js";
import { ConfigView } from "./config-view.js";
import { CostView } from "./cost-view.js";
import { CustomEditor } from "./custom-editor.js";
import { DiagnosticsView } from "./diagnostics-view.js";
import { EditorView } from "./editor-view.js";
import { FeedbackView } from "./feedback-view.js";
import { FileSearchView } from "./file-search-view.js";
import {
	type FooterStats,
	calculateFooterStats,
	formatTokenCount,
} from "./footer-utils.js";
import { FooterComponent } from "./footer.js";
import { GitView } from "./git-view.js";
import { ImportExportView } from "./import-view.js";
import { InfoView } from "./info-view.js";
import { InstructionPanelComponent } from "./instruction-panel.js";
import { LoaderView } from "./loader-view.js";
import { MessageView } from "./message-view.js";
import { ModelSelectorView } from "./model-selector-view.js";
import { NotificationView } from "./notification-view.js";
import { OllamaView } from "./ollama-view.js";
import { PlanView } from "./plan-view.js";
import type { PromptQueue, PromptQueueEvent } from "./prompt-queue.js";
import { ReportSelectorView } from "./report-selector-view.js";
import { RunCommandView } from "./run-command-view.js";
import { RunController } from "./run-controller.js";
import { ConversationCompactor } from "./session/conversation-compactor.js";
import { SessionContext } from "./session/session-context.js";
import { SessionDataProvider } from "./session/session-data-provider.js";
import { SessionSummaryController } from "./session/session-summary-controller.js";
import { SessionSwitcherView } from "./session/session-switcher-view.js";
import { SessionView } from "./session/session-view.js";
import { StreamingView } from "./streaming-view.js";
import { TelemetryView } from "./telemetry-view.js";
import { ThinkingSelectorView } from "./thinking-selector-view.js";
import type { ToolExecutionComponent } from "./tool-execution.js";
import { ToolOutputView } from "./tool-output-view.js";
import { ToolStatusView } from "./tool-status-view.js";
import { UpdateView } from "./update-view.js";
import { WelcomeAnimation } from "./welcome-animation.js";

import { handleAgentsInit } from "../cli/commands/agents.js";
import { isSafeModeEnabled } from "../safety/safe-mode.js";
import { ApprovalController } from "./approval-controller.js";
import { REVIEW_INSTRUCTIONS, buildReviewPrompt } from "./review-prompt.js";
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
export class TuiRenderer {
	private ui: TUI;
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
	private fileSearchView: FileSearchView;
	private conversationCompactor: ConversationCompactor;
	private messageView: MessageView;
	private feedbackView: FeedbackView;
	private aboutView: AboutView;
	private infoView: InfoView;
	private streamingView: StreamingView;
	private thinkingSelectorView: ThinkingSelectorView;
	private modelSelectorView: ModelSelectorView;
	private reportSelectorView: ReportSelectorView;
	private notificationView: NotificationView;
	private updateView: UpdateView;
	private configView: ConfigView;
	private costView: CostView;
	private runController: RunController;
	private agentEventRouter!: AgentEventRouter;
	private sessionContext = new SessionContext();
	private promptQueue?: PromptQueue;
	private promptQueueUnsubscribe?: () => void;
	private queuedPromptCount = 0;
	private queueEnabled = false;
	private isAgentRunning = false;
	private approvalController?: ApprovalController;
	private approvalService: ActionApprovalService;
	private interruptArmed = false;
	private interruptTimeout: NodeJS.Timeout | null = null;
	private compactionInProgress = false;
	private pendingPasteSummaries = new Set<number>();
	private contextWarningLevel: "none" | "warn" | "danger" = "none";

	constructor(
		agent: Agent,
		sessionManager: SessionManager,
		version: string,
		approvalService: ActionApprovalService,
		explicitApiKey?: string,
	) {
		this.agent = agent;
		this.sessionManager = sessionManager;
		this.version = version;
		this.explicitApiKey = explicitApiKey;
		this.ui = new TUI(new ProcessTerminal());
		this.chatContainer = new Container();
		this.statusContainer = new Container();
		this.editor = new CustomEditor();
		this.editor.onLargePaste = (event) => {
			void this.handleLargePaste(event);
		};
		this.editorContainer = new Container(); // Container to hold editor or selector
		this.editorContainer.addChild(this.editor); // Start with editor
		this.footer = new FooterComponent(agent.state);
		this.notificationView = new NotificationView({
			chatContainer: this.chatContainer,
			ui: this.ui,
		});
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
			editor: this.editor,
			editorContainer: this.editorContainer,
		});
		this.runController = new RunController({
			loaderView: this.loaderView,
			footer: this.footer,
			ui: this.ui,
			workingHint: this.workingFooterHint,
			setEditorDisabled: (disabled) => {
				this.editor.disableSubmit = disabled && !this.queueEnabled;
			},
			clearEditor: () => this.clearEditor(),
			stopRenderer: () => this.stop(),
			refreshFooterHint: () => this.refreshFooterHint(),
			notifyFileChanges: () => this.gitView.notifyFileChanges(),
		});
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
			editor: this.editor,
			editorContainer: this.editorContainer,
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
		});
		this.fileSearchView = new FileSearchView({
			editor: this.editor,
			editorContainer: this.editorContainer,
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		this.commandPaletteView = new CommandPaletteView({
			editor: this.editor,
			editorContainer: this.editorContainer,
			ui: this.ui,
			getCommands: () => this.slashCommands,
		});
		this.toolOutputView = new ToolOutputView({
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
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
		this.infoView = new InfoView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			getSlashCommands: () => this.slashCommands,
		});
		this.thinkingSelectorView = new ThinkingSelectorView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			editor: this.editor,
			editorContainer: this.editorContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		this.modelSelectorView = new ModelSelectorView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			editor: this.editor,
			editorContainer: this.editorContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		this.reportSelectorView = new ReportSelectorView({
			editor: this.editor,
			editorContainer: this.editorContainer,
			ui: this.ui,
			onSelect: (type) => {
				if (type === "bug") {
					this.feedbackView.handleBugCommand();
				} else {
					this.feedbackView.handleFeedbackCommand();
				}
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

		const registry = buildCommandRegistry({
			getRunScriptCompletions: (prefix) =>
				this.runCommandView.getRunScriptCompletions(prefix),
			createContext: (ctx) => this.createCommandContext(ctx),
			showThinkingSelector: (_context) => this.thinkingSelectorView.show(),
			showModelSelector: (_context) => this.modelSelectorView.show(),
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
			showStatus: (_context) => this.diagnosticsView.handleStatusCommand(),
			handleReview: (context) => this.handleReviewCommand(context),
			handleUndo: (context) => this.gitView.handleUndoCommand(context.rawInput),
			handleMention: (context) =>
				this.fileSearchView.handleMentionCommand(context.rawInput),
			showHelp: (_context) => this.infoView.showHelp(),
			handleUpdate: (_context) => this.updateView.handleUpdateCommand(),
			handleConfig: (context) => this.configView.handleConfigCommand(context),
			handleCost: (context) => this.costView.handleCostCommand(context),
			handleTelemetry: (context) =>
				this.telemetryView.handleTelemetryCommand(context),
			handleStats: (context) => this.handleStatsCommand(context),
			handlePlan: (context) =>
				this.planView.handlePlanCommand(context.rawInput),
			handlePreview: (context) =>
				this.gitView.handlePreviewCommand(context.rawInput),
			handleRun: (context) =>
				this.runCommandView.handleRunCommand(context.rawInput),
			handleOllama: (context) =>
				this.ollamaView.handleOllamaCommand(context.rawInput),
			handleDiagnostics: (context) =>
				this.diagnosticsView.handleDiagnosticsCommand(context.rawInput),
			handleCompact: (_context) => this.handleCompactCommand(),
			handleCompactTools: (context) =>
				this.toolOutputView.handleCompactToolsCommand(context.rawInput),
			handleQueue: (context) => this.handleQueueCommand(context),
			handleQuit: (_context) => {
				this.stop();
				process.exit(0);
			},
			handleApprovals: (context) => this.handleApprovalsCommand(context),
			handleNewChat: (context) => this.handleNewChatCommand(context),
			handleInitAgents: (context) => this.handleInitCommand(context),
			handleMcp: (context) => this.handleMcpCommand(context),
		});

		this.commandEntries = registry.entries;
		this.slashCommands = registry.commands;

		const autocompleteProvider = new CombinedAutocompleteProvider(
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
	}

	attachPromptQueue(queue: PromptQueue): void {
		this.promptQueue = queue;
		this.queueEnabled = true;
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

		// Add framed header with quick shortcuts
		const headerPanel = new InstructionPanelComponent(this.version);

		// Setup UI layout
		this.ui.addChild(new Spacer(1));
		this.ui.addChild(headerPanel);
		this.ui.addChild(new Spacer(1));

		// Show welcome animation initially
		this.welcomeAnimation = new WelcomeAnimation(() => this.ui.requestRender());
		this.chatContainer.addChild(this.welcomeAnimation);

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(new Spacer(1));
		this.ui.addChild(this.editorContainer); // Use container that can hold editor or selector
		this.refreshFooterHint();
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

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
		this.notificationView.showInfo("Press Esc again within 5s to interrupt.");
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
			return;
		}
		const snapshot = this.promptQueue.getSnapshot();
		this.queuedPromptCount = snapshot.pending.length;
	}

	private handleQueueCommand(context: CommandExecutionContext): void {
		if (!this.promptQueue) {
			context.showInfo("Prompt queue is not available.");
			return;
		}
		const args = context.argumentText.trim();
		if (!args || args === "list") {
			this.renderQueueList();
			return;
		}
		const [action, idText] = args.split(/\s+/, 2);
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
			this.renderQueueList();
			this.updateQueuedPromptCount();
			if (!this.isAgentRunning) {
				this.refreshFooterHint();
			}
			return;
		}
		context.renderHelp();
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

	private handleNewChatCommand(context: CommandExecutionContext): void {
		if (this.isAgentRunning) {
			context.showError(
				"Wait for the current run to finish before starting a new chat.",
			);
			return;
		}
		this.sessionManager.startFreshSession();
		this.agent.clearMessages();
		this.sessionContext.resetArtifacts();
		this.toolOutputView.clearTrackedComponents();
		this.chatContainer.clear();
		this.planView.syncHintWithStore();
		this.planHint = null;
		this.footer.updateState(this.agent.state);
		this.refreshFooterHint();
		this.renderInitialMessages(this.agent.state);
		this.notificationView.showToast("Started a new chat session.", "success");
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

	private handleMcpCommand(_context: CommandExecutionContext): void {
		const lines = [
			"Model Context Protocol",
			"No MCP servers are configured yet.",
			"Add them to your Composer config once MCP support lands, or set the MCP_* environment variables when running under Codex.",
		];
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.ui.requestRender();
	}

	private renderQueueList(): void {
		if (!this.promptQueue) {
			return;
		}
		const snapshot = this.promptQueue.getSnapshot();
		const lines: string[] = [];
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
			lines.push("Use /queue cancel <id> to remove a prompt.");
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.ui.requestRender();
	}

	private formatQueuedText(message: string): string {
		const singleLine = message.replace(/\s+/g, " ").trim();
		if (singleLine.length <= 80) {
			return singleLine || "(empty message)";
		}
		return `${singleLine.slice(0, 77)}…`;
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
		this.footer.setRuntimeBadges(this.buildRuntimeBadges());
		if (this.isAgentRunning) {
			return;
		}
		const hints: string[] = [this.idleFooterHint];
		if (this.compactionInProgress) {
			hints.push("Compacting history…");
		}
		if (this.pendingPasteSummaries.size > 0) {
			hints.push("Summarizing pasted text…");
		}
		if (this.bashModeView?.isActive()) {
			hints.push("Bash mode active — type exit to leave");
		}
		if (this.planHint) {
			hints.push(`Plan ${this.planHint}`);
		}
		this.footer.setHint(hints.filter(Boolean).join(" • "));
	}

	private buildRuntimeBadges(): string[] {
		const badges: string[] = [];
		if (isSafeModeEnabled()) {
			badges.push("safe:on");
		}
		const approvalMode = this.approvalService.getMode();
		if (approvalMode && approvalMode !== "auto") {
			badges.push(`approvals:${approvalMode}`);
		}
		if (this.queuedPromptCount > 0) {
			badges.push(`queue:${this.queuedPromptCount}`);
		}
		return badges;
	}

	public extractTextFromAppMessage(message: AppMessage): string {
		if ((message as AssistantMessage).content) {
			const content = (message as AssistantMessage).content;
			const textParts = content
				.filter((chunk) => chunk.type === "text")
				.map((chunk) => (chunk as any).text as string);
			if (textParts.length) {
				return textParts.join("\n");
			}
		}
		if (typeof (message as any).content === "string") {
			return (message as any).content as string;
		}
		return "";
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
			console.error("Failed to summarize pasted content", error);
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

	stop(): void {
		this.loaderView.stop();
		this.promptQueueUnsubscribe?.();
		this.promptQueueUnsubscribe = undefined;
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}
