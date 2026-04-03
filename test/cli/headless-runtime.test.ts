import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionApprovalService } from "../../src/agent/action-approval.js";
import { getHeadlessPtyPythonCommand } from "../../src/headless/pty-helper.js";
import { serverRequestManager } from "../../src/server/server-request-manager.js";

type LineHandler = (line: string) => void | Promise<void>;
type CloseHandler = () => void;

const supportsPty =
	process.platform !== "win32" &&
	(() => {
		try {
			getHeadlessPtyPythonCommand();
			return true;
		} catch {
			return false;
		}
	})();

describe("runHeadlessMode", () => {
	afterEach(() => {
		for (const request of serverRequestManager.listPending()) {
			serverRequestManager.cancel(request.id, "test cleanup");
		}
		vi.restoreAllMocks();
		vi.resetModules();
		vi.doUnmock("node:readline");
		vi.doUnmock("@evalops/contracts");
	});

	it("falls back to a protocol error when outgoing message validation fails", async () => {
		let onClose: CloseHandler | undefined;
		const readlineInterface = {
			on(event: string, handler: LineHandler | CloseHandler) {
				if (event === "close") {
					onClose = handler as CloseHandler;
				}
				return this;
			},
		};

		vi.doMock("node:readline", () => ({
			createInterface: () => readlineInterface,
		}));
		vi.doMock("@evalops/contracts", async () => {
			const actual =
				await vi.importActual<typeof import("@evalops/contracts")>(
					"@evalops/contracts",
				);
			return {
				...actual,
				assertHeadlessFromAgentMessage: vi.fn(() => {
					throw new Error("schema drift");
				}),
			};
		});

		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		const { runHeadlessMode } = await import("../../src/cli/headless.ts");

		const runPromise = runHeadlessMode(
			{
				state: { model: { id: "gpt-5.4", provider: "openai" } },
				subscribe: vi.fn(),
				prompt: vi.fn(),
				abort: vi.fn(),
			} as never,
			{
				getSessionId: () => "session-headless-test",
			} as never,
		);

		await vi.waitFor(() => {
			expect(onClose).toBeTypeOf("function");
			expect(writes.length).toBeGreaterThan(0);
		});

		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; message?: string });
		expect(messages[0]).toMatchObject({
			type: "error",
			message: "Failed to emit headless message: schema drift",
			fatal: false,
			error_type: "protocol",
		});
	});

	it("reports utility command runtime errors without parse prefixes", async () => {
		let onLine: LineHandler | undefined;
		let onClose: CloseHandler | undefined;
		const readlineInterface = {
			on(event: string, handler: LineHandler | CloseHandler) {
				if (event === "line") {
					onLine = handler as LineHandler;
				}
				if (event === "close") {
					onClose = handler as CloseHandler;
				}
				return this;
			},
		};

		vi.doMock("node:readline", () => ({
			createInterface: () => readlineInterface,
		}));

		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		const { runHeadlessMode } = await import("../../src/cli/headless.ts");

		const runPromise = runHeadlessMode(
			{
				state: { model: { id: "gpt-5.4", provider: "openai" } },
				subscribe: vi.fn(),
				prompt: vi.fn(),
				abort: vi.fn(),
			} as never,
			{
				getSessionId: () => "session-headless-test",
			} as never,
		);

		await vi.waitFor(() => {
			expect(onLine).toBeTypeOf("function");
			expect(onClose).toBeTypeOf("function");
		});

		await onLine?.(
			JSON.stringify({
				type: "hello",
				protocol_version: "1.0",
				client_info: { name: "maestro-test", version: "0.1.0" },
				capabilities: {
					utility_operations: ["command_exec"],
				},
				role: "controller",
			}),
		);
		await onLine?.(
			JSON.stringify({
				type: "utility_command_stdin",
				command_id: "missing-command",
				content: "hello",
			}),
		);
		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						message?: string;
						error_type?: string;
					},
			);
		const error = messages.find((message) => message.type === "error");

		expect(error).toMatchObject({
			type: "error",
			message: "Utility command not found: missing-command",
			error_type: "tool",
		});
		expect(
			messages.some(
				(message) =>
					message.type === "error" &&
					message.message?.includes("Failed to parse command:"),
			),
		).toBe(false);
	});

	it("echoes negotiated opt-out notifications in hello connection info", async () => {
		let onLine: LineHandler | undefined;
		let onClose: CloseHandler | undefined;
		const readlineInterface = {
			on(event: string, handler: LineHandler | CloseHandler) {
				if (event === "line") {
					onLine = handler as LineHandler;
				}
				if (event === "close") {
					onClose = handler as CloseHandler;
				}
				return this;
			},
		};

		vi.doMock("node:readline", () => ({
			createInterface: () => readlineInterface,
		}));

		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		const { runHeadlessMode } = await import("../../src/cli/headless.ts");

		const runPromise = runHeadlessMode(
			{
				state: { model: { id: "gpt-5.4", provider: "openai" } },
				subscribe: vi.fn(),
				prompt: vi.fn(),
				abort: vi.fn(),
			} as never,
			{
				getSessionId: () => "session-headless-test",
			} as never,
		);

		await vi.waitFor(() => {
			expect(onLine).toBeTypeOf("function");
			expect(onClose).toBeTypeOf("function");
		});

		await onLine?.(
			JSON.stringify({
				type: "hello",
				protocol_version: "1.0",
				client_info: { name: "maestro-test", version: "0.1.0" },
				opt_out_notifications: ["status", "heartbeat"],
				capabilities: {
					utility_operations: ["command_exec"],
				},
				role: "controller",
			}),
		);
		onClose?.();
		await runPromise;

		const connectionInfo = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(
				(line) => JSON.parse(line) as { type: string; [key: string]: unknown },
			)
			.find((message) => message.type === "connection_info");
		expect(connectionInfo).toMatchObject({
			type: "connection_info",
			opt_out_notifications: ["status", "heartbeat"],
		});
	});

	it("rejects unknown headless command types at the protocol boundary", async () => {
		let onLine: LineHandler | undefined;
		let onClose: CloseHandler | undefined;
		const readlineInterface = {
			on(event: string, handler: LineHandler | CloseHandler) {
				if (event === "line") {
					onLine = handler as LineHandler;
				}
				if (event === "close") {
					onClose = handler as CloseHandler;
				}
				return this;
			},
		};

		vi.doMock("node:readline", () => ({
			createInterface: () => readlineInterface,
		}));

		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		const { runHeadlessMode } = await import("../../src/cli/headless.ts");

		const runPromise = runHeadlessMode(
			{
				state: { model: { id: "gpt-5.4", provider: "openai" } },
				subscribe: vi.fn(),
				prompt: vi.fn(),
				abort: vi.fn(),
			} as never,
			{
				getSessionId: () => "session-headless-test",
			} as never,
		);

		await vi.waitFor(() => {
			expect(onLine).toBeTypeOf("function");
			expect(onClose).toBeTypeOf("function");
		});

		await onLine?.(JSON.stringify({ type: "totally_unknown_command" }));
		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						message?: string;
					},
			);
		expect(messages).toContainEqual({
			type: "error",
			message: "Failed to parse command: Unknown headless command type",
			fatal: false,
			error_type: "protocol",
		});
	});

	it("rejects malformed known headless commands at the protocol boundary", async () => {
		let onLine: LineHandler | undefined;
		let onClose: CloseHandler | undefined;
		const readlineInterface = {
			on(event: string, handler: LineHandler | CloseHandler) {
				if (event === "line") {
					onLine = handler as LineHandler;
				}
				if (event === "close") {
					onClose = handler as CloseHandler;
				}
				return this;
			},
		};

		vi.doMock("node:readline", () => ({
			createInterface: () => readlineInterface,
		}));

		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		const { runHeadlessMode } = await import("../../src/cli/headless.ts");

		const runPromise = runHeadlessMode(
			{
				state: { model: { id: "gpt-5.4", provider: "openai" } },
				subscribe: vi.fn(),
				prompt: vi.fn(),
				abort: vi.fn(),
			} as never,
			{
				getSessionId: () => "session-headless-test",
			} as never,
		);

		await vi.waitFor(() => {
			expect(onLine).toBeTypeOf("function");
			expect(onClose).toBeTypeOf("function");
		});

		await onLine?.(
			JSON.stringify({
				type: "prompt",
				content: "hello",
				unexpected: true,
			}),
		);
		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						message?: string;
					},
			);
		expect(messages).toContainEqual({
			type: "error",
			message:
				"Failed to parse command: Invalid headless command: /unexpected Unexpected property",
			fatal: false,
			error_type: "protocol",
		});
	});

	it("cancels the underlying pending approval when interrupted", async () => {
		let onLine: LineHandler | undefined;
		let onClose: CloseHandler | undefined;
		let onAgentEvent: ((event: unknown) => void) | undefined;
		const readlineInterface = {
			on(event: string, handler: LineHandler | CloseHandler) {
				if (event === "line") {
					onLine = handler as LineHandler;
				}
				if (event === "close") {
					onClose = handler as CloseHandler;
				}
				return this;
			},
		};

		vi.doMock("node:readline", () => ({
			createInterface: () => readlineInterface,
		}));

		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		const { runHeadlessMode } = await import("../../src/cli/headless.ts");
		const approvalService = new ActionApprovalService("prompt");

		const runPromise = runHeadlessMode(
			{
				state: { model: { id: "gpt-5.4", provider: "openai" } },
				subscribe: vi.fn((handler: (event: unknown) => void) => {
					onAgentEvent = handler;
				}),
				prompt: vi.fn(),
				abort: vi.fn(),
			} as never,
			{
				getSessionId: () => "session-headless-test",
			} as never,
			approvalService,
		);

		await vi.waitFor(() => {
			expect(onLine).toBeTypeOf("function");
			expect(onClose).toBeTypeOf("function");
			expect(onAgentEvent).toBeTypeOf("function");
		});

		const request = {
			id: "call_approval",
			toolName: "bash",
			args: { command: "rm -rf dist" },
			reason: "Dangerous command",
		};
		const approvalPromise = approvalService.requestApproval(request);
		onAgentEvent?.({
			type: "action_approval_required",
			request,
		});

		expect(approvalService.getPendingRequests()).toHaveLength(1);

		await onLine?.(JSON.stringify({ type: "interrupt" }));

		await vi.waitFor(() => {
			expect(approvalService.getPendingRequests()).toHaveLength(0);
		});
		await expect(approvalPromise).resolves.toMatchObject({
			approved: false,
			reason: "Interrupted before request completed",
			resolvedBy: "policy",
		});

		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.map(
				(line) => JSON.parse(line) as { type: string; [key: string]: unknown },
			);
		expect(messages).toContainEqual({
			type: "server_request_resolved",
			request_id: "call_approval",
			request_type: "approval",
			call_id: "call_approval",
			resolution: "cancelled",
			reason: "Interrupted before request completed",
			resolved_by: "runtime",
		});
	});

	it("emits a single generic server_request for approval events", async () => {
		let onClose: CloseHandler | undefined;
		let onAgentEvent: ((event: unknown) => void) | undefined;
		const readlineInterface = {
			on(event: string, handler: LineHandler | CloseHandler) {
				if (event === "close") {
					onClose = handler as CloseHandler;
				}
				return this;
			},
		};

		vi.doMock("node:readline", () => ({
			createInterface: () => readlineInterface,
		}));

		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		const { runHeadlessMode } = await import("../../src/cli/headless.ts");
		const approvalService = {
			requiresUserInteraction: () => true,
			resolve: vi.fn(() => true),
		} as unknown as ActionApprovalService;

		const runPromise = runHeadlessMode(
			{
				state: { model: { id: "gpt-5.4", provider: "openai" } },
				subscribe: vi.fn((handler: (event: unknown) => void) => {
					onAgentEvent = handler;
				}),
				prompt: vi.fn(),
				abort: vi.fn(),
			} as never,
			{
				getSessionId: () => "session-headless-test",
			} as never,
			approvalService,
		);

		await vi.waitFor(() => {
			expect(onClose).toBeTypeOf("function");
			expect(onAgentEvent).toBeTypeOf("function");
		});

		onAgentEvent?.({
			type: "action_approval_required",
			request: {
				id: "call_approval",
				toolName: "bash",
				args: { command: "rm -rf dist" },
				reason: "Dangerous command",
			},
		});

		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.map(
				(line) => JSON.parse(line) as { type: string; [key: string]: unknown },
			);
		const requests = messages.filter(
			(message) =>
				message.type === "server_request" &&
				message.request_id === "call_approval",
		);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			type: "server_request",
			request_id: "call_approval",
			request_type: "approval",
			call_id: "call_approval",
			tool: "bash",
		});
		const toolCallIndex = messages.findIndex(
			(message) =>
				message.type === "tool_call" && message.call_id === "call_approval",
		);
		const requestIndex = messages.findIndex(
			(message) =>
				message.type === "server_request" &&
				message.request_id === "call_approval",
		);
		expect(toolCallIndex).toBeGreaterThanOrEqual(0);
		expect(requestIndex).toBeGreaterThan(toolCallIndex);
	});

	it("suppresses approval-only output in auto approval mode", async () => {
		let onClose: CloseHandler | undefined;
		let onAgentEvent: ((event: unknown) => void) | undefined;
		const readlineInterface = {
			on(event: string, handler: LineHandler | CloseHandler) {
				if (event === "close") {
					onClose = handler as CloseHandler;
				}
				return this;
			},
		};

		vi.doMock("node:readline", () => ({
			createInterface: () => readlineInterface,
		}));

		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		const { runHeadlessMode } = await import("../../src/cli/headless.ts");

		const runPromise = runHeadlessMode(
			{
				state: { model: { id: "gpt-5.4", provider: "openai" } },
				subscribe: vi.fn((handler: (event: unknown) => void) => {
					onAgentEvent = handler;
				}),
				prompt: vi.fn(),
				abort: vi.fn(),
			} as never,
			{
				getSessionId: () => "session-headless-test",
			} as never,
			new ActionApprovalService("auto"),
		);

		await vi.waitFor(() => {
			expect(onClose).toBeTypeOf("function");
			expect(onAgentEvent).toBeTypeOf("function");
		});

		onAgentEvent?.({
			type: "action_approval_required",
			request: {
				id: "call_auto_approval",
				toolName: "bash",
				args: { command: "git push --force" },
				reason: "Force push requires approval",
			},
		});

		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(
				(line) => JSON.parse(line) as { type: string; [key: string]: unknown },
			);
		expect(
			messages.find(
				(message) =>
					message.type === "tool_call" &&
					message.call_id === "call_auto_approval",
			),
		).toBeUndefined();
		expect(
			messages.find(
				(message) =>
					message.type === "server_request" &&
					message.request_id === "call_auto_approval",
			),
		).toBeUndefined();
	});

	it("filters unrelated session server requests from local headless output", async () => {
		let onClose: CloseHandler | undefined;
		const readlineInterface = {
			on(event: string, handler: LineHandler | CloseHandler) {
				if (event === "close") {
					onClose = handler as CloseHandler;
				}
				return this;
			},
		};

		vi.doMock("node:readline", () => ({
			createInterface: () => readlineInterface,
		}));

		const writes: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write);

		const { runHeadlessMode } = await import("../../src/cli/headless.ts");
		const { serverRequestManager: runtimeServerRequestManager } = await import(
			"../../src/server/server-request-manager.js"
		);

		const runPromise = runHeadlessMode(
			{
				state: { model: { id: "gpt-5.4", provider: "openai" } },
				subscribe: vi.fn(),
				prompt: vi.fn(),
				abort: vi.fn(),
			} as never,
			{
				getSessionId: () => "session-headless-test",
			} as never,
		);

		await vi.waitFor(() => {
			expect(onClose).toBeTypeOf("function");
		});

		runtimeServerRequestManager.registerClientTool({
			id: "other-session-request",
			sessionId: "session-other",
			toolName: "ask_user",
			args: { prompt: "Other" },
			kind: "user_input",
			resolve: () => true,
			cancel: () => true,
		});
		runtimeServerRequestManager.registerClientTool({
			id: "current-session-request",
			sessionId: "session-headless-test",
			toolName: "ask_user",
			args: { prompt: "Current" },
			kind: "user_input",
			resolve: () => true,
			cancel: () => true,
		});

		await vi.waitFor(() => {
			const requestIds = writes
				.join("")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as { type: string; [key: string]: unknown },
				)
				.filter((message) => message.type === "server_request")
				.map((message) => message.request_id);
			expect(requestIds).toContain("current-session-request");
		});

		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.map(
				(line) => JSON.parse(line) as { type: string; [key: string]: unknown },
			);
		const requestIds = messages
			.filter((message) => message.type === "server_request")
			.map((message) => message.request_id);

		expect(requestIds).toContain("current-session-request");
		expect(requestIds).not.toContain("other-session-request");
	});

	it.skipIf(!supportsPty)(
		"supports PTY utility command resize through the local headless protocol",
		async () => {
			let onLine: LineHandler | undefined;
			let onClose: CloseHandler | undefined;
			const readlineInterface = {
				on(event: string, handler: LineHandler | CloseHandler) {
					if (event === "line") {
						onLine = handler as LineHandler;
					}
					if (event === "close") {
						onClose = handler as CloseHandler;
					}
					return this;
				},
			};

			vi.doMock("node:readline", () => ({
				createInterface: () => readlineInterface,
			}));

			const writes: string[] = [];
			vi.spyOn(process.stdout, "write").mockImplementation(((
				chunk: unknown,
			) => {
				writes.push(String(chunk));
				return true;
			}) as typeof process.stdout.write);

			const { runHeadlessMode } = await import("../../src/cli/headless.ts");

			const runPromise = runHeadlessMode(
				{
					state: { model: { id: "gpt-5.4", provider: "openai" } },
					subscribe: vi.fn(),
					prompt: vi.fn(),
					abort: vi.fn(),
				} as never,
				{
					getSessionId: () => "session-headless-test",
				} as never,
			);

			await vi.waitFor(() => {
				expect(onLine).toBeTypeOf("function");
				expect(onClose).toBeTypeOf("function");
			});

			await onLine?.(
				JSON.stringify({
					type: "hello",
					protocol_version: "1.0",
					client_info: { name: "maestro-test", version: "0.1.0" },
					capabilities: {
						utility_operations: ["command_exec"],
					},
					role: "controller",
				}),
			);
			await onLine?.(
				JSON.stringify({
					type: "utility_command_start",
					command_id: "cmd_pty",
					command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
					shell_mode: "direct",
					terminal_mode: "pty",
					columns: 90,
					rows: 30,
				}),
			);
			await onLine?.(
				JSON.stringify({
					type: "utility_command_resize",
					command_id: "cmd_pty",
					columns: 120,
					rows: 40,
				}),
			);
			await vi.waitFor(() => {
				expect(writes.join("")).toContain('"type":"utility_command_resized"');
			});
			await onLine?.(
				JSON.stringify({
					type: "utility_command_terminate",
					command_id: "cmd_pty",
				}),
			);
			await vi.waitFor(() => {
				expect(writes.join("")).toContain('"type":"utility_command_exited"');
			});
			onClose?.();
			await runPromise;

			const messages = writes
				.join("")
				.trim()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as { type: string; [key: string]: unknown },
				);

			expect(messages).toContainEqual(
				expect.objectContaining({
					type: "utility_command_started",
					command_id: "cmd_pty",
					terminal_mode: "pty",
					columns: 90,
					rows: 30,
				}),
			);
			expect(messages).toContainEqual({
				type: "utility_command_resized",
				command_id: "cmd_pty",
				columns: 120,
				rows: 40,
			});
		},
	);
});
