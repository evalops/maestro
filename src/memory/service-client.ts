import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import {
	type RequestOptions as HttpsRequestOptions,
	request as httpsRequest,
} from "node:https";
import {
	EVALOPS_ACCESS_TOKEN_ENV_VARS,
	EVALOPS_ORGANIZATION_ID_ENV_VARS,
} from "../evalops/env-aliases.js";
import {
	getEnvValue,
	parsePositiveInt,
	resolveOrganizationId,
	resolvePlatformToken,
	resolveTeamId,
} from "../platform/client.js";
import { createLogger } from "../utils/logger.js";
import { MemoryClient, MemoryType } from "./platform-memory-client.js";
import { getMemoryProjectScope } from "./team-memory.js";
import type { MemoryEntry, MemorySearchResult } from "./types.js";

const logger = createLogger("memory:service");

const MAESTRO_AGENT = "maestro";
const DURABLE_MEMORY_TAG = "maestro-kind:durable-memory";
const SOURCE_TAG = "source:maestro";
const TOPIC_TAG_PREFIX = "maestro-topic:";
const PROJECT_NAME_TAG_PREFIX = "maestro-project-name:";
const SESSION_TAG_PREFIX = "maestro-session:";
const MEMORY_SERVICE_TOKEN_SCOPES = [
	"memories:read",
	"memories:write",
] as const;
const DEFAULT_MEMORY_SERVICE_TOKEN_TTL_SECONDS = 300;
const SERVICE_TOKEN_EXPIRY_SKEW_MS = 30_000;

