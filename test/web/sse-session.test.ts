import { beforeEach, describe, expect, it, vi } from "vitest";
import { SseSession } from "../../src/web/sse-session.js";

const createRes = () => {
	const res: any = {
		chunks: [] as string[],
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
		const session = new SseSession(res, undefined, undefined, 50);
		session.sendEvent({ type: "message_delta", delta: "hi" } as any);
		session.startHeartbeat();
		vi.advanceTimersByTime(120);
		session.stopHeartbeat();
		expect(res.chunks.some((c: string) => c.includes("heartbeat"))).toBe(true);
	});

	it("records skipped writes after disconnect", () => {
		const res = createRes();
		res.writable = false;
		const onSkip = vi.fn();
		const session = new SseSession(res, onSkip);
		session.sendEvent({ type: "message_delta", delta: "hi" } as any);
		session.sendEvent({ type: "message_delta", delta: "hi again" } as any);
		expect(onSkip).toHaveBeenCalled();
		const metrics = session.getMetrics();
		expect(metrics.skipped).toBeGreaterThan(0);
	});
});
