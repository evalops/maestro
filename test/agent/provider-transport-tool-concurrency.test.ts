import { performance } from "node:perf_hooks";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
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

const model: Model<"openai-codex-app-server"> = {
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

type TimedToolRecord = {
	id: string;
	phase: "inspect" | "commit" | "verify";
	startedAt: number;
	endedAt?: number;
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
		model: "gpt-5.5",
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const events: T[] = [];
	for await (const event of iterable) {
		events.push(event);
	}
	return events;
}

describe("ProviderTransport tool scheduling", () => {
	it("runs read-only waves concurrently around a serialized mutation", async () => {
		const records: TimedToolRecord[] = [];
		let activeReadOnlyTools = 0;
		let mutationOverlapCount = 0;

		const readProbeTool: AgentTool = {
			name: "read_probe",
			description: "Read-only latency probe.",
			parameters: Type.Object({
				phase: Type.Union([Type.Literal("inspect"), Type.Literal("verify")]),
				slot: Type.Integer(),
			}),
			annotations: {
				readOnlyHint: true,
			},
			execute: async (toolCallId, args) => {
				const record: TimedToolRecord = {
					id: toolCallId,
					phase: args.phase as "inspect" | "verify",
					startedAt: performance.now(),
				};
				records.push(record);
				activeReadOnlyTools += 1;
				await sleep(80);
				activeReadOnlyTools -= 1;
				record.endedAt = performance.now();
				return {
					content: [
						{
							type: "text",
							text: `${String(args.phase)}:${String(args.slot)}`,
						},
					],
				};
			},
		};
		const commitStepTool: AgentTool = {
			name: "commit_step",
			description: "Mutating latency probe.",
			parameters: Type.Object({
				label: Type.String(),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
			},
			execute: async (toolCallId, args) => {
				if (activeReadOnlyTools > 0) {
					mutationOverlapCount += 1;
				}
				const record: TimedToolRecord = {
					id: toolCallId,
					phase: "commit",
					startedAt: performance.now(),
				};
				records.push(record);
				await sleep(20);
				record.endedAt = performance.now();
				return {
					content: [{ type: "text", text: `commit:${String(args.label)}` }],
				};
			},
		};

		let streamCount = 0;
		mocks.createProviderStream.mockImplementation(async function* () {
			streamCount += 1;
			if (streamCount === 1) {
				const assistant = assistantMessage([], "toolUse");
				yield {
					type: "start",
					partial: assistant,
				} satisfies AssistantMessageEvent;
				const calls = [
					...Array.from({ length: 4 }, (_, index) => ({
						id: `inspect-${index + 1}`,
						name: "read_probe",
						arguments: { phase: "inspect", slot: index + 1 },
					})),
					{
						id: "commit-1",
						name: "commit_step",
						arguments: { label: "apply-plan" },
					},
					...Array.from({ length: 4 }, (_, index) => ({
						id: `verify-${index + 1}`,
						name: "read_probe",
						arguments: { phase: "verify", slot: index + 1 },
					})),
				];
				for (const call of calls) {
					yield {
						type: "toolcall_end",
						toolCall: {
							type: "toolCall",
							id: call.id,
							name: call.name,
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

			const assistant = assistantMessage(
				[{ type: "text", text: "complex goal complete" }],
				"stop",
			);
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

		const userMessage: Message = {
			role: "user",
			content:
				"Complete the complex goal: inspect four inputs, commit the plan, then verify four outputs.",
			timestamp: Date.now(),
		};
		const transport = new ProviderTransport({
			maxConcurrentToolExecutions: 2,
			platformToolExecutionBridge: false,
		});

		const events = await drain(
			transport.run([userMessage], userMessage, {
				systemPrompt: "Use the requested tools.",
				tools: [readProbeTool, commitStepTool],
				model,
			}),
		);

		const toolResults = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> =>
				event.type === "tool_execution_end",
		);
		const inspectRecords = records.filter(
			(record) => record.phase === "inspect",
		);
		const verifyRecords = records.filter((record) => record.phase === "verify");
		const commitRecord = records.find((record) => record.phase === "commit");
		if (!commitRecord?.endedAt) {
			throw new Error("Missing commit tool timing record");
		}

		const inspectStartSpread =
			Math.max(...inspectRecords.map((record) => record.startedAt)) -
			Math.min(...inspectRecords.map((record) => record.startedAt));
		const verifyStartSpread =
			Math.max(...verifyRecords.map((record) => record.startedAt)) -
			Math.min(...verifyRecords.map((record) => record.startedAt));
		const latestInspectEnd = Math.max(
			...inspectRecords.map((record) => record.endedAt ?? 0),
		);
		const earliestVerifyStart = Math.min(
			...verifyRecords.map((record) => record.startedAt),
		);

		expect(toolResults).toHaveLength(9);
		expect(inspectRecords).toHaveLength(4);
		expect(verifyRecords).toHaveLength(4);
		expect(inspectStartSpread).toBeLessThan(40);
		expect(commitRecord.startedAt).toBeGreaterThanOrEqual(latestInspectEnd);
		expect(mutationOverlapCount).toBe(0);
		expect(earliestVerifyStart).toBeGreaterThanOrEqual(commitRecord.endedAt);
		expect(verifyStartSpread).toBeLessThan(40);
	});
});
