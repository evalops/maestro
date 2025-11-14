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
import { createCommandRegistry } from "./commands/registry.js";
import type { CommandEntry } from "./commands/types.js";
import { CustomEditor } from "./custom-editor.js";
import { DiagnosticsView } from "./diagnostics-view.js";
import { FooterComponent } from "./footer.js";
import { GitView } from "./git-view.js";
import { InstructionPanelComponent } from "./instruction-panel.js";
import { LoaderView } from "./loader-view.js";
import { PlanView } from "./plan-view.js";
import { RunCommandView } from "./run-command-view.js";
import { ToolStatusView } from "./tool-status-view.js";
import { CommandPaletteView } from "./command-palette-view.js";
import { FileSearchView } from "./file-search-view.js";
import { SessionView } from "./session-view.js";
import { WelcomeAnimation } from "./welcome-animation.js";
import { ImportExportView } from "./import-view.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { ConversationCompactor } from "./conversation-compactor.js";
import { MessageView } from "./message-view.js";
import { FeedbackView } from "./feedback-view.js";
import { InfoView } from "./info-view.js";
import { ToolOutputView } from "./tool-output-view.js";
import { ThinkingSelectorView } from "./thinking-selector-view.js";
import { ModelSelectorView } from "./model-selector-view.js";
import { StreamingView } from "./streaming-view.js";
import { NotificationView } from "./notification-view.js";

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
	private lastSigintTime = 0;

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
	private lastUserMessageText?: string;
	private lastAssistantMessageText?: string;
	private currentRunToolNames: string[] = [];
	private lastRunToolNames: string[] = [];
	private slashCommands: SlashCommand[] = [];
	private commandEntries: CommandEntry[] = [];
	private planView: PlanView;
	private sessionView: SessionView;
	private importExportView: ImportExportView;
	private runCommandView: RunCommandView;
	private gitView: GitView;
	private toolStatusView: ToolStatusView;
	private diagnosticsView: DiagnosticsView;
	private fileSearchView: FileSearchView;
	private conversationCompactor: ConversationCompactor;
	private messageView: MessageView;
	private feedbackView: FeedbackView;
	private infoView: InfoView;
	private streamingView: StreamingView;
	private thinkingSelectorView: ThinkingSelectorView;
	private modelSelectorView: ModelSelectorView;
	private notificationView: NotificationView;

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
			telemetryEnabled: this.telemetryStatus.enabled,
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
		this.toolStatusView = new ToolStatusView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			getTools: () => this.agent.state.tools,
			showInfoMessage: (message) => this.notificationView.showInfo(message),
		});
		this.sessionView = new SessionView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
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
			getLastUserMessage: () => this.lastUserMessageText,
			getLastAssistantMessage: () => this.lastAssistantMessageText,
			getLastRunToolNames: () => this.lastRunToolNames,
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

		const commandRegistry = createCommandRegistry({
			getRunScriptCompletions: (prefix) =>
				this.runCommandView.getRunScriptCompletions(prefix),
			handlers: {
				thinking: () => this.thinkingSelectorView.show(),
				model: () => this.modelSelectorView.show(),
				exportSession: (input) => this.importExportView.handleExportCommand(input),
				tools: (input) => this.toolStatusView.handleToolsCommand(input),
				importConfig: (input) => this.importExportView.handleImportCommand(input),
				sessionInfo: () => this.sessionView.showSessionInfo(),
				sessions: (input) => this.sessionView.handleSessionsCommand(input),
				reportBug: () => this.feedbackView.handleBugCommand(),
				status: () => this.diagnosticsView.handleStatusCommand(),
				review: () => this.gitView.handleReviewCommand(),
				undoChanges: (input) => this.gitView.handleUndoCommand(input),
				shareFeedback: () => this.feedbackView.handleFeedbackCommand(this.version),
				mention: (input) => this.fileSearchView.handleMentionCommand(input),
				help: () => this.infoView.showHelp(),
				plan: (input) => this.planView.handlePlanCommand(input),
				preview: (input) => this.gitView.handlePreviewCommand(input),
				run: (input) => this.runCommandView.handleRunCommand(input),
				why: () => this.infoView.showWhySummary(),
				diagnostics: (input) =>
					this.diagnosticsView.handleDiagnosticsCommand(input),
				compact: () => this.handleCompactCommand(),
				compactTools: (input) =>
					this.toolOutputView.handleCompactToolsCommand(input),
				quit: () => {
					this.stop();
					process.exit(0);
				},
			},
		});

		this.commandEntries = commandRegistry;
		this.slashCommands = commandRegistry.map((entry) => entry.command);

		const autocompleteProvider = new CombinedAutocompleteProvider(
			this.slashCommands,
			process.cwd(),
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
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

		// Set up custom key handlers on the editor
		this.editor.onEscape = () => {
			// Intercept Escape key when processing
			if (this.editor.disableSubmit && this.onInterruptCallback) {
				this.onInterruptCallback();
			}
		};

		this.editor.onCtrlC = () => {
			this.handleCtrlC();
		};

		this.editor.onShortcut = (shortcut) => {
			if (shortcut === "ctrl+k") {
				this.showCommandPalette();
				return true;
			}
			if (shortcut === "at") {
				this.fileSearchView.showFileSearch();
				return true;
			}
			return false;
		};

		// Handle editor submission
		this.editor.onSubmit = (text: string) => {
			const trimmed = text.trim();
			if (!trimmed) return;

			// Remove welcome animation on first input
			if (this.welcomeAnimation) {
				this.welcomeAnimation.stop();
				this.chatContainer.clear();
				this.welcomeAnimation = null;
			}

			const command = this.commandEntries.find((entry) =>
				entry.matches(trimmed),
			);
			if (command) {
				const outcome = command.execute(trimmed);
				this.editor.setText("");
				if (outcome && typeof (outcome as Promise<void>).then === "function") {
					void outcome;
				}
				return;
			}

			if (this.onInputCallback) {
				this.onInputCallback(trimmed);
			}
		};

		// Start the UI
		this.ui.start();
		this.isInitialized = true;
	}

	async handleEvent(event: AgentEvent, state: AgentState): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		// Update footer with current stats
		this.footer.updateState(state);
		this.currentModelMetadata = toSessionModelMetadata(
			state.model as RegisteredModel,
		);

		switch (event.type) {
			case "agent_start":
				this.currentRunToolNames = [];
				this.editor.disableSubmit = true;
				this.loaderView.start();
				this.footer.setHint("Working… press esc to interrupt");
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "user") {
					this.lastUserMessageText = this.extractTextFromAppMessage(
						event.message,
					);
					// Show user message immediately and clear editor
					this.messageView.addMessage(event.message as AppMessage);
					this.editor.setText("");
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.streamingView.beginAssistantMessage(
						event.message as AssistantMessage,
					);
					this.loaderView.setStreamingActive(true);
					this.loaderView.maybeTransitionToResponding();
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (event.message.role === "assistant") {
					this.streamingView.updateAssistantMessage(
						event.message as AssistantMessage,
					);
					this.ui.requestRender();
				}
				break;

			case "message_end":
				// Skip user messages (already shown in message_start)
				if (event.message.role === "user") {
					break;
				}
				if (event.message.role === "assistant") {
					this.loaderView.setStreamingActive(false);
					const assistantMsg = event.message as AssistantMessage;
					this.lastAssistantMessageText = this.extractTextFromAppMessage(
						event.message,
					);

					this.streamingView.finishAssistantMessage(assistantMsg);
				}
				if (
					event.message.role === "assistant" &&
					event.message.stopReason &&
					event.message.stopReason !== "toolUse"
				) {
					this.loaderView.maybeTransitionToResponding();
				}
				this.ui.requestRender();
				break;

			case "turn_end":
				this.lastRunToolNames = [...this.currentRunToolNames];
				this.currentRunToolNames = [];
				if (event.message.role === "assistant") {
					this.lastAssistantMessageText = this.extractTextFromAppMessage(
						event.message,
					);
				}
				break;

			case "tool_execution_start": {
				this.loaderView.registerToolStage(event.toolCallId, event.toolName);
				this.currentRunToolNames.push(event.toolName);
				this.streamingView.ensureToolComponent(
					event.toolCallId,
					event.toolName,
					event.args,
				);
				this.ui.requestRender();
				break;
			}

			case "tool_execution_end": {
				this.streamingView.resolveToolResult(event.toolCallId, event.result);
				this.ui.requestRender();
				this.loaderView.markToolComplete(event.toolCallId);
				break;
			}

			case "agent_end":
				this.loaderView.finish();
				this.streamingView.forceStopStreaming();
				this.pendingTools.clear();
				this.editor.disableSubmit = false;
				this.gitView.notifyFileChanges();
				this.refreshFooterHint();
				this.ui.requestRender();
				break;
		}
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

	private handleCtrlC(): void {
		// Handle Ctrl+C double-press logic
		const now = Date.now();
		const timeSinceLastCtrlC = now - this.lastSigintTime;

		if (timeSinceLastCtrlC < 500) {
			// Second Ctrl+C within 500ms - exit
			this.stop();
			process.exit(0);
		} else {
			// First Ctrl+C - clear the editor
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private async handleCompactCommand(): Promise<void> {
		await this.conversationCompactor.compactHistory();
	}

	private showCommandPalette(): void {
		this.commandPaletteView.showCommandPalette();
	}

	private hideCommandPalette(): void {
		this.commandPaletteView.hideCommandPalette();
	}

	private clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.notificationView.showError(errorMessage);
	}

	public refreshFooterHint(): void {
		const suffix = this.planHint ? ` • Plan ${this.planHint}` : "";
		this.footer.setHint(`${this.idleFooterHint}${suffix}`);
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
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}
