import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadAutomationState = vi.fn(() => ({ automations: [] }));
const saveAutomationState = vi.fn();
const runAutomationNativeTurn = vi.hoisted(() =>
	vi.fn(async () => ({ ok: true as const })),
);

let autonomousActionsDisabled = false;

vi.mock("../../src/server/stores/automation-store.js", () => ({
	loadAutomationState,
	saveAutomationState,
}));

vi.mock("../../src/server/automations/native-runner.js", () => ({
	runAutomationNativeTurn,
}));

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
		runAutomationNativeTurn.mockClear();
		runAutomationNativeTurn.mockResolvedValue({ ok: true as const });
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

	function sampleModel() {
		return {
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
	}

	function sampleAgent(model: ReturnType<typeof sampleModel>) {
		return {
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
	}

	function sampleAutomation(overrides?: Record<string, unknown>) {
		return {
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
			...overrides,
		};
	}

	it("passes the web profile into native automation turns", async () => {
		const scheduler = await import("../../src/server/automations/scheduler.js");
		const model = sampleModel();
		loadAutomationState.mockReturnValueOnce({
			automations: [sampleAutomation()],
		});

		await scheduler.runAutomationById("automation-1", {
			getRegisteredModel: vi.fn().mockResolvedValue(model),
			defaultApprovalMode: "prompt",
			getCurrentSelection: () => ({ provider: "openai", modelId: "gpt-5.4" }),
			profileName: "web-work",
			cliOverrides: {
				projects: { "/tmp/project": { trust_level: "trusted" } },
			},
		} as never);

		expect(runAutomationNativeTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				profileName: "web-work",
				cliOverrides: {
					projects: { "/tmp/project": { trust_level: "trusted" } },
				},
			}),
		);
	});

	it("runs via native headless", async () => {
		runAutomationNativeTurn.mockImplementation(
			async (options: {
				onEvent: (event: { type: string; message?: unknown }) => void;
			}) => {
				options.onEvent({
					type: "message_end",
					message: {
						role: "assistant",
						content: "native output",
						timestamp: Date.now(),
					},
				});
				return { ok: true as const };
			},
		);

		const scheduler = await import("../../src/server/automations/scheduler.js");
		const model = sampleModel();
		loadAutomationState.mockReturnValueOnce({
			automations: [sampleAutomation()],
		});

		const task = await scheduler.runAutomationById("automation-1", {
			getRegisteredModel: vi.fn().mockResolvedValue(model),
			defaultApprovalMode: "prompt",
			getCurrentSelection: () => ({ provider: "openai", modelId: "gpt-5.4" }),
			profileName: "web-work",
			cliOverrides: {},
		} as never);

		expect(runAutomationNativeTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "summarize",
				modelId: "gpt-5.4",
				provider: "openai",
				approvalMode: "auto",
			}),
		);
		expect(task?.lastRunStatus).toBe("success");
		expect(task?.lastOutput).toBe("native output");
	});

	it("preserves fail-mode approval for unattended native runs", async () => {
		const scheduler = await import("../../src/server/automations/scheduler.js");
		const model = sampleModel();
		loadAutomationState.mockReturnValueOnce({
			automations: [sampleAutomation()],
		});

		await scheduler.runAutomationById("automation-1", {
			getRegisteredModel: vi.fn().mockResolvedValue(model),
			defaultApprovalMode: "fail",
			getCurrentSelection: () => ({ provider: "openai", modelId: "gpt-5.4" }),
			profileName: "web-work",
			cliOverrides: {},
		} as never);

		expect(runAutomationNativeTurn).toHaveBeenCalledWith(
			expect.objectContaining({ approvalMode: "fail" }),
		);
	});

	it("reports failure when native start fails", async () => {
		runAutomationNativeTurn.mockResolvedValue({
			ok: false as const,
			error: new Error("spawn ENOENT"),
			phase: "start" as const,
		});

		const scheduler = await import("../../src/server/automations/scheduler.js");
		const model = sampleModel();
		loadAutomationState.mockReturnValueOnce({
			automations: [sampleAutomation()],
		});

		const task = await scheduler.runAutomationById("automation-1", {
			getRegisteredModel: vi.fn().mockResolvedValue(model),
			defaultApprovalMode: "auto",
			getCurrentSelection: () => ({ provider: "openai", modelId: "gpt-5.4" }),
			profileName: "web-work",
			cliOverrides: {},
		} as never);

		expect(runAutomationNativeTurn).toHaveBeenCalled();
		expect(task?.lastRunStatus).toBe("failure");
	});

	it("passes session history to native turn on resume", async () => {
		runAutomationNativeTurn.mockImplementation(
			async (options: {
				onStarted: (started: {
					systemPrompt: string;
					promptMetadata?: unknown;
					promptContextManifest?: unknown;
					systemPromptSourcePaths?: string[];
				}) => void;
				onEvent: (event: { type: string; message?: unknown }) => void;
			}) => {
				options.onStarted({
					systemPrompt: "native system prompt",
					promptMetadata: { hash: "native-prompt-hash" },
					promptContextManifest: { cwd: "/workspace" },
					systemPromptSourcePaths: ["/workspace/APPEND_SYSTEM.md"],
				});
				options.onEvent({
					type: "message_end",
					message: {
						role: "assistant",
						content: "resumed reply",
						timestamp: 10,
					},
				});
				return { ok: true as const };
			},
		);

		const priorMessages = [
			{ role: "user", content: "first prompt", timestamp: 1 },
			{ role: "assistant", content: "first reply", timestamp: 2 },
		];
		const sessionManager = {
			getSessionFileById: vi.fn(() => "/tmp/session.jsonl"),
			setSessionFile: vi.fn(),
			getHeader: vi.fn(() => undefined),
			createSession: vi.fn(),
			getSessionId: vi.fn(() => "session-resume-1"),
			loadSession: vi.fn(async () => ({ messages: priorMessages })),
			saveMessage: vi.fn(),
			flush: vi.fn(async () => {}),
			startSession: vi.fn(),
		};
		const createSessionManagerForScope = vi.fn(() => sessionManager);
		vi.doMock("../../src/server/session-scope.js", () => ({
			createSessionManagerForScope,
		}));

		try {
			const scheduler = await import(
				"../../src/server/automations/scheduler.js"
			);
			const model = sampleModel();
			loadAutomationState.mockReturnValueOnce({
				automations: [
					sampleAutomation({
						sessionMode: "reuse",
						sessionId: "session-resume-1",
					}),
				],
			});

			await scheduler.runAutomationById("automation-1", {
				getRegisteredModel: vi.fn().mockResolvedValue(model),
				defaultApprovalMode: "auto",
				getCurrentSelection: () => ({
					provider: "openai",
					modelId: "gpt-5.4",
				}),
				profileName: "web-work",
				cliOverrides: {},
			} as never);

			expect(sessionManager.loadSession).toHaveBeenCalledWith(
				"session-resume-1",
			);
			expect(runAutomationNativeTurn).toHaveBeenCalledWith(
				expect.objectContaining({
					prompt: "summarize",
					history: [
						{ role: "user", text: "first prompt" },
						{ role: "assistant", text: "first reply" },
					],
				}),
			);
			expect(sessionManager.startSession).toHaveBeenCalledWith(
				expect.objectContaining({
					model,
					systemPrompt: "native system prompt",
					promptMetadata: expect.objectContaining({
						hash: "native-prompt-hash",
					}),
					promptContextManifest: expect.objectContaining({
						cwd: "/workspace",
					}),
					systemPromptSourcePaths: ["/workspace/APPEND_SYSTEM.md"],
				}),
				expect.objectContaining({ subject: "Profiled automation" }),
			);
			expect(sessionManager.saveMessage).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({ role: "user", content: "summarize" }),
			);
			expect(sessionManager.saveMessage).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({
					role: "assistant",
					content: "resumed reply",
				}),
			);
		} finally {
			vi.doUnmock("../../src/server/session-scope.js");
			vi.resetModules();
		}
	});

	it("sessionMessagesToNativeHistory extracts user/assistant text", async () => {
		const scheduler = await import("../../src/server/automations/scheduler.js");
		const history = scheduler.sessionMessagesToNativeHistory([
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "world" }],
				timestamp: 2,
			},
			{ role: "system", content: "skip me", timestamp: 3 },
			{ role: "user", content: "  ", timestamp: 4 },
		] as never);

		expect(history).toEqual([
			{ role: "user", text: "hello" },
			{ role: "assistant", text: "world" },
		]);
	});
});
