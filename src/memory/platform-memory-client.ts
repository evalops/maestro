export enum MemoryType {
	PROJECT = "project",
}

export type FetchLike = typeof fetch;
export type MemoryHeadersInit = ConstructorParameters<typeof Headers>[0];

export interface MemoryClientOptions {
	accessToken: string;
	baseUrl: string;
	fetch?: FetchLike;
	headers?: MemoryHeadersInit;
	organizationId: string;
}

export interface MemorySourceReference {
	metadata?: Record<string, string>;
	title?: string;
	type?: string;
	uri: string;
}

export type MemoryReviewStatus = "approved" | "proposed" | "rejected";

type Timestamp = {
	nanos?: number;
	seconds?: number;
};

export type RemoteMemoryRecord = {
	agent?: string;
	content: string;
	contentHash?: string;
	createdAt?: Timestamp;
	deletedAt?: Timestamp;
	embedding?: number[];
	id: string;
	organizationId?: string;
	projectId?: string;
	repository?: string;
	score?: number;
	tags?: string[];
	teamId?: string;
	type?: MemoryType | string;
	updatedAt?: Timestamp;
};

export type StoreMemoryRequest = {
	agent?: string;
	agentId?: string;
	confidence?: number;
	content: string;
	entityIds?: string[];
	expiresAt?: Date | string;
	id?: string;
	isPolicy?: boolean;
	pinned?: boolean;
	projectId?: string;
	proposalReason?: string;
	proposedBy?: string;
	repository?: string;
	reviewStatus?: MemoryReviewStatus | string;
	source?: string;
	sourceReferences?: MemorySourceReference[];
	supersedesMemoryId?: string;
	tags?: string[];
	teamId?: string;
	type?: MemoryType | string;
	userId?: string;
};

export type ListMemoriesRequest = {
	agent?: string;
	agentId?: string;
	entityIds?: string[];
	limit?: number;
	offset?: number;
	projectId?: string;
	repository?: string;
	reviewStatus?: MemoryReviewStatus | string;
	teamId?: string;
	type?: MemoryType | string;
	userId?: string;
};

export type RecallMemoriesRequest = ListMemoriesRequest & {
	asOf?: Date | string;
	embedding?: number[];
	minSimilarity?: number;
	query: string;
	relationshipDepth?: number;
	relationshipTypes?: string[];
	topK?: number;
};

export type UpdateMemoryRequest = {
	confidence?: number;
	content?: string;
	entityIds?: string[];
	expiresAt?: Date | string;
	id: string;
	isPolicy?: boolean;
	pinned?: boolean;
	proposalReason?: string;
	proposedBy?: string;
	reviewStatus?: MemoryReviewStatus | string;
	source?: string;
	sourceReferences?: MemorySourceReference[];
	tags?: string[];
	type?: MemoryType | string;
};

export type DeleteMemoryRequest = {
	id: string;
};

export type MemoryResponse = {
	memory?: RemoteMemoryRecord;
};

export type MemoryListResponse = {
	limit?: number;
	memories: RemoteMemoryRecord[];
	offset?: number;
	total?: number;
};

export class MemoryClientError extends Error {
	constructor(
		readonly status: number,
		readonly code?: string,
		readonly responseBody?: unknown,
	) {
		super(
			code
				? `memory request failed: ${status} ${code}`
				: `memory request failed: ${status}`,
		);
		this.name = "MemoryClientError";
	}
}

export class MemoryClient {
	readonly #accessToken: string;
	readonly #baseUrl: string;
	readonly #fetch: FetchLike;
	readonly #headers?: MemoryHeadersInit;
	readonly #organizationId: string;

	constructor(options: MemoryClientOptions) {
		const fetchImpl = options.fetch ?? globalThis.fetch;
		if (!fetchImpl) {
			throw new Error("MemoryClient requires a fetch implementation");
		}

		this.#accessToken = options.accessToken;
		this.#baseUrl = normalizeBaseUrl(options.baseUrl);
		this.#fetch = fetchImpl;
		this.#headers = options.headers;
		this.#organizationId = options.organizationId;
	}

