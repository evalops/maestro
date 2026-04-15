import type { GenEnum, GenFile, GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import type { Message } from "@bufbuild/protobuf";
/**
 * Describes the file memory/v1/memory.proto.
 */
export declare const file_memory_v1_memory: GenFile;
/**
 * @generated from message memory.v1.Memory
 */
export type Memory = Message<"memory.v1.Memory"> & {
    /**
     * @generated from field: string id = 1;
     */
    id: string;
    /**
     * @generated from field: string organization_id = 2;
     */
    organizationId: string;
    /**
     * @generated from field: memory.v1.MemoryType type = 3;
     */
    type: MemoryType;
    /**
     * @generated from field: string content = 4;
     */
    content: string;
    /**
     * @generated from field: string project_id = 5;
     */
    projectId: string;
    /**
     * @generated from field: string team_id = 6;
     */
    teamId: string;
    /**
     * @generated from field: string repository = 7;
     */
    repository: string;
    /**
     * @generated from field: string agent = 8;
     */
    agent: string;
    /**
     * @generated from field: repeated string tags = 9;
     */
    tags: string[];
    /**
     * @generated from field: string content_hash = 10;
     */
    contentHash: string;
    /**
     * @generated from field: repeated float embedding = 11 [packed = true];
     */
    embedding: number[];
    /**
     * @generated from field: double score = 12;
     */
    score: number;
    /**
     * @generated from field: google.protobuf.Timestamp created_at = 13;
     */
    createdAt?: Timestamp;
    /**
     * @generated from field: google.protobuf.Timestamp updated_at = 14;
     */
    updatedAt?: Timestamp;
    /**
     * @generated from field: google.protobuf.Timestamp deleted_at = 15;
     */
    deletedAt?: Timestamp;
};
/**
 * Describes the message memory.v1.Memory.
 * Use `create(MemorySchema)` to create a new message.
 */
export declare const MemorySchema: GenMessage<Memory>;
/**
 * @generated from message memory.v1.MemoryHistory
 */
export type MemoryHistory = Message<"memory.v1.MemoryHistory"> & {
    /**
     * @generated from field: string id = 1;
     */
    id: string;
    /**
     * @generated from field: string memory_id = 2;
     */
    memoryId: string;
    /**
     * @generated from field: string organization_id = 3;
     */
    organizationId: string;
    /**
     * @generated from field: string prev_content = 4;
     */
    prevContent: string;
    /**
     * @generated from field: string new_content = 5;
     */
    newContent: string;
    /**
     * @generated from field: memory.v1.MemoryHistoryEvent event = 6;
     */
    event: MemoryHistoryEvent;
    /**
     * @generated from field: google.protobuf.Timestamp created_at = 7;
     */
    createdAt?: Timestamp;
};
/**
 * Describes the message memory.v1.MemoryHistory.
 * Use `create(MemoryHistorySchema)` to create a new message.
 */
export declare const MemoryHistorySchema: GenMessage<MemoryHistory>;
/**
 * @generated from message memory.v1.StoreRequest
 */
export type StoreRequest = Message<"memory.v1.StoreRequest"> & {
    /**
     * @generated from field: string id = 1;
     */
    id: string;
    /**
     * @generated from field: memory.v1.MemoryType type = 2;
     */
    type: MemoryType;
    /**
     * @generated from field: string content = 3;
     */
    content: string;
    /**
     * @generated from field: string project_id = 4;
     */
    projectId: string;
    /**
     * @generated from field: string team_id = 5;
     */
    teamId: string;
    /**
     * @generated from field: string repository = 6;
     */
    repository: string;
    /**
     * @generated from field: string agent = 7;
     */
    agent: string;
    /**
     * @generated from field: repeated string tags = 8;
     */
    tags: string[];
};
/**
 * Describes the message memory.v1.StoreRequest.
 * Use `create(StoreRequestSchema)` to create a new message.
 */
export declare const StoreRequestSchema: GenMessage<StoreRequest>;
/**
 * @generated from message memory.v1.StoreResponse
 */
export type StoreResponse = Message<"memory.v1.StoreResponse"> & {
    /**
     * @generated from field: memory.v1.Memory memory = 1;
     */
    memory?: Memory;
};
/**
 * Describes the message memory.v1.StoreResponse.
 * Use `create(StoreResponseSchema)` to create a new message.
 */
export declare const StoreResponseSchema: GenMessage<StoreResponse>;
/**
 * @generated from message memory.v1.GetMemoryRequest
 */
export type GetMemoryRequest = Message<"memory.v1.GetMemoryRequest"> & {
    /**
     * @generated from field: string id = 1;
     */
    id: string;
};
/**
 * Describes the message memory.v1.GetMemoryRequest.
 * Use `create(GetMemoryRequestSchema)` to create a new message.
 */
export declare const GetMemoryRequestSchema: GenMessage<GetMemoryRequest>;
/**
 * @generated from message memory.v1.GetMemoryResponse
 */
export type GetMemoryResponse = Message<"memory.v1.GetMemoryResponse"> & {
    /**
     * @generated from field: memory.v1.Memory memory = 1;
     */
    memory?: Memory;
};
/**
 * Describes the message memory.v1.GetMemoryResponse.
 * Use `create(GetMemoryResponseSchema)` to create a new message.
 */
export declare const GetMemoryResponseSchema: GenMessage<GetMemoryResponse>;
/**
 * @generated from message memory.v1.ListMemoriesRequest
 */
export type ListMemoriesRequest = Message<"memory.v1.ListMemoriesRequest"> & {
    /**
     * @generated from field: memory.v1.MemoryType type = 1;
     */
    type: MemoryType;
    /**
     * @generated from field: string project_id = 2;
     */
    projectId: string;
    /**
     * @generated from field: string team_id = 3;
     */
    teamId: string;
    /**
     * @generated from field: string repository = 4;
     */
    repository: string;
    /**
     * @generated from field: string agent = 5;
     */
    agent: string;
    /**
     * @generated from field: int32 limit = 6;
     */
    limit: number;
    /**
     * @generated from field: int32 offset = 7;
     */
    offset: number;
};
/**
 * Describes the message memory.v1.ListMemoriesRequest.
 * Use `create(ListMemoriesRequestSchema)` to create a new message.
 */
export declare const ListMemoriesRequestSchema: GenMessage<ListMemoriesRequest>;
/**
 * @generated from message memory.v1.ListMemoriesResponse
 */
export type ListMemoriesResponse = Message<"memory.v1.ListMemoriesResponse"> & {
    /**
     * @generated from field: repeated memory.v1.Memory memories = 1;
     */
    memories: Memory[];
    /**
     * @generated from field: int32 total = 2;
     */
    total: number;
    /**
     * @generated from field: int32 limit = 3;
     */
    limit: number;
    /**
     * @generated from field: int32 offset = 4;
     */
    offset: number;
};
/**
 * Describes the message memory.v1.ListMemoriesResponse.
 * Use `create(ListMemoriesResponseSchema)` to create a new message.
 */
export declare const ListMemoriesResponseSchema: GenMessage<ListMemoriesResponse>;
/**
 * @generated from message memory.v1.UpdateMemoryRequest
 */
export type UpdateMemoryRequest = Message<"memory.v1.UpdateMemoryRequest"> & {
    /**
     * @generated from field: string id = 1;
     */
    id: string;
    /**
     * @generated from field: string content = 2;
     */
    content: string;
    /**
     * @generated from field: repeated string tags = 3;
     */
    tags: string[];
};
/**
 * Describes the message memory.v1.UpdateMemoryRequest.
 * Use `create(UpdateMemoryRequestSchema)` to create a new message.
 */
export declare const UpdateMemoryRequestSchema: GenMessage<UpdateMemoryRequest>;
/**
 * @generated from message memory.v1.UpdateMemoryResponse
 */
export type UpdateMemoryResponse = Message<"memory.v1.UpdateMemoryResponse"> & {
    /**
     * @generated from field: memory.v1.Memory memory = 1;
     */
    memory?: Memory;
};
/**
 * Describes the message memory.v1.UpdateMemoryResponse.
 * Use `create(UpdateMemoryResponseSchema)` to create a new message.
 */
export declare const UpdateMemoryResponseSchema: GenMessage<UpdateMemoryResponse>;
/**
 * @generated from message memory.v1.DeleteMemoryRequest
 */
export type DeleteMemoryRequest = Message<"memory.v1.DeleteMemoryRequest"> & {
    /**
     * @generated from field: string id = 1;
     */
    id: string;
};
/**
 * Describes the message memory.v1.DeleteMemoryRequest.
 * Use `create(DeleteMemoryRequestSchema)` to create a new message.
 */
export declare const DeleteMemoryRequestSchema: GenMessage<DeleteMemoryRequest>;
/**
 * @generated from message memory.v1.DeleteMemoryResponse
 */
export type DeleteMemoryResponse = Message<"memory.v1.DeleteMemoryResponse"> & {
    /**
     * @generated from field: memory.v1.Memory memory = 1;
     */
    memory?: Memory;
};
/**
 * Describes the message memory.v1.DeleteMemoryResponse.
 * Use `create(DeleteMemoryResponseSchema)` to create a new message.
 */
export declare const DeleteMemoryResponseSchema: GenMessage<DeleteMemoryResponse>;
/**
 * @generated from message memory.v1.GetHistoryRequest
 */
export type GetHistoryRequest = Message<"memory.v1.GetHistoryRequest"> & {
    /**
     * @generated from field: string id = 1;
     */
    id: string;
};
/**
 * Describes the message memory.v1.GetHistoryRequest.
 * Use `create(GetHistoryRequestSchema)` to create a new message.
 */
export declare const GetHistoryRequestSchema: GenMessage<GetHistoryRequest>;
/**
 * @generated from message memory.v1.GetHistoryResponse
 */
export type GetHistoryResponse = Message<"memory.v1.GetHistoryResponse"> & {
    /**
     * @generated from field: repeated memory.v1.MemoryHistory history = 1;
     */
    history: MemoryHistory[];
};
/**
 * Describes the message memory.v1.GetHistoryResponse.
 * Use `create(GetHistoryResponseSchema)` to create a new message.
 */
export declare const GetHistoryResponseSchema: GenMessage<GetHistoryResponse>;
/**
 * @generated from message memory.v1.SetEmbeddingRequest
 */
export type SetEmbeddingRequest = Message<"memory.v1.SetEmbeddingRequest"> & {
    /**
     * @generated from field: string id = 1;
     */
    id: string;
    /**
     * @generated from field: repeated float embedding = 2 [packed = true];
     */
    embedding: number[];
};
/**
 * Describes the message memory.v1.SetEmbeddingRequest.
 * Use `create(SetEmbeddingRequestSchema)` to create a new message.
 */
export declare const SetEmbeddingRequestSchema: GenMessage<SetEmbeddingRequest>;
/**
 * @generated from message memory.v1.SetEmbeddingResponse
 */
export type SetEmbeddingResponse = Message<"memory.v1.SetEmbeddingResponse"> & {
    /**
     * @generated from field: string status = 1;
     */
    status: string;
};
/**
 * Describes the message memory.v1.SetEmbeddingResponse.
 * Use `create(SetEmbeddingResponseSchema)` to create a new message.
 */
export declare const SetEmbeddingResponseSchema: GenMessage<SetEmbeddingResponse>;
/**
 * @generated from message memory.v1.RecallRequest
 */
export type RecallRequest = Message<"memory.v1.RecallRequest"> & {
    /**
     * @generated from field: string query = 1;
     */
    query: string;
    /**
     * @generated from field: repeated float embedding = 2 [packed = true];
     */
    embedding: number[];
    /**
     * @generated from field: string project_id = 3;
     */
    projectId: string;
    /**
     * @generated from field: string team_id = 4;
     */
    teamId: string;
    /**
     * @generated from field: string repository = 5;
     */
    repository: string;
    /**
     * @generated from field: string agent = 6;
     */
    agent: string;
    /**
     * @generated from field: memory.v1.MemoryType type = 7;
     */
    type: MemoryType;
    /**
     * @generated from field: int32 limit = 8;
     */
    limit: number;
};
/**
 * Describes the message memory.v1.RecallRequest.
 * Use `create(RecallRequestSchema)` to create a new message.
 */
export declare const RecallRequestSchema: GenMessage<RecallRequest>;
/**
 * @generated from message memory.v1.RecallResponse
 */
export type RecallResponse = Message<"memory.v1.RecallResponse"> & {
    /**
     * @generated from field: repeated memory.v1.Memory memories = 1;
     */
    memories: Memory[];
    /**
     * @generated from field: string query = 2;
     */
    query: string;
    /**
     * @generated from field: int32 total = 3;
     */
    total: number;
};
/**
 * Describes the message memory.v1.RecallResponse.
 * Use `create(RecallResponseSchema)` to create a new message.
 */
export declare const RecallResponseSchema: GenMessage<RecallResponse>;
/**
 * @generated from message memory.v1.RecallKnowledgeRequest
 */
export type RecallKnowledgeRequest = Message<"memory.v1.RecallKnowledgeRequest"> & {
    /**
     * @generated from field: repeated string conditions = 1;
     */
    conditions: string[];
    /**
     * @generated from field: string project_id = 2;
     */
    projectId: string;
    /**
     * @generated from field: string team_id = 3;
     */
    teamId: string;
    /**
     * @generated from field: string repository = 4;
     */
    repository: string;
    /**
     * @generated from field: string agent = 5;
     */
    agent: string;
    /**
     * @generated from field: int32 limit = 6;
     */
    limit: number;
};
/**
 * Describes the message memory.v1.RecallKnowledgeRequest.
 * Use `create(RecallKnowledgeRequestSchema)` to create a new message.
 */
export declare const RecallKnowledgeRequestSchema: GenMessage<RecallKnowledgeRequest>;
/**
 * @generated from message memory.v1.GetOperatingRulesRequest
 */
export type GetOperatingRulesRequest = Message<"memory.v1.GetOperatingRulesRequest"> & {
    /**
     * @generated from field: string project_id = 1;
     */
    projectId: string;
    /**
     * @generated from field: string team_id = 2;
     */
    teamId: string;
    /**
     * @generated from field: string repository = 3;
     */
    repository: string;
    /**
     * @generated from field: string agent = 4;
     */
    agent: string;
    /**
     * @generated from field: int32 limit = 5;
     */
    limit: number;
    /**
     * @generated from field: int32 offset = 6;
     */
    offset: number;
};
/**
 * Describes the message memory.v1.GetOperatingRulesRequest.
 * Use `create(GetOperatingRulesRequestSchema)` to create a new message.
 */
export declare const GetOperatingRulesRequestSchema: GenMessage<GetOperatingRulesRequest>;
/**
 * @generated from message memory.v1.ConsolidateRequest
 */
export type ConsolidateRequest = Message<"memory.v1.ConsolidateRequest"> & {};
/**
 * Describes the message memory.v1.ConsolidateRequest.
 * Use `create(ConsolidateRequestSchema)` to create a new message.
 */
export declare const ConsolidateRequestSchema: GenMessage<ConsolidateRequest>;
/**
 * @generated from message memory.v1.ConsolidateResponse
 */
export type ConsolidateResponse = Message<"memory.v1.ConsolidateResponse"> & {
    /**
     * @generated from field: int32 consolidated = 1;
     */
    consolidated: number;
};
/**
 * Describes the message memory.v1.ConsolidateResponse.
 * Use `create(ConsolidateResponseSchema)` to create a new message.
 */
export declare const ConsolidateResponseSchema: GenMessage<ConsolidateResponse>;
/**
 * @generated from enum memory.v1.MemoryType
 */
export declare enum MemoryType {
    /**
     * @generated from enum value: MEMORY_TYPE_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: MEMORY_TYPE_USER = 1;
     */
    USER = 1,
    /**
     * @generated from enum value: MEMORY_TYPE_FEEDBACK = 2;
     */
    FEEDBACK = 2,
    /**
     * @generated from enum value: MEMORY_TYPE_PROJECT = 3;
     */
    PROJECT = 3,
    /**
     * @generated from enum value: MEMORY_TYPE_REFERENCE = 4;
     */
    REFERENCE = 4,
    /**
     * @generated from enum value: MEMORY_TYPE_ENTITY = 5;
     */
    ENTITY = 5,
    /**
     * @generated from enum value: MEMORY_TYPE_KNOWLEDGE = 6;
     */
    KNOWLEDGE = 6,
    /**
     * @generated from enum value: MEMORY_TYPE_OPERATING_RULE = 7;
     */
    OPERATING_RULE = 7
}
/**
 * Describes the enum memory.v1.MemoryType.
 */
export declare const MemoryTypeSchema: GenEnum<MemoryType>;
/**
 * @generated from enum memory.v1.MemoryHistoryEvent
 */
export declare enum MemoryHistoryEvent {
    /**
     * @generated from enum value: MEMORY_HISTORY_EVENT_UNSPECIFIED = 0;
     */
    UNSPECIFIED = 0,
    /**
     * @generated from enum value: MEMORY_HISTORY_EVENT_CREATE = 1;
     */
    CREATE = 1,
    /**
     * @generated from enum value: MEMORY_HISTORY_EVENT_UPDATE = 2;
     */
    UPDATE = 2,
    /**
     * @generated from enum value: MEMORY_HISTORY_EVENT_DELETE = 3;
     */
    DELETE = 3
}
/**
 * Describes the enum memory.v1.MemoryHistoryEvent.
 */
export declare const MemoryHistoryEventSchema: GenEnum<MemoryHistoryEvent>;
