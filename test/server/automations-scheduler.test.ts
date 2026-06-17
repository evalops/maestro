import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadAutomationState = vi.fn(() => ({ automations: [] }));
const saveAutomationState = vi.fn();
const runUserPromptWithRecovery = vi.hoisted(() =>
	vi.fn(async (options: { execute: () => Promise<unknown> }) => {
		await options.execute();
	}),
);

let autonomousActionsDisabled = false;

vi.mock("../../src/server/stores/automation-store.js", () => ({
	loadAutomationState,
	saveAutomationState,
}));

vi.mock("../../src/agent/user-prompt-runtime.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/agent/user-prompt-runtime.js")
	>("../../src/agent/user-prompt-runtime.js");
	return {
		...actual,
		runUserPromptWithRecovery,
	};
});

vi.mock("../../src/config/feature-flags.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/config/feature-flags.js")
	>("../../src/config/feature-flags.js");
	return {
		...actual,
		areAutonomousActionsDisabled: () => autonomousActionsDisabled,
	};
});

describe("automation scheduler", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.stubEnv("MAESTRO_AUTOMATION_POLL_MS", "25");
		autonomousActionsDisabled = false;
		loadAutomationState.mockClear();
		saveAutomationState.mockClear();
		runUserPromptWithRecovery.mockClear();
	});

	afterEach(async () => {
		const scheduler = await import("../../src/server/automations/scheduler.js");
		scheduler.stopAutomationScheduler();
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("keeps polling after boot when the autonomous actions kill switch is enabled", async () => {
		autonomousActionsDisabled = true;
		const scheduler = await import("../../src/server/automations/scheduler.js");

		scheduler.startAutomationScheduler({} as never);
		expect(loadAutomationState).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(25);
		expect(loadAutomationState).not.toHaveBeenCalled();

		autonomousActionsDisabled = false;
		await vi.advanceTimersByTimeAsync(25);

		expect(loadAutomationState).toHaveBeenCalledTimes(1);
	});

	it("passes the web profile into automation agents and prompt recovery", async () => {
		const scheduler = await import("../../src/server/automations/scheduler.js");
		const model = {
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1/responses",
			reasoning: true,
			toolUse: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
			providerName: "OpenAI",
			source: "builtin",
			isLocal: false,
		};
		const agent = {
			state: {
				model,
				systemPrompt: "",
				thinkingLevel: "off",
				tools: [],
				messages: [],
			},
			prompt: vi.fn().mockResolvedValue(undefined),
			subscribe: vi.fn(() => () => {}),
			replaceMessages: vi.fn(),
		};
		const createAgent = vi.fn().mockResolvedValue(agent);
		loadAutomationState.mockReturnValueOnce({
			automations: [
				{
					id: "automation-1",
					name: "Profiled automation",
					prompt: "summarize",
					schedule: null,
					nextRun: null,
					timezone: "UTC",
					enabled: true,
					createdAt: "2026-06-11T00:00:00.000Z",
					updatedAt: "2026-06-11T00:00:00.000Z",
					runCount: 0,
					sessionMode: "new",
				},
			],
		});

		await scheduler.runAutomationById("automation-1", {
			createAgent,
			createBackgroundAgent: vi.fn().mockResolvedValue(agent),
			getRegisteredModel: vi.fn().mockResolvedValue(model),
			defaultApprovalMode: "prompt",
			getCurrentSelection: () => ({ provider: "openai", modelId: "gpt-5.4" }),
			profileName: "web-work",
			cliOverrides: {
				projects: { "/tmp/project": { trust_level: "trusted" } },
			},
		} as never);

		expect(createAgent).toHaveBeenCalledWith(
			model,
			"off",
			"auto",
			expect.objectContaining({
				profileName: "web-work",
				cliOverrides: {
					projects: { "/tmp/project": { trust_level: "trusted" } },
				},
			}),
		);
		expect(runUserPromptWithRecovery).toHaveBeenCalledWith(
			expect.objectContaining({
				profileName: "web-work",
				cliOverrides: {
					projects: { "/tmp/project": { trust_level: "trusted" } },
				},
				prompt: "summarize",
			}),
		);
		expect(agent.prompt).toHaveBeenCalledWith("summarize");
	});
});
