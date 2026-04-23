import type { EvalOpsTransport } from "./http.js";
import type {
	AgentRegistryListResponse,
	AgentRegistryRecord,
	ApprovalDecisionRequest,
	ApprovalRequest,
	ApprovalResponse,
	ConnectorListResponse,
	ConnectorOAuthExchangeRequest,
	ConnectorOAuthStartRequest,
	ConnectorOAuthStartResponse,
	ConnectorOAuthTokenResponse,
	ExecutionTrace,
	GovernanceEvaluationRequest,
	GovernanceEvaluationResponse,
	IdentityProfile,
	JsonObject,
	JsonValue,
	LlmGatewayCompletionRequest,
	LlmGatewayCompletionResponse,
	LlmGatewayRouteRequest,
	LlmGatewayRouteResponse,
	MemoryListRequest,
	MemoryListResponse,
	MemoryRecord,
	MeterQueryRequest,
	MeterQueryResponse,
	MeterWideEvent,
	SkillListResponse,
	SkillRecord,
	TraceListResponse,
} from "./types.js";

function offline(reason: string): { offline: true; reason: string } {
	return { offline: true, reason };
}

function noContent(reason: string): JsonObject {
	return offline(reason);
}

export class LlmGatewayClient {
	constructor(private readonly transport: EvalOpsTransport) {}

	route(
		request: LlmGatewayRouteRequest,
		options?: { signal?: AbortSignal },
	): Promise<LlmGatewayRouteResponse> {
		return this.transport.request({
			service: "llm-gateway",
			operation: "route",
			path: "/llm-gateway.v1.LlmGatewayService/Route",
			body: request,
			signal: options?.signal,
			fallback: (reason) => ({
				selectedModel: request.modelHints?.[0] ?? "offline",
				fallbackChain: request.modelHints ?? [],
				...offline(reason),
			}),
		});
	}

	complete(
		request: LlmGatewayCompletionRequest,
		options?: { signal?: AbortSignal },
	): Promise<LlmGatewayCompletionResponse> {
		return this.transport.request({
			service: "llm-gateway",
			operation: "complete",
			path: "/llm-gateway.v1.LlmGatewayService/Complete",
			body: request,
			signal: options?.signal,
			fallback: (reason) => ({
				id: "offline",
				model: request.model ?? "offline",
				content: "",
				...offline(reason),
			}),
		});
	}
}

export class MeterClient {
	constructor(private readonly transport: EvalOpsTransport) {}

	ingestWideEvent(
		event: MeterWideEvent,
		options?: { signal?: AbortSignal },
	): Promise<JsonObject> {
		return this.transport.request({
			service: "meter",
			operation: "ingestWideEvent",
			path: "/meter.v1.MeterService/IngestWideEvent",
			body: event,
			signal: options?.signal,
			fallback: noContent,
		});
	}

	queryWideEvents(
		request: MeterQueryRequest,
		options?: { signal?: AbortSignal },
	): Promise<MeterQueryResponse> {
		return this.transport.request({
			service: "meter",
			operation: "queryWideEvents",
			path: "/meter.v1.MeterService/QueryWideEvents",
			body: request,
			signal: options?.signal,
			cache: true,
			fallback: (reason) => ({ events: [], ...offline(reason) }),
		});
	}
}

export class ApprovalsClient {
	constructor(private readonly transport: EvalOpsTransport) {}

	requestApproval(
		request: ApprovalRequest,
		options?: { signal?: AbortSignal },
	): Promise<ApprovalResponse> {
		return this.transport.request({
			service: "approvals",
			operation: "requestApproval",
			path: "/approvals.v1.ApprovalService/RequestApproval",
			body: request,
			signal: options?.signal,
			fallback: (reason) => ({
				requestId: "offline",
				decision: "pending",
				...offline(reason),
			}),
		});
	}

