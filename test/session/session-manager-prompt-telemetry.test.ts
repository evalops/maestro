import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const telemetryMocks = vi.hoisted(() => ({
	recordMaestroPromptVariantSelected: vi.fn(),
}));

vi.mock("../../src/telemetry/maestro-event-bus.js", () => ({
	recordMaestroPromptVariantSelected:
		telemetryMocks.recordMaestroPromptVariantSelected,
}));

import type { AgentState } from "../../src/agent/types.js";
import { SessionManager } from "../../src/session/manager.js";

function createMockState(): AgentState {
	return {
		steeringMode: "all",
		followUpMode: "all",
		queueMode: "all",
		messages: [],
		systemPrompt: "test system prompt",
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

describe("SessionManager prompt telemetry", () => {
	let testDir: string;
	let originalEnv: string | undefined;
	let originalCwd: string;

	beforeEach(() => {
		telemetryMocks.recordMaestroPromptVariantSelected.mockReset();
		originalCwd = process.cwd();
		originalEnv = process.env.MAESTRO_AGENT_DIR;
		testDir = join(tmpdir(), `maestro-prompt-telemetry-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		process.env.MAESTRO_AGENT_DIR = testDir;
		process.chdir(testDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalEnv === undefined) {
			delete process.env.MAESTRO_AGENT_DIR;
		} else {
			process.env.MAESTRO_AGENT_DIR = originalEnv;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	it("emits prompt variant selection telemetry when a session starts", () => {
		const sessionManager = new SessionManager(false);
		const state = createMockState();

		sessionManager.startSession(state);

		expect(
			telemetryMocks.recordMaestroPromptVariantSelected,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt_metadata: state.promptMetadata,
				correlation: {
					session_id: sessionManager.getSessionId(),
				},
			}),
		);
	});
});
