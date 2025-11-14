import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import clipboard from "clipboardy";
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
import { exportSessionToHtml, exportSessionToText } from "../export-html.js";
import { importFactoryConfig } from "../factory/index.js";
import type { RegisteredModel } from "../models/registry.js";
import { getRegisteredModels, reloadModelConfig } from "../models/registry.js";
import type { ApiKeyLookupResult } from "../providers/api-keys.js";
import { getEnvVarsForProvider, lookupApiKey } from "../providers/api-keys.js";
import {
	type SessionModelMetadata,
	toSessionModelMetadata,
} from "../session-manager.js";
import type { SessionManager } from "../session-manager.js";
import { getTelemetryStatus } from "../telemetry.js";
import type { AutocompleteItem, SlashCommand } from "../tui-lib/index.js";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	ProcessTerminal,
	Spacer,
	TUI,
	Text,
	visibleWidth,
} from "../tui-lib/index.js";
import { getWorkspaceFiles } from "../workspace-files.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { CommandPaletteComponent } from "./command-palette.js";
import { createCommandRegistry } from "./commands/registry.js";
import type { CommandEntry } from "./commands/types.js";
import { CustomEditor } from "./custom-editor.js";
import { formatDiagnosticsReport } from "./diagnostics.js";
import { FileSearchComponent } from "./file-search.js";
import { FooterComponent } from "./footer.js";
import { LoaderView } from "./loader-view.js";
import { ModelSelectorComponent } from "./model-selector.js";
import { ThinkingSelectorComponent } from "./thinking-selector.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";
import { WelcomeAnimation } from "./welcome-animation.js";

const TOOL_FAILURE_LOG_PATH = join(homedir(), ".composer", "tool-failures.log");
const TODO_STORE_PATH =
	process.env.COMPOSER_TODO_FILE ?? join(homedir(), ".composer", "todos.json");
