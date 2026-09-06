import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ConsolidateRequestSchema, ConsolidateResponseSchema, DeleteMemoryRequestSchema, DeleteMemoryResponseSchema, GetHistoryRequestSchema, GetHistoryResponseSchema, GetMemoryRequestSchema, GetMemoryResponseSchema, GetOperatingRulesRequestSchema, ListMemoriesRequestSchema, ListMemoriesResponseSchema, MemoryHistoryEvent, MemoryHistorySchema, MemorySchema, MemoryType, RecallKnowledgeRequestSchema, RecallRequestSchema, RecallResponseSchema, SetEmbeddingRequestSchema, SetEmbeddingResponseSchema, StoreRequestSchema, StoreResponseSchema, UpdateMemoryRequestSchema, UpdateMemoryResponseSchema, } from "@evalops/memory/memory/v1/memory_pb";
export class MemoryClientError extends Error {
    status;
    code;
    responseBody;
    constructor(status, code, responseBody) {
        super(code ? `memory request failed: ${status} ${code}` : `memory request failed: ${status}`);
        this.name = "MemoryClientError";
        this.status = status;
        this.code = code;
        this.responseBody = responseBody;
    }
}
export class MemoryClient {
    #accessToken;
    #baseUrl;
    #fetch;
    #headers;
    #organizationId;
    constructor(options) {
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
    async store(request) {
        const message = create(StoreRequestSchema, request);
        const payload = await this.#requestJson("/v1/memories", {
            body: serializeStoreRequest(message, request),
            method: "POST",
        });
        return create(StoreResponseSchema, {
            memory: deserializeMemory(payload),
        });
    }
    async get(request) {
        const message = create(GetMemoryRequestSchema, request);
        const payload = await this.#requestJson(`/v1/memories/${encodeURIComponent(message.id)}`, {
            method: "GET",
        });
        return create(GetMemoryResponseSchema, {
            memory: deserializeMemory(payload),
        });
    }
    async list(request = {}) {
        const message = create(ListMemoriesRequestSchema, request);
        const payload = await this.#requestJson("/v1/memories", {
            method: "GET",
            query: buildListQuery(message, request),
        });
        return create(ListMemoriesResponseSchema, {
            limit: getIntField(payload, "limit"),
            memories: getArrayField(payload, "memories").map(deserializeMemory),
            offset: getIntField(payload, "offset"),
            total: getIntField(payload, "total"),
        });
    }
    async update(request) {
        const message = create(UpdateMemoryRequestSchema, request);
        const payload = await this.#requestJson(`/v1/memories/${encodeURIComponent(message.id)}`, {
            body: serializeUpdateRequest(message, request),
            method: "PUT",
        });
        return create(UpdateMemoryResponseSchema, {
            memory: deserializeMemory(payload),
        });
    }
    async delete(request) {
        const message = create(DeleteMemoryRequestSchema, request);
        const payload = await this.#requestJson(`/v1/memories/${encodeURIComponent(message.id)}`, {
            method: "DELETE",
        });
        return create(DeleteMemoryResponseSchema, {
            memory: deserializeMemory(payload),
        });
    }
    async history(request) {
        const message = create(GetHistoryRequestSchema, request);
        const payload = await this.#requestJson(`/v1/memories/${encodeURIComponent(message.id)}/history`, {
            method: "GET",
        });
        return create(GetHistoryResponseSchema, {
            history: getArrayField(payload, "history").map(deserializeHistory),
        });
    }
    async setEmbedding(request) {
        const message = create(SetEmbeddingRequestSchema, request);
        const payload = await this.#requestJson(`/v1/memories/${encodeURIComponent(message.id)}/embedding`, {
            body: {
                embedding: message.embedding,
            },
            method: "PUT",
        });
        return create(SetEmbeddingResponseSchema, {
            status: getStringField(payload, "status"),
        });
    }
    async recall(request) {
        const message = create(RecallRequestSchema, request);
        const payload = await this.#requestJson("/v1/memories/recall", {
            body: serializeRecallRequest(message, request),
            method: "POST",
        });
        return create(RecallResponseSchema, {
            memories: getArrayField(payload, "memories").map(deserializeMemory),
            query: getStringField(payload, "query"),
            total: getIntField(payload, "total"),
        });
    }
    async recallKnowledge(request) {
        const message = create(RecallKnowledgeRequestSchema, request);
        const payload = await this.#requestJson("/v1/memories/knowledge/recall", {
            body: serializeRecallKnowledgeRequest(message, request),
            method: "POST",
        });
        return create(RecallResponseSchema, {
            memories: getArrayField(payload, "memories").map(deserializeMemory),
            query: getStringField(payload, "query"),
            total: getIntField(payload, "total"),
        });
    }
    async getOperatingRules(request = {}) {
        const message = create(GetOperatingRulesRequestSchema, request);
        const payload = await this.#requestJson("/v1/memories/operating-rules", {
            method: "GET",
            query: buildOperatingRulesQuery(message, request),
        });
        return create(ListMemoriesResponseSchema, {
            limit: getIntField(payload, "limit"),
            memories: getArrayField(payload, "memories").map(deserializeMemory),
            offset: getIntField(payload, "offset"),
            total: getIntField(payload, "total"),
        });
    }
    async consolidate(request = {}) {
        create(ConsolidateRequestSchema, request);
        const payload = await this.#requestJson("/v1/memories/consolidate", {
            method: "POST",
        });
        return create(ConsolidateResponseSchema, {
            consolidated: getIntField(payload, "consolidated"),
        });
    }
    async #requestJson(path, init) {
        const url = new URL(path.replace(/^\//, ""), this.#baseUrl);
        if (init.query) {
            for (const [key, value] of init.query.entries()) {
                url.searchParams.set(key, value);
            }
        }
        const headers = new Headers(this.#headers);
        headers.set("Authorization", `Bearer ${this.#accessToken}`);
        headers.set("X-Organization-ID", this.#organizationId);
        let body;
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
            throw new MemoryClientError(response.status, getErrorCode(payload), payload);
        }
        return payload;
    }
}
function normalizeBaseUrl(baseUrl) {
    return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}
function buildListQuery(message, request) {
    const params = new URLSearchParams();
    appendStringParam(params, "type", serializeMemoryType(message.type));
    appendStringParam(params, "project_id", message.projectId);
    appendStringParam(params, "team_id", message.teamId);
    appendStringParam(params, "user_id", requestString(request, "userId", "user_id"));
    appendStringParam(params, "repository", message.repository);
    appendStringParam(params, "agent", message.agent);
    appendStringParam(params, "agent_id", requestString(request, "agentId", "agent_id"));
    appendStringParam(params, "review_status", requestString(request, "reviewStatus", "review_status"));
    appendRepeatedStringParam(params, "entity_id", requestStringArray(request, "entityIds", "entity_ids"));
    appendNumberParam(params, "limit", message.limit);
    appendNumberParam(params, "offset", message.offset);
    return params;
}
function buildOperatingRulesQuery(message, request) {
    const params = new URLSearchParams();
    appendStringParam(params, "project_id", message.projectId);
    appendStringParam(params, "team_id", message.teamId);
    appendStringParam(params, "user_id", requestString(request, "userId", "user_id"));
    appendStringParam(params, "repository", message.repository);
    appendStringParam(params, "agent", message.agent);
    appendStringParam(params, "agent_id", requestString(request, "agentId", "agent_id"));
    appendStringParam(params, "review_status", requestString(request, "reviewStatus", "review_status"));
    appendNumberParam(params, "limit", message.limit);
    appendNumberParam(params, "offset", message.offset);
    return params;
}
function serializeStoreRequest(message, request) {
    return compactObject({
        agent: emptyStringToUndefined(message.agent),
        agent_id: requestString(request, "agentId", "agent_id"),
        content: emptyStringToUndefined(message.content),
        confidence: requestNumber(request, "confidence"),
        entity_ids: requestStringArray(request, "entityIds", "entity_ids"),
        expires_at: requestTimestamp(request, "expiresAt", "expires_at"),
        id: emptyStringToUndefined(message.id),
        is_policy: requestBoolean(request, "isPolicy", "is_policy"),
        pinned: requestBoolean(request, "pinned"),
        proposed_by: requestString(request, "proposedBy", "proposed_by"),
        proposal_reason: requestString(request, "proposalReason", "proposal_reason"),
        project_id: emptyStringToUndefined(message.projectId),
        repository: emptyStringToUndefined(message.repository),
        review_status: requestString(request, "reviewStatus", "review_status"),
        source: requestString(request, "source"),
        source_references: requestArray(request, "sourceReferences", "source_references"),
        supersedes_memory_id: requestString(request, "supersedesMemoryId", "supersedes_memory_id"),
        tags: message.tags.length > 0 ? message.tags : undefined,
        team_id: emptyStringToUndefined(message.teamId),
        type: serializeMemoryType(message.type),
        user_id: requestString(request, "userId", "user_id"),
    });
}
function serializeUpdateRequest(message, request) {
    return compactObject({
        content: emptyStringToUndefined(message.content),
        confidence: requestNumber(request, "confidence"),
        entity_ids: requestStringArray(request, "entityIds", "entity_ids"),
        expires_at: requestTimestamp(request, "expiresAt", "expires_at"),
        is_policy: requestBoolean(request, "isPolicy", "is_policy"),
        pinned: requestBoolean(request, "pinned"),
        proposed_by: requestString(request, "proposedBy", "proposed_by"),
        proposal_reason: requestString(request, "proposalReason", "proposal_reason"),
        review_status: requestString(request, "reviewStatus", "review_status"),
        source: requestString(request, "source"),
        source_references: requestArray(request, "sourceReferences", "source_references"),
        tags: message.tags.length > 0 ? message.tags : undefined,
        type: requestString(request, "type"),
    });
}
function serializeRecallRequest(message, request) {
    return compactObject({
        agent: emptyStringToUndefined(message.agent),
        agent_id: requestString(request, "agentId", "agent_id"),
        as_of: requestTimestamp(request, "asOf", "as_of"),
        embedding: message.embedding.length > 0 ? message.embedding : undefined,
        entity_ids: requestStringArray(request, "entityIds", "entity_ids"),
        limit: message.limit > 0 ? message.limit : undefined,
        min_similarity: requestNumber(request, "minSimilarity", "min_similarity"),
        project_id: emptyStringToUndefined(message.projectId),
        query: emptyStringToUndefined(message.query),
        relationship_depth: requestNumber(request, "relationshipDepth", "relationship_depth"),
        relationship_types: requestStringArray(request, "relationshipTypes", "relationship_types"),
        repository: emptyStringToUndefined(message.repository),
        review_status: requestString(request, "reviewStatus", "review_status"),
        team_id: emptyStringToUndefined(message.teamId),
        top_k: requestNumber(request, "topK", "top_k"),
        type: serializeMemoryType(message.type),
        user_id: requestString(request, "userId", "user_id"),
    });
}
function serializeRecallKnowledgeRequest(message, request) {
    return compactObject({
        agent: emptyStringToUndefined(message.agent),
        agent_id: requestString(request, "agentId", "agent_id"),
        conditions: message.conditions.length > 0 ? message.conditions : undefined,
        limit: message.limit > 0 ? message.limit : undefined,
        project_id: emptyStringToUndefined(message.projectId),
        repository: emptyStringToUndefined(message.repository),
        review_status: requestString(request, "reviewStatus", "review_status"),
        team_id: emptyStringToUndefined(message.teamId),
        top_k: requestNumber(request, "topK", "top_k"),
        user_id: requestString(request, "userId", "user_id"),
    });
}
function deserializeMemory(value) {
    const json = asJsonRecord(value);
    return create(MemorySchema, {
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
    });
}
function deserializeHistory(value) {
    const json = asJsonRecord(value);
    return create(MemoryHistorySchema, {
        createdAt: parseTimestamp(json.created_at),
        event: parseHistoryEvent(json.event),
        id: getStringValue(json.id),
        memoryId: getStringValue(json.memory_id),
        newContent: getStringValue(json.new_content),
        organizationId: getStringValue(json.organization_id),
        prevContent: getStringValue(json.prev_content),
    });
}
function serializeMemoryType(type) {
    switch (type) {
        case MemoryType.USER:
            return "user";
        case MemoryType.FEEDBACK:
            return "feedback";
        case MemoryType.PROJECT:
            return "project";
        case MemoryType.REFERENCE:
            return "reference";
        case MemoryType.ENTITY:
            return "entity";
        case MemoryType.KNOWLEDGE:
            return "knowledge";
        case MemoryType.OPERATING_RULE:
            return "operating_rule";
        default:
            return undefined;
    }
}
function parseMemoryType(value) {
    switch (value) {
        case "user":
            return MemoryType.USER;
        case "feedback":
            return MemoryType.FEEDBACK;
        case "project":
            return MemoryType.PROJECT;
        case "reference":
            return MemoryType.REFERENCE;
        case "entity":
            return MemoryType.ENTITY;
        case "knowledge":
            return MemoryType.KNOWLEDGE;
        case "operating_rule":
            return MemoryType.OPERATING_RULE;
        default:
            return MemoryType.UNSPECIFIED;
    }
}
function parseHistoryEvent(value) {
    switch (value) {
        case "create":
            return MemoryHistoryEvent.CREATE;
        case "update":
            return MemoryHistoryEvent.UPDATE;
        case "delete":
            return MemoryHistoryEvent.DELETE;
        default:
            return MemoryHistoryEvent.UNSPECIFIED;
    }
}
function parseTimestamp(value) {
    if (typeof value !== "string" || value.length === 0) {
        return undefined;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return undefined;
    }
    return timestampFromDate(date);
}
function compactObject(object) {
    return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}
function appendStringParam(params, key, value) {
    if (value) {
        params.set(key, value);
    }
}
function appendRepeatedStringParam(params, key, values) {
    for (const value of values ?? []) {
        if (value) {
            params.append(key, value);
        }
    }
}
function appendNumberParam(params, key, value) {
    if (value > 0) {
        params.set(key, String(value));
    }
}
function emptyStringToUndefined(value) {
    return value === "" ? undefined : value;
}
async function parseJsonResponse(response) {
    const text = await response.text();
    if (text === "") {
        return undefined;
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function getErrorCode(value) {
    const record = asJsonRecord(value, false);
    if (!record) {
        return undefined;
    }
    const error = record.error;
    return typeof error === "string" ? error : undefined;
}
function getArrayField(value, key) {
    const record = asJsonRecord(value);
    const field = record[key];
    return Array.isArray(field) ? field : [];
}
function getIntField(value, key) {
    const record = asJsonRecord(value);
    return getNumberValue(record[key]);
}
function getStringField(value, key) {
    const record = asJsonRecord(value);
    return getStringValue(record[key]);
}
function getStringValue(value) {
    return typeof value === "string" ? value : "";
}
function getNumberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function getStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry) => typeof entry === "string");
}
function getNumberArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry) => typeof entry === "number" && Number.isFinite(entry));
}
function requestRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function requestValue(request, camelKey, snakeKey = camelKey) {
    const record = requestRecord(request);
    return record[camelKey] ?? record[snakeKey];
}
function requestString(request, camelKey, snakeKey = camelKey) {
    const value = requestValue(request, camelKey, snakeKey);
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function requestNumber(request, camelKey, snakeKey = camelKey) {
    const value = requestValue(request, camelKey, snakeKey);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function requestBoolean(request, camelKey, snakeKey = camelKey) {
    const value = requestValue(request, camelKey, snakeKey);
    return typeof value === "boolean" ? value : undefined;
}
function requestArray(request, camelKey, snakeKey = camelKey) {
    const value = requestValue(request, camelKey, snakeKey);
    return Array.isArray(value) && value.length > 0 ? value : undefined;
}
function requestStringArray(request, camelKey, snakeKey = camelKey) {
    const values = requestArray(request, camelKey, snakeKey)?.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
    return values && values.length > 0 ? values : undefined;
}
function requestTimestamp(request, camelKey, snakeKey = camelKey) {
    const value = requestValue(request, camelKey, snakeKey);
    if (typeof value === "string") {
        return value.trim() || undefined;
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString();
    }
    return undefined;
}
function asJsonRecord(value, required = true) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    if (!required) {
        return undefined;
    }
    throw new Error("memory client received a non-object JSON payload");
}
