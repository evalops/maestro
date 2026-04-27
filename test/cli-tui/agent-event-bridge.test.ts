import { beforeEach, describe, expect, it, vi } from "vitest";

const telemetryMocks = vi.hoisted(() => ({
	recordSessionDuration: vi.fn(),
	recordSessionStart: vi.fn(),
	recordTokenUsage: vi.fn(),
}));

vi.mock("../../src/telemetry.js", () => telemetryMocks);
vi.mock("../../src/cli-tui/utils/footer-utils.js", () => ({
	calculateFooterStats: vi.fn(() => ({
		totalInput: 0,
		totalOutput: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
		totalCost: 0,
		contextTokens: 0,
		contextWindow: 0,
		contextPercent: 0,
	})),
}));

import type { AgentEvent, AgentState } from "../../src/agent/types.js";
import { AgentEventBridge } from "../../src/cli-tui/tui-renderer/agent-event-bridge.js";

function createState(): AgentState {
	return {
		steeringMode: "all",
		followUpMode: "all",
		queueMode: "all",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4",
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		],
		systemPrompt: "resolved prompt",
		promptMetadata: {
			name: "maestro-system",
			label: "production",
			surface: "maestro",
			version: 9,
			versionId: "ver_9",
			hash: "hash_123",
			source: "service",
		},
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4",
			contextWindow: 200000,
			name: "Claude Sonnet 4",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com/v1/messages",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 0.003,
				output: 0.015,
				cacheRead: 0.0003,
				cacheWrite: 0.00375,
			},
			maxTokens: 8192,
		},
		tools: [],
		thinkingLevel: "off",
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Map(),
	};
}

function createBridge(
	options: { backup?: unknown; getSessionId?: () => string } = {},
) {
	return new AgentEventBridge({
		deps: {
			agent: {} as never,
			sessionManager: {
				getSessionId: options.getSessionId ?? (() => "session-123"),
			} as never,
			sessionRecoveryManager: {
				getCurrentBackup: () => options.backup ?? null,
				startSession: vi.fn(),
				updateMessages: vi.fn(),
			} as never,
			autoRetryController: { checkAndRetry: vi.fn() } as never,
			interruptController: { clear: vi.fn() } as never,
			footer: { updateState: vi.fn() } as never,
			agentEventRouter: { handle: vi.fn() } as never,
		},
		callbacks: {
			ensureInitialized: async () => {},
			handleApprovalRequired: vi.fn(),
			handleApprovalResolved: vi.fn(),
			handleToolRetryRequired: vi.fn(),
			handleToolRetryResolved: vi.fn(),
			setAgentRunning: vi.fn(),
			maybeShowContextWarning: vi.fn(),
			setCurrentModelMetadata: vi.fn(),
		},
	});
}

describe("AgentEventBridge prompt telemetry", () => {
	beforeEach(() => {
		telemetryMocks.recordSessionDuration.mockReset();
		telemetryMocks.recordSessionStart.mockReset();
		telemetryMocks.recordTokenUsage.mockReset();
	});

	it("includes prompt metadata in session start telemetry", async () => {
		const bridge = createBridge();

		await bridge.handleEvent(
			{ type: "agent_start" } as AgentEvent,
			createState(),
		);

		expect(telemetryMocks.recordSessionStart).toHaveBeenCalledWith(
			"session-123",
			{
				model: "anthropic/claude-sonnet-4",
				provider: "anthropic",
				prompt_version: 9,
				prompt_hash: "hash_123",
			},
		);
	});

	it("includes prompt metadata in token usage telemetry", async () => {
		const bridge = createBridge({ backup: {} });

		await bridge.handleEvent(
			{ type: "agent_end" } as AgentEvent,
			createState(),
		);

		expect(telemetryMocks.recordTokenUsage).toHaveBeenCalledWith(
			"session-123",
			{
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
			},
			{
				model: "anthropic/claude-sonnet-4",
				provider: "anthropic",
				prompt_version: 9,
				prompt_hash: "hash_123",
			},
		);
	});

	it("records one closed session duration when the TUI stops", async () => {
		const bridge = createBridge();

		await bridge.handleEvent(
			{ type: "agent_start" } as AgentEvent,
			createState(),
		);
		await bridge.recordSessionClosed();
		await bridge.recordSessionClosed();

		expect(telemetryMocks.recordSessionDuration).toHaveBeenCalledTimes(1);
		expect(telemetryMocks.recordSessionDuration).toHaveBeenCalledWith(
			"session-123",
			expect.any(Number),
			expect.objectContaining({
				model: "anthropic/claude-sonnet-4",
				provider: "anthropic",
				prompt_version: 9,
				prompt_hash: "hash_123",
				closeReason: "MAESTRO_CLOSE_REASON_USER_STOPPED",
				closeMessage: "TUI stopped",
			}),
		);
	});

	it("uses the session id captured at start when recording close telemetry", async () => {
		let sessionId = "session-start";
		const bridge = createBridge({ getSessionId: () => sessionId });

		await bridge.handleEvent(
			{ type: "agent_start" } as AgentEvent,
			createState(),
		);
		sessionId = "session-after-clear";
		await bridge.recordSessionClosed();

		expect(telemetryMocks.recordSessionStart).toHaveBeenCalledWith(
			"session-start",
			expect.any(Object),
		);
		expect(telemetryMocks.recordSessionDuration).toHaveBeenCalledWith(
			"session-start",
			expect.any(Number),
			expect.objectContaining({
				closeReason: "MAESTRO_CLOSE_REASON_USER_STOPPED",
			}),
		);
	});
});
