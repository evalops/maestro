import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogContext } from "../src/logger.js";
import {
	configureLogger,
	generateRunId,
	getCurrentContext,
	logAgentError,
	logBackfillChannel,
	logBackfillComplete,
	logBackfillStart,
	logConnected,
	logDebug,
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
	runWithContext,
	setCurrentContext,
	withContext,
	withContextAsync,
} from "../src/logger.js";

function stripAnsi(input: string): string {
	let output = "";
	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		if (char === "\u001b" && input[i + 1] === "[") {
			i += 2;
			while (i < input.length && input[i] !== "m") {
				i++;
			}
			continue;
		}
		output += char;
	}
	return output;
}

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
		return getLogOutput().map((s) => stripAnsi(s));
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
			expect(output[1]!.length).toBeLessThan(1200); // Some overhead for indent + truncation message
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
			const lines = output[1]!.split("\n");
			expect(lines).toHaveLength(3);
			for (const line of lines) {
				expect(line).toMatch(/^\s{11}/); // 11 spaces indent
			}
		});
	});

	describe("context management", () => {
		it("runWithContext sets context for the duration of the callback", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			expect(getCurrentContext()).toBeNull();

			const result = runWithContext(ctx, () => {
				expect(getCurrentContext()).toEqual(ctx);
				return "result";
			});

			expect(result).toBe("result");
			expect(getCurrentContext()).toBeNull();
		});

		it("runWithContext restores previous context after callback (nested)", () => {
			const ctx1: LogContext = { channelId: "C1", userName: "user1" };
			const ctx2: LogContext = { channelId: "C2", userName: "user2" };

			runWithContext(ctx1, () => {
				expect(getCurrentContext()).toEqual(ctx1);

				runWithContext(ctx2, () => {
					expect(getCurrentContext()).toEqual(ctx2);
				});

				expect(getCurrentContext()).toEqual(ctx1);
			});
		});

		it("runWithContext restores context even if callback throws", () => {
			const ctx1: LogContext = { channelId: "C1", userName: "user1" };
			const ctx2: LogContext = { channelId: "C2", userName: "user2" };

			runWithContext(ctx1, () => {
				expect(() =>
					runWithContext(ctx2, () => {
						throw new Error("test error");
					}),
				).toThrow("test error");

				expect(getCurrentContext()).toEqual(ctx1);
			});
		});

		it("withContextAsync sets context for async callback", async () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			expect(getCurrentContext()).toBeNull();

			const result = await withContextAsync(ctx, async () => {
				expect(getCurrentContext()).toEqual(ctx);
				await new Promise((r) => setTimeout(r, 10));
				expect(getCurrentContext()).toEqual(ctx);
				return "async result";
			});

			expect(result).toBe("async result");
			expect(getCurrentContext()).toBeNull();
		});

		it("withContextAsync restores context even if callback rejects (nested)", async () => {
			const ctx1: LogContext = { channelId: "C1", userName: "user1" };
			const ctx2: LogContext = { channelId: "C2", userName: "user2" };

			await runWithContext(ctx1, async () => {
				await expect(
					withContextAsync(ctx2, async () => {
						throw new Error("async error");
					}),
				).rejects.toThrow("async error");

				expect(getCurrentContext()).toEqual(ctx1);
			});
		});

		it("logInfo uses current context when no explicit context provided", () => {
			const ctx: LogContext = {
				channelId: "C123",
				channelName: "general",
				userName: "user",
			};

			runWithContext(ctx, () => {
				logInfo("Test message");
			});

			const output = getStrippedOutput();
			expect(output[0]).toContain("[#general:user]");
			expect(output[0]).toContain("Test message");
		});

		it("logInfo uses explicit context over current context", () => {
			const currentCtx: LogContext = { channelId: "C1", userName: "current" };
			const explicitCtx: LogContext = { channelId: "C2", userName: "explicit" };

			runWithContext(currentCtx, () => {
				logInfo("Test message", explicitCtx);
			});

			const output = getStrippedOutput();
			expect(output[0]).toContain("explicit");
			expect(output[0]).not.toContain("current");
		});

		it("logWarning uses current context", () => {
			const ctx: LogContext = {
				channelId: "C123",
				channelName: "general",
				userName: "user",
			};

			runWithContext(ctx, () => {
				logWarning("Warning message");
			});

			const output = getStrippedOutput();
			expect(output[0]).toContain("[#general:user]");
			expect(output[0]).toContain("warning: Warning message");
		});

		it("setCurrentContext is deprecated no-op (backward compat)", () => {
			// setCurrentContext is now a no-op - context should be set via runWithContext
			const ctx: LogContext = { channelId: "C123", userName: "user" };
			setCurrentContext(ctx);
			// Should still be null because setCurrentContext is a no-op
			expect(getCurrentContext()).toBeNull();
		});

		it("withContext is alias for runWithContext", () => {
			const ctx: LogContext = { channelId: "C123", userName: "user" };

			const result = withContext(ctx, () => {
				expect(getCurrentContext()).toEqual(ctx);
				return 42;
			});

			expect(result).toBe(42);
			expect(getCurrentContext()).toBeNull();
		});
	});

	describe("generateRunId", () => {
		it("generates unique IDs", () => {
			const id1 = generateRunId();
			const id2 = generateRunId();

			expect(id1).not.toBe(id2);
		});

		it("generates IDs with expected format", () => {
			const id = generateRunId();

			// Format: timestamp_random (base36 characters)
			expect(id).toMatch(/^[0-9a-z]+_[0-9a-z]+$/);
		});
	});

	describe("logDebug", () => {
		it("does not log when DEBUG is not set", () => {
			const originalDebug = process.env.DEBUG;
			process.env.DEBUG = undefined;

			logDebug("Debug message");

			expect(consoleLogSpy).not.toHaveBeenCalled();

			process.env.DEBUG = originalDebug;
		});

		it("logs when DEBUG is true", () => {
			const originalDebug = process.env.DEBUG;
			process.env.DEBUG = "true";

			logDebug("Debug message");

			expect(consoleLogSpy).toHaveBeenCalled();
			const output = getStrippedOutput();
			expect(output[0]).toContain("Debug message");

			process.env.DEBUG = originalDebug;
		});

		it("logs when DEBUG is 1", () => {
			const originalDebug = process.env.DEBUG;
			process.env.DEBUG = "1";

			logDebug("Debug message", { key: "value" });

			expect(consoleLogSpy).toHaveBeenCalled();
			const output = getStrippedOutput();
			expect(output[0]).toContain("Debug message");
			expect(output[0]).toContain('{"key":"value"}');

			process.env.DEBUG = originalDebug;
		});

		it("includes current context in debug output", () => {
			const originalDebug = process.env.DEBUG;
			process.env.DEBUG = "true";

			const ctx: LogContext = { channelId: "C123", userName: "user" };
			runWithContext(ctx, () => {
				logDebug("Debug with context");
			});

			const output = getStrippedOutput();
			expect(output[0]).toContain("user");

			process.env.DEBUG = originalDebug;
		});
	});

	describe("runWithContext (AsyncLocalStorage)", () => {
		it("sets context for synchronous code", () => {
			const ctx: LogContext = { channelId: "C123", userName: "alice" };

			expect(getCurrentContext()).toBeNull();

			const result = runWithContext(ctx, () => {
				expect(getCurrentContext()).toEqual(ctx);
				return "sync-result";
			});

			expect(result).toBe("sync-result");
			expect(getCurrentContext()).toBeNull();
		});

		it("propagates context through async operations", async () => {
			const ctx: LogContext = { channelId: "C123", userName: "alice" };

			const result = await runWithContext(ctx, async () => {
				expect(getCurrentContext()).toEqual(ctx);

				// Simulate async operation
				await new Promise((r) => setTimeout(r, 10));

				// Context should still be available after await
				expect(getCurrentContext()).toEqual(ctx);

				return "async-result";
			});

			expect(result).toBe("async-result");
			expect(getCurrentContext()).toBeNull();
		});

		it("maintains separate contexts for concurrent async operations", async () => {
			const ctx1: LogContext = { channelId: "C1", userName: "user1" };
			const ctx2: LogContext = { channelId: "C2", userName: "user2" };

			const results: string[] = [];

			// Run two async operations concurrently
			await Promise.all([
				runWithContext(ctx1, async () => {
					expect(getCurrentContext()).toEqual(ctx1);
					await new Promise((r) => setTimeout(r, 20));
					expect(getCurrentContext()).toEqual(ctx1);
					results.push(`ctx1: ${getCurrentContext()?.userName}`);
				}),
				runWithContext(ctx2, async () => {
					expect(getCurrentContext()).toEqual(ctx2);
					await new Promise((r) => setTimeout(r, 10));
					expect(getCurrentContext()).toEqual(ctx2);
					results.push(`ctx2: ${getCurrentContext()?.userName}`);
				}),
			]);

			// Both should have maintained their own context
			expect(results).toContain("ctx1: user1");
			expect(results).toContain("ctx2: user2");
		});

		it("nests contexts correctly", () => {
			const outer: LogContext = { channelId: "C1", userName: "outer" };
			const inner: LogContext = { channelId: "C2", userName: "inner" };

			runWithContext(outer, () => {
				expect(getCurrentContext()).toEqual(outer);

				runWithContext(inner, () => {
					expect(getCurrentContext()).toEqual(inner);
				});

				// Outer context should be restored
				expect(getCurrentContext()).toEqual(outer);
			});

			expect(getCurrentContext()).toBeNull();
		});
	});

	describe("configureLogger", () => {
		afterEach(() => {
			// Reset to defaults
			configureLogger({ format: "pretty", minLevel: "debug" });
		});

		it("outputs JSON when format is json", () => {
			configureLogger({ format: "json" });

			logInfo("Test message");

			expect(consoleLogSpy).toHaveBeenCalled();
			const output = consoleLogSpy.mock.calls[0]![0] as string;

			// Should be valid JSON
			const parsed = JSON.parse(output);
			expect(parsed.level).toBe("info");
			expect(parsed.message).toBe("Test message");
			expect(parsed.timestamp).toBeDefined();
		});

		it("includes context in JSON output", () => {
			configureLogger({ format: "json" });
			const ctx: LogContext = { channelId: "C123", userName: "alice" };

			logInfo("Test", ctx);

			const output = consoleLogSpy.mock.calls[0]![0] as string;
			const parsed = JSON.parse(output);
			expect(parsed.context).toEqual(ctx);
		});

		it("includes data in JSON output for warnings", () => {
			configureLogger({ format: "json" });

			logWarning("Warning", "Stack trace details");

			const output = consoleLogSpy.mock.calls[0]![0] as string;
			const parsed = JSON.parse(output);
			expect(parsed.level).toBe("warn");
			expect(parsed.data).toEqual({ details: "Stack trace details" });
		});

		it("respects minLevel setting", () => {
			configureLogger({ minLevel: "warn" });

			logInfo("Should not appear");
			logWarning("Should appear");

			expect(consoleLogSpy).toHaveBeenCalledTimes(1);
			const output = consoleLogSpy.mock.calls[0]![0] as string;
			expect(output).toContain("warning:");
		});

		it("logRunSummary outputs JSON with all fields", () => {
			configureLogger({ format: "json" });

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
					model: "claude-sonnet-4",
				},
			});

			const output = consoleLogSpy.mock.calls[0]![0] as string;
			const parsed = JSON.parse(output);
			expect(parsed.level).toBe("info");
			expect(parsed.message).toBe("Run summary");
			expect(parsed.data.stopReason).toBe("end_turn");
			expect(parsed.data.durationMs).toBe(5000);
			expect(parsed.data.toolsExecuted).toBe(3);
			expect(parsed.data.cost).toBe(0.0025);
			expect(parsed.data.model).toBe("claude-sonnet-4");
		});

		it("logAgentError outputs JSON", () => {
			configureLogger({ format: "json" });

			const ctx: LogContext = { channelId: "C123", userName: "user" };
			logAgentError(ctx, "Something went wrong");

			const output = consoleLogSpy.mock.calls[0]![0] as string;
			const parsed = JSON.parse(output);
			expect(parsed.level).toBe("error");
			expect(parsed.message).toBe("Agent error");
			expect(parsed.data.error).toBe("Something went wrong");
		});
	});
});
