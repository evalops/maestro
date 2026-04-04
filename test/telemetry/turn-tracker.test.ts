import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/agent/agent.js";
import type { AgentEvent, AssistantMessage } from "../../src/agent/types.js";
import { TurnTracker } from "../../src/telemetry/turn-tracker.js";

describe("TurnTracker", () => {
	it("does not start LLM timing on user message boundaries", () => {
		let listener: ((event: AgentEvent) => void) | undefined;
		const agent = {
			state: {
				messages: [],
				error: undefined,
				model: {
					id: "test-model",
					provider: "anthropic",
				},
				thinkingLevel: "off",
			},
			subscribe: (fn: (event: AgentEvent) => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
		} as unknown as Agent;

		let completed: { llmDurationMs: number } | undefined;
		const tracker = new TurnTracker(agent, {
			sessionId: "session-1",
			onTurnComplete: (event) => {
				completed = event;
			},
		});

		const userMessage = {
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.now(),
		};

		listener?.({ type: "agent_start" });
		listener?.({ type: "message_start", message: userMessage });
		listener?.({ type: "message_end", message: userMessage });
		listener?.({ type: "agent_end", messages: [] });

		tracker.dispose();

		expect(completed).toBeTruthy();
		expect(completed?.llmDurationMs).toBe(0);
	});

	it("does not classify a max-output stop as context overflow", () => {
		let listener: ((event: AgentEvent) => void) | undefined;
		const agent = {
			state: {
				messages: [],
				error: undefined,
				model: {
					id: "test-model",
					provider: "anthropic",
				},
				thinkingLevel: "off",
			},
			subscribe: (fn: (event: AgentEvent) => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
		} as unknown as Agent;

		let completed:
			| {
					status: string;
					abortReason?: string;
			  }
			| undefined;
		const tracker = new TurnTracker(agent, {
			sessionId: "session-2",
			onTurnComplete: (event) => {
				completed = event;
			},
		});

		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};

		listener?.({ type: "agent_start" });
		listener?.({ type: "message_start", message: assistantMessage });
		listener?.({ type: "message_end", message: assistantMessage });
		listener?.({
			type: "agent_end",
			messages: [assistantMessage],
			stopReason: "length",
		});

		tracker.dispose();

		expect(completed?.status).toBe("success");
		expect(completed?.abortReason).toBeUndefined();
	});

	it("keeps automatic continuations on the same logical turn number", () => {
		let listener: ((event: AgentEvent) => void) | undefined;
		const agent = {
			state: {
				messages: [],
				error: undefined,
				model: {
					id: "test-model",
					provider: "anthropic",
				},
				thinkingLevel: "off",
			},
			subscribe: (fn: (event: AgentEvent) => void) => {
				listener = fn;
				return () => {
					listener = undefined;
				};
			},
		} as unknown as Agent;

		const completed: Array<{ turnNumber: number; status: string }> = [];
		const tracker = new TurnTracker(agent, {
			sessionId: "session-3",
			onTurnComplete: (event) => {
				completed.push({
					turnNumber: event.turnNumber,
					status: event.status,
				});
			},
		});

		const partialMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			usage: {
				input: 10,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
		const finalMessage: AssistantMessage = {
			...partialMessage,
			content: [{ type: "text", text: "complete" }],
			stopReason: "stop",
			timestamp: Date.now() + 1,
		};

		listener?.({ type: "agent_start" });
		listener?.({ type: "message_start", message: partialMessage });
		listener?.({ type: "message_end", message: partialMessage });
		listener?.({
			type: "agent_end",
			messages: [partialMessage],
			stopReason: "length",
		});

		listener?.({ type: "agent_start", continuation: true });
		listener?.({ type: "message_start", message: finalMessage });
		listener?.({ type: "message_end", message: finalMessage });
		listener?.({
			type: "agent_end",
			messages: [partialMessage, finalMessage],
			stopReason: "stop",
		});

		tracker.dispose();

		expect(completed).toHaveLength(2);
		expect(completed.map((event) => event.turnNumber)).toEqual([1, 1]);
		expect(tracker.getTurnNumber()).toBe(1);
	});
});
