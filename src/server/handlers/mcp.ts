import type { IncomingMessage, ServerResponse } from "node:http";
import { type Static, Type } from "@sinclair/typebox";
import {
	type McpAuthPresetInput,
	type McpServerInput,
	type WritableMcpScope,
	addMcpAuthPresetToConfig,
	addMcpServerToConfig,
	buildSuggestedMcpServerName,
	getOfficialMcpRegistryEntries,
	inferRemoteMcpTransport,
	loadMcpConfig,
	mcpManager,
	officialMcpRegistryEntryMatchesUrl,
	prefetchOfficialMcpRegistry,
	removeMcpAuthPresetFromConfig,
	removeMcpServerFromConfig,
	resolveOfficialMcpRegistryEntry,
	searchOfficialMcpRegistry,
	setProjectMcpServerApprovalDecision,
	updateMcpAuthPresetInConfig,
	updateMcpServerInConfig,
} from "../../mcp/index.js";
import { ApiError, respondWithApiError, sendJson } from "../server-utils.js";
import { parseAndValidateJson } from "../validation.js";

const WritableMcpScopeSchema = Type.Union([
	Type.Literal("local"),
	Type.Literal("project"),
	Type.Literal("user"),
]);

const McpTransportSchema = Type.Union([
	Type.Literal("stdio"),
	Type.Literal("http"),
	Type.Literal("sse"),
]);

const McpServerInputSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	transport: Type.Optional(McpTransportSchema),
	command: Type.Optional(Type.String({ minLength: 1 })),
	args: Type.Optional(Type.Array(Type.String())),
	env: Type.Optional(Type.Record(Type.String(), Type.String())),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	url: Type.Optional(Type.String({ minLength: 1 })),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	headersHelper: Type.Optional(Type.String({ minLength: 1 })),
	authPreset: Type.Optional(Type.String({ minLength: 1 })),
	timeout: Type.Optional(Type.Integer({ minimum: 1 })),
	enabled: Type.Optional(Type.Boolean()),
	disabled: Type.Optional(Type.Boolean()),
});

const McpAuthPresetInputSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	headersHelper: Type.Optional(Type.String({ minLength: 1 })),
});

const NullableStringSchema = Type.Union([
	Type.String({ minLength: 1 }),
	Type.Null(),
]);

const NullableStringArraySchema = Type.Union([
	Type.Array(Type.String()),
	Type.Null(),
]);

const NullableStringRecordSchema = Type.Union([
	Type.Record(Type.String(), Type.String()),
	Type.Null(),
]);

const NullablePositiveIntegerSchema = Type.Union([
	Type.Integer({ minimum: 1 }),
	Type.Null(),
]);

const McpServerUpdateInputSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	transport: Type.Optional(McpTransportSchema),
	command: Type.Optional(Type.String({ minLength: 1 })),
	args: Type.Optional(NullableStringArraySchema),
	env: Type.Optional(NullableStringRecordSchema),
	cwd: Type.Optional(NullableStringSchema),
	url: Type.Optional(Type.String({ minLength: 1 })),
	headers: Type.Optional(NullableStringRecordSchema),
	headersHelper: Type.Optional(NullableStringSchema),
	authPreset: Type.Optional(NullableStringSchema),
	timeout: Type.Optional(NullablePositiveIntegerSchema),
	enabled: Type.Optional(Type.Boolean()),
	disabled: Type.Optional(Type.Boolean()),
});

const McpAuthPresetUpdateInputSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	headers: Type.Optional(NullableStringRecordSchema),
	headersHelper: Type.Optional(NullableStringSchema),
});

const McpRegistryImportSchema = Type.Object({
	query: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String({ minLength: 1 })),
	scope: Type.Optional(WritableMcpScopeSchema),
	url: Type.Optional(Type.String({ minLength: 1 })),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	headersHelper: Type.Optional(Type.String({ minLength: 1 })),
	authPreset: Type.Optional(Type.String({ minLength: 1 })),
	transport: Type.Optional(
		Type.Union([Type.Literal("http"), Type.Literal("sse")]),
	),
});

