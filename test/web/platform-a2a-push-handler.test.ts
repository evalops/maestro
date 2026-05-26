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
		createAgent: vi.fn(),
		createBackgroundAgent: vi.fn(),
		getRegisteredModel: vi.fn(),
		getCurrentSelection: () => ({ provider: "openai", modelId: "gpt-5.4" }),
		ensureCredential: vi.fn(),
		setModelSelection: vi.fn(),
		acquireSse: vi.fn(),
		releaseSse: vi.fn(),
		headlessRuntimeService: {} as WebServerContext["headlessRuntimeService"],
	};
}

describe("handlePlatformA2APushCallback", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
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
			state: "TASK_STATE_COMPLETED",
			final: true,
			runtimeEventId: "event_1",
		});
		expect(ctx.hostedRunner?.lastPlatformA2APush).toMatchObject({
			kind: "statusUpdate",
			taskId: "run_1",
			workspaceId: "ws_hosted",
			organizationId: "org_1",
			state: "TASK_STATE_COMPLETED",
			runtimeEventType: "RUNTIME_EVENT_TYPE_RUN_SUCCEEDED",
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
					"x-workspace-id": "ws_hosted",
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
