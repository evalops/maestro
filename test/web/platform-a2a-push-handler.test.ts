import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebServerContext } from "../../src/server/app-context.js";
import {
	PLATFORM_A2A_PUSH_CALLBACK_PATH,
	handlePlatformA2APushCallback,
	platformA2APushAuthBoundaryExemptPaths,
} from "../../src/server/handlers/platform-a2a-push.js";

class MockResponse extends EventEmitter {
	body = "";
	headers: Record<string, string | number> = {};
	statusCode = 200;
	headersSent = false;
	writableEnded = false;
	req?: IncomingMessage;

	writeHead(statusCode: number, headers: Record<string, string | number>) {
		this.statusCode = statusCode;
		this.headers = { ...this.headers, ...headers };
		this.headersSent = true;
		return this;
	}

	write(chunk: string | Buffer) {
		this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk;
		return true;
	}

	end(chunk?: string | Buffer) {
		if (chunk) {
			this.write(chunk);
		}
		this.writableEnded = true;
		return this;
	}
}

function jsonRequest(
	body: unknown,
	headers: Record<string, string> = {},
): IncomingMessage {
	let sent = false;
	const raw = Buffer.from(JSON.stringify(body), "utf8");
	const req = new Readable({
		read() {
			if (sent) {
				return;
			}
			sent = true;
			this.push(raw);
			this.push(null);
		},
	}) as IncomingMessage;
	Object.assign(req, {
		method: "POST",
		url: "/api/platform/a2a/push",
		headers: {
			host: "localhost",
			"content-type": "application/a2a+json",
			"content-length": String(raw.length),
			...headers,
		},
	});
	return req;
}

function context(): WebServerContext {
	return {
		corsHeaders: {},
		staticMaxAge: 0,
		defaultApprovalMode: "prompt",
		defaultProvider: "openai",
		defaultModelId: "gpt-5.4",
		hostedRunner: {
			enabled: true,
			runnerSessionId: "runner_1",
			workspaceRoot: process.cwd(),
			workspaceId: "ws_hosted",
			a2aTaskId: "run_1",
		},
		getRegisteredModel: vi.fn(),
		getCurrentSelection: () => ({ provider: "openai", modelId: "gpt-5.4" }),
		ensureCredential: vi.fn(),
		setModelSelection: vi.fn(),
		acquireSse: vi.fn(),
		releaseSse: vi.fn(),
		headlessRuntimeService: {} as WebServerContext["headlessRuntimeService"],
	};
}

function workspaceNotificationToken(
	secret: string,
	workspaceId: string,
): string {
	return `workspace-v1.${createHmac("sha256", secret)
		.update(workspaceId)
		.digest("base64url")
		.replace(/=+$/, "")}`;
}