const McpAddServerSchema = Type.Object({
	scope: Type.Optional(WritableMcpScopeSchema),
	server: McpServerInputSchema,
});

const McpRemoveServerSchema = Type.Object({
	scope: Type.Optional(WritableMcpScopeSchema),
	name: Type.String({ minLength: 1 }),
});

const McpAddAuthPresetSchema = Type.Object({
	scope: Type.Optional(WritableMcpScopeSchema),
	preset: McpAuthPresetInputSchema,
});

const McpRemoveAuthPresetSchema = Type.Object({
	scope: Type.Optional(WritableMcpScopeSchema),
	name: Type.String({ minLength: 1 }),
});

const McpUpdateServerSchema = Type.Object({
	scope: Type.Optional(WritableMcpScopeSchema),
	name: Type.String({ minLength: 1 }),
	server: McpServerUpdateInputSchema,
});

const McpUpdateAuthPresetSchema = Type.Object({
	scope: Type.Optional(WritableMcpScopeSchema),
	name: Type.String({ minLength: 1 }),
	preset: McpAuthPresetUpdateInputSchema,
});

const McpProjectApprovalDecisionSchema = Type.Union([
	Type.Literal("approved"),
	Type.Literal("denied"),
]);

const McpSetProjectApprovalSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	decision: McpProjectApprovalDecisionSchema,
});

type McpRegistryImportInput = Static<typeof McpRegistryImportSchema>;
type McpAddServerInput = Static<typeof McpAddServerSchema>;
type McpAddAuthPresetInput = Static<typeof McpAddAuthPresetSchema>;
type McpAuthPresetUpdateInputConfig = Static<
	typeof McpAuthPresetUpdateInputSchema
>;
type McpRemoveServerInput = Static<typeof McpRemoveServerSchema>;
type McpRemoveAuthPresetInput = Static<typeof McpRemoveAuthPresetSchema>;
type McpUpdateServerInput = Static<typeof McpUpdateServerSchema>;
type McpUpdateAuthPresetInput = Static<typeof McpUpdateAuthPresetSchema>;
type McpUpdateServerInputConfig = Static<typeof McpServerUpdateInputSchema>;
type McpSetProjectApprovalInput = Static<typeof McpSetProjectApprovalSchema>;

async function ensureOfficialRegistryLoaded(): Promise<void> {
	await prefetchOfficialMcpRegistry();
	if (getOfficialMcpRegistryEntries().length === 0) {
		throw new ApiError(
			503,
			"Official MCP registry metadata is unavailable right now.",
		);
	}
}

async function reloadMcpManager(projectRoot: string) {
	const config = loadMcpConfig(projectRoot, { includeEnvLimits: true });
	await mcpManager.configure(config);
	return config;
}

function getWritableScope(
	scope: WritableMcpScope | undefined,
): WritableMcpScope {
	return scope ?? "local";
}

function resolveServerTransport(server: {
	transport?: McpServerInput["transport"];
	url?: string | null;
}): McpServerInput["transport"] {
	return (
		server.transport ??
		(server.url ? inferRemoteMcpTransport(server.url) : "stdio")
	);
}

function resolveKnownAuthPreset(
	projectRoot: string,
	authPreset: string | undefined,
) {
	if (!authPreset) {
		return;
	}
	const existingPreset = loadMcpConfig(projectRoot).authPresets.find(
		(preset) => preset.name === authPreset,
	);
	if (!existingPreset) {
		throw new ApiError(
			404,
			`MCP auth preset "${authPreset}" not found in merged config.`,
		);
	}
}