	resolveApproval(
		request: ApprovalDecisionRequest,
		options?: { signal?: AbortSignal },
	): Promise<JsonObject> {
		return this.transport.request({
			service: "approvals",
			operation: "resolveApproval",
			path: "/approvals.v1.ApprovalService/ResolveApproval",
			body: request,
			signal: options?.signal,
			fallback: noContent,
		});
	}
}

export class MemoryClient {
	constructor(private readonly transport: EvalOpsTransport) {}

	store(
		memory: MemoryRecord,
		options?: { signal?: AbortSignal },
	): Promise<{ memory?: MemoryRecord; offline?: boolean; reason?: string }> {
		return this.transport.request({
			service: "memory",
			operation: "store",
			path: "/memory.v1.MemoryService/Store",
			body: memory,
			signal: options?.signal,
			fallback: (reason) => ({ ...offline(reason) }),
		});
	}

	list(
		request: MemoryListRequest = {},
		options?: { signal?: AbortSignal },
	): Promise<MemoryListResponse> {
		return this.transport.request({
			service: "memory",
			operation: "list",
			path: "/memory.v1.MemoryService/List",
			body: request,
			signal: options?.signal,
			cache: true,
			fallback: (reason) => ({ memories: [], ...offline(reason) }),
		});
	}
}

export class TracesClient {
	constructor(private readonly transport: EvalOpsTransport) {}

	record(
		trace: ExecutionTrace,
		options?: { signal?: AbortSignal },
	): Promise<{ trace?: ExecutionTrace; offline?: boolean; reason?: string }> {
		return this.transport.request({
			service: "traces",
			operation: "record",
			path: "/api/traces",
			body: trace,
			signal: options?.signal,
			fallback: (reason) => ({ ...offline(reason) }),
		});
	}

	get(
		traceId: string,
		options?: { signal?: AbortSignal },
	): Promise<{ trace?: ExecutionTrace; offline?: boolean; reason?: string }> {
		return this.transport.request({
			service: "traces",
			operation: "get",
			path: `/api/traces/${encodeURIComponent(traceId)}`,
			method: "GET",
			signal: options?.signal,
			cache: true,
			fallback: (reason) => ({ ...offline(reason) }),
		});
	}

	list(
		request: { workspaceId: string; limit?: number; pageToken?: string },
		options?: { signal?: AbortSignal },
	): Promise<TraceListResponse> {
		const params = new URLSearchParams({
			workspace_id: request.workspaceId,
			...(request.limit ? { limit: String(request.limit) } : {}),
			...(request.pageToken ? { page_token: request.pageToken } : {}),
		});
		return this.transport.request({
			service: "traces",
			operation: "list",
			path: `/api/traces?${params.toString()}`,
			method: "GET",
			signal: options?.signal,
			cache: true,
			fallback: (reason) => ({ traces: [], ...offline(reason) }),
		});
	}

	exportOpenTelemetry(
		traceId: string,
		options?: { signal?: AbortSignal },
	): Promise<JsonObject> {
		return this.transport.request({
			service: "traces",
			operation: "exportOpenTelemetry",
			path: `/api/traces/${encodeURIComponent(traceId)}/otel`,
			method: "GET",
			signal: options?.signal,
			cache: true,
			fallback: noContent,
		});
	}
}

export class AgentRegistryClient {
	constructor(private readonly transport: EvalOpsTransport) {}

	list(
		request: { workspaceId?: string } = {},
		options?: { signal?: AbortSignal },
	): Promise<AgentRegistryListResponse> {
		return this.transport.request({
			service: "agent-registry",
			operation: "list",
			path: "/agent-registry.v1.AgentRegistryService/ListAgents",
			body: request,
			signal: options?.signal,
			cache: true,
			fallback: (reason) => ({ agents: [], ...offline(reason) }),
		});
	}

	register(
		agent: AgentRegistryRecord,
		options?: { signal?: AbortSignal },
	): Promise<{
		agent?: AgentRegistryRecord;
		offline?: boolean;
		reason?: string;
	}> {
		return this.transport.request({
			service: "agent-registry",
			operation: "register",
			path: "/agent-registry.v1.AgentRegistryService/RegisterAgent",
			body: agent,
			signal: options?.signal,
			fallback: (reason) => ({ ...offline(reason) }),
		});
	}
}

