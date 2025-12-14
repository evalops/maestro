import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogContext } from "../src/logger.js";
import {
	logAgentError,
	logBackfillChannel,
	logBackfillComplete,
	logBackfillStart,
	logConnected,
	logDisconnected,
	logInfo,
	logResponse,
	logResponseStart,
	logRunSummary,
	logStartup,
	logThinking,
	logToolError,
	logToolStart,
	logToolSuccess,
	logUsageSummary,
	logUserMessage,
	logWarning,
} from "../src/logger.js";

describe("logger", () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
	});

	function getLogOutput(): string[] {
		return consoleLogSpy.mock.calls.map((call) => String(call[0]));
	}

	function getStrippedOutput(): string[] {
		// Strip ANSI codes for easier assertions
		return getLogOutput().map((s) =>
			s.replace(/\x1b\[[0-9;]*m/g, ""),
		);
	}

	describe("logUserMessage", () => {
		it("logs user message with timestamp and context", () => {
			const ctx: LogContext = {
				channelId: "C123",
				channelName: "general",
				userName: "alice",
			};

			logUserMessage(ctx, "Hello world");

			const output = getStrippedOutput();
			expect(output).toHaveLength(1);
			expect(output[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\]/); // timestamp
			expect(output[0]).toContain("#general:alice");
			expect(output[0]).toContain("Hello world");
		});

		it("formats DM context correctly", () => {
			const ctx: LogContext = {
				channelId: "D123",
				userName: "bob",
			};

			logUserMessage(ctx, "DM message");

			const output = getStrippedOutput();
			expect(output[0]).toContain("[DM:bob]");
		});

		it("falls back to channel ID when no name", () => {
			const ctx: LogContext = {
				channelId: "C456",
			};

			logUserMessage(ctx, "test");

			const output = getStrippedOutput();
			expect(output[0]).toContain("#C456:unknown");
		});

		it("includes extras when provided", () => {
			const ctx: LogContext = {
				channelId: "C123",
				channelName: "general",
				userName: "alice",
				source: "slash",
				runId: "run-123456789012",
				threadTs: "1234567890.123456",
			};

			logUserMessage(ctx, "test");

			const output = getStrippedOutput();
			expect(output[0]).toContain("src=slash");
			expect(output[0]).toContain("run=run-123456"); // shortened to 10
			expect(output[0]).toContain("thread=1234567890"); // shortened to 10
		});
	});

	describe("logToolStart", () => {
		it("logs tool start with name and label", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logToolStart(ctx, "bash", "Run tests", { command: "npm test" });

			const output = getStrippedOutput();
			expect(output[0]).toContain("-> bash: Run tests");
			expect(output[1]).toContain("npm test");
		});

		it("formats path with offset/limit", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logToolStart(ctx, "read", "Read file", {
				path: "/src/app.ts",
				offset: 10,
				limit: 50,
			});

			const output = getStrippedOutput();
			expect(output[1]).toContain("/src/app.ts:10-60");
		});

		it("formats path without offset/limit", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logToolStart(ctx, "read", "Read file", { path: "/src/app.ts" });

			const output = getStrippedOutput();
			expect(output[1]).toContain("/src/app.ts");
			expect(output[1]).not.toContain(":");
		});

		it("skips label in args", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logToolStart(ctx, "bash", "Do something", {
				label: "Do something",
				command: "echo hi",
			});

			const output = getStrippedOutput();
			expect(output[1]).not.toContain("Do something");
			expect(output[1]).toContain("echo hi");
		});

		it("stringifies non-string args", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logToolStart(ctx, "test", "Test", {
				count: 42,
				options: { verbose: true },
			});

			const output = getStrippedOutput();
			expect(output[1]).toContain("42");
			expect(output[1]).toContain('{"verbose":true}');
		});

		it("does not log args if empty after formatting", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logToolStart(ctx, "test", "Test", { label: "Test" });

			expect(consoleLogSpy).toHaveBeenCalledTimes(1); // Only header, no args line
		});
	});

	describe("logToolSuccess", () => {
		it("logs success with duration", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logToolSuccess(ctx, "bash", 1500, "Done");

			const output = getStrippedOutput();
			expect(output[0]).toContain("ok bash (1.5s)");
			expect(output[1]).toContain("Done");
		});

		it("truncates long results", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };
			const longResult = "x".repeat(1500);

			logToolSuccess(ctx, "bash", 100, longResult);

			const output = getStrippedOutput();
			expect(output[1]).toContain("(truncated at 1000 chars)");
			expect(output[1].length).toBeLessThan(1200); // Some overhead for indent + truncation message
		});

		it("does not log result if empty", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logToolSuccess(ctx, "bash", 100, "");

			expect(consoleLogSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("logToolError", () => {
		it("logs error with duration", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logToolError(ctx, "bash", 500, "Command failed");

			const output = getStrippedOutput();
			expect(output[0]).toContain("err bash (0.5s)");
			expect(output[1]).toContain("Command failed");
		});

		it("truncates long errors", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };
			const longError = "error: ".repeat(300);

			logToolError(ctx, "bash", 100, longError);

			const output = getStrippedOutput();
			expect(output[1]).toContain("(truncated at 1000 chars)");
		});
	});

	describe("logResponseStart", () => {
		it("logs streaming message", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logResponseStart(ctx);

			const output = getStrippedOutput();
			expect(output[0]).toContain("-> Streaming response...");
		});
	});

	describe("logThinking", () => {
		it("logs thinking with content", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logThinking(ctx, "Analyzing the problem...");

			const output = getStrippedOutput();
			expect(output[0]).toContain("Thinking");
			expect(output[1]).toContain("Analyzing the problem...");
		});
	});

	describe("logResponse", () => {
		it("logs response with content", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logResponse(ctx, "Here is my answer.");

			const output = getStrippedOutput();
			expect(output[0]).toContain("Response");
			expect(output[1]).toContain("Here is my answer.");
		});
	});

	describe("logInfo", () => {
		it("logs info message", () => {
			logInfo("Server started");

			const output = getStrippedOutput();
			expect(output[0]).toContain("[system]");
			expect(output[0]).toContain("Server started");
		});
	});

	describe("logWarning", () => {
		it("logs warning message", () => {
			logWarning("Connection unstable");

			const output = getStrippedOutput();
			expect(output[0]).toContain("[system] warning:");
			expect(output[0]).toContain("Connection unstable");
		});

		it("logs warning with details", () => {
			logWarning("Error occurred", "Stack trace here");

			const output = getStrippedOutput();
			expect(output[0]).toContain("warning: Error occurred");
			expect(output[1]).toContain("Stack trace here");
		});
	});

	describe("logAgentError", () => {
		it("logs agent error with context", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logAgentError(ctx, "Agent crashed");

			const output = getStrippedOutput();
			expect(output[0]).toContain("Agent error");
			expect(output[1]).toContain("Agent crashed");
		});

		it("logs system error", () => {
			logAgentError("system", "Fatal error");

			const output = getStrippedOutput();
			expect(output[0]).toContain("[system]");
			expect(output[0]).toContain("Agent error");
			expect(output[1]).toContain("Fatal error");
		});
	});

	describe("logRunSummary", () => {
		it("logs run summary with all fields", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logRunSummary(ctx, {
				stopReason: "end_turn",
				durationMs: 5000,
				toolsExecuted: 3,
				cost: {
					total: 0.0025,
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadTokens: 200,
					cacheWriteTokens: 100,
					model: "claude-3-opus",
				},
			});

			const output = getStrippedOutput();
			expect(output[0]).toContain("Run summary");
			expect(output[1]).toContain("stop=end_turn");
			expect(output[1]).toContain("dur=5.0s");
			expect(output[1]).toContain("tools=3");
			expect(output[1]).toContain("cost=$0.0025");
			expect(output[1]).toContain("tokens=1000/500");
			expect(output[1]).toContain("model=claude-3-opus");
		});

		it("omits model when null", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logRunSummary(ctx, {
				stopReason: "end_turn",
				durationMs: 1000,
				toolsExecuted: 1,
				cost: {
					total: 0.001,
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					model: null,
				},
			});

			const output = getStrippedOutput();
			expect(output[1]).not.toContain("model=");
		});
	});

	describe("logUsageSummary", () => {
		it("logs usage summary and returns formatted string", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			const result = logUsageSummary(ctx, {
				input: 1000,
				output: 500,
				cacheRead: 200,
				cacheWrite: 100,
				cost: {
					input: 0.001,
					output: 0.0005,
					cacheRead: 0.0001,
					cacheWrite: 0.00005,
					total: 0.00165,
				},
			});

			const output = getStrippedOutput();
			expect(output[0]).toContain("Usage");
			expect(output[1]).toContain("1,000 in + 500 out");
			expect(output[1]).toContain("200 cache read");
			expect(output[1]).toContain("100 cache write");

			// Check returned summary
			expect(result).toContain("*Usage Summary*");
			expect(result).toContain("Tokens: 1,000 in, 500 out");
			expect(result).toContain("Cache: 200 read, 100 write");
			expect(result).toContain("Cost: $0.0010 in, $0.0005 out");
			expect(result).toContain("*Total: $0.0016*"); // 0.001 + 0.0005 + 0.0001 + 0.00005 = 0.00165
		});

		it("omits cache info when zero", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			const result = logUsageSummary(ctx, {
				input: 500,
				output: 250,
				cacheRead: 0,
				cacheWrite: 0,
				cost: {
					input: 0.0005,
					output: 0.00025,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.00075,
				},
			});

			expect(result).not.toContain("Cache:");
			const output = getStrippedOutput();
			expect(output[1]).not.toContain("cache");
		});
	});

	describe("logStartup", () => {
		it("logs startup info", () => {
			logStartup("/home/user/project", "docker:auto");

			const output = getStrippedOutput();
			expect(output[0]).toContain("Starting Slack agent...");
			expect(output[1]).toContain("Working directory: /home/user/project");
			expect(output[2]).toContain("Sandbox: docker:auto");
		});
	});

	describe("logConnected", () => {
		it("logs connected message", () => {
			logConnected();

			const output = getStrippedOutput();
			expect(output[0]).toContain("Slack agent connected and listening!");
		});
	});

	describe("logDisconnected", () => {
		it("logs disconnected message", () => {
			logDisconnected();

			const output = getStrippedOutput();
			expect(output[0]).toContain("Slack agent disconnected.");
		});
	});

	describe("logBackfillStart", () => {
		it("logs backfill start with channel count", () => {
			logBackfillStart(5);

			const output = getStrippedOutput();
			expect(output[0]).toContain("Backfilling 5 channels...");
		});
	});

	describe("logBackfillChannel", () => {
		it("logs channel backfill progress", () => {
			logBackfillChannel("general", 150);

			const output = getStrippedOutput();
			expect(output[0]).toContain("#general: 150 messages");
		});
	});

	describe("logBackfillComplete", () => {
		it("logs backfill completion", () => {
			logBackfillComplete(500, 3500);

			const output = getStrippedOutput();
			expect(output[0]).toContain("Backfill complete: 500 messages in 3.5s");
		});
	});

	describe("context formatting", () => {
		it("adds # prefix to channel name if missing", () => {
			const ctx: LogContext = {
				channelId: "C123",
				channelName: "general", // no # prefix
				userName: "user",
			};

			logUserMessage(ctx, "test");

			const output = getStrippedOutput();
			expect(output[0]).toContain("#general:user");
		});

		it("does not double # prefix", () => {
			const ctx: LogContext = {
				channelId: "C123",
				channelName: "#general", // already has # prefix
				userName: "user",
			};

			logUserMessage(ctx, "test");

			const output = getStrippedOutput();
			expect(output[0]).toContain("#general:user");
			expect(output[0]).not.toContain("##");
		});

		it("includes taskId in extras", () => {
			const ctx: LogContext = {
				channelId: "C123",
				userName: "user",
				taskId: "task-abc123def456",
			};

			logUserMessage(ctx, "test");

			const output = getStrippedOutput();
			expect(output[0]).toContain("task=task-abc123d"); // shortened to 12 chars
		});

		it("handles all source types", () => {
			const sources: Array<LogContext["source"]> = [
				"channel",
				"dm",
				"slash",
				"scheduled",
			];

			for (const source of sources) {
				consoleLogSpy.mockClear();
				const ctx: LogContext = {
					channelId: "C123",
					userName: "user",
					source,
				};

				logUserMessage(ctx, "test");

				const output = getStrippedOutput();
				expect(output[0]).toContain(`src=${source}`);
			}
		});
	});

	describe("indentation", () => {
		it("indents multiline text", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			logToolSuccess(ctx, "bash", 100, "line1\nline2\nline3");

			const output = getStrippedOutput();
			const lines = output[1].split("\n");
			expect(lines).toHaveLength(3);
			for (const line of lines) {
				expect(line).toMatch(/^\s{11}/); // 11 spaces indent
			}
		});
	});
});
