import { getOAuthToken } from "../oauth/index.js";
import { loadOAuthCredentials } from "../oauth/storage.js";
import { createLogger } from "../utils/logger.js";
import { getMemoryProjectScope } from "./team-memory.js";
import type { MemoryEntry, MemorySearchResult } from "./types.js";

const logger = createLogger("memory:service");

const REQUEST_TIMEOUT_MS = 5000;
const MAESTRO_AGENT = "maestro";
const MAESTRO_MEMORY_TYPE = "project";
const DURABLE_MEMORY_TAG = "maestro-kind:durable-memory";
const SOURCE_TAG = "source:maestro";
const TOPIC_TAG_PREFIX = "maestro-topic:";
const PROJECT_NAME_TAG_PREFIX = "maestro-project-name:";

type RemoteMemoryConfig = {
	baseUrl: string;
	organizationId: string;
	teamId?: string;
	token: string;
};

type RemoteMemoryScope = {
	projectId?: string;
	projectName?: string;
	repository?: string;
};

type RemoteMemoryRecord = {
	agent?: string;
	content: string;
	created_at: string;
	id: string;
	organization_id: string;
	repository?: string;
	score?: number;
	tags?: string[];
	team_id?: string;
	type: string;
	updated_at: string;
};

type RemoteListResponse = {
	memories?: RemoteMemoryRecord[];
	total?: number;
};

type RemoteRecallResponse = {
	memories?: RemoteMemoryRecord[];
	query?: string;
	total?: number;
};

function getEnvValue(names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

function normalizeTopic(topic: string): string {
	return topic.toLowerCase().trim();
}

function normalizeContent(content: string): string {
	return content.replace(/\s+/g, " ").trim();
}

function normalizeTag(tag: string): string {
	return tag.trim().toLowerCase();
}

function mergeTags(current?: string[], next?: string[]): string[] | undefined {
	const values = [...(current ?? []), ...(next ?? [])]
		.map(normalizeTag)
		.filter(Boolean);
	if (values.length === 0) {
		return undefined;
	}
	return Array.from(new Set(values)).sort();
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function resolveOrganizationId(): string | undefined {
	const envOrgId = getEnvValue([
		"MAESTRO_EVALOPS_ORG_ID",
		"EVALOPS_ORGANIZATION_ID",
		"MAESTRO_ENTERPRISE_ORG_ID",
	]);
	if (envOrgId) {
		return envOrgId;
	}
	const stored = loadOAuthCredentials("evalops")?.metadata?.organizationId;
	return typeof stored === "string" && stored.trim().length > 0
		? stored.trim()
		: undefined;
}

async function resolveRemoteMemoryConfig(): Promise<RemoteMemoryConfig | null> {
	const baseUrl = getEnvValue(["MAESTRO_MEMORY_BASE"]);
	if (!baseUrl) {
		return null;
	}

	const organizationId = resolveOrganizationId();
	if (!organizationId) {
		logger.warn(
			"Remote memory configured without organization id; falling back to local memory store",
		);
		return null;
	}

	const token =
		getEnvValue([
			"MAESTRO_MEMORY_ACCESS_TOKEN",
			"MAESTRO_EVALOPS_ACCESS_TOKEN",
		]) ?? (await getOAuthToken("evalops"));
	if (!token) {
		logger.warn(
			"Remote memory configured without access token; falling back to local memory store",
		);
		return null;
	}

	return {
		baseUrl: normalizeBaseUrl(baseUrl),
		organizationId,
		teamId: getEnvValue([
			"MAESTRO_MEMORY_TEAM_ID",
			"MAESTRO_EVALOPS_TEAM_ID",
			"MAESTRO_LLM_GATEWAY_TEAM_ID",
		]),
		token,
	};
}

function resolveRemoteScope(options?: {
	cwd?: string;
	projectId?: string;
	projectName?: string;
}): RemoteMemoryScope {
	if (options?.projectId !== undefined) {
		return {
			projectId: options.projectId,
			projectName: options.projectName,
			repository: options.projectId,
		};
	}

	if (!options?.cwd) {
		return {};
	}

	const scope = getMemoryProjectScope(options.cwd);
	if (!scope) {
		return {};
	}

	return {
		projectId: scope.projectId,
		projectName: scope.projectName,
		repository: scope.projectId,
	};
}

function buildRemoteMemoryTags(
	topic: string,
	tags?: string[],
	projectName?: string,
): string[] {
	return (
		mergeTags(
			[
				SOURCE_TAG,
				DURABLE_MEMORY_TAG,
				`${TOPIC_TAG_PREFIX}${normalizeTopic(topic)}`,
				...(projectName
					? [`${PROJECT_NAME_TAG_PREFIX}${projectName.trim().toLowerCase()}`]
					: []),
			],
			tags,
		) ?? []
	);
}

function extractTopicFromTags(tags?: string[]): string | undefined {
	return tags
		?.find((tag) => normalizeTag(tag).startsWith(TOPIC_TAG_PREFIX))
		?.slice(TOPIC_TAG_PREFIX.length)
		.trim();
}

function extractProjectNameFromTags(tags?: string[]): string | undefined {
	return tags
		?.find((tag) => normalizeTag(tag).startsWith(PROJECT_NAME_TAG_PREFIX))
		?.slice(PROJECT_NAME_TAG_PREFIX.length)
		.trim();
}

function isManagedDurableMemory(record: RemoteMemoryRecord): boolean {
	return (record.tags ?? []).map(normalizeTag).includes(DURABLE_MEMORY_TAG);
}

function toLocalMemoryEntry(
	record: RemoteMemoryRecord,
	scope: RemoteMemoryScope,
): MemoryEntry {
	const tags = (record.tags ?? [])
		.map(normalizeTag)
		.filter(
			(tag) =>
				tag !== SOURCE_TAG &&
				tag !== DURABLE_MEMORY_TAG &&
				!tag.startsWith(TOPIC_TAG_PREFIX) &&
				!tag.startsWith(PROJECT_NAME_TAG_PREFIX),
		);

	return {
		id: record.id,
		topic: extractTopicFromTags(record.tags) ?? "memory",
		content: record.content,
		tags: tags.length > 0 ? tags : undefined,
		projectId: scope.projectId ?? record.repository,
		projectName:
			scope.projectName ?? extractProjectNameFromTags(record.tags) ?? undefined,
		createdAt: Date.parse(record.created_at) || Date.now(),
		updatedAt: Date.parse(record.updated_at) || Date.now(),
	};
}

function buildHeaders(config: RemoteMemoryConfig): Headers {
	const headers = new Headers();
	headers.set("Authorization", `Bearer ${config.token}`);
	headers.set("Content-Type", "application/json");
	headers.set("X-Organization-ID", config.organizationId);
	return headers;
}

function buildQuery(params: Record<string, string | undefined>): string {
	const searchParams = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value) {
			searchParams.set(key, value);
		}
	}
	const encoded = searchParams.toString();
	return encoded ? `?${encoded}` : "";
}

