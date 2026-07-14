import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/types.js";
import { SseSession } from "../../src/server/sse-session.js";

interface MockResponse {
	chunks: string[];
	writable: boolean;
	writableEnded: boolean;
	destroyed: boolean;
	write(chunk: string): void;
	end(): void;
}

const createRes = (): MockResponse => {
	const res: MockResponse = {
		chunks: [],
		writable: true,
		writableEnded: false,
		destroyed: false,
		write(chunk: string) {
			this.chunks.push(chunk);
		},
		end() {
			this.writableEnded = true;
		},
	};
	return res;
};

describe("SseSession", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("writes events and heartbeats", () => {
		const res = createRes();
		const session = new SseSession(
			res as unknown as ServerResponse,
			undefined,
			undefined,
			50,
		);
		const event: AgentEvent = { type: "status", status: "delta", details: {} };
		session.sendEvent(event);
		session.startHeartbeat();
		vi.advanceTimersByTime(120);
		session.stopHeartbeat();
		expect(res.chunks.some((c: string) => c.includes("heartbeat"))).toBe(true);
	});

	it("writes routing receipts as first-class stream events", () => {
		const res = createRes();
		const session = new SseSession(res as unknown as ServerResponse);

		session.sendRoutingReceipt({
			decisionId: "decision-1",
			requestedProfile: "high",
			source: "session",
			resolvedProfileId: "high-v1",
			resolvedProfileVersion: 1,
			provider: "anthropic",
			model: "claude-opus-4-6",
			reasoningEffort: "xhigh",
			createdAt: "2026-07-14T12:00:00.000Z",
		});

		expect(res.chunks).toContainEqual(
			expect.stringContaining('"type":"routing_receipt"'),
		);
	});

	it("records skipped writes after disconnect", () => {
		const res = createRes();
		res.writable = false;
		const onSkip = vi.fn();
		const session = new SseSession(res as unknown as ServerResponse, onSkip);
		const event1: AgentEvent = {
			type: "status",
			status: "delta1",
			details: {},
		};
		const event2: AgentEvent = {
			type: "status",
			status: "delta2",
			details: {},
		};
		session.sendEvent(event1);
		session.sendEvent(event2);
		expect(onSkip).toHaveBeenCalled();
		const metrics = session.getMetrics();
		expect(metrics.skipped).toBeGreaterThan(0);
	});
});