type RemoteMemoryConfig = {
	agentId: string;
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

type MemorySourceReference = {
	uri: string;
	title: string;
	type: string;
	metadata?: Record<string, string>;
};

type RemoteStoreRequest = Parameters<MemoryClient["store"]>[0] & {
	agentId?: string;
	reviewStatus?: string;
	sourceReferences?: MemorySourceReference[];
};

type RemoteListRequest = Parameters<MemoryClient["list"]>[0] & {
	agentId?: string;
	reviewStatus?: string;
};

type RemoteRecallRequest = Parameters<MemoryClient["recall"]>[0] & {
	agentId?: string;
	reviewStatus?: string;
};

type CachedServiceToken = {
	expiresAtMs: number;
	token: string;
};

type ServiceTokenResponseBody = {
	claims?: {
		expires_at?: string;
		expiresAt?: string;
	};
	expires_at?: string;
	expiresAt?: string;
	token?: string;
};

const memoryServiceTokenCache = new Map<string, CachedServiceToken>();

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

function resolveMemoryAgentId(): string {
	return (
		getEnvValue(["MAESTRO_MEMORY_AGENT_ID", "MAESTRO_AGENT_ID"]) ??
		MAESTRO_AGENT
	);
}

function resolveMemoryServiceTokenUrl(): string | undefined {
	return getEnvValue([
		"MAESTRO_MEMORY_IDENTITY_SERVICE_TOKENS_URL",
		"IDENTITY_SERVICE_TOKENS_URL",
	]);
}

function resolveMemoryServiceTokenTtlSeconds(): number {
	return parsePositiveInt(
		getEnvValue(["MAESTRO_MEMORY_SERVICE_TOKEN_TTL_SECONDS"]),
		DEFAULT_MEMORY_SERVICE_TOKEN_TTL_SECONDS,
	);
}

function resolveMemoryServiceTokenBootstrapKey(): string | undefined {
	return getEnvValue([
		"MAESTRO_MEMORY_IDENTITY_BOOTSTRAP_KEY",
		"IDENTITY_BOOTSTRAP_KEY",
	]);
}

function resolveMemoryIdentityTlsOptions(): HttpsRequestOptions {
	const caFile = getEnvValue([
		"MAESTRO_MEMORY_IDENTITY_TLS_CA_FILE",
		"IDENTITY_CLIENT_TLS_CA_FILE",
	]);
	const certFile = getEnvValue([
		"MAESTRO_MEMORY_IDENTITY_TLS_CERT_FILE",
		"IDENTITY_CLIENT_TLS_CERT_FILE",
	]);
	const keyFile = getEnvValue([
		"MAESTRO_MEMORY_IDENTITY_TLS_KEY_FILE",
		"IDENTITY_CLIENT_TLS_KEY_FILE",
	]);
	const servername = getEnvValue([
		"MAESTRO_MEMORY_IDENTITY_TLS_SERVER_NAME",
		"IDENTITY_CLIENT_TLS_SERVER_NAME",
	]);

	return {
		...(caFile ? { ca: readFileSync(caFile, "utf8") } : {}),
		...(certFile ? { cert: readFileSync(certFile, "utf8") } : {}),
		...(keyFile ? { key: readFileSync(keyFile, "utf8") } : {}),
		...(servername ? { servername } : {}),
	};
}

function serviceTokenCacheValid(
	cached: CachedServiceToken | undefined,
): boolean {
	return Boolean(
		cached && cached.expiresAtMs - SERVICE_TOKEN_EXPIRY_SKEW_MS > Date.now(),
	);
}

function parseServiceTokenExpiresAt(
	payload: ServiceTokenResponseBody,
	ttlSeconds: number,
): number {
	const value =
		payload.expires_at ??
		payload.expiresAt ??
		payload.claims?.expires_at ??
		payload.claims?.expiresAt;
	if (value) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return Date.now() + ttlSeconds * 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseServiceTokenResponseBody(
	value: unknown,
): ServiceTokenResponseBody {
	if (!isRecord(value)) {
		return {};
	}
	const claims = isRecord(value.claims) ? value.claims : undefined;
	return {
		token: typeof value.token === "string" ? value.token.trim() : undefined,
		expires_at:
			typeof value.expires_at === "string" ? value.expires_at : undefined,
		expiresAt:
			typeof value.expiresAt === "string" ? value.expiresAt : undefined,
		claims: claims
			? {
					expires_at:
						typeof claims.expires_at === "string"
							? claims.expires_at
							: undefined,
					expiresAt:
						typeof claims.expiresAt === "string" ? claims.expiresAt : undefined,
				}
			: undefined,
	};
}

function readResponseBody(response: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		response.on("data", (chunk: Buffer | string) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		response.on("end", () => {
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		response.on("error", reject);
	});
}

function issueMemoryServiceTokenRequest(
	url: string,
	organizationId: string,
	ttlSeconds: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify({
			service: MAESTRO_AGENT,
			organization_id: organizationId,
			scopes: MEMORY_SERVICE_TOKEN_SCOPES,
			ttl_seconds: ttlSeconds,
		});
		const parsedUrl = new URL(url);
		const bootstrapKey = resolveMemoryServiceTokenBootstrapKey();
		const request = httpsRequest(
			parsedUrl,
			{
				...resolveMemoryIdentityTlsOptions(),
				headers: {
					Accept: "application/json",
					"Connect-Protocol-Version": "1",
					"Content-Length": Buffer.byteLength(body).toString(),
					"Content-Type": "application/json",
					...(bootstrapKey ? { "X-Identity-Bootstrap-Key": bootstrapKey } : {}),
				},
				method: "POST",
			},
			async (response) => {
				try {
					const responseBody = await readResponseBody(response);
					if (response.statusCode !== 200 && response.statusCode !== 201) {
						reject(
							new Error(
								`identity service token request failed with status ${response.statusCode ?? "unknown"}`,
							),
						);
						return;
					}
					const parsed = parseServiceTokenResponseBody(
						JSON.parse(responseBody),
					);
					if (!parsed.token) {
						reject(new Error("identity service token response missing token"));
						return;
					}
					memoryServiceTokenCache.set(organizationId, {
						token: parsed.token,
						expiresAtMs: parseServiceTokenExpiresAt(parsed, ttlSeconds),
					});
					resolve(parsed.token);
				} catch (error) {
					reject(error);
				}
			},
		);
		request.on("error", reject);
		request.write(body);
		request.end();
	});
}

async function resolveMemoryServiceToken(
	organizationId: string,
): Promise<string | undefined> {
	const url = resolveMemoryServiceTokenUrl();
	if (!url) {
		return undefined;
	}
	const cached = memoryServiceTokenCache.get(organizationId);
	if (serviceTokenCacheValid(cached)) {
		return cached?.token;
	}

	const bootstrapKey = resolveMemoryServiceTokenBootstrapKey();
	const certFile = getEnvValue([
		"MAESTRO_MEMORY_IDENTITY_TLS_CERT_FILE",
		"IDENTITY_CLIENT_TLS_CERT_FILE",
	]);
	const keyFile = getEnvValue([
		"MAESTRO_MEMORY_IDENTITY_TLS_KEY_FILE",
		"IDENTITY_CLIENT_TLS_KEY_FILE",
	]);
	if (!bootstrapKey && (!certFile || !keyFile)) {
		return undefined;
	}

	return issueMemoryServiceTokenRequest(
		url,
		organizationId,
		resolveMemoryServiceTokenTtlSeconds(),
	);
}

async function resolveMemoryAccessToken(
	organizationId: string,
): Promise<string | undefined> {
	const configuredToken = getEnvValue([
		"MAESTRO_MEMORY_ACCESS_TOKEN",
		...EVALOPS_ACCESS_TOKEN_ENV_VARS,
	]);
	if (configuredToken) {
		return configuredToken;
	}

	try {
		const serviceToken = await resolveMemoryServiceToken(organizationId);
		if (serviceToken) {
			return serviceToken;
		}
	} catch (error) {
		logger.warn(
			"Failed to issue identity service token for remote memory; trying OAuth fallback",
			{ error },
		);
	}

	return resolvePlatformToken([]);
}

async function resolveRemoteMemoryConfig(): Promise<RemoteMemoryConfig | null> {
	const baseUrl = getEnvValue([
		"MAESTRO_MEMORY_BASE",
		"MAESTRO_MEMORY_SERVICE_URL",
		"MAESTRO_PLATFORM_BASE_URL",
		"MAESTRO_EVALOPS_BASE_URL",
		"EVALOPS_BASE_URL",
	]);
	if (!baseUrl) {
		return null;
	}

	const organizationId = resolveOrganizationId([
		"MAESTRO_MEMORY_ORGANIZATION_ID",
		...EVALOPS_ORGANIZATION_ID_ENV_VARS,
	]);
	if (!organizationId) {
		logger.warn(
			"Remote memory configured without organization id; falling back to local memory store",
		);
		return null;
	}

	const token = await resolveMemoryAccessToken(organizationId);
	if (!token) {
		logger.warn(
			"Remote memory configured without access token; falling back to local memory store",
		);
		return null;
	}

	return {
		agentId: resolveMemoryAgentId(),
		client: new MemoryClient({
			baseUrl,
			accessToken: token,
			organizationId,
		}),
		teamId: resolveTeamId([
			"MAESTRO_MEMORY_TEAM_ID",
			"MAESTRO_EVALOPS_TEAM_ID",
			"MAESTRO_LLM_GATEWAY_TEAM_ID",
		]),
	};
}

export function resetMemoryServiceTokenCacheForTests(): void {
	memoryServiceTokenCache.clear();
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
	sessionId?: string,
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
				...(sessionId ? [`${SESSION_TAG_PREFIX}${sessionId.trim()}`] : []),
			],
			tags,
		) ?? []
	);
}

