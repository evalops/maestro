import type { MessageInitShape } from "@bufbuild/protobuf";
import { ConsolidateRequestSchema, DeleteMemoryRequestSchema, GetHistoryRequestSchema, GetMemoryRequestSchema, GetOperatingRulesRequestSchema, ListMemoriesRequestSchema, RecallKnowledgeRequestSchema, RecallRequestSchema, SetEmbeddingRequestSchema, StoreRequestSchema, UpdateMemoryRequestSchema } from "@evalops/memory/memory/v1/memory_pb";
export type FetchLike = typeof fetch;
export interface MemoryClientOptions {
    baseUrl: string;
    accessToken: string;
    organizationId: string;
    fetch?: FetchLike;
    headers?: HeadersInit;
}
export interface MemorySourceReference {
    uri: string;
    title?: string;
    type?: string;
    metadata?: Record<string, string>;
}
export type MemoryReviewStatus = "approved" | "proposed" | "rejected";
export type ExtendedStoreRequest = MessageInitShape<typeof StoreRequestSchema> & {
    agentId?: string;
    userId?: string;
    source?: string;
    confidence?: number;
    pinned?: boolean;
    isPolicy?: boolean;
    sourceReferences?: MemorySourceReference[];
    expiresAt?: string | Date;
    supersedesMemoryId?: string;
    reviewStatus?: MemoryReviewStatus | string;
    proposedBy?: string;
    proposalReason?: string;
    entityIds?: string[];
};
export type ExtendedUpdateRequest = MessageInitShape<typeof UpdateMemoryRequestSchema> & {
    type?: string;
    source?: string;
    confidence?: number;
    pinned?: boolean;
    isPolicy?: boolean;
    sourceReferences?: MemorySourceReference[];
    expiresAt?: string | Date;
    reviewStatus?: MemoryReviewStatus | string;
    proposedBy?: string;
    proposalReason?: string;
    entityIds?: string[];
};
export type ExtendedListRequest = MessageInitShape<typeof ListMemoriesRequestSchema> & {
    agentId?: string;
    userId?: string;
    reviewStatus?: MemoryReviewStatus | string;
    entityIds?: string[];
};
export type ExtendedRecallRequest = MessageInitShape<typeof RecallRequestSchema> & {
    agentId?: string;
    userId?: string;
    reviewStatus?: MemoryReviewStatus | string;
    entityIds?: string[];
    relationshipDepth?: number;
    relationshipTypes?: string[];
    asOf?: string | Date;
    topK?: number;
    minSimilarity?: number;
};
export type ExtendedRecallKnowledgeRequest = MessageInitShape<typeof RecallKnowledgeRequestSchema> & {
    agentId?: string;
    userId?: string;
    reviewStatus?: MemoryReviewStatus | string;
    topK?: number;
};
export type ExtendedOperatingRulesRequest = MessageInitShape<typeof GetOperatingRulesRequestSchema> & {
    agentId?: string;
    userId?: string;
    reviewStatus?: MemoryReviewStatus | string;
};
export declare class MemoryClientError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly responseBody?: unknown;
    constructor(status: number, code?: string, responseBody?: unknown);
}
export declare class MemoryClient {
    #private;
    constructor(options: MemoryClientOptions);
    store(request: ExtendedStoreRequest): Promise<import("@evalops/memory/memory/v1/memory_pb").StoreResponse>;
    get(request: MessageInitShape<typeof GetMemoryRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").GetMemoryResponse>;
    list(request?: ExtendedListRequest): Promise<import("@evalops/memory/memory/v1/memory_pb").ListMemoriesResponse>;
    update(request: ExtendedUpdateRequest): Promise<import("@evalops/memory/memory/v1/memory_pb").UpdateMemoryResponse>;
    delete(request: MessageInitShape<typeof DeleteMemoryRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").DeleteMemoryResponse>;
    history(request: MessageInitShape<typeof GetHistoryRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").GetHistoryResponse>;
    setEmbedding(request: MessageInitShape<typeof SetEmbeddingRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").SetEmbeddingResponse>;
    recall(request: ExtendedRecallRequest): Promise<import("@evalops/memory/memory/v1/memory_pb").RecallResponse>;
    recallKnowledge(request: ExtendedRecallKnowledgeRequest): Promise<import("@evalops/memory/memory/v1/memory_pb").RecallResponse>;
    getOperatingRules(request?: ExtendedOperatingRulesRequest): Promise<import("@evalops/memory/memory/v1/memory_pb").ListMemoriesResponse>;
    consolidate(request?: MessageInitShape<typeof ConsolidateRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").ConsolidateResponse>;
}
