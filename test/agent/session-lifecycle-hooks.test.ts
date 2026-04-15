import { afterEach, describe, expect, it } from "vitest";
import {
	applySessionEndHooks,
	computeSessionDurationMs,
	countCompletedTurns,
} from "../../src/agent/session-lifecycle-hooks.js";
import { clearRegisteredHooks, registerHook } from "../../src/hooks/index.js";

describe("session-lifecycle-hooks", () => {
	afterEach(() => {
		clearRegisteredHooks();
	});

	it("counts assistant messages as completed turns", () => {
		expect(
			countCompletedTurns([
				{ role: "user" },
				{ role: "assistant" },
				{ role: "tool" },
				{ role: "assistant" },
			]),
		).toBe(2);
	});

	it("computes duration from the session header timestamp", () => {
		expect(
			computeSessionDurationMs(
				{
					getHeader: () => ({
						timestamp: new Date("2026-04-05T00:00:00.000Z").toISOString(),
					}),
				},
				Date.parse("2026-04-05T00:00:05.000Z"),
			),
		).toBe(5000);
	});

	it("runs SessionEnd hooks with derived duration and turn count", async () => {
		let capturedInput: Record<string, unknown> | undefined;

		registerHook("SessionEnd", {
			type: "callback",
			callback: async (input) => {
				capturedInput = input as Record<string, unknown>;
				return { continue: true };
			},
		});

		await applySessionEndHooks({
			agent: {
				state: {
					messages: [
						{ role: "user", content: "hello" },
						{ role: "assistant", content: [] },
						{ role: "assistant", content: [] },
					],
				},
			} as never,
			sessionManager: {
				getSessionId: () => "session-123",
				getHeader: () => ({
					timestamp: new Date("2026-04-05T00:00:00.000Z").toISOString(),
				}),
			},
			cwd: process.cwd(),
			reason: "complete",
			now: Date.parse("2026-04-05T00:00:07.000Z"),
		});

		expect(capturedInput).toMatchObject({
			hook_event_name: "SessionEnd",
			session_id: "session-123",
			reason: "complete",
			duration_ms: 7000,
			turn_count: 2,
		});
	});
});
