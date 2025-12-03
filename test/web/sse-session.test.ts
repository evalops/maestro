import type { ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/types.js";
import { SseSession } from "../../src/web/sse-session.js";

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

	it("writes events and heartbeats", () => {
		const res = createRes();
		const session = new SseSession(
			res as unknown as ServerResponse,
			undefined,
			undefined,
			50,
		);
		const event: AgentEvent = { type: "message_delta", delta: "hi" };
		session.sendEvent(event);
		session.startHeartbeat();
		vi.advanceTimersByTime(120);
		session.stopHeartbeat();
		expect(res.chunks.some((c: string) => c.includes("heartbeat"))).toBe(true);
	});

	it("records skipped writes after disconnect", () => {
		const res = createRes();
		res.writable = false;
		const onSkip = vi.fn();
		const session = new SseSession(res as unknown as ServerResponse, onSkip);
		const event1: AgentEvent = { type: "message_delta", delta: "hi" };
		const event2: AgentEvent = { type: "message_delta", delta: "hi again" };
		session.sendEvent(event1);
		session.sendEvent(event2);
		expect(onSkip).toHaveBeenCalled();
		const metrics = session.getMetrics();
		expect(metrics.skipped).toBeGreaterThan(0);
	});
});
