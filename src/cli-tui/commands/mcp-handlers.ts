import { parseKeyValueTokens } from "@evalops/contracts";
import chalk from "chalk";
import {
	type McpAuthPresetStatus,
	type McpOfficialRegistryEntry,
	type McpServerConfig,
	type McpServerStatus,
	type WritableMcpScope,
	addMcpAuthPresetToConfig,
	addMcpServerToConfig,
	buildSuggestedMcpServerName,
	getOfficialMcpRegistryEntries,
	getOfficialMcpRegistryMatch,
	getOfficialMcpRegistryUrls,
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
import { parseCommandArguments } from "../../tools/shell-utils.js";

type RemoteMcpTransport = "http" | "sse";

type ConfigurableMcpServer = Pick<
	McpServerConfig,
	| "transport"
	| "url"
	| "command"
	| "args"
	| "env"
	| "cwd"
	| "headers"
	| "headersHelper"
	| "authPreset"
>;

export interface McpRenderContext {
	rawInput: string;
	addContent(content: string): void;
	showError(message: string): void;
	requestRender(): void;
}

interface ParsedMcpServerMutationCommand {
	scope?: WritableMcpScope;
	server: {
		name: string;
		transport: "stdio" | "http" | "sse";
		command?: string;
		args?: string[];
		env?: Record<string, string>;
		cwd?: string;
		url?: string;
		headers?: Record<string, string>;
		headersHelper?: string;
		authPreset?: string;
	};
}

interface ParsedMcpAuthPresetMutationCommand {
	scope?: WritableMcpScope;
	preset: {
		name: string;
		headers?: Record<string, string>;
		headersHelper?: string;
	};
}

interface ParsedMcpRemoveCommand {
	name: string;
	scope?: WritableMcpScope;
}

interface ParsedMcpProjectApprovalCommand {
	name: string;
}

interface ParsedMcpImportCommand {
	query: string;
	localName?: string;
	scope: WritableMcpScope;
	url?: string;
	transport?: RemoteMcpTransport;
	headers?: Record<string, string>;
	headersHelper?: string;
	authPreset?: string;
}

const MCP_ADD_USAGE =
	"/mcp add <name> <command-or-url> [args...] [--scope local|project|user] [--transport stdio|http|sse] [--cwd <path>] [--env KEY=value] [--header 'Name: value'] [--headers-helper <command>] [--auth-preset <name>]";
const MCP_EDIT_USAGE =
	"/mcp edit <name> <command-or-url> [args...] [--scope local|project|user] [--transport stdio|http|sse] [--cwd <path>] [--env KEY=value] [--header 'Name: value'] [--headers-helper <command>] [--auth-preset <name>]";
const MCP_REMOVE_USAGE = "/mcp remove <name> [--scope local|project|user]";
const MCP_APPROVE_USAGE = "/mcp approve <name>";
const MCP_DENY_USAGE = "/mcp deny <name>";
const MCP_SEARCH_USAGE = "/mcp search [query]";
const MCP_IMPORT_USAGE =
	"/mcp import <official-id> [name] [--scope local|project|user] [--url <https-url>] [--transport http|sse] [--header 'Name: value'] [--headers-helper <command>] [--auth-preset <name>]";
const MCP_AUTH_USAGE = "/mcp auth [list|add|edit|remove]";
const MCP_AUTH_ADD_USAGE =
	"/mcp auth add <name> [--scope local|project|user] [--header 'Name: value'] [--headers-helper <command>]";
const MCP_AUTH_EDIT_USAGE =
	"/mcp auth edit <name> [--scope local|project|user] [--header 'Name: value'] [--headers-helper <command>]";
const MCP_AUTH_REMOVE_USAGE =
	"/mcp auth remove <name> [--scope local|project|user]";

function formatMcpScopeLabel(scope: McpServerStatus["scope"]): string | null {
	switch (scope) {
		case "enterprise":
			return "Enterprise config";
		case "plugin":
			return "Plugin config";
		case "project":
			return "Project config";
		case "local":
			return "Local config";
		case "user":
			return "User config";
		default:
			return null;
	}
}

function formatMcpTransportLabel(
	transport:
		| McpServerStatus["transport"]
		| McpOfficialRegistryEntry["transport"],
): string {
	switch (transport) {
		case "http":
			return "HTTP";
		case "sse":
			return "SSE";
		case "stdio":
			return "stdio";
		default:
			return "unknown";
	}
}

function formatMcpErrorLabel(error: string | undefined): string | null {
	if (typeof error !== "string") {
		return null;
	}

	return error.trim() || "Connection failed.";
}

function formatMcpTrustLabel(server: McpServerStatus): string | null {
	if (server.transport !== "http" && server.transport !== "sse") {
		return null;
	}

	switch (server.remoteTrust) {
		case "official":
			return server.officialRegistry?.displayName
				? `Official registry (${server.officialRegistry.displayName})`
				: "Official registry";
		case "custom":
			return "Custom remote";
		default:
			return "Unverified remote";
	}
}

function formatMcpProjectApprovalLabel(
	projectApproval: McpServerStatus["projectApproval"],
): string | null {
	switch (projectApproval) {
		case "pending":
			return "Pending local approval";
		case "approved":
			return "Approved locally";
		case "denied":
			return "Denied locally";
		default:
			return null;
	}
}

function getMcpConnectionState(server: McpServerStatus): {
	icon: string;
	label: string;
} {
	switch (server.projectApproval) {
		case "pending":
			return { icon: chalk.yellow("◐"), label: "Pending approval" };
		case "denied":
			return { icon: chalk.red("■"), label: "Denied" };
		default:
			return {
				icon: server.connected ? chalk.green("●") : chalk.red("○"),
				label: server.connected ? "Connected" : "Not connected",
			};
	}
}

function isWritableScope(value: string): value is WritableMcpScope {
	return value === "local" || value === "project" || value === "user";
}

function isMcpTransport(value: string): value is "stdio" | "http" | "sse" {
	return value === "stdio" || value === "http" || value === "sse";
}

function isRemoteMcpTransport(value: string): value is RemoteMcpTransport {
	return value === "http" || value === "sse";
}

function looksLikeRemoteUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function parseTokens(rawInput: string): string[] {
	try {
		return parseCommandArguments(rawInput);
	} catch (error) {
		throw new Error(
			error instanceof Error
				? `Invalid /mcp command: ${error.message}`
				: String(error),
		);
	}
}

function parseMcpPromptInvocationTokens(rawInput: string): {
	serverName?: string;
	promptName?: string;
	args?: Record<string, string>;
} {
	const tokens = parseTokens(rawInput);
	if (tokens[0] !== "/mcp" || tokens[1] !== "prompts") {
		return {};
	}

	const serverName = tokens[2];
	const promptName = tokens[3];
	if (!serverName || !promptName) {
		return { serverName, promptName };
	}

	const parsedArgs = parseKeyValueTokens(
		tokens.slice(4),
		"Invalid MCP prompt argument. Use KEY=value after the prompt name.",
	);
	if (parsedArgs.error) {
		throw new Error(parsedArgs.error);
	}

	return {
		serverName,
		promptName,
		args: parsedArgs.values,
	};
}

function isMcpAuthAlias(value: string | undefined): boolean {
	return value === "auth" || value === "preset" || value === "presets";
}

function parseMcpServerMutationCommand(
	rawInput: string,
	command: "add" | "edit",
	defaultScope?: WritableMcpScope,
): ParsedMcpServerMutationCommand {
	const usage = command === "add" ? MCP_ADD_USAGE : MCP_EDIT_USAGE;
	const tokens = parseTokens(rawInput);

	if (tokens[0] !== "/mcp" || tokens[1] !== command) {
		throw new Error(usage);
	}

	const name = tokens[2];
	if (!name) {
		throw new Error(usage);
	}

	let scope = defaultScope;
	let transport: "stdio" | "http" | "sse" | undefined;
	let cwd: string | undefined;
	let headersHelper: string | undefined;
	let authPreset: string | undefined;
	const headers: Record<string, string> = {};
	const env: Record<string, string> = {};
	const positionals: string[] = [];
	let separatorIndex = -1;

	for (let index = 3; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--") {
			separatorIndex = index;
			break;
		}
		if (token === "--scope" || token === "-s") {
			const value = tokens[index + 1];
			if (!value || !isWritableScope(value)) {
				throw new Error("Invalid MCP scope. Use local, project, or user.");
			}
			scope = value;
			index += 1;
			continue;
		}
		if (token === "--transport" || token === "-t") {
			const value = tokens[index + 1];
			if (!value || !isMcpTransport(value)) {
				throw new Error("Invalid MCP transport. Use stdio, http, or sse.");
			}
			transport = value;
			index += 1;
			continue;
		}
		if (token === "--cwd") {
			const value = tokens[index + 1];
			if (!value) {
				throw new Error("Missing value for --cwd.");
			}
			cwd = value;
			index += 1;
			continue;
		}
		if (token === "--headers-helper") {
			const value = tokens[index + 1];
			if (!value) {
				throw new Error("Missing value for --headers-helper.");
			}
			headersHelper = value;
			index += 1;
			continue;
		}
		if (token === "--auth-preset") {
			const value = tokens[index + 1];
			if (!value) {
				throw new Error("Missing value for --auth-preset.");
			}
			authPreset = value;
			index += 1;
			continue;
		}
		if (token === "--header" || token === "-H") {
			const value = tokens[index + 1];
			if (!value) {
				throw new Error("Missing value for --header.");
			}
			const [headerName, ...rest] = value.split(":");
			const headerValue = rest.join(":").trim();
			if (!headerName?.trim() || headerValue.length === 0) {
				throw new Error(`Invalid MCP header: ${value}`);
			}
			headers[headerName.trim()] = headerValue;
			index += 1;
			continue;
		}
		if (token === "--env" || token === "-e") {
			const value = tokens[index + 1];
			if (!value) {
				throw new Error("Missing value for --env.");
			}
			const separator = value.indexOf("=");
			if (separator <= 0) {
				throw new Error(`Invalid MCP env var: ${value}`);
			}
			const envName = value.slice(0, separator).trim();
			const envValue = value.slice(separator + 1);
			if (!envName) {
				throw new Error(`Invalid MCP env var: ${value}`);
			}
			env[envName] = envValue;
			index += 1;
			continue;
		}

		positionals.push(token);
	}

	const commandTokens =
		separatorIndex >= 0 ? tokens.slice(separatorIndex + 1) : positionals;
	if (commandTokens.length === 0) {
		throw new Error(usage);
	}

	const target = commandTokens[0]!;
	const resolvedTransport =
		transport ??
		(looksLikeRemoteUrl(target) ? inferRemoteMcpTransport(target) : "stdio");

	if (resolvedTransport === "http" || resolvedTransport === "sse") {
		if (!looksLikeRemoteUrl(target)) {
			throw new Error(
				`Remote MCP servers require an http(s) URL target. Received: ${target}`,
			);
		}
		if (commandTokens.length > 1) {
			throw new Error(
				"Remote MCP servers accept a single URL target. Move command arguments after -- only for stdio servers.",
			);
		}
		if (cwd) {
			throw new Error("--cwd is only supported for stdio MCP servers.");
		}
		if (Object.keys(env).length > 0) {
			throw new Error("--env is only supported for stdio MCP servers.");
		}
		return {
			scope,
			server: {
				name,
				transport: resolvedTransport,
				url: target,
				headers: Object.keys(headers).length > 0 ? headers : undefined,
				headersHelper,
				authPreset,
			},
		};
	}

	if (Object.keys(headers).length > 0) {
		throw new Error("--header is only supported for remote MCP servers.");
	}
	if (headersHelper) {
		throw new Error(
			"--headers-helper is only supported for remote MCP servers.",
		);
	}
	if (authPreset) {
		throw new Error("--auth-preset is only supported for remote MCP servers.");
	}

	return {
		scope,
		server: {
			name,
			transport: "stdio",
			command: commandTokens[0],
			args: commandTokens.slice(1),
			env: Object.keys(env).length > 0 ? env : undefined,
			cwd,
		},
	};
}

