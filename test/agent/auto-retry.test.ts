import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../../src/agent/agent.js";
import { AutoRetryController } from "../../src/agent/auto-retry.js";
import type { AgentEvent, AssistantMessage } from "../../src/agent/types.js";

/**
 * Minimal Agent stand-in: AutoRetryController only reads `state.messages`,
 * calls `replaceMessages`, and calls `continue()`. We capture those calls.
 */
interface MockAgentState {
	messages: AssistantMessage[];
}
function makeMockAgent(messages: AssistantMessage[] = []): {
	agent: Agent;
	state: MockAgentState;
	calls: { replaceMessages: AssistantMessage[][]; continueCount: number };
} {
	const state: MockAgentState = { messages };
	const calls = {
		replaceMessages: [] as AssistantMessage[][],
		continueCount: 0,
	};
	const agent = {
		state,
		replaceMessages: (next: AssistantMessage[]) => {
			state.messages = next;
			calls.replaceMessages.push(next);
		},
		continue: async () => {
			calls.continueCount += 1;
		},
	} as unknown as Agent;
	return { agent, state, calls };
}

function retryableError(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: text,
	} as AssistantMessage;
}

function nonRetryableMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "end_turn",
	} as AssistantMessage;
}

/**
 * Drive one retry cycle: track a message, run checkAndRetry, then advance fake
 * timers past the backoff sleep (and the trailing continue() setTimeout).
 */
async function retryCycle(
	ctrl: AutoRetryController,
	agent: Agent,
	expectedDelayMs: number,
	message: AssistantMessage,
): Promise<boolean> {
	ctrl.trackAssistantMessage(message);
	const result = ctrl.checkAndRetry(agent);
	await vi.advanceTimersByTimeAsync(expectedDelayMs);
	await vi.runOnlyPendingTimersAsync(); // flush the trailing continue() setTimeout
	return result;
}