async function requestJSON<T>(
	config: RemoteMemoryConfig,
	method: string,
	path: string,
	body?: Record<string, unknown>,
): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(`${config.baseUrl}${path}`, {
			method,
			headers: buildHeaders(config),
			body: body ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`Remote memory error ${response.status}: ${text || response.statusText}`,
			);
		}
		return (text ? (JSON.parse(text) as T) : ({} as T)) as T;
	} finally {
		clearTimeout(timeout);
	}
}

async function listRemoteRecordsForScope(
	config: RemoteMemoryConfig,
	scope: RemoteMemoryScope,
): Promise<RemoteMemoryRecord[]> {
	const response = await requestJSON<RemoteListResponse>(
		config,
		"GET",
		`/v1/memories${buildQuery({
			type: MAESTRO_MEMORY_TYPE,
			team_id: config.teamId,
			repository: scope.repository,
			agent: MAESTRO_AGENT,
		})}`,
	);
	return (response.memories ?? []).filter(isManagedDurableMemory);
}

function findMatchingRemoteRecord(
	records: RemoteMemoryRecord[],
	topic: string,
	content: string,
): RemoteMemoryRecord | undefined {
	const normalizedTopic = normalizeTopic(topic);
	const normalizedContent = normalizeContent(content).toLowerCase();
	return records.find(
		(record) =>
			extractTopicFromTags(record.tags) === normalizedTopic &&
			normalizeContent(record.content).toLowerCase() === normalizedContent,
	);
}

