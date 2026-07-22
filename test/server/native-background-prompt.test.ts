import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, AssistantMessage } from "../../src/agent/types.js";
import {
	collectAssistantTextFromEvents,
	runNativeBackgroundPrompt,
} from "../../src/server/native-background-prompt.js";
import type { RunNativeWebChatTurnOptions } from "../../src/server/web-native-chat.js";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

describe("collectAssistantTextFromEvents", () => {
	it("returns last non-empty message_end assistant text", () => {
		const events: AgentEvent[] = [
			{ type: "agent_start" },
			{
				type: "message_end",
				message: assistantMessage("first"),
			},
			{
				type: "message_end",
				message: assistantMessage("second"),
			},
			{ type: "agent_end", messages: [], stopReason: "stop" },
		];
		expect(collectAssistantTextFromEvents(events)).toBe("second");
	});

	it("returns empty string when no assistant text", () => {
		expect(collectAssistantTextFromEvents([{ type: "agent_start" }])).toBe("");
	});
});

describe("runNativeBackgroundPrompt", () => {
	it("collects text from a successful native turn with auto approval", async () => {
		const runTurn = vi.fn(async (options: RunNativeWebChatTurnOptions) => {
			options.onEvent({
				type: "message_end",
				message: assistantMessage("Suggest adding unit tests next."),
			});
			return { ok: true as const };
		});

		const result = await runNativeBackgroundPrompt({
			prompt: "recent conversation...",
			systemPrompt: "you suggest prompts",
			modelId: "gpt-5-mini",
			provider: "openai",
			runTurn,
		});

		expect(result).toEqual({
			ok: true,
			text: "Suggest adding unit tests next.",
		});
		expect(runTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "recent conversation...",
				systemPrompt: "you suggest prompts",
				modelId: "gpt-5-mini",
				provider: "openai",
				thinkingLevel: "off",
				approvalMode: "auto",
				turnTimeoutMs: 60_000,
			}),
		);
	});

	it("reports the start phase on start failure", async () => {
		const runTurn = vi.fn(async () => ({
			ok: false as const,
			error: new Error("spawn ENOENT"),
			phase: "start" as const,
		}));

		const result = await runNativeBackgroundPrompt({
			prompt: "x",
			runTurn,
		});

		expect(result).toEqual({
			ok: false,
			error: expect.objectContaining({ message: "spawn ENOENT" }),
			phase: "start",
		});
	});

	it("reports the turn phase on mid-turn failure", async () => {
		const runTurn = vi.fn(async () => ({
			ok: false as const,
			error: new Error("turn blew up"),
			phase: "turn" as const,
		}));

		const result = await runNativeBackgroundPrompt({
			prompt: "x",
			runTurn,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.phase).toBe("turn");
			expect(result.error.message).toBe("turn blew up");
		}
	});

	it("treats unexpected throw as a start-phase failure", async () => {
		const runTurn = vi.fn(async () => {
			throw new Error("unexpected");
		});

		const result = await runNativeBackgroundPrompt({
			prompt: "x",
			runTurn,
		});

		expect(result).toEqual({
			ok: false,
			error: expect.objectContaining({ message: "unexpected" }),
			phase: "start",
		});
	});
});
