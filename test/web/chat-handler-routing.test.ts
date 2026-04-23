import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/intelligent-router/recorder.js", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/services/intelligent-router/recorder.js")
	>("../../src/services/intelligent-router/recorder.js");
	return {
		...actual,
		selectIntelligentRouterModel: vi.fn(),
	};
});

import type { RegisteredModel } from "../../src/models/registry.js";
import type { WebServerContext } from "../../src/server/app-context.js";
import { handleChat } from "../../src/server/handlers/chat.js";
import { requestContextStorage } from "../../src/server/request-context.js";
import { selectIntelligentRouterModel } from "../../src/services/intelligent-router/recorder.js";
import type { RoutingDecision } from "../../src/services/intelligent-router/types.js";

const selectedModel: RegisteredModel = {
	id: "claude-sonnet-4-5",
	provider: "anthropic",
	name: "Claude",
	api: "anthropic-messages",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
	providerName: "Anthropic",
	source: "builtin",
	isLocal: false,
};

const fallbackModel: RegisteredModel = {
	...selectedModel,
	id: "gpt-4o-mini",
	provider: "openai",
	name: "GPT-4o mini",
	api: "openai-responses",
	providerName: "OpenAI",
};

const cors = { "Access-Control-Allow-Origin": "*" };

interface MockResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: string;
	writableEnded: boolean;
	on: () => void;
	off: () => void;
	writeHead(status: number, headers?: Record<string, string>): void;
	write(chunk: string | Buffer): void;
	end(chunk?: string | Buffer): void;
}

interface MockPassThrough extends PassThrough {
	method: string;
	url: string;
	headers: Record<string, string>;
}

function makeRes(): MockResponse {
	return {
		statusCode: 200,
		headers: {},
		body: "",
		writableEnded: false,
		on: () => {},
		off: () => {},
		writeHead(status: number, headers?: Record<string, string>) {
			this.statusCode = status;
			this.headers = headers || {};
		},
		write(chunk: string | Buffer) {
			this.body += chunk.toString();
		},
		end(chunk?: string | Buffer) {
			if (chunk) this.write(chunk);
			this.writableEnded = true;
		},
	};
}

function routingDecision(): RoutingDecision {
	return {
		decisionId: "decision-1",
		taskType: "chat",
		strategy: "balanced",
		selectedModel: {
			provider: selectedModel.provider,
			model: selectedModel.id,
		},
		fallbackChain: [
			{
				provider: fallbackModel.provider,
				model: fallbackModel.id,
			},
		],
		scores: [],
		overrideApplied: false,
		reason: "insufficient_history_model_hint",
		createdAt: "2026-04-20T12:00:00.000Z",
	};
}

describe("handleChat routing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the selected model error when only a fallback violates workspace policy", async () => {
		vi.mocked(selectIntelligentRouterModel).mockReturnValue({
			taskType: "chat",
			decision: routingDecision(),
			modelInputs: [
				`${selectedModel.provider}/${selectedModel.id}`,
				`${fallbackModel.provider}/${fallbackModel.id}`,
			],
		});

		const req = new PassThrough() as MockPassThrough;
		req.method = "POST";
		req.url = "/api/chat";
		req.headers = {};
		req.end(
			JSON.stringify({
				messages: [{ role: "user", content: "hi" }],
			}),
		);

		const res = makeRes();
		const context: Partial<WebServerContext> = {
			createAgent: async () => {
				throw new Error("should not create agent");
			},
			getRegisteredModel: async (input) => {
				if (input === `${selectedModel.provider}/${selectedModel.id}`) {
					throw new Error("Missing API key for anthropic");
				}
				if (input === `${fallbackModel.provider}/${fallbackModel.id}`) {
					return fallbackModel;
				}
				throw new Error(`Unexpected model lookup: ${input}`);
			},
			defaultApprovalMode: "prompt",
			defaultProvider: selectedModel.provider,
			defaultModelId: selectedModel.id,
			corsHeaders: cors,
		};

		await requestContextStorage.run(
			{
				requestId: "request-1",
				traceId: "0123456789abcdef0123456789abcdef",
				spanId: "0123456789abcdef",
				startTime: 0,
				method: "POST",
				url: "/api/chat",
				workspaceConfig: {
					workspaceId: "workspace-a",
					source: "database",
					config: {
						workspaceId: "workspace-a",
						modelPreferences: {
							defaultModel: `${selectedModel.provider}/${selectedModel.id}`,
							allowedModels: [`${selectedModel.provider}/${selectedModel.id}`],
							blockedModels: [],
						},
						safetyRules: {
							allowedTools: [],
							blockedTools: [],
							requiredSkills: [],
							fileBoundaries: [],
						},
						rateLimits: {
							requestsPerMinute: 60,
							tokensPerMinute: 1000,
						},
						createdAt: "2026-04-20T12:00:00.000Z",
						updatedAt: "2026-04-20T12:00:00.000Z",
					},
				},
			},
			async () => {
				await handleChat(
					req as unknown as IncomingMessage,
					res as unknown as ServerResponse,
					context as WebServerContext,
				);
			},
		);

		expect(res.statusCode).toBe(500);
		expect(res.body).toContain("Missing API key for anthropic");
		expect(res.body).not.toContain("not allowed by workspace policy");
	});
});
