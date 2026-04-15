import { MemoryType } from "@evalops/memory";
import { MemoryClient } from "@evalops/memory/client";
import { getOAuthToken } from "../oauth/index.js";
import { loadOAuthCredentials } from "../oauth/storage.js";
import { createLogger } from "../utils/logger.js";
import { getMemoryProjectScope } from "./team-memory.js";
import type { MemoryEntry, MemorySearchResult } from "./types.js";

const logger = createLogger("memory:service");

const MAESTRO_AGENT = "maestro";
const DURABLE_MEMORY_TAG = "maestro-kind:durable-memory";
const SOURCE_TAG = "source:maestro";
const TOPIC_TAG_PREFIX = "maestro-topic:";
const PROJECT_NAME_TAG_PREFIX = "maestro-project-name:";

type RemoteMemoryConfig = {
	client: MemoryClient;
	teamId?: string;
};

type RemoteMemoryScope = {
	projectId?: string;
	projectName?: string;
	repository?: string;
};

type ClientMemory = Awaited<
	ReturnType<MemoryClient["list"]>
>["memories"][number];

type TimestampLike = {
	nanos?: number;
	seconds?: bigint | number | string;
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

function mergeTags(
	current?: readonly string[],
	next?: readonly string[],
): string[] | undefined {
	const values = [...(current ?? []), ...(next ?? [])]
		.map(normalizeTag)
		.filter(Boolean);
	if (values.length === 0) {
		return undefined;
	}
	return Array.from(new Set(values)).sort();
}

function firstNonEmptyString(
	...values: Array<string | undefined>
): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
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
		client: new MemoryClient({
			baseUrl,
			accessToken: token,
			organizationId,
		}),
		teamId: getEnvValue([
			"MAESTRO_MEMORY_TEAM_ID",
			"MAESTRO_EVALOPS_TEAM_ID",
			"MAESTRO_LLM_GATEWAY_TEAM_ID",
		]),
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
	tags?: readonly string[],
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

function extractTopicFromTags(tags?: readonly string[]): string | undefined {
	return tags
		?.find((tag) => normalizeTag(tag).startsWith(TOPIC_TAG_PREFIX))
		?.slice(TOPIC_TAG_PREFIX.length)
		.trim();
}

function extractProjectNameFromTags(
	tags?: readonly string[],
): string | undefined {
	return tags
		?.find((tag) => normalizeTag(tag).startsWith(PROJECT_NAME_TAG_PREFIX))
		?.slice(PROJECT_NAME_TAG_PREFIX.length)
		.trim();
}

function isManagedDurableMemory(record: ClientMemory): boolean {
	return (record.tags ?? []).map(normalizeTag).includes(DURABLE_MEMORY_TAG);
}

function timestampToMillis(value: TimestampLike | undefined): number {
	if (!value) {
		return Date.now();
	}

	let seconds = 0;
	if (typeof value.seconds === "bigint") {
		if (value.seconds > BigInt(Number.MAX_SAFE_INTEGER)) {
			return Date.now();
		}
		seconds = Number(value.seconds);
	} else if (typeof value.seconds === "number") {
		seconds = value.seconds;
	} else if (typeof value.seconds === "string") {
		seconds = Number.parseInt(value.seconds, 10);
	}

	const nanos = typeof value.nanos === "number" ? value.nanos : 0;
	const millis = seconds * 1000 + Math.floor(nanos / 1_000_000);
	return Number.isFinite(millis) && millis > 0 ? millis : Date.now();
}

function toLocalMemoryEntry(
	record: ClientMemory,
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
		projectId: firstNonEmptyString(
			scope.projectId,
			record.projectId,
			record.repository,
		),
		projectName: firstNonEmptyString(
			scope.projectName,
			extractProjectNameFromTags(record.tags),
		),
		createdAt: timestampToMillis(record.createdAt as TimestampLike | undefined),
		updatedAt: timestampToMillis(record.updatedAt as TimestampLike | undefined),
	};
}

function requireMemory(
	value: ClientMemory | undefined,
	operation: string,
): ClientMemory {
	if (!value) {
		throw new Error(`${operation} returned no memory payload`);
	}
	return value;
}

async function listRemoteRecordsForScope(
	config: RemoteMemoryConfig,
	scope: RemoteMemoryScope,
): Promise<ClientMemory[]> {
	const response = await config.client.list({
		type: MemoryType.PROJECT,
		teamId: config.teamId,
		repository: scope.repository,
		agent: MAESTRO_AGENT,
	});
	return (response.memories ?? []).filter(isManagedDurableMemory);
}

function findMatchingRemoteRecord(
	records: ClientMemory[],
	topic: string,
	content: string,
): ClientMemory | undefined {
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
		existingRecords?: ClientMemory[];
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
		const created = requireMemory(
			(
				await config.client.store({
					type: MemoryType.PROJECT,
					content: nextContent,
					teamId: config.teamId,
					repository: scope.repository,
					agent: MAESTRO_AGENT,
					tags: nextTags,
				})
			).memory,
			"store memory",
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

	const updated = requireMemory(
		(
			await config.client.update({
				id: existing.id,
				content: nextContent,
				tags: mergedTags ?? [],
			})
		).memory,
		"update memory",
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
		const response = await config.client.recall({
			query,
			limit: options?.limit ?? 10,
			type: MemoryType.PROJECT,
			teamId: config.teamId,
			repository: scope.repository,
			agent: MAESTRO_AGENT,
		});
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
		await config.client.delete({ id: existing.id });
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
