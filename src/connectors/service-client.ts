import { loadOAuthCredentials } from "../oauth/storage.js";
import { CONNECT_PROTOCOL_VERSION } from "../platform/client.js";
import {
	PLATFORM_CONNECT_METHODS,
	PLATFORM_CONNECT_SERVICES,
	platformConnectMethodPath,
	platformConnectServicePath,
} from "../platform/core-services.js";
import { fetchDownstream } from "../utils/downstream-http.js";
import * as downstream from "../utils/downstream.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("connectors:service");

const DEFAULT_LIST_LIMIT = 500;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 2_000;
const REGISTER_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.connectors.registerConnection,
);
const GET_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.connectors.getConnection,
);
const LIST_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.connectors.listConnections,
);
const REFRESH_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.connectors.refreshConnection,
);
const REVOKE_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.connectors.revokeConnection,
);
const GET_HEALTH_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.connectors.getHealth,
);
const RESOLVE_SOURCE_OF_TRUTH_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.connectors.resolveSourceOfTruth,
);
const GET_DEGRADED_READ_POLICY_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.connectors.getDegradedReadPolicy,
);
const SET_SOURCE_OF_TRUTH_POLICY_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.connectors.setSourceOfTruthPolicy,
);
const GET_CAPABILITIES_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.connectors.getCapabilities,
);

export const CONNECTORS_CALL_FAILURE_MODES = {
	getCapabilities: downstream.FailOpen,
	getConnection: downstream.FailOpen,
	getDegradedReadPolicy: downstream.FailOpen,
	getHealth: downstream.FailOpen,
	listConnections: downstream.FailOpen,
	refreshConnection: downstream.FailOpen,
	registerConnection: downstream.FailOpen,
	resolveSourceOfTruth: downstream.FailOpen,
	revokeConnection: downstream.FailOpen,
	setSourceOfTruthPolicy: downstream.FailOpen,
} as const;

type ConnectorsCall = keyof typeof CONNECTORS_CALL_FAILURE_MODES;

export interface ConnectorsServiceConfig {
	baseUrl?: string;
	token?: string;
	workspaceId?: string;
	timeoutMs?: number;
	maxAttempts?: number;
	circuitFailureThreshold?: number;
	circuitResetTimeoutMs?: number;
	circuitSuccessThreshold?: number;
}

export interface ResolvedConnectorsServiceConfig {
	baseUrl: string;
	token?: string;
	workspaceId?: string;
	timeoutMs: number;
	maxAttempts: number;
	circuitFailureThreshold: number;
	circuitResetTimeoutMs: number;
	circuitSuccessThreshold: number;
}

interface RemoteConnectionPayload {
	id?: string;
	workspaceId?: string;
	providerId?: string;
	displayName?: string;
	authType?: string | number;
	scopes?: string[];
	credentialRefs?: Record<string, string>;
	healthStatus?: string | number;
	lastHealthyAt?: string;
	createdAt?: string;
	updatedAt?: string;
}

interface ConnectionResponse {
	connection?: RemoteConnectionPayload;
}

interface ListConnectionsResponse {
	connections?: RemoteConnectionPayload[];
	total?: number;
}

interface HealthPayload {
	status?: string | number;
	latencyMs?: number;
	lastCheckAt?: string;
	errorMessage?: string;
}

interface GetHealthResponse {
	health?: HealthPayload;
}

interface SourceOfTruthPolicyPayload {
	workspaceId?: string;
	area?: string | number;
	primaryConnectionId?: string;
	fallbackConnectionId?: string;
}

interface ResolveSourceOfTruthResponse {
	policy?: SourceOfTruthPolicyPayload;
	primaryConnection?: RemoteConnectionPayload;
}

interface RemoteDegradedReadPolicyPayload {
	mode?: string;
	allowedIntegrations?: string[];
	maxAgeMinutes?: number | string;
	queuePrimaryRefresh?: boolean;
}

interface GetDegradedReadPolicyResponse {
	policy?: RemoteDegradedReadPolicyPayload;
}

interface GetCapabilitiesResponse {
	capabilities?: string[];
}