	async store(request: StoreMemoryRequest): Promise<MemoryResponse> {
		const payload = await this.#requestJson("/v1/memories", {
			body: serializeStoreRequest(request),
			method: "POST",
		});
		return { memory: deserializeMemory(payload) };
	}

	async list(request: ListMemoriesRequest = {}): Promise<MemoryListResponse> {
		const payload = await this.#requestJson("/v1/memories", {
			method: "GET",
			query: buildListQuery(request),
		});
		return {
			limit: getNumberField(payload, "limit"),
			memories: getArrayField(payload, "memories").map(deserializeMemory),
			offset: getNumberField(payload, "offset"),
			total: getNumberField(payload, "total"),
		};
	}

	async update(request: UpdateMemoryRequest): Promise<MemoryResponse> {
		const payload = await this.#requestJson(
			`/v1/memories/${encodeURIComponent(request.id)}`,
			{
				body: serializeUpdateRequest(request),
				method: "PUT",
			},
		);
		return { memory: deserializeMemory(payload) };
	}

	async delete(request: DeleteMemoryRequest): Promise<MemoryResponse> {
		const payload = await this.#requestJson(
			`/v1/memories/${encodeURIComponent(request.id)}`,
			{
				method: "DELETE",
			},
		);
		return { memory: deserializeMemory(payload) };
	}

	async recall(request: RecallMemoriesRequest): Promise<MemoryListResponse> {
		const payload = await this.#requestJson("/v1/memories/recall", {
			body: serializeRecallRequest(request),
			method: "POST",
		});
		return {
			memories: getArrayField(payload, "memories").map(deserializeMemory),
			total: getNumberField(payload, "total"),
		};
	}

	async #requestJson(
		path: string,
		init: {
			body?: unknown;
			method: string;
			query?: URLSearchParams;
		},
	): Promise<unknown> {
		const url = new URL(path.replace(/^\//, ""), this.#baseUrl);
		if (init.query) {
			for (const [key, value] of init.query.entries()) {
				url.searchParams.append(key, value);
			}
		}

		const headers = new Headers(this.#headers);
		headers.set("Authorization", `Bearer ${this.#accessToken}`);
		headers.set("X-Organization-ID", this.#organizationId);

		let body: string | undefined;
		if (init.body !== undefined) {
			headers.set("Content-Type", "application/json");
			body = JSON.stringify(init.body);
		}

		const response = await this.#fetch(url, {
			body,
			headers,
			method: init.method,
		});
		const payload = await parseJsonResponse(response);
		if (!response.ok) {
			throw new MemoryClientError(
				response.status,
				getErrorCode(payload),
				payload,
			);
		}
		return payload;
	}
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function buildListQuery(request: ListMemoriesRequest): URLSearchParams {
	const params = new URLSearchParams();
	appendStringParam(params, "type", serializeMemoryType(request.type));
	appendStringParam(params, "project_id", request.projectId);
	appendStringParam(params, "team_id", request.teamId);
	appendStringParam(params, "user_id", request.userId);
	appendStringParam(params, "repository", request.repository);
	appendStringParam(params, "agent", request.agent);
	appendStringParam(params, "agent_id", request.agentId);
	appendStringParam(params, "review_status", request.reviewStatus);
	appendRepeatedStringParam(params, "entity_id", request.entityIds);
	appendNumberParam(params, "limit", request.limit);
	appendNumberParam(params, "offset", request.offset);
	return params;
}

function serializeStoreRequest(
	request: StoreMemoryRequest,
): Record<string, unknown> {
	return compactObject({
		agent: emptyStringToUndefined(request.agent),
		agent_id: request.agentId,
		confidence: request.confidence,
		content: emptyStringToUndefined(request.content),
		entity_ids: nonEmptyArray(request.entityIds),
		expires_at: serializeTimestamp(request.expiresAt),
		id: emptyStringToUndefined(request.id),
		is_policy: request.isPolicy,
		pinned: request.pinned,
		project_id: emptyStringToUndefined(request.projectId),
		proposal_reason: request.proposalReason,
		proposed_by: request.proposedBy,
		repository: emptyStringToUndefined(request.repository),
		review_status: request.reviewStatus,
		source: request.source,
		source_references: nonEmptyArray(request.sourceReferences),
		supersedes_memory_id: request.supersedesMemoryId,
		tags: nonEmptyArray(request.tags),
		team_id: emptyStringToUndefined(request.teamId),
		type: serializeMemoryType(request.type),
		user_id: request.userId,
	});
}

function serializeUpdateRequest(
	request: UpdateMemoryRequest,
): Record<string, unknown> {
	return compactObject({
		confidence: request.confidence,
		content: emptyStringToUndefined(request.content),
		entity_ids: nonEmptyArray(request.entityIds),
		expires_at: serializeTimestamp(request.expiresAt),
		is_policy: request.isPolicy,
		pinned: request.pinned,
		proposal_reason: request.proposalReason,
		proposed_by: request.proposedBy,
		review_status: request.reviewStatus,
		source: request.source,
		source_references: nonEmptyArray(request.sourceReferences),
		tags: nonEmptyArray(request.tags),
		type: serializeMemoryType(request.type),
	});
}

function serializeRecallRequest(
	request: RecallMemoriesRequest,
): Record<string, unknown> {
	return compactObject({
		agent: emptyStringToUndefined(request.agent),
		agent_id: request.agentId,
		as_of: serializeTimestamp(request.asOf),
		embedding: nonEmptyArray(request.embedding),
		entity_ids: nonEmptyArray(request.entityIds),
		limit: positiveNumber(request.limit),
		min_similarity: request.minSimilarity,
		project_id: emptyStringToUndefined(request.projectId),
		query: emptyStringToUndefined(request.query),
		relationship_depth: request.relationshipDepth,
		relationship_types: nonEmptyArray(request.relationshipTypes),
		repository: emptyStringToUndefined(request.repository),
		review_status: request.reviewStatus,
		team_id: emptyStringToUndefined(request.teamId),
		top_k: request.topK,
		type: serializeMemoryType(request.type),
		user_id: request.userId,
	});
}

function deserializeMemory(value: unknown): RemoteMemoryRecord {
	const json = asRecord(value);
	return {
		agent: getStringValue(json.agent),
		content: getStringValue(json.content),
		contentHash: getStringValue(json.content_hash),
		createdAt: parseTimestamp(json.created_at),
		deletedAt: parseTimestamp(json.deleted_at),
		embedding: getNumberArray(json.embedding),
		id: getStringValue(json.id),
		organizationId: getStringValue(json.organization_id),
		projectId: getStringValue(json.project_id),
		repository: getStringValue(json.repository),
		score: getNumberValue(json.score),
		tags: getStringArray(json.tags),
		teamId: getStringValue(json.team_id),
		type: parseMemoryType(json.type),
		updatedAt: parseTimestamp(json.updated_at),
	};
}

function serializeMemoryType(
	type: MemoryType | string | undefined,
): string | undefined {
	switch (type) {
		case "user":
		case "feedback":
		case "project":
		case "reference":
		case "entity":
		case "knowledge":
		case "operating_rule":
			return type;
		default:
			return undefined;
	}
}

function parseMemoryType(value: unknown): MemoryType | string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseTimestamp(value: unknown): Timestamp | undefined {
	if (typeof value !== "string" || value.length === 0) {
		return undefined;
	}
	const millis = new Date(value).getTime();
	if (!Number.isFinite(millis)) {
		return undefined;
	}
	return {
		nanos: (millis % 1000) * 1_000_000,
		seconds: Math.floor(millis / 1000),
	};
}

async function parseJsonResponse(response: Response): Promise<unknown> {
	const text = await response.text();
	if (text === "") {
		return undefined;
	}
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function getErrorCode(value: unknown): string | undefined {
	const record = asOptionalRecord(value);
	const error = record?.error;
	return typeof error === "string" ? error : undefined;
}

function appendStringParam(
	params: URLSearchParams,
	key: string,
	value: string | undefined,
): void {
	if (value) {
		params.set(key, value);
	}
}

function appendRepeatedStringParam(
	params: URLSearchParams,
	key: string,
	values: string[] | undefined,
): void {
	for (const value of values ?? []) {
		if (value) {
			params.append(key, value);
		}
	}
}

function appendNumberParam(
	params: URLSearchParams,
	key: string,
	value: number | undefined,
): void {
	if (value !== undefined && value > 0) {
		params.set(key, String(value));
	}
}

function compactObject(
	object: Record<string, unknown>,
): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(object).filter(([, value]) => value !== undefined),
	);
}

function emptyStringToUndefined(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

function nonEmptyArray<T>(values: T[] | undefined): T[] | undefined {
	return values && values.length > 0 ? values : undefined;
}

function positiveNumber(value: number | undefined): number | undefined {
	return value !== undefined && value > 0 ? value : undefined;
}

function serializeTimestamp(
	value: Date | string | undefined,
): string | undefined {
	if (typeof value === "string") {
		return value.trim() || undefined;
	}
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value.toISOString();
	}
	return undefined;
}

function getArrayField(value: unknown, key: string): unknown[] {
	const record = asRecord(value);
	const field = record[key];
	return Array.isArray(field) ? field : [];
}

function getNumberField(value: unknown, key: string): number | undefined {
	const field = asRecord(value)[key];
	return typeof field === "number" && Number.isFinite(field)
		? field
		: undefined;
}

function getStringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function getNumberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function getNumberArray(value: unknown): number[] {
	return Array.isArray(value)
		? value.filter(
				(entry): entry is number =>
					typeof entry === "number" && Number.isFinite(entry),
			)
		: [];
}

function asRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