describe("handlePlatformA2APushCallback", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("accepts a workspace-scoped HMAC notification token derived from the shared secret", async () => {
		const sharedSecret = "callback-secret";
		const workspaceId = "ws_hosted";
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", sharedSecret);
		const derived = workspaceNotificationToken(sharedSecret, workspaceId);

		const ctx = context();
		const res = new MockResponse();
		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					statusUpdate: {
						taskId: "run_1",
						contextId: "ctx_1",
						final: true,
						status: { state: "TASK_STATE_COMPLETED" },
						metadata: {
							messageId: "message_1",
							workspaceId,
							organizationId: "org_1",
						},
					},
				},
				{
					"x-a2a-notification-token": derived,
					"x-evalops-workspace-id": workspaceId,
				},
			),
			res as unknown as ServerResponse,
			ctx,
		);
		expect(res.statusCode).toBe(202);
	});

	it("prefers the evalops workspace header for workspace-scoped tokens", async () => {
		const sharedSecret = "callback-secret";
		const workspaceId = "ws_hosted";
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", sharedSecret);
		const derived = workspaceNotificationToken(sharedSecret, workspaceId);

		const ctx = context();
		const res = new MockResponse();
		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					statusUpdate: {
						taskId: "run_1",
						status: { state: "TASK_STATE_COMPLETED" },
						metadata: { workspaceId },
					},
				},
				{
					"x-a2a-notification-token": derived,
					"x-workspace-id": "ws_other",
					"x-evalops-workspace-id": workspaceId,
				},
			),
			res as unknown as ServerResponse,
			ctx,
		);

		expect(res.statusCode).toBe(202);
	});

	it("rejects a workspace-scoped HMAC notification token when the payload workspace differs from the header workspace", async () => {
		const sharedSecret = "callback-secret";
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", sharedSecret);
		const derived = workspaceNotificationToken(sharedSecret, "ws_hosted");
		const ctx = context();
		const res = new MockResponse();

		await expect(() =>
			handlePlatformA2APushCallback(
				jsonRequest(
					{
						statusUpdate: {
							taskId: "run_1",
							contextId: "ctx_1",
							final: true,
							status: { state: "TASK_STATE_COMPLETED" },
							metadata: {
								messageId: "message_1",
								workspaceId: "ws_other",
								organizationId: "org_1",
							},
						},
					},
					{
						"x-a2a-notification-token": derived,
						"x-evalops-workspace-id": "ws_hosted",
					},
				),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toThrow("Invalid A2A notification token");
		expect(ctx.hostedRunner?.lastPlatformA2APush).toBeUndefined();
	});

	it("rejects a callback when the notification token matches neither the raw secret nor the workspace HMAC", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-secret");
		const ctx = context();
		const res = new MockResponse();
		await expect(() =>
			handlePlatformA2APushCallback(
				jsonRequest(
					{
						statusUpdate: {
							taskId: "run_1",
							contextId: "ctx_1",
							final: true,
							status: { state: "TASK_STATE_COMPLETED" },
							metadata: {
								messageId: "message_1",
								workspaceId: "ws_hosted",
								organizationId: "org_1",
							},
						},
					},
					{
						"x-a2a-notification-token": "workspace-v1.not-a-real-mac",
						"x-evalops-workspace-id": "ws_hosted",
					},
				),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toThrow("Invalid A2A notification token");
	});

	it("only exempts the callback route from auth middleware when a callback token is configured", () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "");
		vi.stubEnv("MAESTRO_A2A_CALLBACK_TOKEN", "");
		expect(platformA2APushAuthBoundaryExemptPaths()).toEqual([]);

		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		expect(platformA2APushAuthBoundaryExemptPaths()).toEqual([
			PLATFORM_A2A_PUSH_CALLBACK_PATH,
		]);
	});

	it("accepts status updates and records the hosted runner projection", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		const res = new MockResponse();

		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					statusUpdate: {
						taskId: "run_1",
						contextId: "ctx_1",
						final: true,
						status: { state: "TASK_STATE_COMPLETED" },
						metadata: {
							messageId: "message_1",
							workspaceId: "ws_hosted",
							organizationId: "org_1",
							runtimeEventId: "event_1",
							runtimeEventType: "RUNTIME_EVENT_TYPE_RUN_SUCCEEDED",
						},
					},
				},
				{ "x-a2a-notification-token": "callback-token" },
			),
			res as unknown as ServerResponse,
			ctx,
		);

		expect(res.statusCode).toBe(202);
		expect(JSON.parse(res.body)).toMatchObject({
			accepted: true,
			kind: "statusUpdate",
			taskId: "run_1",
			messageId: "message_1",
			messageIds: ["message_1"],
			state: "TASK_STATE_COMPLETED",
			final: true,
			runtimeEventId: "event_1",
		});
		expect(ctx.hostedRunner?.lastPlatformA2APush).toMatchObject({
			kind: "statusUpdate",
			taskId: "run_1",
			messageId: "message_1",
			messageIds: ["message_1"],
			workspaceId: "ws_hosted",
			organizationId: "org_1",
			state: "TASK_STATE_COMPLETED",
			runtimeEventType: "RUNTIME_EVENT_TYPE_RUN_SUCCEEDED",
		});
	});

	it("accepts message updates only for the hosted runner A2A message", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.a2aMessageId = "message_1";
		}
		const res = new MockResponse();

		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					message: {
						id: "message_1",
						taskId: "run_1",
						contextId: "ctx_1",
						metadata: {
							workspaceId: "ws_hosted",
							organizationId: "org_1",
						},
					},
				},
				{ "x-a2a-notification-token": "callback-token" },
			),
			res as unknown as ServerResponse,
			ctx,
		);

		expect(res.statusCode).toBe(202);
		expect(JSON.parse(res.body)).toMatchObject({
			accepted: true,
			kind: "message",
			taskId: "run_1",
			messageId: "message_1",
			messageIds: ["message_1"],
		});
		expect(ctx.hostedRunner?.lastPlatformA2APush).toMatchObject({
			kind: "message",
			taskId: "run_1",
			messageId: "message_1",
			messageIds: ["message_1"],
		});
	});

	it("accepts message updates without task ids for the hosted runner A2A message", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.a2aMessageId = "message_1";
		}
		const res = new MockResponse();

		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					message: {
						id: "message_1",
						contextId: "ctx_1",
					},
				},
				{ "x-a2a-notification-token": "callback-token" },
			),
			res as unknown as ServerResponse,
			ctx,
		);

		expect(res.statusCode).toBe(202);
		expect(JSON.parse(res.body)).toMatchObject({
			accepted: true,
			kind: "message",
			messageId: "message_1",
			messageIds: ["message_1"],
			contextId: "ctx_1",
		});
		expect(JSON.parse(res.body).taskId).toBeUndefined();
		expect(ctx.hostedRunner?.lastPlatformA2APush).toMatchObject({
			kind: "message",
			messageId: "message_1",
			messageIds: ["message_1"],
			contextId: "ctx_1",
		});
		expect(ctx.hostedRunner?.lastPlatformA2APush?.taskId).toBeUndefined();
	});

	it("rejects unbound message-only pushes without correlation metadata", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.a2aMessageId = undefined;
		}
		const res = new MockResponse();

		await expect(
			handlePlatformA2APushCallback(
				jsonRequest(
					{
						message: {
							id: "message_misrouted",
							contextId: "ctx_1",
						},
					},
					{
						"x-a2a-notification-token": "callback-token",
						"x-evalops-agent-id": "agent_expected",
					},
				),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toMatchObject({ statusCode: 403 });

		expect(ctx.hostedRunner?.a2aMessageId).toBeUndefined();
		expect(ctx.hostedRunner?.lastPlatformA2APush).toBeUndefined();
	});

	it("binds an unclaimed hosted runner message when workspace metadata matches", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.a2aTaskId = undefined;
			ctx.hostedRunner.a2aMessageId = undefined;
		}
		const res = new MockResponse();

		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					message: {
						id: "message_bound",
						taskId: "run_bound",
						contextId: "ctx_1",
						metadata: {
							workspaceId: "ws_hosted",
						},
					},
				},
				{ "x-a2a-notification-token": "callback-token" },
			),
			res as unknown as ServerResponse,
			ctx,
		);

		expect(res.statusCode).toBe(202);
		expect(ctx.hostedRunner?.a2aTaskId).toBe("run_bound");
		expect(ctx.hostedRunner?.a2aMessageId).toBe("message_bound");
		expect(ctx.hostedRunner?.lastPlatformA2APush).toMatchObject({
			taskId: "run_bound",
			messageId: "message_bound",
			workspaceId: "ws_hosted",
		});
	});

	it("records tenant and trace context from callback headers and payload metadata", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		const res = new MockResponse();

		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					statusUpdate: {
						taskId: "run_1",
						contextId: "ctx_1",
						status: { state: "TASK_STATE_WORKING" },
						metadata: {
							traceparent:
								"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
							organizationId: "org_payload",
							tenant_id: "tenant_payload",
							agentId: "agent_payload",
						},
					},
				},
				{
					"x-a2a-notification-token": "callback-token",
					traceparent:
						"00-11111111111111111111111111111111-2222222222222222-01",
					tracestate: "evalops=push",
					"x-organization-id": "org_header",
					"x-workspace-id": "ws_other",
					"x-evalops-workspace-id": "ws_hosted",
					"x-evalops-actor-id": "actor_header",
				},
			),
			res as unknown as ServerResponse,
			ctx,
		);

		expect(res.statusCode).toBe(202);
		expect(JSON.parse(res.body)).toMatchObject({
			accepted: true,
			kind: "statusUpdate",
			taskId: "run_1",
			traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
			tracestate: "evalops=push",
			organizationId: "org_payload",
			workspaceId: "ws_hosted",
			tenantId: "tenant_payload",
			agentId: "agent_payload",
			actorId: "actor_header",
		});
		expect(ctx.hostedRunner?.lastPlatformA2APush).toMatchObject({
			taskId: "run_1",
			traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
			tracestate: "evalops=push",
			organizationId: "org_payload",
			workspaceId: "ws_hosted",
			tenantId: "tenant_payload",
			agentId: "agent_payload",
			actorId: "actor_header",
		});
	});

	it("rejects callbacks for a different hosted runner agent", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.agentId = "agent_expected";
		}
		const res = new MockResponse();

		await expect(
			handlePlatformA2APushCallback(
				jsonRequest(
					{
						statusUpdate: {
							taskId: "run_1",
							contextId: "ctx_1",
							status: { state: "TASK_STATE_WORKING" },
							metadata: {
								workspaceId: "ws_hosted",
								agentId: "agent_other",
							},
						},
					},
					{ "x-a2a-notification-token": "callback-token" },
				),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toMatchObject({ statusCode: 403 });

		expect(ctx.hostedRunner?.lastPlatformA2APush).toBeUndefined();
	});

	it("rejects callbacks for a different nested hosted runner agent", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.agentId = "agent_expected";
		}
		const res = new MockResponse();

		await expect(
			handlePlatformA2APushCallback(
				jsonRequest(
					{
						statusUpdate: {
							taskId: "run_1",
							contextId: "ctx_1",
							status: {
								state: "TASK_STATE_WORKING",
								message: {
									id: "agent_response_message",
									metadata: {
										agentId: "agent_other",
									},
								},
							},
							metadata: {
								workspaceId: "ws_hosted",
								agentId: "agent_expected",
							},
						},
					},
					{
						"x-a2a-notification-token": "callback-token",
						"x-evalops-agent-id": "agent_expected",
					},
				),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toMatchObject({ statusCode: 403 });

		expect(ctx.hostedRunner?.lastPlatformA2APush).toBeUndefined();
	});

	it("does not reject status pushes for agent response message ids", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.a2aMessageId = "original_user_message";
		}
		const res = new MockResponse();

		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					statusUpdate: {
						taskId: "run_1",
						contextId: "ctx_1",
						status: {
							state: "TASK_STATE_WORKING",
							message: {
								id: "agent_response_message",
								taskId: "run_1",
							},
						},
						metadata: {
							workspaceId: "ws_hosted",
						},
					},
				},
				{ "x-a2a-notification-token": "callback-token" },
			),
			res as unknown as ServerResponse,
			ctx,
		);

		expect(res.statusCode).toBe(202);
		expect(JSON.parse(res.body)).toMatchObject({
			accepted: true,
			kind: "statusUpdate",
			taskId: "run_1",
			state: "TASK_STATE_WORKING",
		});
		expect(JSON.parse(res.body).messageId).toBeUndefined();
		expect(ctx.hostedRunner?.a2aMessageId).toBe("original_user_message");
		expect(ctx.hostedRunner?.lastPlatformA2APush).toMatchObject({
			taskId: "run_1",
			workspaceId: "ws_hosted",
			state: "TASK_STATE_WORKING",
		});
		expect(ctx.hostedRunner?.lastPlatformA2APush?.messageId).toBeUndefined();
	});

	it("does not bind status push message metadata as the runner durable message", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.a2aMessageId = undefined;
		}
		const res = new MockResponse();

		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					statusUpdate: {
						taskId: "run_1",
						contextId: "ctx_1",
						status: { state: "TASK_STATE_WORKING" },
						metadata: {
							messageId: "agent_progress_message",
							workspaceId: "ws_hosted",
						},
					},
				},
				{ "x-a2a-notification-token": "callback-token" },
			),
			res as unknown as ServerResponse,
			ctx,
		);

		expect(res.statusCode).toBe(202);
		expect(ctx.hostedRunner?.a2aMessageId).toBeUndefined();
		expect(ctx.hostedRunner?.lastPlatformA2APush).toMatchObject({
			kind: "statusUpdate",
			taskId: "run_1",
			messageId: "agent_progress_message",
		});
	});

	it("does not reject task snapshots for agent response message ids", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.a2aMessageId = "original_user_message";
		}
		const res = new MockResponse();

		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					task: {
						id: "run_1",
						contextId: "ctx_1",
						status: {
							state: "TASK_STATE_WORKING",
							message: {
								messageId: "agent_response_message",
								taskId: "run_1",
							},
						},
						metadata: {
							workspaceId: "ws_hosted",
						},
					},
				},
				{ "x-a2a-notification-token": "callback-token" },
			),
			res as unknown as ServerResponse,
			ctx,
		);

		expect(res.statusCode).toBe(202);
		expect(JSON.parse(res.body)).toMatchObject({
			accepted: true,
			kind: "task",
			taskId: "run_1",
			state: "TASK_STATE_WORKING",
		});
		expect(JSON.parse(res.body).messageId).toBeUndefined();
		expect(ctx.hostedRunner?.a2aMessageId).toBe("original_user_message");
		expect(ctx.hostedRunner?.lastPlatformA2APush).toMatchObject({
			kind: "task",
			taskId: "run_1",
			state: "TASK_STATE_WORKING",
			workspaceId: "ws_hosted",
		});
		expect(ctx.hostedRunner?.lastPlatformA2APush?.messageId).toBeUndefined();
	});

	it("records snake_case trace metadata aliases", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		const res = new MockResponse();

		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					statusUpdate: {
						taskId: "run_1",
						contextId: "ctx_1",
						status: { state: "TASK_STATE_WORKING" },
						metadata: {
							workspaceId: "ws_hosted",
							trace_parent:
								"00-33333333333333333333333333333333-4444444444444444-01",
							trace_state: "evalops=metadata",
						},
					},
				},
				{ "x-a2a-notification-token": "callback-token" },
			),
			res as unknown as ServerResponse,
			ctx,
		);

		expect(res.statusCode).toBe(202);
		expect(ctx.hostedRunner?.lastPlatformA2APush).toMatchObject({
			taskId: "run_1",
			traceparent: "00-33333333333333333333333333333333-4444444444444444-01",
			tracestate: "evalops=metadata",
		});
	});

	it("binds an unclaimed hosted runner task when workspace metadata matches", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.a2aTaskId = undefined;
		}
		const res = new MockResponse();

		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					statusUpdate: {
						taskId: "run_1",
						contextId: "ctx_1",
						status: { state: "TASK_STATE_WORKING" },
						metadata: {
							workspace_id: "ws_hosted",
						},
					},
				},
				{ "x-a2a-notification-token": "callback-token" },
			),
			res as unknown as ServerResponse,
			ctx,
		);

		expect(res.statusCode).toBe(202);
		expect(ctx.hostedRunner?.a2aTaskId).toBe("run_1");
		expect(ctx.hostedRunner?.lastPlatformA2APush).toMatchObject({
			taskId: "run_1",
			workspaceId: "ws_hosted",
		});
	});

	it("does not treat tenant metadata as a workspace marker", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		const res = new MockResponse();

		await handlePlatformA2APushCallback(
			jsonRequest(
				{
					statusUpdate: {
						taskId: "run_1",
						contextId: "ctx_1",
						status: { state: "TASK_STATE_WORKING" },
						metadata: {
							tenant_id: "org_not_workspace",
						},
					},
				},
				{ "x-a2a-notification-token": "callback-token" },
			),
			res as unknown as ServerResponse,
			ctx,
		);

		expect(res.statusCode).toBe(202);
		expect(ctx.hostedRunner?.lastPlatformA2APush).toMatchObject({
			taskId: "run_1",
			tenantId: "org_not_workspace",
		});
	});

	it("rejects callbacks for a different A2A task", async () => {
		const ctx = context();
		const res = new MockResponse();

		await expect(
			handlePlatformA2APushCallback(
				jsonRequest({ statusUpdate: { taskId: "other_run" } }),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toMatchObject({ statusCode: 404 });
	});

	it("rejects callbacks for a different durable A2A message", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.a2aMessageId = "message_1";
		}
		const res = new MockResponse();

		await expect(
			handlePlatformA2APushCallback(
				jsonRequest(
					{
						message: {
							id: "message_other",
							taskId: "run_1",
							contextId: "ctx_1",
							metadata: {
								workspaceId: "ws_hosted",
							},
						},
					},
					{ "x-a2a-notification-token": "callback-token" },
				),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toMatchObject({ statusCode: 404 });

		expect(ctx.hostedRunner?.lastPlatformA2APush).toBeUndefined();
	});

	it("rejects callbacks whose durable A2A message differs only by case", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.a2aMessageId = "Message_1";
		}
		const res = new MockResponse();

		await expect(
			handlePlatformA2APushCallback(
				jsonRequest(
					{
						message: {
							id: "message_1",
							taskId: "run_1",
							contextId: "ctx_1",
							metadata: {
								workspaceId: "ws_hosted",
							},
						},
					},
					{ "x-a2a-notification-token": "callback-token" },
				),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toMatchObject({ statusCode: 404 });

		expect(ctx.hostedRunner?.lastPlatformA2APush).toBeUndefined();
	});

	it("rejects task snapshots whose durable message list excludes the hosted message", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.a2aMessageId = "message_1";
		}
		const res = new MockResponse();

		await expect(
			handlePlatformA2APushCallback(
				jsonRequest(
					{
						task: {
							id: "run_1",
							contextId: "ctx_1",
							messageIds: ["message_other"],
							metadata: {
								workspaceId: "ws_hosted",
							},
						},
					},
					{ "x-a2a-notification-token": "callback-token" },
				),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toMatchObject({ statusCode: 404 });

		expect(ctx.hostedRunner?.lastPlatformA2APush).toBeUndefined();
	});

	it("rejects callbacks with mismatched workspace metadata", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		const res = new MockResponse();

		await expect(
			handlePlatformA2APushCallback(
				jsonRequest(
					{
						statusUpdate: {
							taskId: "run_1",
							status: { state: "TASK_STATE_WORKING" },
							metadata: {
								workspaceId: "ws_other",
							},
						},
					},
					{ "x-a2a-notification-token": "callback-token" },
				),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toMatchObject({ statusCode: 403 });

		expect(ctx.hostedRunner?.lastPlatformA2APush).toBeUndefined();
	});

	it("rejects mismatched payload workspace even when the request header matches", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		const res = new MockResponse();

		await expect(
			handlePlatformA2APushCallback(
				jsonRequest(
					{
						statusUpdate: {
							taskId: "run_1",
							status: { state: "TASK_STATE_WORKING" },
							metadata: {
								workspaceId: "ws_other",
							},
						},
					},
					{
						"x-a2a-notification-token": "callback-token",
						"x-workspace-id": "ws_hosted",
					},
				),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toMatchObject({ statusCode: 403 });

		expect(ctx.hostedRunner?.lastPlatformA2APush).toBeUndefined();
	});

	it("rejects first unbound callbacks without workspace metadata", async () => {
		vi.stubEnv("MAESTRO_PLATFORM_A2A_CALLBACK_TOKEN", "callback-token");
		const ctx = context();
		if (ctx.hostedRunner) {
			ctx.hostedRunner.a2aTaskId = undefined;
		}
		const res = new MockResponse();

		await expect(
			handlePlatformA2APushCallback(
				jsonRequest(
					{
						statusUpdate: {
							taskId: "run_1",
							status: { state: "TASK_STATE_WORKING" },
							metadata: {
								tenant_id: "org_not_workspace",
							},
						},
					},
					{ "x-a2a-notification-token": "callback-token" },
				),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toMatchObject({ statusCode: 403 });

		expect(ctx.hostedRunner?.a2aTaskId).toBeUndefined();
		expect(ctx.hostedRunner?.lastPlatformA2APush).toBeUndefined();
	});

	it("rejects task updates that omit the task identifier", async () => {
		const ctx = context();
		const res = new MockResponse();

		await expect(
			handlePlatformA2APushCallback(
				jsonRequest({
					statusUpdate: {
						status: { state: "TASK_STATE_WORKING" },
						metadata: {
							runtimeEventId: "event_1",
							runtimeEventType: "RUNTIME_EVENT_TYPE_PROGRESS",
						},
					},
				}),
				res as unknown as ServerResponse,
				ctx,
			),
		).rejects.toMatchObject({ statusCode: 400 });

		expect(ctx.hostedRunner?.lastPlatformA2APush).toBeUndefined();
	});
});
