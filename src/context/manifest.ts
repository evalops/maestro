import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import {
	type ComposerConfig,
	type PromptProjectDocDiagnostic,
	type PromptProjectDocManifest,
	loadPromptProjectDocManifest,
} from "../config/index.js";
import { loadMcpConfig } from "../mcp/config.js";
import type {
	McpConfig,
	McpManagerStatus,
	McpPromptDefinition,
	McpServerConfig,
	McpServerStatus,
} from "../mcp/types.js";

export type UnifiedContextEntryKind =
	| "project_doc"
	| "mcp_server"
	| "mcp_resource"
	| "mcp_prompt";

export type UnifiedContextEntrySource =
	| "filesystem"
	| "mcp_config"
	| "mcp_runtime";

export type UnifiedContextEntryStatus =
	| "available"
	| "configured"
	| "connected"
	| "disconnected"
	| "error"
	| "loaded";

export interface UnifiedContextManifestEntry {
	id: string;
	kind: UnifiedContextEntryKind;
	source: UnifiedContextEntrySource;
	status: UnifiedContextEntryStatus;
	label: string;
	path?: string;
	scopeDir?: string;
	serverName?: string;
	uri?: string;
	promptName?: string;
	precedenceIndex?: number;
	bytesRead?: number;
	contentHash?: string;
	metadata?: Record<string, unknown>;
}

export interface UnifiedContextManifestDiagnostic {
	code:
		| PromptProjectDocDiagnostic["code"]
		| "mcp_config_loaded"
		| "mcp_config_unreadable"
		| "mcp_runtime_unavailable";
	severity: "info" | "warning";
	message: string;
	path?: string;
	scopeDir?: string;
	entryId?: string;
}

export interface UnifiedContextManifest {
	version: 1;
	cwd: string;
	projectDocs: PromptProjectDocManifest;
	entries: UnifiedContextManifestEntry[];
	diagnostics: UnifiedContextManifestDiagnostic[];
}

export interface LoadUnifiedContextManifestOptions {
	config?: ComposerConfig;
	mcpConfig?: McpConfig;
	mcpStatus?: McpManagerStatus;
	includeMcpConfig?: boolean;
}

export interface UnifiedContextManifestDiffEntry {
	id: string;
	kind: UnifiedContextEntryKind;
	label: string;
	before?: UnifiedContextManifestEntry;
	after?: UnifiedContextManifestEntry;
	changes?: string[];
}

export interface UnifiedContextManifestDiff {
	beforeCwd: string;
	afterCwd: string;
	added: UnifiedContextManifestDiffEntry[];
	removed: UnifiedContextManifestDiffEntry[];
	changed: UnifiedContextManifestDiffEntry[];
	unchanged: UnifiedContextManifestDiffEntry[];
	diagnostics: UnifiedContextManifestDiagnostic[];
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}

	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

function hashValue(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function normalizeMetadata(
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(metadata).filter(([, value]) => value !== undefined),
	);
}

function summarizeRedactedArgs(args: string[] | undefined):
	| {
			count: number;
			redacted: true;
	  }
	| undefined {
	return args ? { count: args.length, redacted: true } : undefined;
}

function summarizeRedactedCommand(command: string | undefined):
	| {
			configured: true;
			redacted: true;
	  }
	| undefined {
	return command ? { configured: true, redacted: true } : undefined;
}

function summarizeRedactedError(error: string | undefined):
	| {
			present: true;
			redacted: true;
	  }
	| undefined {
	return error ? { present: true, redacted: true } : undefined;
}

function summarizeRedactedUrl(url: string | undefined):
	| {
			scheme?: string;
			host?: string;
			redacted: true;
	  }
	| undefined {
	if (!url) {
		return undefined;
	}
	try {
		const parsed = new URL(url);
		return {
			scheme: parsed.protocol.replace(/:$/, ""),
			host: parsed.host,
			redacted: true,
		};
	} catch {
		return { redacted: true };
	}
}

function compareEntry(
	before: UnifiedContextManifestEntry,
	after: UnifiedContextManifestEntry,
): string[] {
	const fields: Array<keyof UnifiedContextManifestEntry> = [
		"source",
		"status",
		"label",
		"path",
		"scopeDir",
		"serverName",
		"uri",
		"promptName",
		"precedenceIndex",
		"bytesRead",
		"contentHash",
		"metadata",
	];
	if (before.kind === "project_doc" && after.kind === "project_doc") {
		return fields
			.filter((field) => field !== "path" && field !== "scopeDir")
			.filter(
				(field) => stableJson(before[field]) !== stableJson(after[field]),
			);
	}
	return fields.filter(
		(field) => stableJson(before[field]) !== stableJson(after[field]),
	);
}