export class SkillsClient {
	constructor(private readonly transport: EvalOpsTransport) {}

	list(
		request: { workspaceId?: string; limit?: number } = {},
		options?: { signal?: AbortSignal },
	): Promise<SkillListResponse> {
		return this.transport.request({
			service: "skills",
			operation: "list",
			path: "/skills.v1.SkillService/List",
			body: request,
			signal: options?.signal,
			cache: true,
			fallback: (reason) => ({ skills: [], total: 0, ...offline(reason) }),
		});
	}

	get(
		skillId: string,
		options?: { signal?: AbortSignal },
	): Promise<{ skill?: SkillRecord; offline?: boolean; reason?: string }> {
		return this.transport.request({
			service: "skills",
			operation: "get",
			path: "/skills.v1.SkillService/Get",
			body: { skillId },
			signal: options?.signal,
			cache: true,
			fallback: (reason) => ({ ...offline(reason) }),
		});
	}
}

export class IdentityClient {
	constructor(private readonly transport: EvalOpsTransport) {}

	getProfile(options?: { signal?: AbortSignal }): Promise<IdentityProfile> {
		return this.transport.request({
			service: "identity",
			operation: "getProfile",
			path: "/identity.v1.IdentityService/GetProfile",
			body: {},
			signal: options?.signal,
			cache: true,
			fallback: (reason) => ({ id: "offline", ...offline(reason) }),
		});
	}
}

export class GovernanceClient {
	constructor(private readonly transport: EvalOpsTransport) {}

	evaluateAction(
		request: GovernanceEvaluationRequest,
		options?: { signal?: AbortSignal },
	): Promise<GovernanceEvaluationResponse> {
		return this.transport.request({
			service: "governance",
			operation: "evaluateAction",
			path: "/governance.v1.GovernanceService/EvaluateAction",
			body: request,
			signal: options?.signal,
			fallback: (reason) => ({
				decision: "require_approval",
				reasons: ["Governance service unavailable; using offline fallback"],
				matchedRules: ["offline-fallback"],
				...offline(reason),
			}),
		});
	}
}

export class ConnectorsClient {
	constructor(private readonly transport: EvalOpsTransport) {}

	list(options?: { signal?: AbortSignal }): Promise<ConnectorListResponse> {
		return this.transport.request({
			service: "connectors",
			operation: "list",
			path: "/connectors.v1.ConnectorService/ListConnections",
			body: {},
			signal: options?.signal,
			cache: true,
			fallback: (reason) => ({ connectors: [], ...offline(reason) }),
		});
	}

	startOAuth(
		request: ConnectorOAuthStartRequest,
		options?: { signal?: AbortSignal },
	): Promise<ConnectorOAuthStartResponse> {
		return this.transport.request({
			service: "connectors",
			operation: "startOAuth",
			path: "/connectors.v1.ConnectorOAuthService/Start",
			body: request,
			signal: options?.signal,
			fallback: (reason) => ({ authUrl: "", state: "", ...offline(reason) }),
		});
	}

	exchangeOAuthCode(
		request: ConnectorOAuthExchangeRequest,
		options?: { signal?: AbortSignal },
	): Promise<ConnectorOAuthTokenResponse> {
		return this.transport.request({
			service: "connectors",
			operation: "exchangeOAuthCode",
			path: "/connectors.v1.ConnectorOAuthService/ExchangeCode",
			body: request,
			signal: options?.signal,
			fallback: (reason) => ({ accessToken: "", ...offline(reason) }),
		});
	}

	request<TResponse>(
		path: string,
		body: JsonValue = {},
		options?: { operation?: string; signal?: AbortSignal },
	): Promise<TResponse> {
		return this.transport.request({
			service: "connectors",
			operation: options?.operation ?? "request",
			path,
			body,
			signal: options?.signal,
		});
	}
}
