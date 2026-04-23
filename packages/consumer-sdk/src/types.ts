import type {
	ComposerMessage,
	ComposerUsage,
	PromptMessage,
	ResponseUsage,
} from "@evalops/contracts";

export type EvalOpsServiceName =
	| "llm-gateway"
	| "meter"
	| "approvals"
	| "memory"
	| "traces"
	| "agent-registry"
	| "skills"
	| "identity"
	| "governance"
	| "connectors";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
	[key: string]: JsonValue | undefined;
}

export type FeatureFlagValue = boolean | string | number;
export type FeatureFlags = Record<string, FeatureFlagValue>;

export interface EvalOpsClientConfig {
	baseUrl?: string;
	token?: string;
	featureFlags?: FeatureFlags;
	cacheTtlMs?: number;
	cacheMaxEntries?: number;
	offlineFallback?: boolean;
	fetch?: typeof fetch;
}

export interface EvalOpsClientMetrics {
	requests: number;
	cacheHits: number;
	fallbacks: number;
	fallbacksByService: Record<EvalOpsServiceName, number>;
	lastFallback?: {
		service: EvalOpsServiceName;
		operation: string;
		reason: string;
		at: string;
	};
}

export interface EvalOpsRequestOptions {
	signal?: AbortSignal;
}

export interface OfflineFallbackMarker {
	offline: true;
	reason: string;
}

export interface LlmGatewayRouteRequest extends JsonObject {
	taskType: string;
	workspaceId?: string;
	agentId?: string;
	modelHints?: string[];
}

export interface LlmGatewayRouteResponse extends JsonObject {
	selectedModel: string;
	fallbackChain: string[];
	offline?: boolean;
	reason?: string;
}

export interface LlmGatewayCompletionRequest {
	model?: string;
	messages: ComposerMessage[];
	temperature?: number;
	maxTokens?: number;
	prompt?: PromptMessage;
}

export interface LlmGatewayCompletionResponse {
	id: string;
	model: string;
	content: string;
	usage?: ComposerUsage | ResponseUsage;
	offline?: boolean;
	reason?: string;
}

export interface MeterWideEvent extends JsonObject {
	timestamp?: string;
	teamId?: string;
	agentId?: string;
	surface?: string;
	eventType: string;
	model?: string;
	provider?: string;
	requestId?: string;
	metadata?: Record<string, string>;
	data?: JsonValue;
	metrics?: JsonObject;
}

export interface MeterQueryRequest extends JsonObject {
	workspaceId?: string;
	agentId?: string;
	startTime?: string;
	endTime?: string;
	limit?: number;
}

export interface MeterQueryResponse extends JsonObject {
	events: MeterWideEvent[];
	nextPageToken?: string;
	offline?: boolean;
	reason?: string;
}

export interface ApprovalRequest extends JsonObject {
	workspaceId: string;
	agentId?: string;
	actionType: string;
	actionPayload: string;
	riskLevel?: string;
	contextJson?: string;
}

export interface ApprovalResponse extends JsonObject {
	requestId: string;
	decision?: "approved" | "denied" | "pending";
	autoApprovedReason?: string;
	offline?: boolean;
	reason?: string;
}

export interface ApprovalDecisionRequest extends JsonObject {
	approvalRequestId: string;
	decision: "approved" | "denied";
	decidedBy?: string;
	reason?: string;
}

export interface MemoryRecord extends JsonObject {
	id?: string;
	type?: "project" | "user" | "team";
	content: string;
	teamId?: string;
	repository?: string;
	agent?: string;
	tags?: string[];
	createdAt?: string;
	updatedAt?: string;
}

export interface MemoryListRequest extends JsonObject {
	type?: "project" | "user" | "team";
	teamId?: string;
	repository?: string;
	agent?: string;
	tags?: string[];
}

export interface MemoryListResponse extends JsonObject {
	memories: MemoryRecord[];
	offline?: boolean;
	reason?: string;
}

export interface TraceSpan extends JsonObject {
	name: string;
	startTimeUnixNano?: string;
	endTimeUnixNano?: string;
	attributes?: Record<string, string | number | boolean>;
}

export interface ExecutionTrace extends JsonObject {
	traceId: string;
	workspaceId: string;
	agentId: string;
	spans: TraceSpan[];
	durationMs: number;
	status: "success" | "error" | "cancelled";
	createdAt?: string;
}

export interface TraceListResponse extends JsonObject {
	traces: ExecutionTrace[];
	nextPageToken?: string;
	offline?: boolean;
	reason?: string;
}

export interface AgentRegistryRecord extends JsonObject {
	id: string;
	workspaceId?: string;
	name?: string;
	status?: "running" | "idle" | "offline" | "error";
	version?: string;
	labels?: Record<string, string>;
}

export interface AgentRegistryListResponse extends JsonObject {
	agents: AgentRegistryRecord[];
	offline?: boolean;
	reason?: string;
}

export interface SkillRecord extends JsonObject {
	id: string;
	name: string;
	description?: string;
	content?: string;
	tags?: string[];
	scope?: "global" | "workspace" | "personal";
}

export interface SkillListResponse extends JsonObject {
	skills: SkillRecord[];
	total?: number;
	offline?: boolean;
	reason?: string;
}

export interface IdentityProfile extends JsonObject {
	id: string;
	email?: string;
	name?: string;
	organizationId?: string;
	workspaceIds?: string[];
	offline?: boolean;
	reason?: string;
}

export interface GovernanceEvaluationRequest extends JsonObject {
	workspaceId: string;
	agentId?: string;
	actionType: string;
	actionPayload: string;
	context?: JsonObject;
}

export interface GovernanceEvaluationResponse extends JsonObject {
	decision: "allow" | "deny" | "require_approval";
	reasons: string[];
	matchedRules: string[];
	offline?: boolean;
	reason?: string;
}

export interface ConnectorRecord extends JsonObject {
	id: string;
	name: string;
	type: string;
	status?: "connected" | "disconnected" | "error";
	metadata?: JsonObject;
}

export interface ConnectorListResponse extends JsonObject {
	connectors: ConnectorRecord[];
	offline?: boolean;
	reason?: string;
}

export interface ConnectorOAuthStartRequest extends JsonObject {
	connectorName: string;
	redirectUri: string;
	scopes?: string[];
}

export interface ConnectorOAuthStartResponse extends JsonObject {
	authUrl: string;
	state: string;
	offline?: boolean;
	reason?: string;
}

export interface ConnectorOAuthExchangeRequest extends JsonObject {
	connectorName: string;
	code: string;
	state: string;
	redirectUri: string;
}

export interface ConnectorOAuthTokenResponse extends JsonObject {
	accessToken: string;
	refreshToken?: string;
	expiresIn?: number;
	tokenType?: string;
	offline?: boolean;
	reason?: string;
}