function parseMcpRemoveCommand(rawInput: string): ParsedMcpRemoveCommand {
	const tokens = parseTokens(rawInput);
	if (tokens[0] !== "/mcp" || tokens[1] !== "remove") {
		throw new Error(MCP_REMOVE_USAGE);
	}

	const name = tokens[2];
	if (!name) {
		throw new Error(MCP_REMOVE_USAGE);
	}

	let scope: WritableMcpScope | undefined;
	for (let index = 3; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--scope" || token === "-s") {
			const value = tokens[index + 1];
			if (!value || !isWritableScope(value)) {
				throw new Error("Invalid MCP scope. Use local, project, or user.");
			}
			scope = value;
			index += 1;
			continue;
		}
		throw new Error(MCP_REMOVE_USAGE);
	}

	return { name, scope };
}

function parseMcpProjectApprovalCommand(
	rawInput: string,
	command: "approve" | "deny",
): ParsedMcpProjectApprovalCommand {
	const tokens = parseTokens(rawInput);
	const usage = command === "approve" ? MCP_APPROVE_USAGE : MCP_DENY_USAGE;
	if (tokens[0] !== "/mcp" || tokens[1] !== command) {
		throw new Error(usage);
	}

	const name = tokens[2];
	if (!name || tokens.length !== 3) {
		throw new Error(usage);
	}

	return { name };
}

