import { describe, expect, it } from "vitest";

import type { AgentEvent, AssistantMessage } from "../../src/agent/types.js";
import type { HeadlessFromAgentMessage } from "../../src/cli/headless-protocol.js";
import { createNativeHeadlessEventAdapter } from "../../src/server/native-headless-event-adapter.js";

function emptyUsage() {
	return {
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
		total_tokens: 0,
		total_cost_usd: 0,
		model_id: "gpt-test",
		provider: "openai",
	};
}

function eventTypes(events: AgentEvent[]): string[] {
	return events.map((event) => event.type);
}

function isAssistant(message: unknown): message is AssistantMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { role?: string }).role === "assistant"
	);
}

describe("createNativeHeadlessEventAdapter", () => {
	it("maps response_start → chunks → response_end into coherent message events", () => {
		const adapter = createNativeHeadlessEventAdapter({
			modelId: "gpt-test",
			provider: "openai",
		});

		const start = adapter.handle({
			type: "response_start",
			response_id: "resp_1",
		});
		expect(eventTypes(start)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
		]);
		const messageStart = start.find((e) => e.type === "message_start");
		expect(messageStart?.type).toBe("message_start");
		if (messageStart?.type === "message_start") {
			expect(isAssistant(messageStart.message)).toBe(true);
			if (isAssistant(messageStart.message)) {
				expect(messageStart.message.content).toEqual([]);
				expect(messageStart.message.model).toBe("gpt-test");
				expect(messageStart.message.provider).toBe("openai");
			}
		}

		const chunk1 = adapter.handle({
			type: "response_chunk",
			response_id: "resp_1",
			content: "Hello",
			is_thinking: false,
		});
		expect(eventTypes(chunk1)).toEqual(["message_update"]);
		expect(adapter.getPartialAssistantText()).toBe("Hello");
		if (chunk1[0]?.type === "message_update") {
			expect(chunk1[0].assistantMessageEvent).toMatchObject({
				type: "text_delta",
				contentIndex: 0,
				delta: "Hello",
			});
		}

		const chunk2 = adapter.handle({
			type: "response_chunk",
			response_id: "resp_1",
			content: ", world",
			is_thinking: false,
		});
		expect(eventTypes(chunk2)).toEqual(["message_update"]);
		expect(adapter.getPartialAssistantText()).toBe("Hello, world");
		if (chunk2[0]?.type === "message_update") {
			expect(chunk2[0].assistantMessageEvent).toMatchObject({
				type: "text_delta",
				delta: ", world",
			});
			const partial = chunk2[0].assistantMessageEvent.partial;
			expect(partial.content).toEqual([{ type: "text", text: "Hello, world" }]);
		}

		const end = adapter.handle({
			type: "response_end",
			response_id: "resp_1",
			usage: {
				...emptyUsage(),
				input_tokens: 10,
				output_tokens: 4,
				total_tokens: 14,
				total_cost_usd: 0.001,
			},
			tools_summary: {
				tools_used: [],
				calls_succeeded: 0,
				calls_failed: 0,
			},
			duration_ms: 42,
		});
		// Intermediate response_end closes the assistant message only (tools may follow).
		expect(eventTypes(end)).toEqual(["message_end"]);
		if (end[0]?.type === "message_end" && isAssistant(end[0].message)) {
			expect(end[0].message.content).toEqual([
				{ type: "text", text: "Hello, world" },
			]);
			expect(end[0].message.usage.input).toBe(10);
			expect(end[0].message.usage.output).toBe(4);
			expect(end[0].message.usage.cost.total).toBe(0.001);
			expect(end[0].message.model).toBe("gpt-test");
			expect(end[0].message.stopReason).toBe("stop");
		}
		expect(adapter.getPartialAssistantText()).toBe("");

		const done = adapter.handle({
			type: "response_end",
			response_id: "done",
			usage: emptyUsage(),
			tools_summary: {
				tools_used: [],
				calls_succeeded: 0,
				calls_failed: 0,
			},
			duration_ms: 0,
		});
		expect(eventTypes(done)).toEqual(["turn_end", "agent_end"]);
		if (done[1]?.type === "agent_end") {
			expect(done[1].stopReason).toBe("stop");
			expect(done[1].aborted).toBeUndefined();
		}
	});

	it("keeps the turn open across intermediate response_end for multi-round tools", () => {
		const adapter = createNativeHeadlessEventAdapter({
			modelId: "gpt-test",
			provider: "openai",
		});

		const round1 = [
			...adapter.handle({ type: "response_start", response_id: "r1" }),
			...adapter.handle({
				type: "response_chunk",
				response_id: "r1",
				content: "using tools",
				is_thinking: false,
			}),
			...adapter.handle({
				type: "response_end",
				response_id: "r1",
				usage: emptyUsage(),
				tools_summary: {
					tools_used: ["bash"],
					calls_succeeded: 0,
					calls_failed: 0,
				},
				duration_ms: 1,
			}),
			...adapter.handle({
				type: "tool_call",
				call_id: "c1",
				tool: "bash",
				args: { command: "ls" },
				requires_approval: false,
			}),
			...adapter.handle({
				type: "tool_end",
				call_id: "c1",
				success: true,
				tool: "bash",
			}),
		];
		expect(eventTypes(round1)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_update",
			"message_end",
			"tool_execution_start",
			"tool_execution_end",
		]);
		expect(round1.some((e) => e.type === "agent_end")).toBe(false);

		const round2Start = adapter.handle({
			type: "response_start",
			response_id: "r2",
		});
		// No second agent_start / turn_start mid-turn.
		expect(eventTypes(round2Start)).toEqual(["message_start"]);

		adapter.handle({
			type: "response_chunk",
			response_id: "r2",
			content: "done",
			is_thinking: false,
		});
		adapter.handle({
			type: "response_end",
			response_id: "r2",
			usage: emptyUsage(),
			tools_summary: {
				tools_used: ["bash"],
				calls_succeeded: 1,
				calls_failed: 0,
			},
			duration_ms: 2,
		});

		const terminal = adapter.handle({
			type: "response_end",
			response_id: "done",
			usage: emptyUsage(),
			tools_summary: {
				tools_used: ["bash"],
				calls_succeeded: 1,
				calls_failed: 0,
			},
			duration_ms: 0,
		});
		expect(eventTypes(terminal)).toEqual(["turn_end", "agent_end"]);
	});

	it("maps thinking chunks to thinking_delta", () => {
		const adapter = createNativeHeadlessEventAdapter();

		adapter.handle({ type: "response_start", response_id: "resp_t" });

		const thinking = adapter.handle({
			type: "response_chunk",
			response_id: "resp_t",
			content: "ponder…",
			is_thinking: true,
		});
		expect(eventTypes(thinking)).toEqual(["message_update"]);
		if (thinking[0]?.type === "message_update") {
			expect(thinking[0].assistantMessageEvent).toMatchObject({
				type: "thinking_delta",
				contentIndex: 0,
				delta: "ponder…",
			});
			expect(thinking[0].assistantMessageEvent.partial.content).toEqual([
				{ type: "thinking", thinking: "ponder…" },
			]);
		}

		const text = adapter.handle({
			type: "response_chunk",
			response_id: "resp_t",
			content: "answer",
			is_thinking: false,
		});
		if (text[0]?.type === "message_update") {
			expect(text[0].assistantMessageEvent).toMatchObject({
				type: "text_delta",
				contentIndex: 1,
				delta: "answer",
			});
			expect(text[0].assistantMessageEvent.partial.content).toEqual([
				{ type: "thinking", thinking: "ponder…" },
				{ type: "text", text: "answer" },
			]);
		}

		// Thinking does not appear in getPartialAssistantText.
		expect(adapter.getPartialAssistantText()).toBe("answer");
	});

	it("maps tool_call → tool_start → tool_output → tool_end to tool_execution_*", () => {
		const adapter = createNativeHeadlessEventAdapter();

		const call = adapter.handle({
			type: "tool_call",
			call_id: "call_1",
			tool_execution_id: "tex_1",
			tool: "bash",
			args: { command: "ls" },
			requires_approval: false,
		});
		expect(eventTypes(call)).toEqual(["tool_execution_start"]);
		if (call[0]?.type === "tool_execution_start") {
			expect(call[0]).toMatchObject({
				toolCallId: "call_1",
				toolExecutionId: "tex_1",
				toolName: "bash",
				args: { command: "ls" },
			});
		}

		// tool_start is optional/no-op (start already emitted).
		expect(adapter.handle({ type: "tool_start", call_id: "call_1" })).toEqual(
			[],
		);

		const output = adapter.handle({
			type: "tool_output",
			call_id: "call_1",
			content: "README.md\n",
		});
		expect(eventTypes(output)).toEqual(["tool_execution_update"]);
		if (output[0]?.type === "tool_execution_update") {
			expect(output[0].partialResult).toEqual({
				content: [{ type: "text", text: "README.md\n" }],
				toolExecutionId: "tex_1",
			});
		}

		const more = adapter.handle({
			type: "tool_output",
			call_id: "call_1",
			content: "package.json\n",
		});
		if (more[0]?.type === "tool_execution_update") {
			expect(more[0].partialResult.content).toEqual([
				{ type: "text", text: "README.md\npackage.json\n" },
			]);
		}

		const end = adapter.handle({
			type: "tool_end",
			call_id: "call_1",
			tool_execution_id: "tex_1",
			success: true,
			tool: "bash",
		});
		expect(eventTypes(end)).toEqual(["tool_execution_end"]);
		if (end[0]?.type === "tool_execution_end") {
			expect(end[0].isError).toBe(false);
			expect(end[0].result).toMatchObject({
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				isError: false,
				content: [{ type: "text", text: "README.md\npackage.json\n" }],
			});
		}
	});

	it("passthrough raw_agent_event when event looks like AgentEvent", () => {
		const adapter = createNativeHeadlessEventAdapter();
		const raw: AgentEvent = {
			type: "status",
			status: "from-native",
			details: { source: "raw" },
		};

		const events = adapter.handle({
			type: "raw_agent_event",
			event_type: "status",
			event: raw,
		});
		expect(events).toEqual([raw]);
		// Same reference passthrough (no clone required for pure bridge).
		expect(events[0]).toBe(raw);
	});

	it("drops raw_agent_event when payload is not an AgentEvent-shaped object", () => {
		const adapter = createNativeHeadlessEventAdapter();
		const events = adapter.handle({
			type: "raw_agent_event",
			// Intentionally malformed for the adapter guard.
			event_type: "status",
			event: "not-an-event" as unknown as AgentEvent,
		});
		expect(events).toEqual([]);
	});

	it("maps fatal error to error + agent_end aborted", () => {
		const adapter = createNativeHeadlessEventAdapter();
		adapter.handle({ type: "response_start", response_id: "resp_err" });
		adapter.handle({
			type: "response_chunk",
			response_id: "resp_err",
			content: "partial",
			is_thinking: false,
		});

		const events = adapter.handle({
			type: "error",
			message: "native runtime crashed",
			fatal: true,
			error_type: "fatal",
		});
		expect(eventTypes(events)).toEqual(["error", "agent_end"]);
		if (events[0]?.type === "error") {
			expect(events[0].message).toBe("native runtime crashed");
		}
		if (events[1]?.type === "agent_end") {
			expect(events[1].aborted).toBe(true);
			expect(events[1].stopReason).toBe("error");
			expect(events[1].messages).toHaveLength(1);
			expect(events[1].partialAccepted).toBeDefined();
		}
	});

	it("maps non-fatal error without agent_end", () => {
		const adapter = createNativeHeadlessEventAdapter();
		const events = adapter.handle({
			type: "error",
			message: "transient blip",
			fatal: false,
			error_type: "transient",
		});
		expect(events).toEqual([{ type: "error", message: "transient blip" }]);
	});

	it("maps ready once and session_info / status as status events", () => {
		const adapter = createNativeHeadlessEventAdapter();

		const ready1 = adapter.handle({
			type: "ready",
			protocol_version: "2026-04-02",
			model: "claude-test",
			provider: "anthropic",
			session_id: "sess_1",
		});
		expect(ready1).toEqual([
			{
				type: "status",
				status: "ready",
				details: {
					model: "claude-test",
					provider: "anthropic",
					session_id: "sess_1",
					protocol_version: "2026-04-02",
					executor_type: undefined,
				},
			},
		]);

		// Second ready is suppressed (don't spam).
		expect(
			adapter.handle({
				type: "ready",
				protocol_version: "2026-04-02",
				model: "claude-test",
				provider: "anthropic",
				session_id: "sess_1",
			}),
		).toEqual([]);

		const session = adapter.handle({
			type: "session_info",
			session_id: "sess_1",
			cwd: "/tmp/ws",
			git_branch: "main",
		});
		expect(session).toEqual([
			{
				type: "status",
				status: "session_info",
				details: {
					session_id: "sess_1",
					cwd: "/tmp/ws",
					git_branch: "main",
				},
			},
		]);

		const status = adapter.handle({
			type: "status",
			message: "working…",
		});
		expect(status).toEqual([
			{ type: "status", status: "working…", details: {} },
		]);
	});

	it("maps approval server_request to action_approval_required", () => {
		const adapter = createNativeHeadlessEventAdapter();
		const events = adapter.handle({
			type: "server_request",
			request_id: "req_1",
			request_type: "approval",
			call_id: "call_a",
			tool_execution_id: "tex_a",
			tool: "bash",
			display_name: "Shell",
			args: { command: "rm -rf /" },
			reason: "Destructive command",
			started_at_ms: 100,
		});
		expect(eventTypes(events)).toEqual(["action_approval_required"]);
		if (events[0]?.type === "action_approval_required") {
			expect(events[0].request).toMatchObject({
				id: "req_1",
				toolName: "bash",
				displayName: "Shell",
				reason: "Destructive command",
				args: { command: "rm -rf /" },
				startedAtMs: 100,
				platform: {
					source: "tool_execution",
					toolExecutionId: "tex_a",
				},
			});
		}
	});

	it("maps client_tool_request headless message", () => {
		const adapter = createNativeHeadlessEventAdapter();
		const events = adapter.handle({
			type: "client_tool_request",
			call_id: "ct_1",
			tool: "browser_click",
			args: { selector: "#go" },
		});
		expect(events).toEqual([
			{
				type: "client_tool_request",
				toolCallId: "ct_1",
				toolName: "browser_click",
				args: { selector: "#go" },
			},
		]);
	});

	it("sets stopReason toolUse when response_end reports tools", () => {
		const adapter = createNativeHeadlessEventAdapter();
		adapter.handle({ type: "response_start", response_id: "resp_tools" });
		adapter.handle({
			type: "response_chunk",
			response_id: "resp_tools",
			content: "done",
			is_thinking: false,
		});
		const end = adapter.handle({
			type: "response_end",
			response_id: "resp_tools",
			usage: emptyUsage(),
			tools_summary: {
				tools_used: ["bash"],
				calls_succeeded: 1,
				calls_failed: 0,
			},
			duration_ms: 10,
		});
		if (end[0]?.type === "message_end" && isAssistant(end[0].message)) {
			expect(end[0].message.stopReason).toBe("toolUse");
		}
		if (end[2]?.type === "agent_end") {
			expect(end[2].stopReason).toBe("toolUse");
		}
	});

	it("reset clears partial text and allows a fresh response cycle", () => {
		const adapter = createNativeHeadlessEventAdapter({
			modelId: "m1",
			provider: "p1",
		});
		adapter.handle({ type: "response_start", response_id: "r1" });
		adapter.handle({
			type: "response_chunk",
			response_id: "r1",
			content: "hi",
			is_thinking: false,
		});
		expect(adapter.getPartialAssistantText()).toBe("hi");

		adapter.reset();
		expect(adapter.getPartialAssistantText()).toBe("");

		const start = adapter.handle({
			type: "response_start",
			response_id: "r2",
		});
		// agent_start again after reset.
		expect(eventTypes(start)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
		]);
	});

	it.each([
		{
			name: "utility_command_started is ignored for chat bridge MVP",
			message: {
				type: "utility_command_started",
				command_id: "cmd_1",
				command: "echo hi",
				shell_mode: "shell",
				terminal_mode: "pipe",
			} satisfies HeadlessFromAgentMessage,
		},
		{
			name: "utility_file_watch_event is ignored for chat bridge MVP",
			message: {
				type: "utility_file_watch_event",
				watch_id: "w1",
				change_type: "modify",
				path: "/tmp/a",
				relative_path: "a",
				timestamp: 1,
				is_directory: false,
			} satisfies HeadlessFromAgentMessage,
		},
	])("$name", ({ message }) => {
		const adapter = createNativeHeadlessEventAdapter();
		expect(adapter.handle(message)).toEqual([]);
	});
});
