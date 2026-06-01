import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BATCH_SHAPING_FEEDBACK_HINT,
	type BatchShapingEvalCase,
	evaluateBatchShapingCaseOutput,
	runBatchShapingEvalSuite,
} from "../../scripts/evals/batch-shaping/core.js";
import { Agent } from "../../src/agent/agent.js";
import type {
	AgentEvent,
	AgentTool,
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
} from "../../src/agent/types.js";

const mocks = vi.hoisted(() => ({
	createProviderStream: vi.fn(),
}));

vi.mock("../../src/agent/transport/create-provider-stream.js", () => ({
	createProviderStream: mocks.createProviderStream,
}));

const { ProviderTransport } = await import("../../src/agent/transport.js");

const providerModel: Model<"openai-codex-app-server"> = {
	id: "gpt-5.5",
	name: "GPT-5.5 (Codex)",
	api: "openai-codex-app-server",
	provider: "openai-codex",
	baseUrl: "codex-app-server://local",
	reasoning: true,
	toolUse: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272000,
	maxTokens: 128000,
};

function assistantMessage(
	content: AssistantMessage["content"] = [],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-codex-app-server",
		provider: "openai-codex",
		model: providerModel.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function messageText(message: Message): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	if (Array.isArray(message.content)) {
		return message.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("\n");
	}
	return "";
}

function messagesContain(messages: Message[], substring: string): boolean {
	return messages.some((message) => messageText(message).includes(substring));
}

