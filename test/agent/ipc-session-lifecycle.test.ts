import { describe, expect, it } from "vitest";
import {
	beginShutdown,
	completeHandshake,
	finishShutdown,
	isLive,
	isTerminal,
	markFailed,
	transitionForMessage,
} from "../../src/agent/ipc-session-lifecycle.js";

describe("agent/ipc-session-lifecycle", () => {
	describe("transitionForMessage", () => {
		it("accepts hello from connected and moves to handshaking", () => {
			expect(transitionForMessage("connected", "hello")).toEqual({
				ok: true,
				nextState: "handshaking",
			});
		});

		it("rejects hello once a session has already moved past connected", () => {
			for (const state of ["handshaking", "ready", "draining"] as const) {
				const result = transitionForMessage(state, "hello");
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.reason).toBe("hello-already-received");
				}
			}
		});

		it("rejects requests before ready", () => {
			for (const state of ["connected", "handshaking"] as const) {
				const result = transitionForMessage(state, "request");
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.reason).toBe("request-before-ready");
				}
			}
		});

		it("accepts requests in ready (no state change)", () => {
			expect(transitionForMessage("ready", "request")).toEqual({
				ok: true,
				nextState: "ready",
			});
		});

		it("rejects new requests during drain", () => {
			const result = transitionForMessage("draining", "request");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("request-during-drain");
			}
		});

		it("allows responses to complete during drain", () => {
			expect(transitionForMessage("draining", "response")).toEqual({
				ok: true,
				nextState: "draining",
			});
		});

		it("rejects responses before ready", () => {
			for (const state of ["connected", "handshaking"] as const) {
				const result = transitionForMessage(state, "response");
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.reason).toBe("response-before-ready");
				}
			}
		});

		it("accepts events only in ready (not connected, handshaking, or drain)", () => {
			expect(transitionForMessage("ready", "event")).toEqual({
				ok: true,
				nextState: "ready",
			});
			const draining = transitionForMessage("draining", "event");
			expect(draining.ok).toBe(false);
			if (!draining.ok) expect(draining.reason).toBe("event-after-drain");
			for (const state of ["connected", "handshaking"] as const) {
				const result = transitionForMessage(state, "event");
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.reason).toBe("event-before-ready");
			}
		});

		it("rejects every message kind once the session is closed", () => {
			for (const kind of ["hello", "request", "response", "event"] as const) {
				const result = transitionForMessage("closed", kind);
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.reason).toBe("already-closed");
			}
		});

		it("rejects every message kind once the session has failed", () => {
			for (const kind of ["hello", "request", "response", "event"] as const) {
				const result = transitionForMessage("failed", kind);
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.reason).toBe("already-failed");
			}
		});
	});

	describe("completeHandshake", () => {
		it("moves handshaking → ready", () => {
			expect(completeHandshake("handshaking")).toBe("ready");
		});

		it("throws when called outside the handshaking state", () => {
			for (const state of [
				"connected",
				"ready",
				"draining",
				"closed",
				"failed",
			] as const) {
				expect(() => completeHandshake(state)).toThrow(
					/cannot complete handshake/,
				);
			}
		});
	});

	describe("beginShutdown", () => {
		it("moves ready / handshaking → draining", () => {
			expect(beginShutdown("ready")).toBe("draining");
			expect(beginShutdown("handshaking")).toBe("draining");
		});

		it("moves connected → closed (no in-flight requests to drain)", () => {
			expect(beginShutdown("connected")).toBe("closed");
		});

		it("is idempotent on terminal states", () => {
			expect(beginShutdown("closed")).toBe("closed");
			expect(beginShutdown("failed")).toBe("failed");
		});

		it("re-draining is a no-op", () => {
			expect(beginShutdown("draining")).toBe("closed");
		});
	});

	describe("finishShutdown", () => {
		it("moves draining → closed", () => {
			expect(finishShutdown("draining")).toBe("closed");
		});

		it("forces any non-terminal state to closed", () => {
			for (const state of [
				"connected",
				"handshaking",
				"ready",
				"draining",
			] as const) {
				expect(finishShutdown(state)).toBe("closed");
			}
		});

		it("is idempotent on terminal states", () => {
			expect(finishShutdown("closed")).toBe("closed");
			expect(finishShutdown("failed")).toBe("failed");
		});
	});

	describe("markFailed", () => {
		it("moves any live state to failed", () => {
			for (const state of [
				"connected",
				"handshaking",
				"ready",
				"draining",
			] as const) {
				expect(markFailed(state)).toBe("failed");
			}
		});

		it("does not overwrite closed", () => {
			expect(markFailed("closed")).toBe("closed");
		});

		it("is idempotent on failed", () => {
			expect(markFailed("failed")).toBe("failed");
		});
	});

	describe("isLive / isTerminal", () => {
		it("treats connected/handshaking/ready/draining as live", () => {
			for (const state of [
				"connected",
				"handshaking",
				"ready",
				"draining",
			] as const) {
				expect(isLive(state)).toBe(true);
				expect(isTerminal(state)).toBe(false);
			}
		});

		it("treats closed/failed as terminal", () => {
			for (const state of ["closed", "failed"] as const) {
				expect(isLive(state)).toBe(false);
				expect(isTerminal(state)).toBe(true);
			}
		});
	});
});
