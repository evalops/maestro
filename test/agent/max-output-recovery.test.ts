import { describe, expect, it, vi } from "vitest";
import type { Agent } from "../../src/agent/agent.js";
import { recoverFromMaxOutput } from "../../src/agent/max-output-recovery.js";
import type {
	AgentState,
	AppMessage,
	AssistantMessage,
} from "../../src/agent/types.js";

function createAssistantMessage(
	stopReason: AssistantMessage["stopReason"],
	outputTokens = 1,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `stop=${stopReason}` }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 1,
			output: outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createAgentStub(
	stopReasonsAfterContinue: AssistantMessage["stopReason"][],
	initialMessages: AppMessage[],
): Pick<Agent, "state" | "continue"> {
	const state = {
		messages: [...initialMessages],
	} as AgentState;
	const remaining = [...stopReasonsAfterContinue];

	return {
		state,
		continue: vi.fn(async () => {
			const nextStopReason = remaining.shift() ?? "stop";
			state.messages = [
				...state.messages,
				createAssistantMessage(nextStopReason),
			];
		}),
	};
}

describe("recoverFromMaxOutput", () => {
	it("does nothing when the last assistant message did not hit the max output limit", async () => {
		const agent = createAgentStub([], [createAssistantMessage("stop")]);

		const result = await recoverFromMaxOutput(agent);

		expect(result).toEqual({
			recovered: false,
			attempts: 0,
			exhausted: false,
			stoppedEarly: false,
		});
		expect(agent.continue).not.toHaveBeenCalled();
	});

	it("continues until the last assistant message stops naturally", async () => {
		const onContinue = vi.fn();
		const agent = createAgentStub(
			["length", "stop"],
			[createAssistantMessage("length")],
		);

		const result = await recoverFromMaxOutput(agent, { onContinue });

		expect(result).toEqual({
			recovered: true,
			attempts: 2,
			exhausted: false,
			stoppedEarly: false,
		});
		expect(agent.continue).toHaveBeenCalledTimes(2);
		expect(onContinue).toHaveBeenNthCalledWith(1, 1, 5);
		expect(onContinue).toHaveBeenNthCalledWith(2, 2, 5);
	});

	it("stops after the configured continuation limit", async () => {
		const onExhausted = vi.fn();
		const agent = createAgentStub(
			["length", "length", "length"],
			[createAssistantMessage("length")],
		);

		const result = await recoverFromMaxOutput(agent, {
			maxContinuations: 2,
			onExhausted,
		});

		expect(result).toEqual({
			recovered: true,
			attempts: 2,
			exhausted: true,
			stoppedEarly: false,
		});
		expect(agent.continue).toHaveBeenCalledTimes(2);
		expect(onExhausted).toHaveBeenCalledWith(2);
	});

	it("stops early when the last two retries both produce tiny outputs", async () => {
		const onStoppedEarly = vi.fn();
		const agent = createAgentStub(
			["length", "length", "length", "length"],
			[createAssistantMessage("length", 100)],
		);

		agent.continue = vi.fn().mockImplementation(async () => {
			agent.state.messages = [
				...agent.state.messages,
				createAssistantMessage("length", 100),
			];
		});

		const result = await recoverFromMaxOutput(agent, {
			onStoppedEarly,
		});

		expect(result).toEqual({
			recovered: true,
			attempts: 3,
			exhausted: false,
			stoppedEarly: true,
		});
		expect(agent.continue).toHaveBeenCalledTimes(3);
		expect(onStoppedEarly).toHaveBeenCalledWith(3, 5);
	});

	it("stops retrying when a continuation makes no progress", async () => {
		const agent = createAgentStub([], [createAssistantMessage("length")]);

		agent.continue = vi.fn(async () => {});

		const result = await recoverFromMaxOutput(agent);

		expect(result).toEqual({
			recovered: false,
			attempts: 1,
			exhausted: false,
			stoppedEarly: false,
		});
		expect(agent.continue).toHaveBeenCalledTimes(1);
	});
});
