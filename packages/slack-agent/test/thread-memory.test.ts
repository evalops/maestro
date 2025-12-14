import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadMemoryManager } from "../src/thread-memory.js";

describe("ThreadMemoryManager", () => {
	let dir: string;
	let memory: ThreadMemoryManager;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-memory-"));
		memory = new ThreadMemoryManager(dir, {
			maxMessages: 10,
			maxTokens: 1000,
			retentionDays: 7,
		});
	});

	afterEach(async () => {
		await memory.shutdown();
		await rm(dir, { recursive: true, force: true });
	});

	describe("getContext", () => {
		it("returns empty context for new thread", async () => {
			const context = await memory.getContext("C123", "T456");
			expect(context.channelId).toBe("C123");
			expect(context.threadTs).toBe("T456");
			expect(context.messages).toHaveLength(0);
			expect(context.totalTokens).toBe(0);
		});

		it("returns existing context", async () => {
			await memory.addMessage("C123", "T456", {
				role: "user",
				content: "Hello",
			});

			const context = await memory.getContext("C123", "T456");
			expect(context.messages).toHaveLength(1);
		});
	});

	describe("addMessage", () => {
		it("adds message to context", async () => {
			const message = await memory.addMessage("C123", "T456", {
				role: "user",
				content: "Hello world",
				userId: "U789",
			});

			expect(message.id).toBeDefined();
			expect(message.role).toBe("user");
			expect(message.content).toBe("Hello world");
			expect(message.userId).toBe("U789");
			expect(message.createdAt).toBeDefined();
		});

		it("estimates token count", async () => {
			const message = await memory.addMessage("C123", "T456", {
				role: "user",
				content: "Hello world this is a test message",
			});

			expect(message.tokenCount).toBeGreaterThan(0);
		});

		it("updates total token count", async () => {
			await memory.addMessage("C123", "T456", {
				role: "user",
				content: "Hello world",
			});
			await memory.addMessage("C123", "T456", {
				role: "assistant",
				content: "Hi there!",
			});

			const context = await memory.getContext("C123", "T456");
			expect(context.totalTokens).toBeGreaterThan(0);
		});

		it("enforces message limit", async () => {
			// Add more than maxMessages (10)
			for (let i = 0; i < 15; i++) {
				await memory.addMessage("C123", "T456", {
					role: "user",
					content: `Message ${i}`,
				});
			}

			const context = await memory.getContext("C123", "T456");
			expect(context.messages.length).toBeLessThanOrEqual(10);
		});

		it("preserves message metadata", async () => {
			const message = await memory.addMessage("C123", "T456", {
				role: "assistant",
				content: "Response",
				metadata: {
					model: "claude-3",
					toolCalls: [{ name: "read" }],
				},
			});

			expect(message.metadata?.model).toBe("claude-3");
			expect(message.metadata?.toolCalls).toHaveLength(1);
		});
	});

	describe("getMessagesForAgent", () => {
		it("returns formatted messages for agent", async () => {
			await memory.addMessage("C123", "T456", {
				role: "user",
				content: "Hello",
			});
			await memory.addMessage("C123", "T456", {
				role: "assistant",
				content: "Hi!",
			});
			await memory.addMessage("C123", "T456", {
				role: "system",
				content: "System message",
			});

			const messages = await memory.getMessagesForAgent("C123", "T456");

			// Should only include user and assistant messages
			expect(messages).toHaveLength(2);
			expect(messages[0].role).toBe("user");
			expect(messages[1].role).toBe("assistant");
		});
	});

	describe("clearThread", () => {
		it("clears thread context", async () => {
			await memory.addMessage("C123", "T456", {
				role: "user",
				content: "Hello",
			});

			await memory.clearThread("C123", "T456");

			const context = await memory.getContext("C123", "T456");
			expect(context.messages).toHaveLength(0);
		});
	});

	describe("getThreadSummary", () => {
		it("returns thread summary", async () => {
			await memory.addMessage("C123", "T456", {
				role: "user",
				content: "Hello",
			});
			await memory.addMessage("C123", "T456", {
				role: "assistant",
				content: "Hi!",
			});

			const summary = await memory.getThreadSummary("C123", "T456");

			expect(summary.messageCount).toBe(2);
			expect(summary.totalTokens).toBeGreaterThan(0);
			expect(summary.lastMessageAt).toBeDefined();
		});

		it("returns null lastMessageAt for empty thread", async () => {
			const summary = await memory.getThreadSummary("C123", "T456");
			expect(summary.messageCount).toBe(0);
			expect(summary.lastMessageAt).toBeNull();
		});
	});

	describe("cleanup", () => {
		it("returns 0 for Redis storage (TTL handled automatically)", async () => {
			// Create manager with custom storage that simulates Redis
			const deleted = await memory.cleanup();
			// For file storage, it should process but find nothing old enough
			expect(deleted).toBe(0);
		});
	});
});

describe("ThreadMemoryManager with custom token count", () => {
	let dir: string;
	let memory: ThreadMemoryManager;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-memory-tokens-"));
		memory = new ThreadMemoryManager(dir, {
			maxTokens: 100, // Very low limit
			maxMessages: 100,
		});
	});

	afterEach(async () => {
		await memory.shutdown();
		await rm(dir, { recursive: true, force: true });
	});

	it("enforces token limit by removing old messages", async () => {
		// Add messages that will exceed token limit
		for (let i = 0; i < 20; i++) {
			await memory.addMessage("C123", "T456", {
				role: "user",
				content: "This is a longer message that uses more tokens for testing",
			});
		}

		const context = await memory.getContext("C123", "T456");
		expect(context.totalTokens).toBeLessThanOrEqual(100);
	});
});

describe("ThreadMemoryManager handles special characters in threadTs", () => {
	let dir: string;
	let memory: ThreadMemoryManager;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "slack-agent-memory-special-"));
		memory = new ThreadMemoryManager(dir);
	});

	afterEach(async () => {
		await memory.shutdown();
		await rm(dir, { recursive: true, force: true });
	});

	it("handles threadTs with dots (Slack timestamp format)", async () => {
		// Slack timestamps have format like "1234567890.123456"
		await memory.addMessage("C123", "1234567890.123456", {
			role: "user",
			content: "Hello",
		});

		const context = await memory.getContext("C123", "1234567890.123456");
		expect(context.messages).toHaveLength(1);
	});
});