describe("AutoRetryController", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	describe("configuration", () => {
		it("applies sensible defaults", () => {
			const ctrl = new AutoRetryController();
			expect(ctrl.isEnabled()).toBe(true);
			expect(ctrl.isRetrying()).toBe(false);
			expect(ctrl.getCurrentAttempt()).toBe(0);
		});

		it("honors partial overrides via constructor and setConfig", () => {
			const ctrl = new AutoRetryController({ maxRetries: 5 });
			expect(ctrl.isEnabled()).toBe(true);
			ctrl.setConfig({ enabled: false, baseDelayMs: 500 });
			expect(ctrl.isEnabled()).toBe(false);
		});

		it("loads from a RetryConfig shape", () => {
			const ctrl = new AutoRetryController();
			ctrl.loadFromRetryConfig({
				enabled: true,
				max_retries: 7,
				base_delay_ms: 1234,
			});
			expect(ctrl.isEnabled()).toBe(true);
		});

		it("does not retry when disabled", async () => {
			const { agent } = makeMockAgent([retryableError("overloaded_error")]);
			const ctrl = new AutoRetryController({
				enabled: false,
				baseDelayMs: 100,
			});
			const events: AgentEvent[] = [];
			ctrl.setEventListener((e) => events.push(e));
			expect(
				await retryCycle(ctrl, agent, 100, retryableError("overloaded_error")),
			).toBe(false);
			expect(events).toHaveLength(0);
		});
	});

	describe("retry delay parsing (server-provided windows)", () => {
		it.each([
			[
				"overloaded: reset after 18h31m10s",
				(18 * 3600 + 31 * 60 + 10) * 1000 + 1000,
			],
			["overloaded: reset after 39s", 39 * 1000 + 1000],
			["overloaded: reset after 10m15s", (10 * 60 + 15) * 1000 + 1000],
		])("parses 'quota %s'", async (msg, expectedServerMs) => {
			const { agent } = makeMockAgent();
			const ctrl = new AutoRetryController({ baseDelayMs: 100, maxRetries: 3 });
			const events: AgentEvent[] = [];
			ctrl.setEventListener((e) => events.push(e));
			const started = await retryCycle(
				ctrl,
				agent,
				expectedServerMs,
				retryableError(msg),
			);
			expect(started).toBe(true);
			const start = events.find((e) => e.type === "auto_retry_start");
			expect(start).toMatchObject({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: Math.max(expectedServerMs, 100),
			});
		});

		it("parses 'Please retry in Xs' / 'Xms'", async () => {
			const { agent } = makeMockAgent();
			const ctrl = new AutoRetryController({ baseDelayMs: 100 });
			const events: AgentEvent[] = [];
			ctrl.setEventListener((e) => events.push(e));
			await retryCycle(
				ctrl,
				agent,
				6000,
				retryableError("overloaded_error, Please retry in 5s"),
			);
			expect(events.find((e) => e.type === "auto_retry_start")).toMatchObject({
				delayMs: 6000, // 5s + 1s buffer, beats baseDelay 100
			});
		});

		it("parses a structured retryDelay JSON fragment", async () => {
			const { agent } = makeMockAgent();
			const ctrl = new AutoRetryController({ baseDelayMs: 100 });
			const events: AgentEvent[] = [];
			ctrl.setEventListener((e) => events.push(e));
			await retryCycle(
				ctrl,
				agent,
				35074,
				retryableError('503 Bad Gateway {"retryDelay": "34.074s"}'),
			);
			expect(events.find((e) => e.type === "auto_retry_start")).toMatchObject({
				delayMs: 35074, // 34074ms + 1000
			});
		});

		it("falls back to exponential backoff when no server delay is present", async () => {
			const { agent } = makeMockAgent();
			const ctrl = new AutoRetryController({
				baseDelayMs: 2000,
				maxRetries: 3,
			});
			const events: AgentEvent[] = [];
			ctrl.setEventListener((e) => events.push(e));
			await retryCycle(ctrl, agent, 2000, retryableError("overloaded_error"));
			expect(events.find((e) => e.type === "auto_retry_start")).toMatchObject({
				delayMs: 2000, // baseDelayMs * 2^0
			});
		});

		it("honors exponential backoff across attempts (2^n)", async () => {
			const { agent } = makeMockAgent();
			const ctrl = new AutoRetryController({
				baseDelayMs: 1000,
				maxRetries: 3,
			});
			const events: AgentEvent[] = [];
			ctrl.setEventListener((e) => events.push(e));
			await retryCycle(ctrl, agent, 1000, retryableError("overloaded_error")); // 2^0
			await retryCycle(ctrl, agent, 2000, retryableError("overloaded_error")); // 2^1
			await retryCycle(ctrl, agent, 4000, retryableError("overloaded_error")); // 2^2
			const starts = events.filter((e) => e.type === "auto_retry_start");
			expect(starts.map((s) => (s as { delayMs: number }).delayMs)).toEqual([
				1000, 2000, 4000,
			]);
		});
	});

	describe("retry lifecycle", () => {
		it("removes the trailing error message from agent state before retrying", async () => {
			const err = retryableError("overloaded_error");
			const { agent, calls } = makeMockAgent([err]);
			const ctrl = new AutoRetryController({ baseDelayMs: 100 });
			await retryCycle(ctrl, agent, 100, err);
			expect(calls.replaceMessages).toHaveLength(1);
			// the retryable assistant message was stripped from the tail
			expect(calls.replaceMessages[0]).toHaveLength(0);
		});

		it("schedules continue() after the backoff", async () => {
			const { agent, calls } = makeMockAgent([
				retryableError("503 Service Unavailable"),
			]);
			const ctrl = new AutoRetryController({ baseDelayMs: 100 });
			await retryCycle(
				ctrl,
				agent,
				100,
				retryableError("503 Service Unavailable"),
			);
			expect(calls.continueCount).toBe(1);
		});

		it("does not retry a non-retryable message and reports success after a retry", async () => {
			const { agent } = makeMockAgent();
			const ctrl = new AutoRetryController({ baseDelayMs: 100, maxRetries: 3 });
			const events: AgentEvent[] = [];
			ctrl.setEventListener((e) => events.push(e));
			// first: a retryable error starts a retry sequence
			await retryCycle(ctrl, agent, 100, retryableError("overloaded_error"));
			expect(ctrl.getCurrentAttempt()).toBe(1);
			// then: a clean turn ends the sequence with success
			ctrl.trackAssistantMessage(nonRetryableMessage());
			expect(await ctrl.checkAndRetry(agent)).toBe(false);
			expect(events.at(-1)).toMatchObject({
				type: "auto_retry_end",
				success: true,
				attempt: 1,
			});
			expect(ctrl.getCurrentAttempt()).toBe(0);
		});

		it("gives up after maxRetries with a failure event", async () => {
			const { agent } = makeMockAgent();
			const ctrl = new AutoRetryController({ baseDelayMs: 50, maxRetries: 2 });
			const events: AgentEvent[] = [];
			ctrl.setEventListener((e) => events.push(e));
			// attempts 1 and 2 retry
			await retryCycle(ctrl, agent, 50, retryableError("overloaded_error"));
			await retryCycle(ctrl, agent, 100, retryableError("overloaded_error"));
			// 3rd error exceeds maxRetries(2): no sleep, immediate failure
			ctrl.trackAssistantMessage(retryableError("overloaded_error"));
			expect(await ctrl.checkAndRetry(agent)).toBe(false);
			expect(events.at(-1)).toMatchObject({
				type: "auto_retry_end",
				success: false,
				attempt: 2,
				finalError: "overloaded_error",
			});
			expect(ctrl.isRetrying()).toBe(false);
		});

		it("ignores a non-retryable message when no retry is in progress", async () => {
			const { agent } = makeMockAgent();
			const ctrl = new AutoRetryController();
			const events: AgentEvent[] = [];
			ctrl.setEventListener((e) => events.push(e));
			ctrl.trackAssistantMessage(nonRetryableMessage());
			expect(await ctrl.checkAndRetry(agent)).toBe(false);
			expect(events).toHaveLength(0);
		});

		it("does nothing when no message has been tracked", async () => {
			const { agent } = makeMockAgent();
			const ctrl = new AutoRetryController();
			expect(await ctrl.checkAndRetry(agent)).toBe(false);
		});
	});

	describe("abort semantics", () => {
		it("canceling mid-backoff emits a failure event and stops the retry", async () => {
			const { agent } = makeMockAgent();
			const ctrl = new AutoRetryController({
				baseDelayMs: 5000,
				maxRetries: 3,
			});
			const events: AgentEvent[] = [];
			ctrl.setEventListener((e) => events.push(e));
			ctrl.trackAssistantMessage(retryableError("overloaded_error"));
			const pending = ctrl.checkAndRetry(agent);
			// abort before the 5s backoff elapses
			ctrl.abortRetry();
			const result = await pending;
			expect(result).toBe(false);
			expect(events.at(-1)).toMatchObject({
				type: "auto_retry_end",
				success: false,
				finalError: "Retry cancelled",
			});
			expect(ctrl.getCurrentAttempt()).toBe(0);
		});
	});

	describe("cleanup", () => {
		it("reset() clears attempt state and resolves any pending retry", async () => {
			const { agent } = makeMockAgent();
			const ctrl = new AutoRetryController({
				baseDelayMs: 5000,
				maxRetries: 3,
			});
			ctrl.trackAssistantMessage(retryableError("overloaded_error"));
			const pending = ctrl.checkAndRetry(agent);
			let resolved = false;
			void pending.then(() => {
				resolved = true;
			});
			ctrl.reset();
			await vi.runAllTimersAsync();
			expect(resolved).toBe(true);
			expect(ctrl.getCurrentAttempt()).toBe(0);
		});

		it("waitForRetry resolves once a retry sequence completes", async () => {
			const { agent } = makeMockAgent();
			const ctrl = new AutoRetryController({ baseDelayMs: 100, maxRetries: 1 });
			const events: AgentEvent[] = [];
			ctrl.setEventListener((e) => events.push(e));
			await retryCycle(ctrl, agent, 100, retryableError("overloaded_error"));
			// then terminal failure on the next error
			ctrl.trackAssistantMessage(retryableError("overloaded_error"));
			await ctrl.checkAndRetry(agent);
			await expect(ctrl.waitForRetry()).resolves.toBeUndefined();
		});
	});
});
