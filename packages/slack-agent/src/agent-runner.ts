/**
 * Agent Runner - Connects Slack messages to Composer's Agent
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type ConversationTurn,
	formatSummarizedContext,
	summarizeContext,
} from "./context-summarizer.js";
import { CostTracker } from "./cost-tracker.js";
import * as logger from "./logger.js";
import { type SandboxConfig, createExecutor } from "./sandbox.js";
import type { ChannelInfo, SlackContext, UserInfo } from "./slack/bot.js";
import type { ChannelStore } from "./store.js";
import { createSlackAgentTools, setUploadFunction } from "./tools/index.js";
import { ensureDir } from "./utils/fs.js";
import { splitForSlack } from "./utils/split-for-slack.js";

// Import from main composer source
import { Agent } from "../../../src/agent/agent.js";
import { ProviderTransport } from "../../../src/agent/transport.js";
import type {
	AgentEvent,
	AgentTool,
	Api,
	AssistantMessage,
	Message,
	Model,
	TextContent,
	ThinkingContent,
} from "../../../src/agent/types.js";
import { getModel } from "../../../src/models/builtin.js";

/**
 * Retry configuration for transient failures
 */
export interface RetryConfig {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
	maxAttempts: 3,
	baseDelayMs: 1000,
	maxDelayMs: 30000,
};

/**
 * Check if an error is likely transient and retryable
 */
export function isRetryableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	const message = error.message.toLowerCase();

	// Rate limit errors
	if (message.includes("rate limit") || message.includes("429")) return true;

	// Timeout errors
	if (message.includes("timeout") || message.includes("timed out")) return true;

	// Network errors
	if (
		message.includes("network") ||
		message.includes("econnreset") ||
		message.includes("econnrefused") ||
		message.includes("socket hang up") ||
		message.includes("fetch failed")
	)
		return true;

	// Server errors (5xx)
	if (
		message.includes("500") ||
		message.includes("502") ||
		message.includes("503") ||
		message.includes("504") ||
		message.includes("internal server error") ||
		message.includes("service unavailable") ||
		message.includes("bad gateway")
	)
		return true;

	// Overload errors
	if (message.includes("overloaded") || message.includes("capacity"))
		return true;

	return false;
}

/**
 * Execute a function with exponential backoff retry
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	config: RetryConfig = DEFAULT_RETRY_CONFIG,
	onRetry?: (attempt: number, error: Error, delayMs: number) => void,
): Promise<T> {
	let lastError: Error | undefined;

	for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			// Don't retry if it's not a retryable error or if it's the last attempt
			if (!isRetryableError(error) || attempt === config.maxAttempts) {
				throw lastError;
			}

			// Calculate delay with exponential backoff and jitter
			const exponentialDelay = config.baseDelayMs * 2 ** (attempt - 1);
			const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
			const delayMs = Math.min(exponentialDelay + jitter, config.maxDelayMs);

			if (onRetry) {
				onRetry(attempt, lastError, delayMs);
			}

			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	throw lastError;
}

export interface AgentRunner {
	run(
		ctx: SlackContext,
		channelDir: string,
		store: ChannelStore,
	): Promise<AgentRunResult>;
	abort(): void;
}

export interface AgentRunResult {
	stopReason: string;
	durationMs: number;
	toolsExecuted: number;
	cost: {
		total: number;
		inputTokens: number;
		outputTokens: number;
		cacheWriteTokens: number;
		cacheReadTokens: number;
		model?: string | null;
	};
}

// Slack timestamp helpers
let lastTsMs = 0;
let tsCounter = 0;

function toSlackTs(): string {
	const now = Date.now();
	if (now === lastTsMs) {
		tsCounter++;
	} else {
		lastTsMs = now;
		tsCounter = 0;
	}
	const seconds = Math.floor(now / 1000);
	const micros = (now % 1000) * 1000 + tsCounter;
	return `${seconds}.${micros.toString().padStart(6, "0")}`;
}

function getAnthropicApiKey(): string {
	const key =
		process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
	if (!key) {
		throw new Error("ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY must be set");
	}
	return key;
}

interface LogMessage {
	date?: string;
	ts?: string;
	threadTs?: string;
	user?: string;
	userName?: string;
	text?: string;
	attachments?: Array<{
		local: string;
		original?: string;
		mimetype?: string;
		filetype?: string;
		size?: number;
	}>;
	isBot?: boolean;
}

interface Thread {
	parentTs: string;
	messages: LogMessage[];
}

/**
 * Parse log messages into conversation turns with thread structure
 */