async function upsertRemoteDurableMemoryWithConfig(
	config: RemoteMemoryConfig,
	scope: RemoteMemoryScope,
	topic: string,
	content: string,
	options?: {
		existingRecords?: RemoteMemoryRecord[];
		tags?: string[];
	},
): Promise<{ entry: MemoryEntry; created: boolean; updated: boolean }> {
	const nextContent = normalizeContent(content);
	const nextTags = buildRemoteMemoryTags(
		topic,
		options?.tags,
		scope.projectName,
	);
	const existingRecords =
		options?.existingRecords ??
		(await listRemoteRecordsForScope(config, scope));
	const existing = findMatchingRemoteRecord(
		existingRecords,
		topic,
		nextContent,
	);

	if (!existing) {
		const created = await requestJSON<RemoteMemoryRecord>(
			config,
			"POST",
			"/v1/memories",
			{
				type: MAESTRO_MEMORY_TYPE,
				content: nextContent,
				team_id: config.teamId,
				repository: scope.repository,
				agent: MAESTRO_AGENT,
				tags: nextTags,
			},
		);
		return {
			entry: toLocalMemoryEntry(created, scope),
			created: true,
			updated: false,
		};
	}

	const mergedTags = mergeTags(existing.tags, nextTags);
	const nextTagsStable = mergedTags ?? [];
	const currentTagsStable = mergeTags(existing.tags) ?? [];
	const tagsChanged =
		nextTagsStable.length !== currentTagsStable.length ||
		nextTagsStable.some((tag, index) => currentTagsStable[index] !== tag);
	if (!tagsChanged && normalizeContent(existing.content) === nextContent) {
		return {
			entry: toLocalMemoryEntry(existing, scope),
			created: false,
			updated: false,
		};
	}

	const updated = await requestJSON<RemoteMemoryRecord>(
		config,
		"PUT",
		`/v1/memories/${encodeURIComponent(existing.id)}`,
		{
			content: nextContent,
			tags: mergedTags,
		},
	);
	return {
		entry: toLocalMemoryEntry(updated, scope),
		created: false,
		updated: true,
	};
}

export async function upsertRemoteDurableMemory(
	topic: string,
	content: string,
	options?: {
		cwd?: string;
		projectId?: string;
		projectName?: string;
		tags?: string[];
	},
): Promise<{ entry: MemoryEntry; created: boolean; updated: boolean } | null> {
	const config = await resolveRemoteMemoryConfig();
	if (!config) {
		return null;
	}

	return upsertRemoteDurableMemoryWithConfig(
		config,
		resolveRemoteScope(options),
		topic,
		content,
		{ tags: options?.tags },
	);
}

export async function recallRemoteDurableMemories(
	query: string,
	options?: {
		cwd?: string;
		limit?: number;
	},
): Promise<MemorySearchResult[] | null> {
	const config = await resolveRemoteMemoryConfig();
	if (!config) {
		return null;
	}

	const scope = resolveRemoteScope(options);
	try {
		const response = await requestJSON<RemoteRecallResponse>(
			config,
			"POST",
			"/v1/memories/recall",
			{
				query,
				limit: options?.limit ?? 10,
				type: MAESTRO_MEMORY_TYPE,
				team_id: config.teamId,
				repository: scope.repository,
				agent: MAESTRO_AGENT,
			},
		);
		return (response.memories ?? [])
			.filter(isManagedDurableMemory)
			.map((memory) => ({
				entry: toLocalMemoryEntry(memory, scope),
				score: Number(memory.score ?? 0),
				matchedOn: "content" as const,
			}));
	} catch (error) {
		logger.warn("Remote memory recall failed; using local fallback", {
			error: error instanceof Error ? error.message : String(error),
			projectId: scope.projectId,
		});
		return null;
	}
}

export async function applyRemoteAutoMemoryConsolidation(params: {
	options?: {
		cwd?: string;
		projectId?: string;
		projectName?: string;
	};
	removeEntries: MemoryEntry[];
	upserts: Array<{
		content: string;
		tags?: string[];
		topic: string;
	}>;
}): Promise<{ removed: number; added: number; updated: number } | null> {
	const config = await resolveRemoteMemoryConfig();
	if (!config) {
		return null;
	}

	const scope = resolveRemoteScope(params.options);
	const existingRecords = await listRemoteRecordsForScope(config, scope);

	let removed = 0;
	for (const entry of params.removeEntries) {
		const existing = findMatchingRemoteRecord(
			existingRecords,
			entry.topic,
			entry.content,
		);
		if (!existing) {
			continue;
		}
		await requestJSON<Record<string, never>>(
			config,
			"DELETE",
			`/v1/memories/${encodeURIComponent(existing.id)}`,
		);
		removed += 1;
	}

	let added = 0;
	let updated = 0;
	for (const upsert of params.upserts) {
		const result = await upsertRemoteDurableMemoryWithConfig(
			config,
			scope,
			upsert.topic,
			upsert.content,
			{
				tags: ["auto", "durable", "consolidated", ...(upsert.tags ?? [])],
				existingRecords,
			},
		);
		if (result.created) {
			added += 1;
		} else if (result.updated) {
			updated += 1;
		}
	}

	return { removed, added, updated };
}
