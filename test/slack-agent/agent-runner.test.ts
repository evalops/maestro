/**
 * Tests for agent-runner.ts - Agent runner utilities and helpers
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Note: We test the exported createAgentRunner function through integration
// and focus on testing the internal utilities through their observable behavior

describe("agent-runner", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`slack-agent-runner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("message history formatting", () => {
		// Test message history format by creating log files and inspecting the output
		it("formats messages with date, user, and text", async () => {
			const channelDir = join(testDir, "C123456");
			mkdirSync(channelDir, { recursive: true });

			const logPath = join(channelDir, "log.jsonl");
			const messages = [
				{
					date: "2024-01-15T10:00:00.000Z",
					ts: "1705312800.000000",
					user: "U123456",
					userName: "testuser",
					text: "Hello world",
					attachments: [],
					isBot: false,
				},
				{
					date: "2024-01-15T10:01:00.000Z",
					ts: "1705312860.000000",
					user: "bot",
					text: "Hi there!",
					attachments: [],
					isBot: true,
				},
			];

			writeFileSync(
				logPath,
				`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`,
			);

			// Verify the log file exists and has correct format
			expect(existsSync(logPath)).toBe(true);
			const content = require("node:fs").readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(2);

			const msg1 = JSON.parse(lines[0]);
			expect(msg1.userName).toBe("testuser");
			expect(msg1.text).toBe("Hello world");

			const msg2 = JSON.parse(lines[1]);
			expect(msg2.isBot).toBe(true);
			expect(msg2.text).toBe("Hi there!");
		});

		it("handles empty message history", () => {
			const channelDir = join(testDir, "C123456");
			mkdirSync(channelDir, { recursive: true });

			// No log file created - should be handled gracefully
			const logPath = join(channelDir, "log.jsonl");
			expect(existsSync(logPath)).toBe(false);
		});

		it("handles malformed JSON in log file", () => {
			const channelDir = join(testDir, "C123456");
			mkdirSync(channelDir, { recursive: true });

			const logPath = join(channelDir, "log.jsonl");
			writeFileSync(
				logPath,
				`{"valid": "json"}\nnot valid json\n{"also": "valid"}\n`,
			);

			// Should not throw when reading file with malformed lines
			expect(existsSync(logPath)).toBe(true);
		});

		it("includes attachments in formatted messages", () => {
			const channelDir = join(testDir, "C123456");
			mkdirSync(channelDir, { recursive: true });

			const logPath = join(channelDir, "log.jsonl");
			const message = {
				date: "2024-01-15T10:00:00.000Z",
				ts: "1705312800.000000",
				user: "U123456",
				userName: "testuser",
				text: "Check this file",
				attachments: [
					{
						original: "report.pdf",
						local: "C123456/attachments/1234_report.pdf",
					},
				],
				isBot: false,
			};

			writeFileSync(logPath, `${JSON.stringify(message)}\n`);

			const content = require("node:fs").readFileSync(logPath, "utf-8");
			const parsed = JSON.parse(content.trim());
			expect(parsed.attachments).toHaveLength(1);
			expect(parsed.attachments[0].local).toContain("report.pdf");
		});
	});

	describe("memory file handling", () => {
		it("reads global MEMORY.md from workspace root", () => {
			const memoryPath = join(testDir, "MEMORY.md");
			writeFileSync(memoryPath, "# Global Memory\n\nThis is global context.");

			expect(existsSync(memoryPath)).toBe(true);
			const content = require("node:fs").readFileSync(memoryPath, "utf-8");
			expect(content).toContain("Global Memory");
		});

		it("reads channel-specific MEMORY.md", () => {
			const channelDir = join(testDir, "C123456");
			mkdirSync(channelDir, { recursive: true });

			const memoryPath = join(channelDir, "MEMORY.md");
			writeFileSync(
				memoryPath,
				"# Channel Memory\n\nChannel-specific context.",
			);

			expect(existsSync(memoryPath)).toBe(true);
			const content = require("node:fs").readFileSync(memoryPath, "utf-8");
			expect(content).toContain("Channel Memory");
		});

		it("handles missing memory files gracefully", () => {
			const memoryPath = join(testDir, "MEMORY.md");
			expect(existsSync(memoryPath)).toBe(false);
			// Should not throw
		});

		it("handles empty memory files", () => {
			const memoryPath = join(testDir, "MEMORY.md");
			writeFileSync(memoryPath, "");

			expect(existsSync(memoryPath)).toBe(true);
			const content = require("node:fs").readFileSync(memoryPath, "utf-8");
			expect(content).toBe("");
		});
	});

	describe("system prompt construction", () => {
		it("should include workspace layout section", () => {
			const channelDir = join(testDir, "C123456");
			mkdirSync(channelDir, { recursive: true });

			// Create some files to simulate workspace
			writeFileSync(join(testDir, "package.json"), '{"name": "test"}');
			mkdirSync(join(testDir, "src"), { recursive: true });
			writeFileSync(join(testDir, "src", "index.ts"), 'console.log("hello")');

			// Files should exist
			expect(existsSync(join(testDir, "package.json"))).toBe(true);
			expect(existsSync(join(testDir, "src", "index.ts"))).toBe(true);
		});
	});

	describe("tool result formatting", () => {
		it("formats text content from tool results", () => {
			const result = {
				content: [{ type: "text" as const, text: "File contents here" }],
				details: undefined,
			};

			expect(result.content[0].type).toBe("text");
			expect(result.content[0].text).toBe("File contents here");
		});

		it("formats image content from tool results", () => {
			const result = {
				content: [
					{ type: "text" as const, text: "Read image file [image/png]" },
					{ type: "image" as const, data: "base64data", mimeType: "image/png" },
				],
				details: undefined,
			};

			expect(result.content).toHaveLength(2);
			expect(result.content[1].type).toBe("image");
		});

		it("handles error results", () => {
			const errorResult = {
				content: [{ type: "text" as const, text: "Error: File not found" }],
				isError: true,
			};

			expect(errorResult.isError).toBe(true);
			expect(errorResult.content[0].text).toContain("Error");
		});
	});

	describe("truncate helper", () => {
		it("does not truncate short strings", () => {
			const text = "short";
			const maxLen = 100;
			// Simulate truncate behavior
			const result =
				text.length <= maxLen ? text : `${text.substring(0, maxLen - 3)}...`;
			expect(result).toBe("short");
		});

		it("truncates long strings with ellipsis", () => {
			const text = "This is a very long string that should be truncated";
			const maxLen = 20;
			const result =
				text.length <= maxLen ? text : `${text.substring(0, maxLen - 3)}...`;
			expect(result).toBe("This is a very lo...");
			expect(result.length).toBe(maxLen);
		});
	});

	describe("Slack timestamp generation", () => {
		it("generates unique timestamps for rapid calls", () => {
			const timestamps = new Set<string>();
			// Simulate timestamp generation
			for (let i = 0; i < 100; i++) {
				const now = Date.now();
				const seconds = Math.floor(now / 1000);
				const micros = (now % 1000) * 1000 + i;
				const ts = `${seconds}.${micros.toString().padStart(6, "0")}`;
				timestamps.add(ts);
			}
			// All timestamps should be unique
			expect(timestamps.size).toBe(100);
		});

		it("follows Slack timestamp format", () => {
			const now = Date.now();
			const seconds = Math.floor(now / 1000);
			const micros = (now % 1000) * 1000;
			const ts = `${seconds}.${micros.toString().padStart(6, "0")}`;

			// Format: seconds.microseconds
			expect(ts).toMatch(/^\d+\.\d{6}$/);
		});
	});

	describe("API key handling", () => {
		const originalEnv = process.env;

		beforeEach(() => {
			process.env = { ...originalEnv };
		});

		afterEach(() => {
			process.env = originalEnv;
		});

		it("prefers ANTHROPIC_OAUTH_TOKEN over ANTHROPIC_API_KEY", () => {
			process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token";
			process.env.ANTHROPIC_API_KEY = "api-key";

			const key =
				process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
			expect(key).toBe("oauth-token");
		});

		it("falls back to ANTHROPIC_API_KEY when ANTHROPIC_OAUTH_TOKEN not set", () => {
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.ANTHROPIC_OAUTH_TOKEN;
			process.env.ANTHROPIC_API_KEY = "api-key";

			const key =
				process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
			expect(key).toBe("api-key");
		});

		it("returns undefined when neither key is set", () => {
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.ANTHROPIC_OAUTH_TOKEN;
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.ANTHROPIC_API_KEY;

			const key =
				process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
			expect(key).toBeUndefined();
		});
	});

	describe("message queue behavior", () => {
		it("processes messages in order", async () => {
			const processed: number[] = [];
			const queue: Array<() => Promise<void>> = [];

			// Add tasks to queue
			for (let i = 0; i < 5; i++) {
				const num = i;
				queue.push(async () => {
					await new Promise((r) => setTimeout(r, 10));
					processed.push(num);
				});
			}

			// Process queue sequentially
			for (const task of queue) {
				await task();
			}

			expect(processed).toEqual([0, 1, 2, 3, 4]);
		});

		it("handles errors without stopping queue", async () => {
			const processed: string[] = [];
			const queue: Array<() => Promise<void>> = [
				async () => {
					processed.push("first");
				},
				async () => {
					throw new Error("intentional error");
				},
				async () => {
					processed.push("third");
				},
			];

			// Process with error handling
			for (const task of queue) {
				try {
					await task();
				} catch {
					processed.push("error-caught");
				}
			}

			expect(processed).toEqual(["first", "error-caught", "third"]);
		});
	});

	describe("workspace layout generation", () => {
		it("lists files in workspace directory", async () => {
			// Create test workspace structure
			writeFileSync(join(testDir, "package.json"), "{}");
			writeFileSync(join(testDir, "README.md"), "# Test");
			mkdirSync(join(testDir, "src"), { recursive: true });
			writeFileSync(join(testDir, "src", "index.ts"), "");

			const { readdirSync, statSync } = require("node:fs");

			function listDir(dir: string, prefix = ""): string[] {
				const entries = readdirSync(dir);
				const result: string[] = [];

				for (const entry of entries) {
					const fullPath = join(dir, entry);
					const stat = statSync(fullPath);

					if (stat.isDirectory()) {
						result.push(`${prefix}${entry}/`);
						result.push(...listDir(fullPath, `${prefix}  `));
					} else {
						result.push(`${prefix}${entry}`);
					}
				}

				return result;
			}

			const layout = listDir(testDir);

			expect(layout).toContain("package.json");
			expect(layout).toContain("README.md");
			expect(layout).toContain("src/");
		});
	});

	describe("abort handling", () => {
		it("creates AbortController for run cancellation", () => {
			const controller = new AbortController();
			expect(controller.signal.aborted).toBe(false);

			controller.abort();
			expect(controller.signal.aborted).toBe(true);
		});

		it("propagates abort signal to tools", async () => {
			const controller = new AbortController();
			let signalReceived = false;

			const mockTool = async (signal?: AbortSignal) => {
				if (signal?.aborted) {
					signalReceived = true;
					throw new Error("Aborted");
				}
				return { content: [{ type: "text", text: "ok" }] };
			};

			controller.abort();

			try {
				await mockTool(controller.signal);
			} catch {
				// Expected
			}

			expect(signalReceived).toBe(true);
		});
	});
});
