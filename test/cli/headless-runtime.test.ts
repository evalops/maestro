import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionApprovalService } from "../../src/agent/action-approval.js";
import type { AgentEvent } from "../../src/agent/types.js";
import { HEADLESS_PROTOCOL_VERSION } from "../../src/cli/headless-protocol.js";
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

	it("returns an explicit hello_ok handshake acknowledgement", async () => {
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

		const helloOk = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(
				(line) => JSON.parse(line) as { type: string; [key: string]: unknown },
			)
			.find((message) => message.type === "hello_ok");
		expect(helloOk).toMatchObject({
			type: "hello_ok",
			protocol_version: HEADLESS_PROTOCOL_VERSION,
			opt_out_notifications: ["status", "heartbeat"],
		});
	});

	it("emits raw_agent_event payloads for opted-in clients before transport suppression", async () => {
		let onLine: LineHandler | undefined;
		let onClose: CloseHandler | undefined;
		let agentListener: ((event: AgentEvent) => void) | undefined;
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
				subscribe: vi.fn((listener) => {
					agentListener = listener;
					return () => {};
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
			expect(onLine).toBeTypeOf("function");
			expect(onClose).toBeTypeOf("function");
			expect(agentListener).toBeTypeOf("function");
		});

		await onLine?.(
			JSON.stringify({
				type: "hello",
				protocol_version: "1.0",
				client_info: { name: "maestro-test", version: "0.1.0" },
				capabilities: {
					raw_agent_events: true,
				},
				role: "controller",
			}),
		);

		agentListener?.({
			type: "action_approval_required",
			request: {
				id: "approval_1",
				toolName: "bash",
				args: { command: "rm -rf /tmp/example" },
				reason: "Dangerous command",
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
				(line) =>
					JSON.parse(line) as {
						type: string;
						event_type?: string;
						event?: { type?: string };
					},
			);

		expect(
			messages.find((message) => message.type === "raw_agent_event"),
		).toMatchObject({
			type: "raw_agent_event",
			event_type: "action_approval_required",
			event: {
				type: "action_approval_required",
			},
		});
		expect(messages.some((message) => message.type === "server_request")).toBe(
			false,
		);
	});

	it("suppresses opted-out local notification messages after hello", async () => {
		let onLine: LineHandler | undefined;
		let onClose: CloseHandler | undefined;
		let agentEventHandler:
			| ((event: { type: string; [key: string]: unknown }) => void)
			| undefined;
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
				subscribe: vi.fn((handler) => {
					agentEventHandler = handler as typeof agentEventHandler;
				}),
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
			expect(agentEventHandler).toBeTypeOf("function");
		});

		await onLine?.(
			JSON.stringify({
				type: "hello",
				protocol_version: "1.0",
				client_info: { name: "maestro-test", version: "0.1.0" },
				opt_out_notifications: ["status", "compaction", "connection_info"],
				role: "controller",
			}),
		);

		agentEventHandler?.({
			type: "status",
			status: "Thinking hard",
			details: {},
		});
		agentEventHandler?.({
			type: "compaction",
			summary: "Compacted context",
			firstKeptEntryIndex: 4,
			tokensBefore: 2048,
			timestamp: "2026-04-02T00:00:00.000Z",
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
			messages.filter((message) => message.type === "hello_ok"),
		).toHaveLength(1);
		expect(
			messages.filter((message) => message.type === "connection_info"),
		).toHaveLength(0);
		expect(messages.some((message) => message.type === "status")).toBe(false);
		expect(messages.some((message) => message.type === "compaction")).toBe(
			false,
		);
	});

	it("assigns the local connection as owner for utility resources", async () => {
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
					utility_operations: ["command_exec", "file_watch"],
				},
				role: "controller",
			}),
		);
		await onLine?.(
			JSON.stringify({
				type: "utility_command_start",
				command_id: "cmd_local_owner",
				command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => {}, 1000)")}`,
				shell_mode: "direct",
			}),
		);
		await onLine?.(
			JSON.stringify({
				type: "utility_file_watch_start",
				watch_id: "watch_local_owner",
				root_dir: process.cwd(),
			}),
		);

		await vi.waitFor(() => {
			const messages = writes
				.join("")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as { type: string; [key: string]: unknown },
				);
			expect(messages).toContainEqual(
				expect.objectContaining({
					type: "utility_command_started",
					command_id: "cmd_local_owner",
					owner_connection_id: "local",
				}),
			);
			expect(messages).toContainEqual(
				expect.objectContaining({
					type: "utility_file_watch_started",
					watch_id: "watch_local_owner",
					owner_connection_id: "local",
				}),
			);
		});

		await onLine?.(
			JSON.stringify({
				type: "utility_command_terminate",
				command_id: "cmd_local_owner",
			}),
		);
		await onLine?.(
			JSON.stringify({
				type: "utility_file_watch_stop",
				watch_id: "watch_local_owner",
			}),
		);
		onClose?.();
		await runPromise;
	});

	it("returns utility file read results for the local connection", async () => {
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

		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-read-"));
		try {
			await writeFile(join(tempDir, "notes.txt"), "one\ntwo\nthree\nfour\n");

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
						utility_operations: ["file_read"],
					},
					role: "controller",
				}),
			);
			await onLine?.(
				JSON.stringify({
					type: "utility_file_read",
					read_id: "read_local",
					path: "notes.txt",
					cwd: tempDir,
					offset: 2,
					limit: 2,
				}),
			);

			await vi.waitFor(() => {
				const messages = writes
					.join("")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map(
						(line) =>
							JSON.parse(line) as { type: string; [key: string]: unknown },
					);
				expect(messages).toContainEqual(
					expect.objectContaining({
						type: "utility_file_read_result",
						read_id: "read_local",
						relative_path: "notes.txt",
						cwd: tempDir,
						content: "two\nthree",
						start_line: 2,
						end_line: 3,
						total_lines: 4,
						truncated: true,
					}),
				);
			});

			onClose?.();
			await runPromise;
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves the file read request id on local read errors", async () => {
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

		const tempDir = await mkdtemp(join(tmpdir(), "maestro-headless-read-"));
		try {
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
						utility_operations: ["file_read"],
					},
					role: "controller",
				}),
			);
			await onLine?.(
				JSON.stringify({
					type: "utility_file_read",
					read_id: "read_missing",
					path: "missing.txt",
					cwd: tempDir,
				}),
			);

			await vi.waitFor(() => {
				const messages = writes
					.join("")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map(
						(line) =>
							JSON.parse(line) as {
								type: string;
								request_id?: string;
								message?: string;
							},
					);
				expect(messages).toContainEqual(
					expect.objectContaining({
						type: "error",
						request_id: "read_missing",
						message: expect.stringContaining("missing.txt"),
					}),
				);
			});

			onClose?.();
			await runPromise;
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
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

	it("rejects viewer interrupt requests before aborting the local session", async () => {
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
		const abort = vi.fn();

		const runPromise = runHeadlessMode(
			{
				state: { model: { id: "gpt-5.4", provider: "openai" } },
				subscribe: vi.fn(),
				prompt: vi.fn(),
				abort,
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
				role: "viewer",
			}),
		);
		await onLine?.(JSON.stringify({ type: "interrupt" }));
		onClose?.();
		await runPromise;

		expect(abort).not.toHaveBeenCalled();

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; message?: string });
		expect(messages).toContainEqual({
			type: "error",
			message: "Viewer headless connections cannot send messages",
			fatal: false,
			error_type: "protocol",
		});
	});

	it("rejects viewer user_input capability negotiation during hello", async () => {
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
				capabilities: { server_requests: ["user_input"] },
				role: "viewer",
			}),
		);
		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; message?: string });
		expect(messages).toContainEqual({
			type: "error",
			message:
				"viewer headless connections cannot negotiate user_input requests",
			fatal: false,
			error_type: "protocol",
		});
		expect(messages.some((message) => message.type === "hello_ok")).toBe(false);
	});

	it("rejects viewer tool_retry capability negotiation during hello", async () => {
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
				capabilities: { server_requests: ["tool_retry"] },
				role: "viewer",
			}),
		);
		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; message?: string });
		expect(messages).toContainEqual({
			type: "error",
			message:
				"viewer headless connections cannot negotiate tool_retry requests",
			fatal: false,
			error_type: "protocol",
		});
		expect(messages.some((message) => message.type === "hello_ok")).toBe(false);
	});

	it("rejects viewer hello renegotiation that adds user_input requests", async () => {
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
				capabilities: { server_requests: ["approval"] },
				role: "viewer",
			}),
		);
		await onLine?.(
			JSON.stringify({
				type: "hello",
				protocol_version: "1.1",
				client_info: { name: "maestro-test", version: "0.2.0" },
				capabilities: { server_requests: ["user_input"] },
			}),
		);
		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; message?: string });
		expect(messages).toContainEqual({
			type: "error",
			message:
				"viewer headless connections cannot negotiate user_input requests",
			fatal: false,
			error_type: "protocol",
		});
		expect(
			messages.filter((message) => message.type === "hello_ok"),
		).toHaveLength(1);
	});

	it("rejects viewer hello renegotiation that adds tool_retry requests", async () => {
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
				capabilities: { server_requests: ["approval"] },
				role: "viewer",
			}),
		);
		await onLine?.(
			JSON.stringify({
				type: "hello",
				protocol_version: "1.1",
				client_info: { name: "maestro-test", version: "0.2.0" },
				capabilities: { server_requests: ["tool_retry"] },
			}),
		);
		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; message?: string });
		expect(messages).toContainEqual({
			type: "error",
			message:
				"viewer headless connections cannot negotiate tool_retry requests",
			fatal: false,
			error_type: "protocol",
		});
		expect(
			messages.filter((message) => message.type === "hello_ok"),
		).toHaveLength(1);
	});

	it("rejects hello renegotiation that changes the existing connection role", async () => {
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
				capabilities: { server_requests: ["approval"] },
				role: "viewer",
			}),
		);
		await onLine?.(
			JSON.stringify({
				type: "hello",
				protocol_version: "1.1",
				client_info: { name: "maestro-test", version: "0.2.0" },
				capabilities: { server_requests: ["approval", "user_input"] },
				role: "controller",
			}),
		);
		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; message?: string });
		expect(messages).toContainEqual({
			type: "error",
			message: "headless connection role cannot change after hello",
			fatal: false,
			error_type: "protocol",
		});
		expect(
			messages.filter((message) => message.type === "hello_ok"),
		).toHaveLength(1);
	});

	it("echoes the effective viewer role when a follow-up hello omits role", async () => {
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
				capabilities: { server_requests: ["approval"] },
				role: "viewer",
			}),
		);
		await onLine?.(
			JSON.stringify({
				type: "hello",
				protocol_version: "1.1",
				client_info: { name: "maestro-test", version: "0.2.0" },
				capabilities: { server_requests: ["approval"] },
			}),
		);
		onClose?.();
		await runPromise;

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const helloOkMessages = messages.filter(
			(message) => message.type === "hello_ok",
		);
		const connectionInfoMessages = messages.filter(
			(message) => message.type === "connection_info",
		);

		expect(helloOkMessages).toHaveLength(2);
		expect(helloOkMessages.at(-1)).toMatchObject({
			type: "hello_ok",
			role: "viewer",
			controller_connection_id: null,
			client_protocol_version: "1.1",
			client_info: { name: "maestro-test", version: "0.2.0" },
		});
		expect(connectionInfoMessages).toHaveLength(2);
		expect(connectionInfoMessages.at(-1)).toMatchObject({
			type: "connection_info",
			role: "viewer",
			controller_connection_id: null,
			client_protocol_version: "1.1",
			client_info: { name: "maestro-test", version: "0.2.0" },
		});
	});

	it("rejects viewer prompt requests before sending them to the local agent", async () => {
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
		const prompt = vi.fn();

		const runPromise = runHeadlessMode(
			{
				state: { model: { id: "gpt-5.4", provider: "openai" } },
				subscribe: vi.fn(),
				prompt,
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
				role: "viewer",
			}),
		);
		await onLine?.(
			JSON.stringify({
				type: "prompt",
				content: "viewer should not send prompts",
			}),
		);
		onClose?.();
		await runPromise;

		expect(prompt).not.toHaveBeenCalled();

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; message?: string });
		expect(messages).toContainEqual({
			type: "error",
			message: "Viewer headless connections cannot send messages",
			fatal: false,
			error_type: "protocol",
		});
	});

	it("rejects viewer shutdown requests before terminating the local runtime", async () => {
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
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);

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
				role: "viewer",
			}),
		);
		await onLine?.(JSON.stringify({ type: "shutdown" }));
		onClose?.();
		await runPromise;

		expect(exit).not.toHaveBeenCalled();

		const messages = writes
			.join("")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; message?: string });
		expect(messages).toContainEqual({
			type: "error",
			message: "Viewer headless connections cannot send messages",
			fatal: false,
			error_type: "protocol",
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

	it("routes tool retry prompts through generic server request responses", async () => {
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
		const { ServerRequestToolRetryService } = await import(
			"../../src/server/tool-retry-service.js"
		);
		const toolRetryService = new ServerRequestToolRetryService(
			"prompt",
			() => "session-headless-test",
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
			undefined,
			toolRetryService,
		);

		await vi.waitFor(() => {
			expect(onLine).toBeTypeOf("function");
			expect(onClose).toBeTypeOf("function");
		});

		await onLine?.(
			JSON.stringify({
				type: "hello",
				capabilities: { server_requests: ["tool_retry"] },
				role: "controller",
			}),
		);

		const decisionPromise = toolRetryService.requestDecision({
			id: "retry_1",
			toolCallId: "call_bash",
			toolName: "bash",
			args: { command: "ls" },
			errorMessage: "Command failed",
			attempt: 1,
			summary: "Retry bash command",
		});

		await vi.waitFor(() => {
			const messages = writes
				.join("")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as { type: string; [key: string]: unknown },
				);
			expect(messages).toContainEqual({
				type: "server_request",
				request_id: "retry_1",
				request_type: "tool_retry",
				call_id: "call_bash",
				tool: "bash",
				args: {
					tool_call_id: "call_bash",
					args: { command: "ls" },
					error_message: "Command failed",
					attempt: 1,
					summary: "Retry bash command",
				},
				reason: "Retry bash command",
			});
		});

		await onLine?.(
			JSON.stringify({
				type: "server_request_response",
				request_id: "retry_1",
				request_type: "tool_retry",
				decision_action: "retry",
				reason: "Try again",
			}),
		);

		await expect(decisionPromise).resolves.toEqual({
			action: "retry",
			reason: "Try again",
			resolvedBy: "user",
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
		expect(messages).toContainEqual({
			type: "server_request_resolved",
			request_id: "retry_1",
			request_type: "tool_retry",
			call_id: "call_bash",
			resolution: "retried",
			reason: "Try again",
			resolved_by: "user",
		});
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
