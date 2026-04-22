import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SAMPLE_OPENAI_KEY = [
	"sk",
	"-",
	"abc123def456ghi789jkl012mno345pqr678",
].join("");

const mockModel = {
	id: "mock",
	name: "Mock",
	provider: "mock",
	api: "openai-completions",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 8192,
	maxTokens: 2048,
} as const;

describe("tool call attempt event bus publishing", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
	});

	it("sanitizes safe_arguments before publishing tool call attempts", async () => {
		const recordMaestroToolCallAttempt = vi.fn();

		vi.doMock("../../src/telemetry/maestro-event-bus.js", () => ({
			recordMaestroToolCallAttempt,
			recordMaestroToolCallCompleted: vi.fn(),
		}));

		const [{ Agent }, { MockToolTransport }] = await Promise.all([
			import("../../src/agent/agent.js"),
			import("../../src/testing/mock-agent.js"),
		]);

		const shellTool = {
			name: "bash",
			description: "Run shell command",
			parameters: Type.Object({
				command: Type.String(),
			}),
			execute: async () => ({
				content: [{ type: "text" as const, text: "ok" }],
			}),
		};

		const agent = new Agent({
			transport: new MockToolTransport(
				[
					{
						name: "bash",
						args: {
							command: `curl -H "Authorization: Bearer ${SAMPLE_OPENAI_KEY}" https://example.com`,
						},
					},
				],
				() => "Done",
			),
			initialState: {
				model: mockModel,
				tools: [shellTool],
			},
		});

		await agent.prompt("run the command");

		expect(recordMaestroToolCallAttempt).toHaveBeenCalledTimes(1);
		const payload = recordMaestroToolCallAttempt.mock.calls[0]?.[0] as {
			safe_arguments: Record<string, unknown>;
		};
		expect(payload.safe_arguments).toMatchObject({
			command: expect.stringContaining("[REDACTED:"),
		});
		expect(JSON.stringify(payload.safe_arguments)).not.toContain(
			SAMPLE_OPENAI_KEY,
		);
	});
});
