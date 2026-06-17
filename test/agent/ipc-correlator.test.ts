import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	IpcCorrelatorDisposedError,
	IpcRequestTimeoutError,
	IpcResponseError,
	RequestCorrelator,
} from "../../src/agent/ipc-correlator.js";
import {
	type IpcRequest,
	makeErrorResponse,
	makeEvent,
	makeResponse,
} from "../../src/agent/ipc-envelope.js";

describe("agent/ipc-correlator", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("RequestCorrelator.request", () => {
		it("dispatches the request through send() and resolves with the response result", async () => {
			const sent: IpcRequest[] = [];
			const corr = new RequestCorrelator({
				send: (req) => sent.push(req),
			});
			const p = corr.request<unknown, { ok: boolean }>("mission.list");
			expect(sent).toHaveLength(1);
			expect(sent[0]?.method).toBe("mission.list");
			corr.receive(makeResponse(sent[0]!.id, { ok: true }));
			await expect(p).resolves.toEqual({ ok: true });
		});

		it("rejects with IpcResponseError on an error response", async () => {
			const sent: IpcRequest[] = [];
			const corr = new RequestCorrelator({
				send: (req) => sent.push(req),
			});
			const p = corr.request("mission.qux");
			corr.receive(
				makeErrorResponse(sent[0]!.id, {
					code: "unknown-method",
					message: "no such method: mission.qux",
				}),
			);
			await expect(p).rejects.toBeInstanceOf(IpcResponseError);
			await expect(p).rejects.toMatchObject({ code: "unknown-method" });
		});

		it("times out per defaultTimeoutMs", async () => {
			const corr = new RequestCorrelator({
				send: () => {},
				defaultTimeoutMs: 100,
			});
			const p = corr.request("noop");
			const expectation = expect(p).rejects.toBeInstanceOf(
				IpcRequestTimeoutError,
			);
			vi.advanceTimersByTime(100);
			await expectation;
		});

		it("times out per per-call timeoutMs", async () => {
			const corr = new RequestCorrelator({
				send: () => {},
				defaultTimeoutMs: 100_000,
			});
			const p = corr.request("noop", undefined, { timeoutMs: 50 });
			const expectation = expect(p).rejects.toBeInstanceOf(
				IpcRequestTimeoutError,
			);
			vi.advanceTimersByTime(50);
			await expectation;
		});

		it("timeoutMs <= 0 disables the timeout", () => {
			const corr = new RequestCorrelator({
				send: () => {},
				defaultTimeoutMs: 100,
			});
			corr.request("noop", undefined, { timeoutMs: 0 });
			vi.advanceTimersByTime(1_000_000);
			// Still pending; never rejected by timer.
			expect(corr.pendingCount()).toBe(1);
		});

		it("rejects the promise when send() throws synchronously", async () => {
			const corr = new RequestCorrelator({
				send: () => {
					throw new Error("transport closed");
				},
			});
			await expect(corr.request("noop")).rejects.toThrow("transport closed");
			expect(corr.pendingCount()).toBe(0);
		});

		it("rejects with IpcCorrelatorDisposedError after dispose()", async () => {
			const corr = new RequestCorrelator({ send: () => {} });
			corr.dispose();
			await expect(corr.request("noop")).rejects.toBeInstanceOf(
				IpcCorrelatorDisposedError,
			);
		});

		it("allocates monotonic ids by default (req-1, req-2, …)", () => {
			const sent: IpcRequest[] = [];
			const corr = new RequestCorrelator({
				send: (req) => sent.push(req),
			});
			corr.request("a");
			corr.request("b");
			expect(sent.map((r) => r.id)).toEqual(["req-1", "req-2"]);
		});

		it("accepts a custom allocateId for deterministic tests", () => {
			const sent: IpcRequest[] = [];
			const corr = new RequestCorrelator({
				send: (req) => sent.push(req),
				allocateId: () => "fixed-id",
			});
			corr.request("a");
			expect(sent[0]?.id).toBe("fixed-id");
		});
	});

	describe("RequestCorrelator.receive", () => {
		it("silently drops responses with no matching pending request", () => {
			const corr = new RequestCorrelator({ send: () => {} });
			expect(() =>
				corr.receive(makeResponse("ghost", { ok: true })),
			).not.toThrow();
		});

		it("fans events out to every subscriber", () => {
			const corr = new RequestCorrelator({ send: () => {} });
			const a: unknown[] = [];
			const b: unknown[] = [];
			corr.onEvent((e) => a.push(e));
			corr.onEvent((e) => b.push(e));
			corr.receive(makeEvent("log", { line: "hi" }));
			expect(a).toHaveLength(1);
			expect(b).toHaveLength(1);
		});

		it("onEvent returns an unsubscribe function", () => {
			const corr = new RequestCorrelator({ send: () => {} });
			const got: unknown[] = [];
			const unsub = corr.onEvent((e) => got.push(e));
			corr.receive(makeEvent("c", 1));
			unsub();
			corr.receive(makeEvent("c", 2));
			expect(got).toHaveLength(1);
		});

		it("isolates a rude listener that throws so the rest still see the event", () => {
			const corr = new RequestCorrelator({ send: () => {} });
			const consoleErr = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});
			corr.onEvent(() => {
				throw new Error("rude");
			});
			let seen = 0;
			corr.onEvent(() => {
				seen += 1;
			});
			corr.receive(makeEvent("c", 1));
			expect(seen).toBe(1);
			consoleErr.mockRestore();
		});
	});

	describe("RequestCorrelator.dispose", () => {
		it("rejects every pending request with IpcCorrelatorDisposedError", async () => {
			const corr = new RequestCorrelator({ send: () => {} });
			const a = corr.request("a");
			const b = corr.request("b");
			corr.dispose();
			await expect(a).rejects.toBeInstanceOf(IpcCorrelatorDisposedError);
			await expect(b).rejects.toBeInstanceOf(IpcCorrelatorDisposedError);
		});

		it("clears pending timeouts so they never fire post-dispose", async () => {
			const corr = new RequestCorrelator({
				send: () => {},
				defaultTimeoutMs: 100,
			});
			const p = corr.request("noop");
			const expectation = expect(p).rejects.toBeInstanceOf(
				IpcCorrelatorDisposedError,
			);
			corr.dispose();
			await expectation;
			// Even after the timer would have fired, no new rejection happens.
			vi.advanceTimersByTime(1_000);
		});

		it("is idempotent", () => {
			const corr = new RequestCorrelator({ send: () => {} });
			corr.dispose();
			expect(() => corr.dispose()).not.toThrow();
		});
	});
});
