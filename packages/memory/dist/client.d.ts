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
export declare class MemoryClientError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly responseBody?: unknown;
    constructor(status: number, code?: string, responseBody?: unknown);
}
export declare class MemoryClient {
    #private;
    constructor(options: MemoryClientOptions);
    store(request: MessageInitShape<typeof StoreRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").StoreResponse>;
    get(request: MessageInitShape<typeof GetMemoryRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").GetMemoryResponse>;
    list(request?: MessageInitShape<typeof ListMemoriesRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").ListMemoriesResponse>;
    update(request: MessageInitShape<typeof UpdateMemoryRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").UpdateMemoryResponse>;
    delete(request: MessageInitShape<typeof DeleteMemoryRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").DeleteMemoryResponse>;
    history(request: MessageInitShape<typeof GetHistoryRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").GetHistoryResponse>;
    setEmbedding(request: MessageInitShape<typeof SetEmbeddingRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").SetEmbeddingResponse>;
    recall(request: MessageInitShape<typeof RecallRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").RecallResponse>;
    recallKnowledge(request: MessageInitShape<typeof RecallKnowledgeRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").RecallResponse>;
    getOperatingRules(request?: MessageInitShape<typeof GetOperatingRulesRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").ListMemoriesResponse>;
    consolidate(request?: MessageInitShape<typeof ConsolidateRequestSchema>): Promise<import("@evalops/memory/memory/v1/memory_pb").ConsolidateResponse>;
}
