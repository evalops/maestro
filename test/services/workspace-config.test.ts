import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWorkspaceConfig } from "../../src/server/handlers/workspace-config.js";
import {
	getWorkspaceConfigContext,
	requestContextStorage,
} from "../../src/server/request-context.js";
import {
	type WorkspaceConfig,
	WorkspaceConfigService,
	WorkspaceConfigUnavailableError,
	WorkspaceConfigValidationError,
	createWorkspaceConfigMiddleware,
	evaluateModelPolicy,
	normalizeWorkspaceConfigInput,
	resolveWorkspaceConfigId,
	setWorkspaceConfigServiceForTest,
} from "../../src/services/workspace-config/index.js";

interface MockResponse {
	writableEnded: boolean;
	headersSent: boolean;
	statusCode?: number;
	body?: string;
	writeHead: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
	setHeader: ReturnType<typeof vi.fn>;
}

function createRequest(
	method: string,
	url: string,
	body?: unknown,
	headers: Record<string, string> = {},
): IncomingMessage {
	const payload =
		body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
	const req = Readable.from(payload) as IncomingMessage;
	req.method = method;
	req.url = url;
	req.headers = { host: "localhost", ...headers };
	return req;
}

function createResponse(): MockResponse {
	const res: MockResponse = {
		writableEnded: false,
		headersSent: false,
		writeHead: vi.fn((statusCode: number) => {
			res.statusCode = statusCode;
			res.headersSent = true;
		}),
		end: vi.fn((body?: string) => {
			res.body = body;
			res.writableEnded = true;
		}),
		setHeader: vi.fn(),
	};
	return res;
}

function parseJsonResponse(res: MockResponse): unknown {
	return JSON.parse(res.body ?? "{}");
}

function sampleConfig(): WorkspaceConfig {
	return normalizeWorkspaceConfigInput(
		{
			workspaceId: "workspace-a",
			modelPreferences: {
				defaultModel: "anthropic/claude-sonnet",
				allowedModels: ["anthropic/claude-sonnet"],
				blockedModels: ["openai/gpt-4o"],
			},
			safetyRules: {
				blockedTools: ["bash"],
				requiredSkills: ["audit"],
				fileBoundaries: ["src", "packages"],
				maxTokensPerSession: 120000,
			},
			rateLimits: {
				requestsPerMinute: 60,
				tokensPerMinute: 100000,
			},
		},
		new Date("2026-04-20T12:00:00.000Z"),
	);
}