function parseMcpSearchQuery(rawInput: string): string {
	const tokens = parseTokens(rawInput);
	if (
		tokens[0] !== "/mcp" ||
		(tokens[1] !== "search" && tokens[1] !== "registry")
	) {
		throw new Error(MCP_SEARCH_USAGE);
	}
	return tokens.slice(2).join(" ").trim();
}

function parseMcpImportCommand(rawInput: string): ParsedMcpImportCommand {
	const tokens = parseTokens(rawInput);
	if (tokens[0] !== "/mcp" || tokens[1] !== "import") {
		throw new Error(MCP_IMPORT_USAGE);
	}

	const query = tokens[2];
	if (!query) {
		throw new Error(MCP_IMPORT_USAGE);
	}

	let localName: string | undefined;
	let scope: WritableMcpScope = "local";
	let url: string | undefined;
	let transport: RemoteMcpTransport | undefined;
	let headersHelper: string | undefined;
	let authPreset: string | undefined;
	const headers: Record<string, string> = {};

	for (let index = 3; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--scope" || token === "-s") {
			const value = tokens[index + 1];
			if (!value || !isWritableScope(value)) {
				throw new Error("Invalid MCP scope. Use local, project, or user.");
			}
			scope = value;
			index += 1;
			continue;
		}
		if (token === "--url") {
			const value = tokens[index + 1];
			if (!value || !looksLikeRemoteUrl(value)) {
				throw new Error("Provide a valid http(s) URL for --url.");
			}
			url = value;
			index += 1;
			continue;
		}
		if (token === "--transport" || token === "-t") {
			const value = tokens[index + 1];
			if (!value || !isRemoteMcpTransport(value)) {
				throw new Error("Invalid MCP transport. Use http or sse.");
			}
			transport = value;
			index += 1;
			continue;
		}
		if (token === "--headers-helper") {
			const value = tokens[index + 1];
			if (!value) {
				throw new Error("Missing value for --headers-helper.");
			}
			headersHelper = value;
			index += 1;
			continue;
		}
		if (token === "--auth-preset") {
			const value = tokens[index + 1];
			if (!value) {
				throw new Error("Missing value for --auth-preset.");
			}
			authPreset = value;
			index += 1;
			continue;
		}
		if (token === "--header" || token === "-H") {
			const value = tokens[index + 1];
			if (!value) {
				throw new Error("Missing value for --header.");
			}
			const [headerName, ...rest] = value.split(":");
			const headerValue = rest.join(":").trim();
			if (!headerName?.trim() || headerValue.length === 0) {
				throw new Error(`Invalid MCP header: ${value}`);
			}
			headers[headerName.trim()] = headerValue;
			index += 1;
			continue;
		}
		if (token.startsWith("-")) {
			throw new Error(MCP_IMPORT_USAGE);
		}
		if (!localName) {
			localName = token;
			continue;
		}
		throw new Error(MCP_IMPORT_USAGE);
	}

	return {
		query,
		localName,
		scope,
		url,
		transport,
		headers: Object.keys(headers).length > 0 ? headers : undefined,
		headersHelper,
		authPreset,
	};
}

function parseMcpAuthPresetMutationCommand(
	rawInput: string,
	command: "add" | "edit",
	defaultScope?: WritableMcpScope,
): ParsedMcpAuthPresetMutationCommand {
	const usage = command === "add" ? MCP_AUTH_ADD_USAGE : MCP_AUTH_EDIT_USAGE;
	const tokens = parseTokens(rawInput);

	if (
		tokens[0] !== "/mcp" ||
		!isMcpAuthAlias(tokens[1]) ||
		tokens[2] !== command
	) {
		throw new Error(usage);
	}

	const name = tokens[3];
	if (!name) {
		throw new Error(usage);
	}

	let scope = defaultScope;
	let headersHelper: string | undefined;
	const headers: Record<string, string> = {};

	for (let index = 4; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--scope" || token === "-s") {
			const value = tokens[index + 1];
			if (!value || !isWritableScope(value)) {
				throw new Error("Invalid MCP scope. Use local, project, or user.");
			}
			scope = value;
			index += 1;
			continue;
		}
		if (token === "--headers-helper") {
			const value = tokens[index + 1];
			if (!value) {
				throw new Error("Missing value for --headers-helper.");
			}
			headersHelper = value;
			index += 1;
			continue;
		}
		if (token === "--header" || token === "-H") {
			const value = tokens[index + 1];
			if (!value) {
				throw new Error("Missing value for --header.");
			}
			const [headerName, ...rest] = value.split(":");
			const headerValue = rest.join(":").trim();
			if (!headerName?.trim() || headerValue.length === 0) {
				throw new Error(`Invalid MCP header: ${value}`);
			}
			headers[headerName.trim()] = headerValue;
			index += 1;
			continue;
		}
		throw new Error(usage);
	}

	if (Object.keys(headers).length === 0 && !headersHelper) {
		throw new Error(
			"MCP auth presets require at least one --header or --headers-helper value.",
		);
	}

	return {
		scope,
		preset: {
			name,
			headers: Object.keys(headers).length > 0 ? headers : undefined,
			headersHelper,
		},
	};
}

function parseMcpAuthPresetRemoveCommand(
	rawInput: string,
): ParsedMcpRemoveCommand {
	const tokens = parseTokens(rawInput);
	if (
		tokens[0] !== "/mcp" ||
		!isMcpAuthAlias(tokens[1]) ||
		tokens[2] !== "remove"
	) {
		throw new Error(MCP_AUTH_REMOVE_USAGE);
	}

	const name = tokens[3];
	if (!name) {
		throw new Error(MCP_AUTH_REMOVE_USAGE);
	}

	let scope: WritableMcpScope | undefined;
	for (let index = 4; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--scope" || token === "-s") {
			const value = tokens[index + 1];
			if (!value || !isWritableScope(value)) {
				throw new Error("Invalid MCP scope. Use local, project, or user.");
			}
			scope = value;
			index += 1;
			continue;
		}
		throw new Error(MCP_AUTH_REMOVE_USAGE);
	}

	return { name, scope };
}

