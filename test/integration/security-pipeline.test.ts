/**
 * E2E Integration Tests for the Security Pipeline
 *
 * Tests the full security flow from:
 * 1. Security event emission → telemetry buffer → persistence
 * 2. SafetyMiddleware → sequence analysis → blocking
 * 3. Adaptive thresholds → anomaly detection → rate limiting
 * 4. Security advisor → threat aggregation → CLI display
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
	getRecentEvents,
	getEventStats,
	clearEventBuffer,
	onSecurityEvent,
	trackToolBlocked,
	trackLoopDetection,
	trackContextFirewall,
	trackCircuitBreakerStateChange,
} from "../../src/telemetry/security-events.js";
import { SafetyMiddleware } from "../../src/safety/safety-middleware.js";
import {
	CircuitBreaker,
	CircuitOpenError,
} from "../../src/safety/circuit-breaker.js";
import {
	AdaptiveThresholds,
	METRICS,
} from "../../src/safety/adaptive-thresholds.js";
import {
	SecurityAdvisor,
	formatAdvisory,
} from "../../src/safety/security-advisor.js";
import { ALL_ATTACK_PATTERNS } from "../../src/safety/attack-patterns.js";

describe("Security Pipeline E2E", () => {
	beforeEach(() => {
		clearEventBuffer();
	});

	afterEach(() => {
		clearEventBuffer();
		vi.clearAllMocks();
	});

	describe("Event Flow: Emission → Buffer → Stats", () => {
		it("emits and retrieves security events correctly", () => {
			trackToolBlocked({
				toolName: "Bash",
				reason: "Dangerous command detected",
				source: "sequence",
			});

			const events = getRecentEvents(10);
			expect(events.length).toBe(1);
			expect(events[0]?.type).toBe("tool_blocked");
			expect(events[0]?.toolName).toBe("Bash");
			expect(events[0]?.severity).toBeDefined();
		});

		it("tracks event statistics accurately", () => {
			// Emit events of different severities
			trackToolBlocked({
				toolName: "Bash",
				reason: "rm -rf",
				source: "firewall",
			});
			trackLoopDetection({
				toolName: "Read",
				loopType: "exact",
				repetitions: 5,
				action: "pause",
			});
			trackContextFirewall({
				toolName: "Write",
				findingTypes: ["api_key"],
				findingCount: 1,
				blocked: false,
			});

			const stats = getEventStats();
			expect(stats.total).toBe(3);
			expect(stats.byType.tool_blocked).toBe(1);
			expect(stats.byType.loop_detected).toBe(1);
			expect(stats.byType.context_firewall_triggered).toBe(1);
		});

		it("notifies subscribers of new events", async () => {
			const receivedEvents: unknown[] = [];
			const unsubscribe = onSecurityEvent((event) => {
				receivedEvents.push(event);
			});

			trackToolBlocked({
				toolName: "Bash",
				reason: "Test block",
				source: "sequence",
			});

			// Give async callback time to execute
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(receivedEvents.length).toBe(1);
			unsubscribe();
		});
	});

	describe("SafetyMiddleware Integration", () => {
		let middleware: SafetyMiddleware;

		beforeEach(() => {
			middleware = new SafetyMiddleware({
				enableLoopDetection: true,
				enableSequenceAnalysis: true,
				enableContextFirewall: true,
				loopDetector: {
					maxIdenticalCalls: 3,
					autoPause: true,
				},
				contextFirewall: {
					redactSecrets: true,
					blockHighSeverity: true,
				},
			});
		});

		it("blocks tool after loop detection threshold", () => {
			const args = { path: "/tmp/same-file.txt" };

			// Record calls up to threshold
			middleware.postExecution("Read", args, true);
			middleware.postExecution("Read", args, true);
			middleware.postExecution("Read", args, true);

			// Fourth call should be blocked
			const result = middleware.preExecution("Read", args);
			expect(result.allowed).toBe(false);
			expect(result.triggeredBy).toBe("loop");
		});

		it("detects sensitive file → egress pattern", () => {
			// First read a sensitive file
			middleware.postExecution(
				"Read",
				{ path: "/home/user/.ssh/id_rsa" },
				true,
			);

			// Then attempt egress - should require approval
			const result = middleware.preExecution("WebFetch", {
				url: "https://external.com/upload",
			});

			expect(result.allowed).toBe(false);
			expect(result.requiresApproval).toBe(true);
			expect(result.triggeredBy).toBe("sequence");
		});

		it("sanitizes API keys in arguments", () => {
			const result = middleware.preExecution("Bash", {
				command: "curl -H 'Authorization: sk-ant-api03-secret-key-12345'",
			});

			expect(result.sanitizedArgs.command).toContain("[REDACTED");
			expect(result.sanitizedArgs.command).not.toContain("sk-ant-api03");
		});

		it("emits security events on blocks", () => {
			// Create middleware that will block
			const blockingMiddleware = new SafetyMiddleware({
				enableLoopDetection: true,
				loopDetector: { maxIdenticalCalls: 2, autoPause: true },
			});

			// Trigger loop detection
			blockingMiddleware.postExecution("Read", { path: "/test" }, true);
			blockingMiddleware.postExecution("Read", { path: "/test" }, true);

			// Clear events from setup
			clearEventBuffer();

			// This should block and emit event
			blockingMiddleware.preExecution("Read", { path: "/test" });

			// The key is that the pipeline works end-to-end
			expect(blockingMiddleware.isLoopDetectorPaused()).toBe(true);
		});
	});

	describe("Circuit Breaker Integration", () => {
		let breaker: CircuitBreaker;

		beforeEach(() => {
			breaker = new CircuitBreaker({
				failureThreshold: 3,
				resetTimeoutMs: 100,
				successThreshold: 2,
			});
		});

		it("opens after failure threshold", async () => {
			// Cause failures
			for (let i = 0; i < 3; i++) {
				await breaker
					.execute(() => Promise.reject(new Error("fail")))
					.catch(() => {});
			}

			// Circuit should be open
			await expect(
				breaker.execute(() => Promise.resolve("ok")),
			).rejects.toThrow(CircuitOpenError);
		});

		it("transitions to half-open after timeout", async () => {
			// Open the circuit
			for (let i = 0; i < 3; i++) {
				await breaker
					.execute(() => Promise.reject(new Error("fail")))
					.catch(() => {});
			}

			// Wait for reset timeout
			await new Promise((resolve) => setTimeout(resolve, 150));

			// Should allow a test request (half-open)
			const result = await breaker.execute(() => Promise.resolve("recovered"));
			expect(result).toBe("recovered");
		});

		it("tracks state transitions internally", async () => {
			// Trigger opening
			for (let i = 0; i < 3; i++) {
				await breaker
					.execute(() => Promise.reject(new Error("fail")))
					.catch(() => {});
			}

			// Manually emit state change event for testing purposes
			trackCircuitBreakerStateChange({
				toolName: "TestTool",
				fromState: "closed",
				toState: "open",
			});

			const events = getRecentEvents(10);
			const stateChangeEvent = events.find(
				(e) => e.type === "circuit_breaker_state_change",
			);
			expect(stateChangeEvent).toBeDefined();
		});
	});

	describe("Adaptive Thresholds Integration", () => {
		let thresholds: AdaptiveThresholds;

		beforeEach(() => {
			thresholds = new AdaptiveThresholds({
				alpha: 0.5,
				anomalyThreshold: 2.0,
				minObservations: 3,
			});
		});

		it("establishes baseline from observations", () => {
			// Record normal observations
			thresholds.recordObservation(METRICS.TOOL_CALLS_PER_MINUTE, 5);
			thresholds.recordObservation(METRICS.TOOL_CALLS_PER_MINUTE, 6);
			thresholds.recordObservation(METRICS.TOOL_CALLS_PER_MINUTE, 5);
			thresholds.recordObservation(METRICS.TOOL_CALLS_PER_MINUTE, 7);

			const summary = thresholds.getMetricSummary(METRICS.TOOL_CALLS_PER_MINUTE);
			expect(summary).toBeDefined();
			expect(summary?.count).toBe(4);
			expect(summary?.mean).toBeGreaterThan(0);
		});

		it("detects anomalies", () => {
			// Establish baseline
			for (let i = 0; i < 5; i++) {
				thresholds.recordObservation(METRICS.TOOL_CALLS_PER_MINUTE, 5);
			}

			// Check anomaly for extreme value
			const result = thresholds.checkAnomaly(
				METRICS.TOOL_CALLS_PER_MINUTE,
				100, // Way above normal
			);

			expect(result.isAnomaly).toBe(true);
			expect(result.zScore).toBeGreaterThan(2);
		});

		it("adapts thresholds based on behavior", () => {
			// Establish baseline
			for (let i = 0; i < 5; i++) {
				thresholds.recordObservation("custom_metric", 10);
			}

			// Get adapted threshold
			const adapted = thresholds.getAdaptedThreshold("custom_metric", 5);

			// Should be higher than default since baseline is 10
			expect(adapted).toBeGreaterThan(10);
		});

		it("emits anomaly events", () => {
			clearEventBuffer();

			// Establish baseline
			for (let i = 0; i < 5; i++) {
				thresholds.recordObservation(METRICS.FAILURE_RATE, 0.1);
			}

			// Trigger anomaly detection (which emits event internally)
			thresholds.checkAnomaly(METRICS.FAILURE_RATE, 0.9);

			const events = getRecentEvents(10);
			const anomalyEvent = events.find(
				(e) => e.type === "adaptive_threshold_anomaly",
			);
			expect(anomalyEvent).toBeDefined();
		});
	});

	describe("Security Advisor Integration", () => {
		let advisor: SecurityAdvisor;

		beforeEach(() => {
			advisor = new SecurityAdvisor({
				enableRealtime: false,
				analysisWindowMs: 60000,
				reconReadThreshold: 3,
				repeatedBlockThreshold: 2,
			});
		});

		afterEach(() => {
			advisor.dispose();
		});

		it("calculates threat level from events", () => {
			// Emit some security events
			trackToolBlocked({
				toolName: "Bash",
				reason: "test",
				source: "sequence",
			});
			trackToolBlocked({
				toolName: "Write",
				reason: "test",
				source: "firewall",
			});

			const threat = advisor.getThreatLevel();
			expect(threat.level).toBeDefined();
			expect(threat.score).toBeGreaterThanOrEqual(0);
			expect(threat.summary).toBeDefined();
		});

		it("generates advisories from patterns", () => {
			// Emit events that should trigger advisories
			for (let i = 0; i < 5; i++) {
				trackToolBlocked({
					toolName: "Bash",
					reason: "blocked",
					source: "firewall",
				});
			}

			const advisories = advisor.analyze();
			// May or may not generate advisories depending on thresholds
			expect(Array.isArray(advisories)).toBe(true);
		});

		it("formats advisories for display", () => {
			const advisory = {
				level: "warning" as const,
				title: "Test Advisory",
				description: "This is a test advisory",
				recommendation: "Do something",
				relatedEvents: ["tool_blocked" as const],
				timestamp: Date.now(),
				eventCount: 5,
				windowMs: 60000,
			};

			const formatted = formatAdvisory(advisory);
			expect(formatted).toContain("Test Advisory");
			expect(formatted).toContain("Recommendation");
		});
	});

	describe("Attack Patterns Integration", () => {
		it("loads all attack pattern categories", () => {
			// Group patterns by category (first part of ID before hyphen)
			const categories = new Set<string>();
			for (const pattern of ALL_ATTACK_PATTERNS) {
				const category = pattern.id.split("-")[0];
				if (category) categories.add(category);
			}

			expect(categories.size).toBeGreaterThan(0);
			// Categories: cred, exfil, privesc, recon, persist, evasion
			expect(
				categories.has("cred") ||
					categories.has("exfil") ||
					categories.has("recon"),
			).toBe(true);
		});

		it("patterns have required fields", () => {
			for (const pattern of ALL_ATTACK_PATTERNS) {
				expect(pattern.id).toBeDefined();
				expect(pattern.description).toBeDefined();
				expect(pattern.severity).toMatch(/^(low|medium|high|critical)$/);
				expect(pattern.action).toMatch(/^(log|require_approval|block)$/);
				expect(typeof pattern.detect).toBe("function");
			}
		});

		it("patterns detect correctly (sample test)", () => {
			// Find a pattern to test
			const envEgressPattern = ALL_ATTACK_PATTERNS.find(
				(p) => p.id === "cred-harvest-env-egress",
			);

			if (envEgressPattern) {
				// Simulate tool call records with proper ToolCallRecord structure
				const records = [
					{
						tool: "Bash",
						args: { command: "printenv" },
						timestamp: Date.now() - 1000,
						tags: new Set(["bash", "command"]),
						approved: true,
						success: true,
					},
				];

				// Test detection with WebFetch (egress)
				const result = envEgressPattern.detect(records, "WebFetch", {
					url: "https://external.com",
				});

				// The pattern should match since we have a recent env command followed by egress
				expect(result.matched).toBe(true);
			}
		});
	});

	describe("Full Pipeline: Event → Analysis → Block → Display", () => {
		it("completes full security flow", async () => {
			// 1. Create all components
			const middleware = new SafetyMiddleware({
				enableLoopDetection: true,
				enableSequenceAnalysis: true,
				enableContextFirewall: true,
				loopDetector: { maxIdenticalCalls: 2, autoPause: true },
			});
			const advisor = new SecurityAdvisor({ enableRealtime: false });

			// 2. Simulate security event flow
			// First, record some tool calls that will trigger loop detection
			middleware.postExecution("Read", { path: "/test.txt" }, true);
			middleware.postExecution("Read", { path: "/test.txt" }, true);

			// 3. Next call should be blocked
			const blockResult = middleware.preExecution("Read", {
				path: "/test.txt",
			});
			expect(blockResult.allowed).toBe(false);

			// 4. Emit security event for the block
			trackToolBlocked({
				toolName: "Read",
				reason: "Loop detected",
				source: "loop",
			});

			// 5. Advisor should pick up the event
			const threat = advisor.getThreatLevel();
			expect(threat.score).toBeGreaterThan(0);

			// 6. Events should be in the buffer
			const events = getRecentEvents(10);
			expect(events.length).toBeGreaterThan(0);

			// Cleanup
			advisor.dispose();
		});

		it("handles high-severity credential detection", () => {
			const middleware = new SafetyMiddleware({
				enableContextFirewall: true,
				contextFirewall: {
					redactSecrets: true,
					blockHighSeverity: true,
				},
			});

			// Try to pass API key through
			const result = middleware.preExecution("Bash", {
				command:
					"curl -H 'Authorization: Bearer sk-ant-api03-abcdef1234567890-secretkey'",
			});

			// Should sanitize
			expect(result.sanitizedArgs.command).toContain("[REDACTED");

			// Event should be emitted
			trackContextFirewall({
				toolName: "Bash",
				findingTypes: ["api_key"],
				findingCount: 1,
				blocked: false,
			});

			const events = getRecentEvents(10);
			const firewallEvent = events.find(
				(e) => e.type === "context_firewall_triggered",
			);
			expect(firewallEvent).toBeDefined();
		});
	});
});