function projectDocEntryId(
	cwd: string,
	entry: PromptProjectDocManifest["entries"][number],
): string {
	if (entry.sourceKind === "project") {
		const relativePath = relative(cwd, entry.path) || entry.candidateName;
		return `project_doc:${entry.sourceKind}:${relativePath}`;
	}
	return `project_doc:${entry.sourceKind}:${entry.path}`;
}

function projectDocEntries(
	manifest: PromptProjectDocManifest,
): UnifiedContextManifestEntry[] {
	return manifest.entries.map((entry) => ({
		id: projectDocEntryId(manifest.cwd, entry),
		kind: "project_doc",
		source: "filesystem",
		status: "loaded",
		label: entry.candidateName,
		path: entry.path,
		scopeDir: entry.scopeDir,
		precedenceIndex: entry.precedenceIndex,
		bytesRead: entry.bytesRead,
		contentHash: entry.contentHash,
		metadata: normalizeMetadata({
			sourceKind: entry.sourceKind,
			truncated: entry.truncated,
			originalSize: entry.originalSize,
			maxBytes: entry.maxBytes,
		}),
	}));
}

function mcpServerConfigEntry(
	server: McpServerConfig,
): UnifiedContextManifestEntry {
	const metadata = normalizeMetadata({
		transport: server.transport,
		scope: server.scope,
		command: summarizeRedactedCommand(server.command),
		args: summarizeRedactedArgs(server.args),
		cwdConfigured: server.cwd ? true : undefined,
		url: summarizeRedactedUrl(server.url),
		envKeys: server.env ? Object.keys(server.env).sort() : undefined,
		headerKeys: server.headers ? Object.keys(server.headers).sort() : undefined,
		headersHelperConfigured: server.headersHelper ? true : undefined,
		authPreset: server.authPreset,
		timeout: server.timeout,
	});
	return {
		id: `mcp_server:${server.name}`,
		kind: "mcp_server",
		source: "mcp_config",
		status: "configured",
		label: server.name,
		serverName: server.name,
		contentHash: hashValue(metadata),
		metadata,
	};
}

function mcpServerStatusEntry(
	server: McpServerStatus,
): UnifiedContextManifestEntry {
	const metadata = normalizeMetadata({
		transport: server.transport,
		scope: server.scope,
		command: summarizeRedactedCommand(server.command),
		args: summarizeRedactedArgs(server.args),
		cwdConfigured: server.cwd ? true : undefined,
		remoteUrl: summarizeRedactedUrl(server.remoteUrl),
		remoteHost: server.remoteHost,
		envKeys: server.envKeys,
		headerKeys: server.headerKeys,
		headersHelperConfigured: server.headersHelper ? true : undefined,
		authPreset: server.authPreset,
		timeout: server.timeout,
		remoteTrust: server.remoteTrust,
		projectApproval: server.projectApproval,
		toolCount: server.tools.length,
		resourceCount: server.resources.length,
		promptCount: server.prompts.length,
		error: summarizeRedactedError(server.error),
	});
	return {
		id: `mcp_server:${server.name}`,
		kind: "mcp_server",
		source: "mcp_runtime",
		status: server.error
			? "error"
			: server.connected
				? "connected"
				: "disconnected",
		label: server.name,
		serverName: server.name,
		contentHash: hashValue(metadata),
		metadata,
	};
}

function mcpResourceEntry(
	serverName: string,
	uri: string,
): UnifiedContextManifestEntry {
	return {
		id: `mcp_resource:${serverName}:${uri}`,
		kind: "mcp_resource",
		source: "mcp_runtime",
		status: "available",
		label: uri,
		serverName,
		uri,
		contentHash: hashValue({ serverName, uri }),
	};
}

function mcpPromptEntry(
	serverName: string,
	promptName: string,
	prompt?: McpPromptDefinition,
): UnifiedContextManifestEntry {
	const metadata = normalizeMetadata({
		title: prompt?.title,
		description: prompt?.description,
		arguments: prompt?.arguments,
	});
	return {
		id: `mcp_prompt:${serverName}:${promptName}`,
		kind: "mcp_prompt",
		source: "mcp_runtime",
		status: "available",
		label: prompt?.title ?? promptName,
		serverName,
		promptName,
		contentHash: hashValue({ serverName, promptName, metadata }),
		metadata,
	};
}