function resolveKnownAuthPresetName(
	projectRoot: string,
	authPreset: string | undefined,
): void {
	if (!authPreset) {
		return;
	}
	const existingPreset = (loadMcpConfig(projectRoot).authPresets ?? []).find(
		(preset) => preset.name === authPreset,
	);
	if (!existingPreset) {
		throw new Error(
			`MCP auth preset "${authPreset}" not found in merged config.`,
		);
	}
}

async function reloadMcpManager(projectRoot: string) {
	const nextConfig = loadMcpConfig(projectRoot, { includeEnvLimits: true });
	await mcpManager.configure(nextConfig);
	return nextConfig;
}

async function ensureOfficialRegistryLoaded(): Promise<
	McpOfficialRegistryEntry[]
> {
	await prefetchOfficialMcpRegistry();
	const entries = getOfficialMcpRegistryEntries();
	if (entries.length === 0) {
		throw new Error("Official MCP registry metadata is unavailable right now.");
	}
	return entries;
}

function formatOfficialRegistryIdentifier(
	entry: Pick<McpOfficialRegistryEntry, "slug" | "serverName">,
): string | undefined {
	return entry.slug ?? entry.serverName;
}

function appendConfiguredServerSummary(
	lines: string[],
	server: ConfigurableMcpServer,
): void {
	lines.push(`  transport: ${server.transport}`);

	if (server.url) {
		lines.push(`  remote: ${server.url}`);
		const registryMatch = getOfficialMcpRegistryMatch(server.url);
		if (registryMatch.trust === "official") {
			lines.push(
				`  trust: official${registryMatch.info?.displayName ? ` (${registryMatch.info.displayName})` : ""}`,
			);
			if (registryMatch.info?.documentationUrl) {
				lines.push(`  docs: ${registryMatch.info.documentationUrl}`);
			}
		} else if (registryMatch.trust === "custom") {
			lines.push("  trust: custom");
		}
		if (server.headers && Object.keys(server.headers).length > 0) {
			lines.push(`  headers: ${Object.keys(server.headers).join(", ")}`);
		}
		if (server.headersHelper) {
			lines.push(`  headers helper: ${server.headersHelper}`);
		}
		if (server.authPreset) {
			lines.push(`  auth preset: ${server.authPreset}`);
		}
		return;
	}

	lines.push(`  command: ${server.command}`);
	if (server.args?.length) {
		lines.push(`  args: ${server.args.join(" ")}`);
	}
	if (server.cwd) {
		lines.push(`  cwd: ${server.cwd}`);
	}
	if (server.env && Object.keys(server.env).length > 0) {
		lines.push(`  env: ${Object.keys(server.env).join(", ")}`);
	}
}

function renderOfficialRegistryResults(
	renderCtx: McpRenderContext,
	title: string,
	entries: McpOfficialRegistryEntry[],
	footer?: string,
): void {
	const lines: string[] = [title, ""];

	for (const [index, entry] of entries.entries()) {
		lines.push(`${index + 1}. ${entry.displayName}`);
		const registryId = formatOfficialRegistryIdentifier(entry);
		if (registryId) {
			lines.push(`    id: ${registryId}`);
		}
		if (entry.transport) {
			lines.push(`    transport: ${formatMcpTransportLabel(entry.transport)}`);
		}
		const urls = getOfficialMcpRegistryUrls(entry);
		if (urls.length === 1) {
			lines.push(`    url: ${urls[0]}`);
		} else if (urls.length > 1) {
			lines.push(`    url: ${urls[0]} (+${urls.length - 1} more)`);
		} else if (entry.urlRegex) {
			lines.push(`    url pattern: ${entry.urlRegex}`);
		}
		if (entry.oneLiner) {
			lines.push(`    summary: ${entry.oneLiner}`);
		}
		if (entry.documentationUrl) {
			lines.push(`    docs: ${entry.documentationUrl}`);
		}
		lines.push("");
	}

	if (footer) {
		lines.push(chalk.dim(footer));
	}

	renderCtx.addContent(lines.join("\n").trimEnd());
	renderCtx.requestRender();
}

function appendAuthPresetSummary(
	lines: string[],
	preset: {
		name: string;
		scope?: McpAuthPresetStatus["scope"];
		headers?: Record<string, string>;
		headerKeys?: string[];
		headersHelper?: string;
	},
): void {
	lines.push(preset.name);
	const scopeLabel = formatMcpScopeLabel(preset.scope);
	if (scopeLabel) {
		lines.push(`    Source: ${scopeLabel}`);
	}
	const headerKeys =
		preset.headerKeys ??
		(preset.headers ? Object.keys(preset.headers).sort() : undefined);
	if (headerKeys && headerKeys.length > 0) {
		lines.push(`    Header keys: ${headerKeys.join(", ")}`);
	}
	if (preset.headersHelper) {
		lines.push(`    Headers helper: ${preset.headersHelper}`);
	}
}

function appendConfiguredAuthPresetDetails(
	lines: string[],
	preset: {
		headers?: Record<string, string>;
		headerKeys?: string[];
		headersHelper?: string;
	},
): void {
	const headerKeys =
		preset.headerKeys ??
		(preset.headers ? Object.keys(preset.headers).sort() : undefined);
	if (headerKeys && headerKeys.length > 0) {
		lines.push(`  headers: ${headerKeys.join(", ")}`);
	}
	if (preset.headersHelper) {
		lines.push(`  headers helper: ${preset.headersHelper}`);
	}
}

function formatMcpPromptArgumentSummary(
	server: McpServerStatus,
	promptName: string,
): string | null {
	const prompt = server.promptDetails?.find(
		(entry) => entry.name === promptName,
	);
	const promptArguments = prompt?.arguments ?? [];
	if (!prompt || promptArguments.length === 0) {
		return null;
	}

	return promptArguments
		.map((argument) => {
			const summary = argument.required
				? `${argument.name} (required)`
				: argument.name;
			return argument.description
				? `${summary}: ${argument.description}`
				: summary;
		})
		.join("; ");
}

