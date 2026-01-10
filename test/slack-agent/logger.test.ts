/**
 * Tests for logger.ts - Console logging utilities
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logger from "../../packages/slack-agent/src/logger.js";

describe("logger", () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
	});

	describe("formatContext", () => {
		it("formats DM context with userName", () => {
			logger.logUserMessage(
				{ channelId: "D123456", userName: "testuser" },
				"test message",
			);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("[DM:testuser]"),
			);
		});

		it("formats DM context with channelId when userName missing", () => {
			logger.logUserMessage({ channelId: "D123456" }, "test message");

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("[DM:D123456]"),
			);
		});

		it("formats channel context with # prefix", () => {
			logger.logUserMessage(
				{ channelId: "C123456", channelName: "general", userName: "testuser" },
				"test message",
			);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("[#general:testuser]"),
			);
		});

		it("does not double # prefix if already present", () => {
			logger.logUserMessage(
				{ channelId: "C123456", channelName: "#general", userName: "testuser" },
				"test message",
			);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("[#general:testuser]"),
			);
			expect(consoleLogSpy).not.toHaveBeenCalledWith(
				expect.stringContaining("[##general"),
			);
		});

		it("uses channelId when channelName missing", () => {
			logger.logUserMessage(
				{ channelId: "C123456", userName: "testuser" },
				"test message",
			);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("[#C123456:testuser]"),
			);
		});

		it("uses 'unknown' when userName missing in channel context", () => {
			logger.logUserMessage(
				{ channelId: "C123456", channelName: "general" },
				"test message",
			);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("[#general:unknown]"),
			);
		});
	});

	describe("logUserMessage", () => {
		it("logs user message with green color", () => {
			logger.logUserMessage(
				{ channelId: "C123456", channelName: "general", userName: "testuser" },
				"Hello world",
			);

			expect(consoleLogSpy).toHaveBeenCalled();
			const call = consoleLogSpy.mock.calls[0]![0];
			expect(call).toContain("Hello world");
		});

		it("includes timestamp in log", () => {
			logger.logUserMessage({ channelId: "C123456" }, "test");

			const call = consoleLogSpy.mock.calls[0]![0];
			// Timestamp format: [HH:MM:SS]
			expect(call).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
		});
	});

	describe("logToolStart", () => {
		it("logs tool start with name and label", () => {
			logger.logToolStart(
				{ channelId: "C123456", userName: "user" },
				"read",
				"Reading config file",
				{ path: "/etc/config" },
			);

			expect(consoleLogSpy).toHaveBeenCalled();
			const call = consoleLogSpy.mock.calls[0]![0];
			expect(call).toContain("read");
			expect(call).toContain("Reading config file");
		});

		it("logs formatted args on separate line", () => {
			logger.logToolStart({ channelId: "C123456" }, "read", "Reading file", {
				path: "/etc/config",
			});

			// Should have two calls: one for tool line, one for args
			expect(consoleLogSpy).toHaveBeenCalledTimes(2);
		});

		it("formats path with offset and limit", () => {
			logger.logToolStart({ channelId: "C123456" }, "read", "Reading file", {
				path: "/etc/config",
				offset: 10,
				limit: 20,
			});

			const argsCall = consoleLogSpy.mock.calls[1]![0];
			expect(argsCall).toContain("/etc/config:10-30");
		});

		it("skips label argument in formatted output", () => {
			logger.logToolStart({ channelId: "C123456" }, "read", "Reading file", {
				label: "Should not appear",
				path: "/file.txt",
			});

			const argsCall = consoleLogSpy.mock.calls[1]![0];
			expect(argsCall).not.toContain("Should not appear");
		});
	});

	describe("logToolSuccess", () => {
		it("logs success with duration and ok status", () => {
			logger.logToolSuccess(
				{ channelId: "C123456" },
				"read",
				1500,
				"file contents here",
			);

			const call = consoleLogSpy.mock.calls[0]![0];
			expect(call).toContain("ok");
			expect(call).toContain("read");
			expect(call).toContain("1.5s");
		});

		it("logs result on separate line", () => {
			logger.logToolSuccess(
				{ channelId: "C123456" },
				"read",
				1000,
				"result text",
			);

			expect(consoleLogSpy).toHaveBeenCalledTimes(2);
			const resultCall = consoleLogSpy.mock.calls[1]![0];
			expect(resultCall).toContain("result text");
		});

		it("truncates very long results", () => {
			const longResult = "x".repeat(2000);
			logger.logToolSuccess({ channelId: "C123456" }, "read", 1000, longResult);

			const resultCall = consoleLogSpy.mock.calls[1]![0];
			expect(resultCall).toContain("truncated");
		});
	});

	describe("logToolError", () => {
		it("logs error with err status and duration", () => {
			logger.logToolError(
				{ channelId: "C123456" },
				"bash",
				500,
				"Command failed",
			);

			const call = consoleLogSpy.mock.calls[0]![0];
			expect(call).toContain("err");
			expect(call).toContain("bash");
			expect(call).toContain("0.5s");
		});

		it("logs error message on separate line", () => {
			logger.logToolError(
				{ channelId: "C123456" },
				"bash",
				500,
				"Error details",
			);

			expect(consoleLogSpy).toHaveBeenCalledTimes(2);
			const errorCall = consoleLogSpy.mock.calls[1]![0];
			expect(errorCall).toContain("Error details");
		});
	});

	describe("logResponseStart", () => {
		it("logs streaming response indicator", () => {
			logger.logResponseStart({ channelId: "C123456", userName: "user" });

			const call = consoleLogSpy.mock.calls[0]![0];
			expect(call).toContain("Streaming response");
		});
	});

	describe("logThinking", () => {
		it("logs thinking with truncation for long thoughts", () => {
			const longThinking = "thinking ".repeat(200);
			logger.logThinking({ channelId: "C123456" }, longThinking);

			expect(consoleLogSpy).toHaveBeenCalledTimes(2);
			const thinkingCall = consoleLogSpy.mock.calls[1]![0];
			expect(thinkingCall).toContain("truncated");
		});
	});

	describe("logResponse", () => {
		it("logs response text", () => {
			logger.logResponse({ channelId: "C123456" }, "This is the response");

			expect(consoleLogSpy).toHaveBeenCalledTimes(2);
			const responseCall = consoleLogSpy.mock.calls[1]![0];
			expect(responseCall).toContain("This is the response");
		});
	});

	describe("logInfo", () => {
		it("logs info message with system context", () => {
			logger.logInfo("System information message");

			const call = consoleLogSpy.mock.calls[0]![0];
			expect(call).toContain("[system]");
			expect(call).toContain("System information message");
		});
	});

	describe("logWarning", () => {
		it("logs warning with optional details", () => {
			logger.logWarning("Something went wrong", "Additional details here");

			expect(consoleLogSpy).toHaveBeenCalledTimes(2);
			const warningCall = consoleLogSpy.mock.calls[0]![0];
			expect(warningCall).toContain("warning");
			const detailsCall = consoleLogSpy.mock.calls[1]![0];
			expect(detailsCall).toContain("Additional details");
		});

		it("works without details", () => {
			logger.logWarning("Just a warning");

			expect(consoleLogSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("logAgentError", () => {
		it("logs agent error with context", () => {
			logger.logAgentError({ channelId: "C123456" }, "Agent crashed");

			expect(consoleLogSpy).toHaveBeenCalledTimes(2);
			const errorCall = consoleLogSpy.mock.calls[0]![0];
			expect(errorCall).toContain("Agent error");
		});

		it("handles system context", () => {
			logger.logAgentError("system", "System-level error");

			const call = consoleLogSpy.mock.calls[0]![0];
			expect(call).toContain("[system]");
		});
	});

	describe("logUsageSummary", () => {
		it("returns formatted usage summary string", () => {
			const usage = {
				input: 1000,
				output: 500,
				cacheRead: 100,
				cacheWrite: 50,
				cost: {
					input: 0.01,
					output: 0.02,
					cacheRead: 0.001,
					cacheWrite: 0.002,
					total: 0.033,
				},
			};

			const summary = logger.logUsageSummary({ channelId: "C123456" }, usage);

			expect(summary).toContain("Usage Summary");
			expect(summary).toContain("1,000 in");
			expect(summary).toContain("500 out");
			expect(summary).toContain("$0.0330");
		});

		it("hides cache info when both are zero", () => {
			const usage = {
				input: 1000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				cost: {
					input: 0.01,
					output: 0.02,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.03,
				},
			};

			const summary = logger.logUsageSummary({ channelId: "C123456" }, usage);

			expect(summary).not.toContain("cache read");
			expect(summary).not.toContain("cache write");
		});
	});

	describe("logStartup", () => {
		it("logs startup information", () => {
			logger.logStartup("/home/user/project", "docker:sandbox");

			expect(consoleLogSpy).toHaveBeenCalledTimes(3);
			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("Slack agent"),
			);
			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("/home/user/project"),
			);
			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("docker:sandbox"),
			);
		});
	});

	describe("logConnected", () => {
		it("logs connection success", () => {
			logger.logConnected();

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("connected and listening"),
			);
		});
	});

	describe("logDisconnected", () => {
		it("logs disconnection", () => {
			logger.logDisconnected();

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("disconnected"),
			);
		});
	});

	describe("backfill logging", () => {
		it("logs backfill start", () => {
			logger.logBackfillStart(5);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("Backfilling 5 channels"),
			);
		});

		it("logs individual channel backfill", () => {
			logger.logBackfillChannel("general", 42);

			expect(consoleLogSpy).toHaveBeenCalledWith(
				expect.stringContaining("#general: 42 messages"),
			);
		});

		it("logs backfill complete with duration", () => {
			logger.logBackfillComplete(150, 5000);

			const call = consoleLogSpy.mock.calls[0]![0];
			expect(call).toContain("Backfill complete");
			expect(call).toContain("150 messages");
			expect(call).toContain("5.0s");
		});
	});
});