function mergeEditableServerConfig(
	existingServer: McpServerInput & { name: string },
	nextServer: McpUpdateServerInputConfig & { name: string },
): McpServerInput & { name: string } {
	const transport = resolveServerTransport({
		...existingServer,
		...nextServer,
	});
	const hasField = <T extends object>(value: T, key: keyof T): boolean =>
		Object.prototype.hasOwnProperty.call(value, key);
	const mergeOptional = <T>(
		key: keyof McpUpdateServerInputConfig,
		existing: T | undefined,
		next: T | null | undefined,
	): T | undefined => {
		if (!hasField(nextServer, key)) {
			return existing;
		}
		return next === null ? undefined : next;
	};
	const common = {
		name: nextServer.name,
		transport,
		enabled: nextServer.enabled ?? existingServer.enabled,
		disabled: nextServer.disabled ?? existingServer.disabled,
		timeout: mergeOptional(
			"timeout",
			existingServer.timeout,
			nextServer.timeout,
		),
	};

	if (transport === "stdio") {
		return {
			...common,
			command:
				(hasField(nextServer, "command") ? nextServer.command : undefined) ??
				existingServer.command,
			args: mergeOptional("args", existingServer.args, nextServer.args),
			env: mergeOptional("env", existingServer.env, nextServer.env),
			cwd: mergeOptional("cwd", existingServer.cwd, nextServer.cwd),
		};
	}

	return {
		...common,
		url:
			(hasField(nextServer, "url") ? nextServer.url : undefined) ??
			existingServer.url,
		headers: mergeOptional(
			"headers",
			existingServer.headers,
			nextServer.headers,
		),
		headersHelper: mergeOptional(
			"headersHelper",
			existingServer.headersHelper,
			nextServer.headersHelper,
		),
		authPreset: mergeOptional(
			"authPreset",
			existingServer.authPreset,
			nextServer.authPreset,
		),
	};
}

function mergeEditableAuthPresetConfig(
	existingPreset: McpAuthPresetInput & { name: string },
	nextPreset: McpAuthPresetUpdateInputConfig & { name: string },
): McpAuthPresetInput & { name: string } {
	const hasField = <T extends object>(value: T, key: keyof T): boolean =>
		Object.prototype.hasOwnProperty.call(value, key);
	const mergeOptional = <T>(
		key: keyof McpAuthPresetUpdateInputConfig,
		existing: T | undefined,
		next: T | null | undefined,
	): T | undefined => {
		if (!hasField(nextPreset, key)) {
			return existing;
		}
		return next === null ? undefined : next;
	};

	return {
		name: nextPreset.name,
		headers: mergeOptional(
			"headers",
			existingPreset.headers,
			nextPreset.headers,
		),
		headersHelper: mergeOptional(
			"headersHelper",
			existingPreset.headersHelper,
			nextPreset.headersHelper,
		),
	};
}

function findWritableFallbackServer(projectRoot: string, name: string) {
	return loadMcpConfig(projectRoot).servers.find(
		(server) => server.name === name,
	);
}

function findWritableFallbackAuthPreset(projectRoot: string, name: string) {
	return loadMcpConfig(projectRoot).authPresets.find(
		(preset) => preset.name === name,
	);
}

async function handleAddServer(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): Promise<void> {
	const body = await parseAndValidateJson<McpAddServerInput>(
		req,
		McpAddServerSchema,
	);
	const projectRoot = process.cwd();
	const existingServer = loadMcpConfig(projectRoot).servers.find(
		(server) => server.name === body.server.name,
	);
	if (existingServer) {
		throw new ApiError(
			409,
			`MCP server "${body.server.name}" already exists in merged config (scope: ${existingServer.scope ?? "unknown"}). Choose a different name.`,
		);
	}

	if (body.server.url) {
		await prefetchOfficialMcpRegistry();
	}

	const scope = getWritableScope(body.scope);
	const transport = resolveServerTransport(body.server);
	resolveKnownAuthPreset(projectRoot, body.server.authPreset);
	const { path } = addMcpServerToConfig({
		projectRoot,
		scope,
		server: {
			...body.server,
			transport,
		},
	});
	await reloadMcpManager(projectRoot);

	sendJson(
		res,
		200,
		{
			name: body.server.name,
			scope,
			path,
			server: {
				...body.server,
				transport,
			},
		},
		corsHeaders,
		req,
	);
}