function appendMcpPromptSummary(
	lines: string[],
	server: McpServerStatus,
	promptName: string,
	indent = "  ",
): void {
	lines.push(`${indent}${promptName}`);
	const prompt = server.promptDetails?.find(
		(entry) => entry.name === promptName,
	);
	if (!prompt) {
		return;
	}

	const detailIndent = `${indent}  `;
	if (prompt.title && prompt.title !== promptName) {
		lines.push(`${detailIndent}Title: ${prompt.title}`);
	}
	if (prompt.description) {
		lines.push(`${detailIndent}Description: ${prompt.description}`);
	}
	const argumentSummary = formatMcpPromptArgumentSummary(server, promptName);
	if (argumentSummary) {
		lines.push(`${detailIndent}Args: ${argumentSummary}`);
	}
}

export function formatMcpPromptList(
	servers: McpServerStatus[],
	serverName?: string,
): string {
	const lines: string[] = ["MCP Prompts", ""];
	const visibleServers = serverName
		? servers.filter((entry) => entry.name === serverName)
		: servers;

	if (serverName && visibleServers.length === 0) {
		lines.push(`Server '${serverName}' not found`);
	} else if (serverName && !visibleServers[0]?.connected) {
		lines.push(`Server '${serverName}' not connected`);
	} else {
		const connectedWithPrompts = visibleServers
			.filter((server) => server.connected)
			.filter((server) => server.prompts.length > 0);

		if (connectedWithPrompts.length === 0) {
			lines.push(
				serverName
					? `Server '${serverName}' does not expose prompts.`
					: "No prompts available from connected servers.",
			);
		} else {
			for (const server of connectedWithPrompts) {
				lines.push(`${chalk.bold(server.name)}:`);
				for (const prompt of server.prompts) {
					appendMcpPromptSummary(lines, server, prompt);
				}
				lines.push("");
			}
		}
	}

	lines.push("");
	lines.push(chalk.dim("Usage: /mcp prompts <server> <name> [KEY=value ...]"));
	return lines.join("\n");
}

function renderMcpStatus(renderCtx: McpRenderContext): void {
	const status = mcpManager.getStatus();
	const lines: string[] = ["Model Context Protocol", ""];

	if (status.authPresets.length > 0) {
		lines.push("Auth presets", "");
		for (const preset of status.authPresets) {
			appendAuthPresetSummary(lines, preset);
			lines.push("");
		}
	}

	if (status.servers.length === 0) {
		if (status.authPresets.length > 0) {
			lines.push("Servers", "");
		}
		lines.push(
			"No MCP servers configured.",
			"",
			"Add servers to ~/.maestro/mcp.json, .maestro/mcp.json, or use /mcp:",
			"",
			"  /mcp search linear",
			"  /mcp import linear",
			"  /mcp add linear https://mcp.linear.app/mcp",
			"  /mcp add linear https://mcp.linear.app/mcp --auth-preset linear-auth",
			"  /mcp auth add linear-auth --header 'Authorization: Bearer ...'",
			"  /mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .",
			"",
			'  { "mcpServers": { "my-server": { "command": "npx", "args": ["-y", "@example/mcp-server"] } } }',
		);
	} else {
		if (status.authPresets.length > 0) {
			lines.push("Servers", "");
		}
		for (const server of status.servers) {
			const connectionState = getMcpConnectionState(server);
			lines.push(`${connectionState.icon} ${server.name}`);
			const scopeLabel = formatMcpScopeLabel(server.scope);
			if (scopeLabel) {
				lines.push(`    Source: ${scopeLabel}`);
			}
			lines.push(`    Status: ${connectionState.label}`);
			lines.push(`    Transport: ${formatMcpTransportLabel(server.transport)}`);
			if (server.remoteUrl) {
				lines.push(`    Remote: ${server.remoteUrl}`);
			}
			if (server.authPreset) {
				lines.push(`    Auth preset: ${server.authPreset}`);
			}
			if (server.headerKeys && server.headerKeys.length > 0) {
				lines.push(`    Header keys: ${server.headerKeys.join(", ")}`);
			}
			if (server.headersHelper) {
				lines.push(`    Headers helper: ${server.headersHelper}`);
			}
			const trustLabel = formatMcpTrustLabel(server);
			if (trustLabel) {
				lines.push(`    Trust: ${trustLabel}`);
			}
			const approvalLabel = formatMcpProjectApprovalLabel(
				server.projectApproval,
			);
			if (approvalLabel) {
				lines.push(`    Approval: ${approvalLabel}`);
			}
			if (server.officialRegistry?.documentationUrl) {
				lines.push(`    Docs: ${server.officialRegistry.documentationUrl}`);
			}
			if (server.officialRegistry?.permissions) {
				lines.push(`    Permissions: ${server.officialRegistry.permissions}`);
			}
			if (server.connected) {
				if (server.tools.length > 0) {
					lines.push(
						`    Tools: ${server.tools.map((tool) => tool.name).join(", ")}`,
					);
				}
				if (server.resources.length > 0) {
					lines.push(`    Resources: ${server.resources.length}`);
				}
				if (server.prompts.length > 0) {
					lines.push(`    Prompts: ${server.prompts.join(", ")}`);
				}
			} else if (
				server.projectApproval === "pending" ||
				server.projectApproval === "denied"
			) {
				lines.push(
					`    ${chalk.dim("Connection is blocked by local approval state")}`,
				);
			} else {
				lines.push(`    ${chalk.dim("Not connected")}`);
				const errorLabel = formatMcpErrorLabel(server.error);
				if (errorLabel) {
					lines.push(`    ${chalk.red(`Error: ${errorLabel}`)}`);
				}
			}
		}
	}

	lines.push("");
	lines.push(
		chalk.dim(
			"Subcommands: /mcp add, /mcp edit, /mcp remove, /mcp approve, /mcp deny, /mcp search, /mcp import, /mcp auth, /mcp resources, /mcp prompts",
		),
	);

	renderCtx.addContent(lines.join("\n").trimEnd());
	renderCtx.requestRender();
}