export interface RemoteConnectorConnection {
	id: string;
	workspaceId: string;
	providerId: string;
	displayName?: string;
	authType?: string;
	scopes: string[];
	credentialRefs?: Record<string, string>;
	healthStatus?: string;
	lastHealthyAt?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface RemoteConnectionHealth {
	status?: string;
	latencyMs?: number;
	lastCheckAt?: string;
	errorMessage?: string;
}

export interface RegisterRemoteConnectionInput {
	workspaceId?: string;
	providerId: string;
	displayName?: string;
	authType: "AUTH_TYPE_OAUTH2" | "AUTH_TYPE_API_KEY" | "AUTH_TYPE_BASIC";
	scopes?: string[];
	credentials?: Record<string, string>;
}

export interface RemoteSourceOfTruthResolution {
	workspaceId: string;
	area: string;
	primaryConnectionId: string;
	fallbackConnectionId?: string;
	providerId: string;
	displayName?: string;
}

export interface RemoteSourceOfTruthPolicy {
	workspaceId: string;
	area: string;
	primaryConnectionId: string;
	fallbackConnectionId?: string;
}

export interface SetRemoteSourceOfTruthPolicyInput {
	workspaceId?: string;
	area: string;
	primaryConnectionId: string;
	fallbackConnectionId?: string;
}

export interface RemoteDegradedReadPolicy {
	mode?: string;
	integrations: string[];
	maxAgeMinutes?: number;
	queuePrimaryRefresh?: boolean;
}

const SOURCE_OF_TRUTH_AREA_BY_LOCAL: Partial<Record<string, string>> = {
	analytics: "SOURCE_OF_TRUTH_AREA_ANALYTICS",
	billing: "SOURCE_OF_TRUTH_AREA_BILLING",
	crm: "SOURCE_OF_TRUTH_AREA_CRM",
	hris: "SOURCE_OF_TRUTH_AREA_HRIS",
	support: "SOURCE_OF_TRUTH_AREA_SUPPORT",
};

const downstreamClients = new Map<string, downstream.DownstreamClient>();

function trimString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function getEnvValue(names: string[]): string | undefined {
	for (const name of names) {
		const value = trimString(process.env[name]);
		if (value) {
			return value;
		}
	}
	return undefined;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(baseUrl: string): string {
	let normalized = baseUrl.trim();
	for (const suffix of [
		REGISTER_PATH,
		GET_PATH,
		LIST_PATH,
		REFRESH_PATH,
		REVOKE_PATH,
		GET_HEALTH_PATH,
		RESOLVE_SOURCE_OF_TRUTH_PATH,
		GET_DEGRADED_READ_POLICY_PATH,
		SET_SOURCE_OF_TRUTH_POLICY_PATH,
		GET_CAPABILITIES_PATH,
		platformConnectServicePath(PLATFORM_CONNECT_SERVICES.connectors),
	]) {
		if (normalized.endsWith(suffix)) {
			normalized = normalized.slice(0, -suffix.length);
		}
	}
	return normalized.replace(/\/+$/, "");
}

function normalizeStringList(values: string[] | undefined): string[] {
	return Array.from(
		new Set(
			(values ?? [])
				.map((value) => value.trim())
				.filter((value) => value.length > 0),
		),
	);
}

function normalizeStringMap(
	values: Record<string, string> | undefined,
): Record<string, string> | undefined {
	const entries = Object.entries(values ?? {})
		.map(([key, value]) => [key.trim(), value.trim()] as const)
		.filter(([key, value]) => key.length > 0 && value.length > 0);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeEnum(value: string | number | undefined): string | undefined {
	const normalized = String(value ?? "")
		.trim()
		.toUpperCase();
	return normalized ? normalized : undefined;
}

function normalizePositiveInteger(
	value: number | string | undefined,
): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.round(value);
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}

function resolveWorkspaceId(
	config: ConnectorsServiceConfig | undefined,
): string | undefined {
	const configuredWorkspaceId = trimString(config?.workspaceId);
	const envWorkspaceId = getEnvValue([
		"CONNECTORS_SERVICE_WORKSPACE_ID",
		"MAESTRO_CONNECTORS_WORKSPACE_ID",
		"MAESTRO_EVALOPS_WORKSPACE_ID",
		"MAESTRO_WORKSPACE_ID",
		"MAESTRO_EVALOPS_ORG_ID",
		"EVALOPS_ORGANIZATION_ID",
		"MAESTRO_ENTERPRISE_ORG_ID",
	]);
	if (configuredWorkspaceId ?? envWorkspaceId) {
		return configuredWorkspaceId ?? envWorkspaceId;
	}
	const stored = loadOAuthCredentials("evalops")?.metadata?.organizationId;
	return typeof stored === "string" && stored.trim().length > 0
		? stored.trim()
		: undefined;
}

export function resolveConnectorsServiceConfig(
	config?: ConnectorsServiceConfig | false,
): ResolvedConnectorsServiceConfig | null {
	if (config === false) {
		return null;
	}

	const baseUrl =
		trimString(config?.baseUrl) ??
		getEnvValue([
			"CONNECTORS_SERVICE_URL",
			"MAESTRO_CONNECTORS_SERVICE_URL",
			"MAESTRO_PLATFORM_BASE_URL",
			"MAESTRO_EVALOPS_BASE_URL",
			"EVALOPS_BASE_URL",
		]);
	if (!baseUrl) {
		return null;
	}

	const storedToken = trimString(loadOAuthCredentials("evalops")?.access);
	return {
		baseUrl: normalizeBaseUrl(baseUrl),
		circuitFailureThreshold:
			config?.circuitFailureThreshold ??
			parsePositiveInt(
				getEnvValue([
					"CONNECTORS_SERVICE_CIRCUIT_FAILURE_THRESHOLD",
					"MAESTRO_CONNECTORS_SERVICE_CIRCUIT_FAILURE_THRESHOLD",
				]),
				5,
			),
		circuitResetTimeoutMs:
			config?.circuitResetTimeoutMs ??
			parsePositiveInt(
				getEnvValue([
					"CONNECTORS_SERVICE_CIRCUIT_RESET_TIMEOUT_MS",
					"MAESTRO_CONNECTORS_SERVICE_CIRCUIT_RESET_TIMEOUT_MS",
				]),
				30_000,
			),
		circuitSuccessThreshold:
			config?.circuitSuccessThreshold ??
			parsePositiveInt(
				getEnvValue([
					"CONNECTORS_SERVICE_CIRCUIT_SUCCESS_THRESHOLD",
					"MAESTRO_CONNECTORS_SERVICE_CIRCUIT_SUCCESS_THRESHOLD",
				]),
				2,
			),
		maxAttempts:
			config?.maxAttempts ??
			parsePositiveInt(
				getEnvValue([
					"CONNECTORS_SERVICE_MAX_ATTEMPTS",
					"MAESTRO_CONNECTORS_SERVICE_MAX_ATTEMPTS",
				]),
				DEFAULT_MAX_ATTEMPTS,
			),
		timeoutMs:
			config?.timeoutMs ??
			parsePositiveInt(
				getEnvValue([
					"CONNECTORS_SERVICE_TIMEOUT_MS",
					"MAESTRO_CONNECTORS_SERVICE_TIMEOUT_MS",
				]),
				DEFAULT_TIMEOUT_MS,
			),
		token:
			trimString(config?.token) ??
			getEnvValue([
				"CONNECTORS_SERVICE_TOKEN",
				"MAESTRO_CONNECTORS_SERVICE_TOKEN",
				"MAESTRO_EVALOPS_ACCESS_TOKEN",
				"EVALOPS_TOKEN",
			]) ??
			storedToken,
		workspaceId: resolveWorkspaceId(config),
	};
}

function buildHeaders(
	config: ResolvedConnectorsServiceConfig,
): Record<string, string> {
	return {
		...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
		"Connect-Protocol-Version": CONNECT_PROTOCOL_VERSION,
		"Content-Type": "application/json",
	};
}

function getDownstreamClient(
	config: ResolvedConnectorsServiceConfig,
	op: ConnectorsCall,
): downstream.DownstreamClient {
	const failureMode = CONNECTORS_CALL_FAILURE_MODES[op];
	const key = JSON.stringify({
		baseUrl: config.baseUrl,
		failureMode,
		op,
		threshold: config.circuitFailureThreshold,
		reset: config.circuitResetTimeoutMs,
		success: config.circuitSuccessThreshold,
	});
	const cached = downstreamClients.get(key);
	if (cached) {
		return cached;
	}
	const client = downstream.New(`connectors.${op}`, {
		failureMode,
		breaker: {
			failureThreshold: config.circuitFailureThreshold,
			resetTimeoutMs: config.circuitResetTimeoutMs,
			successThreshold: config.circuitSuccessThreshold,
			toolName: `connectors.${op}`,
		},
	});
	downstreamClients.set(key, client);
	return client;
}

async function postConnectors<T>(
	config: ResolvedConnectorsServiceConfig,
	op: ConnectorsCall,
	path: string,
	body: Record<string, unknown>,
	failOpenValue: () => T,
): Promise<T> {
	const client = getDownstreamClient(config, op);
	return downstream.CallOp(
		client,
		op,
		async () => {
			const response = await fetchDownstream(
				`${config.baseUrl}${path}`,
				{
					method: "POST",
					headers: buildHeaders(config),
					body: JSON.stringify(body),
				},
				{
					serviceName: "connectors service",
					failureMode:
						client.failureMode === downstream.FailClosed
							? "required"
							: "optional",
					timeoutMs: config.timeoutMs,
					maxAttempts: config.maxAttempts,
				},
			);

			if (!response.ok) {
				const text = await response.text();
				throw new Error(
					`connectors service returned ${response.status}: ${
						text || response.statusText
					}`,
				);
			}

			return (await response.json()) as T;
		},
		failOpenValue,
	);
}

function normalizeRemoteConnection(
	connection: RemoteConnectionPayload | undefined,
): RemoteConnectorConnection | null {
	if (!connection) {
		return null;
	}
	const id = trimString(connection.id);
	const workspaceId = trimString(connection.workspaceId);
	const providerId = trimString(connection.providerId);
	if (!id || !workspaceId || !providerId) {
		return null;
	}
	const credentialRefs = normalizeStringMap(connection.credentialRefs);
	return {
		id,
		workspaceId,
		providerId,
		displayName: trimString(connection.displayName),
		authType: normalizeEnum(connection.authType),
		scopes: normalizeStringList(connection.scopes),
		...(credentialRefs ? { credentialRefs } : {}),
		healthStatus: normalizeEnum(connection.healthStatus),
		lastHealthyAt: trimString(connection.lastHealthyAt),
		createdAt: trimString(connection.createdAt),
		updatedAt: trimString(connection.updatedAt),
	};
}

function normalizeHealth(
	health: HealthPayload | undefined,
): RemoteConnectionHealth | null {
	if (!health) {
		return null;
	}
	return {
		status: normalizeEnum(health.status),
		latencyMs:
			typeof health.latencyMs === "number" && Number.isFinite(health.latencyMs)
				? Math.round(health.latencyMs)
				: undefined,
		lastCheckAt: trimString(health.lastCheckAt),
		errorMessage: trimString(health.errorMessage),
	};
}

function normalizeSourceOfTruthPolicy(
	policy: SourceOfTruthPolicyPayload | undefined,
	fallbackWorkspaceId?: string,
	fallbackArea?: string,
): RemoteSourceOfTruthPolicy | null {
	if (!policy) {
		return null;
	}
	const workspaceId = trimString(policy.workspaceId) ?? fallbackWorkspaceId;
	const area =
		fallbackArea ??
		(typeof policy.area === "string"
			? trimString(policy.area)?.replace(/^SOURCE_OF_TRUTH_AREA_/u, "")
			: undefined
		)?.toLowerCase();
	const primaryConnectionId = trimString(policy.primaryConnectionId);
	if (!workspaceId || !area || !primaryConnectionId) {
		return null;
	}
	return {
		workspaceId,
		area,
		primaryConnectionId,
		...(trimString(policy.fallbackConnectionId)
			? { fallbackConnectionId: trimString(policy.fallbackConnectionId) }
			: {}),
	};
}

export async function listRemoteConnections(
	workspaceId?: string,
	configInput?: ConnectorsServiceConfig | false,
): Promise<RemoteConnectorConnection[]> {
	const config = resolveConnectorsServiceConfig(configInput);
	const resolvedWorkspaceId = trimString(workspaceId) ?? config?.workspaceId;
	if (!config || !resolvedWorkspaceId) {
		return [];
	}

	const response = await postConnectors<ListConnectionsResponse>(
		config,
		"listConnections",
		LIST_PATH,
		{
			workspaceId: resolvedWorkspaceId,
			limit: DEFAULT_LIST_LIMIT,
			offset: 0,
		},
		() => ({ connections: [], total: 0 }),
	);
	return (response.connections ?? [])
		.map(normalizeRemoteConnection)
		.filter(
			(connection): connection is RemoteConnectorConnection =>
				connection !== null,
		);
}

export async function getRemoteConnection(
	connectionId?: string,
	configInput?: ConnectorsServiceConfig | false,
): Promise<RemoteConnectorConnection | null> {
	const config = resolveConnectorsServiceConfig(configInput);
	const id = trimString(connectionId);
	if (!config || !id) {
		return null;
	}
	const response = await postConnectors<ConnectionResponse>(
		config,
		"getConnection",
		GET_PATH,
		{ id },
		() => ({}),
	);
	return normalizeRemoteConnection(response.connection);
}

export async function registerRemoteConnection(
	input: RegisterRemoteConnectionInput,
	configInput?: ConnectorsServiceConfig | false,
): Promise<RemoteConnectorConnection | null> {
	const config = resolveConnectorsServiceConfig(configInput);
	const workspaceId = trimString(input.workspaceId) ?? config?.workspaceId;
	const providerId = trimString(input.providerId);
	if (!config || !workspaceId || !providerId) {
		return null;
	}

	const credentials = normalizeStringMap(input.credentials);
	const response = await postConnectors<ConnectionResponse>(
		config,
		"registerConnection",
		REGISTER_PATH,
		{
			workspaceId,
			providerId,
			displayName: trimString(input.displayName) ?? providerId,
			authType: input.authType,
			scopes: normalizeStringList(input.scopes),
			...(credentials ? { credentials } : {}),
		},
		() => ({}),
	);
	return normalizeRemoteConnection(response.connection);
}

export async function refreshRemoteConnection(
	connectionId?: string,
	configInput?: ConnectorsServiceConfig | false,
): Promise<RemoteConnectorConnection | null> {
	const config = resolveConnectorsServiceConfig(configInput);
	const id = trimString(connectionId);
	if (!config || !id) {
		return null;
	}
	const response = await postConnectors<ConnectionResponse>(
		config,
		"refreshConnection",
		REFRESH_PATH,
		{ id },
		() => ({}),
	);
	return normalizeRemoteConnection(response.connection);
}

export async function revokeRemoteConnection(
	connectionId?: string,
	configInput?: ConnectorsServiceConfig | false,
): Promise<boolean> {
	const config = resolveConnectorsServiceConfig(configInput);
	const id = trimString(connectionId);
	if (!config || !id) {
		return false;
	}
	const response = await postConnectors<{ revoked?: boolean }>(
		config,
		"revokeConnection",
		REVOKE_PATH,
		{ id },
		() => ({ revoked: false }),
	);
	return response.revoked !== false;
}

export async function getRemoteConnectionHealth(
	connectionId?: string,
	configInput?: ConnectorsServiceConfig | false,
): Promise<RemoteConnectionHealth | null> {
	const config = resolveConnectorsServiceConfig(configInput);
	const id = trimString(connectionId);
	if (!config || !id) {
		return null;
	}
	const response = await postConnectors<GetHealthResponse>(
		config,
		"getHealth",
		GET_HEALTH_PATH,
		{ connectionId: id },
		() => ({}),
	);
	return normalizeHealth(response.health);
}

export async function resolveRemoteSourceOfTruth(
	workspaceId?: string,
	area?: string,
	configInput?: ConnectorsServiceConfig | false,
): Promise<RemoteSourceOfTruthResolution | null> {
	const config = resolveConnectorsServiceConfig(configInput);
	const resolvedWorkspaceId = trimString(workspaceId) ?? config?.workspaceId;
	const normalizedArea = trimString(area)?.toLowerCase();
	const remoteArea = normalizedArea
		? SOURCE_OF_TRUTH_AREA_BY_LOCAL[normalizedArea]
		: undefined;
	if (!config || !resolvedWorkspaceId || !normalizedArea || !remoteArea) {
		return null;
	}
	const response = await postConnectors<ResolveSourceOfTruthResponse>(
		config,
		"resolveSourceOfTruth",
		RESOLVE_SOURCE_OF_TRUTH_PATH,
		{
			workspaceId: resolvedWorkspaceId,
			area: remoteArea,
		},
		() => ({}),
	);
	const primaryConnectionId =
		trimString(response.policy?.primaryConnectionId) ??
		trimString(response.primaryConnection?.id);
	const providerId = trimString(response.primaryConnection?.providerId);
	if (!primaryConnectionId || !providerId) {
		return null;
	}
	return {
		workspaceId:
			trimString(response.policy?.workspaceId) ?? resolvedWorkspaceId,
		area: normalizedArea,
		primaryConnectionId,
		...(trimString(response.policy?.fallbackConnectionId)
			? {
					fallbackConnectionId: trimString(
						response.policy?.fallbackConnectionId,
					),
				}
			: {}),
		providerId,
		...(trimString(response.primaryConnection?.displayName)
			? { displayName: trimString(response.primaryConnection?.displayName) }
			: {}),
	};
}

export async function setRemoteSourceOfTruthPolicy(
	input: SetRemoteSourceOfTruthPolicyInput,
	configInput?: ConnectorsServiceConfig | false,
): Promise<RemoteSourceOfTruthPolicy | null> {
	const config = resolveConnectorsServiceConfig(configInput);
	const workspaceId = trimString(input.workspaceId) ?? config?.workspaceId;
	const normalizedArea = trimString(input.area)?.toLowerCase();
	const remoteArea = normalizedArea
		? SOURCE_OF_TRUTH_AREA_BY_LOCAL[normalizedArea]
		: undefined;
	const primaryConnectionId = trimString(input.primaryConnectionId);
	const fallbackConnectionId = trimString(input.fallbackConnectionId);
	if (
		!config ||
		!workspaceId ||
		!normalizedArea ||
		!remoteArea ||
		!primaryConnectionId
	) {
		return null;
	}

	const response = await postConnectors<SetSourceOfTruthPolicyResponse>(
		config,
		"setSourceOfTruthPolicy",
		SET_SOURCE_OF_TRUTH_POLICY_PATH,
		{
			policy: {
				workspaceId,
				area: remoteArea,
				primaryConnectionId,
				...(fallbackConnectionId ? { fallbackConnectionId } : {}),
			},
		},
		() => ({}),
	);
	return normalizeSourceOfTruthPolicy(
		response.policy,
		workspaceId,
		normalizedArea,
	);
}

interface SetSourceOfTruthPolicyResponse {
	policy?: SourceOfTruthPolicyPayload;
}

export async function getRemoteDegradedReadPolicy(
	workspaceId?: string,
	configInput?: ConnectorsServiceConfig | false,
): Promise<RemoteDegradedReadPolicy | null> {
	const config = resolveConnectorsServiceConfig(configInput);
	const resolvedWorkspaceId = trimString(workspaceId) ?? config?.workspaceId;
	if (!config || !resolvedWorkspaceId) {
		return null;
	}
	const response = await postConnectors<GetDegradedReadPolicyResponse>(
		config,
		"getDegradedReadPolicy",
		GET_DEGRADED_READ_POLICY_PATH,
		{ workspaceId: resolvedWorkspaceId },
		() => ({}),
	);
	if (!response.policy) {
		return null;
	}
	const maxAgeMinutes = normalizePositiveInteger(response.policy.maxAgeMinutes);
	return {
		mode: trimString(response.policy.mode),
		integrations: normalizeStringList(response.policy.allowedIntegrations),
		...(maxAgeMinutes !== undefined ? { maxAgeMinutes } : {}),
		...(typeof response.policy.queuePrimaryRefresh === "boolean"
			? { queuePrimaryRefresh: response.policy.queuePrimaryRefresh }
			: {}),
	};
}

export async function getRemoteConnectionCapabilities(
	connectionId?: string,
	configInput?: ConnectorsServiceConfig | false,
): Promise<string[]> {
	const config = resolveConnectorsServiceConfig(configInput);
	const id = trimString(connectionId);
	if (!config || !id) {
		return [];
	}
	const response = await postConnectors<GetCapabilitiesResponse>(
		config,
		"getCapabilities",
		GET_CAPABILITIES_PATH,
		{ connectionId: id },
		() => ({ capabilities: [] }),
	);
	return normalizeStringList(response.capabilities);
}

export function resetConnectorsDownstreamForTests(): void {
	downstreamClients.clear();
	logger.debug("Reset connectors downstream client cache");
}
