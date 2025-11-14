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
import { getRegisteredModels, reloadModelConfig } from "../models/registry.js";
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
import { AssistantMessageComponent } from "./assistant-message.js";
import { createCommandRegistry } from "./commands/registry.js";
import type { CommandEntry } from "./commands/types.js";
import { CustomEditor } from "./custom-editor.js";
import { DiagnosticsView } from "./diagnostics-view.js";
import { FooterComponent } from "./footer.js";
import { GitView } from "./git-view.js";
import { InstructionPanelComponent } from "./instruction-panel.js";
import { LoaderView } from "./loader-view.js";
import { ModelSelectorComponent } from "./model-selector.js";
import { PlanView } from "./plan-view.js";
import { RunCommandView } from "./run-command-view.js";
import { ThinkingSelectorComponent } from "./thinking-selector.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { ToolStatusView } from "./tool-status-view.js";
import { CommandPaletteView } from "./command-palette-view.js";
import { FileSearchView } from "./file-search-view.js";
import { SessionView } from "./session-view.js";
import { UserMessageComponent } from "./user-message.js";
import { WelcomeAnimation } from "./welcome-animation.js";
import { ImportExportView } from "./import-view.js";
import { ConversationCompactor } from "./conversation-compactor.js";

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

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | null = null;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private explicitApiKey?: string;
	private telemetryStatus = getTelemetryStatus();
	private currentModelMetadata?: SessionModelMetadata;

	// Thinking level selector
	private thinkingSelector: ThinkingSelectorComponent | null = null;

	// Model selector
	private modelSelector: ModelSelectorComponent | null = null;

	// Track if this is the first user message (to skip spacer)
	private isFirstUserMessage = true;

	// Welcome animation shown before first interaction
	private welcomeAnimation: WelcomeAnimation | null = null;

	private readonly idleFooterHint =
		"Try /help for commands or /tools for status";
	private planHint: string | null = null;
	private compactToolOutputs = false;
	private toolComponents = new Set<ToolExecutionComponent>();
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
			showInfoMessage: (message) => this.showInfoMessage(message),
			setPlanHint: (hint) => {
				this.planHint = hint;
				this.refreshFooterHint();
			},
		});
		this.runCommandView = new RunCommandView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.showInfoMessage(message),
		});
		this.gitView = new GitView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.showInfoMessage(message),
			showToast: (message, tone) => this.showToast(message, tone),
		});
		this.toolStatusView = new ToolStatusView({
			chatContainer: this.chatContainer,
			ui: this.ui,
			getTools: () => this.agent.state.tools,
			showInfoMessage: (message) => this.showInfoMessage(message),
		});
		this.sessionView = new SessionView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
			applyLoadedSessionContext: () => this.applyLoadedSessionContext(),
			showInfoMessage: (message) => this.showInfoMessage(message),
			onSessionLoaded: (sessionInfo) => {
				this.toolComponents.clear();
				this.renderInitialMessages(this.agent.state);
				this.footer.updateState(this.agent.state);
				this.showInfoMessage(
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
			showInfoMessage: (message) => this.showInfoMessage(message),
		});
		this.commandPaletteView = new CommandPaletteView({
			editor: this.editor,
			editorContainer: this.editorContainer,
			ui: this.ui,
			getCommands: () => this.slashCommands,
		});
		this.importExportView = new ImportExportView({
			agent: this.agent,
			sessionManager: this.sessionManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
			showInfoMessage: (message) => this.showInfoMessage(message),
			applyLoadedSessionContext: () => this.applyLoadedSessionContext(),
		});
		this.conversationCompactor = new ConversationCompactor({
			agent: this.agent,
			sessionManager: this.sessionManager,
			chatContainer: this.chatContainer,
			ui: this.ui,
			footer: this.footer,
			idleHint: this.idleFooterHint,
			toolComponents: this.toolComponents,
			renderMessages: () => this.renderInitialMessages(this.agent.state),
			showInfoMessage: (message) => this.showInfoMessage(message),
		});

		const commandRegistry = createCommandRegistry({
			getRunScriptCompletions: (prefix) =>
				this.runCommandView.getRunScriptCompletions(prefix),
			handlers: {
				thinking: () => this.showThinkingSelector(),
				model: () => this.showModelSelector(),
				exportSession: (input) => this.importExportView.handleExportCommand(input),
				tools: (input) => this.toolStatusView.handleToolsCommand(input),
				importConfig: (input) => this.importExportView.handleImportCommand(input),
				sessionInfo: () => this.sessionView.showSessionInfo(),
				sessions: (input) => this.sessionView.handleSessionsCommand(input),
				reportBug: () => this.diagnosticsView.handleBugCommand(),
				status: () => this.diagnosticsView.handleStatusCommand(),
				review: () => this.gitView.handleReviewCommand(),
				undoChanges: (input) => this.gitView.handleUndoCommand(input),
				shareFeedback: () => this.diagnosticsView.handleFeedbackCommand(),
				mention: (input) => this.fileSearchView.handleMentionCommand(input),
				help: () => this.handleHelpCommand(),
				plan: (input) => this.planView.handlePlanCommand(input),
				preview: (input) => this.gitView.handlePreviewCommand(input),
				run: (input) => this.runCommandView.handleRunCommand(input),
				why: () => this.handleWhyCommand(),
				diagnostics: (input) =>
					this.diagnosticsView.handleDiagnosticsCommand(input),
				compact: () => this.handleCompactCommand(),
				compactTools: (input) => this.handleCompactToolsCommand(input),
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
					this.addMessageToChat(event.message);
					this.editor.setText("");
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					// Create assistant component for streaming
					this.streamingComponent = new AssistantMessageComponent();
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(
						event.message as AssistantMessage,
					);
					this.loaderView.setStreamingActive(true);
					this.loaderView.maybeTransitionToResponding();
					this.ui.requestRender();
				}
				break;

			case "message_update":
				// Update streaming component
				if (this.streamingComponent && event.message.role === "assistant") {
					const assistantMsg = event.message as AssistantMessage;
					this.streamingComponent.updateContent(assistantMsg);

					// Create tool execution components as soon as we see tool calls
					for (const content of assistantMsg.content) {
						if (content.type === "toolCall") {
							// Only create if we haven't created it yet
							if (!this.pendingTools.has(content.id)) {
								this.chatContainer.addChild(new Text("", 0, 0));
								const component = new ToolExecutionComponent(
									content.name,
									content.arguments,
								);
								this.chatContainer.addChild(component);
								this.pendingTools.set(content.id, component);
								this.registerToolComponent(component);
							} else {
								// Update existing component with latest arguments as they stream
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}

					this.ui.requestRender();
				}
				break;

			case "message_end":
				// Skip user messages (already shown in message_start)
				if (event.message.role === "user") {
					break;
				}
				if (this.streamingComponent && event.message.role === "assistant") {
					this.loaderView.setStreamingActive(false);
					const assistantMsg = event.message as AssistantMessage;
					this.lastAssistantMessageText = this.extractTextFromAppMessage(
						event.message,
					);

					// Update streaming component with final message (includes stopReason)
					this.streamingComponent.updateContent(assistantMsg);

					// If message was aborted or errored, mark all pending tool components as failed
					if (
						assistantMsg.stopReason === "aborted" ||
						assistantMsg.stopReason === "error"
					) {
						const errorMessage =
							assistantMsg.stopReason === "aborted"
								? "Operation aborted"
								: assistantMsg.errorMessage || "Error";
						for (const [toolCallId, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					}

					// Keep the streaming component - it's now the final assistant message
					this.streamingComponent = null;
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
				// Component should already exist from message_update, but create if missing
				if (!this.pendingTools.has(event.toolCallId)) {
					const component = new ToolExecutionComponent(
						event.toolName,
						event.args,
					);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
					this.registerToolComponent(component);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				// Update the existing tool component with the result
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult(event.result);
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}
				this.loaderView.markToolComplete(event.toolCallId);
				break;
			}

			case "agent_end":
				this.loaderView.finish();
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = null;
				}
				this.pendingTools.clear();
				this.editor.disableSubmit = false;
				this.gitView.notifyFileChanges();
				this.refreshFooterHint();
				this.ui.requestRender();
				break;
		}
	}

	private addMessageToChat(message: Message): void {
		if (message.role === "user") {
			const userMsg = message as any;
			// Extract text content - handle both string and array content
			let textContent = "";
			if (typeof userMsg.content === "string") {
				textContent = userMsg.content;
			} else if (Array.isArray(userMsg.content)) {
				const textBlocks = userMsg.content.filter(
					(c: any) => c.type === "text",
				);
				textContent = textBlocks.map((c: any) => c.text).join("");
			}

			if (textContent) {
				const userComponent = new UserMessageComponent(
					textContent,
					this.isFirstUserMessage,
				);
				this.chatContainer.addChild(userComponent);
				this.isFirstUserMessage = false;
			}
		} else if (message.role === "assistant") {
			const assistantMsg = message as AssistantMessage;

			// Add assistant message component
			const assistantComponent = new AssistantMessageComponent(assistantMsg);
			this.chatContainer.addChild(assistantComponent);
		}
		// Note: tool calls and results are now handled via tool_execution_start/end events
	}

	renderInitialMessages(state: AgentState): void {
		// Render all existing messages (for --continue mode)
		// Reset first user message flag for initial render
		this.isFirstUserMessage = true;

		// Update footer with loaded state
		this.footer.updateState(state);
		this.toolComponents.clear();
		this.pendingTools.clear();

		// Render messages
		for (let i = 0; i < state.messages.length; i++) {
			const message = state.messages[i];

			if (message.role === "user") {
				const userMsg = message as any;
				const textBlocks = userMsg.content.filter(
					(c: any) => c.type === "text",
				);
				const textContent = textBlocks.map((c: any) => c.text).join("");
				if (textContent) {
					const userComponent = new UserMessageComponent(
						textContent,
						this.isFirstUserMessage,
					);
					this.chatContainer.addChild(userComponent);
					this.isFirstUserMessage = false;
				}
			} else if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				const assistantComponent = new AssistantMessageComponent(assistantMsg);
				this.chatContainer.addChild(assistantComponent);

				// Create tool execution components for any tool calls
				for (const content of assistantMsg.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.arguments,
						);
						this.chatContainer.addChild(component);
						this.registerToolComponent(component);

						// If message was aborted/errored, immediately mark tool as failed
						if (
							assistantMsg.stopReason === "aborted" ||
							assistantMsg.stopReason === "error"
						) {
							const errorMessage =
								assistantMsg.stopReason === "aborted"
									? "Operation aborted"
									: assistantMsg.errorMessage || "Error";
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						} else {
							// Store in map so we can update with results later
							this.pendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Update existing tool execution component with results				;
				const component = this.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult({
						content: message.content,
						details: message.details,
						isError: message.isError,
					});
					// Remove from pending map since it's complete
					this.pendingTools.delete(message.toolCallId);
				}
			}
		}
		// Clear pending map (should already be empty, but keep tidy)
		this.pendingTools.clear();
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







	private showThinkingSelector(): void {
		// Create thinking selector with current level
		this.thinkingSelector = new ThinkingSelectorComponent(
			this.agent.state.thinkingLevel,
			(level) => {
				// Apply the selected thinking level
				this.agent.setThinkingLevel(level);

				// Save thinking level change to session
				this.sessionManager.saveThinkingLevelChange(level);

				// Show confirmation message with proper spacing
				this.chatContainer.addChild(new Spacer(1));
				const confirmText = new Text(
					chalk.dim(`Thinking level: ${level}`),
					1,
					0,
				);
				this.chatContainer.addChild(confirmText);

				// Hide selector and show editor again
				this.hideThinkingSelector();
				this.ui.requestRender();
			},
			() => {
				// Just hide the selector
				this.hideThinkingSelector();
				this.ui.requestRender();
			},
		);

		// Replace editor with selector
		this.editorContainer.clear();
		this.editorContainer.addChild(this.thinkingSelector);
		this.ui.setFocus(this.thinkingSelector.getSelectList());
		this.ui.requestRender();
	}

	private hideThinkingSelector(): void {
		// Replace selector with editor in the container
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.thinkingSelector = null;
		this.ui.setFocus(this.editor);
	}

	private showModelSelector(): void {
		// Create model selector with current model
		this.modelSelector = new ModelSelectorComponent(
			this.agent.state.model as RegisteredModel,
			(model) => {
				// Apply the selected model
				this.agent.setModel(model);

				// Save model change to session
				this.sessionManager.saveModelChange(`${model.provider}/${model.id}`);

				// Show confirmation message with proper spacing
				this.chatContainer.addChild(new Spacer(1));
				const confirmText = new Text(chalk.dim(`Model: ${model.id}`), 1, 0);
				this.chatContainer.addChild(confirmText);

				// Hide selector and show editor again
				this.hideModelSelector();
				this.ui.requestRender();
			},
			() => {
				// Just hide the selector
				this.hideModelSelector();
				this.ui.requestRender();
			},
		);

		// Replace editor with selector
		this.editorContainer.clear();
		this.editorContainer.addChild(this.modelSelector);
		this.ui.setFocus(this.modelSelector);
		this.ui.requestRender();
	}

	private hideModelSelector(): void {
		// Replace selector with editor in the container
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.modelSelector = null;
		this.ui.setFocus(this.editor);
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

	private showInfoMessage(text: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(chalk.dim(text), 1, 0));
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(chalk.red(`Error: ${errorMessage}`), 1, 0),
		);
		this.ui.requestRender();
	}

	private refreshFooterHint(): void {
		const suffix = this.planHint ? ` • Plan ${this.planHint}` : "";
		this.footer.setHint(`${this.idleFooterHint}${suffix}`);
	}

	private showToast(
		text: string,
		tone: "info" | "warn" | "success" = "info",
	): void {
		const color =
			tone === "warn"
				? chalk.hex("#f97316")
				: tone === "success"
					? chalk.hex("#10b981")
					: chalk.hex("#38bdf8");
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(color(`ℹ ${text}`), 1, 0));
		this.ui.requestRender();
	}

	private handleHelpCommand(): void {
		const lines = this.slashCommands.map(
			(cmd) => `${chalk.cyan(`/${cmd.name}`)} - ${cmd.description}`,
		);
		const text = `${chalk.bold("Slash commands")}
${lines.join("\n")}`;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(text, 1, 0));
		this.ui.requestRender();
	}

	private handleWhyCommand(): void {
		const user = this.lastUserMessageText
			? this.lastUserMessageText
			: chalk.dim("No recent user question recorded.");
		const response = this.lastAssistantMessageText
			? this.lastAssistantMessageText
			: chalk.dim("No assistant response yet.");
		const tools = this.lastRunToolNames.length
			? this.lastRunToolNames.join(", ")
			: chalk.dim("none");
		const text = `${chalk.bold("Why summary")}
${chalk.dim("Last question")}:
${user}

${chalk.dim("Tools invoked")}:
${tools}

${chalk.dim("Assistant reply")}:
${response}`;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(text, 1, 0));
		this.ui.requestRender();
	}

	private extractTextFromAppMessage(message: AppMessage): string {
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

	private handleCompactToolsCommand(text: string): void {
		const parts = text.trim().split(/\s+/);
		let nextState = this.compactToolOutputs;
		if (parts.length === 1) {
			nextState = !nextState;
		} else {
			const arg = parts[1].toLowerCase();
			if (arg === "on" || arg === "true") {
				nextState = true;
			} else if (arg === "off" || arg === "false") {
				nextState = false;
			} else if (arg === "toggle") {
				nextState = !nextState;
			} else {
				this.showInfoMessage("Usage: /compact-tools [on|off|toggle]");
				return;
			}
		}
		this.compactToolOutputs = nextState;
		this.applyCompactModeToTools();
		this.showInfoMessage(
			nextState
				? "Tool outputs will collapse by default."
				: "Tool outputs will show full content.",
		);
	}

	stop(): void {
		this.loaderView.stop();
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}

	private registerToolComponent(component: ToolExecutionComponent): void {
		this.toolComponents.add(component);
		component.setCollapsed(this.compactToolOutputs);
	}

	private applyCompactModeToTools(): void {
		for (const component of this.toolComponents) {
			component.setCollapsed(this.compactToolOutputs);
		}
		this.ui.requestRender();
	}
}