export function handleMcpCommand(renderCtx: McpRenderContext): void {
	const args = renderCtx.rawInput.replace(/^\/mcp\s*/, "").trim();
	const parts = args.split(/\s+/);
	const subcommand = parts[0]?.toLowerCase() || "";

	if (subcommand === "add") {
		void handleMcpAddCommand(renderCtx);
		return;
	}
	if (subcommand === "edit") {
		void handleMcpEditCommand(renderCtx);
		return;
	}
	if (subcommand === "remove") {
		void handleMcpRemoveCommand(renderCtx);
		return;
	}
	if (subcommand === "approve") {
		void handleMcpProjectApprovalCommand(renderCtx, "approve");
		return;
	}
	if (subcommand === "deny") {
		void handleMcpProjectApprovalCommand(renderCtx, "deny");
		return;
	}
	if (subcommand === "search" || subcommand === "registry") {
		void handleMcpSearchCommand(renderCtx);
		return;
	}
	if (subcommand === "import") {
		void handleMcpImportCommand(renderCtx);
		return;
	}
	if (isMcpAuthAlias(subcommand)) {
		void handleMcpAuthCommand(renderCtx);
		return;
	}
	if (subcommand === "resources") {
		handleMcpResourcesCommand(parts.slice(1), renderCtx);
		return;
	}
	if (subcommand === "prompts") {
		handleMcpPromptsCommand(parts.slice(1), renderCtx);
		return;
	}

	renderMcpStatus(renderCtx);
}

async function handleMcpAddCommand(renderCtx: McpRenderContext): Promise<void> {
	try {
		const projectRoot = process.cwd();
		const parsed = parseMcpServerMutationCommand(
			renderCtx.rawInput,
			"add",
			"local",
		);
		const existingServer = loadMcpConfig(projectRoot).servers.find(
			(server) => server.name === parsed.server.name,
		);
		if (existingServer) {
			throw new Error(
				`MCP server "${parsed.server.name}" already exists in merged config (scope: ${existingServer.scope ?? "unknown"}). Choose a different name.`,
			);
		}
		resolveKnownAuthPresetName(projectRoot, parsed.server.authPreset);

		if (parsed.server.url) {
			await prefetchOfficialMcpRegistry();
		}

		const { path } = addMcpServerToConfig({
			projectRoot,
			scope: parsed.scope ?? "local",
			server: parsed.server,
		});
		await reloadMcpManager(projectRoot);

		const lines = [
			`Added MCP server "${parsed.server.name}"`,
			`  scope: ${parsed.scope ?? "local"}`,
			`  path: ${path}`,
		];
		appendConfiguredServerSummary(lines, parsed.server);

		renderCtx.addContent(lines.join("\n"));
		renderCtx.requestRender();
	} catch (error) {
		renderCtx.showError(error instanceof Error ? error.message : String(error));
	}
}

async function handleMcpEditCommand(
	renderCtx: McpRenderContext,
): Promise<void> {
	try {
		const projectRoot = process.cwd();
		const parsed = parseMcpServerMutationCommand(renderCtx.rawInput, "edit");
		const currentConfig = loadMcpConfig(projectRoot);
		const existingServer = currentConfig.servers.find(
			(server) => server.name === parsed.server.name,
		);
		if (!existingServer) {
			throw new Error(
				`MCP server "${parsed.server.name}" not found in merged config.`,
			);
		}
		resolveKnownAuthPresetName(projectRoot, parsed.server.authPreset);

		if (existingServer.url || parsed.server.url) {
			await prefetchOfficialMcpRegistry();
		}

		const { path, scope } = updateMcpServerInConfig({
			projectRoot,
			scope: parsed.scope,
			name: parsed.server.name,
			server: parsed.server,
		});
		const reloadedConfig = await reloadMcpManager(projectRoot);
		const activeServer = reloadedConfig.servers.find(
			(server) => server.name === parsed.server.name,
		);

		const lines = [
			`Updated MCP server "${parsed.server.name}"`,
			`  scope: ${scope}`,
			`  path: ${path}`,
		];
		appendConfiguredServerSummary(lines, activeServer ?? parsed.server);

		renderCtx.addContent(lines.join("\n"));
		renderCtx.requestRender();
	} catch (error) {
		renderCtx.showError(error instanceof Error ? error.message : String(error));
	}
}

async function handleMcpRemoveCommand(
	renderCtx: McpRenderContext,
): Promise<void> {
	try {
		const projectRoot = process.cwd();
		const parsed = parseMcpRemoveCommand(renderCtx.rawInput);
		const { path, scope } = removeMcpServerFromConfig({
			projectRoot,
			scope: parsed.scope,
			name: parsed.name,
		});
		const reloadedConfig = await reloadMcpManager(projectRoot);
		const fallbackServer = reloadedConfig.servers.find(
			(server) => server.name === parsed.name,
		);

		const lines = [
			`Removed MCP server "${parsed.name}"`,
			`  scope: ${scope}`,
			`  path: ${path}`,
		];
		if (fallbackServer) {
			lines.push(
				`  fallback: now using ${formatMcpScopeLabel(fallbackServer.scope) ?? fallbackServer.scope ?? "another"} for "${parsed.name}"`,
			);
		} else {
			lines.push("  status: removed from merged config");
		}

		renderCtx.addContent(lines.join("\n"));
		renderCtx.requestRender();
	} catch (error) {
		renderCtx.showError(error instanceof Error ? error.message : String(error));
	}
}

async function handleMcpProjectApprovalCommand(
	renderCtx: McpRenderContext,
	command: "approve" | "deny",
): Promise<void> {
	try {
		const projectRoot = process.cwd();
		const parsed = parseMcpProjectApprovalCommand(renderCtx.rawInput, command);
		const currentConfig = loadMcpConfig(projectRoot);
		const existingServer = currentConfig.servers.find(
			(server) => server.name === parsed.name,
		);
		if (!existingServer) {
			throw new Error(
				`MCP server "${parsed.name}" not found in merged config.`,
			);
		}
		if (existingServer.scope !== "project") {
			throw new Error(
				`MCP server "${parsed.name}" is not loaded from project config.`,
			);
		}

		const decision = command === "approve" ? "approved" : "denied";
		setProjectMcpServerApprovalDecision({
			projectRoot,
			server: existingServer,
			authPresets: currentConfig.authPresets,
			decision,
		});
		await reloadMcpManager(projectRoot);

		renderCtx.addContent(
			decision === "approved"
				? `Approved project MCP server "${parsed.name}".`
				: `Denied project MCP server "${parsed.name}".`,
		);
		renderCtx.requestRender();
	} catch (error) {
		renderCtx.showError(error instanceof Error ? error.message : String(error));
	}
}

