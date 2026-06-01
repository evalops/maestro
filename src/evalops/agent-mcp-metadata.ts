import {
	type OAuthCredentials,
	loadOAuthCredentials,
} from "../oauth/storage.js";

export interface EvalOpsAgentMcpMetadata {
	agentId?: string;
	apiKey?: string;
	createdAt: string;
	endpoint: string;
	expiresAt?: string;
	integrationProfile?: string;
	keyId?: string;
	keyName?: string;
	keyPrefix?: string;
	manifestUrl?: string;
	memoryMode?: string;
	registeredAt: string;
	registryVisible?: boolean;
	runId?: string;
	runtimeOwner?: string;
	scopes?: string[];
	sessionExpiresAt?: string;
	shimType?: string;
	surface: string;
	traceMode?: string;
	type: "agent-mcp";
	workspaceId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const values = value
		.map((entry) => nonEmptyString(entry))
		.filter((entry): entry is string => Boolean(entry));
	return values.length > 0 ? values : undefined;
}

export function getStoredAgentMcpMetadata(
	credentials: OAuthCredentials | null,
): EvalOpsAgentMcpMetadata | undefined {
	const metadata = credentials?.metadata;
	const agentMcp = isRecord(metadata?.agentMcp) ? metadata.agentMcp : undefined;
	const apiKey = nonEmptyString(agentMcp?.apiKey);
	const endpoint = nonEmptyString(agentMcp?.endpoint);
	const registeredAt = nonEmptyString(agentMcp?.registeredAt);
	const createdAt = nonEmptyString(agentMcp?.createdAt);
	const surface = nonEmptyString(agentMcp?.surface);
	if (!apiKey || !endpoint || !registeredAt || !createdAt || !surface) {
		return undefined;
	}
	return {
		type: "agent-mcp",
		apiKey,
		createdAt,
		endpoint,
		registeredAt,
		surface,
		agentId: nonEmptyString(agentMcp?.agentId),
		expiresAt: nonEmptyString(agentMcp?.expiresAt),
		integrationProfile: nonEmptyString(agentMcp?.integrationProfile),
		keyId: nonEmptyString(agentMcp?.keyId),
		keyName: nonEmptyString(agentMcp?.keyName),
		keyPrefix: nonEmptyString(agentMcp?.keyPrefix),
		manifestUrl: nonEmptyString(agentMcp?.manifestUrl),
		memoryMode: nonEmptyString(agentMcp?.memoryMode),
		registryVisible:
			typeof agentMcp?.registryVisible === "boolean"
				? agentMcp.registryVisible
				: undefined,
		runId: nonEmptyString(agentMcp?.runId),
		runtimeOwner: nonEmptyString(agentMcp?.runtimeOwner),
		scopes: stringArray(agentMcp?.scopes),
		sessionExpiresAt: nonEmptyString(agentMcp?.sessionExpiresAt),
		shimType: nonEmptyString(agentMcp?.shimType),
		traceMode: nonEmptyString(agentMcp?.traceMode),
		workspaceId: nonEmptyString(agentMcp?.workspaceId),
	};
}

export function getStoredEvalOpsAgentMcpMetadata():
	| EvalOpsAgentMcpMetadata
	| undefined {
	return getStoredAgentMcpMetadata(loadOAuthCredentials("evalops"));
}