async function handleRemoveServer(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): Promise<void> {
	const body = await parseAndValidateJson<McpRemoveServerInput>(
		req,
		McpRemoveServerSchema,
	);
	const projectRoot = process.cwd();
	const { path, scope } = removeMcpServerFromConfig({
		projectRoot,
		scope: body.scope,
		name: body.name,
	});
	await reloadMcpManager(projectRoot);
	const fallback = findWritableFallbackServer(projectRoot, body.name);

	sendJson(
		res,
		200,
		{
			name: body.name,
			scope,
			path,
			fallback: fallback
				? {
						name: fallback.name,
						scope: fallback.scope,
					}
				: null,
		},
		corsHeaders,
		req,
	);
}

async function handleUpdateServer(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): Promise<void> {
	const body = await parseAndValidateJson<McpUpdateServerInput>(
		req,
		McpUpdateServerSchema,
	);
	const projectRoot = process.cwd();
	const existingServer = loadMcpConfig(projectRoot).servers.find(
		(server) => server.name === body.name,
	);
	if (!existingServer) {
		throw new ApiError(
			404,
			`MCP server "${body.name}" not found in merged config.`,
		);
	}

	const mergedServer = mergeEditableServerConfig(existingServer, body.server);
	resolveKnownAuthPreset(projectRoot, mergedServer.authPreset);

	if (mergedServer.url) {
		await prefetchOfficialMcpRegistry();
	}
	const { path, scope } = updateMcpServerInConfig({
		projectRoot,
		scope: body.scope,
		name: body.name,
		server: mergedServer,
	});
	await reloadMcpManager(projectRoot);

	sendJson(
		res,
		200,
		{
			name: body.server.name,
			scope,
			path,
			server: mergedServer,
		},
		corsHeaders,
		req,
	);
}

async function handleAddAuthPreset(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): Promise<void> {
	const body = await parseAndValidateJson<McpAddAuthPresetInput>(
		req,
		McpAddAuthPresetSchema,
	);
	const projectRoot = process.cwd();
	const existingPreset = loadMcpConfig(projectRoot).authPresets.find(
		(preset) => preset.name === body.preset.name,
	);
	if (existingPreset) {
		throw new ApiError(
			409,
			`MCP auth preset "${body.preset.name}" already exists in merged config (scope: ${existingPreset.scope ?? "unknown"}). Choose a different name.`,
		);
	}

	const scope = getWritableScope(body.scope);
	const { path } = addMcpAuthPresetToConfig({
		projectRoot,
		scope,
		preset: body.preset,
	});
	await reloadMcpManager(projectRoot);

	sendJson(
		res,
		200,
		{
			name: body.preset.name,
			scope,
			path,
			preset: body.preset,
		},
		corsHeaders,
		req,
	);
}

async function handleRemoveAuthPreset(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): Promise<void> {
	const body = await parseAndValidateJson<McpRemoveAuthPresetInput>(
		req,
		McpRemoveAuthPresetSchema,
	);
	const projectRoot = process.cwd();
	const { path, scope } = removeMcpAuthPresetFromConfig({
		projectRoot,
		scope: body.scope,
		name: body.name,
	});
	await reloadMcpManager(projectRoot);
	const fallback = findWritableFallbackAuthPreset(projectRoot, body.name);

	sendJson(
		res,
		200,
		{
			name: body.name,
			scope,
			path,
			fallback: fallback
				? {
						name: fallback.name,
						scope: fallback.scope,
					}
				: null,
		},
		corsHeaders,
		req,
	);
}

