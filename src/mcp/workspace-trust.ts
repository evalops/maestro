import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ClientToolExecutionService } from "../agent/transport.js";
import type { TextContent } from "../agent/types.js";
import { PATHS } from "../config/constants.js";
import { readJsonFile, writeJsonFile } from "../utils/fs.js";
import type {
	McpConfig,
	McpServerConfig,
	McpWorkspaceTrustEntry,
	McpWorkspaceTrustMode,
} from "./types.js";

type StoredMcpWorkspaceTrust = {
	version: 1;
	servers: Record<string, McpWorkspaceTrustEntry[]>;
};

type TrustDecision = "trust_once" | "trust_always" | "block" | "cancel";

const execFileAsync = promisify(execFile);

function emptyStore(): StoredMcpWorkspaceTrust {
	return {
		version: 1,
		servers: {},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeTrustEntry(value: unknown): McpWorkspaceTrustEntry | null {
	if (!isRecord(value)) {
		return null;
	}
	const workspaceUri = value.workspaceUri;
	const mode = value.mode;
	if (
		typeof workspaceUri !== "string" ||
		workspaceUri.trim().length === 0 ||
		(mode !== "trusted" && mode !== "ask" && mode !== "blocked")
	) {
		return null;
	}
	return {
		workspaceUri: canonicalizeWorkspaceUri(workspaceUri),
		mode,
		serverFingerprint:
			typeof value.serverFingerprint === "string"
				? value.serverFingerprint
				: undefined,
		grantedBy:
			typeof value.grantedBy === "string" ? value.grantedBy : undefined,
		grantedAt:
			typeof value.grantedAt === "string" ? value.grantedAt : undefined,
		expiresAt:
			typeof value.expiresAt === "string" ? value.expiresAt : undefined,
		reason: typeof value.reason === "string" ? value.reason : undefined,
	};
}

function normalizeStore(value: unknown): StoredMcpWorkspaceTrust {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.servers)) {
		return emptyStore();
	}
	const servers: Record<string, McpWorkspaceTrustEntry[]> = {};
	for (const [serverName, entries] of Object.entries(value.servers)) {
		if (!Array.isArray(entries)) {
			continue;
		}
		const normalized = entries
			.map(normalizeTrustEntry)
			.filter((entry): entry is McpWorkspaceTrustEntry => !!entry);
		if (normalized.length > 0) {
			servers[serverName] = normalized;
		}
	}
	return { version: 1, servers };
}

function readStore(): StoredMcpWorkspaceTrust {
	return normalizeStore(
		readJsonFile<unknown>(PATHS.MCP_WORKSPACE_TRUST_FILE, {
			fallback: emptyStore(),
		}),
	);
}

function writeStore(store: StoredMcpWorkspaceTrust): void {
	writeJsonFile(PATHS.MCP_WORKSPACE_TRUST_FILE, store);
}

function isExpired(entry: McpWorkspaceTrustEntry, now = Date.now()): boolean {
	if (!entry.expiresAt) {
		return false;
	}
	const expiresAt = Date.parse(entry.expiresAt);
	return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function latestMatchingEntry(
	entries: readonly McpWorkspaceTrustEntry[] | undefined,
	workspaceUri: string,
	options: { serverFingerprint?: string } = {},
): McpWorkspaceTrustEntry | undefined {
	if (!entries) {
		return undefined;
	}
	const canonicalWorkspaceUri = canonicalizeWorkspaceUri(workspaceUri);
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || isExpired(entry)) {
			continue;
		}
		if (
			canonicalizeWorkspaceUri(entry.workspaceUri) !== canonicalWorkspaceUri
		) {
			continue;
		}
		if (
			options.serverFingerprint &&
			entry.serverFingerprint !== options.serverFingerprint
		) {
			if (entry.serverFingerprint || entry.mode === "trusted") {
				continue;
			}
		}
		return entry;
	}
	return undefined;
}

function resolveConfiguredMcpWorkspaceTrust(options: {
	config: Pick<McpConfig, "trustedWorkspaces" | "workspaceTrustDefault">;
	serverName: string;
	workspaceUri: string;
	serverFingerprint?: string;
	storedTrust?: Record<string, McpWorkspaceTrustEntry[]>;
}): McpWorkspaceTrustMode {
	const configuredEntries =
		options.config.trustedWorkspaces?.[options.serverName];
	const configured = latestMatchingEntry(
		configuredEntries,
		options.workspaceUri,
	);
	if (configured) {
		return configured.mode;
	}
	if (options.config.workspaceTrustDefault === "untrusted") {
		return "untrusted";
	}
	const stored = latestMatchingEntry(
		options.storedTrust?.[options.serverName],
		options.workspaceUri,
		{ serverFingerprint: options.serverFingerprint },
	);
	if (stored) {
		return stored.mode;
	}
	if (!options.config.workspaceTrustDefault && !configuredEntries?.length) {
		return "trusted";
	}
	return options.config.workspaceTrustDefault ?? "ask";
}

function canonicalizeWorkspaceUri(workspaceUri: string): string {
	const trimmed = workspaceUri.trim();
	if (trimmed.startsWith("git:")) {
		return `git:${sanitizeGitRemote(trimmed.slice("git:".length))}`;
	}
	return trimmed;
}

function sanitizeGitRemote(remote: string): string {
	const trimmed = remote.trim();
	try {
		const url = new URL(trimmed);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return trimmed
			.replace(/^[^/@\s]+@(?=[^/:]+[:/])/, "")
			.replace(/[?#].*$/, "");
	}
}

function normalizeFingerprintValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(normalizeFingerprintValue);
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entryValue]) => entryValue !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entryValue]) => [
					key,
					normalizeFingerprintValue(entryValue),
				]),
		);
	}
	return value;
}

