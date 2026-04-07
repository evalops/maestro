import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { PATHS } from "../config/constants.js";
import { readJsonFile, writeJsonFile } from "../utils/fs.js";
import type {
	McpAuthPresetConfig,
	McpProjectApprovalDecision,
	McpProjectApprovalStatus,
	McpServerConfig,
} from "./types.js";

interface StoredProjectMcpApprovalEntry {
	fingerprint: string;
	decision: McpProjectApprovalDecision;
	updatedAt: string;
}

interface StoredProjectMcpApprovalStore {
	version: 1;
	projects: Record<string, Record<string, StoredProjectMcpApprovalEntry>>;
}

const EMPTY_PROJECT_MCP_APPROVAL_STORE: StoredProjectMcpApprovalStore = {
	version: 1,
	projects: {},
};

function normalizeStringRecord(
	record: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!record) {
		return undefined;
	}
	return Object.fromEntries(
		Object.entries(record).sort(([leftKey], [rightKey]) =>
			leftKey.localeCompare(rightKey),
		),
	);
}

function normalizeProjectAuthPreset(
	server: McpServerConfig,
	authPresets: readonly McpAuthPresetConfig[],
): {
	name: string;
	headers?: Record<string, string>;
	headersHelper?: string;
} | null {
	if (!server.authPreset) {
		return null;
	}
	const preset = authPresets.find(
		(candidate) =>
			candidate.name === server.authPreset && candidate.scope === "project",
	);
	if (!preset) {
		return null;
	}
	return {
		name: preset.name,
		headers: normalizeStringRecord(preset.headers),
		headersHelper: preset.headersHelper,
	};
}

function normalizeApprovalStore(raw: unknown): StoredProjectMcpApprovalStore {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return EMPTY_PROJECT_MCP_APPROVAL_STORE;
	}
	const candidate = raw as {
		version?: unknown;
		projects?: unknown;
	};
	if (candidate.version !== 1) {
		return EMPTY_PROJECT_MCP_APPROVAL_STORE;
	}
	const projects =
		candidate.projects && typeof candidate.projects === "object"
			? candidate.projects
			: {};
	const normalizedProjects: StoredProjectMcpApprovalStore["projects"] = {};
	for (const [projectRoot, value] of Object.entries(projects)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			continue;
		}
		const serverEntries: Record<string, StoredProjectMcpApprovalEntry> = {};
		for (const [serverName, entry] of Object.entries(value)) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				continue;
			}
			const candidateEntry = entry as {
				fingerprint?: unknown;
				decision?: unknown;
				updatedAt?: unknown;
			};
			if (
				typeof candidateEntry.fingerprint !== "string" ||
				(candidateEntry.decision !== "approved" &&
					candidateEntry.decision !== "denied") ||
				typeof candidateEntry.updatedAt !== "string"
			) {
				continue;
			}
			serverEntries[serverName] = {
				fingerprint: candidateEntry.fingerprint,
				decision: candidateEntry.decision,
				updatedAt: candidateEntry.updatedAt,
			};
		}
		normalizedProjects[projectRoot] = serverEntries;
	}
	return {
		version: 1,
		projects: normalizedProjects,
	};
}

function readProjectMcpApprovalStore(): StoredProjectMcpApprovalStore {
	return normalizeApprovalStore(
		readJsonFile<unknown>(PATHS.MCP_PROJECT_APPROVALS_FILE, {
			fallback: EMPTY_PROJECT_MCP_APPROVAL_STORE,
		}),
	);
}

function writeProjectMcpApprovalStore(
	store: StoredProjectMcpApprovalStore,
): void {
	writeJsonFile(PATHS.MCP_PROJECT_APPROVALS_FILE, store);
}

function getProjectRootKey(projectRoot: string): string {
	return resolve(projectRoot);
}

export function buildProjectMcpServerFingerprint(
	server: McpServerConfig,
	authPresets: readonly McpAuthPresetConfig[] = [],
): string {
	const fingerprintInput = {
		name: server.name,
		transport: server.transport,
		command: server.command,
		args: server.args ?? [],
		env: normalizeStringRecord(server.env),
		cwd: server.cwd,
		url: server.url,
		headers: normalizeStringRecord(server.headers),
		headersHelper: server.headersHelper,
		authPreset: server.authPreset,
		timeout: server.timeout,
		enabled: server.enabled,
		disabled: server.disabled,
		projectAuthPreset: normalizeProjectAuthPreset(server, authPresets),
	};
	return createHash("sha256")
		.update(JSON.stringify(fingerprintInput))
		.digest("hex");
}

export function getProjectMcpServerApprovalStatus(options: {
	projectRoot?: string;
	server: McpServerConfig;
	authPresets?: readonly McpAuthPresetConfig[];
}): McpProjectApprovalStatus | undefined {
	const { projectRoot, server, authPresets = [] } = options;
	if (!projectRoot || server.scope !== "project") {
		return undefined;
	}

	const projectKey = getProjectRootKey(projectRoot);
	const fingerprint = buildProjectMcpServerFingerprint(server, authPresets);
	const store = readProjectMcpApprovalStore();
	const entry = store.projects[projectKey]?.[server.name];
	if (!entry || entry.fingerprint !== fingerprint) {
		return "pending";
	}
	return entry.decision;
}

export function setProjectMcpServerApprovalDecision(options: {
	projectRoot: string;
	server: McpServerConfig;
	authPresets?: readonly McpAuthPresetConfig[];
	decision: McpProjectApprovalDecision;
}): void {
	const { projectRoot, server, authPresets = [], decision } = options;
	if (server.scope !== "project") {
		throw new Error(
			`MCP server "${server.name}" is not project-scoped and does not require project approval.`,
		);
	}

	const projectKey = getProjectRootKey(projectRoot);
	const store = readProjectMcpApprovalStore();
	const serverEntries = {
		...(store.projects[projectKey] ?? {}),
	};
	serverEntries[server.name] = {
		fingerprint: buildProjectMcpServerFingerprint(server, authPresets),
		decision,
		updatedAt: new Date().toISOString(),
	};
	store.projects[projectKey] = serverEntries;
	writeProjectMcpApprovalStore(store);
}