function parseLogMessages(channelDir: string): ConversationTurn[] {
	const logPath = join(channelDir, "log.jsonl");
	if (!existsSync(logPath)) {
		return [];
	}

	const content = readFileSync(logPath, "utf-8");
	const lines = content.trim().split("\n").filter(Boolean);

	if (lines.length === 0) {
		return [];
	}

	const messages: LogMessage[] = [];
	for (const line of lines) {
		try {
			messages.push(JSON.parse(line));
		} catch {
			// Skip malformed lines
		}
	}
	messages.sort((a, b) => {
		const tsA = Number.parseFloat(a.ts || "0");
		const tsB = Number.parseFloat(b.ts || "0");
		return tsA - tsB;
	});

	// Group messages by thread
	const threads = new Map<string, Thread>();
	const topLevelMessages: LogMessage[] = [];

	for (const msg of messages) {
		if (msg.threadTs) {
			// This is a reply in a thread
			const thread = threads.get(msg.threadTs);
			if (thread) {
				thread.messages.push(msg);
			} else {
				// Thread parent might come later or be missing
				threads.set(msg.threadTs, { parentTs: msg.threadTs, messages: [msg] });
			}
		} else {
			// Top-level message (might be a thread parent)
			topLevelMessages.push(msg);
			// Check if this is a thread parent
			if (!threads.has(msg.ts || "")) {
				threads.set(msg.ts || "", { parentTs: msg.ts || "", messages: [] });
			}
		}
	}

	// Convert to ConversationTurn format
	const turns: ConversationTurn[] = [];
	for (const msg of topLevelMessages) {
		const thread = threads.get(msg.ts || "");
		const turn: ConversationTurn = {
			date: msg.date || "",
			user: msg.userName || msg.user || "",
			text: msg.text || "",
			isBot: msg.isBot === true,
			attachments: msg.attachments?.map((a) => a.local),
		};

		// Include thread replies
		if (thread && thread.messages.length > 0) {
			turn.threadReplies = thread.messages.map((reply) => ({
				date: reply.date || "",
				user: reply.userName || reply.user || "",
				text: reply.text || "",
			}));
		}

		turns.push(turn);
	}

	return turns;
}

/**
 * Get recent messages with optional summarization of older turns
 */
function getRecentMessages(channelDir: string, turnCount: number): string {
	const turns = parseLogMessages(channelDir);

	if (turns.length === 0) {
		return "(no message history yet)";
	}

	// Limit to the requested number of turns
	const limitedTurns = turns.slice(-turnCount);

	// Apply summarization (keeps recent 10 verbatim, summarizes older)
	const summarized = summarizeContext(limitedTurns, channelDir, {
		recentTurnCount: 10,
		minTurnsForSummary: 15,
		maxSummaryChars: 2000,
	});

	return formatSummarizedContext(summarized);
}