function loadConfiguredMcpEntries(
	cwd: string,
	options: LoadUnifiedContextManifestOptions,
	diagnostics: UnifiedContextManifestDiagnostic[],
): UnifiedContextManifestEntry[] {
	if (options.includeMcpConfig === false || options.mcpStatus) {
		return [];
	}

	try {
		const config = options.mcpConfig ?? loadMcpConfig(cwd);
		if (config.servers.length > 0) {
			diagnostics.push({
				code: "mcp_config_loaded",
				severity: "info",
				message: `${config.servers.length} configured MCP server${config.servers.length === 1 ? "" : "s"} included from config.`,
			});
		}
		return config.servers.map(mcpServerConfigEntry);
	} catch (error) {
		diagnostics.push({
			code: "mcp_config_unreadable",
			severity: "warning",
			message: `Could not load MCP config: ${error instanceof Error ? error.message : String(error)}`,
		});
		return [];
	}
}

function loadRuntimeMcpEntries(
	status: McpManagerStatus | undefined,
	diagnostics: UnifiedContextManifestDiagnostic[],
): UnifiedContextManifestEntry[] {
	if (!status) {
		return [];
	}

	const entries: UnifiedContextManifestEntry[] = [];
	for (const server of status.servers) {
		entries.push(mcpServerStatusEntry(server));
		for (const uri of server.resources) {
			entries.push(mcpResourceEntry(server.name, uri));
		}
		const promptDetails = new Map(
			(server.promptDetails ?? []).map((prompt) => [prompt.name, prompt]),
		);
		for (const promptName of server.prompts) {
			entries.push(
				mcpPromptEntry(server.name, promptName, promptDetails.get(promptName)),
			);
		}
		if (!server.connected && server.error) {
			diagnostics.push({
				code: "mcp_runtime_unavailable",
				severity: "warning",
				message: `MCP server ${server.name} is unavailable; error details redacted.`,
				entryId: `mcp_server:${server.name}`,
			});
		}
	}
	return entries;
}

export function loadUnifiedContextManifest(
	cwdOverride?: string,
	options: LoadUnifiedContextManifestOptions = {},
): UnifiedContextManifest {
	const cwd = resolve(cwdOverride ?? process.cwd());
	const projectDocs = loadPromptProjectDocManifest(cwd, options.config);
	const diagnostics: UnifiedContextManifestDiagnostic[] =
		projectDocs.diagnostics.map((diagnostic) => ({ ...diagnostic }));
	const entries = [
		...projectDocEntries(projectDocs),
		...loadConfiguredMcpEntries(cwd, options, diagnostics),
		...loadRuntimeMcpEntries(options.mcpStatus, diagnostics),
	];

	return {
		version: 1,
		cwd,
		projectDocs,
		entries,
		diagnostics,
	};
}

export function diffUnifiedContextManifests(
	before: UnifiedContextManifest,
	after: UnifiedContextManifest,
): UnifiedContextManifestDiff {
	const beforeEntries = new Map(
		before.entries.map((entry) => [entry.id, entry]),
	);
	const afterEntries = new Map(after.entries.map((entry) => [entry.id, entry]));
	const added: UnifiedContextManifestDiffEntry[] = [];
	const removed: UnifiedContextManifestDiffEntry[] = [];
	const changed: UnifiedContextManifestDiffEntry[] = [];
	const unchanged: UnifiedContextManifestDiffEntry[] = [];

	for (const [id, afterEntry] of afterEntries) {
		const beforeEntry = beforeEntries.get(id);
		if (!beforeEntry) {
			added.push({
				id,
				kind: afterEntry.kind,
				label: afterEntry.label,
				after: afterEntry,
			});
			continue;
		}
		const changes = compareEntry(beforeEntry, afterEntry);
		if (changes.length > 0) {
			changed.push({
				id,
				kind: afterEntry.kind,
				label: afterEntry.label,
				before: beforeEntry,
				after: afterEntry,
				changes,
			});
		} else {
			unchanged.push({
				id,
				kind: afterEntry.kind,
				label: afterEntry.label,
				before: beforeEntry,
				after: afterEntry,
			});
		}
	}

	for (const [id, beforeEntry] of beforeEntries) {
		if (!afterEntries.has(id)) {
			removed.push({
				id,
				kind: beforeEntry.kind,
				label: beforeEntry.label,
				before: beforeEntry,
			});
		}
	}

	const sortById = (
		a: UnifiedContextManifestDiffEntry,
		b: UnifiedContextManifestDiffEntry,
	) => a.id.localeCompare(b.id);

	return {
		beforeCwd: before.cwd,
		afterCwd: after.cwd,
		added: added.sort(sortById),
		removed: removed.sort(sortById),
		changed: changed.sort(sortById),
		unchanged: unchanged.sort(sortById),
		diagnostics: [...before.diagnostics, ...after.diagnostics],
	};
}
