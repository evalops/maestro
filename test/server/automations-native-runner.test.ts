import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/types.js";
import { runAutomationNativeTurn } from "../../src/server/automations/native-runner.js";

describe("runAutomationNativeTurn", () => {
	it("delegates to runNativeWebChatTurn with auto approval by default", async () => {
		const onEvent = vi.fn();
		const runTurn = vi.fn(async () => ({ ok: true as const }));

		const result = await runAutomationNativeTurn({
			prompt: "hello automation",
			modelId: "gpt-test",
			provider: "openai",
			thinkingLevel: "low",
			onEvent,
			runTurn,
		});

		expect(result).toEqual({ ok: true });
		expect(runTurn).toHaveBeenCalledWith({
			prompt: "hello automation",
			cwd: undefined,
			modelId: "gpt-test",
			provider: "openai",
			thinkingLevel: "low",
			approvalMode: "auto",
			profileName: undefined,
			cliOverrides: undefined,
			history: undefined,
			onStarted: undefined,
			onEvent,
			signal: undefined,
		});
	});

	it("forwards history to runNativeWebChatTurn", async () => {
		const onEvent = vi.fn();
		const runTurn = vi.fn(async () => ({ ok: true as const }));
		const history = [
			{ role: "user" as const, text: "prior user" },
			{ role: "assistant" as const, text: "prior assistant" },
		];

		await runAutomationNativeTurn({
			prompt: "next turn",
			history,
			onEvent,
			runTurn,
		});

		expect(runTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "next turn",
				history,
				approvalMode: "auto",
			}),
		);
	});

	it("forwards onEvent callbacks from the turn runner", async () => {
		const onEvent = vi.fn();
		const sampleEvent = { type: "error", message: "boom" } as AgentEvent;
		const runTurn = vi.fn(
			async (options: { onEvent: (event: AgentEvent) => void }) => {
				options.onEvent(sampleEvent);
				return { ok: true as const };
			},
		);

		await runAutomationNativeTurn({
			prompt: "ping",
			onEvent,
			runTurn,
		});

		expect(onEvent).toHaveBeenCalledWith(sampleEvent);
	});
});
