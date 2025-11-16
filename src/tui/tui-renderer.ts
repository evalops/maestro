import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
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
} from "../session-manager.js";
import type { SessionManager } from "../session-manager.js";
import { getTelemetryStatus } from "../telemetry.js";
import type { SlashCommand } from "../tui-lib/index.js";
import {
	CombinedAutocompleteProvider,
	Container,
	ProcessTerminal,
	Spacer,
	TUI,
	Text,
} from "../tui-lib/index.js";
import { AgentEventRouter } from "./agent-event-router.js";
import { CommandPaletteView } from "./command-palette-view.js";
import { buildCommandRegistry } from "./command-registry-builder.js";
import { formatCommandHelp } from "./commands/argument-parser.js";
import type {
	CommandEntry,
	CommandExecutionContext,
} from "./commands/types.js";
import { ConfigView } from "./config-view.js";
import { ConversationCompactor } from "./conversation-compactor.js";
import { CostView } from "./cost-view.js";
import { CustomEditor } from "./custom-editor.js";
import { DiagnosticsView } from "./diagnostics-view.js";
import { EditorView } from "./editor-view.js";
import { FeedbackView } from "./feedback-view.js";
import { FileSearchView } from "./file-search-view.js";
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
import {
	PromptQueue,
	type PromptQueueEvent,
} from "./prompt-queue.js";
import { RunCommandView } from "./run-command-view.js";
import { RunController } from "./run-controller.js";
import { SessionContext } from "./session-context.js";
import { SessionDataProvider } from "./session-data-provider.js";
import { SessionSummaryController } from "./session-summary-controller.js";
import { SessionSwitcherView } from "./session-switcher-view.js";
import { SessionView } from "./session-view.js";
import { StreamingView } from "./streaming-view.js";
import { TelemetryView } from "./telemetry-view.js";
import { ThinkingSelectorView } from "./thinking-selector-view.js";
import type { ToolExecutionComponent } from "./tool-execution.js";
import { ToolOutputView } from "./tool-output-view.js";
import { ToolStatusView } from "./tool-status-view.js";
import { UpdateView } from "./update-view.js";
import { WelcomeAnimation } from "./welcome-animation.js";

const TODO_STORE_PATH =
	process.env.COMPOSER_TODO_FILE ?? join(homedir(), ".composer", "todos.json");
/**
 * TUI renderer for the coding agent
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
	private gitView: GitView;
	private toolStatusView: ToolStatusView;
	private diagnosticsView: DiagnosticsView;
	private telemetryView: TelemetryView;
	private ollamaView: OllamaView;
	private fileSearchView: FileSearchView;
	private conversationCompactor: ConversationCompactor;
	private messageView: MessageView;
	private feedbackView: FeedbackView;
	private infoView: InfoView;
	private streamingView: StreamingView;
	private thinkingSelectorView: ThinkingSelectorView;
	private modelSelectorView: ModelSelectorView;
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

	constructor(
		agent: Agent,
		sessionManager: SessionManager,
		version: string,
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
		this.editorContainer = new Container(); // Container to hold editor or selector
		this.editorContainer.addChild(this.editor); // Start with editor
		this.footer = new FooterComponent(agent.state);
		this.notificationView = new NotificationView({
			chatContainer: this.chatContainer,
			ui: this.ui,
		});
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
		});
		this.runController = new RunController({
			loaderView: this.loaderView,
			footer: this.footer,
			ui: this.ui,
			workingHint: "Working… press esc to interrupt",
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
		});
		this.importExportView = new ImportExportView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
			applyLoadedSessionContext: () => this.applyLoadedSessionContext(),
		});
		this.feedbackView = new FeedbackView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
		});
		this.infoView = new InfoView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			getSlashCommands: () => this.slashCommands,
			getLastUserMessage: () => this.sessionContext.getLastUserMessage(),
			getLastAssistantMessage: () =>
				this.sessionContext.getLastAssistantMessage(),
			getLastRunToolNames: () => this.sessionContext.getLastRunToolNames(),
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
			handleExportSession: (context) =>
				this.importExportView.handleExportCommand(context.rawInput),
			handleTools: (context) =>
				this.toolStatusView.handleToolsCommand(context.rawInput),
			handleImportConfig: (context) =>
				this.importExportView.handleImportCommand(context.rawInput),
			showSessionInfo: (_context) => this.sessionView.showSessionInfo(),
			handleSessions: (context) =>
				this.sessionView.handleSessionsCommand(context.rawInput),
			handleBug: (_context) => this.feedbackView.handleBugCommand(),
			showStatus: (_context) => this.diagnosticsView.handleStatusCommand(),
			handleReview: (_context) => this.gitView.handleReviewCommand(),
			handleUndo: (context) => this.gitView.handleUndoCommand(context.rawInput),
			shareFeedback: (_context) =>
				this.feedbackView.handleFeedbackCommand(this.version),
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
			handleWhy: (_context) => this.infoView.showWhySummary(),
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
		});

		this.commandEntries = registry.entries;
		this.slashCommands = registry.commands;

		const autocompleteProvider = new CombinedAutocompleteProvider(
			this.slashCommands,
			process.cwd(),
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
		new EditorView({
			editor: this.editor,
			getCommandEntries: () => this.commandEntries,
			onFirstInput: () => this.dismissWelcomeAnimation(),
			onSubmit: (text) => {
				if (this.onInputCallback) {
					this.onInputCallback(text);
				}
			},
			shouldInterrupt: () => this.isAgentRunning,
			onInterrupt: () => {
				if (this.onInterruptCallback) {
					this.onInterruptCallback();
				}
			},
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
		if (event.type === "agent_start") {
			this.isAgentRunning = true;
		} else if (event.type === "agent_end") {
			this.isAgentRunning = false;
		}

		// Update footer with current stats
		this.footer.updateState(state);
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

	setInterruptCallback(callback: () => void): void {
		this.onInterruptCallback = callback;
	}

	private async handleCompactCommand(): Promise<void> {
		await this.conversationCompactor.compactHistory();
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
	}

	public refreshFooterHint(): void {
		if (this.isAgentRunning) {
			return;
		}
		const hints: string[] = [this.idleFooterHint];
		if (this.queuedPromptCount > 0) {
			const queueLabel =
				this.queuedPromptCount === 1
					? "1 prompt queued"
					: `${this.queuedPromptCount} prompts queued`;
			hints.push(queueLabel);
		}
		if (this.planHint) {
			hints.push(`Plan ${this.planHint}`);
		}
		this.footer.setHint(hints.filter(Boolean).join(" • "));
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

	private applyLoadedSessionContext(): void {
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