async function handleUpdateAuthPreset(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): Promise<void> {
	const body = await parseAndValidateJson<McpUpdateAuthPresetInput>(
		req,
		McpUpdateAuthPresetSchema,
	);
	const projectRoot = process.cwd();
	const existingPreset = loadMcpConfig(projectRoot).authPresets.find(
		(preset) => preset.name === body.name,
	);
	if (!existingPreset) {
		throw new ApiError(
			404,
			`MCP auth preset "${body.name}" not found in merged config.`,
		);
	}
	if (body.preset.name !== body.name) {
		throw new ApiError(400, "Renaming MCP auth presets is not supported.");
	}

	const mergedPreset = mergeEditableAuthPresetConfig(
		existingPreset,
		body.preset,
	);
	const { path, scope } = updateMcpAuthPresetInConfig({
		projectRoot,
		scope: body.scope,
		name: body.name,
		preset: mergedPreset,
	});
	await reloadMcpManager(projectRoot);

	sendJson(
		res,
		200,
		{
			name: body.preset.name,
			scope,
			path,
			preset: mergedPreset,
		},
		corsHeaders,
		req,
	);
}

async function handleImportRegistry(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): Promise<void> {
	const body = await parseAndValidateJson<McpRegistryImportInput>(
		req,
		McpRegistryImportSchema,
	);
	await ensureOfficialRegistryLoaded();

	const { entry, matches } = resolveOfficialMcpRegistryEntry(body.query);
	if (!entry) {
		if (matches.length > 1) {
			throw new ApiError(
				409,
				`Multiple official MCP registry matches found for "${body.query}". Try /mcp search ${body.query}.`,
			);
		}
		throw new ApiError(
			404,
			`No official MCP registry match found for "${body.query}". Try /mcp search ${body.query}.`,
		);
	}

	const projectRoot = process.cwd();
	const name = body.name ?? buildSuggestedMcpServerName(entry);
	const existingServer = loadMcpConfig(projectRoot).servers.find(
		(server) => server.name === name,
	);
	if (existingServer) {
		throw new ApiError(
			409,
			`MCP server "${name}" already exists in merged config (scope: ${existingServer.scope ?? "unknown"}). Choose a different name.`,
		);
	}

	const resolvedUrl = body.url ?? entry.url ?? entry.urlOptions?.[0]?.url;
	if (!resolvedUrl) {
		throw new ApiError(
			400,
			`Official MCP registry entry "${entry.displayName}" requires a URL override.`,
		);
	}

	if (body.url && !officialMcpRegistryEntryMatchesUrl(entry, body.url)) {
		throw new ApiError(
			400,
			`URL does not match the official MCP registry entry "${entry.displayName}".`,
		);
	}

	const transport =
		body.transport ?? entry.transport ?? inferRemoteMcpTransport(resolvedUrl);
	const scope = getWritableScope(body.scope);
	resolveKnownAuthPreset(projectRoot, body.authPreset);
	const { path } = addMcpServerToConfig({
		projectRoot,
		scope,
		server: {
			name,
			transport,
			url: resolvedUrl,
			headers: body.headers,
			headersHelper: body.headersHelper,
			authPreset: body.authPreset,
		},
	});

	await reloadMcpManager(projectRoot);

	sendJson(
		res,
		200,
		{
			name,
			scope,
			path,
			entry,
			server: {
				transport,
				url: resolvedUrl,
				headers: body.headers,
				headersHelper: body.headersHelper,
				authPreset: body.authPreset,
			},
		},
		corsHeaders,
		req,
	);
}

async function handleSetProjectApproval(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
): Promise<void> {
	const body = await parseAndValidateJson<McpSetProjectApprovalInput>(
		req,
		McpSetProjectApprovalSchema,
	);
	const projectRoot = process.cwd();
	const config = loadMcpConfig(projectRoot);
	const existingServer = config.servers.find(
		(server) => server.name === body.name,
	);
	if (!existingServer) {
		throw new ApiError(
			404,
			`MCP server "${body.name}" not found in merged config.`,
		);
	}
	if (existingServer.scope !== "project") {
		throw new ApiError(
			400,
			`MCP server "${body.name}" is not loaded from project config.`,
		);
	}

	setProjectMcpServerApprovalDecision({
		projectRoot,
		server: existingServer,
		authPresets: config.authPresets,
		decision: body.decision,
	});
	await reloadMcpManager(projectRoot);
	const activeServer = mcpManager
		.getStatus()
		.servers.find((server) => server.name === body.name);

	sendJson(
		res,
		200,
		{
			name: body.name,
			scope: "project",
			decision: body.decision,
			projectApproval: activeServer?.projectApproval ?? body.decision,
		},
		corsHeaders,
		req,
	);
}

