import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/agent/types.js";
import { SseSession } from "../src/web-server.js";

interface MockResponse {
	writable: boolean;
	writableEnded: boolean;
	destroyed: boolean;
	write: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
	flushHeaders: ReturnType<typeof vi.fn>;
}

function createMockResponse(
	overrides: Partial<MockResponse> = {},
): MockResponse {
	return {
		writable: true,
		writableEnded: false,
		destroyed: false,
		write: vi.fn(),
		end: vi.fn(),
		flushHeaders: vi.fn(),
		...overrides,
	};
}

describe("SseSession", () => {
	it("guards writes that throw after disconnect", () => {
		const res = createMockResponse({
			write: vi.fn().mockImplementation(() => {
				throw new Error("EPIPE");
			}),
		});
		const session = new SseSession(res);
		const event: AgentEvent = {
			type: "status",
			status: "test",
			details: {},
		} as AgentEvent;

		expect(() => session.sendEvent(event)).not.toThrow();
		const metrics = session.getMetrics();
		expect(metrics.sent).toBe(0);
		expect(metrics.skipped).toBe(1);
		expect(metrics.lastError).toBeInstanceOf(Error);
	});

	it("skips writes when already ended", () => {
		const res = createMockResponse({ writableEnded: true });
		const session = new SseSession(res);
		session.sendHeartbeat();
		const metrics = session.getMetrics();
		expect(metrics.sent).toBe(0);
		expect(metrics.skipped).toBe(1);
	});

	it("swallows end errors after disconnect", () => {
		const res = createMockResponse({
			write: vi.fn(),
			end: vi.fn().mockImplementation(() => {
				throw new Error("end exploded");
			}),
		});
		const session = new SseSession(res);
		// Mark as not writable to force skip then attempt end
		res.writableEnded = false;
		expect(() => session.end()).not.toThrow();
		const metrics = session.getMetrics();
		expect(metrics.skipped).toBeGreaterThanOrEqual(1);
	});
});
