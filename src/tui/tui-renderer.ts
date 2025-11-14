import type { Agent } from "../agent/agent.js";
import type {
	AgentEvent,
	AgentState,
	AssistantMessage,
	AppMessage,
	Message,
	ThinkingLevel,
	ToolResultMessage,
} from "../agent/types.js";
import type { SlashCommand } from "../tui-lib/index.js";
import {
	CombinedAutocompleteProvider,
	Container,
	Loader,
	ProcessTerminal,
	Spacer,
	TUI,
	Text,
	visibleWidth,
	type Component,
} from "../tui-lib/index.js";
import chalk from "chalk";
import { exportSessionToHtml, exportSessionToText } from "../export-html.js";
import type { RegisteredModel } from "../models/registry.js";
import { getRegisteredModels, reloadModelConfig } from "../models/registry.js";
import {
	toSessionModelMetadata,
	type SessionModelMetadata,
} from "../session-manager.js";
import type { SessionManager } from "../session-manager.js";
import type { ApiKeyLookupResult } from "../providers/api-keys.js";
import { getEnvVarsForProvider, lookupApiKey } from "../providers/api-keys.js";
import { getTelemetryStatus, recordLoaderStage } from "../telemetry.js";
import { formatDiagnosticsReport } from "./diagnostics.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { CustomEditor } from "./custom-editor.js";
import { FooterComponent } from "./footer.js";
import { ModelSelectorComponent } from "./model-selector.js";
import { ThinkingSelectorComponent } from "./thinking-selector.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";
import { WelcomeAnimation } from "./welcome-animation.js";
import { importFactoryConfig } from "../factory-sync.js";

