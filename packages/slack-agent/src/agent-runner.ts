/**
 * Agent Runner - Connects Slack messages to Composer's Agent
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as logger from "./logger.js";
import { type SandboxConfig, createExecutor } from "./sandbox.js";
import type { ChannelInfo, SlackContext, UserInfo } from "./slack/bot.js";
import type { ChannelStore } from "./store.js";
import { createSlackAgentTools, setUploadFunction } from "./tools/index.js";

// Import from main composer source
import { Agent } from "../../../src/agent/agent.js";
import { ProviderTransport } from "../../../src/agent/transport.js";
import type {
	AgentEvent,
	AgentTool,
	Api,
	AssistantMessage,
	Model,
	TextContent,
	ThinkingContent,
} from "../../../src/agent/types.js";
import { getModel } from "../../../src/models/builtin.js";

export interface AgentRunner {
	run(
		ctx: SlackContext,
		channelDir: string,
		store: ChannelStore,
	): Promise<{ stopReason: string }>;
	abort(): void;
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
	user?: string;
	userName?: string;
	text?: string;
	attachments?: Array<{ local: string }>;
	isBot?: boolean;
}

function getRecentMessages(channelDir: string, turnCount: number): string {
	const logPath = join(channelDir, "log.jsonl");
	if (!existsSync(logPath)) {
		return "(no message history yet)";
	}

	const content = readFileSync(logPath, "utf-8");
	const lines = content.trim().split("\n").filter(Boolean);

	if (lines.length === 0) {
		return "(no message history yet)";
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

	// Group into turns
	const turns: LogMessage[][] = [];
	let currentTurn: LogMessage[] = [];
	let lastWasBot: boolean | null = null;

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		const isBot = msg.isBot === true;

		if (lastWasBot === null) {
			currentTurn.unshift(msg);
			lastWasBot = isBot;
		} else if (isBot && lastWasBot) {
			currentTurn.unshift(msg);
		} else {
			turns.unshift(currentTurn);
			currentTurn = [msg];
			lastWasBot = isBot;

			if (turns.length >= turnCount) {
				break;
			}
		}
	}

	if (currentTurn.length > 0 && turns.length < turnCount) {
		turns.unshift(currentTurn);
	}

	const formatted: string[] = [];
	for (const turn of turns) {
		for (const msg of turn) {
			const date = (msg.date || "").substring(0, 19);
			const user = msg.userName || msg.user || "";
			const text = msg.text || "";
			const attachments = (msg.attachments || []).map((a) => a.local).join(",");
			formatted.push(`${date}\t${user}\t${text}\t${attachments}`);
		}
	}

	return formatted.join("\n");
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
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to Slack
- status: Check system health, resource usage (CPU, memory), and workspace disk usage

Each tool requires a "label" parameter (shown to user).

Use the status tool when:
- User asks about your status, health, or resources
- Before running memory-intensive tasks
- Debugging performance issues
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

export function createAgentRunner(sandboxConfig: SandboxConfig): AgentRunner {
	let agent: Agent | null = null;
	const executor = createExecutor(sandboxConfig);

	return {
		async run(
			ctx: SlackContext,
			channelDir: string,
			store: ChannelStore,
		): Promise<{ stopReason: string }> {
			await mkdir(channelDir, { recursive: true });

			const channelId = ctx.message.channel;
			const workspacePath = executor.getWorkspacePath(
				channelDir.replace(`/${channelId}`, ""),
			);
			const recentMessages = getRecentMessages(channelDir, 50);
			const memory = getMemory(channelDir);
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
					thinkingLevel: "off",
					tools: tools as AgentTool[],
				},
			});

			const logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};

			const pendingTools = new Map<
				string,
				{ toolName: string; args: unknown; startTime: number }
			>();

			let stopReason = "stop";
			const SLACK_MAX_LENGTH = 40000;

			const splitForSlack = (text: string): string[] => {
				if (text.length <= SLACK_MAX_LENGTH) return [text];
				const parts: string[] = [];
				let remaining = text;
				let partNum = 1;
				while (remaining.length > 0) {
					const chunk = remaining.substring(0, SLACK_MAX_LENGTH - 50);
					remaining = remaining.substring(SLACK_MAX_LENGTH - 50);
					const suffix =
						remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
					parts.push(chunk + suffix);
					partNum++;
				}
				return parts;
			};

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
					const parts = splitForSlack(text);
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

						const durationMs = pending ? Date.now() - pending.startTime : 0;

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
			const userPrompt = `Conversation history (last 50 turns). Respond to the last message.\nFormat: date TAB user TAB text TAB attachments\n\n${recentMessages}`;

			// Debug: write full context to file
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

			await agent.prompt(userPrompt);

			await queue.flush();

			// Get final assistant message and replace main message
			const messages = agent.state.messages;
			const lastAssistant = messages
				.filter((m) => m.role === "assistant")
				.pop();
			const finalText =
				lastAssistant?.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
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

			return { stopReason };
		},

		abort(): void {
			agent?.abort();
		},
	};
}

function translateToHostPath(
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
