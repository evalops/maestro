import { describe, expect, it } from "vitest";
import type {
	EvalGateHookInput,
	HookEventType,
	HookInput,
	NotificationHookInput,
	OnErrorHookInput,
	OverflowHookInput,
	PermissionRequestHookInput,
	PostMessageHookInput,
	PostToolUseFailureHookInput,
	PostToolUseHookInput,
	PreCompactHookInput,
	PreMessageHookInput,
	PreToolUseHookInput,
	SessionEndHookInput,
	SessionStartHookInput,
	SubagentStartHookInput,
	SubagentStopHookInput,
	UserPromptSubmitHookInput,
} from "../../src/hooks/types.js";

describe("Hook Types", () => {
	describe("HookEventType", () => {
		it("includes all 16 event types", () => {
			const eventTypes: HookEventType[] = [
				"PreToolUse",
				"PostToolUse",
				"PostToolUseFailure",
				"EvalGate",
				"SessionStart",
				"SessionEnd",
				"SubagentStart",
				"SubagentStop",
				"UserPromptSubmit",
				"Notification",
				"PreCompact",
				"PermissionRequest",
				"Overflow",
				"PreMessage",
				"PostMessage",
				"OnError",
			];

			expect(eventTypes).toHaveLength(16);
		});
	});

	describe("PreToolUseHookInput", () => {
		it("has required fields", () => {
			const input: PreToolUseHookInput = {
				hook_event_name: "PreToolUse",
				cwd: "/home/user/project",
				timestamp: new Date().toISOString(),
				tool_name: "Bash",
				tool_call_id: "call_123",
				tool_input: { command: "ls -la" },
			};

			expect(input.hook_event_name).toBe("PreToolUse");
			expect(input.tool_name).toBe("Bash");
			expect(input.tool_input).toEqual({ command: "ls -la" });
		});

		it("supports optional session_id", () => {
			const input: PreToolUseHookInput = {
				hook_event_name: "PreToolUse",
				cwd: "/tmp",
				timestamp: new Date().toISOString(),
				session_id: "session_456",
				tool_name: "Read",
				tool_call_id: "call_789",
				tool_input: { path: "/etc/passwd" },
			};

			expect(input.session_id).toBe("session_456");
		});

		it("supports optional tool presentation fields", () => {
			const input: PreToolUseHookInput = {
				hook_event_name: "PreToolUse",
				cwd: "/tmp",
				timestamp: new Date().toISOString(),
				tool_name: "Read",
				tool_call_id: "call_789",
				tool_input: { path: "/etc/passwd" },
				tool_display_name: "Read passwd file",
				tool_summary: "Read passwd file",
				tool_action_description: "Reading passwd file",
			};

			expect(input.tool_display_name).toBe("Read passwd file");
			expect(input.tool_summary).toBe("Read passwd file");
			expect(input.tool_action_description).toBe("Reading passwd file");
		});
	});

	describe("PostToolUseHookInput", () => {
		it("includes tool output and error status", () => {
			const input: PostToolUseHookInput = {
				hook_event_name: "PostToolUse",
				cwd: "/home/user",
				timestamp: new Date().toISOString(),
				tool_name: "Bash",
				tool_call_id: "call_123",
				tool_input: { command: "cat file.txt" },
				tool_output: "file contents here",
				is_error: false,
			};

			expect(input.tool_output).toBe("file contents here");
			expect(input.is_error).toBe(false);
		});

		it("handles error output", () => {
			const input: PostToolUseHookInput = {
				hook_event_name: "PostToolUse",
				cwd: "/tmp",
				timestamp: new Date().toISOString(),
				tool_name: "Bash",
				tool_call_id: "call_456",
				tool_input: { command: "cat nonexistent.txt" },
				tool_output: "cat: nonexistent.txt: No such file or directory",
				is_error: true,
			};

			expect(input.is_error).toBe(true);
		});

		it("supports optional tool presentation fields", () => {
			const input: PostToolUseHookInput = {
				hook_event_name: "PostToolUse",
				cwd: "/tmp",
				timestamp: new Date().toISOString(),
				tool_name: "Bash",
				tool_call_id: "call_456",
				tool_input: { command: "cat nonexistent.txt" },
				tool_output: "cat: nonexistent.txt: No such file or directory",
				is_error: true,
				tool_display_name: "Shell command",
				tool_summary: "Ran cat nonexistent.txt",
				tool_action_description: "Running cat nonexistent.txt",
			};

			expect(input.tool_display_name).toBe("Shell command");
			expect(input.tool_summary).toBe("Ran cat nonexistent.txt");
			expect(input.tool_action_description).toBe("Running cat nonexistent.txt");
		});
	});

	describe("OverflowHookInput", () => {
		it("has token count fields", () => {
			const input: OverflowHookInput = {
				hook_event_name: "Overflow",
				cwd: "/home/user/project",
				timestamp: new Date().toISOString(),
				token_count: 150000,
				max_tokens: 100000,
				model: "claude-3-opus",
			};

			expect(input.token_count).toBe(150000);
			expect(input.max_tokens).toBe(100000);
			expect(input.model).toBe("claude-3-opus");
		});

		it("model is optional", () => {
			const input: OverflowHookInput = {
				hook_event_name: "Overflow",
				cwd: "/tmp",
				timestamp: new Date().toISOString(),
				token_count: 200000,
				max_tokens: 128000,
			};

			expect(input.model).toBeUndefined();
		});
	});

	describe("PreMessageHookInput", () => {
		it("includes message and attachments", () => {
			const input: PreMessageHookInput = {
				hook_event_name: "PreMessage",
				cwd: "/home/user",
				timestamp: new Date().toISOString(),
				message: "Please help me with this task",
				attachments: ["/path/to/file.txt"],
				model: "claude-3-sonnet",
			};

			expect(input.message).toBe("Please help me with this task");
			expect(input.attachments).toEqual(["/path/to/file.txt"]);
		});

		it("handles empty attachments", () => {
			const input: PreMessageHookInput = {
				hook_event_name: "PreMessage",
				cwd: "/tmp",
				timestamp: new Date().toISOString(),
				message: "Hello",
				attachments: [],
			};

			expect(input.attachments).toHaveLength(0);
		});
	});

	describe("PostMessageHookInput", () => {
		it("includes response metrics", () => {
			const input: PostMessageHookInput = {
				hook_event_name: "PostMessage",
				cwd: "/home/user",
				timestamp: new Date().toISOString(),
				response: "Here is my detailed response...",
				input_tokens: 1000,
				output_tokens: 500,
				duration_ms: 2500,
				stop_reason: "end_turn",
			};

			expect(input.response).toBe("Here is my detailed response...");
			expect(input.input_tokens).toBe(1000);
			expect(input.output_tokens).toBe(500);
			expect(input.duration_ms).toBe(2500);
			expect(input.stop_reason).toBe("end_turn");
		});

		it("stop_reason is optional", () => {
			const input: PostMessageHookInput = {
				hook_event_name: "PostMessage",
				cwd: "/tmp",
				timestamp: new Date().toISOString(),
				response: "Response",
				input_tokens: 100,
				output_tokens: 50,
				duration_ms: 500,
			};

			expect(input.stop_reason).toBeUndefined();
		});
	});

	describe("OnErrorHookInput", () => {
		it("includes error details", () => {
			const input: OnErrorHookInput = {
				hook_event_name: "OnError",
				cwd: "/home/user",
				timestamp: new Date().toISOString(),
				error: "Connection timeout after 30 seconds",
				error_kind: "NetworkError",
				context: "api_call",
				recoverable: true,
			};

			expect(input.error).toBe("Connection timeout after 30 seconds");
			expect(input.error_kind).toBe("NetworkError");
			expect(input.context).toBe("api_call");
			expect(input.recoverable).toBe(true);
		});

		it("handles non-recoverable errors", () => {
			const input: OnErrorHookInput = {
				hook_event_name: "OnError",
				cwd: "/tmp",
				timestamp: new Date().toISOString(),
				error: "Fatal system error",
				error_kind: "FatalError",
				recoverable: false,
			};

			expect(input.recoverable).toBe(false);
			expect(input.context).toBeUndefined();
		});
	});

	describe("SessionStartHookInput", () => {
		it("includes source", () => {
			const input: SessionStartHookInput = {
				hook_event_name: "SessionStart",
				cwd: "/home/user/project",
				timestamp: new Date().toISOString(),
				session_id: "sess_123",
				source: "cli",
			};

			expect(input.source).toBe("cli");
		});
	});

	describe("SessionEndHookInput", () => {
		it("includes end metrics", () => {
			const input: SessionEndHookInput = {
				hook_event_name: "SessionEnd",
				cwd: "/home/user",
				timestamp: new Date().toISOString(),
				session_id: "sess_123",
				reason: "user_exit",
				duration_ms: 300000,
				turn_count: 10,
			};

			expect(input.reason).toBe("user_exit");
			expect(input.duration_ms).toBe(300000);
			expect(input.turn_count).toBe(10);
		});
	});

	describe("SubagentStartHookInput", () => {
		it("includes subagent details", () => {
			const input: SubagentStartHookInput = {
				hook_event_name: "SubagentStart",
				cwd: "/home/user",
				timestamp: new Date().toISOString(),
				agent_type: "explore",
				prompt: "Find all test files",
				parent_session_id: "parent_123",
			};

			expect(input.agent_type).toBe("explore");
			expect(input.prompt).toBe("Find all test files");
			expect(input.parent_session_id).toBe("parent_123");
		});
	});

	describe("SubagentStopHookInput", () => {
		it("includes completion details", () => {
			const input: SubagentStopHookInput = {
				hook_event_name: "SubagentStop",
				cwd: "/home/user",
				timestamp: new Date().toISOString(),
				agent_type: "explore",
				agent_id: "agent_456",
				success: true,
				duration_ms: 5000,
				turn_count: 3,
				transcript_path: "/path/to/transcript.json",
			};

			expect(input.agent_id).toBe("agent_456");
			expect(input.success).toBe(true);
			expect(input.duration_ms).toBe(5000);
		});
	});

	describe("EvalGateHookInput", () => {
		it("includes tool execution details", () => {
			const input: EvalGateHookInput = {
				hook_event_name: "EvalGate",
				cwd: "/home/user",
				timestamp: new Date().toISOString(),
				tool_name: "Bash",
				tool_call_id: "call_123",
				tool_input: { command: "echo test" },
				tool_output: "test",
				is_error: false,
			};

			expect(input.hook_event_name).toBe("EvalGate");
			expect(input.tool_output).toBe("test");
		});
	});

	describe("PermissionRequestHookInput", () => {
		it("includes permission request details", () => {
			const input: PermissionRequestHookInput = {
				hook_event_name: "PermissionRequest",
				cwd: "/home/user",
				timestamp: new Date().toISOString(),
				tool_name: "Bash",
				tool_call_id: "call_123",
				tool_input: { command: "rm -rf /tmp/test" },
				reason: "Destructive operation",
			};

			expect(input.hook_event_name).toBe("PermissionRequest");
			expect(input.reason).toBe("Destructive operation");
		});
	});

	describe("HookInput union type", () => {
		it("accepts all input types", () => {
			const inputs: HookInput[] = [
				{
					hook_event_name: "PreToolUse",
					cwd: "/tmp",
					timestamp: new Date().toISOString(),
					tool_name: "Bash",
					tool_call_id: "1",
					tool_input: {},
				},
				{
					hook_event_name: "PostToolUse",
					cwd: "/tmp",
					timestamp: new Date().toISOString(),
					tool_name: "Bash",
					tool_call_id: "1",
					tool_input: {},
					tool_output: "",
					is_error: false,
				},
				{
					hook_event_name: "Overflow",
					cwd: "/tmp",
					timestamp: new Date().toISOString(),
					token_count: 100000,
					max_tokens: 80000,
				},
				{
					hook_event_name: "PreMessage",
					cwd: "/tmp",
					timestamp: new Date().toISOString(),
					message: "test",
					attachments: [],
				},
				{
					hook_event_name: "PostMessage",
					cwd: "/tmp",
					timestamp: new Date().toISOString(),
					response: "test",
					input_tokens: 100,
					output_tokens: 50,
					duration_ms: 500,
				},
				{
					hook_event_name: "OnError",
					cwd: "/tmp",
					timestamp: new Date().toISOString(),
					error: "test",
					error_kind: "TestError",
					recoverable: true,
				},
			];

			expect(inputs).toHaveLength(6);
			for (const input of inputs) {
				expect(input.hook_event_name).toBeDefined();
				expect(input.cwd).toBeDefined();
				expect(input.timestamp).toBeDefined();
			}
		});
	});
});