type LoaderStage = {
	key: string;
	label: string;
};

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
	private loadingAnimation: Loader | null = null;
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

	// Loader stage tracking
	private loaderStages: LoaderStage[] = [];
	private loaderToolStageMeta = new Map<string, { toolName: string }>();
	private toolStagesByName = new Map<string, string[]>();
	private completedToolStages = new Set<string>();
	private completedStageKeys = new Set<string>();
	private currentStageKey: string | null = null;
	private stageStartTime: number | null = null;
	private readonly idleFooterHint = "Use /model or /thinking to tune replies";
	private compactToolOutputs = false;
	private toolComponents = new Set<ToolExecutionComponent>();

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

		// Define slash commands
		const thinkingCommand: SlashCommand = {
			name: "thinking",
			description: "Select reasoning level (opens selector UI)",
		};

		const modelCommand: SlashCommand = {
			name: "model",
			description: "Select model (opens selector UI)",
		};

		const exportCommand: SlashCommand = {
			name: "export",
			description: "Export session to HTML file",
		};

		const importCommand: SlashCommand = {
			name: "import",
			description: "Import configuration (e.g. /import factory)",
		};

		const sessionCommand: SlashCommand = {
			name: "session",
			description: "Show session info and stats",
		};

		const sessionsCommand: SlashCommand = {
			name: "sessions",
			description: "List or load recent sessions",
		};

		const diagnosticsCommand: SlashCommand = {
			name: "diag",
			description: "Show provider/model/API key diagnostics",
		};

		const compactToolsCommand: SlashCommand = {
			name: "compact-tools",
			description: "Toggle folding of tool outputs",
		};

		const compactCommand: SlashCommand = {
			name: "compact",
			description: "Summarize older messages to reclaim context",
		};

		const quitCommand: SlashCommand = {
			name: "quit",
			description: "Exit composer (same as ctrl+c twice)",
		};

		// Setup autocomplete for file paths and slash commands
		const autocompleteProvider = new CombinedAutocompleteProvider(
			[
				thinkingCommand,
				modelCommand,
				exportCommand,
				importCommand,
				sessionCommand,
				sessionsCommand,
				diagnosticsCommand,
				compactCommand,
				compactToolsCommand,
				quitCommand,
			],
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
		this.footer.setHint(this.idleFooterHint);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		// Set up custom key handlers on the editor
		this.editor.onEscape = () => {
			// Intercept Escape key when processing
			if (this.loadingAnimation && this.onInterruptCallback) {
				this.onInterruptCallback();
			}
		};

		this.editor.onCtrlC = () => {
			this.handleCtrlC();
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

			// Check for /thinking command
			if (trimmed === "/thinking") {
				// Show thinking level selector
				this.showThinkingSelector();
				this.editor.setText("");
				return;
			}

			// Check for /model command
			if (trimmed === "/model") {
				// Show model selector
				this.showModelSelector();
				this.editor.setText("");
				return;
			}

				// Check for /export command
				if (trimmed.startsWith("/export")) {
					this.handleExportCommand(trimmed);
					this.editor.setText("");
					return;
				}

				if (trimmed.startsWith("/import")) {
					void this.handleImportCommand(trimmed);
					this.editor.setText("");
					return;
				}

			// Check for /session command
			if (trimmed === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}

			if (trimmed.startsWith("/sessions")) {
				this.handleSessionsCommand(trimmed);
				this.editor.setText("");
				return;
			}

			// Check for /diag command
			if (trimmed === "/diag" || trimmed === "/diagnostics") {
				this.handleDiagnosticsCommand();
				this.editor.setText("");
				return;
			}

			if (trimmed === "/compact") {
				void this.handleCompactCommand();
				this.editor.setText("");
				return;
			}

			if (trimmed.startsWith("/compact-tools")) {
				this.handleCompactToolsCommand(trimmed);
				this.editor.setText("");
				return;
			}

			if (trimmed === "/quit" || trimmed === "/exit") {
				this.stop();
				process.exit(0);
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
				// Show loading animation
				this.editor.disableSubmit = true;
				// Stop old loader before clearing
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
				}
				this.statusContainer.clear();
				this.resetLoaderProgressTracking();
				this.loadingAnimation = new Loader(
					this.ui,
					"Planning",
				);
				this.loadingAnimation.setHint("(esc to interrupt)");
				this.loadingAnimation.setTitle("Active tasks");
				this.statusContainer.addChild(this.loadingAnimation);
				this.updateLoaderStage("planning");
				this.footer.setHint("Working… press esc to interrupt");
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "user") {
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
					this.ui.requestRender();
					if (this.loadingAnimation) {
						const noToolStages = this.loaderToolStageMeta.size === 0;
						const allToolsComplete =
							this.loaderToolStageMeta.size > 0 &&
							this.completedToolStages.size ===
								this.loaderToolStageMeta.size;
						if (noToolStages || allToolsComplete) {
							this.updateLoaderStage("responding");
						}
					}
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
					const assistantMsg = event.message as AssistantMessage;

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
					this.updateLoaderStage("responding");
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				this.registerToolStage(event.toolCallId, event.toolName);
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
				this.completedToolStages.add(event.toolCallId);
				if (
					this.loaderToolStageMeta.size > 0 &&
					this.completedToolStages.size === this.loaderToolStageMeta.size
				) {
					this.updateLoaderStage("responding");
				}
				break;
			}

			case "agent_end":
				// Stop loading animation
				if (this.loadingAnimation) {
					if (this.currentStageKey) {
						this.completedStageKeys.add(this.currentStageKey);
						this.refreshLoaderProgress();
						this.loadingAnimation.setProgress(1);
					}
					this.loadingAnimation.stop();
					this.loadingAnimation = null;
					this.statusContainer.clear();
				}
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = null;
				}
				this.pendingTools.clear();
				this.clearLoaderProgressTracking();
				this.editor.disableSubmit = false;
				this.footer.setHint(this.idleFooterHint);
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
				const textBlocks = userMsg.content.filter((c: any) => c.type === "text");
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
		return `Summarize the preceding ${messageCount} conversation messages from a coding session.` +
			"\nProvide concise markdown with sections for Summary, Decisions, and Outstanding Work." +
			"\nHighlight key files, TODOs, and blockers. Limit to 200 words.";
	}

	private buildSummarizationSystemPrompt(): string {
		return "You are a careful note-taker that distills coding conversations into actionable summaries.";
	}

	private decorateSummaryText(text: string, compactedCount: number, fromModel: boolean): string {
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

	private handleExportCommand(text: string): void {
		// Parse: /export [lite] [filename]
		const parts = text.split(/\s+/);
		let mode: "html" | "text" = "html";
		let outputPath: string | undefined;
		if (parts.length > 1) {
			if (parts[1].toLowerCase() === "lite" || parts[1].toLowerCase() === "text") {
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

	private showSessionsList(sessions: Array<{
		path: string;
		id: string;
		created: Date;
		modified: Date;
		messageCount: number;
		firstMessage: string;
		allMessagesText: string;
	}>): void {
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

	private handleDiagnosticsCommand(): void {
		if (!this.currentApiKeyInfo) {
			this.currentApiKeyInfo = this.resolveApiKey();
		}

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
		});

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(report, 1, 0));
		this.ui.requestRender();
	}

	stop(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = null;
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}


	private resetLoaderProgressTracking(): void {
		this.finalizeStageTiming();
		this.loaderStages = [
			{ key: "planning", label: "Planning" },
			{ key: "responding", label: "Responding" },
		];
		this.loaderToolStageMeta.clear();
		this.toolStagesByName.clear();
		this.completedToolStages.clear();
		this.completedStageKeys.clear();
		this.currentStageKey = null;
		this.stageStartTime = null;
		this.footer.setStage(null);
	}

	private clearLoaderProgressTracking(): void {
		this.finalizeStageTiming();
		this.loaderStages = [];
		this.loaderToolStageMeta.clear();
		this.toolStagesByName.clear();
		this.completedToolStages.clear();
		this.completedStageKeys.clear();
		this.currentStageKey = null;
		this.stageStartTime = null;
		this.footer.setStage(null);
		if (this.loadingAnimation) {
			this.loadingAnimation.setProgress(null);
		}
	}

	private updateLoaderStage(key: string, labelOverride?: string): void {
		if (!this.loadingAnimation) return;
		const now = Date.now();
		const stageChanged = this.currentStageKey !== key;
		if (stageChanged && this.currentStageKey && this.stageStartTime) {
			this.recordStageTiming(
				this.currentStageKey,
				now - this.stageStartTime,
			);
		}
		const previousStageKey = stageChanged ? this.currentStageKey : null;
		let index = this.loaderStages.findIndex((stage) => stage.key === key);
		if (index === -1) {
			const label = labelOverride ?? this.formatStageLabel(key);
			this.loaderStages.push({ key, label });
			index = this.loaderStages.length - 1;
		} else if (labelOverride) {
			this.loaderStages[index].label = labelOverride;
		}
		if (previousStageKey) {
			this.completedStageKeys.add(previousStageKey);
		}
		const stage = this.loaderStages[index];
		this.currentStageKey = key;
		if (stageChanged) {
			this.stageStartTime = now;
		}
		this.loadingAnimation.setStage(stage.label, index + 1, this.loaderStages.length);
		this.refreshLoaderProgress();
		this.footer.setStage(stage.label);
	}

	private formatStageLabel(key: string): string {
		if (key === "planning") return "Planning";
		if (key === "responding") return "Responding";
		const toolMeta = this.loaderToolStageMeta.get(key);
		if (toolMeta) {
			return `Tool · ${toolMeta.toolName}`;
		}
		return key;
	}

	private refreshLoaderProgress(): void {
		if (!this.loadingAnimation || !this.currentStageKey) return;
		const total = this.loaderStages.length;
		if (total === 0) {
			this.loadingAnimation.setProgress(null);
			return;
		}
		const completedCount = this.loaderStages.reduce((count, stage) => {
			return this.completedStageKeys.has(stage.key) ? count + 1 : count;
		}, 0);
		const currentStageCompleted = this.completedStageKeys.has(
			this.currentStageKey,
		);
		const currentPartial = currentStageCompleted
			? 0
			: this.getCurrentStageProgress(this.currentStageKey);
		const rawProgress = (completedCount + currentPartial) / total;
		const normalized = Math.min(0.99, Math.max(0, rawProgress));
		this.loadingAnimation.setProgress(normalized);
	}

	private getCurrentStageProgress(stageKey: string): number {
		if (stageKey === "responding") {
			return this.streamingComponent ? 0.6 : 0.85;
		}
		if (stageKey === "planning") {
			return 0.4;
		}
		if (this.loaderToolStageMeta.has(stageKey)) {
			return this.pendingTools.has(stageKey) ? 0.5 : 0.75;
		}
		return 0.3;
	}

	private registerToolStage(toolCallId: string, toolName: string): void {
		if (!this.loadingAnimation) return;
		if (this.loaderToolStageMeta.has(toolCallId)) {
			this.updateLoaderStage(toolCallId);
			return;
		}
		this.loaderToolStageMeta.set(toolCallId, { toolName });
		const respondingIndex = this.loaderStages.findIndex(
			(stage) => stage.key === "responding",
		);
		const insertIndex =
			respondingIndex === -1 ? this.loaderStages.length : respondingIndex;
		this.loaderStages.splice(insertIndex, 0, {
			key: toolCallId,
			label: `Tool · ${toolName}`,
		});
		const group = this.toolStagesByName.get(toolName) ?? [];
		group.push(toolCallId);
		this.toolStagesByName.set(toolName, group);
		this.refreshToolStageLabels(toolName);
		this.updateLoaderStage(toolCallId);
	}

	private refreshToolStageLabels(toolName: string): void {
		const entries = this.toolStagesByName.get(toolName);
		if (!entries || entries.length === 0) return;
		const total = entries.length;
		entries.forEach((key, index) => {
			const label =
				total > 1
					? `Tool · ${toolName} (${index + 1}/${total})`
					: `Tool · ${toolName}`;
			this.renameStage(key, label);
		});
	}

	private renameStage(key: string, label: string): void {
		const stage = this.loaderStages.find((entry) => entry.key === key);
		if (!stage) return;
		stage.label = label;
		if (this.currentStageKey === key && this.loadingAnimation) {
			const index = this.loaderStages.findIndex((entry) => entry.key === key);
			this.loadingAnimation.setStage(label, index + 1, this.loaderStages.length);
			this.footer.setStage(label);
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

	private finalizeStageTiming(): void {
		if (this.currentStageKey && this.stageStartTime) {
			this.recordStageTiming(this.currentStageKey, Date.now() - this.stageStartTime);
		}
		this.stageStartTime = null;
	}

	private recordStageTiming(stageKey: string, durationMs: number): void {
		if (!this.telemetryStatus.enabled) return;
		const stage = this.loaderStages.find((entry) => entry.key === stageKey);
		const label = stage?.label ?? stageKey;
		recordLoaderStage(label, durationMs, {
			stageKey,
			stages: this.loaderStages.map((entry) => entry.label),
		});
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
		const separator = chalk.hex("#8b5cf6")(
			`├${"─".repeat(panelWidth - 2)}┤`,
		);
		const keyWidth = Math.min(16, Math.max(10, Math.floor(innerWidth * 0.4)));
		const descWidth = Math.max(8, innerWidth - keyWidth - 1);
		const rows = this.shortcuts.map(({ keys, desc }) => {
			const keyLabel = chalk
				.hex("#f1c0e8")
				.bold(this.padText(keys, keyWidth));
			const descLabel = chalk
				.hex("#94a3b8")
				(this.padText(desc, descWidth));
			return `${chalk.hex("#8b5cf6")("│ ")}${keyLabel} ${descLabel}${chalk.hex("#8b5cf6")(" │")}`;
		});
		const bottom = chalk.hex("#8b5cf6")(
			`╰${"─".repeat(panelWidth - 2)}╯`,
		);
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