describe("batch shaping evals", () => {
	beforeEach(() => {
		mocks.createProviderStream.mockReset();
	});

	const sensitiveCase: BatchShapingEvalCase = {
		name: "sensitive repo inspection batches after nudge",
		userIntent:
			"Inspect the package manifest, source layout, and private customer notes.",
		replays: {
			baseline: {
				promptMessages: [
					"Inspect the package manifest, source layout, and private customer notes.",
				],
				emittedToolCalls: [
					{
						toolName: "read",
						args: { file_path: "package.json" },
					},
				],
			},
			nudged: {
				promptMessages: [
					"Inspect the package manifest, source layout, and private customer notes.",
					"When you need several independent reads or searches, emit them together in one assistant message so Maestro can batch them safely.",
				],
				emittedToolCalls: [
					{
						toolName: "read",
						args: { file_path: "package.json" },
					},
					{
						toolName: "list",
						args: { path: "src/private/customer-alpha" },
					},
					{
						toolName: "search",
						args: {
							pattern: "SECRET_TOKEN_SHOULD_NOT_LEAK",
							path: "src/private/customer-alpha",
						},
					},
				],
			},
		},
		sensitiveSubstrings: [
			"src/private/customer-alpha",
			"SECRET_TOKEN_SHOULD_NOT_LEAK",
		],
		expected: {
			baseline: {
				modelToolCallCount: 1,
				multiCallTurns: 0,
			},
			nudged: {
				modelToolCallCount: 3,
				multiCallTurns: 1,
			},
			improvement: {
				modelToolCallCountDelta: 2,
				multiCallTurnDelta: 1,
				increasedMultiCallTurns: true,
			},
			privacy: {
				safe: true,
			},
			runtime: {
				exercisedAgentToolPhaseSummary: true,
				promptOnlyFeedbackDelivered: true,
			},
		},
	};

	it("proves prompt nudges increase multi-call turns through agent feedback", async () => {
		const actual = await evaluateBatchShapingCaseOutput(sensitiveCase);

		expect(actual).toMatchObject(sensitiveCase.expected);
		expect(actual.nudged.topSerializationReasons).toEqual([]);
		expect(actual.baseline.topSerializationReasons).toEqual([
			{ reason: "single_read_only_call", count: 1 },
		]);
		expect(actual.runtime.observedToolPhaseSummaryCount).toBe(2);
	});

	it("keeps batch-shaping eval reports free of tool args and sensitive substrings", async () => {
		const actual = await evaluateBatchShapingCaseOutput(sensitiveCase);
		const serializedReport = JSON.stringify(actual);

		expect(serializedReport).not.toContain("args");
		expect(serializedReport).not.toContain("file_path");
		expect(serializedReport).not.toContain("path");
		expect(serializedReport).not.toContain("pattern");
		expect(serializedReport).not.toContain("src/private/customer-alpha");
		expect(serializedReport).not.toContain("SECRET_TOKEN_SHOULD_NOT_LEAK");
		expect(actual.privacy).toMatchObject({
			safe: true,
			disallowedSubstringCount: 2,
		});
	});

	it("fails eval cases that do not improve batch shape", async () => {
		const results = await runBatchShapingEvalSuite([
			{
				...sensitiveCase,
				replays: {
					baseline: sensitiveCase.replays!.baseline,
					nudged: {
						...sensitiveCase.replays!.nudged,
						emittedToolCalls:
							sensitiveCase.replays!.nudged.emittedToolCalls.slice(0, 1),
					},
				},
				expected: {
					baseline: {
						modelToolCallCount: 1,
						multiCallTurns: 0,
					},
					nudged: {
						modelToolCallCount: 1,
						multiCallTurns: 0,
					},
					improvement: {
						modelToolCallCountDelta: 0,
						multiCallTurnDelta: 0,
						increasedMultiCallTurns: true,
					},
				},
			},
		]);

		expect(results).toHaveLength(1);
		expect(results[0]?.pass).toBe(false);
		expect(results[0]?.mismatch).toContain("increasedMultiCallTurns");
	});

	it("smokes the batch-shaping nudge through Agent and ProviderTransport", async () => {
		const readToolExecute = vi.fn(async (_toolCallId, args) => ({
			content: [
				{ type: "text" as const, text: `read:${String(args.file_path)}` },
			],
		}));
		const readTool: AgentTool = {
			name: "read_probe",
			description: "Read-only eval probe.",
			parameters: Type.Object({ file_path: Type.String() }),
			annotations: { readOnlyHint: true },
			execute: readToolExecute,
		};
		let streamCount = 0;
		let nudgedTurnMessages: Message[] = [];
		mocks.createProviderStream.mockImplementation(async function* (
			_model: unknown,
			context: { messages: Message[] },
		) {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				yield {
					type: "toolcall_end",
					toolCall: {
						type: "toolCall",
						id: "baseline-read",
						name: "read_probe",
						arguments: { file_path: "package.json" },
					},
					partial: assistant,
				} satisfies AssistantMessageEvent;
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			if (streamCount === 2) {
				nudgedTurnMessages = context.messages;
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				for (const call of [
					{
						id: "nudged-read-1",
						arguments: { file_path: "src/agent/agent.ts" },
					},
					{
						id: "nudged-read-2",
						arguments: { file_path: "src/agent/transport.ts" },
					},
				]) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							id: call.id,
							name: "read_probe",
							arguments: call.arguments,
						},
						partial: assistant,
					} satisfies AssistantMessageEvent;
				}
				yield {
					type: "done",
					reason: "toolUse",
					message: assistant,
				} satisfies AssistantMessageEvent;
				return;
			}

			const assistant = assistantMessage([
				{ type: "text", text: "batch shaping smoke complete" },
			]);
			yield {
				type: "start",
				partial: assistant,
			} satisfies AssistantMessageEvent;
			yield {
				type: "done",
				reason: "stop",
				message: assistant,
			} satisfies AssistantMessageEvent;
		});

		const events: AgentEvent[] = [];
		const agent = new Agent({
			transport: new ProviderTransport({
				maxConcurrentToolExecutions: 4,
				platformToolExecutionBridge: false,
			}),
			initialState: {
				model: providerModel,
				tools: [readTool],
				systemPrompt: "Use read probes for repo inspection.",
			},
		});
		agent.subscribe((event) => events.push(event));

		await agent.prompt(
			"Inspect package metadata and the scheduler implementation.",
		);

		const summaries = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_phase_summary" }> =>
				event.type === "tool_phase_summary",
		);
		expect(streamCount).toBe(3);
		expect(readToolExecute).toHaveBeenCalledTimes(3);
		expect(
			messagesContain(nudgedTurnMessages, BATCH_SHAPING_FEEDBACK_HINT),
		).toBe(true);
		expect(summaries).toHaveLength(2);
		expect(summaries[0]).toMatchObject({
			modelToolCallCount: 1,
			serializedCallCount: 1,
			batchShapingFeedback: {
				avoidableSingleton: true,
				reason: "single_read_only_call",
				hint: BATCH_SHAPING_FEEDBACK_HINT,
			},
		});
		expect(summaries[1]).toMatchObject({
			modelToolCallCount: 2,
			parallelizedCallCount: 2,
			serializedCallCount: 0,
		});
		expect(summaries[1]?.batchShapingFeedback).toBeUndefined();
		expect(summaries[1]?.decisions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					toolCallId: "nudged-read-1",
					outcome: "parallelized",
					reason: "read_only_parallel_safe",
				}),
				expect.objectContaining({
					toolCallId: "nudged-read-2",
					outcome: "parallelized",
					reason: "read_only_parallel_safe",
				}),
			]),
		);
	});
});