async function handleMcpSearchCommand(
	renderCtx: McpRenderContext,
): Promise<void> {
	try {
		await ensureOfficialRegistryLoaded();
		const query = parseMcpSearchQuery(renderCtx.rawInput);
		const matches = searchOfficialMcpRegistry(query, { limit: 8 });
		if (matches.length === 0) {
			renderCtx.addContent(
				[
					query
						? `Official MCP Registry matches for "${query}"`
						: "Official MCP Registry",
					"",
					query
						? `No matches found for "${query}".`
						: "No official MCP registry entries available.",
				].join("\n"),
			);
			renderCtx.requestRender();
			return;
		}

		renderOfficialRegistryResults(
			renderCtx,
			query
				? `Official MCP Registry matches for "${query}"`
				: "Official MCP Registry",
			matches,
			"Use /mcp import <id> [name] to add one of these servers.",
		);
	} catch (error) {
		renderCtx.showError(error instanceof Error ? error.message : String(error));
	}
}

async function handleMcpImportCommand(
	renderCtx: McpRenderContext,
): Promise<void> {
	try {
		const projectRoot = process.cwd();
		const parsed = parseMcpImportCommand(renderCtx.rawInput);
		await ensureOfficialRegistryLoaded();

		const { entry, matches } = resolveOfficialMcpRegistryEntry(parsed.query);
		if (!entry) {
			if (matches.length > 0) {
				renderOfficialRegistryResults(
					renderCtx,
					`Multiple official MCP registry matches for "${parsed.query}"`,
					matches,
					"Use a more specific id, or inspect candidates with /mcp search <query>.",
				);
				return;
			}
			throw new Error(
				`No official MCP registry match found for "${parsed.query}". Try /mcp search ${parsed.query}`,
			);
		}

		const localName = parsed.localName ?? buildSuggestedMcpServerName(entry);
		const existingServer = loadMcpConfig(projectRoot).servers.find(
			(server) => server.name === localName,
		);
		if (existingServer) {
			throw new Error(
				`MCP server "${localName}" already exists in merged config (scope: ${existingServer.scope ?? "unknown"}). Choose a different name.`,
			);
		}
		resolveKnownAuthPresetName(projectRoot, parsed.authPreset);

		const resolvedUrl = parsed.url ?? entry.url ?? entry.urlOptions?.[0]?.url;
		if (!resolvedUrl) {
			throw new Error(
				`Official MCP registry entry "${entry.displayName}" requires --url because it does not publish a default remote URL.`,
			);
		}
		if (!looksLikeRemoteUrl(resolvedUrl)) {
			throw new Error(
				`Official MCP URL must be http(s). Received: ${resolvedUrl}`,
			);
		}
		if (parsed.url && !officialMcpRegistryEntryMatchesUrl(entry, parsed.url)) {
			throw new Error(
				`URL does not match the official MCP registry entry "${entry.displayName}".`,
			);
		}

		const transport =
			parsed.transport ??
			entry.transport ??
			inferRemoteMcpTransport(resolvedUrl);
		const { path } = addMcpServerToConfig({
			projectRoot,
			scope: parsed.scope,
			server: {
				name: localName,
				transport,
				url: resolvedUrl,
				headers: parsed.headers,
				headersHelper: parsed.headersHelper,
				authPreset: parsed.authPreset,
			},
		});
		await reloadMcpManager(projectRoot);

		const lines = [
			`Imported official MCP server "${localName}"`,
			`  scope: ${parsed.scope}`,
			`  path: ${path}`,
		];
		const registryId = formatOfficialRegistryIdentifier(entry);
		if (registryId) {
			lines.push(`  registry id: ${registryId}`);
		}
		lines.push(`  source: ${entry.displayName}`);
		appendConfiguredServerSummary(lines, {
			transport,
			url: resolvedUrl,
			headers: parsed.headers,
			headersHelper: parsed.headersHelper,
			authPreset: parsed.authPreset,
		});

		renderCtx.addContent(lines.join("\n"));
		renderCtx.requestRender();
	} catch (error) {
		renderCtx.showError(error instanceof Error ? error.message : String(error));
	}
}

async function handleMcpAuthCommand(
	renderCtx: McpRenderContext,
): Promise<void> {
	try {
		const tokens = parseTokens(renderCtx.rawInput);
		const subcommand = tokens[2]?.toLowerCase() ?? "list";

		if (subcommand === "list") {
			const status = mcpManager.getStatus();
			const lines: string[] = ["MCP Auth Presets", ""];

			if (status.authPresets.length === 0) {
				lines.push(
					"No MCP auth presets configured.",
					"",
					"Examples:",
					"  /mcp auth add linear-auth --header 'Authorization: Bearer ...'",
					"  /mcp add linear https://mcp.linear.app/mcp --auth-preset linear-auth",
				);
			} else {
				for (const preset of status.authPresets) {
					appendAuthPresetSummary(lines, preset);
					lines.push("");
				}
				lines.push(
					chalk.dim(
						"Usage: /mcp auth add|edit|remove <name> [--scope ...] [--header ...] [--headers-helper ...]",
					),
				);
			}

			renderCtx.addContent(lines.join("\n").trimEnd());
			renderCtx.requestRender();
			return;
		}

		if (subcommand === "add") {
			await handleMcpAuthAddCommand(renderCtx);
			return;
		}
		if (subcommand === "edit") {
			await handleMcpAuthEditCommand(renderCtx);
			return;
		}
		if (subcommand === "remove") {
			await handleMcpAuthRemoveCommand(renderCtx);
			return;
		}

		renderCtx.showError(MCP_AUTH_USAGE);
	} catch (error) {
		renderCtx.showError(error instanceof Error ? error.message : String(error));
	}
}

async function handleMcpAuthAddCommand(
	renderCtx: McpRenderContext,
): Promise<void> {
	try {
		const projectRoot = process.cwd();
		const parsed = parseMcpAuthPresetMutationCommand(
			renderCtx.rawInput,
			"add",
			"local",
		);
		const existingPreset = loadMcpConfig(projectRoot).authPresets.find(
			(preset) => preset.name === parsed.preset.name,
		);
		if (existingPreset) {
			throw new Error(
				`MCP auth preset "${parsed.preset.name}" already exists in merged config (scope: ${existingPreset.scope ?? "unknown"}). Choose a different name.`,
			);
		}

		const { path } = addMcpAuthPresetToConfig({
			projectRoot,
			scope: parsed.scope ?? "local",
			preset: parsed.preset,
		});
		await reloadMcpManager(projectRoot);

		const lines = [
			`Added MCP auth preset "${parsed.preset.name}"`,
			`  scope: ${parsed.scope ?? "local"}`,
			`  path: ${path}`,
		];
		appendConfiguredAuthPresetDetails(lines, parsed.preset);

		renderCtx.addContent(lines.join("\n"));
		renderCtx.requestRender();
	} catch (error) {
		renderCtx.showError(error instanceof Error ? error.message : String(error));
	}
}

