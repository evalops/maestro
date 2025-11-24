import { writeFileSync } from "node:fs";

const spec = {
	openapi: "3.1.0",
	info: {
		title: "Composer Web API",
		version: "0.10.0",
		description:
			"HTTP + SSE API used by the Composer web UI. Generated from route definitions.",
	},
	servers: [
		{
			url: "http://localhost:8080",
			description: "Local web server",
		},
	],
	paths: {
		"/api/chat": {
			post: {
				summary: "Send a chat request (SSE stream)",
				description:
					"Validate and dispatch a chat request. Responds with text/event-stream; final event is [DONE].",
				security: [{ ComposerApiKey: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/ChatRequest" },
						},
					},
				},
				responses: {
					200: {
						description: "SSE stream",
						content: { "text/event-stream": {} },
					},
					400: { description: "Invalid request" },
					401: { description: "Unauthorized (missing/invalid key)" },
				},
			},
		},
		"/api/models": {
			get: {
				summary: "List registered models",
				security: [{ ComposerApiKey: [] }],
				responses: {
					200: {
						description: "Array of models",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/ModelsResponse" },
							},
						},
					},
				},
			},
		},
		"/api/model": {
			get: {
				summary: "Get active model selection",
				security: [{ ComposerApiKey: [] }],
				responses: {
					200: {
						description: "Current model",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/ModelSelectionResponse" },
							},
						},
					},
				},
			},
			post: {
				summary: "Set active model",
				security: [{ ComposerApiKey: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/ModelSetRequest" },
						},
					},
				},
				responses: {
					200: {
						description: "Selected model",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/ModelSelectionResponse" },
							},
						},
					},
					400: { description: "Invalid model selection" },
					404: { description: "Model not found" },
				},
			},
		},
		"/api/config": {
			get: {
				summary: "Read custom config",
				security: [{ ComposerApiKey: [] }],
				responses: {
					200: {
						description: "Config payload",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/ConfigResponse" },
							},
						},
					},
				},
			},
			post: {
				summary: "Write custom config",
				security: [{ ComposerApiKey: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/ConfigWriteRequest" },
						},
					},
				},
				responses: {
					200: { description: "Config persisted" },
					400: { description: "Invalid config" },
					413: { description: "Payload too large" },
				},
			},
		},
		"/api/status": {
			get: {
				summary: "Server status",
				security: [{ ComposerApiKey: [] }],
				responses: {
					200: {
						description: "Status payload",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/StatusResponse" },
							},
						},
					},
				},
			},
		},
		"/api/usage": {
			get: {
				summary: "Usage statistics",
				security: [{ ComposerApiKey: [] }],
				responses: { 200: { description: "Usage stats" } },
			},
		},
		"/api/sessions": {
			get: { summary: "List sessions", security: [{ ComposerApiKey: [] }], responses: { 200: { description: "Sessions list" } } },
			post: { summary: "Create/import session", security: [{ ComposerApiKey: [] }], responses: { 200: { description: "Session created/imported" } } },
		},
		"/api/sessions/{id}": {
			get: {
				summary: "Get session by id",
				security: [{ ComposerApiKey: [] }],
				parameters: [
					{ name: "id", in: "path", required: true, schema: { type: "string" } },
				],
				responses: { 200: { description: "Session data" }, 404: { description: "Not found" } },
			},
			delete: {
				summary: "Delete session",
				security: [{ ComposerApiKey: [] }],
				parameters: [
					{ name: "id", in: "path", required: true, schema: { type: "string" } },
				],
				responses: { 200: { description: "Deleted" }, 404: { description: "Not found" } },
			},
		},
	},
	components: {
		securitySchemes: {
			ComposerApiKey: {
				type: "apiKey",
				in: "header",
				name: "x-composer-api-key",
				description:
					"Value of COMPOSER_WEB_API_KEY. Authorization: Bearer <key> is also accepted.",
			},
		},
		schemas: {
			ChatMessage: {
				type: "object",
				required: ["role"],
				properties: {
					role: { type: "string", description: "Message role (user/assistant/system)" },
					content: { type: "string", nullable: true },
				},
			},
			ChatRequest: {
				type: "object",
				required: ["messages"],
				properties: {
					messages: {
						type: "array",
						items: { $ref: "#/components/schemas/ChatMessage" },
						minItems: 1,
					},
					model: { type: "string" },
					sessionId: { type: "string" },
					thinkingLevel: { type: "string", description: "off|lean|medium|max (provider-specific)" },
				},
			},
			ModelSetRequest: {
				type: "object",
				required: ["model"],
				properties: { model: { type: "string" } },
			},
			ModelSelectionResponse: {
				type: "object",
				required: ["id", "provider"],
				properties: {
					id: { type: "string" },
					provider: { type: "string" },
					name: { type: "string" },
					contextWindow: { type: "integer" },
					maxTokens: { type: "integer" },
					reasoning: { type: "boolean" },
				},
			},
			ModelEntry: {
				type: "object",
				required: ["id", "provider", "api"],
				properties: {
					id: { type: "string" },
					provider: { type: "string" },
					name: { type: "string" },
					api: { type: "string" },
					contextWindow: { type: "integer" },
					maxTokens: { type: "integer" },
					cost: { type: "object", additionalProperties: true },
					capabilities: {
						type: "object",
						properties: {
							streaming: { type: "boolean" },
							tools: { type: "boolean" },
							vision: { type: "boolean" },
							reasoning: { type: "boolean" },
						},
					},
				},
			},
			ModelsResponse: {
				type: "object",
				properties: {
					models: { type: "array", items: { $ref: "#/components/schemas/ModelEntry" } },
				},
			},
			ConfigWriteRequest: {
				type: "object",
				required: ["config"],
				properties: { config: { type: "object" } },
				additionalProperties: true,
			},
			ConfigResponse: {
				type: "object",
				properties: {
					config: { type: "object" },
					configPath: { type: "string" },
				},
			},
			StatusResponse: {
				type: "object",
				properties: {
					cwd: { type: "string" },
					git: {
						type: "object",
						properties: {
							branch: { type: "string" },
							status: { type: "object" },
						},
					},
					context: {
						type: "object",
						properties: {
							agentMd: { type: "boolean" },
							claudeMd: { type: "boolean" },
						},
					},
					server: {
						type: "object",
						properties: {
							uptime: { type: "number" },
							version: { type: "string" },
							staticCacheMaxAgeSeconds: { type: "number" },
						},
					},
					backgroundTasks: { type: "object" },
					lastUpdated: { type: "number" },
					lastLatencyMs: { type: "number" },
				},
			},
		},
	},
};

const outputPath = "openapi.json";
writeFileSync(outputPath, JSON.stringify(spec, null, 2), "utf-8");
console.log(`OpenAPI spec written to ${outputPath}`);
