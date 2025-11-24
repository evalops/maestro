import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import {
	ChatRequestSchema,
	ModelSetSchema,
} from "../src/web/validation.js";
let version = "0.0.0";
try {
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	version = pkg.version ?? version;
} catch (err) {
	console.error("Failed to read package.json for version; defaulting to 0.0.0", err);
}

type Route = { method: string; path: string };

function extractRoutes(sourcePath: string): Route[] {
	const sourceText = readFileSync(sourcePath, "utf8");
	const sf = ts.createSourceFile(
		sourcePath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

	const routes: Route[] = [];

	function visit(node: ts.Node) {
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText() === "routes" &&
			node.initializer &&
			ts.isArrayLiteralExpression(node.initializer)
		) {
			for (const el of node.initializer.elements) {
				if (!ts.isObjectLiteralExpression(el)) continue;
				let method: string | undefined;
				let path: string | undefined;
				for (const prop of el.properties) {
					if (!ts.isPropertyAssignment(prop)) continue;
					const key = prop.name.getText().replace(/['"]/g, "");
					if (key === "method" && ts.isStringLiteral(prop.initializer)) {
						method = prop.initializer.text.toLowerCase();
					}
					if (key === "path" && ts.isStringLiteral(prop.initializer)) {
						path = prop.initializer.text.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
					}
				}
				if (method && path) {
					routes.push({ method, path });
				}
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sf);
	return routes;
}

function buildComponents() {
const schemas: Record<string, unknown> = {
		ChatRequest: ChatRequestSchema,
		ModelSetRequest: ModelSetSchema,
		ChatMessage: {
			type: "object",
			required: ["role"],
			properties: {
				role: { type: "string" },
				content: { type: "string", nullable: true },
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
				models: {
					type: "array",
					items: { $ref: "#/components/schemas/ModelEntry" },
				},
			},
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
	Session: {
		type: "object",
		properties: {
			id: { type: "string" },
			name: { type: "string" },
			createdAt: { type: "string", format: "date-time" },
			updatedAt: { type: "string", format: "date-time" },
		},
	},
	SessionsResponse: {
		type: "object",
		properties: {
			sessions: {
				type: "array",
				items: { $ref: "#/components/schemas/Session" },
			},
		},
	},
	ErrorResponse: {
		type: "object",
		properties: {
			error: { type: "string" },
			details: { type: "string" },
		},
	},
};

	return {
		securitySchemes: {
			ComposerApiKey: {
				type: "apiKey",
				in: "header",
				name: "x-composer-api-key",
				description:
					"Value of COMPOSER_WEB_API_KEY. Authorization: Bearer <key> is also accepted.",
			},
		},
		schemas,
	};
}

function extractParams(path: string): string[] {
	const matches = path.match(/{([^}]+)}/g) || [];
	return matches.map((m) => m.slice(1, -1));
}

function buildPaths(routes: Route[]) {
	const paths: Record<string, any> = {};

	const ensure = (path: string) => {
		if (!paths[path]) paths[path] = {};
		return paths[path];
	};

	for (const { method, path } of routes) {
		const normalizedPath = path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
		const target = ensure(normalizedPath);
		const params = extractParams(normalizedPath).map((name) => ({
			name,
			in: "path",
			required: true,
			schema: { type: "string" },
		}));
		target[method] = target[method] || {
			summary: "Auto-generated from route definition",
			parameters: params,
			responses: { 200: { description: "OK" } },
		};
		// keep parameters if already enriched
		if (params.length) {
			target[method].parameters = params;
		}
		if (normalizedPath.startsWith("/api")) {
			target[method].security = target[method].security || [
				{ ComposerApiKey: [] },
			];
		}
	}

	// Enrich known endpoints
	if (paths["/api/chat"]?.post) {
		paths["/api/chat"].post = {
			summary: "Send a chat request (SSE)",
			description: "Streams SSE events; final marker is [DONE].",
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
				200: { description: "SSE stream", content: { "text/event-stream": {} } },
				400: { description: "Invalid request" },
				401: { description: "Unauthorized" },
			},
		};
	}

	if (paths["/api/models"]?.get) {
		paths["/api/models"].get.responses = {
			200: {
				description: "Registered models",
				content: {
					"application/json": {
						schema: { $ref: "#/components/schemas/ModelsResponse" },
					},
				},
			},
		};
	}

	if (paths["/api/model"]) {
		const base = {
			security: [{ ComposerApiKey: [] }],
			responses: {
				200: {
					description: "Current model selection",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/ModelSelectionResponse" },
						},
					},
				},
			},
		};
		if (paths["/api/model"].get) {
			paths["/api/model"].get = { ...base, summary: "Get active model" };
		}
		if (paths["/api/model"].post) {
			paths["/api/model"].post = {
				...base,
				summary: "Set active model",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/ModelSetRequest" },
						},
					},
				},
				responses: {
					...base.responses,
					400: { description: "Invalid model selection" },
					404: { description: "Model not found" },
				},
			};
		}
	}

	if (paths["/api/config"]) {
		if (paths["/api/config"].get) {
			paths["/api/config"].get = {
				summary: "Get custom config",
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
			};
		}
		if (paths["/api/config"].post) {
			paths["/api/config"].post = {
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
			};
		}
	}

	if (paths["/api/status"]?.get) {
		paths["/api/status"].get = {
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
		};
	}

	return paths;
}

function buildSpec(routes: Route[]) {
	const serverUrl =
		process.env.OPENAPI_SERVER_URL || "https://api.example.com";
	return {
		openapi: "3.1.0",
		info: {
			title: "Composer Web API",
			version,
			description:
				"Auto-generated from src/web-server.ts routes. Components seeded from runtime schemas.",
		},
		servers: [{ url: serverUrl }],
		paths: buildPaths(routes),
		components: buildComponents(),
	};
}

function main() {
	const routes = extractRoutes("src/web-server.ts");
	const spec = buildSpec(routes);
	try {
		writeFileSync("openapi.json", JSON.stringify(spec, null, 2), "utf8");
		console.log(`Generated openapi.json with ${routes.length} routes.`);
	} catch (err) {
		console.error("Failed to write openapi.json", err);
		process.exitCode = 1;
	}
}

main();
