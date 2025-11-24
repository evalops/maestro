import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import type { ActionApprovalService } from "../../src/agent/action-approval.js";
import { ProviderTransport } from "../../src/agent/transport.js";
import type {
	AgentRunConfig,
	AgentTool,
	Message,
	ToolResultMessage,
} from "../../src/agent/types.js";

const { nextToolStream } = vi.hoisted(() => {
	const baseAssistantMessage = {
		role: "assistant" as const,
		content: [],
		api: "openai-completions" as const,
		provider: "openai" as const,
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse" as const,
		timestamp: 0,
	};

	let invocation = 0;

	const buildStream = (includeToolCalls: boolean) =>
		async function* () {
			yield { type: "start" as const, partial: baseAssistantMessage };
			if (includeToolCalls) {
				yield {
					type: "toolcall_end" as const,
					toolCall: {
						type: "toolCall" as const,
						id: "call_collect",
						name: "collect_customer_context",
						arguments: { subject: "Case-742" },
					},
					partial: baseAssistantMessage,
				};
				yield {
					type: "toolcall_end" as const,
					toolCall: {
						type: "toolCall" as const,
						id: "call_handoff",
						name: "handoff_to_human",
						arguments: {},
					},
					partial: baseAssistantMessage,
				};
			}
			yield {
				type: "done" as const,
				reason: includeToolCalls ? ("toolUse" as const) : ("stop" as const),
				message: baseAssistantMessage,
			};
		};

	return {
		nextToolStream: () => buildStream(invocation++ === 0),
	};
});

vi.mock("../../src/agent/providers/anthropic.js", () => ({
	streamAnthropic: vi.fn(() => {
		throw new Error("not used in test");
	}),
}));

vi.mock("../../src/agent/providers/google.js", () => ({
	streamGoogle: vi.fn(() => {
		throw new Error("not used in test");
	}),
}));

vi.mock("../../src/agent/providers/openai.js", () => ({
	streamOpenAI: vi.fn(() => nextToolStream()()),
}));

describe("ProviderTransport workflow-state integration", () => {
	it("serializes tool execution so human egress sees pending PII", async () => {
		const collectTool: AgentTool = {
			name: "collect_customer_context",
			description: "collect",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
				return {
					content: [{ type: "text", text: "PII" }],
				};
			},
		};

		const handoffExecute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "handoff" }],
		}));
		const handoffTool: AgentTool = {
			name: "handoff_to_human",
			description: "handoff",
			parameters: Type.Object({}, { additionalProperties: true }),
			execute: handoffExecute,
		};

		const approvalSpy = vi.fn(async () => ({
			approved: false,
			reason: "Blocked",
			resolvedBy: "policy" as const,
		}));
		const approvalService = {
			requiresUserInteraction: () => false,
			requestApproval: approvalSpy,
		} as unknown as ActionApprovalService;

		const transport = new ProviderTransport({
			getApiKey: () => "test-key",
			approvalService,
			maxConcurrentToolExecutions: 2,
		});
		const cfg: AgentRunConfig = {
			systemPrompt: "",
			tools: [collectTool, handoffTool],
			model: {
				id: "gpt-test",
				name: "gpt-test",
				api: "openai-completions",
				provider: "openai",
				baseUrl: "https://example.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 1000,
			},
		};
		const userMessage: Message = {
			role: "user",
			content: "hi",
			timestamp: Date.now(),
		};

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const handoffResults: ToolResultMessage[] = [];

		for await (const event of transport.run([], userMessage, cfg)) {
			if (
				event.type === "tool_execution_end" &&
				event.toolCallId === "call_handoff"
			) {
				handoffResults.push(event.result);
			}
		}

		expect(approvalSpy).not.toHaveBeenCalled();
		expect(handoffExecute).not.toHaveBeenCalled();
		expect(handoffResults).toHaveLength(1);
		expect(handoffResults[0].content[0]).toMatchObject({
			text: expect.stringContaining("redact_transcript"),
		});
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining(
				"WorkflowStateTracker currently requires serialized tool execution; maxConcurrentToolExecutions has been capped",
			),
		);

		warnSpy.mockRestore();
	});
});
