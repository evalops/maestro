import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { ActionApprovalService } from "../../src/agent/action-approval.js";
import { handleRuntimeAppServerWebSocket } from "../../src/server/handlers/runtime-app-server-ws.js";
import { ServerRequestManager } from "../../src/server/server-request-manager.js";

class FakeSocket extends EventEmitter {
	readyState = 1;
	readonly sent: string[] = [];
	closed = false;

	send(payload: string) {
		this.sent.push(payload);
	}

	close() {
		this.closed = true;
		this.readyState = 3;
	}
}

class ThrowingSocket extends FakeSocket {
	override send(_payload: string) {
		throw new Error("peer disconnected mid-send");
	}
}

describe("runtime app-server WebSocket", () => {
	it("responds to initialize with a typed runtime protocol handshake", async () => {
		const socket = new FakeSocket();
		handleRuntimeAppServerWebSocket(socket as unknown as WebSocket, {
			serverRequestManager: new ServerRequestManager(),
		});

		socket.emit(
			"message",
			JSON.stringify({
				jsonrpc: "2.0",
				id: "init-1",
				method: "runtime.initialize",
				params: { clientInfo: { name: "test-client" }, sessionId: "sess_1" },
			}),
		);
		await Promise.resolve();

		const response = JSON.parse(socket.sent[0] ?? "{}");
		expect(response).toMatchObject({
			jsonrpc: "2.0",
			id: "init-1",
			result: {
				protocolVersion: "runtime-app-server.v1",
				capabilities: {
					chat: false,
					serverRequests: true,
					modelCapabilities: true,
				},
			},
		});
	});

	it("exposes registered model provider capabilities", async () => {
		const socket = new FakeSocket();
		handleRuntimeAppServerWebSocket(socket as unknown as WebSocket, {
			serverRequestManager: new ServerRequestManager(),
		});

		socket.emit(
			"message",
			JSON.stringify({
				jsonrpc: "2.0",
				id: "models-1",
				method: "runtime.model_provider_capabilities.read",
			}),
		);
		await Promise.resolve();

		const response = JSON.parse(socket.sent[0] ?? "{}");
		expect(response).toMatchObject({
			jsonrpc: "2.0",
			id: "models-1",
			result: {
				providers: expect.arrayContaining([
					expect.objectContaining({
						id: "openai-codex",
						models: expect.arrayContaining([
							expect.objectContaining({
								api: "openai-codex-app-server",
								capabilities: expect.objectContaining({
									streaming: true,
									reasoning: true,
								}),
							}),
						]),
					}),
				]),
			},
		});
	});

	it("streams server request lifecycle notifications", async () => {
		const socket = new FakeSocket();
		const manager = new ServerRequestManager();
		const approvalService = new ActionApprovalService("prompt");
		vi.spyOn(approvalService, "resolve").mockReturnValue(true);

		handleRuntimeAppServerWebSocket(socket as unknown as WebSocket, {
			serverRequestManager: manager,
			sessionId: "sess_1",
		});
		socket.emit(
			"message",
			JSON.stringify({
				jsonrpc: "2.0",
				id: "init-1",
				method: "runtime.initialize",
				params: { sessionId: "sess_1" },
			}),
		);
		await Promise.resolve();
		socket.sent.length = 0;

		manager.registerApproval({
			sessionId: "sess_other",
			request: {
				id: "approval_other",
				toolName: "bash",
				args: { command: "cat secret.txt" },
				reason: "Approval required",
			},
			service: approvalService,
		});
		manager.registerApproval({
			sessionId: "sess_1",
			request: {
				id: "approval_1",
				toolName: "bash",
				args: { command: "git status" },
				reason: "Approval required",
			},
			service: approvalService,
		});
		manager.resolveApproval("approval_1", {
			approved: true,
			reason: "ok",
			resolvedBy: "user",
		});

		const notifications = socket.sent.map((payload) => JSON.parse(payload));
		expect(notifications).toEqual([
			expect.objectContaining({
				jsonrpc: "2.0",
				method: "runtime.server_request.registered",
				params: expect.objectContaining({
					type: "registered",
					request: expect.objectContaining({
						id: "approval_1",
						kind: "approval",
						sessionId: "sess_1",
					}),
				}),
			}),
			expect.objectContaining({
				jsonrpc: "2.0",
				method: "runtime.server_request.resolved",
				params: expect.objectContaining({
					resolution: "approved",
					resolvedBy: "user",
				}),
			}),
		]);
	});

	it("does not let disconnect-race send failures escape server request notifications", () => {
		const socket = new ThrowingSocket();
		const manager = new ServerRequestManager();
		const approvalService = new ActionApprovalService("prompt");

		handleRuntimeAppServerWebSocket(socket as unknown as WebSocket, {
			serverRequestManager: manager,
			sessionId: "sess_1",
		});

		expect(() =>
			manager.registerApproval({
				sessionId: "sess_1",
				request: {
					id: "approval_1",
					toolName: "bash",
					args: { command: "git status" },
					reason: "Approval required",
				},
				service: approvalService,
			}),
		).not.toThrow();
	});

	it("replays pending server requests after session initialization", async () => {
		const socket = new FakeSocket();
		const manager = new ServerRequestManager();
		const approvalService = new ActionApprovalService("prompt");

		manager.registerApproval({
			sessionId: "sess_other",
			request: {
				id: "approval_other",
				toolName: "bash",
				args: { command: "cat secret.txt" },
				reason: "Approval required",
			},
			service: approvalService,
		});
		manager.registerApproval({
			sessionId: "sess_1",
			request: {
				id: "approval_pending",
				toolName: "bash",
				args: { command: "git diff" },
				reason: "Approval required",
			},
			service: approvalService,
		});

		handleRuntimeAppServerWebSocket(socket as unknown as WebSocket, {
			serverRequestManager: manager,
		});

		socket.emit(
			"message",
			JSON.stringify({
				jsonrpc: "2.0",
				id: "init-1",
				method: "runtime.initialize",
				params: { sessionId: "sess_1" },
			}),
		);
		await Promise.resolve();

		const notifications = socket.sent.map((payload) => JSON.parse(payload));
		expect(notifications).toEqual([
			expect.objectContaining({
				jsonrpc: "2.0",
				id: "init-1",
			}),
			expect.objectContaining({
				jsonrpc: "2.0",
				method: "runtime.initialized",
			}),
			expect.objectContaining({
				jsonrpc: "2.0",
				method: "runtime.server_request.registered",
				params: expect.objectContaining({
					type: "registered",
					request: expect.objectContaining({
						id: "approval_pending",
						kind: "approval",
						sessionId: "sess_1",
					}),
				}),
			}),
		]);
		expect(
			notifications.some(
				(notification) => notification.params?.request?.id === "approval_other",
			),
		).toBe(false);
	});

	it("delays pre-bound pending request replay until initialization completes", async () => {
		const socket = new FakeSocket();
		const manager = new ServerRequestManager();
		const approvalService = new ActionApprovalService("prompt");

		manager.registerApproval({
			sessionId: "sess_1",
			request: {
				id: "approval_prebound",
				toolName: "bash",
				args: { command: "git status" },
				reason: "Approval required",
			},
			service: approvalService,
		});

		handleRuntimeAppServerWebSocket(socket as unknown as WebSocket, {
			serverRequestManager: manager,
			sessionId: "sess_1",
		});

		expect(socket.sent).toEqual([]);

		socket.emit(
			"message",
			JSON.stringify({
				jsonrpc: "2.0",
				id: "init-1",
				method: "runtime.initialize",
				params: { sessionId: "sess_1" },
			}),
		);
		await Promise.resolve();

		const messages = socket.sent.map((payload) => JSON.parse(payload));
		expect(messages).toEqual([
			expect.objectContaining({
				jsonrpc: "2.0",
				id: "init-1",
			}),
			expect.objectContaining({
				jsonrpc: "2.0",
				method: "runtime.initialized",
			}),
			expect.objectContaining({
				jsonrpc: "2.0",
				method: "runtime.server_request.registered",
				params: expect.objectContaining({
					request: expect.objectContaining({ id: "approval_prebound" }),
				}),
			}),
		]);
	});

	it("rejects session initialization when access validation fails", async () => {
		const socket = new FakeSocket();
		const manager = new ServerRequestManager();
		const approvalService = new ActionApprovalService("prompt");

		manager.registerApproval({
			sessionId: "sess_private",
			request: {
				id: "approval_private",
				toolName: "bash",
				args: { command: "cat secret.txt" },
				reason: "Approval required",
			},
			service: approvalService,
		});

		handleRuntimeAppServerWebSocket(socket as unknown as WebSocket, {
			serverRequestManager: manager,
			validateSessionAccess: (sessionId) => sessionId === "sess_allowed",
		});

		socket.emit(
			"message",
			JSON.stringify({
				jsonrpc: "2.0",
				id: "init-private",
				method: "runtime.initialize",
				params: { sessionId: "sess_private" },
			}),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));

		const messages = socket.sent.map((payload) => JSON.parse(payload));
		expect(messages).toEqual([
			expect.objectContaining({
				jsonrpc: "2.0",
				id: "init-private",
				error: expect.objectContaining({
					code: -32600,
					message: "Runtime app-server session access denied",
				}),
			}),
		]);
	});

	it("returns a JSON-RPC parse error with a null id for malformed frames", async () => {
		const socket = new FakeSocket();
		handleRuntimeAppServerWebSocket(socket as unknown as WebSocket, {
			serverRequestManager: new ServerRequestManager(),
		});

		socket.emit("message", "{");
		await Promise.resolve();

		expect(socket.sent.map((payload) => JSON.parse(payload))).toEqual([
			{
				jsonrpc: "2.0",
				id: null,
				error: {
					code: -32700,
					message: "Parse error",
				},
			},
		]);
	});

	it("returns a JSON-RPC invalid request error with a null id when the request id is invalid", async () => {
		const socket = new FakeSocket();
		handleRuntimeAppServerWebSocket(socket as unknown as WebSocket, {
			serverRequestManager: new ServerRequestManager(),
		});

		socket.emit(
			"message",
			JSON.stringify({
				jsonrpc: "2.0",
				id: null,
				method: "runtime.ping",
			}),
		);
		await Promise.resolve();

		expect(socket.sent.map((payload) => JSON.parse(payload))).toEqual([
			{
				jsonrpc: "2.0",
				id: null,
				error: {
					code: -32600,
					message: "Runtime app-server request id must be a string or number",
				},
			},
		]);
	});

	it("rejects concurrent initialization that races session binding", async () => {
		const socket = new FakeSocket();
		let finishFirstValidation: (() => void) | undefined;

		handleRuntimeAppServerWebSocket(socket as unknown as WebSocket, {
			serverRequestManager: new ServerRequestManager(),
			validateSessionAccess: (sessionId) => {
				if (sessionId !== "sess_a") {
					return true;
				}
				return new Promise<boolean>((resolve) => {
					finishFirstValidation = () => resolve(true);
				});
			},
		});

		socket.emit(
			"message",
			JSON.stringify({
				jsonrpc: "2.0",
				id: "init-a",
				method: "runtime.initialize",
				params: { sessionId: "sess_a" },
			}),
		);
		await Promise.resolve();
		socket.emit(
			"message",
			JSON.stringify({
				jsonrpc: "2.0",
				id: "init-b",
				method: "runtime.initialize",
				params: { sessionId: "sess_b" },
			}),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		finishFirstValidation?.();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const messages = socket.sent.map((payload) => JSON.parse(payload));
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					jsonrpc: "2.0",
					id: "init-a",
					result: expect.objectContaining({
						protocolVersion: "runtime-app-server.v1",
					}),
				}),
				expect.objectContaining({
					jsonrpc: "2.0",
					id: "init-b",
					error: expect.objectContaining({
						code: -32600,
						message:
							"Runtime app-server session binding is already in progress",
					}),
				}),
			]),
		);
	});
});