async function handleMcpAuthEditCommand(
	renderCtx: McpRenderContext,
): Promise<void> {
	try {
		const projectRoot = process.cwd();
		const parsed = parseMcpAuthPresetMutationCommand(
			renderCtx.rawInput,
			"edit",
		);
		const currentConfig = loadMcpConfig(projectRoot);
		const existingPreset = currentConfig.authPresets.find(
			(preset) => preset.name === parsed.preset.name,
		);
		if (!existingPreset) {
			throw new Error(
				`MCP auth preset "${parsed.preset.name}" not found in merged config.`,
			);
		}

		const { path, scope } = updateMcpAuthPresetInConfig({
			projectRoot,
			scope: parsed.scope,
			name: parsed.preset.name,
			preset: parsed.preset,
		});
		const reloadedConfig = await reloadMcpManager(projectRoot);
		const activePreset = reloadedConfig.authPresets.find(
			(preset) => preset.name === parsed.preset.name,
		);

		const lines = [
			`Updated MCP auth preset "${parsed.preset.name}"`,
			`  scope: ${scope}`,
			`  path: ${path}`,
		];
		appendConfiguredAuthPresetDetails(lines, activePreset ?? parsed.preset);

		renderCtx.addContent(lines.join("\n"));
		renderCtx.requestRender();
	} catch (error) {
		renderCtx.showError(error instanceof Error ? error.message : String(error));
	}
}

async function handleMcpAuthRemoveCommand(
	renderCtx: McpRenderContext,
): Promise<void> {
	try {
		const projectRoot = process.cwd();
		const parsed = parseMcpAuthPresetRemoveCommand(renderCtx.rawInput);
		const { path, scope } = removeMcpAuthPresetFromConfig({
			projectRoot,
			scope: parsed.scope,
			name: parsed.name,
		});
		const reloadedConfig = await reloadMcpManager(projectRoot);
		const fallbackPreset = reloadedConfig.authPresets.find(
			(preset) => preset.name === parsed.name,
		);

		const lines = [
			`Removed MCP auth preset "${parsed.name}"`,
			`  scope: ${scope}`,
			`  path: ${path}`,
		];
		if (fallbackPreset) {
			lines.push(
				`  fallback: now using ${formatMcpScopeLabel(fallbackPreset.scope) ?? fallbackPreset.scope ?? "another"} for "${parsed.name}"`,
			);
		} else {
			lines.push("  status: removed from merged config");
		}

		renderCtx.addContent(lines.join("\n"));
		renderCtx.requestRender();
	} catch (error) {
		renderCtx.showError(error instanceof Error ? error.message : String(error));
	}
}

export function handleMcpResourcesCommand(
	args: string[],
	renderCtx: McpRenderContext,
): void {
	const status = mcpManager.getStatus();
	const lines: string[] = ["MCP Resources", ""];

	if (args.length >= 2) {
		const serverName = args[0]!;
		const uri = args.slice(1).join(" ");
		const server = status.servers.find((entry) => entry.name === serverName);
		if (!server?.connected) {
			lines.push(`Server '${serverName}' not connected`);
		} else {
			mcpManager
				.readResource(serverName, uri)
				.then((result) => {
					const resourceLines = [`Resource: ${uri}`, ""];
					for (const content of result.contents) {
						if (content.text) {
							resourceLines.push(content.text);
						} else if (content.blob) {
							resourceLines.push(
								`[Binary data: ${content.mimeType || "unknown type"}]`,
							);
						}
					}
					renderCtx.addContent(resourceLines.join("\n"));
					renderCtx.requestRender();
				})
				.catch((error: unknown) => {
					const message =
						error instanceof Error ? error.message : String(error);
					renderCtx.showError(`Failed to read resource: ${message}`);
				});
			return;
		}
	} else {
		let hasResources = false;
		for (const server of status.servers) {
			if (!server.connected || server.resources.length === 0) continue;
			hasResources = true;
			lines.push(`${chalk.bold(server.name)}:`);
			for (const uri of server.resources) {
				lines.push(`  ${uri}`);
			}
			lines.push("");
		}
		if (!hasResources) {
			lines.push("No resources available from connected servers.");
		}
		lines.push("");
		lines.push(chalk.dim("Usage: /mcp resources <server> <uri>"));
	}

	renderCtx.addContent(lines.join("\n"));
	renderCtx.requestRender();
}

export function handleMcpPromptsCommand(
	args: string[],
	renderCtx: McpRenderContext,
): void {
	const status = mcpManager.getStatus();
	const lines: string[] = ["MCP Prompts", ""];

	if (args.length >= 2) {
		let promptInvocation: ReturnType<typeof parseMcpPromptInvocationTokens>;
		try {
			promptInvocation = parseMcpPromptInvocationTokens(renderCtx.rawInput);
		} catch (error) {
			renderCtx.showError(
				error instanceof Error ? error.message : String(error),
			);
			return;
		}
		const serverName = promptInvocation.serverName ?? args[0]!;
		const promptName = promptInvocation.promptName ?? args[1]!;
		const server = status.servers.find((entry) => entry.name === serverName);
		if (!server) {
			lines.push(`Server '${serverName}' not found`);
		} else if (!server.connected) {
			lines.push(`Server '${serverName}' not connected`);
		} else if (!server.prompts.includes(promptName)) {
			lines.push(`Prompt '${promptName}' not found on server '${serverName}'`);
		} else {
			mcpManager
				.getPrompt(serverName, promptName, promptInvocation.args)
				.then((result) => {
					const promptLines = [`Prompt: ${promptName}`, ""];
					if (result.description) {
						promptLines.push(`Description: ${result.description}`, "");
					}
					for (const message of result.messages) {
						promptLines.push(`[${message.role}]`);
						promptLines.push(message.content);
						promptLines.push("");
					}
					renderCtx.addContent(promptLines.join("\n"));
					renderCtx.requestRender();
				})
				.catch((error: unknown) => {
					const message =
						error instanceof Error ? error.message : String(error);
					renderCtx.showError(`Failed to get prompt: ${message}`);
				});
			return;
		}
	} else {
		renderCtx.addContent(formatMcpPromptList(status.servers, args[0]));
		renderCtx.requestRender();
		return;
	}

	renderCtx.addContent(lines.join("\n"));
	renderCtx.requestRender();
}