function fingerprintMcpServer(server: McpServerConfig): string {
	const identity: McpServerConfig = { ...server };
	delete identity.disabled;
	delete identity.enabled;
	delete identity.scope;
	return createHash("sha256")
		.update(JSON.stringify(normalizeFingerprintValue(identity)))
		.digest("hex");
}

export async function resolveMcpWorkspaceUri(
	workspaceRoot = process.cwd(),
): Promise<string> {
	const root = resolve(workspaceRoot);
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", root, "config", "--get", "remote.origin.url"],
			{
				timeout: 1000,
				windowsHide: true,
				encoding: "utf8",
			},
		);
		const remote = stdout.trim();
		if (remote.length > 0) {
			return `git:${sanitizeGitRemote(remote)}`;
		}
	} catch {
		// Non-git workspaces fall back to a canonical local path.
	}
	return `file:${root}`;
}

function setMcpWorkspaceTrust(options: {
	serverName: string;
	workspaceUri: string;
	mode: Exclude<McpWorkspaceTrustMode, "untrusted">;
	serverFingerprint?: string;
	grantedBy?: string;
	reason?: string;
}): void {
	const store = readStore();
	const workspaceUri = canonicalizeWorkspaceUri(options.workspaceUri);
	const entries = (store.servers[options.serverName] ?? []).filter(
		(entry) =>
			canonicalizeWorkspaceUri(entry.workspaceUri) !== workspaceUri ||
			entry.serverFingerprint !== options.serverFingerprint,
	);
	entries.push({
		workspaceUri,
		mode: options.mode,
		serverFingerprint: options.serverFingerprint,
		grantedBy: options.grantedBy,
		grantedAt: new Date().toISOString(),
		reason: options.reason,
	});
	store.servers[options.serverName] = entries;
	writeStore(store);
}

function getDecision(content: TextContent[]): TrustDecision {
	const text = content.find(
		(item): item is TextContent =>
			item.type === "text" && typeof item.text === "string",
	)?.text;
	if (!text) {
		return "cancel";
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isRecord(parsed)) {
			return "cancel";
		}
		if (parsed.action === "decline" || parsed.action === "cancel") {
			return "cancel";
		}
		const payload = isRecord(parsed.content) ? parsed.content : parsed;
		const candidate = payload.decision ?? payload.choice ?? payload.action;
		if (
			candidate === "trust_once" ||
			candidate === "trust_always" ||
			candidate === "block" ||
			candidate === "cancel"
		) {
			return candidate;
		}
	} catch {
		return "cancel";
	}
	return "cancel";
}

export async function ensureMcpWorkspaceTrusted(options: {
	config: McpConfig;
	server: McpServerConfig;
	toolName: string;
	clientToolService?: ClientToolExecutionService;
}): Promise<void> {
	const storedTrust = readStore().servers;
	if (
		!options.config.workspaceTrustDefault &&
		!options.config.trustedWorkspaces?.[options.server.name]?.length &&
		!storedTrust[options.server.name]?.length
	) {
		return;
	}
	const workspaceUri = await resolveMcpWorkspaceUri(options.config.projectRoot);
	const serverFingerprint = fingerprintMcpServer(options.server);
	const mode = resolveConfiguredMcpWorkspaceTrust({
		config: options.config,
		serverName: options.server.name,
		workspaceUri,
		serverFingerprint,
		storedTrust,
	});

	if (mode === "trusted") {
		return;
	}
	if (mode === "blocked" || mode === "untrusted") {
		throw new Error(
			`MCP server "${options.server.name}" is not trusted for workspace ${workspaceUri}.`,
		);
	}
	if (!options.clientToolService) {
		throw new Error(
			`MCP server "${options.server.name}" requires workspace trust before invoking "${options.toolName}", but no MCP elicitation client is connected.`,
		);
	}

	const requestId = `mcp_trust:${options.server.name}:${options.toolName}:${randomUUID()}`;
	const result = await options.clientToolService.requestExecution(
		requestId,
		"mcp_elicitation",
		{
			serverName: options.server.name,
			requestId,
			mode: "form",
			message: `Trust MCP server "${options.server.name}" for workspace ${workspaceUri} before calling tool "${options.toolName}"?`,
			requestedSchema: {
				type: "object",
				properties: {
					decision: {
						type: "string",
						title: "Decision",
						enum: ["trust_once", "trust_always", "block", "cancel"],
					},
				},
				required: ["decision"],
			},
		},
	);

	if (result.isError) {
		throw new Error(
			`MCP trust prompt failed for server "${options.server.name}".`,
		);
	}

	const decision = getDecision(result.content as TextContent[]);
	if (decision === "trust_once") {
		return;
	}
	if (decision === "trust_always") {
		setMcpWorkspaceTrust({
			serverName: options.server.name,
			workspaceUri,
			mode: "trusted",
			serverFingerprint,
			grantedBy: "user",
			reason: `Accepted MCP tool invocation for ${options.toolName}`,
		});
		return;
	}
	if (decision === "block") {
		setMcpWorkspaceTrust({
			serverName: options.server.name,
			workspaceUri,
			mode: "blocked",
			serverFingerprint,
			grantedBy: "user",
			reason: `Blocked MCP tool invocation for ${options.toolName}`,
		});
	}
	throw new Error(
		`MCP server "${options.server.name}" was not trusted for workspace ${workspaceUri}.`,
	);
}
