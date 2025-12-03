import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	recordBusinessMetric,
	recordCompaction,
	recordCost,
	recordModelSwitch,
	recordSandboxViolation,
	recordSessionDuration,
	recordSessionStart,
	recordTokenUsage,
} from "../../src/telemetry.js";

describe("Business Metrics Telemetry", () => {
	beforeEach(() => {
		// Enable telemetry for tests
		vi.stubEnv("COMPOSER_TELEMETRY", "1");
		vi.stubEnv("COMPOSER_TELEMETRY_FILE", "/tmp/test-telemetry.log");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe("recordBusinessMetric", () => {
		it("records a business metric without throwing", () => {
			expect(() => {
				recordBusinessMetric("session.count", 1, { sessionId: "test-123" });
			}).not.toThrow();
		});

		it("accepts all metric types", () => {
			const metrics = [
				"session.count",
				"session.duration",
				"lines_of_code.count",
				"tokens.input",
				"tokens.output",
				"tokens.cache_read",
				"tokens.cache_write",
				"cost.usd",
				"compaction.triggered",
				"model.switch",
			] as const;

			for (const metric of metrics) {
				expect(() => {
					recordBusinessMetric(metric, 1);
				}).not.toThrow();
			}
		});
	});

	describe("recordSessionStart", () => {
		it("records session start", () => {
			expect(() => {
				recordSessionStart("session-123", { model: "claude-3-opus" });
			}).not.toThrow();
		});
	});

	describe("recordSessionDuration", () => {
		it("records session duration in ms", () => {
			expect(() => {
				recordSessionDuration("session-123", 60000, {
					model: "claude-3-opus",
				});
			}).not.toThrow();
		});
	});

	describe("recordTokenUsage", () => {
		it("records token usage with all types", () => {
			expect(() => {
				recordTokenUsage(
					"session-123",
					{
						input: 1000,
						output: 500,
						cacheRead: 200,
						cacheWrite: 100,
					},
					{ model: "claude-3-opus" },
				);
			}).not.toThrow();
		});

		it("skips zero values", () => {
			expect(() => {
				recordTokenUsage("session-123", {
					input: 0,
					output: 100,
				});
			}).not.toThrow();
		});
	});

	describe("recordCost", () => {
		it("records cost in USD", () => {
			expect(() => {
				recordCost("session-123", 0.05, { model: "claude-3-opus" });
			}).not.toThrow();
		});
	});

	describe("recordCompaction", () => {
		it("records compaction event", () => {
			expect(() => {
				recordCompaction("session-123", { model: "claude-3-opus" });
			}).not.toThrow();
		});
	});

	describe("recordModelSwitch", () => {
		it("records model switch", () => {
			expect(() => {
				recordModelSwitch("session-123", "claude-3-opus", "claude-3-sonnet");
			}).not.toThrow();
		});
	});
});

describe("Sandbox Violation Telemetry", () => {
	beforeEach(() => {
		vi.stubEnv("COMPOSER_TELEMETRY", "1");
		vi.stubEnv("COMPOSER_TELEMETRY_FILE", "/tmp/test-telemetry.log");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe("recordSandboxViolation", () => {
		it("records blocked event", () => {
			expect(() => {
				recordSandboxViolation(
					"blocked",
					"bash",
					"rm -rf /",
					"Dangerous command blocked",
					{ command: "rm -rf /", sessionId: "test-123" },
				);
			}).not.toThrow();
		});

		it("records warned event", () => {
			expect(() => {
				recordSandboxViolation(
					"warned",
					"write",
					"/etc/passwd",
					"Writing to sensitive path",
					{ path: "/etc/passwd" },
				);
			}).not.toThrow();
		});

		it("records allowed event", () => {
			expect(() => {
				recordSandboxViolation(
					"allowed",
					"read",
					"/home/user/file.txt",
					"Read allowed after confirmation",
				);
			}).not.toThrow();
		});

		it("sanitizes command in output", () => {
			// Should not throw when command contains sensitive data
			expect(() => {
				recordSandboxViolation(
					"blocked",
					"bash",
					"curl -u secret:password http://api.example.com",
					"Network access blocked",
					{ command: "curl -u secret:password http://api.example.com" },
				);
			}).not.toThrow();
		});
	});
});
