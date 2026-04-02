import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../src/agent/types.js";
import {
	HEADLESS_PROTOCOL_VERSION,
	HeadlessProtocolTranslator,
	applyIncomingHeadlessMessage,
	buildHeadlessCompactionMessage,
	buildHeadlessToolsSummary,
	buildHeadlessUsage,
	classifyHeadlessError,
	createHeadlessRuntimeState,
} from "../../src/cli/headless-protocol.js";

function assistantMessage(
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		model: "claude-opus-4-6",
		provider: "anthropic",
		stopReason: "stop",
		usage: {
			input: 1200,
			output: 450,
			cacheRead: 30,
			cacheWrite: 15,
			cost: {
				input: 0.01,
				output: 0.02,
				cacheRead: 0,
				cacheWrite: 0.001,
				total: 0.031,
			},
		},
		...overrides,
	};
}

describe("headless protocol helpers", () => {
	it("exports a concrete protocol version", () => {
		expect(HEADLESS_PROTOCOL_VERSION).toBe("2026-03-30");
	});

	it("classifies cancellation-like errors", () => {
		expect(classifyHeadlessError("Run interrupted by user", false)).toBe(
			"cancelled",
		);
	});

	it("classifies transient provider failures", () => {
		expect(classifyHeadlessError("Rate limit exceeded", false)).toBe(
			"transient",
		);
	});

	it("classifies generic temporary provider failures as transient", () => {
		expect(classifyHeadlessError("Temporary server error", false)).toBe(
			"transient",
		);
	});

	it("classifies protocol parse failures", () => {
		expect(classifyHeadlessError("Failed to parse JSON input", false)).toBe(
			"protocol",
		);
	});

	it("prefers tool classification over protocol keywords when both appear", () => {
		expect(classifyHeadlessError("Failed to parse tool response", false)).toBe(
			"tool",
		);
	});

	it("classifies unknown non-fatal errors as tool errors", () => {
		expect(classifyHeadlessError("Something odd happened", false)).toBe("tool");
	});

	it("builds usage totals from assistant messages", () => {
		expect(
			buildHeadlessUsage(assistantMessage(), "claude-opus-4-6", "anthropic"),
		).toEqual({
			input_tokens: 1200,
			output_tokens: 450,
			cache_read_tokens: 30,
			cache_write_tokens: 15,
			total_tokens: 1695,
			total_cost_usd: 0.031,
			model_id: "claude-opus-4-6",
			provider: "anthropic",
		});
	});

	it("returns zeroed usage when usage metadata is missing", () => {
		expect(
			buildHeadlessUsage(
				assistantMessage({ usage: undefined }),
				"gpt-5.4",
				"openai",
			),
		).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			total_tokens: 0,
			total_cost_usd: 0,
			model_id: "gpt-5.4",
			provider: "openai",
		});
	});

	it("builds headless tool summaries with concise labels", () => {
		expect(
			buildHeadlessToolsSummary({
				toolsUsed: new Set(["bash", "read"]),
				callsSucceeded: 2,
				callsFailed: 1,
				summaryLabels: ["Read config.json", "Ran npm test", "Read config.json"],
			}),
		).toEqual({
			tools_used: ["bash", "read"],
			calls_succeeded: 2,
			calls_failed: 1,
			summary_labels: ["Read config.json", "Ran npm test", "Read config.json"],
		});
	});

	it("omits empty summary labels from the serialized tool summary", () => {
		expect(
			buildHeadlessToolsSummary({
				toolsUsed: new Set(["read"]),
				callsSucceeded: 1,
				callsFailed: 0,
				summaryLabels: [],
			}),
		).toEqual({
			tools_used: ["read"],
			calls_succeeded: 1,
			calls_failed: 0,
			summary_labels: undefined,
		});
	});

	it("builds headless compaction messages", () => {
		expect(
			buildHeadlessCompactionMessage({
				type: "compaction",
				summary: "## Conversation Summary",
				firstKeptEntryIndex: 4,
				tokensBefore: 12000,
				auto: true,
				timestamp: "2026-03-31T12:00:00Z",
			}),
		).toEqual({
			type: "compaction",
			summary: "## Conversation Summary",
			first_kept_entry_index: 4,
			tokens_before: 12000,
			auto: true,
			timestamp: "2026-03-31T12:00:00Z",
		});
	});

	it("translates tool execution updates into tool_output chunks", () => {
		const translator = new HeadlessProtocolTranslator();
		expect(
			translator.handleAgentEvent({
				type: "tool_execution_update",
				toolCallId: "call_123",
				toolName: "bash",
				args: {},
				partialResult: {
					content: [{ type: "text", text: "first line" }],
				},
			}),
		).toEqual([
			{
				type: "tool_output",
				call_id: "call_123",
				content: "first line",
			},
		]);
	});

	it("deduplicates repeated tool summary labels within a response", () => {
		const translator = new HeadlessProtocolTranslator();
		translator.handleAgentEvent({
			type: "message_start",
			message: assistantMessage(),
		});
		translator.handleAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "read",
			args: { file_path: "package.json" },
		});
		translator.handleAgentEvent({
			type: "tool_execution_start",
			toolCallId: "call_2",
			toolName: "read",
			args: { file_path: "package.json" },
		});

		const [responseEnd] = translator.handleAgentEvent({
			type: "message_end",
			message: assistantMessage(),
		});
		expect(responseEnd).toMatchObject({
			type: "response_end",
			tools_summary: {
				summary_labels: ["Read package.json"],
			},
		});
	});

	it("tracks non-approval tool names through tool_start", () => {
		const state = createHeadlessRuntimeState();

		applyIncomingHeadlessMessage(state, {
			type: "tool_call",
			call_id: "call_read",
			tool: "read",
			args: { file_path: "package.json" },
			requires_approval: false,
		});
		applyIncomingHeadlessMessage(state, {
			type: "tool_start",
			call_id: "call_read",
		});

		expect(state.pending_approvals).toEqual([]);
		expect(state.active_tools).toEqual([
			{
				call_id: "call_read",
				tool: "read",
				output: "",
			},
		]);
	});
});