function getMemory(channelDir: string): string {
	const parts: string[] = [];

	const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Global Workspace Memory\n${content}`);
			}
		} catch (error) {
			logger.logWarning(
				"Failed to read workspace memory",
				`${workspaceMemoryPath}: ${error}`,
			);
		}
	}

	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Channel-Specific Memory\n${content}`);
			}
		} catch (error) {
			logger.logWarning(
				"Failed to read channel memory",
				`${channelMemoryPath}: ${error}`,
			);
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	return parts.join("\n\n");
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
): string {
	const channelPath = `${workspacePath}/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";

	const channelMappings =
		channels.length > 0
			? channels.map((c) => `${c.id}\t#${c.name}`).join("\n")
			: "(no channels loaded)";

	const userMappings =
		users.length > 0
			? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n")
			: "(no users loaded)";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	const currentDate = new Date().toISOString().split("T")[0];
	const currentDateTime = new Date().toISOString();

	return `You are a Slack bot assistant. Be concise. No emojis.

## Context
- Date: ${currentDate} (${currentDateTime})
- You receive the last 50 conversation turns. If you need older context, search log.jsonl.

## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).

## Slack IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@username> format (e.g., <@mario>).

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Global memory (all channels)
├── skills/                      # Global CLI tools you create
└── ${channelId}/                # This channel
    ├── MEMORY.md                # Channel-specific memory
    ├── log.jsonl                # Full message history
    ├── attachments/             # User-shared files
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).
Store in \`${workspacePath}/skills/<name>/\` or \`${channelPath}/skills/<name>/\`.
Each skill needs a \`SKILL.md\` documenting usage. Read it before using a skill.
List skills in global memory so you remember them.

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## Tools
- bash: Run shell commands (primary tool). Install packages as needed. Destructive commands require user approval.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to Slack
- status: Check system health, resource usage (CPU, memory), and workspace disk usage
- schedule: Schedule tasks for future execution (one-time or recurring)

Each tool requires a "label" parameter (shown to user).

Use the status tool when:
- User asks about your status, health, or resources
- Before running memory-intensive tasks
- Debugging performance issues

Use the schedule tool for:
- Reminders: "remind me in 2 hours to check deployment"
- One-time tasks: "tomorrow at 9am run the test suite"
- Recurring tasks: "every day at 9am summarize commits"
`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (
			result as { content: Array<{ type: string; text?: string }> }
		).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

/**
 * Callback to request approval for destructive commands
 * Returns true if approved, false if rejected/timeout
 */
export type ApprovalRequestCallback = (
	command: string,
	description: string,
) => Promise<boolean>;

/**
 * Callbacks for scheduling tasks
 */
export interface ScheduleCallbacks {
	onSchedule: (
		description: string,
		prompt: string,
		when: string,
	) => Promise<{
		success: boolean;
		taskId?: string;
		nextRun?: string;
		error?: string;
	}>;
	onListTasks: () => Promise<
		Array<{
			id: string;
			description: string;
			nextRun: string;
			recurring: boolean;
		}>
	>;
	onCancelTask: (
		taskId: string,
	) => Promise<{ success: boolean; error?: string }>;
}

export interface AgentRunnerOptions {
	/** Enable extended thinking mode */
	thinking?: boolean;
	/** Callback to request approval for destructive commands */
	onApprovalNeeded?: ApprovalRequestCallback;
	/** Callbacks for scheduling tasks */
	scheduleCallbacks?: ScheduleCallbacks;
}

export function createAgentRunner(
	sandboxConfig: SandboxConfig,
	workingDir?: string,
	options?: AgentRunnerOptions,
): AgentRunner {
	let agent: Agent | null = null;
	const executor = createExecutor(sandboxConfig);
	const costTracker = workingDir ? new CostTracker(workingDir) : null;
	const thinkingLevel = options?.thinking ? "medium" : "off";

	return {
		async run(
			ctx: SlackContext,
			channelDir: string,
			store: ChannelStore,
		): Promise<AgentRunResult> {
			const runStartMs = Date.now();
			await ensureDir(channelDir);

			// Wait for any file downloads to complete before processing
			if (ctx.message.attachments.length > 0) {
				logger.logInfo(
					`Waiting for ${ctx.message.attachments.length} file download(s)...`,
				);
				await store.waitForDownloads();
			}

			const channelId = ctx.message.channel;
			const workspacePath = executor.getWorkspacePath(
				channelDir.replace(`/${channelId}`, ""),
			);
			const recentMessages = getRecentMessages(channelDir, 50);
			const memory = getMemory(channelDir);

			// Build file content section for code/text files attached to current message
			let fileContentSection = "";
			for (const attachment of ctx.message.attachments) {
				const content = store.readAttachmentContent(attachment);
				if (content) {
					const truncated =
						content.length > 50000
							? `${content.substring(0, 50000)}\n\n... (truncated, ${content.length} chars total)`
							: content;
					fileContentSection += `\n### File: ${attachment.original}\nPath: ${attachment.local}\n\`\`\`\n${truncated}\n\`\`\`\n`;
				}
			}
			if (fileContentSection) {
				fileContentSection = `\n## Attached Files (content)\n${fileContentSection}`;
			}
			const systemPrompt = buildSystemPrompt(
				workspacePath,
				channelId,
				memory,
				sandboxConfig,
				ctx.channels,
				ctx.users,
			);

			logger.logInfo(
				`Context sizes - system: ${systemPrompt.length} chars, messages: ${recentMessages.length} chars, memory: ${memory.length} chars`,
			);

			// Set up file upload function for the attach tool
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(
					filePath,
					channelDir,
					workspacePath,
					channelId,
				);
				await ctx.uploadFile(hostPath, title);
			});

			// Create tools with executor
			const tools = createSlackAgentTools(executor, {
				containerName: executor.getContainerName(),
				onApprovalNeeded: options?.onApprovalNeeded,
				scheduleOptions: options?.scheduleCallbacks,
			});

			// Get the model - default to Claude Sonnet 4
			const model = getModel(
				"anthropic",
				"claude-sonnet-4-20250514",
			) as Model<Api>;
			if (!model) {
				throw new Error("Failed to get Claude Sonnet 4 model");
			}

			// Create transport
			const transport = new ProviderTransport({
				getApiKey: async (provider: string) => {
					if (provider === "anthropic") {
						return getAnthropicApiKey();
					}
					throw new Error(`Unsupported provider: ${provider}`);
				},
			});

			// Create agent
			agent = new Agent({
				transport,
				initialState: {
					systemPrompt,
					model,
					thinkingLevel,
					tools: tools as AgentTool[],
				},
			});

			const logCtx: logger.LogContext = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
				threadTs: ctx.message.threadTs,
				runId: ctx.runId,
				taskId: ctx.taskId,
				source: ctx.source,
			};

			const pendingTools = new Map<
				string,
				{ toolName: string; args: unknown; startTime: number }
			>();

			let stopReason = "stop";
			const SLACK_MAX_LENGTH = 40000;
			let runCostTotal = 0;
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheWriteTokens = 0;
			let cacheReadTokens = 0;
			let modelUsed: string | null = null;

			// Progress indicator - update status every 30 seconds during long operations
			let lastStatusUpdate = Date.now();
			let toolsExecuted = 0;
			const STATUS_UPDATE_INTERVAL = 30000; // 30 seconds

			const maybeUpdateStatus = async () => {
				const now = Date.now();
				if (now - lastStatusUpdate >= STATUS_UPDATE_INTERVAL) {
					lastStatusUpdate = now;
					const pendingCount = pendingTools.size;
					let status = "Still working";
					if (toolsExecuted > 0) {
						status += ` (${toolsExecuted} tool${toolsExecuted > 1 ? "s" : ""} run)`;
					}
					if (pendingCount > 0) {
						const pendingNames = Array.from(pendingTools.values())
							.map((t) => t.toolName)
							.join(", ");
						status += ` - running: ${pendingNames}`;
					}
					try {
						await ctx.updateStatus(status);
					} catch {
						// Ignore status update errors
					}
				}
			};

			const splitForSlackText = (text: string): string[] =>
				splitForSlack(text, { maxLength: SLACK_MAX_LENGTH });

			// Promise queue for ordered Slack responses
			const queue = {
				chain: Promise.resolve(),
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					this.chain = this.chain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							logger.logWarning(`Slack API error (${errorContext})`, errMsg);
							try {
								await ctx.respondInThread(`_Error: ${errMsg}_`);
							} catch {
								// Ignore
							}
						}
					});
				},
				enqueueMessage(
					text: string,
					target: "main" | "thread",
					errorContext: string,
					log = true,
				): void {
					const parts = splitForSlackText(text);
					for (const part of parts) {
						this.enqueue(
							() =>
								target === "main"
									? ctx.respond(part, log)
									: ctx.respondInThread(part),
							errorContext,
						);
					}
				},
				flush(): Promise<void> {
					return this.chain;
				},
			};

			// Subscribe to agent events
			agent.subscribe(async (event: AgentEvent) => {
				switch (event.type) {
					case "tool_execution_start": {
						const args = event.args as { label?: string };
						const label = args?.label || event.toolName;

						pendingTools.set(event.toolCallId, {
							toolName: event.toolName,
							args: event.args,
							startTime: Date.now(),
						});

						logger.logToolStart(
							logCtx,
							event.toolName,
							label,
							event.args as Record<string, unknown>,
						);

						await store.logMessage(ctx.message.channel, {
							date: new Date().toISOString(),
							ts: toSlackTs(),
							user: "bot",
							text: `[Tool] ${event.toolName}: ${JSON.stringify(event.args)}`,
							attachments: [],
							isBot: true,
						});

						queue.enqueue(
							() => ctx.respond(`_-> ${label}_`, false),
							"tool label",
						);
						break;
					}

					case "tool_execution_end": {
						const resultStr = extractToolResultText(event.result);
						const pending = pendingTools.get(event.toolCallId);
						pendingTools.delete(event.toolCallId);
						toolsExecuted++;

						const durationMs = pending ? Date.now() - pending.startTime : 0;

						// Check if we should update progress status
						await maybeUpdateStatus();

						if (event.isError) {
							logger.logToolError(
								logCtx,
								event.toolName,
								durationMs,
								resultStr,
							);
						} else {
							logger.logToolSuccess(
								logCtx,
								event.toolName,
								durationMs,
								resultStr,
							);
						}

						await store.logMessage(ctx.message.channel, {
							date: new Date().toISOString(),
							ts: toSlackTs(),
							user: "bot",
							text: `[Tool Result] ${event.toolName}: ${event.isError ? "ERROR: " : ""}${truncate(resultStr, 1000)}`,
							attachments: [],
							isBot: true,
						});

						const label = pending?.args
							? (pending.args as { label?: string }).label
							: undefined;
						const duration = (durationMs / 1000).toFixed(1);
						let threadMessage = `*${event.isError ? "err" : "ok"} ${event.toolName}*`;
						if (label) {
							threadMessage += `: ${label}`;
						}
						threadMessage += ` (${duration}s)\n`;
						threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;

						queue.enqueueMessage(threadMessage, "thread", "tool result", false);

						if (event.isError) {
							queue.enqueue(
								() =>
									ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false),
								"tool error",
							);
						}
						break;
					}

					case "message_start":
						if (event.message.role === "assistant") {
							logger.logResponseStart(logCtx);
						}
						break;

					case "message_end":
						if (event.message.role === "assistant") {
							const assistantMsg = event.message as AssistantMessage;

							if (assistantMsg.stopReason) {
								stopReason = assistantMsg.stopReason;
							}

							// Track costs
							if (costTracker && assistantMsg.usage) {
								const record = costTracker.record(channelId, {
									model: assistantMsg.model,
									inputTokens: assistantMsg.usage.input,
									outputTokens: assistantMsg.usage.output,
									cacheWriteTokens: assistantMsg.usage.cacheWrite,
									cacheReadTokens: assistantMsg.usage.cacheRead,
								});
								runCostTotal += record.estimatedCost;
								inputTokens += record.inputTokens;
								outputTokens += record.outputTokens;
								cacheWriteTokens += record.cacheWriteTokens || 0;
								cacheReadTokens += record.cacheReadTokens || 0;
								modelUsed = record.model;
							}

							const content = event.message.content;
							const thinkingParts: string[] = [];
							const textParts: string[] = [];

							for (const part of content) {
								if (part.type === "thinking") {
									thinkingParts.push((part as ThinkingContent).thinking);
								} else if (part.type === "text") {
									textParts.push((part as TextContent).text);
								}
							}

							const text = textParts.join("\n");

							for (const thinking of thinkingParts) {
								logger.logThinking(logCtx, thinking);
								queue.enqueueMessage(`_${thinking}_`, "main", "thinking main");
								queue.enqueueMessage(
									`_${thinking}_`,
									"thread",
									"thinking thread",
									false,
								);
							}

							if (text.trim()) {
								logger.logResponse(logCtx, text);
								queue.enqueueMessage(text, "main", "response main");
								queue.enqueueMessage(text, "thread", "response thread", false);
							}
						}
						break;
				}
			});

			// Run the agent with user's message
			let userPrompt = `Conversation history (last 50 turns). Respond to the last message.\nFormat: date TAB user TAB text TAB attachments\n\n${recentMessages}`;

			// Append file contents if any code/text files were attached
			if (fileContentSection) {
				userPrompt += fileContentSection;
			}

			// Debug: write full context to file (guarded to avoid persisting secrets)
			if (process.env.SLACK_AGENT_DEBUG_PROMPTS === "1") {
				const toolDefs = tools.map((t) => ({
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				}));
				const debugPrompt =
					`=== SYSTEM PROMPT (${systemPrompt.length} chars) ===\n\n${systemPrompt}\n\n` +
					`=== TOOL DEFINITIONS (${JSON.stringify(toolDefs).length} chars) ===\n\n${JSON.stringify(toolDefs, null, 2)}\n\n` +
					`=== USER PROMPT (${userPrompt.length} chars) ===\n\n${userPrompt}`;
				await writeFile(
					join(channelDir, "last_prompt.txt"),
					debugPrompt,
					"utf-8",
				);
			}

			const activeAgent = agent;
			if (!activeAgent) {
				throw new Error("Agent not initialized");
			}

			// Run with retry logic for transient API failures
			await withRetry(
				() => activeAgent.prompt(userPrompt),
				DEFAULT_RETRY_CONFIG,
				(attempt, error, delayMs) => {
					const delaySec = (delayMs / 1000).toFixed(1);
					logger.logWarning(
						`API call failed (attempt ${attempt}/${DEFAULT_RETRY_CONFIG.maxAttempts})`,
						`${error.message}. Retrying in ${delaySec}s...`,
					);
					queue.enqueue(
						() =>
							ctx.respond(
								`_Temporary error, retrying in ${delaySec}s..._`,
								false,
							),
						"retry notice",
					);
				},
			);

			await queue.flush();

			// Get final assistant message and replace main message
			const messages = activeAgent.state.messages as Message[];
			const lastAssistant = messages
				.filter((m): m is AssistantMessage => m.role === "assistant")
				.pop();
			const finalText =
				lastAssistant?.content
					.filter((c): c is TextContent => c.type === "text")
					.map((c) => c.text)
					.join("\n") || "";

			if (finalText.trim()) {
				try {
					const mainText =
						finalText.length > SLACK_MAX_LENGTH
							? `${finalText.substring(0, SLACK_MAX_LENGTH - 50)}\n\n_(see thread for full response)_`
							: finalText;
					await ctx.replaceMessage(mainText);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					logger.logWarning("Failed to replace message", errMsg);
				}
			}

			const durationMs = Date.now() - runStartMs;
			return {
				stopReason,
				durationMs,
				toolsExecuted,
				cost: {
					total: runCostTotal,
					inputTokens,
					outputTokens,
					cacheWriteTokens,
					cacheReadTokens,
					model: modelUsed,
				},
			};
		},

		abort(): void {
			agent?.abort();
		},
	};
}

export function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	if (workspacePath === "/workspace") {
		const prefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(prefix)) {
			return join(channelDir, containerPath.slice(prefix.length));
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(channelDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}
