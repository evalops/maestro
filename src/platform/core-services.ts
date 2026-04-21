export interface PlatformConnectMethodDescriptor {
	readonly service: string;
	readonly method: string;
}

export const PLATFORM_CONNECT_SERVICES = {
	approvals: "approvals.v1.ApprovalService",
	connectors: "connectors.v1.ConnectorService",
	governance: "governance.v1.GovernanceService",
	llmGateway: "llmgateway.v1.GatewayService",
	meter: "meter.v1.MeterService",
	prompts: "prompts.v1.PromptService",
} as const;

export const PLATFORM_CONNECT_METHODS = {
	approvals: {
		requestApproval: {
			service: PLATFORM_CONNECT_SERVICES.approvals,
			method: "RequestApproval",
		},
		resolveApproval: {
			service: PLATFORM_CONNECT_SERVICES.approvals,
			method: "ResolveApproval",
		},
	},
	connectors: {
		getCapabilities: {
			service: PLATFORM_CONNECT_SERVICES.connectors,
			method: "GetCapabilities",
		},
		getConnection: {
			service: PLATFORM_CONNECT_SERVICES.connectors,
			method: "GetConnection",
		},
		getDegradedReadPolicy: {
			service: PLATFORM_CONNECT_SERVICES.connectors,
			method: "GetDegradedReadPolicy",
		},
		getHealth: {
			service: PLATFORM_CONNECT_SERVICES.connectors,
			method: "GetHealth",
		},
		listConnections: {
			service: PLATFORM_CONNECT_SERVICES.connectors,
			method: "ListConnections",
		},
		refreshConnection: {
			service: PLATFORM_CONNECT_SERVICES.connectors,
			method: "RefreshConnection",
		},
		registerConnection: {
			service: PLATFORM_CONNECT_SERVICES.connectors,
			method: "RegisterConnection",
		},
		resolveSourceOfTruth: {
			service: PLATFORM_CONNECT_SERVICES.connectors,
			method: "ResolveSourceOfTruth",
		},
		revokeConnection: {
			service: PLATFORM_CONNECT_SERVICES.connectors,
			method: "RevokeConnection",
		},
	},
	governance: {
		evaluateAction: {
			service: PLATFORM_CONNECT_SERVICES.governance,
			method: "EvaluateAction",
		},
	},
	llmGateway: {
		createChatCompletion: {
			service: PLATFORM_CONNECT_SERVICES.llmGateway,
			method: "CreateChatCompletion",
		},
		createEmbedding: {
			service: PLATFORM_CONNECT_SERVICES.llmGateway,
			method: "CreateEmbedding",
		},
		createMessage: {
			service: PLATFORM_CONNECT_SERVICES.llmGateway,
			method: "CreateMessage",
		},
		createResponse: {
			service: PLATFORM_CONNECT_SERVICES.llmGateway,
			method: "CreateResponse",
		},
		getInfo: {
			service: PLATFORM_CONNECT_SERVICES.llmGateway,
			method: "GetInfo",
		},
	},
	meter: {
		getEventDashboard: {
			service: PLATFORM_CONNECT_SERVICES.meter,
			method: "GetEventDashboard",
		},
		ingestWideEvent: {
			service: PLATFORM_CONNECT_SERVICES.meter,
			method: "IngestWideEvent",
		},
		queryWideEvents: {
			service: PLATFORM_CONNECT_SERVICES.meter,
			method: "QueryWideEvents",
		},
	},
	prompts: {
		resolve: {
			service: PLATFORM_CONNECT_SERVICES.prompts,
			method: "Resolve",
		},
	},
} as const;

export const PLATFORM_HTTP_ROUTES = {
	memory: {
		recall: "/v1/memories/recall",
	},
} as const;

export function platformConnectServicePath(service: string): string {
	return `/${service}`;
}

export function platformConnectMethodPath(
	descriptor: PlatformConnectMethodDescriptor,
): string {
	return `${platformConnectServicePath(descriptor.service)}/${descriptor.method}`;
}
