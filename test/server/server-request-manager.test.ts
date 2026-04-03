import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionApprovalService } from "../../src/agent/action-approval.js";
import { ToolRetryService } from "../../src/agent/tool-retry.js";
import { ServerRequestManager } from "../../src/server/server-request-manager.js";

describe("ServerRequestManager", () => {
	let manager: ServerRequestManager;

	beforeEach(() => {
		manager = new ServerRequestManager();
	});

	it("resolves approval requests through a shared typed registry", () => {
		const service = new ActionApprovalService("prompt");
		const resolveSpy = vi.spyOn(service, "resolve").mockReturnValue(true);

		manager.registerApproval({
			sessionId: "sess_approval",
			request: {
				id: "approval_1",
				toolName: "bash",
				args: { command: "git push --force" },
				reason: "Force push requires approval",
			},
			service,
		});

		expect(manager.listPending({ sessionId: "sess_approval" })).toEqual([
			expect.objectContaining({
				id: "approval_1",
				kind: "approval",
				toolName: "bash",
			}),
		]);

		expect(
			manager.resolveApproval("approval_1", {
				approved: false,
				reason: "Denied by user",
				resolvedBy: "user",
			}),
		).toBe(true);
		expect(resolveSpy).toHaveBeenCalledWith("approval_1", {
			approved: false,
			reason: "Denied by user",
			resolvedBy: "user",
		});
		expect(manager.get("approval_1")).toBeUndefined();
	});

	it("resolves client tool requests through the same registry", () => {
		const resolve = vi.fn().mockReturnValue(true);
		const cancel = vi.fn().mockReturnValue(true);

		manager.registerClientTool({
			id: "client_tool_1",
			sessionId: "sess_client",
			toolName: "artifacts",
			args: { command: "create", filename: "report.txt" },
			resolve,
			cancel,
		});

		expect(manager.resolveClientTool("client_tool_1", [], false)).toBe(true);
		expect(resolve).toHaveBeenCalledWith([], false);
		expect(cancel).not.toHaveBeenCalled();
		expect(manager.get("client_tool_1")).toBeUndefined();
	});

	it("cancels all pending requests for a session", () => {
		const service = new ActionApprovalService("prompt");
		const resolveApproval = vi.spyOn(service, "resolve").mockReturnValue(true);
		const cancelClientTool = vi.fn().mockReturnValue(true);

		manager.registerApproval({
			sessionId: "sess_shared",
			request: {
				id: "approval_2",
				toolName: "bash",
				args: { command: "rm -rf dist" },
				reason: "Dangerous command",
			},
			service,
		});
		manager.registerClientTool({
			id: "client_tool_2",
			sessionId: "sess_shared",
			toolName: "artifacts",
			args: { command: "create", filename: "report.txt" },
			resolve: vi.fn().mockReturnValue(true),
			cancel: cancelClientTool,
		});

		expect(
			manager.cancelBySession(
				"sess_shared",
				"Interrupted before request completed",
			),
		).toBe(2);
		expect(resolveApproval).toHaveBeenCalledWith("approval_2", {
			approved: false,
			reason: "Interrupted before request completed",
			resolvedBy: "policy",
		});
		expect(cancelClientTool).toHaveBeenCalledWith(
			"Interrupted before request completed",
		);
		expect(manager.listPending({ sessionId: "sess_shared" })).toEqual([]);
	});

	it("resolves timed out requests during cleanup", () => {
		const service = new ActionApprovalService("prompt");
		const resolveApproval = vi.spyOn(service, "resolve").mockReturnValue(true);
		const cancelClientTool = vi.fn().mockReturnValue(true);

		manager.registerApproval({
			request: {
				id: "approval_timeout",
				toolName: "bash",
				args: { command: "git push --force" },
				reason: "Force push requires approval",
			},
			service,
			timeoutMs: 1,
		});
		manager.registerClientTool({
			id: "client_tool_timeout",
			toolName: "artifacts",
			args: { command: "create", filename: "report.txt" },
			timeoutMs: 1,
			resolve: vi.fn().mockReturnValue(true),
			cancel: cancelClientTool,
		});

		manager.cleanup(Date.now() + 5);

		expect(resolveApproval).toHaveBeenCalledWith("approval_timeout", {
			approved: false,
			reason: "Approval request timed out",
			resolvedBy: "policy",
		});
		expect(cancelClientTool).toHaveBeenCalledWith(
			"Client tool execution timed out after 60 seconds. The VS Code extension may not be responding.",
		);
	});

	it("emits lifecycle events for request registration and resolution", () => {
		const service = new ActionApprovalService("prompt");
		vi.spyOn(service, "resolve").mockReturnValue(true);
		const listener = vi.fn();
		manager.subscribe(listener);

		manager.registerApproval({
			sessionId: "sess_events",
			request: {
				id: "approval_events",
				toolName: "bash",
				args: { command: "git push --force" },
				reason: "Force push requires approval",
			},
			service,
		});
		manager.resolveApproval("approval_events", {
			approved: true,
			reason: "Approved",
			resolvedBy: "user",
		});

		expect(listener).toHaveBeenNthCalledWith(1, {
			type: "registered",
			request: expect.objectContaining({
				id: "approval_events",
				kind: "approval",
				sessionId: "sess_events",
			}),
		});
		expect(listener).toHaveBeenNthCalledWith(2, {
			type: "resolved",
			request: expect.objectContaining({
				id: "approval_events",
				kind: "approval",
			}),
			resolution: "approved",
			reason: "Approved",
			resolvedBy: "user",
		});
	});

	it("emits timeout-style failed events for client tools during cleanup", () => {
		const resolve = vi.fn().mockReturnValue(true);
		const cancel = vi.fn().mockReturnValue(true);
		const listener = vi.fn();
		manager.subscribe(listener);

		manager.registerClientTool({
			id: "client_tool_events",
			sessionId: "sess_events",
			toolName: "artifacts",
			args: { command: "create", filename: "report.txt" },
			timeoutMs: 1,
			resolve,
			cancel,
		});
		manager.cleanup(Date.now() + 5);

		expect(listener).toHaveBeenNthCalledWith(1, {
			type: "registered",
			request: expect.objectContaining({
				id: "client_tool_events",
				kind: "client_tool",
				sessionId: "sess_events",
			}),
		});
		expect(listener).toHaveBeenNthCalledWith(2, {
			type: "resolved",
			request: expect.objectContaining({
				id: "client_tool_events",
				kind: "client_tool",
			}),
			resolution: "failed",
			reason:
				"Client tool execution timed out after 60 seconds. The VS Code extension may not be responding.",
			resolvedBy: "policy",
		});
	});

	it("emits user input lifecycle events as a distinct request kind", () => {
		const resolve = vi.fn().mockReturnValue(true);
		const cancel = vi.fn().mockReturnValue(true);
		const listener = vi.fn();
		manager.subscribe(listener);

		manager.registerClientTool({
			id: "user_input_1",
			sessionId: "sess_user_input",
			toolName: "ask_user",
			args: {
				questions: [
					{
						header: "Library",
						question: "Which library should we use?",
						options: [
							{ label: "Zod", description: "Use Zod schemas" },
							{ label: "Valibot", description: "Use Valibot schemas" },
						],
					},
				],
			},
			kind: "user_input",
			resolve,
			cancel,
		});
		manager.resolveClientTool(
			"user_input_1",
			[{ type: "text", text: "Zod" }],
			false,
		);

		expect(listener).toHaveBeenNthCalledWith(1, {
			type: "registered",
			request: expect.objectContaining({
				id: "user_input_1",
				kind: "user_input",
				sessionId: "sess_user_input",
			}),
		});
		expect(listener).toHaveBeenNthCalledWith(2, {
			type: "resolved",
			request: expect.objectContaining({
				id: "user_input_1",
				kind: "user_input",
			}),
			resolution: "answered",
			reason: undefined,
			resolvedBy: "client",
		});
	});

	it("uses a user-input specific timeout reason during cleanup", () => {
		const resolve = vi.fn().mockReturnValue(true);
		const cancel = vi.fn().mockReturnValue(true);
		const listener = vi.fn();
		manager.subscribe(listener);

		manager.registerClientTool({
			id: "user_input_timeout",
			sessionId: "sess_user_input",
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
			kind: "user_input",
			timeoutMs: 1,
			resolve,
			cancel,
		});

		manager.cleanup(Date.now() + 5);

		expect(cancel).toHaveBeenCalledWith(
			"User input request timed out before the connected client responded.",
		);
		expect(listener).toHaveBeenNthCalledWith(2, {
			type: "resolved",
			request: expect.objectContaining({
				id: "user_input_timeout",
				kind: "user_input",
			}),
			resolution: "failed",
			reason:
				"User input request timed out before the connected client responded.",
			resolvedBy: "policy",
		});
	});

	it("resolves tool retry prompts through the shared registry", () => {
		const service = new ToolRetryService("prompt");
		const retrySpy = vi.spyOn(service, "retry").mockReturnValue(true);
		const listener = vi.fn();
		manager.subscribe(listener);

		manager.registerToolRetry({
			sessionId: "sess_retry",
			request: {
				id: "retry_1",
				toolCallId: "call_bash",
				toolName: "bash",
				args: { command: "ls" },
				errorMessage: "Command failed",
				attempt: 1,
				maxAttempts: 3,
				summary: "Retry bash command",
			},
			service,
		});

		expect(manager.listPending({ sessionId: "sess_retry" })).toEqual([
			expect.objectContaining({
				id: "retry_1",
				kind: "tool_retry",
				callId: "call_bash",
				toolName: "bash",
			}),
		]);

		expect(
			manager.resolveToolRetry("retry_1", {
				action: "retry",
				reason: "Retry once more",
				resolvedBy: "user",
			}),
		).toBe(true);
		expect(retrySpy).toHaveBeenCalledWith("retry_1", "Retry once more");
		expect(listener).toHaveBeenNthCalledWith(1, {
			type: "registered",
			request: expect.objectContaining({
				id: "retry_1",
				kind: "tool_retry",
				sessionId: "sess_retry",
				callId: "call_bash",
			}),
		});
		expect(listener).toHaveBeenNthCalledWith(2, {
			type: "resolved",
			request: expect.objectContaining({
				id: "retry_1",
				kind: "tool_retry",
				callId: "call_bash",
			}),
			resolution: "retried",
			reason: "Retry once more",
			resolvedBy: "user",
		});
	});

	it("uses a tool-retry specific timeout reason during cleanup", () => {
		const service = new ToolRetryService("prompt");
		const abortSpy = vi.spyOn(service, "abort").mockReturnValue(true);
		const listener = vi.fn();
		manager.subscribe(listener);

		manager.registerToolRetry({
			sessionId: "sess_retry",
			request: {
				id: "retry_timeout",
				toolCallId: "call_bash",
				toolName: "bash",
				args: { command: "ls" },
				errorMessage: "Command failed",
				attempt: 1,
			},
			service,
			timeoutMs: 1,
		});

		manager.cleanup(Date.now() + 5);

		expect(abortSpy).toHaveBeenCalledWith(
			"retry_timeout",
			"Tool retry request timed out before a retry decision was provided.",
		);
		expect(listener).toHaveBeenNthCalledWith(2, {
			type: "resolved",
			request: expect.objectContaining({
				id: "retry_timeout",
				kind: "tool_retry",
			}),
			resolution: "cancelled",
			reason:
				"Tool retry request timed out before a retry decision was provided.",
			resolvedBy: "policy",
		});
	});
});
