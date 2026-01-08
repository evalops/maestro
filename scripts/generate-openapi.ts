import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import {
	ComposerChatRequestSchema as ChatRequestSchema,
	ComposerCommandListResponseSchema,
	ComposerCommandPrefsSchema,
	ComposerCommandPrefsWriteResponseSchema,
	ComposerConfigResponseSchema,
	ComposerConfigWriteRequestSchema,
	ComposerConfigWriteResponseSchema,
	ComposerApprovalsStatusResponseSchema,
	ComposerApprovalsUpdateRequestSchema,
	ComposerApprovalsUpdateResponseSchema,
	ComposerBackgroundHistoryResponseSchema,
	ComposerBackgroundPathResponseSchema,
	ComposerBackgroundStatusResponseSchema,
	ComposerBackgroundUpdateRequestSchema,
	ComposerBackgroundUpdateResponseSchema,
	ComposerErrorResponseSchema,
	ComposerFilesResponseSchema,
	ComposerFrameworkListResponseSchema,
	ComposerFrameworkStatusResponseSchema,
	ComposerFrameworkUpdateRequestSchema,
	ComposerFrameworkUpdateResponseSchema,
	ComposerGuardianConfigRequestSchema,
	ComposerGuardianConfigResponseSchema,
	ComposerGuardianRunResponseSchema,
	ComposerGuardianStatusResponseSchema,
	ComposerModelListResponseSchema,
	ComposerModelSchema,
	ComposerModelSetSchema as ModelSetSchema,
	ComposerMessageSchema,
	ComposerPlanActionResponseSchema,
	ComposerPlanRequestSchema,
	ComposerPlanStatusResponseSchema,
	ComposerSessionListResponseSchema,
	ComposerSessionSchema,
	ComposerSessionSummarySchema,
	ComposerStatusResponseSchema,
	ComposerUndoHistoryResponseSchema,
	ComposerUndoOperationResponseSchema,
	ComposerUndoRequestSchema,
	ComposerUndoStatusResponseSchema,
	ComposerUsageResponseSchema,
} from "../packages/contracts/src/schemas.js";
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

	function collectRoutes(elements: ts.NodeArray<ts.Expression>) {
		for (const el of elements) {
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

	function visit(node: ts.Node) {
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText() === "routes" &&
			node.initializer &&
			ts.isArrayLiteralExpression(node.initializer)
		) {
			collectRoutes(node.initializer.elements);
		}
		if (
			ts.isReturnStatement(node) &&
			node.expression &&
			ts.isArrayLiteralExpression(node.expression)
		) {
			collectRoutes(node.expression.elements);
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
		ChatMessage: ComposerMessageSchema,
		ModelEntry: ComposerModelSchema,
		ModelsResponse: ComposerModelListResponseSchema,
		ModelSelectionResponse: ComposerModelSchema,
		CommandsResponse: ComposerCommandListResponseSchema,
		CommandPrefs: ComposerCommandPrefsSchema,
		CommandPrefsWriteResponse: ComposerCommandPrefsWriteResponseSchema,
		FilesResponse: ComposerFilesResponseSchema,
		ConfigWriteRequest: ComposerConfigWriteRequestSchema,
		ConfigResponse: ComposerConfigResponseSchema,
		ConfigWriteResponse: ComposerConfigWriteResponseSchema,
		GuardianStatusResponse: ComposerGuardianStatusResponseSchema,
		GuardianRunResponse: ComposerGuardianRunResponseSchema,
		GuardianConfigRequest: ComposerGuardianConfigRequestSchema,
		GuardianConfigResponse: ComposerGuardianConfigResponseSchema,
		PlanStatusResponse: ComposerPlanStatusResponseSchema,
		PlanRequest: ComposerPlanRequestSchema,
		PlanActionResponse: ComposerPlanActionResponseSchema,
		BackgroundStatusResponse: ComposerBackgroundStatusResponseSchema,
		BackgroundHistoryResponse: ComposerBackgroundHistoryResponseSchema,
		BackgroundPathResponse: ComposerBackgroundPathResponseSchema,
		BackgroundUpdateRequest: ComposerBackgroundUpdateRequestSchema,
		BackgroundUpdateResponse: ComposerBackgroundUpdateResponseSchema,
		ApprovalsStatusResponse: ComposerApprovalsStatusResponseSchema,
		ApprovalsUpdateRequest: ComposerApprovalsUpdateRequestSchema,
		ApprovalsUpdateResponse: ComposerApprovalsUpdateResponseSchema,
		FrameworkStatusResponse: ComposerFrameworkStatusResponseSchema,
		FrameworkListResponse: ComposerFrameworkListResponseSchema,
		FrameworkUpdateRequest: ComposerFrameworkUpdateRequestSchema,
		FrameworkUpdateResponse: ComposerFrameworkUpdateResponseSchema,
		UndoStatusResponse: ComposerUndoStatusResponseSchema,
		UndoHistoryResponse: ComposerUndoHistoryResponseSchema,
		UndoRequest: ComposerUndoRequestSchema,
		UndoOperationResponse: ComposerUndoOperationResponseSchema,
		StatusResponse: ComposerStatusResponseSchema,
		UsageResponse: ComposerUsageResponseSchema,
		SessionSummary: ComposerSessionSummarySchema,
		Session: ComposerSessionSchema,
		SessionsResponse: ComposerSessionListResponseSchema,
		ErrorResponse: ComposerErrorResponseSchema,
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
		const defaults = {
			summary: "Auto-generated from route definition",
			parameters: params,
			responses: { 200: { description: "OK" } },
		};
		target[method] = target[method]
			? {
					...defaults,
					...target[method],
					// merge parameters/security if present
					parameters: params.length
						? params
						: target[method].parameters || defaults.parameters,
					security:
						target[method].security ||
						(normalizedPath.startsWith("/api")
							? [{ ComposerApiKey: [] }]
							: undefined),
			  }
			: {
					...defaults,
					security: normalizedPath.startsWith("/api")
						? [{ ComposerApiKey: [] }]
						: undefined,
			  };
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

	if (paths["/api/commands"]?.get) {
		paths["/api/commands"].get.responses = {
			200: {
				description: "Custom commands",
				content: {
					"application/json": {
						schema: { $ref: "#/components/schemas/CommandsResponse" },
					},
				},
			},
		};
	}

	if (paths["/api/files"]?.get) {
		paths["/api/files"].get.responses = {
			200: {
				description: "Workspace files",
				content: {
					"application/json": {
						schema: { $ref: "#/components/schemas/FilesResponse" },
					},
				},
			},
		};
	}

	if (paths["/api/command-prefs"]) {
		const prefsSchema = { $ref: "#/components/schemas/CommandPrefs" };
		const prefsResponse = {
			200: {
				description: "Command preferences",
				content: { "application/json": { schema: prefsSchema } },
			},
		};
		if (paths["/api/command-prefs"].get) {
			paths["/api/command-prefs"].get.responses = prefsResponse;
		}
		if (paths["/api/command-prefs"].post) {
			paths["/api/command-prefs"].post = {
				summary: "Update command preferences",
				security: [{ ComposerApiKey: [] }],
				requestBody: {
					required: true,
					content: { "application/json": { schema: prefsSchema } },
				},
				responses: {
					200: {
						description: "Command preferences updated",
						content: {
							"application/json": {
								schema: {
									$ref: "#/components/schemas/CommandPrefsWriteResponse",
								},
							},
						},
					},
					400: { description: "Invalid preferences payload" },
				},
			};
		}
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
					200: {
						description: "Config persisted",
						content: {
							"application/json": {
								schema: {
									$ref: "#/components/schemas/ConfigWriteResponse",
								},
							},
						},
					},
					400: { description: "Invalid config" },
					413: { description: "Payload too large" },
				},
			};
		}
	}

	if (paths["/api/guardian/status"]) {
		if (paths["/api/guardian/status"].get) {
			paths["/api/guardian/status"].get = {
				summary: "Get guardian status",
				security: [{ ComposerApiKey: [] }],
				responses: {
					200: {
						description: "Guardian status",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/GuardianStatusResponse" },
							},
						},
					},
				},
			};
		}
	}

	if (paths["/api/guardian/run"]) {
		if (paths["/api/guardian/run"].post) {
			paths["/api/guardian/run"].post = {
				summary: "Run guardian checks",
				security: [{ ComposerApiKey: [] }],
				responses: {
					200: {
						description: "Guardian run result",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/GuardianRunResponse" },
							},
						},
					},
				},
			};
		}
	}

	if (paths["/api/guardian/config"]) {
		if (paths["/api/guardian/config"].post) {
			paths["/api/guardian/config"].post = {
				summary: "Update guardian config",
				security: [{ ComposerApiKey: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/GuardianConfigRequest" },
						},
					},
				},
				responses: {
					200: {
						description: "Guardian config updated",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/GuardianConfigResponse" },
							},
						},
					},
					400: { description: "Invalid guardian config" },
				},
			};
		}
	}

	if (paths["/api/plan"]) {
		if (paths["/api/plan"].get) {
			paths["/api/plan"].get = {
				summary: "Get plan mode state",
				security: [{ ComposerApiKey: [] }],
				responses: {
					200: {
						description: "Plan mode status",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/PlanStatusResponse" },
							},
						},
					},
				},
			};
		}
		if (paths["/api/plan"].post) {
			paths["/api/plan"].post = {
				summary: "Update plan mode",
				security: [{ ComposerApiKey: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/PlanRequest" },
						},
					},
				},
				responses: {
					200: {
						description: "Plan mode updated",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/PlanActionResponse" },
							},
						},
					},
					400: { description: "Invalid plan request" },
				},
			};
		}
	}

	if (paths["/api/background"]) {
		if (paths["/api/background"].get) {
			paths["/api/background"].get = {
				summary: "Get background task status",
				security: [{ ComposerApiKey: [] }],
				responses: {
					200: {
						description: "Background task data",
						content: {
							"application/json": {
								schema: {
									oneOf: [
										{ $ref: "#/components/schemas/BackgroundStatusResponse" },
										{ $ref: "#/components/schemas/BackgroundHistoryResponse" },
										{ $ref: "#/components/schemas/BackgroundPathResponse" },
									],
								},
							},
						},
					},
					400: { description: "Invalid action" },
				},
			};
		}
		if (paths["/api/background"].post) {
			paths["/api/background"].post = {
				summary: "Update background settings",
				security: [{ ComposerApiKey: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/BackgroundUpdateRequest" },
						},
					},
				},
				responses: {
					200: {
						description: "Background settings updated",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/BackgroundUpdateResponse" },
							},
						},
					},
					400: { description: "Invalid background action" },
				},
			};
		}
	}

	if (paths["/api/undo"]) {
		if (paths["/api/undo"].get) {
			paths["/api/undo"].get = {
				summary: "Get undo status",
				security: [{ ComposerApiKey: [] }],
				responses: {
					200: {
						description: "Undo status data",
						content: {
							"application/json": {
								schema: {
									oneOf: [
										{ $ref: "#/components/schemas/UndoStatusResponse" },
										{ $ref: "#/components/schemas/UndoHistoryResponse" },
									],
								},
							},
						},
					},
					400: { description: "Invalid action" },
				},
			};
		}
		if (paths["/api/undo"].post) {
			paths["/api/undo"].post = {
				summary: "Perform undo operation",
				security: [{ ComposerApiKey: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/UndoRequest" },
						},
					},
				},
				responses: {
					200: {
						description: "Undo action result",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/UndoOperationResponse" },
							},
						},
					},
					400: { description: "Invalid undo request" },
				},
			};
		}
	}

	if (paths["/api/approvals"]) {
		if (paths["/api/approvals"].get) {
			paths["/api/approvals"].get = {
				summary: "Get approval mode",
				security: [{ ComposerApiKey: [] }],
				responses: {
					200: {
						description: "Approval mode",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/ApprovalsStatusResponse" },
							},
						},
					},
				},
			};
		}
		if (paths["/api/approvals"].post) {
			paths["/api/approvals"].post = {
				summary: "Set approval mode",
				security: [{ ComposerApiKey: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/ApprovalsUpdateRequest" },
						},
					},
				},
				responses: {
					200: {
						description: "Approval mode updated",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/ApprovalsUpdateResponse" },
							},
						},
					},
					400: { description: "Invalid approval mode" },
				},
			};
		}
	}

	if (paths["/api/framework"]) {
		if (paths["/api/framework"].get) {
			paths["/api/framework"].get = {
				summary: "Get framework preference",
				security: [{ ComposerApiKey: [] }],
				responses: {
					200: {
						description: "Framework status data",
						content: {
							"application/json": {
								schema: {
									oneOf: [
										{ $ref: "#/components/schemas/FrameworkStatusResponse" },
										{ $ref: "#/components/schemas/FrameworkListResponse" },
									],
								},
							},
						},
					},
					400: { description: "Invalid action" },
				},
			};
		}
		if (paths["/api/framework"].post) {
			paths["/api/framework"].post = {
				summary: "Update framework preference",
				security: [{ ComposerApiKey: [] }],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/FrameworkUpdateRequest" },
						},
					},
				},
				responses: {
					200: {
						description: "Framework preference updated",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/FrameworkUpdateResponse" },
							},
						},
					},
					400: { description: "Invalid framework" },
				},
			};
		}
	}

	if (paths["/api/sessions"]) {
		if (paths["/api/sessions"].get) {
			paths["/api/sessions"].get = {
				summary: "List sessions",
				security: [{ ComposerApiKey: [] }],
				responses: {
					200: {
						description: "Sessions list",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/SessionsResponse" },
							},
						},
					},
					401: { description: "Unauthorized" },
				},
			};
		}
		if (paths["/api/sessions"].post) {
			paths["/api/sessions"].post = {
				summary: "Create/import session",
				security: [{ ComposerApiKey: [] }],
				requestBody: {
					required: false,
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: { title: { type: "string" } },
							},
						},
					},
				},
				responses: {
					201: {
						description: "Session created/imported",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/Session" },
							},
						},
					},
					401: { description: "Unauthorized" },
					400: {
						description: "Invalid session payload",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/ErrorResponse" },
							},
						},
					},
				},
			};
		}
	}

	if (paths["/api/sessions/{id}"]) {
		if (paths["/api/sessions/{id}"].get) {
			paths["/api/sessions/{id}"].get = {
				summary: "Get session by id",
				security: [{ ComposerApiKey: [] }],
				parameters: [
					{ name: "id", in: "path", required: true, schema: { type: "string" } },
				],
				responses: {
					200: {
						description: "Session data",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/Session" },
							},
						},
					},
					401: { description: "Unauthorized" },
					404: { description: "Not found" },
				},
			};
		}
		if (paths["/api/sessions/{id}"].delete) {
			paths["/api/sessions/{id}"].delete = {
				summary: "Delete session",
				security: [{ ComposerApiKey: [] }],
				parameters: [
					{ name: "id", in: "path", required: true, schema: { type: "string" } },
				],
				responses: {
					204: { description: "Deleted" },
					401: { description: "Unauthorized" },
					404: { description: "Not found" },
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

	if (paths["/api/usage"]?.get) {
		paths["/api/usage"].get = {
			summary: "Usage summary",
			security: [{ ComposerApiKey: [] }],
			responses: {
				200: {
					description: "Usage payload",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/UsageResponse" },
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
	const routes = extractRoutes("src/server/routes.ts");
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
