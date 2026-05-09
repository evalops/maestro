import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import {
	type ComposerConfig,
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
import {
	UNIFIED_CONTEXT_MANIFEST_PROTOCOL,
	type UnifiedContextEntryKind,
	type UnifiedContextEntrySource,
	type UnifiedContextEntryStatus,
	type UnifiedContextManifest,
	type UnifiedContextManifestContractIssue,
	type UnifiedContextManifestDiagnostic,
	type UnifiedContextManifestDiff,
	type UnifiedContextManifestDiffEntry,
	type UnifiedContextManifestEntry,
} from "./manifest-types.js";

export {
	UNIFIED_CONTEXT_MANIFEST_PROTOCOL,
	type UnifiedContextEntryKind,
	type UnifiedContextEntrySource,
	type UnifiedContextEntryStatus,
	type UnifiedContextManifest,
	type UnifiedContextManifestContractIssue,
	type UnifiedContextManifestDiagnostic,
	type UnifiedContextManifestDiff,
	type UnifiedContextManifestDiffEntry,
	type UnifiedContextManifestEntry,
} from "./manifest-types.js";

export interface LoadUnifiedContextManifestOptions {
	config?: ComposerConfig;
	projectDocs?: PromptProjectDocManifest;
	mcpConfig?: McpConfig;
	mcpStatus?: McpManagerStatus;
	includeMcpConfig?: boolean;
}

const ENTRY_KINDS: ReadonlySet<UnifiedContextEntryKind> = new Set([
	"project_doc",
	"mcp_server",
	"mcp_resource",
	"mcp_prompt",
]);

const ENTRY_SOURCES: ReadonlySet<UnifiedContextEntrySource> = new Set([
	"filesystem",
	"mcp_config",
	"mcp_runtime",
]);

const ENTRY_STATUSES: ReadonlySet<UnifiedContextEntryStatus> = new Set([
	"available",
	"configured",
	"connected",
	"disconnected",
	"error",
	"loaded",
]);

const METADATA_KEYS_BY_KIND: Record<
	UnifiedContextEntryKind,
	ReadonlySet<string>
> = {
	project_doc: new Set(["sourceKind", "truncated", "originalSize", "maxBytes"]),
	mcp_server: new Set([
		"transport",
		"scope",
		"command",
		"args",
		"cwdConfigured",
		"url",
		"remoteUrl",
		"remoteHost",
		"envKeys",
		"headerKeys",
		"headersHelperConfigured",
		"authPreset",
		"timeout",
		"remoteTrust",
		"projectApproval",
		"toolCount",
		"resourceCount",
		"promptCount",
		"error",
	]),
	mcp_resource: new Set(),
	mcp_prompt: new Set(["title", "description", "arguments"]),
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasRedactedTrue(value: unknown): boolean {
	return isRecord(value) && value.redacted === true;
}

function validateRedactedObject(
	issues: UnifiedContextManifestContractIssue[],
	value: unknown,
	path: string,
	requiredFlag: "configured" | "present" | null,
): void {
	if (!isRecord(value) || value.redacted !== true) {
		issues.push({
			path,
			message: "must be summarized as a redacted object",
		});
		return;
	}
	if (requiredFlag && value[requiredFlag] !== true) {
		issues.push({
			path,
			message: `must include ${requiredFlag}: true`,
		});
	}
}

function validateRedactedUrlObject(
	issues: UnifiedContextManifestContractIssue[],
	value: unknown,
	path: string,
): void {
	if (!hasRedactedTrue(value)) {
		issues.push({
			path,
			message: "must be summarized as a redacted URL object",
		});
		return;
	}
	if (isRecord(value)) {
		for (const key of Object.keys(value)) {
			if (!["scheme", "host", "redacted"].includes(key)) {
				issues.push({
					path: `${path}.${key}`,
					message: "is not allowed in redacted URL metadata",
				});
			}
		}
	}
}

function validateEntryMetadata(
	issues: UnifiedContextManifestContractIssue[],
	entry: UnifiedContextManifestEntry,
	entryPath: string,
): void {
	const metadata = entry.metadata;
	if (!metadata) {
		return;
	}
	const allowedKeys =
		METADATA_KEYS_BY_KIND[entry.kind as UnifiedContextEntryKind];
	if (!allowedKeys) {
		return;
	}
	for (const key of Object.keys(metadata)) {
		if (!allowedKeys.has(key)) {
			issues.push({
				path: `${entryPath}.metadata.${key}`,
				message: `is not allowed for ${entry.kind} entries`,
			});
		}
	}
	if (entry.kind !== "mcp_server") {
		return;
	}

	if ("command" in metadata) {
		validateRedactedObject(
			issues,
			metadata.command,
			`${entryPath}.metadata.command`,
			"configured",
		);
	}
	if ("args" in metadata) {
		if (!isRecord(metadata.args) || metadata.args.redacted !== true) {
			issues.push({
				path: `${entryPath}.metadata.args`,
				message: "must be summarized as a redacted args object",
			});
		} else if (typeof metadata.args.count !== "number") {
			issues.push({
				path: `${entryPath}.metadata.args.count`,
				message: "must include the redacted argument count",
			});
		}
	}
	if ("url" in metadata) {
		validateRedactedUrlObject(
			issues,
			metadata.url,
			`${entryPath}.metadata.url`,
		);
	}
	if ("remoteUrl" in metadata) {
		validateRedactedUrlObject(
			issues,
			metadata.remoteUrl,
			`${entryPath}.metadata.remoteUrl`,
		);
	}
	if ("error" in metadata) {
		validateRedactedObject(
			issues,
			metadata.error,
			`${entryPath}.metadata.error`,
			"present",
		);
	}
}

export function validateUnifiedContextManifestContract(
	manifest: UnifiedContextManifest,
): UnifiedContextManifestContractIssue[] {
	const issues: UnifiedContextManifestContractIssue[] = [];
	if (manifest.protocolVersion !== UNIFIED_CONTEXT_MANIFEST_PROTOCOL) {
		issues.push({
			path: "protocolVersion",
			message: `must be ${UNIFIED_CONTEXT_MANIFEST_PROTOCOL}`,
		});
	}
	if (manifest.version !== 1) {
		issues.push({ path: "version", message: "must be 1" });
	}

	const seenIds = new Set<string>();
	manifest.entries.forEach((entry, index) => {
		const entryPath = `entries[${index}]`;
		if (!entry.id) {
			issues.push({ path: `${entryPath}.id`, message: "is required" });
		} else if (seenIds.has(entry.id)) {
			issues.push({ path: `${entryPath}.id`, message: "must be unique" });
		}
		seenIds.add(entry.id);

		if (!ENTRY_KINDS.has(entry.kind)) {
			issues.push({ path: `${entryPath}.kind`, message: "is unsupported" });
		}
		if (!ENTRY_SOURCES.has(entry.source)) {
			issues.push({ path: `${entryPath}.source`, message: "is unsupported" });
		}
		if (!ENTRY_STATUSES.has(entry.status)) {
			issues.push({ path: `${entryPath}.status`, message: "is unsupported" });
		}
		if (
			entry.kind === "project_doc" &&
			entry.id.startsWith("project_doc:project:/")
		) {
			issues.push({
				path: `${entryPath}.id`,
				message: "must use a workspace-relative project document identity",
			});
		}
		validateEntryMetadata(issues, entry, entryPath);
	});

	return issues;
}

export function assertUnifiedContextManifestContract(
	manifest: UnifiedContextManifest,
): void {
	const issues = validateUnifiedContextManifestContract(manifest);
	if (issues.length === 0) {
		return;
	}
	throw new Error(
		[
			"Unified context manifest contract failed:",
			...issues.map((issue) => `- ${issue.path}: ${issue.message}`),
		].join("\n"),
	);
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
	const projectDocs =
		options.projectDocs ?? loadPromptProjectDocManifest(cwd, options.config);
	const diagnostics: UnifiedContextManifestDiagnostic[] =
		projectDocs.diagnostics.map((diagnostic) => ({ ...diagnostic }));
	const entries = [
		...projectDocEntries(projectDocs),
		...loadConfiguredMcpEntries(cwd, options, diagnostics),
		...loadRuntimeMcpEntries(options.mcpStatus, diagnostics),
	];

	const manifest: UnifiedContextManifest = {
		protocolVersion: UNIFIED_CONTEXT_MANIFEST_PROTOCOL,
		version: 1,
		cwd,
		projectDocs,
		entries,
		diagnostics,
	};
	assertUnifiedContextManifestContract(manifest);
	return manifest;
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
