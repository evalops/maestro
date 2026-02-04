import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/agent/agent.js";
import type { AgentEvent } from "../../src/agent/types.js";
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
});
