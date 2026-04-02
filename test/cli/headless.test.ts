import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../src/agent/types.js";
import {
	HEADLESS_PROTOCOL_VERSION,
	HeadlessProtocolTranslator,
	applyIncomingHeadlessMessage,
	applyOutgoingHeadlessMessage,
	buildHeadlessCompactionMessage,
	buildHeadlessServerRequestCancellationMessages,
	buildHeadlessToolsSummary,
	buildHeadlessUsage,
	classifyHeadlessError,
	createHeadlessRuntimeState,
	loadPromptAttachments,
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

	it("falls back to tool classification for unknown non-fatal errors", () => {
		expect(classifyHeadlessError("Unexpected failure", false)).toBe("tool");
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

	it("translates approval requests into legacy and server_request messages", () => {
		const translator = new HeadlessProtocolTranslator();
		expect(
			translator.handleAgentEvent({
				type: "action_approval_required",
				request: {
					id: "call_approval",
					toolName: "bash",
					args: { command: "rm -rf dist" },
					reason: "Dangerous command",
				},
			}),
		).toEqual([
			{
				type: "tool_call",
				call_id: "call_approval",
				tool: "bash",
				args: { command: "rm -rf dist" },
				requires_approval: true,
			},
			{
				type: "server_request",
				request_id: "call_approval",
				request_type: "approval",
				call_id: "call_approval",
				tool: "bash",
				args: { command: "rm -rf dist" },
				reason: "Dangerous command",
			},
		]);
	});

	it("translates approval resolutions into server_request_resolved messages", () => {
		const translator = new HeadlessProtocolTranslator();
		expect(
			translator.handleAgentEvent({
				type: "action_approval_resolved",
				request: {
					id: "call_approval",
					toolName: "bash",
					args: { command: "rm -rf dist" },
					reason: "Dangerous command",
				},
				decision: {
					approved: false,
					reason: "Denied by user",
					resolvedBy: "user",
				},
			}),
		).toEqual([
			{
				type: "server_request_resolved",
				request_id: "call_approval",
				request_type: "approval",
				call_id: "call_approval",
				resolution: "denied",
				reason: "Denied by user",
				resolved_by: "user",
			},
		]);
	});

	it("translates client tool requests into legacy and generic request messages", () => {
		const translator = new HeadlessProtocolTranslator();
		expect(
			translator.handleAgentEvent({
				type: "client_tool_request",
				toolCallId: "call_client",
				toolName: "artifacts",
				args: { command: "create", filename: "report.txt" },
			}),
		).toEqual([
			{
				type: "client_tool_request",
				call_id: "call_client",
				tool: "artifacts",
				args: { command: "create", filename: "report.txt" },
			},
			{
				type: "server_request",
				request_id: "call_client",
				request_type: "client_tool",
				call_id: "call_client",
				tool: "artifacts",
				args: { command: "create", filename: "report.txt" },
				reason: "Client tool artifacts requires local execution",
			},
		]);
	});

	it("translates ask_user requests into user_input server requests", () => {
		const translator = new HeadlessProtocolTranslator();
		expect(
			translator.handleAgentEvent({
				type: "client_tool_request",
				toolCallId: "call_user_input",
				toolName: "ask_user",
				args: {
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
							],
						},
					],
				},
			}),
		).toEqual([
			{
				type: "client_tool_request",
				call_id: "call_user_input",
				tool: "ask_user",
				args: {
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
							],
						},
					],
				},
			},
			{
				type: "server_request",
				request_id: "call_user_input",
				request_type: "user_input",
				call_id: "call_user_input",
				tool: "ask_user",
				args: {
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
							],
						},
					],
				},
				reason: "Agent requested structured user input",
			},
		]);
	});

	it("deduplicates repeated tool summary labels", () => {
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

		expect(
			translator.handleAgentEvent({
				type: "message_end",
				message: assistantMessage(),
			}),
		).toEqual([
			expect.objectContaining({
				type: "response_end",
				tools_summary: expect.objectContaining({
					summary_labels: ["Read package.json"],
				}),
			}),
		]);
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

	it("tracks approval server requests in the runtime state", () => {
		const state = createHeadlessRuntimeState();

		applyIncomingHeadlessMessage(state, {
			type: "server_request",
			request_id: "call_bash",
			request_type: "approval",
			call_id: "call_bash",
			tool: "bash",
			args: { command: "git push --force" },
			reason: "Force push requires approval",
		});

		expect(state.pending_approvals).toEqual([
			{
				call_id: "call_bash",
				tool: "bash",
				args: { command: "git push --force" },
			},
		]);
		expect(state.tracked_tools).toEqual([
			{
				call_id: "call_bash",
				tool: "bash",
				args: { command: "git push --force" },
			},
		]);
	});

	it("tracks negotiated connection metadata in runtime state", () => {
		const state = createHeadlessRuntimeState();

		applyOutgoingHeadlessMessage(state, {
			type: "hello",
			protocol_version: "2026-03-30",
			client_info: { name: "maestro-tui-rs", version: "0.1.0" },
			capabilities: { server_requests: ["approval"] },
			role: "controller",
		});
		applyIncomingHeadlessMessage(state, {
			type: "connection_info",
			client_protocol_version: "2026-03-30",
			client_info: { name: "maestro-tui-rs", version: "0.1.0" },
			capabilities: { server_requests: ["approval"] },
			role: "controller",
		});

		expect(state.client_protocol_version).toBe("2026-03-30");
		expect(state.client_info).toEqual({
			name: "maestro-tui-rs",
			version: "0.1.0",
		});
		expect(state.capabilities).toEqual({
			server_requests: ["approval"],
		});
		expect(state.connection_role).toBe("controller");
	});

	it("clears approval state on denied server_request_resolved messages", () => {
		const state = createHeadlessRuntimeState();

		applyIncomingHeadlessMessage(state, {
			type: "server_request",
			request_id: "call_bash",
			request_type: "approval",
			call_id: "call_bash",
			tool: "bash",
			args: { command: "git push --force" },
			reason: "Force push requires approval",
		});
		applyIncomingHeadlessMessage(state, {
			type: "server_request_resolved",
			request_id: "call_bash",
			request_type: "approval",
			call_id: "call_bash",
			resolution: "denied",
			reason: "Denied by user",
			resolved_by: "user",
		});

		expect(state.pending_approvals).toEqual([]);
		expect(state.tracked_tools).toEqual([]);
	});

	it("tracks and clears pending client tool requests in runtime state", () => {
		const state = createHeadlessRuntimeState();

		applyIncomingHeadlessMessage(state, {
			type: "client_tool_request",
			call_id: "call_client",
			tool: "artifacts",
			args: { command: "create", filename: "report.txt" },
		});

		expect(state.pending_client_tools).toEqual([
			{
				call_id: "call_client",
				tool: "artifacts",
				args: { command: "create", filename: "report.txt" },
			},
		]);
		expect(state.tracked_tools).toEqual([
			{
				call_id: "call_client",
				tool: "artifacts",
				args: { command: "create", filename: "report.txt" },
			},
		]);

		applyIncomingHeadlessMessage(state, {
			type: "tool_end",
			call_id: "call_client",
			success: true,
		});

		expect(state.pending_client_tools).toEqual([]);
		expect(state.tracked_tools).toEqual([]);
	});

	it("tracks generic client tool server requests in runtime state", () => {
		const state = createHeadlessRuntimeState();

		applyIncomingHeadlessMessage(state, {
			type: "server_request",
			request_id: "call_client",
			request_type: "client_tool",
			call_id: "call_client",
			tool: "artifacts",
			args: { command: "create", filename: "report.txt" },
			reason: "Client tool artifacts requires local execution",
		});

		expect(state.pending_client_tools).toEqual([
			{
				call_id: "call_client",
				tool: "artifacts",
				args: { command: "create", filename: "report.txt" },
			},
		]);
		expect(state.tracked_tools).toEqual([
			{
				call_id: "call_client",
				tool: "artifacts",
				args: { command: "create", filename: "report.txt" },
			},
		]);

		applyIncomingHeadlessMessage(state, {
			type: "server_request_resolved",
			request_id: "call_client",
			request_type: "client_tool",
			call_id: "call_client",
			resolution: "completed",
			resolved_by: "client",
		});

		expect(state.pending_client_tools).toEqual([]);
		expect(state.tracked_tools).toEqual([
			{
				call_id: "call_client",
				tool: "artifacts",
				args: { command: "create", filename: "report.txt" },
			},
		]);
	});

	it("tracks and resolves user input requests in runtime state", () => {
		const state = createHeadlessRuntimeState();

		applyIncomingHeadlessMessage(state, {
			type: "client_tool_request",
			call_id: "call_user_input",
			tool: "ask_user",
			args: {
				questions: [
					{
						header: "Stack",
						question: "Which schema library should we use?",
						options: [
							{
								label: "Zod",
								description: "Use Zod schemas",
							},
						],
					},
				],
			},
		});

		expect(state.pending_user_inputs).toEqual([
			{
				call_id: "call_user_input",
				tool: "ask_user",
				args: {
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
							],
						},
					],
				},
			},
		]);

		applyIncomingHeadlessMessage(state, {
			type: "server_request_resolved",
			request_id: "call_user_input",
			request_type: "user_input",
			call_id: "call_user_input",
			resolution: "answered",
			resolved_by: "client",
		});

		expect(state.pending_user_inputs).toEqual([]);
		expect(state.tracked_tools).toEqual([
			{
				call_id: "call_user_input",
				tool: "ask_user",
				args: {
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
							],
						},
					],
				},
			},
		]);
	});

	it("cancellation helper emits explicit cancelled resolutions for pending requests", () => {
		const state = createHeadlessRuntimeState();

		applyIncomingHeadlessMessage(state, {
			type: "server_request",
			request_id: "call_bash",
			request_type: "approval",
			call_id: "call_bash",
			tool: "bash",
			args: { command: "git push --force" },
			reason: "Force push requires approval",
		});
		applyIncomingHeadlessMessage(state, {
			type: "server_request",
			request_id: "call_client",
			request_type: "client_tool",
			call_id: "call_client",
			tool: "artifacts",
			args: { command: "create", filename: "report.txt" },
			reason: "Client tool artifacts requires local execution",
		});
		applyIncomingHeadlessMessage(state, {
			type: "server_request",
			request_id: "call_user_input",
			request_type: "user_input",
			call_id: "call_user_input",
			tool: "ask_user",
			args: {
				questions: [
					{
						header: "Stack",
						question: "Which schema library should we use?",
						options: [
							{
								label: "Zod",
								description: "Use Zod schemas",
							},
						],
					},
				],
			},
			reason: "Agent requested structured user input",
		});

		expect(
			buildHeadlessServerRequestCancellationMessages(
				state,
				"Interrupted before request completed",
			),
		).toEqual([
			{
				type: "server_request_resolved",
				request_id: "call_bash",
				request_type: "approval",
				call_id: "call_bash",
				resolution: "cancelled",
				reason: "Interrupted before request completed",
				resolved_by: "runtime",
			},
			{
				type: "server_request_resolved",
				request_id: "call_client",
				request_type: "client_tool",
				call_id: "call_client",
				resolution: "cancelled",
				reason: "Interrupted before request completed",
				resolved_by: "runtime",
			},
			{
				type: "server_request_resolved",
				request_id: "call_user_input",
				request_type: "user_input",
				call_id: "call_user_input",
				resolution: "cancelled",
				reason: "Interrupted before request completed",
				resolved_by: "runtime",
			},
		]);
	});

	it("clears tracked client tools on cancelled server_request_resolved messages", () => {
		const state = createHeadlessRuntimeState();

		applyIncomingHeadlessMessage(state, {
			type: "server_request",
			request_id: "call_client",
			request_type: "client_tool",
			call_id: "call_client",
			tool: "artifacts",
			args: { command: "create", filename: "report.txt" },
			reason: "Client tool artifacts requires local execution",
		});
		applyIncomingHeadlessMessage(state, {
			type: "server_request_resolved",
			request_id: "call_client",
			request_type: "client_tool",
			call_id: "call_client",
			resolution: "cancelled",
			reason: "Interrupted before request completed",
			resolved_by: "runtime",
		});

		expect(state.pending_client_tools).toEqual([]);
		expect(state.tracked_tools).toEqual([]);
	});

	it("clears pending client tool requests on outbound client tool results", () => {
		const state = createHeadlessRuntimeState();

		applyIncomingHeadlessMessage(state, {
			type: "client_tool_request",
			call_id: "call_client",
			tool: "artifacts",
			args: { command: "create", filename: "report.txt" },
		});

		applyIncomingHeadlessMessage(state, {
			type: "tool_start",
			call_id: "call_client",
		});

		applyOutgoingHeadlessMessage(state, {
			type: "client_tool_result",
			call_id: "call_client",
			content: [{ type: "text", text: "ok" }],
			is_error: false,
		});

		expect(state.pending_client_tools).toEqual([]);
		expect(state.tracked_tools).toEqual([
			{
				call_id: "call_client",
				tool: "artifacts",
				args: { command: "create", filename: "report.txt" },
			},
		]);
	});

	it("clears pending requests on outbound generic server request responses", () => {
		const state = createHeadlessRuntimeState();

		applyIncomingHeadlessMessage(state, {
			type: "server_request",
			request_id: "call_user_input",
			request_type: "user_input",
			call_id: "call_user_input",
			tool: "ask_user",
			args: {
				questions: [
					{
						header: "Stack",
						question: "Which schema library should we use?",
						options: [
							{
								label: "Zod",
								description: "Use Zod schemas",
							},
						],
					},
				],
			},
			reason: "Agent requested structured user input",
		});

		applyOutgoingHeadlessMessage(state, {
			type: "server_request_response",
			request_id: "call_user_input",
			request_type: "user_input",
			content: [{ type: "text", text: "Use Zod" }],
			is_error: false,
		});

		expect(state.pending_user_inputs).toEqual([]);
		expect(state.tracked_tools).toEqual([
			{
				call_id: "call_user_input",
				tool: "ask_user",
				args: {
					questions: [
						{
							header: "Stack",
							question: "Which schema library should we use?",
							options: [
								{
									label: "Zod",
									description: "Use Zod schemas",
								},
							],
						},
					],
				},
			},
		]);
	});

	it("preserves tracked tools on approved server_request_resolved messages", () => {
		const state = createHeadlessRuntimeState();

		applyIncomingHeadlessMessage(state, {
			type: "server_request",
			request_id: "call_bash",
			request_type: "approval",
			call_id: "call_bash",
			tool: "bash",
			args: { command: "git push --force" },
			reason: "Force push requires approval",
		});
		applyIncomingHeadlessMessage(state, {
			type: "server_request_resolved",
			request_id: "call_bash",
			request_type: "approval",
			call_id: "call_bash",
			resolution: "approved",
			reason: "Approved by user",
			resolved_by: "user",
		});

		expect(state.pending_approvals).toEqual([]);
		expect(state.tracked_tools).toEqual([
			{
				call_id: "call_bash",
				tool: "bash",
				args: { command: "git push --force" },
			},
		]);
	});

	it("does not clear responding state on non-fatal errors", () => {
		const state = createHeadlessRuntimeState();

		applyIncomingHeadlessMessage(state, {
			type: "response_start",
			response_id: "resp_1",
		});
		applyIncomingHeadlessMessage(state, {
			type: "error",
			message: "Tool failed",
			fatal: false,
			error_type: "tool",
		});

		expect(state.is_responding).toBe(true);
		expect(state.last_error).toBe("Tool failed");
		expect(state.last_error_type).toBe("tool");
	});

	it("accepts text attachments up to the 10MB default limit", async () => {
		const tempDir = await mkdtemp(
			join(tmpdir(), "maestro-headless-attachment-"),
		);
		const filePath = join(tempDir, "large.txt");
		const errors: Array<{ message: string; fatal: boolean }> = [];

		try {
			await writeFile(filePath, Buffer.alloc(9 * 1024 * 1024, "a"));

			const attachments = await loadPromptAttachments(
				[filePath],
				(message, fatal) => {
					errors.push({ message, fatal });
				},
			);

			expect(errors).toEqual([]);
			expect(attachments).toHaveLength(1);
			expect(attachments[0]).toMatchObject({
				type: "document",
				fileName: "large.txt",
				size: 9 * 1024 * 1024,
			});
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});
