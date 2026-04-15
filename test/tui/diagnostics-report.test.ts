import chalk from "chalk";
import { beforeAll, describe, expect, it } from "vitest";
import { formatDiagnosticsReport } from "../../src/cli-tui/status/diagnostics.js";
import type { DiagnosticsInput } from "../../src/cli-tui/status/diagnostics.js";

beforeAll(() => {
	chalk.level = 0;
});

const baseInput: DiagnosticsInput = {
	sessionId: "session-123",
	sessionFile: "/tmp/session-123.json",
	state: {
		systemPrompt: "You are a helpful assistant",
		model: {
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 3,
				output: 15,
				cacheRead: 1,
				cacheWrite: 2,
			},
			contextWindow: 200_000,
			maxTokens: 8192,
		},
		thinkingLevel: "medium",
		tools: [],
		steeringMode: "all",
		followUpMode: "all",
		queueMode: "all",
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Map(),
	},
	modelMetadata: {
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
		providerName: "Anthropic",
		name: "Claude Sonnet",
		source: "custom",
		baseUrl: "https://api.anthropic.com",
		contextWindow: 200_000,
		maxTokens: 8192,
	},
	apiKeyLookup: {
		provider: "anthropic",
		source: "env",
		key: "***",
		checkedEnvVars: ["ANTHROPIC_API_KEY"],
		envVar: "ANTHROPIC_API_KEY",
	},
	telemetry: {
		enabled: true,
		reason: "config",
		endpoint: "https://telemetry",
		filePath: "/tmp/telemetry.log",
		sampleRate: 1,
		flagValue: "true",
	},
	training: {
		preference: "opted-out",
		optOut: true,
		reason: "MAESTRO_TRAINING_OPT_OUT=1",
		flagValue: "1",
	},
	exaUsage: {
		totalCalls: 3,
		successes: 2,
		failures: 1,
		totalDurationMs: 4200,
		totalCostDollars: 0.0123,
		lastEvents: [
			{
				timestamp: 1_700_000_000,
				endpoint: "/search",
				operation: "websearch",
				success: true,
				status: 200,
				durationMs: 1200,
				costDollars: 0.004,
			},
		],
	},
	pendingTools: [{ id: "tool-1", name: "websearch" }],
	explicitApiKey: undefined,
	health: {
		toolFailures: 0,
		gitStatus: "clean",
		planGoals: 2,
		planPendingTasks: 1,
	},
	lspDiagnostics: {
		"src/index.ts": [
			{
				message: "Unused variable",
				range: {
					start: { line: 0, character: 4 },
					end: { line: 0, character: 10 },
				},
				severity: 2,
				source: "tsc",
			},
		],
	},
	context: undefined,
	runtime: undefined,
	attachments: [],
};

describe("formatDiagnosticsReport", () => {
	it("matches snapshot with full data", () => {
		const result = formatDiagnosticsReport(baseInput);
		expect(result).toMatchSnapshot();
	});

	it("matches snapshot when optional data missing", () => {
		const minimalInput: DiagnosticsInput = {
			...baseInput,
			exaUsage: null,
			health: undefined,
			lspDiagnostics: {},
			pendingTools: [],
			runtime: undefined,
			attachments: [],
			telemetry: {
				enabled: false,
				reason: "disabled",
				sampleRate: 0,
			},
			training: {
				preference: "provider-default",
				optOut: null,
				reason: "provider default",
			},
			apiKeyLookup: {
				provider: "anthropic",
				source: "missing",
				checkedEnvVars: [],
			},
		};
		const result = formatDiagnosticsReport(minimalInput);
		expect(result).toMatchSnapshot();
	});
});