function buildSourceReferences(
	topic: string,
	scope: RemoteMemoryScope,
	options?: {
		sessionId?: string;
	},
): MemorySourceReference[] {
	const references: MemorySourceReference[] = [
		{
			uri: scope.repository
				? `repo:${scope.repository}`
				: "maestro://durable-memory",
			title: `Maestro durable memory: ${normalizeTopic(topic)}`,
			type: "maestro-durable-memory",
			metadata: {
				source: "maestro",
				topic: normalizeTopic(topic),
				...(scope.projectId ? { projectId: scope.projectId } : {}),
				...(scope.projectName ? { projectName: scope.projectName } : {}),
				...(scope.repository ? { repository: scope.repository } : {}),
			},
		},
	];
	const sessionId = options?.sessionId?.trim();
	if (sessionId) {
		references.push({
			uri: `maestro://sessions/${sessionId}`,
			title: `Maestro session ${sessionId}`,
			type: "maestro-session",
			metadata: {
				source: "maestro",
				sessionId,
				topic: normalizeTopic(topic),
				...(scope.projectId ? { projectId: scope.projectId } : {}),
				...(scope.projectName ? { projectName: scope.projectName } : {}),
				...(scope.repository ? { repository: scope.repository } : {}),
			},
		});
	}
	return references;
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
				!tag.startsWith(PROJECT_NAME_TAG_PREFIX) &&
				!tag.startsWith(SESSION_TAG_PREFIX),
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
	const request: RemoteListRequest = {
		type: MemoryType.PROJECT,
		teamId: config.teamId,
		repository: scope.repository,
		agent: MAESTRO_AGENT,
		agentId: config.agentId,
		reviewStatus: "approved",
	};
	const response = await config.client.list(request);
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
		sessionId?: string;
		tags?: string[];
	},
): Promise<{ entry: MemoryEntry; created: boolean; updated: boolean }> {
	const nextContent = normalizeContent(content);
	const nextTags = buildRemoteMemoryTags(
		topic,
		options?.tags,
		scope.projectName,
		options?.sessionId,
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
		const request: RemoteStoreRequest = {
			type: MemoryType.PROJECT,
			content: nextContent,
			teamId: config.teamId,
			repository: scope.repository,
			agent: MAESTRO_AGENT,
			agentId: config.agentId,
			tags: nextTags,
			reviewStatus: "approved",
			sourceReferences: buildSourceReferences(topic, scope, {
				sessionId: options?.sessionId,
			}),
		};
		const created = requireMemory(
			(await config.client.store(request)).memory,
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
				reviewStatus: "approved",
				sourceReferences: buildSourceReferences(topic, scope, {
					sessionId: options?.sessionId,
				}),
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
		sessionId?: string;
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
		{ sessionId: options?.sessionId, tags: options?.tags },
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
		const request: RemoteRecallRequest = {
			query,
			limit: options?.limit ?? 10,
			type: MemoryType.PROJECT,
			teamId: config.teamId,
			repository: scope.repository,
			agent: MAESTRO_AGENT,
			agentId: config.agentId,
			reviewStatus: "approved",
		};
		const response = await config.client.recall(request);
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