const PLAN_STATUS_SYMBOLS = {
	pending: "[ ]",
	in_progress: "[~]",
	completed: "[x]",
} as const;
const PLAN_STATUS_LABELS = {
	pending: "Pending",
	in_progress: "In Progress",
	completed: "Completed",
} as const;
type PlanStatusKey = keyof typeof PLAN_STATUS_SYMBOLS;

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
	private currentApiKeyInfo?: ApiKeyLookupResult;
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
	private commandPalette: CommandPaletteComponent | null = null;
	private fileSearchComponent: FileSearchComponent | null = null;
	private workspaceFiles: string[] = [];
	private runScripts: string[] = [];
	private lastUserMessageText?: string;
	private lastAssistantMessageText?: string;
	private currentRunToolNames: string[] = [];
	private lastRunToolNames: string[] = [];
	private lastNotifiedChanges: string[] = [];
	private slashCommands: SlashCommand[] = [];
	private commandEntries: CommandEntry[] = [];

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
		this.runScripts = this.loadRunScripts();

		const commandRegistry = createCommandRegistry({
			getRunScriptCompletions: (prefix) => this.getRunScriptCompletions(prefix),
			handlers: {
				thinking: () => this.showThinkingSelector(),
				model: () => this.showModelSelector(),
				exportSession: (input) => this.handleExportCommand(input),
				tools: (input) => this.handleToolsCommand(input),
				importConfig: (input) => this.handleImportCommand(input),
				sessionInfo: () => this.handleSessionCommand(),
				sessions: (input) => this.handleSessionsCommand(input),
				reportBug: () => this.handleBugCommand(),
				status: () => this.handleStatusCommand(),
				review: () => this.handleReviewCommand(),
				undoChanges: (input) => this.handleUndoCommand(input),
				shareFeedback: () => this.handleFeedbackCommand(),
				mention: (input) => this.handleMentionCommand(input),
				help: () => this.handleHelpCommand(),
				plan: (input) => this.handlePlanCommand(input),
				preview: (input) => this.handlePreviewCommand(input),
				run: (input) => this.handleRunCommand(input),
				why: () => this.handleWhyCommand(),
				diagnostics: (input) => this.handleDiagnosticsCommand(input),
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
		if (this.explicitApiKey) {
			this.currentApiKeyInfo = {
				provider: this.agent.state.model.provider,
				source: "explicit",
				key: this.explicitApiKey,
				checkedEnvVars: [],
			};
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
				this.showFileSearch();
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
				this.loaderView.registerToolStage(
					event.toolCallId,
					event.toolName,
				);
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
				this.notifyFileChanges();
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
		const messages = [...this.agent.state.messages];
		const keepCount = 6;
		if (messages.length <= keepCount + 1) {
			this.showInfoMessage("Not enough history to compact. Keep chatting!");
			return;
		}

		const boundary = Math.max(0, messages.length - keepCount);
		const older = messages.slice(0, boundary);
		if (!older.length) {
			this.showInfoMessage("No earlier messages to compact.");
			return;
		}

		const sliceSize = Math.min(40, older.length);
		const summaryInput = older.slice(-sliceSize) as Message[];
		this.footer.setHint("Summarizing history…");
		let summaryMessage: AssistantMessage | null = null;
		let usedModel = false;
		try {
			const prompt = this.buildSummarizationPrompt(summaryInput.length);
			const summary = await this.agent.generateSummary(
				summaryInput,
				prompt,
				this.buildSummarizationSystemPrompt(),
			);
			const llmText = this.extractPlainText(summary).trim();
			const decorated = this.decorateSummaryText(
				llmText || this.buildCompactSummary(summaryInput),
				older.length,
				true,
			);
			summaryMessage = {
				...summary,
				content: [{ type: "text", text: decorated }],
				timestamp: Date.now(),
			};
			usedModel = true;
		} catch (error) {
			console.warn("LLM compaction failed:", error);
		} finally {
			this.footer.setHint(this.idleFooterHint);
		}

		if (!summaryMessage) {
			const fallbackText = this.decorateSummaryText(
				this.buildCompactSummary(older),
				older.length,
				false,
			);
			summaryMessage = {
				role: "assistant",
				content: [{ type: "text", text: fallbackText }],
				api: this.agent.state.model.api,
				provider: this.agent.state.model.provider,
				model: this.agent.state.model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
		}

		const keep = messages.slice(boundary);
		const newMessages = [summaryMessage as AppMessage, ...keep];
		this.agent.replaceMessages(newMessages);
		this.sessionManager.saveMessage(summaryMessage);

		this.chatContainer.clear();
		this.toolComponents.clear();
		this.renderInitialMessages(this.agent.state);
		this.showInfoMessage(
			usedModel
				? `Compacted ${older.length} messages via model summary.`
				: `Compacted ${older.length} messages with a local summary.`,
		);
	}

	private buildCompactSummary(messages: Message[]): string {
		const lines: string[] = [];
		let exchange = 1;
		for (const message of messages) {
			const text = this.extractPlainText(message).trim();
			if (!text) continue;
			const truncated = this.truncateText(text, 180);
			if (message.role === "user") {
				lines.push(`• User ${exchange}: ${truncated}`);
			} else if (message.role === "assistant") {
				lines.push(`  ↳ Assistant: ${truncated}`);
				exchange += 1;
			} else if (message.role === "toolResult") {
				lines.push(
					`  ↳ Tool ${(message as ToolResultMessage).toolName}: ${this.truncateText(
						this.extractPlainText(message),
						160,
					)}`,
				);
			}
			if (lines.length >= 32) break;
		}
		if (!lines.length) {
			return "(conversation summary placeholder: no textual content to compact)";
		}
		return `Conversation summary generated at ${new Date().toLocaleString()}\n${lines.join("\n")}`;
	}

	private buildSummarizationPrompt(messageCount: number): string {
		return `Summarize the preceding ${messageCount} conversation messages from a coding session.
Provide concise markdown with sections for Summary, Decisions, and Outstanding Work.
Highlight key files, TODOs, and blockers. Limit to 200 words.`;
	}

	private buildSummarizationSystemPrompt(): string {
		return "You are a careful note-taker that distills coding conversations into actionable summaries.";
	}

	private decorateSummaryText(
		text: string,
		compactedCount: number,
		fromModel: boolean,
	): string {
		const meta = fromModel
			? "_Model-generated summary of prior discussion._"
			: "_Local summary of prior discussion (model unavailable)._";
		return `${meta}\n\n${text}\n\n(Compacted ${compactedCount} messages on ${new Date().toLocaleString()})`;
	}

	private extractPlainText(message: Message): string {
		if ((message as any).content === undefined) return "";
		if (typeof (message as any).content === "string") {
			return (message as any).content as string;
		}
		if (Array.isArray((message as any).content)) {
			return (message as any).content
				.filter((block: any) => block.type === "text")
				.map((block: any) => block.text)
				.join("\n");
		}
		return "";
	}

	private truncateText(text: string, limit = 160): string {
		if (text.length <= limit) return text;
		return `${text.slice(0, limit - 1).trim()}…`;
	}

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		// Show error message in the chat
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(chalk.red(`Error: ${errorMessage}`), 1, 0),
		);
		this.ui.requestRender();
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
		if (this.commandPalette) return;
		this.commandPalette = new CommandPaletteComponent(
			this.slashCommands,
			(command) => {
				this.hideCommandPalette();
				const current = this.editor.getText().trim();
				const insertion = `/${command.name} `;
				if (!current) {
					this.editor.setText(insertion);
				} else {
					this.editor.insertText(insertion);
				}
				this.ui.requestRender();
			},
			() => this.hideCommandPalette(),
		);
		this.editorContainer.clear();
		this.editorContainer.addChild(this.commandPalette);
		this.ui.setFocus(this.commandPalette);
		this.ui.requestRender();
	}

	private hideCommandPalette(): void {
		if (!this.commandPalette) return;
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.commandPalette = null;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private showFileSearch(): void {
		if (this.fileSearchComponent) return;
		const files = this.getWorkspaceFileList();
		if (files.length === 0) {
			this.showInfoMessage(
				"No files found. Ensure ripgrep or find is available.",
			);
			return;
		}
		this.fileSearchComponent = new FileSearchComponent(
			files,
			(file) => {
				this.hideFileSearch();
				this.editor.insertText(`${file} `);
				this.ui.requestRender();
			},
			() => this.hideFileSearch(),
		);
		this.editorContainer.clear();
		this.editorContainer.addChild(this.fileSearchComponent);
		this.ui.setFocus(this.fileSearchComponent);
		this.ui.requestRender();
	}

	private hideFileSearch(): void {
		if (!this.fileSearchComponent) return;
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.fileSearchComponent = null;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private handleExportCommand(text: string): void {
		// Parse: /export [lite] [filename]
		const parts = text.split(/\s+/);
		let mode: "html" | "text" = "html";
		let outputPath: string | undefined;
		if (parts.length > 1) {
			if (
				parts[1].toLowerCase() === "lite" ||
				parts[1].toLowerCase() === "text"
			) {
				mode = "text";
				outputPath = parts[2];
			} else {
				outputPath = parts[1];
			}
		}

		try {
			const filePath =
				mode === "text"
					? exportSessionToText(
							this.sessionManager,
							this.agent.state,
							outputPath,
						)
					: exportSessionToHtml(
							this.sessionManager,
							this.agent.state,
							outputPath,
						);

			// Show success message in chat - matching thinking level style
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(chalk.dim(`Session exported to: ${filePath}`), 1, 0),
			);
			this.ui.requestRender();
		} catch (error: any) {
			// Show error message in chat
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(
					chalk.red(
						`Failed to export session: ${error.message || "Unknown error"}`,
					),
					1,
					0,
				),
			);
			this.ui.requestRender();
		}
	}

	private handleSessionCommand(): void {
		// Get session info
		const sessionFile = this.sessionManager.getSessionFile();
		const state = this.agent.state;

		// Count messages
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter(
			(m) => m.role === "assistant",
		).length;
		const toolResults = state.messages.filter(
			(m) => m.role === "toolResult",
		).length;
		const totalMessages = state.messages.length;

		// Count tool calls from assistant messages
		let toolCalls = 0;
		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter(
					(c) => c.type === "toolCall",
				).length;
			}
		}

		// Calculate cumulative usage from all assistant messages (same as footer)
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		const totalTokens =
			totalInput + totalOutput + totalCacheRead + totalCacheWrite;

		// Build info text
		let info = `${chalk.bold("Session Info")}\n\n`;
		info += `${chalk.dim("File:")} ${sessionFile}\n`;
		info += `${chalk.dim("ID:")} ${this.sessionManager.getSessionId()}\n\n`;
		info += `${chalk.bold("Messages")}\n`;
		info += `${chalk.dim("User:")} ${userMessages}\n`;
		info += `${chalk.dim("Assistant:")} ${assistantMessages}\n`;
		info += `${chalk.dim("Tool Calls:")} ${toolCalls}\n`;
		info += `${chalk.dim("Tool Results:")} ${toolResults}\n`;
		info += `${chalk.dim("Total:")} ${totalMessages}\n\n`;
		info += `${chalk.bold("Tokens")}\n`;
		info += `${chalk.dim("Input:")} ${totalInput.toLocaleString()}\n`;
		info += `${chalk.dim("Output:")} ${totalOutput.toLocaleString()}\n`;
		if (totalCacheRead > 0) {
			info += `${chalk.dim("Cache Read:")} ${totalCacheRead.toLocaleString()}\n`;
		}
		if (totalCacheWrite > 0) {
			info += `${chalk.dim("Cache Write:")} ${totalCacheWrite.toLocaleString()}\n`;
		}
		info += `${chalk.dim("Total:")} ${totalTokens.toLocaleString()}\n`;

		if (totalCost > 0) {
			info += `\n${chalk.bold("Cost")}\n`;
			info += `${chalk.dim("Total:")} ${totalCost.toFixed(4)}`;
		}

		// Show info in chat
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleSessionsCommand(text: string): void {
		const parts = text.trim().split(/\s+/);
		const sessions = this.sessionManager.loadAllSessions();
		if (parts.length === 1 || parts[1] === "list") {
			this.showSessionsList(sessions);
			return;
		}

		if (parts[1] === "load" && parts.length >= 3) {
			const index = Number.parseInt(parts[2], 10);
			if (!Number.isFinite(index) || index <= 0) {
				this.showInfoMessage("Usage: /sessions load <number>");
				return;
			}
			if (sessions.length === 0) {
				this.showInfoMessage("No saved sessions to load.");
				return;
			}
			const selected = sessions[index - 1];
			if (!selected) {
				this.showInfoMessage(`No session #${index} found.`);
				return;
			}
			this.sessionManager.setSessionFile(selected.path);
			const loaded = this.sessionManager.loadMessages() as AppMessage[];
			this.agent.replaceMessages(loaded);
			this.applyLoadedSessionContext();
			this.chatContainer.clear();
			this.toolComponents.clear();
			this.renderInitialMessages(this.agent.state);
			this.footer.updateState(this.agent.state);
			this.showInfoMessage(
				`Loaded session ${selected.id} (${selected.messageCount} messages).`,
			);
			return;
		}

		this.showInfoMessage("Usage: /sessions [list|load <number>]");
	}

	private showSessionsList(
		sessions: Array<{
			path: string;
			id: string;
			created: Date;
			modified: Date;
			messageCount: number;
			firstMessage: string;
			allMessagesText: string;
		}>,
	): void {
		this.chatContainer.addChild(new Spacer(1));
		if (sessions.length === 0) {
			this.chatContainer.addChild(
				new Text(chalk.dim("No saved sessions for this project."), 1, 0),
			);
			this.ui.requestRender();
			return;
		}
		const lines = sessions.slice(0, 5).map((session, idx) => {
			const preview = session.firstMessage
				? session.firstMessage.slice(0, 60)
				: "(no messages)";
			return `${idx + 1}. ${chalk.cyan(session.id.slice(0, 8))} · ${chalk.dim(
				session.modified.toLocaleString(),
			)} · ${preview}`;
		});
		this.chatContainer.addChild(
			new Text(
				`${chalk.bold("Sessions")}
${lines.join("\n")}
Use /sessions load <number> to switch.`,
				1,
				0,
			),
		);
		this.ui.requestRender();
	}

	private showInfoMessage(text: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(chalk.dim(text), 1, 0));
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

	private handleToolsCommand(commandText = "/tools"): void {
		const parts = commandText.trim().split(/\s+/);
		if (parts.length > 1 && parts[1] === "clear") {
			if (!existsSync(TOOL_FAILURE_LOG_PATH)) {
				this.showInfoMessage("No tool failure log found to clear.");
				return;
			}
			try {
				writeFileSync(TOOL_FAILURE_LOG_PATH, "");
				this.showInfoMessage("Cleared tool failure log.");
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error ?? "unknown");
				this.showInfoMessage(`Failed to clear log: ${message}`);
			}
			return;
		}
		const tools = this.agent.state.tools ?? [];
		const { recent, counts } = this.getToolFailureData();
		const toolLines = tools.length
			? tools.map((tool) => {
					const label = tool.label ?? tool.name;
					const description = tool.description || "No description provided";
					const failureCount = counts.get(tool.name) ?? 0;
					const failureBadge =
						failureCount > 0 ? ` ${chalk.red(`✗ ${failureCount}`)}` : "";
					return `${chalk.cyan(label)} ${chalk.dim(`(${tool.name})`)}${failureBadge}\n  ${chalk.dim(description)}`;
				})
			: [chalk.dim("No tools are currently registered.")];

		const failureSection = recent.length
			? `${chalk.bold("Recent tool failures")}\n${recent
					.map((entry) => `${entry.timestamp} · ${entry.tool} · ${entry.error}`)
					.join("\n")}`
			: chalk.dim("No recent tool failures logged.");

		const text = `${chalk.bold("Available tools")}
${toolLines.join("\n\n")}\n\n${failureSection}\n\n${chalk.dim("Use /tools clear to reset the failure log.")}`;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(text, 1, 0));
		this.ui.requestRender();
	}

	private handleBugCommand(): void {
		const sessionFile = this.sessionManager.getSessionFile();
		const sessionId = this.sessionManager.getSessionId();
		const model = this.agent.state.model;
		const toolFailureTips = existsSync(TOOL_FAILURE_LOG_PATH)
			? `- ${TOOL_FAILURE_LOG_PATH}`
			: null;
		const filesToShare = [sessionFile, toolFailureTips]
			.filter((value): value is string => Boolean(value))
			.map((path) => `- ${path}`)
			.join("\n");

		const text = `${chalk.bold("Bug report info")}
Session ID: ${sessionId}
Session file: ${sessionFile}
Model: ${model ? `${model.provider}/${model.id}` : "unknown"}
Messages: ${this.agent.state.messages.length}
Tools: ${
			(this.agent.state.tools ?? []).map((tool) => tool.name).join(", ") ||
			"none"
		}

${chalk.bold("Send these files:")}
${filesToShare || chalk.dim("(session file will appear once persisted)")}

Attach them in the bug report so we can replay the session.`;
		const copied = this.copyTextToClipboard(text);

		const copyNote = copied
			? chalk.dim("Bug info copied to clipboard.")
			: chalk.dim("(Could not copy bug info to clipboard.)");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(`${text}\n\n${copyNote}`, 1, 0));
		this.ui.requestRender();
	}

	private handleStatusCommand(): void {
		const snapshot = this.collectHealthSnapshot();
		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		const model = this.agent.state.model
			? `${this.agent.state.model.provider}/${this.agent.state.model.id}`
			: "unknown";
		const thinking = this.agent.state.thinkingLevel ?? "off";
		const telemetry = this.telemetryStatus;
		const telemetryLine = telemetry.enabled
			? `on · ${telemetry.reason}${telemetry.endpoint ? ` → ${telemetry.endpoint}` : ""}`
			: `off · ${telemetry.reason}`;
		const toolLine =
			snapshot.toolFailures > 0
				? `${snapshot.toolFailures} logged${snapshot.toolFailurePath ? ` · ${snapshot.toolFailurePath}` : ""}`
				: "none logged";
		const planLine =
			(snapshot.planGoals ?? 0) > 0
				? `${snapshot.planGoals} goal${snapshot.planGoals === 1 ? "" : "s"} · ${snapshot.planPendingTasks ?? 0} pending`
				: "no saved plans";
		const gitLine = snapshot.gitStatus ?? "unknown (git unavailable)";
		const sessionLine = sessionId
			? `${sessionId}\n${sessionFile}`
			: "No persisted session yet.";

		const text = `${chalk.bold("Status snapshot")} ${chalk.dim(`v${this.version}`)}
${chalk.dim("Model")}: ${model}
${chalk.dim("Thinking")}: ${thinking}
${chalk.dim("Telemetry")}: ${telemetryLine}
${chalk.dim("Git")}: ${gitLine}
${chalk.dim("Plans")}: ${planLine}
${chalk.dim("Tool failures")}: ${toolLine}
${chalk.dim("Session")}: ${sessionLine}

Use /diag for a full diagnostic report.`;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(text, 1, 0));
		this.ui.requestRender();
	}

	private handleReviewCommand(): void {
		const statusResult = this.runGitCommand(["status", "-sb"]);
		const diffResult = this.runGitCommand(["diff", "--stat"]);
		const statusText = statusResult.ok
			? statusResult.stdout.trim() || chalk.dim("Working tree clean.")
			: chalk.red(
					`git status failed: ${
						statusResult.stderr.trim() ||
						statusResult.stdout.trim() ||
						"unknown error"
					}`,
				);
		const diffLinesRaw = diffResult.ok
			? diffResult.stdout.trim()
			: chalk.red(
					`git diff --stat failed: ${
						diffResult.stderr.trim() ||
						diffResult.stdout.trim() ||
						"unknown error"
					}`,
				);
		const diffLines = diffLinesRaw.split("\n");
		const limit = 20;
		const preview = diffLines.slice(0, limit).join("\n");
		const remainder =
			diffLines.length > limit
				? `\n${chalk.dim(`(+${diffLines.length - limit} more lines)`)}`
				: "";
		const diffText =
			diffLinesRaw.trim().length > 0
				? `${preview}${remainder}`
				: chalk.dim("No pending changes.");

		const message = `${chalk.bold("Review snapshot")}
${chalk.dim("Git status")}:
${statusText}

${chalk.dim("Diff stats")}:
${diffText}

${chalk.dim("Next steps")}:
- Use /preview <file> for an inline diff
- Use /plan to revisit saved goals
- Use /status for a lightweight health check`;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(message, 1, 0));
		this.ui.requestRender();
	}

	private handleUndoCommand(text: string): void {
		const parts = text.trim().split(/\s+/);
		if (parts.length < 2) {
			this.showInfoMessage("Usage: /undo <file> [more files]");
			return;
		}
		const targets = parts.slice(1).filter(Boolean);
		if (!targets.length) {
			this.showInfoMessage("Usage: /undo <file> [more files]");
			return;
		}
		const result = this.runGitCommand(["checkout", "--", ...targets]);
		if (!result.ok) {
			const error =
				result.stderr.trim() ||
				result.stdout.trim() ||
				"Failed to undo changes.";
			this.showInfoMessage(error);
			return;
		}
		const summary = `${chalk.bold("Undo complete")}
Reverted changes in:
- ${targets.join("\n- ")}`;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(summary, 1, 0));
		this.ui.requestRender();
	}

	private handleFeedbackCommand(): void {
		const snapshot = this.collectHealthSnapshot();
		const sessionId = this.sessionManager.getSessionId();
		const sessionFile = this.sessionManager.getSessionFile();
		const model = this.agent.state.model
			? `${this.agent.state.model.provider}/${this.agent.state.model.id}`
			: "unknown";
		const plain = `Composer feedback
Version: ${this.version}
Session: ${sessionId}
Session file: ${sessionFile}
Model: ${model}
Git: ${snapshot.gitStatus ?? "unknown"}
Tool failures: ${snapshot.toolFailures}
Plans pending: ${snapshot.planPendingTasks ?? 0}

What happened?

What did you expect instead?

Anything else we should know?`;
		const copied = this.copyTextToClipboard(plain);
		const body = `${chalk.bold("Feedback template")}
${plain}

${copied ? chalk.dim("Copied to clipboard — paste this into Discord or GitHub.") : chalk.dim("Copy failed — select and copy manually.")}`;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(body, 1, 0));
		this.ui.requestRender();
	}

	private handleMentionCommand(text: string): void {
		const files = this.getWorkspaceFileList();
		if (!files.length) {
			this.showInfoMessage("Workspace file index is empty.");
			return;
		}
		const query = text.includes(" ")
			? text.slice(text.indexOf(" ")).trim()
			: "";
		const normalized = query.toLowerCase();
		const matches = files
			.filter((file) =>
				normalized ? file.toLowerCase().includes(normalized) : true,
			)
			.slice(0, 15);
		if (!matches.length) {
			this.showInfoMessage(`No files found matching "${query}".`);
			return;
		}
		const listing = matches
			.map((file, index) => `${index + 1}. @${file}`)
			.join("\n");
		const textBlock = `${chalk.bold("Mention helper")}
${listing}

Use @ in the editor for the interactive search palette.`;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(textBlock, 1, 0));
		this.ui.requestRender();
	}

	private copyTextToClipboard(value: string): boolean {
		try {
			clipboard.writeSync(value);
			return true;
		} catch {
			return false;
		}
	}

	private handlePlanCommand(text: string): void {
		const store = this.loadTodoStore();
		const goals = Object.keys(store);
		if (goals.length === 0) {
			this.showInfoMessage(
				"No plans found. Use the todo tool in a message to create one.",
			);
			this.planHint = null;
			this.refreshFooterHint();
			return;
		}
		const parts = text.trim().split(/\s+/);
		if (parts.length === 1) {
			const summaries = goals.map((goal) => {
				const entry = store[goal];
				const counts = this.countTodoStatuses(entry.items);
				return `${chalk.bold(goal)}\n  Pending: ${counts.pending} · In Progress: ${counts.in_progress} · Completed: ${counts.completed}`;
			});
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(
					`${chalk.bold("Plans")}\n${summaries.join(
						"\n\n",
					)}\n\nUse /plan <goal> to see details.`,
					1,
					0,
				),
			);
			this.ui.requestRender();
			this.planHint = null;
			this.refreshFooterHint();
			return;
		}
		const goalQuery = text.slice(text.indexOf(" ") + 1).trim();
		const goalKey =
			goals.find((goal) => goal.toLowerCase() === goalQuery.toLowerCase()) ??
			goals.find((goal) =>
				goal.toLowerCase().includes(goalQuery.toLowerCase()),
			);
		if (!goalKey) {
			this.showInfoMessage(`No plan found matching "${goalQuery}".`);
			return;
		}
		const entry = store[goalKey];
		const counts = this.countTodoStatuses(entry.items);
		const tasks = entry.items.length
			? entry.items
					.map((item, index) => {
						const status = (item.status ?? "pending") as PlanStatusKey;
						const symbol = PLAN_STATUS_SYMBOLS[status] ?? "[ ]";
						const lines = [`${index + 1}. ${symbol} ${item.content}`];
						lines.push(`   • Status: ${PLAN_STATUS_LABELS[status] ?? status}`);
						lines.push(`   • Priority: ${item.priority ?? "medium"}`);
						if (item.due) lines.push(`   • Due: ${item.due}`);
						if (item.blockedBy?.length)
							lines.push(`   • Blocked by: ${item.blockedBy.join(", ")}`);
						if (item.notes) lines.push(`   • Notes: ${item.notes}`);
						return lines.join("\n");
					})
					.join("\n\n")
			: chalk.dim("No tasks yet — add some with the todo tool.");
		const detail = `${chalk.bold(goalKey)}\nUpdated: ${new Date(entry.updatedAt).toLocaleString()}\nPending: ${counts.pending} · In Progress: ${counts.in_progress} · Completed: ${counts.completed}\n\n${tasks}`;
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(detail, 1, 0));
		this.ui.requestRender();
		const total =
			counts.pending + counts.in_progress + counts.completed ||
			entry.items.length;
		const summary =
			total > 0 ? `${counts.completed}/${total} done` : "no tasks yet";
		this.planHint = `${goalKey}: ${summary}`;
		this.refreshFooterHint();
	}

	private loadTodoStore(): Record<
		string,
		{
			goal: string;
			items: Array<{
				id: string;
				content: string;
				status: string;
				priority: string;
				notes?: string;
				due?: string;
				blockedBy?: string[];
			}>;
			updatedAt: string;
		}
	> {
		try {
			const raw = readFileSync(TODO_STORE_PATH, "utf-8");
			return JSON.parse(raw);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return {};
			}
			return {};
		}
	}

	private countTodoStatuses(
		items: Array<{ status: string }>,
	): Record<PlanStatusKey, number> {
		return items.reduce(
			(acc, item) => {
				const key = (item.status ?? "pending") as PlanStatusKey;
				if (acc[key] !== undefined) {
					acc[key] += 1;
				}
				return acc;
			},
			{ pending: 0, in_progress: 0, completed: 0 } as Record<
				PlanStatusKey,
				number
			>,
		);
	}

	private async handleRunCommand(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		if (parts.length < 2) {
			this.showInfoMessage("Usage: /run <script> [args]");
			return;
		}
		const script = parts[1];
		const args = parts.slice(2).join(" ");
		const command = args ? `npm run ${script} -- ${args}` : `npm run ${script}`;

		this.chatContainer.addChild(new Spacer(1));
		const outputComponent = new Text(
			`${chalk.bold(`$ ${command}`)}\nRunning…`,
			1,
			0,
		);
		this.chatContainer.addChild(outputComponent);
		this.ui.requestRender();

		const result = await this.runShellCommand(command);
		const statusLine = result.success
			? chalk.green(`Exit code ${result.code}`)
			: chalk.red(`Exit code ${result.code}`);
		const body = [result.stdout, result.stderr].filter(Boolean).join("\n");
		outputComponent.setText(
			`${chalk.bold(`$ ${command}`)}\n${body || chalk.dim("(no output)")}\n\n${statusLine}`,
		);
		this.ui.requestRender();
	}

	private async runShellCommand(command: string): Promise<{
		success: boolean;
		code: number;
		stdout: string;
		stderr: string;
	}> {
		return await new Promise((resolve) => {
			const child = spawn("bash", ["-lc", command], {
				cwd: process.cwd(),
				env: process.env,
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("close", (code) => {
				resolve({
					success: code === 0,
					code: code ?? -1,
					stdout: stdout.trimEnd(),
					stderr: stderr.trimEnd(),
				});
			});
			child.on("error", (error) => {
				resolve({
					success: false,
					code: -1,
					stdout,
					stderr:
						error instanceof Error ? error.message : String(error ?? "unknown"),
				});
			});
		});
	}

	private async handlePreviewCommand(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		if (parts.length < 2) {
			this.showInfoMessage("Usage: /preview <file>");
			return;
		}
		const target = parts.slice(1).join(" ");
		const quoted = JSON.stringify(target);
		const result = await this.runShellCommand(`git diff -- ${quoted}`);
		this.chatContainer.addChild(new Spacer(1));
		const content = result.stdout || result.stderr;
		const textOutput = content
			? content
			: chalk.dim(`No differences for ${target}`);
		this.chatContainer.addChild(
			new Text(`${chalk.bold(`git diff -- ${target}`)}\n${textOutput}`, 1, 0),
		);
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

	private getWorkspaceFileList(): string[] {
		if (!this.workspaceFiles.length) {
			this.workspaceFiles = getWorkspaceFiles();
		}
		return this.workspaceFiles;
	}

	private loadRunScripts(): string[] {
		try {
			const pkgPath = join(process.cwd(), "package.json");
			const raw = readFileSync(pkgPath, "utf-8");
			const pkg = JSON.parse(raw);
			return pkg?.scripts ? Object.keys(pkg.scripts) : [];
		} catch {
			return [];
		}
	}

	private getRunScriptCompletions(prefix: string): AutocompleteItem[] | null {
		if (!this.runScripts.length) {
			this.runScripts = this.loadRunScripts();
		}
		if (!this.runScripts.length) {
			return null;
		}
		const lower = prefix.toLowerCase();
		const matches = this.runScripts
			.filter((script) => script.toLowerCase().startsWith(lower))
			.slice(0, 10);
		if (!matches.length) {
			return null;
		}
		return matches.map((script) => ({
			value: script,
			label: script,
			description: "package script",
		}));
	}

	private runGitCommand(args: string[]): {
		ok: boolean;
		stdout: string;
		stderr: string;
	} {
		try {
			const result = spawnSync("git", args, {
				cwd: process.cwd(),
				encoding: "utf-8",
			});
			return {
				ok: (result.status ?? 0) === 0,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
		} catch (error) {
			return {
				ok: false,
				stdout: "",
				stderr:
					error instanceof Error ? error.message : String(error ?? "unknown"),
			};
		}
	}

	private notifyFileChanges(): void {
		try {
			const result = spawnSync("git", ["status", "-sb"], {
				cwd: process.cwd(),
				encoding: "utf-8",
			});
			if ((result.status ?? 0) !== 0) {
				return;
			}
			const lines = result.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && !line.startsWith("##"));
			if (lines.length === 0) {
				this.lastNotifiedChanges = [];
				return;
			}
			const normalized = lines.slice().sort();
			if (
				normalized.length === this.lastNotifiedChanges.length &&
				normalized.every(
					(line, index) => line === this.lastNotifiedChanges[index],
				)
			) {
				return;
			}
			this.lastNotifiedChanges = normalized;
			const files = lines
				.map((line) => line.replace(/^[A-Z?]{1,2}\s+/, ""))
				.filter(Boolean);
			const previewTargets = files.slice(0, 3).join("\n- ");
			const message = `${files.length} file${files.length === 1 ? "" : "s"} modified.\n- ${previewTargets}\nUse /preview <file> to inspect diffs.`;
			this.showToast(message, "info");
		} catch {
			// ignore git errors
		}
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

	private collectHealthSnapshot(): {
		toolFailures: number;
		toolFailurePath?: string;
		gitStatus?: string;
		planGoals?: number;
		planPendingTasks?: number;
	} {
		const { counts } = this.getToolFailureData();
		const totalFailures = Array.from(counts.values()).reduce(
			(sum, value) => sum + value,
			0,
		);
		let gitStatus: string | undefined;
		try {
			const result = spawnSync("git", ["status", "-sb"], {
				cwd: process.cwd(),
				encoding: "utf-8",
			});
			if ((result.status ?? 0) === 0) {
				gitStatus = result.stdout.trim() || "clean";
			}
		} catch (_error) {
			// ignore if git is unavailable
		}
		const store = this.loadTodoStore();
		let pending = 0;
		for (const goal of Object.values(store)) {
			pending += goal.items.filter(
				(item) => (item.status ?? "pending") === "pending",
			).length;
		}
		return {
			toolFailures: totalFailures,
			toolFailurePath: existsSync(TOOL_FAILURE_LOG_PATH)
				? TOOL_FAILURE_LOG_PATH
				: undefined,
			gitStatus,
			planGoals: Object.keys(store).length,
			planPendingTasks: pending,
		};
	}

	private getToolFailureData(limit = 5): {
		recent: Array<{ tool: string; error: string; timestamp: string }>;
		counts: Map<string, number>;
	} {
		const result = {
			recent: [] as Array<{ tool: string; error: string; timestamp: string }>,
			counts: new Map<string, number>(),
		};
		try {
			if (!existsSync(TOOL_FAILURE_LOG_PATH)) {
				return result;
			}
			const raw = readFileSync(TOOL_FAILURE_LOG_PATH, "utf-8");
			const lines = raw
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			for (const line of lines) {
				try {
					const parsed = JSON.parse(line) as {
						tool?: string;
						error?: string;
						timestamp?: string;
					};
					const toolName = parsed.tool ?? "unknown";
					const timestamp = parsed.timestamp
						? new Date(parsed.timestamp).toLocaleString()
						: "unknown time";
					const error = parsed.error ?? "unknown error";
					result.counts.set(toolName, (result.counts.get(toolName) ?? 0) + 1);
					result.recent.push({ tool: toolName, error, timestamp });
				} catch {
					// ignore malformed lines
				}
			}
			result.recent = result.recent.slice(-limit);
			return result;
		} catch {
			return result;
		}
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

	private async handleImportCommand(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		const source = parts[1]?.toLowerCase();
		if (!source || source === "help") {
			this.showInfoMessage("Usage: /import factory");
			return;
		}
		if (source === "factory") {
			try {
				const result = importFactoryConfig();
				reloadModelConfig();
				this.showInfoMessage(
					`Imported ${result.modelCount} model${result.modelCount === 1 ? "" : "s"} from Factory into ${result.targetPath}.`,
				);
			} catch (error: unknown) {
				this.showInfoMessage(
					chalk.red(
						`Factory import failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					),
				);
			}
			return;
		}
		this.showInfoMessage(
			`Unknown import source "${source}". Supported sources: factory`,
		);
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

	private resolveApiKey(): ApiKeyLookupResult {
		const provider = this.agent.state.model.provider;
		const result = lookupApiKey(provider, this.explicitApiKey);
		return result;
	}

	private handleDiagnosticsCommand(commandText = "/diag"): void {
		if (!this.currentApiKeyInfo) {
			this.currentApiKeyInfo = this.resolveApiKey();
		}

		const health = this.collectHealthSnapshot();
		const report = formatDiagnosticsReport({
			sessionId: this.sessionManager.getSessionId(),
			sessionFile: this.sessionManager.getSessionFile(),
			state: this.agent.state,
			modelMetadata: this.currentModelMetadata,
			apiKeyLookup: this.currentApiKeyInfo,
			telemetry: this.telemetryStatus,
			pendingTools: Array.from(this.pendingTools.entries()).map(
				([id, component]) => ({ id, name: component.getToolName() }),
			),
			explicitApiKey: this.explicitApiKey,
			health,
		});

		const shouldCopy = /copy|share/.test(commandText.split(/\s+/)[1] ?? "");
		let copyNote = "";
		if (shouldCopy) {
			const copied = this.copyTextToClipboard(report);
			copyNote = `\n\n${copied ? chalk.dim("Diagnostics copied to clipboard.") : chalk.dim("(Could not copy diagnostics to clipboard.)")}`;
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(`${report}${copyNote}`, 1, 0));
		this.ui.requestRender();
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

class InstructionPanelComponent implements Component {
	private shortcuts = [
		{ keys: "esc", desc: "interrupt" },
		{ keys: "ctrl+c", desc: "clear" },
		{ keys: "ctrl+c×2", desc: "exit" },
		{ keys: "ctrl+k", desc: "delete line" },
		{ keys: "/ command", desc: "commands" },
		{ keys: "drop", desc: "attach files" },
	];

	constructor(private version: string) {}

	render(width: number): string[] {
		const panelWidth = this.calculateWidth(width);
		const innerWidth = Math.max(1, panelWidth - 4);
		const top = chalk.hex("#8b5cf6")(`╭${"─".repeat(panelWidth - 2)}╮`);
		const title = this.centerText(
			`composer v${this.version} · EvalOps`,
			innerWidth,
		);
		const titleLine = `${chalk.hex("#8b5cf6")("│ ")}${chalk
			.hex("#e2e8f0")
			.bold(title)}${chalk.hex("#8b5cf6")(" │")}`;
		const separator = chalk.hex("#8b5cf6")(`├${"─".repeat(panelWidth - 2)}┤`);
		const keyWidth = Math.min(16, Math.max(10, Math.floor(innerWidth * 0.4)));
		const descWidth = Math.max(8, innerWidth - keyWidth - 1);
		const rows = this.shortcuts.map(({ keys, desc }) => {
			const keyLabel = chalk.hex("#f1c0e8").bold(this.padText(keys, keyWidth));
			const descLabel = chalk.hex("#94a3b8")(this.padText(desc, descWidth));
			return `${chalk.hex("#8b5cf6")("│ ")}${keyLabel} ${descLabel}${chalk.hex("#8b5cf6")(" │")}`;
		});
		const bottom = chalk.hex("#8b5cf6")(`╰${"─".repeat(panelWidth - 2)}╯`);
		return [top, titleLine, separator, ...rows, bottom];
	}

	private calculateWidth(terminalWidth: number): number {
		const maxWidth = Math.max(36, Math.floor(terminalWidth * 0.75));
		return Math.max(32, Math.min(maxWidth, terminalWidth - 2));
	}

	private padText(text: string, width: number): string {
		const length = visibleWidth(text);
		if (length >= width) {
			return text;
		}
		return `${text}${" ".repeat(width - length)}`;
	}

	private centerText(text: string, width: number): string {
		const length = visibleWidth(text);
		if (length >= width) {
			return text;
		}
		const totalPad = width - length;
		const left = Math.floor(totalPad / 2);
		const right = totalPad - left;
		return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
	}
}