describe("workspace config", () => {
	afterEach(() => {
		setWorkspaceConfigServiceForTest(null);
		vi.restoreAllMocks();
	});

	it("normalizes workspace config settings", () => {
		const config = normalizeWorkspaceConfigInput({
			workspaceId: " workspace-a ",
			modelPreferences: {
				allowedModels: ["anthropic/claude-sonnet", "anthropic/claude-sonnet"],
				blockedModels: [" openai/gpt-4o "],
			},
			safetyRules: {
				blockedTools: ["bash", " bash "],
				requiredSkills: ["audit"],
				fileBoundaries: ["src"],
				requireApprovals: true,
			},
			rateLimits: {
				requestsPerMinute: 30.9,
			},
		});

		expect(config.workspaceId).toBe("workspace-a");
		expect(config.modelPreferences.allowedModels).toEqual([
			"anthropic/claude-sonnet",
		]);
		expect(config.modelPreferences.blockedModels).toEqual(["openai/gpt-4o"]);
		expect(config.safetyRules.blockedTools).toEqual(["bash"]);
		expect(config.safetyRules.requireApprovals).toBe(true);
		expect(config.rateLimits.requestsPerMinute).toBe(30);
	});

	it("rejects invalid positive integer settings", () => {
		expect(() =>
			normalizeWorkspaceConfigInput({
				workspaceId: "workspace-a",
				rateLimits: { requestsPerMinute: 0 },
			}),
		).toThrow(WorkspaceConfigValidationError);
	});

	it("evaluates allowed and blocked model policies", () => {
		const config = sampleConfig();

		expect(
			evaluateModelPolicy(config, {
				provider: "anthropic",
				modelId: "claude-sonnet",
			}),
		).toBeNull();
		expect(
			evaluateModelPolicy(config, {
				provider: "openai",
				modelId: "gpt-4o",
			}),
		).toMatchObject({ code: "model_blocked" });
		expect(
			evaluateModelPolicy(config, {
				provider: "google",
				modelId: "gemini-pro",
			}),
		).toMatchObject({ code: "model_not_allowed" });
	});

	it("resolves workspace ids from request headers before query params", () => {
		const req = createRequest(
			"GET",
			"/api/workspace-configs?workspace_id=query-workspace",
			undefined,
			{ "x-maestro-workspace-id": "header-workspace" },
		);

		expect(resolveWorkspaceConfigId(req)).toBe("header-workspace");
	});

	it("ignores empty workspace query params when resolving policy context", () => {
		const req = createRequest("GET", "/api/chat?workspace_id=&workspaceId=%20");

		expect(resolveWorkspaceConfigId(req)).toBe(process.cwd());
	});

	it("rejects empty workspace ids before config lookup or deletion", async () => {
		const service = new WorkspaceConfigService(
			() => {
				throw new Error("database should not be touched");
			},
			() => true,
		);

		await expect(service.getConfig(" ")).rejects.toThrow(
			WorkspaceConfigValidationError,
		);
		await expect(service.deleteConfig("")).rejects.toThrow(
			WorkspaceConfigValidationError,
		);
	});

	it("creates workspace configs through the REST handler", async () => {
		const config = sampleConfig();
		const upsertConfig = vi.fn().mockResolvedValue(config);
		setWorkspaceConfigServiceForTest({
			isConfigured: () => true,
			upsertConfig,
			getConfig: vi.fn(),
			listConfigs: vi.fn(),
			patchConfig: vi.fn(),
			deleteConfig: vi.fn(),
		} as unknown as WorkspaceConfigService);

		const req = createRequest("POST", "/api/workspace-configs", {
			workspaceId: "workspace-a",
			modelPreferences: { allowedModels: ["anthropic/claude-sonnet"] },
		});
		const res = createResponse();

		await handleWorkspaceConfig(req, res as unknown as ServerResponse, {});

		expect(upsertConfig).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceId: "workspace-a" }),
		);
		expect(res.statusCode).toBe(201);
		expect(parseJsonResponse(res)).toEqual({ config });
	});

	it("lists workspace configs through the REST handler", async () => {
		const config = sampleConfig();
		const listConfigs = vi.fn().mockResolvedValue({
			configs: [config],
			pagination: { limit: 1, offset: 0, hasMore: true, nextOffset: 1 },
		});
		setWorkspaceConfigServiceForTest({
			isConfigured: () => true,
			upsertConfig: vi.fn(),
			getConfig: vi.fn(),
			listConfigs,
			patchConfig: vi.fn(),
			deleteConfig: vi.fn(),
		} as unknown as WorkspaceConfigService);

		const req = createRequest("GET", "/api/workspace-configs?limit=1");
		const res = createResponse();

		await handleWorkspaceConfig(req, res as unknown as ServerResponse, {});

		expect(listConfigs).toHaveBeenCalledWith({ limit: 1, offset: 0 });
		expect(res.statusCode).toBe(200);
		expect(parseJsonResponse(res)).toEqual({
			configs: [config],
			pagination: { limit: 1, offset: 0, hasMore: true, nextOffset: 1 },
		});
	});

	it("updates and deletes workspace configs by id", async () => {
		const config = sampleConfig();
		const patchConfig = vi.fn().mockResolvedValue(config);
		const deleteConfig = vi.fn().mockResolvedValue(true);
		setWorkspaceConfigServiceForTest({
			isConfigured: () => true,
			upsertConfig: vi.fn(),
			getConfig: vi.fn(),
			listConfigs: vi.fn(),
			patchConfig,
			deleteConfig,
		} as unknown as WorkspaceConfigService);

		const updateReq = createRequest(
			"PUT",
			"/api/workspace-configs/workspace-a",
			{
				safetyRules: { blockedTools: ["bash"] },
			},
		);
		const updateRes = createResponse();
		await handleWorkspaceConfig(
			updateReq,
			updateRes as unknown as ServerResponse,
			{},
			{ workspaceId: "workspace-a" },
		);

		expect(patchConfig).toHaveBeenCalledWith(
			"workspace-a",
			expect.objectContaining({ safetyRules: { blockedTools: ["bash"] } }),
		);
		expect(updateRes.statusCode).toBe(200);

		const deleteReq = createRequest(
			"DELETE",
			"/api/workspace-configs/workspace-a",
		);
		const deleteRes = createResponse();
		await handleWorkspaceConfig(
			deleteReq,
			deleteRes as unknown as ServerResponse,
			{},
			{ workspaceId: "workspace-a" },
		);

		expect(deleteConfig).toHaveBeenCalledWith("workspace-a");
		expect(deleteRes.statusCode).toBe(200);
		expect(parseJsonResponse(deleteRes)).toEqual({
			deleted: true,
			workspaceId: "workspace-a",
		});
	});

	it("returns unavailable when workspace config storage is not configured", async () => {
		setWorkspaceConfigServiceForTest({
			isConfigured: () => false,
			upsertConfig: vi
				.fn()
				.mockRejectedValue(new WorkspaceConfigUnavailableError()),
			getConfig: vi.fn(),
			listConfigs: vi.fn(),
			patchConfig: vi.fn(),
			deleteConfig: vi.fn(),
		} as unknown as WorkspaceConfigService);

		const req = createRequest("POST", "/api/workspace-configs", {
			workspaceId: "workspace-a",
		});
		const res = createResponse();

		await handleWorkspaceConfig(req, res as unknown as ServerResponse, {});

		expect(res.statusCode).toBe(503);
		expect(parseJsonResponse(res)).toEqual({
			error: "Workspace config database is not configured.",
		});
	});

	it("loads workspace config into request context middleware", async () => {
		const config = sampleConfig();
		const getConfig = vi.fn().mockResolvedValue(config);
		setWorkspaceConfigServiceForTest({
			isConfigured: () => true,
			upsertConfig: vi.fn(),
			getConfig,
			listConfigs: vi.fn(),
			patchConfig: vi.fn(),
			deleteConfig: vi.fn(),
		} as unknown as WorkspaceConfigService);

		const req = createRequest("GET", "/api/chat", undefined, {
			"x-maestro-workspace-id": "workspace-a",
		});
		const res = createResponse();
		const middleware = createWorkspaceConfigMiddleware({});
		let loadedContext: ReturnType<typeof getWorkspaceConfigContext>;

		await requestContextStorage.run(
			{
				requestId: "request-1",
				traceId: "0123456789abcdef0123456789abcdef",
				spanId: "0123456789abcdef",
				startTime: 0,
				method: "GET",
				url: "/api/chat",
			},
			async () => {
				await middleware(req, res as unknown as ServerResponse, () => {
					loadedContext = getWorkspaceConfigContext();
				});
			},
		);

		expect(getConfig).toHaveBeenCalledWith("workspace-a");
		expect(loadedContext).toEqual({
			workspaceId: "workspace-a",
			config,
			source: "database",
		});
	});

	it("propagates downstream handler errors after loading middleware context", async () => {
		const config = sampleConfig();
		setWorkspaceConfigServiceForTest({
			isConfigured: () => true,
			upsertConfig: vi.fn(),
			getConfig: vi.fn().mockResolvedValue(config),
			listConfigs: vi.fn(),
			patchConfig: vi.fn(),
			deleteConfig: vi.fn(),
		} as unknown as WorkspaceConfigService);

		const req = createRequest("GET", "/api/chat", undefined, {
			"x-maestro-workspace-id": "workspace-a",
		});
		const res = createResponse();
		const middleware = createWorkspaceConfigMiddleware({});
		const downstreamError = new Error("chat handler failed");

		await expect(
			requestContextStorage.run(
				{
					requestId: "request-1",
					traceId: "0123456789abcdef0123456789abcdef",
					spanId: "0123456789abcdef",
					startTime: 0,
					method: "GET",
					url: "/api/chat",
				},
				async () => {
					await middleware(req, res as unknown as ServerResponse, async () => {
						throw downstreamError;
					});
				},
			),
		).rejects.toThrow(downstreamError);
		expect(res.writableEnded).toBe(false);
	});

	it("returns bad request when workspace config id validation fails", async () => {
		setWorkspaceConfigServiceForTest({
			isConfigured: () => true,
			upsertConfig: vi.fn(),
			getConfig: vi
				.fn()
				.mockRejectedValue(
					new WorkspaceConfigValidationError("workspaceId is required."),
				),
			listConfigs: vi.fn(),
			patchConfig: vi.fn(),
			deleteConfig: vi.fn(),
		} as unknown as WorkspaceConfigService);

		const req = createRequest("GET", "/api/chat", undefined, {
			"x-maestro-workspace-id": "workspace-a",
		});
		const res = createResponse();
		const middleware = createWorkspaceConfigMiddleware({});

		await requestContextStorage.run(
			{
				requestId: "request-1",
				traceId: "0123456789abcdef0123456789abcdef",
				spanId: "0123456789abcdef",
				startTime: 0,
				method: "GET",
				url: "/api/chat",
			},
			async () => {
				await middleware(req, res as unknown as ServerResponse, () => {
					throw new Error("next should not be called");
				});
			},
		);

		expect(res.statusCode).toBe(400);
		expect(parseJsonResponse(res)).toEqual({
			error: "workspaceId is required.",
		});
	});

	it("marks middleware context unconfigured when storage is disabled", async () => {
		setWorkspaceConfigServiceForTest({
			isConfigured: () => false,
			upsertConfig: vi.fn(),
			getConfig: vi.fn(),
			listConfigs: vi.fn(),
			patchConfig: vi.fn(),
			deleteConfig: vi.fn(),
		} as unknown as WorkspaceConfigService);

		const req = createRequest("GET", "/api/chat", undefined, {
			"x-maestro-workspace-id": "workspace-a",
		});
		const res = createResponse();
		const middleware = createWorkspaceConfigMiddleware({});
		let loadedContext: ReturnType<typeof getWorkspaceConfigContext>;

		await requestContextStorage.run(
			{
				requestId: "request-1",
				traceId: "0123456789abcdef0123456789abcdef",
				spanId: "0123456789abcdef",
				startTime: 0,
				method: "GET",
				url: "/api/chat",
			},
			async () => {
				await middleware(req, res as unknown as ServerResponse, () => {
					loadedContext = getWorkspaceConfigContext();
				});
			},
		);

		expect(loadedContext).toEqual({
			workspaceId: "workspace-a",
			config: null,
			source: "unconfigured",
		});
	});
});
