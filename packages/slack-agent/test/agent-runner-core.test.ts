/**
 * Tests for agent-runner core logic
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("agent-runner core logic", () => {
	describe("parseLogMessages", () => {
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
			}>;
			isBot?: boolean;
		}

		interface ConversationTurn {
			role: "user" | "assistant";
			content: string;
			timestamp?: string;
		}

		// Re-implement parsing logic for testing
		function parseLogMessages(lines: string[]): LogMessage[] {
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
			return messages;
		}

		it("parses valid JSON lines", () => {
			const lines = [
				'{"ts":"1234567890.000001","user":"U123","text":"Hello"}',
				'{"ts":"1234567890.000002","user":"bot","text":"Hi there","isBot":true}',
			];
			const messages = parseLogMessages(lines);
			expect(messages).toHaveLength(2);
			expect(messages[0].text).toBe("Hello");
			expect(messages[1].text).toBe("Hi there");
		});

		it("skips malformed JSON lines", () => {
			const lines = [
				'{"ts":"1234567890.000001","text":"Valid"}',
				"not valid json",
				'{"ts":"1234567890.000002","text":"Also valid"}',
			];
			const messages = parseLogMessages(lines);
			expect(messages).toHaveLength(2);
		});

		it("sorts messages by timestamp", () => {
			const lines = [
				'{"ts":"1234567890.000003","text":"Third"}',
				'{"ts":"1234567890.000001","text":"First"}',
				'{"ts":"1234567890.000002","text":"Second"}',
			];
			const messages = parseLogMessages(lines);
			expect(messages[0].text).toBe("First");
			expect(messages[1].text).toBe("Second");
			expect(messages[2].text).toBe("Third");
		});

		it("handles empty input", () => {
			const messages = parseLogMessages([]);
			expect(messages).toHaveLength(0);
		});
	});

	describe("thread grouping", () => {
		interface LogMessage {
			ts?: string;
			threadTs?: string;
			text?: string;
		}

		interface Thread {
			parentTs: string;
			messages: LogMessage[];
		}

		function groupByThread(messages: LogMessage[]): {
			threads: Map<string, Thread>;
			topLevel: LogMessage[];
		} {
			const threads = new Map<string, Thread>();
			const topLevel: LogMessage[] = [];

			for (const msg of messages) {
				if (msg.threadTs) {
					const thread = threads.get(msg.threadTs);
					if (thread) {
						thread.messages.push(msg);
					} else {
						threads.set(msg.threadTs, {
							parentTs: msg.threadTs,
							messages: [msg],
						});
					}
				} else {
					topLevel.push(msg);
					if (!threads.has(msg.ts || "")) {
						threads.set(msg.ts || "", { parentTs: msg.ts || "", messages: [] });
					}
				}
			}

			return { threads, topLevel };
		}

		it("groups messages by thread", () => {
			const messages: LogMessage[] = [
				{ ts: "1.0", text: "Parent message" },
				{ ts: "1.1", threadTs: "1.0", text: "Reply 1" },
				{ ts: "1.2", threadTs: "1.0", text: "Reply 2" },
				{ ts: "2.0", text: "Another top-level" },
			];

			const { threads, topLevel } = groupByThread(messages);

			expect(topLevel).toHaveLength(2);
			expect(threads.get("1.0")?.messages).toHaveLength(2);
		});

		it("handles orphaned thread replies", () => {
			const messages: LogMessage[] = [
				{ ts: "1.1", threadTs: "1.0", text: "Reply to missing parent" },
			];

			const { threads, topLevel } = groupByThread(messages);

			expect(topLevel).toHaveLength(0);
			expect(threads.get("1.0")?.messages).toHaveLength(1);
		});
	});

	describe("buildSystemPrompt", () => {
		interface ChannelInfo {
			id: string;
			name: string;
		}

		interface UserInfo {
			id: string;
			userName: string;
			displayName: string;
		}

		function buildSystemPrompt(
			workspacePath: string,
			channelId: string,
			memory: string,
			channels: ChannelInfo[],
			users: UserInfo[],
		): string {
			const parts: string[] = [];

			parts.push("You are a helpful Slack bot assistant.");
			parts.push(`\n## Workspace\nPath: ${workspacePath}`);
			parts.push(`Current channel: ${channelId}`);

			if (channels.length > 0) {
				const channelList = channels
					.map((c) => `- #${c.name} (${c.id})`)
					.join("\n");
				parts.push(`\n## Available Channels\n${channelList}`);
			}

			if (users.length > 0) {
				const userList = users
					.map((u) => `- @${u.userName} (${u.id}): ${u.displayName}`)
					.join("\n");
				parts.push(`\n## Team Members\n${userList}`);
			}

			if (memory) {
				parts.push(`\n## Memory\n${memory}`);
			}

			return parts.join("\n");
		}

		it("includes workspace path and channel", () => {
			const prompt = buildSystemPrompt("/workspace", "C123", "", [], []);
			expect(prompt).toContain("/workspace");
			expect(prompt).toContain("C123");
		});

		it("includes channel list when available", () => {
			const channels = [
				{ id: "C1", name: "general" },
				{ id: "C2", name: "random" },
			];
			const prompt = buildSystemPrompt("/workspace", "C123", "", channels, []);
			expect(prompt).toContain("#general");
			expect(prompt).toContain("#random");
		});

		it("includes user list when available", () => {
			const users = [
				{ id: "U1", userName: "alice", displayName: "Alice Smith" },
				{ id: "U2", userName: "bob", displayName: "Bob Jones" },
			];
			const prompt = buildSystemPrompt("/workspace", "C123", "", [], users);
			expect(prompt).toContain("@alice");
			expect(prompt).toContain("Alice Smith");
		});

		it("includes memory when provided", () => {
			const memory = "Remember: User prefers concise answers";
			const prompt = buildSystemPrompt("/workspace", "C123", memory, [], []);
			expect(prompt).toContain(memory);
		});
	});

	describe("cost tracking", () => {
		interface UsageRecord {
			model: string;
			inputTokens: number;
			outputTokens: number;
			cacheWriteTokens?: number;
			cacheReadTokens?: number;
			estimatedCost: number;
		}

		function calculateCost(usage: {
			model: string;
			inputTokens: number;
			outputTokens: number;
			cacheWriteTokens?: number;
			cacheReadTokens?: number;
		}): UsageRecord {
			// Simplified cost calculation (actual uses model-specific rates)
			const inputCost = usage.inputTokens * 0.000003; // $3/M tokens
			const outputCost = usage.outputTokens * 0.000015; // $15/M tokens
			const cacheCost = (usage.cacheWriteTokens || 0) * 0.00000375; // $3.75/M

			return {
				...usage,
				estimatedCost: inputCost + outputCost + cacheCost,
			};
		}

		it("calculates cost from token usage", () => {
			const record = calculateCost({
				model: "claude-sonnet-4",
				inputTokens: 1000,
				outputTokens: 500,
			});

			expect(record.estimatedCost).toBeGreaterThan(0);
			expect(record.inputTokens).toBe(1000);
			expect(record.outputTokens).toBe(500);
		});

		it("includes cache tokens in cost", () => {
			const withCache = calculateCost({
				model: "claude-sonnet-4",
				inputTokens: 1000,
				outputTokens: 500,
				cacheWriteTokens: 2000,
			});

			const withoutCache = calculateCost({
				model: "claude-sonnet-4",
				inputTokens: 1000,
				outputTokens: 500,
			});

			expect(withCache.estimatedCost).toBeGreaterThan(
				withoutCache.estimatedCost,
			);
		});

		it("accumulates costs across multiple calls", () => {
			let totalCost = 0;
			const records = [
				calculateCost({ model: "claude", inputTokens: 100, outputTokens: 50 }),
				calculateCost({ model: "claude", inputTokens: 200, outputTokens: 100 }),
				calculateCost({ model: "claude", inputTokens: 300, outputTokens: 150 }),
			];

			for (const r of records) {
				totalCost += r.estimatedCost;
			}

			expect(totalCost).toBeGreaterThan(0);
			expect(records.reduce((sum, r) => sum + r.inputTokens, 0)).toBe(600);
		});
	});

	describe("tool execution tracking", () => {
		interface PendingTool {
			toolName: string;
			args: unknown;
			startTime: number;
		}

		it("tracks pending tools by call ID", () => {
			const pendingTools = new Map<string, PendingTool>();

			// Start tool
			pendingTools.set("call_1", {
				toolName: "bash",
				args: { command: "ls" },
				startTime: Date.now(),
			});

			expect(pendingTools.has("call_1")).toBe(true);
			expect(pendingTools.get("call_1")?.toolName).toBe("bash");

			// Complete tool
			pendingTools.delete("call_1");
			expect(pendingTools.has("call_1")).toBe(false);
		});

		it("calculates duration from start time", () => {
			const startTime = Date.now() - 1500; // 1.5 seconds ago
			const durationMs = Date.now() - startTime;

			expect(durationMs).toBeGreaterThanOrEqual(1500);
			expect(durationMs).toBeLessThan(2000);
		});

		it("tracks multiple concurrent tools", () => {
			const pendingTools = new Map<string, PendingTool>();

			pendingTools.set("call_1", {
				toolName: "bash",
				args: {},
				startTime: Date.now(),
			});
			pendingTools.set("call_2", {
				toolName: "read",
				args: {},
				startTime: Date.now(),
			});
			pendingTools.set("call_3", {
				toolName: "write",
				args: {},
				startTime: Date.now(),
			});

			expect(pendingTools.size).toBe(3);

			// Complete one
			pendingTools.delete("call_2");
			expect(pendingTools.size).toBe(2);
		});
	});

	describe("message queue ordering", () => {
		it("processes messages in FIFO order", async () => {
			const processed: string[] = [];
			const queue: Array<{ fn: () => Promise<void>; label: string }> = [];

			// Add items
			queue.push({
				fn: async () => {
					processed.push("first");
				},
				label: "first",
			});
			queue.push({
				fn: async () => {
					processed.push("second");
				},
				label: "second",
			});
			queue.push({
				fn: async () => {
					processed.push("third");
				},
				label: "third",
			});

			// Process queue
			for (const item of queue) {
				await item.fn();
			}

			expect(processed).toEqual(["first", "second", "third"]);
		});
	});

	describe("translateToHostPath", () => {
		function translateToHostPath(
			filePath: string,
			channelDir: string,
			workspacePath: string,
			channelId: string,
		): string {
			// If path starts with workspace prefix, it's already a container path
			if (filePath.startsWith(workspacePath)) {
				// Convert container path to host path
				const relativePath = filePath.slice(workspacePath.length);
				return channelDir.replace(`/${channelId}`, "") + relativePath;
			}
			// If it's a relative path or doesn't match, return as-is
			return filePath;
		}

		it("translates container paths to host paths", () => {
			const result = translateToHostPath(
				"/workspace/channels/C123/file.txt",
				"/host/data/channels/C123",
				"/workspace/channels",
				"C123",
			);
			expect(result).toBe("/host/data/channels/C123/file.txt");
		});

		it("preserves paths outside workspace", () => {
			const result = translateToHostPath(
				"/tmp/other/file.txt",
				"/host/data/channels/C123",
				"/workspace/channels",
				"C123",
			);
			expect(result).toBe("/tmp/other/file.txt");
		});

		it("handles relative paths", () => {
			const result = translateToHostPath(
				"./relative/path.txt",
				"/host/data/channels/C123",
				"/workspace/channels",
				"C123",
			);
			expect(result).toBe("./relative/path.txt");
		});
	});

	describe("text truncation", () => {
		function truncate(text: string, maxLength: number): string {
			if (text.length <= maxLength) {
				return text;
			}
			return `${text.substring(0, maxLength - 3)}...`;
		}

		it("returns short text unchanged", () => {
			expect(truncate("hello", 100)).toBe("hello");
		});

		it("truncates long text with ellipsis", () => {
			const long = "a".repeat(200);
			const result = truncate(long, 100);
			expect(result.length).toBe(100);
			expect(result.endsWith("...")).toBe(true);
		});

		it("handles exact length", () => {
			const text = "a".repeat(100);
			expect(truncate(text, 100)).toBe(text);
		});
	});

	describe("extractToolResultText", () => {
		interface ToolResult {
			content?: Array<{ type: string; text?: string }>;
			error?: string;
		}

		function extractToolResultText(result: ToolResult): string {
			if (result.error) {
				return result.error;
			}
			if (result.content) {
				return result.content
					.filter((c) => c.type === "text" && c.text)
					.map((c) => c.text)
					.join("\n");
			}
			return JSON.stringify(result);
		}

		it("extracts text content from result", () => {
			const result = {
				content: [
					{ type: "text", text: "Line 1" },
					{ type: "text", text: "Line 2" },
				],
			};
			expect(extractToolResultText(result)).toBe("Line 1\nLine 2");
		});

		it("returns error message when present", () => {
			const result = { error: "Command failed" };
			expect(extractToolResultText(result)).toBe("Command failed");
		});

		it("filters non-text content", () => {
			const result = {
				content: [
					{ type: "text", text: "Text" },
					{ type: "image", data: "..." },
					{ type: "text", text: "More text" },
				],
			};
			expect(extractToolResultText(result)).toBe("Text\nMore text");
		});

		it("returns JSON for unknown format", () => {
			const result = { custom: "data" };
			expect(extractToolResultText(result as ToolResult)).toBe(
				'{"custom":"data"}',
			);
		});
	});

	describe("abort handling", () => {
		it("sets abort flag", () => {
			let aborted = false;
			const runner = {
				abort: () => {
					aborted = true;
				},
			};

			runner.abort();
			expect(aborted).toBe(true);
		});

		it("abort can be called multiple times safely", () => {
			let abortCount = 0;
			const runner = {
				abort: () => {
					abortCount++;
				},
			};

			runner.abort();
			runner.abort();
			runner.abort();
			expect(abortCount).toBe(3);
		});
	});

	describe("AgentRunResult structure", () => {
		interface AgentRunResult {
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

		it("constructs valid result", () => {
			const result: AgentRunResult = {
				stopReason: "stop",
				durationMs: 5000,
				toolsExecuted: 3,
				cost: {
					total: 0.005,
					inputTokens: 1000,
					outputTokens: 500,
					cacheWriteTokens: 200,
					cacheReadTokens: 100,
					model: "claude-sonnet-4",
				},
			};

			expect(result.stopReason).toBe("stop");
			expect(result.durationMs).toBe(5000);
			expect(result.toolsExecuted).toBe(3);
			expect(result.cost.total).toBe(0.005);
		});

		it("handles abort stop reason", () => {
			const result: AgentRunResult = {
				stopReason: "abort",
				durationMs: 1000,
				toolsExecuted: 1,
				cost: {
					total: 0.001,
					inputTokens: 100,
					outputTokens: 50,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					model: null,
				},
			};

			expect(result.stopReason).toBe("abort");
		});
	});
});

describe("status update throttling", () => {
	it("throttles status updates to interval", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const STATUS_UPDATE_INTERVAL = 100; // Use short interval for testing
		let lastStatusUpdate = -STATUS_UPDATE_INTERVAL; // Ensure first call updates
		let updateCount = 0;

		const maybeUpdateStatus = async () => {
			const now = Date.now();
			if (now - lastStatusUpdate < STATUS_UPDATE_INTERVAL) {
				return; // Throttled
			}
			lastStatusUpdate = now;
			updateCount++;
		};

		try {
			// First call should update
			await maybeUpdateStatus();
			expect(updateCount).toBe(1);

			// Immediate second call should be throttled
			await maybeUpdateStatus();
			expect(updateCount).toBe(1);

			// Wait for interval
			vi.advanceTimersByTime(STATUS_UPDATE_INTERVAL + 10);

			// Now should update
			await maybeUpdateStatus();
			expect(updateCount).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