export async function handleMcpStatus(
	req: IncomingMessage,
	res: ServerResponse,
	corsHeaders: Record<string, string>,
) {
	try {
		if (req.method === "GET") {
			const url = new URL(req.url || "/api/mcp", `http://${req.headers.host}`);
			const action = url.searchParams.get("action") || "status";

			if (action === "status") {
				sendJson(res, 200, mcpManager.getStatus(), corsHeaders, req);
				return;
			}

			if (action === "search-registry") {
				await ensureOfficialRegistryLoaded();
				const query = url.searchParams.get("query")?.trim() ?? "";
				const entries = searchOfficialMcpRegistry(query, { limit: 12 });
				sendJson(res, 200, { query, entries }, corsHeaders, req);
				return;
			}

			if (action === "read-resource") {
				const server = url.searchParams.get("server");
				const uri = url.searchParams.get("uri");

				if (!server || !uri) {
					sendJson(
						res,
						400,
						{ error: "Missing required query parameters: server and uri" },
						corsHeaders,
						req,
					);
					return;
				}

				const result = await mcpManager.readResource(server, uri);
				sendJson(res, 200, result, corsHeaders, req);
				return;
			}

			if (action === "get-prompt") {
				const server = url.searchParams.get("server");
				const promptName = url.searchParams.get("name");

				if (!server || !promptName) {
					sendJson(
						res,
						400,
						{ error: "Missing required query parameters: server and name" },
						corsHeaders,
						req,
					);
					return;
				}

				const args: Record<string, string> = {};
				for (const [key, value] of url.searchParams.entries()) {
					if (key.startsWith("arg:")) {
						args[key.slice(4)] = value;
					}
				}

				const result = await mcpManager.getPrompt(
					server,
					promptName,
					Object.keys(args).length > 0 ? args : undefined,
				);
				sendJson(res, 200, result, corsHeaders, req);
				return;
			}

			sendJson(res, 400, { error: "Invalid action" }, corsHeaders, req);
			return;
		}

		if (req.method === "POST") {
			const url = new URL(req.url || "/api/mcp", `http://${req.headers.host}`);
			const action = url.searchParams.get("action") || "import-registry";

			if (action === "import-registry") {
				await handleImportRegistry(req, res, corsHeaders);
				return;
			}

			if (action === "add-server") {
				await handleAddServer(req, res, corsHeaders);
				return;
			}

			if (action === "add-auth-preset") {
				await handleAddAuthPreset(req, res, corsHeaders);
				return;
			}

			if (action === "remove-server") {
				await handleRemoveServer(req, res, corsHeaders);
				return;
			}

			if (action === "remove-auth-preset") {
				await handleRemoveAuthPreset(req, res, corsHeaders);
				return;
			}

			if (action === "update-server") {
				await handleUpdateServer(req, res, corsHeaders);
				return;
			}

			if (action === "update-auth-preset") {
				await handleUpdateAuthPreset(req, res, corsHeaders);
				return;
			}

			if (action === "set-project-approval") {
				await handleSetProjectApproval(req, res, corsHeaders);
				return;
			}

			sendJson(res, 400, { error: "Invalid action" }, corsHeaders, req);
			return;
		}

		sendJson(res, 405, { error: "Method not allowed" }, corsHeaders, req);
	} catch (error) {
		respondWithApiError(res, error, 500, corsHeaders, req);
	}
}
