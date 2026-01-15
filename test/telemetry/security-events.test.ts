import { describe, expect, it, beforeEach, vi } from "vitest";
import {
	trackLoopDetection,
	trackSequencePattern,
	trackContextFirewall,
	trackToolBlocked,
	trackToolApprovalRequired,
	trackSensitiveContent,
	getRecentEvents,
	getEventStats,
	clearEventBuffer,
	onSecurityEvent,
} from "../../src/telemetry/security-events.js";

describe("security-events", () => {
	beforeEach(() => {
		clearEventBuffer();
	});

	describe("trackLoopDetection", () => {
		it("tracks exact loop events", () => {
			trackLoopDetection({
				loopType: "exact",
				repetitions: 5,
				toolName: "read",
				action: "pause",
			});

			const events = getRecentEvents();
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("loop_detected");
			expect(events[0]?.severity).toBe("medium");
			expect(events[0]?.metadata?.loopType).toBe("exact");
		});

		it("assigns correct severity based on action", () => {
			trackLoopDetection({
				loopType: "exact",
				repetitions: 3,
				toolName: "read",
				action: "warn",
			});

			trackLoopDetection({
				loopType: "exact",
				repetitions: 5,
				toolName: "read",
				action: "halt",
			});

			const events = getRecentEvents();
			expect(events[0]?.severity).toBe("low");
			expect(events[1]?.severity).toBe("high");
		});
	});

	describe("trackSequencePattern", () => {
		it("tracks pattern detection events", () => {
			trackSequencePattern({
				patternId: "read-then-egress",
				toolName: "web_fetch",
				action: "require_approval",
				severity: "high",
				matchingTools: ["read", "web_fetch"],
			});

			const events = getRecentEvents();
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("sequence_pattern_detected");
			expect(events[0]?.metadata?.patternId).toBe("read-then-egress");
			expect(events[0]?.metadata?.matchingTools).toContain("read");
		});
	});

	describe("trackContextFirewall", () => {
		it("tracks firewall events", () => {
			trackContextFirewall({
				findingTypes: ["api_key", "aws_secret"],
				findingCount: 2,
				blocked: false,
				toolName: "bash",
			});

			const events = getRecentEvents();
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("context_firewall_triggered");
			expect(events[0]?.metadata?.findingCount).toBe(2);
		});

		it("assigns high severity when blocked", () => {
			trackContextFirewall({
				findingTypes: ["private_key"],
				findingCount: 1,
				blocked: true,
			});

			const events = getRecentEvents();
			expect(events[0]?.severity).toBe("high");
		});
	});

	describe("trackToolBlocked", () => {
		it("tracks blocked tool events", () => {
			trackToolBlocked({
				toolName: "bash",
				reason: "Suspicious command pattern",
				source: "sequence",
			});

			const events = getRecentEvents();
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("tool_blocked");
			expect(events[0]?.metadata?.source).toBe("sequence");
		});
	});

	describe("trackToolApprovalRequired", () => {
		it("tracks approval required events", () => {
			trackToolApprovalRequired({
				toolName: "write",
				reason: "Writing to system path",
				source: "policy",
			});

			const events = getRecentEvents();
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("tool_approval_required");
			expect(events[0]?.severity).toBe("medium");
		});
	});

	describe("trackSensitiveContent", () => {
		it("tracks sensitive content detection", () => {
			trackSensitiveContent({
				contentTypes: ["email", "phone"],
				count: 3,
				context: "tool arguments",
			});

			const events = getRecentEvents();
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("sensitive_content_detected");
			expect(events[0]?.severity).toBe("low");
		});
	});

	describe("getRecentEvents", () => {
		it("returns limited events", () => {
			for (let i = 0; i < 10; i++) {
				trackLoopDetection({
					loopType: "exact",
					repetitions: i,
					toolName: "read",
					action: "warn",
				});
			}

			const events = getRecentEvents(5);
			expect(events).toHaveLength(5);
		});

		it("filters by type", () => {
			trackLoopDetection({
				loopType: "exact",
				repetitions: 3,
				toolName: "read",
				action: "warn",
			});
			trackToolBlocked({
				toolName: "bash",
				reason: "test",
				source: "sequence",
			});

			const events = getRecentEvents(100, { type: "loop_detected" });
			expect(events).toHaveLength(1);
			expect(events[0]?.type).toBe("loop_detected");
		});

		it("filters by severity", () => {
			trackLoopDetection({
				loopType: "exact",
				repetitions: 3,
				toolName: "read",
				action: "warn", // low severity
			});
			trackToolBlocked({
				toolName: "bash",
				reason: "test",
				source: "sequence", // high severity
			});

			const events = getRecentEvents(100, { severity: "high" });
			expect(events).toHaveLength(1);
			expect(events[0]?.severity).toBe("high");
		});
	});

	describe("getEventStats", () => {
		it("calculates event statistics", () => {
			trackLoopDetection({
				loopType: "exact",
				repetitions: 3,
				toolName: "read",
				action: "warn",
			});
			trackLoopDetection({
				loopType: "cyclic",
				repetitions: 2,
				toolName: "read",
				action: "pause",
			});
			trackToolBlocked({
				toolName: "bash",
				reason: "test",
				source: "sequence",
			});

			const stats = getEventStats();
			expect(stats.total).toBe(3);
			expect(stats.byType.loop_detected).toBe(2);
			expect(stats.byType.tool_blocked).toBe(1);
			expect(stats.bySeverity.low).toBe(1);
			expect(stats.bySeverity.medium).toBe(1);
			expect(stats.bySeverity.high).toBe(1);
		});

		it("tracks recent high severity events", () => {
			trackToolBlocked({
				toolName: "bash",
				reason: "test",
				source: "sequence",
				severity: "critical",
			});

			const stats = getEventStats();
			expect(stats.recentHigh).toBe(1);
		});
	});

	describe("onSecurityEvent", () => {
		it("notifies listeners of events", () => {
			const listener = vi.fn();
			const unsubscribe = onSecurityEvent(listener);

			trackLoopDetection({
				loopType: "exact",
				repetitions: 3,
				toolName: "read",
				action: "warn",
			});

			expect(listener).toHaveBeenCalledTimes(1);
			expect(listener).toHaveBeenCalledWith(
				expect.objectContaining({ type: "loop_detected" }),
			);

			unsubscribe();
		});

		it("unsubscribes properly", () => {
			const listener = vi.fn();
			const unsubscribe = onSecurityEvent(listener);

			unsubscribe();

			trackLoopDetection({
				loopType: "exact",
				repetitions: 3,
				toolName: "read",
				action: "warn",
			});

			expect(listener).not.toHaveBeenCalled();
		});

		it("handles listener errors gracefully", () => {
			const errorListener = vi.fn().mockImplementation(() => {
				throw new Error("Listener error");
			});
			const goodListener = vi.fn();

			onSecurityEvent(errorListener);
			onSecurityEvent(goodListener);

			// Should not throw
			expect(() => {
				trackLoopDetection({
					loopType: "exact",
					repetitions: 3,
					toolName: "read",
					action: "warn",
				});
			}).not.toThrow();

			// Good listener should still be called
			expect(goodListener).toHaveBeenCalled();
		});
	});

	describe("buffer management", () => {
		it("clears buffer", () => {
			trackLoopDetection({
				loopType: "exact",
				repetitions: 3,
				toolName: "read",
				action: "warn",
			});

			expect(getRecentEvents()).toHaveLength(1);

			clearEventBuffer();

			expect(getRecentEvents()).toHaveLength(0);
		});
	});
});
