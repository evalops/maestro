import {
	type RemoteConnectorConnection,
	type RemoteSourceOfTruthPolicy,
	refreshRemoteConnection,
	registerRemoteConnection,
	revokeRemoteConnection,
	setRemoteSourceOfTruthPolicy,
} from "../connectors/service-client.js";
import type { SupportedOAuthProvider } from "./index.js";
import {
	type OAuthCredentials,
	loadOAuthCredentials,
	saveOAuthCredentials,
} from "./storage.js";

type ConnectorOAuthProvider = Exclude<SupportedOAuthProvider, "evalops">;

const CONNECTOR_PROVIDER_BY_OAUTH_PROVIDER: Record<
	ConnectorOAuthProvider,
	string
> = {
	anthropic: "x-evalops:anthropic",
	"github-copilot": "github",
	"google-antigravity": "google",
	"google-gemini-cli": "google",
	openai: "x-evalops:openai",
	"openai-codex": "x-evalops:openai",
};

const DISPLAY_NAME_BY_OAUTH_PROVIDER: Record<ConnectorOAuthProvider, string> = {
	anthropic: "Anthropic OAuth",
	"github-copilot": "GitHub Copilot OAuth",
	"google-antigravity": "Google Antigravity OAuth",
	"google-gemini-cli": "Google Gemini CLI OAuth",
	openai: "OpenAI OAuth",
	"openai-codex": "OpenAI Codex OAuth",
};

export const CONNECTOR_SOURCE_OF_TRUTH_AREAS = [
	"analytics",
	"billing",
	"crm",
	"hris",
	"support",
] as const;

export type ConnectorSourceOfTruthArea =
	(typeof CONNECTOR_SOURCE_OF_TRUTH_AREAS)[number];

export interface ConfigureOAuthProviderSourceOfTruthPolicyInput {
	area: string;
	fallbackConnectionId?: string;
}

export interface ConfiguredOAuthProviderSourceOfTruthPolicy {
	provider: ConnectorOAuthProvider;
	area: ConnectorSourceOfTruthArea;
	fallbackConnectionId?: string;
	connectorConnectionId?: string;
	primaryConnectionId?: string;
	workspaceId?: string;
}

const SOURCE_OF_TRUTH_METADATA_KEYS = [
	"connectorSourceOfTruthArea",
	"connectorSourceOfTruthFallbackConnectionId",
	"connectorSourceOfTruthPrimaryConnectionId",
	"connectorSourceOfTruthWorkspaceId",
	"sourceOfTruthArea",
	"sourceOfTruthFallbackConnectionId",
] as const;

function isConnectorOAuthProvider(
	provider: string,
): provider is ConnectorOAuthProvider {
	return Object.prototype.hasOwnProperty.call(
		CONNECTOR_PROVIDER_BY_OAUTH_PROVIDER,
		provider,
	);
}

function supportedConnectorOAuthProviders(): string {
	return Object.keys(CONNECTOR_PROVIDER_BY_OAUTH_PROVIDER).sort().join(", ");
}

function trimString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

export function normalizeConnectorSourceOfTruthArea(
	area: string,
): ConnectorSourceOfTruthArea | null {
	const normalized = area
		.trim()
		.toLowerCase()
		.replace(/^source_of_truth_area_/u, "")
		.replace(/^source-of-truth-area-/u, "")
		.replaceAll("_", "-");
	for (const candidate of CONNECTOR_SOURCE_OF_TRUTH_AREAS) {
		if (
			candidate === normalized ||
			candidate.replaceAll("_", "-") === normalized
		) {
			return candidate;
		}
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMetadataString(
	metadata: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function getMetadataStringArray(
	metadata: Record<string, unknown> | undefined,
	key: string,
): string[] | undefined {
	const value = metadata?.[key];
	if (!Array.isArray(value)) {
		return undefined;
	}
	const entries = value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return entries.length > 0 ? entries : undefined;
}

function getMetadataStringMap(
	metadata: Record<string, unknown> | undefined,
	key: string,
): Record<string, string> | undefined {
	const value = metadata?.[key];
	if (!isRecord(value)) {
		return undefined;
	}
	const entries = Object.entries(value)
		.map(
			([entryKey, entryValue]) =>
				[
					entryKey.trim(),
					typeof entryValue === "string" ? entryValue.trim() : "",
				] as const,
		)
		.filter(([entryKey, entryValue]) => entryKey && entryValue);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mergeConnectionMetadata(
	credentials: OAuthCredentials,
	connection: RemoteConnectorConnection | null,
	providerId: string,
): OAuthCredentials {
	if (!connection) {
		return credentials;
	}
	return {
		...credentials,
		metadata: {
			...credentials.metadata,
			connectorConnectionId: connection.id,
			connectorHealthStatus: connection.healthStatus,
			connectorProviderId: connection.providerId || providerId,
			connectorUpdatedAt: connection.updatedAt,
			connectorWorkspaceId: connection.workspaceId,
		},
	};
}

function getSourceOfTruthArea(
	metadata: Record<string, unknown> | undefined,
): string | undefined {
	return (
		getMetadataString(metadata, "connectorSourceOfTruthArea") ??
		getMetadataString(metadata, "sourceOfTruthArea")
	);
}

function getSourceOfTruthFallbackConnectionId(
	metadata: Record<string, unknown> | undefined,
): string | undefined {
	return (
		getMetadataString(metadata, "connectorSourceOfTruthFallbackConnectionId") ??
		getMetadataString(metadata, "sourceOfTruthFallbackConnectionId")
	);
}

function mergeSourceOfTruthPolicyMetadata(
	credentials: OAuthCredentials,
	policy: RemoteSourceOfTruthPolicy | null,
): OAuthCredentials {
	if (!policy) {
		return credentials;
	}
	return {
		...credentials,
		metadata: {
			...credentials.metadata,
			connectorSourceOfTruthArea: policy.area,
			connectorSourceOfTruthPrimaryConnectionId: policy.primaryConnectionId,
			connectorSourceOfTruthWorkspaceId: policy.workspaceId,
			...(policy.fallbackConnectionId
				? {
						connectorSourceOfTruthFallbackConnectionId:
							policy.fallbackConnectionId,
					}
				: {}),
		},
	};
}

async function syncSourceOfTruthPolicy(
	credentials: OAuthCredentials,
	connection: RemoteConnectorConnection | null,
): Promise<OAuthCredentials> {
	if (!connection) {
		return credentials;
	}
	const area = getSourceOfTruthArea(credentials.metadata);
	if (!area) {
		return credentials;
	}

	const policy = await setRemoteSourceOfTruthPolicy({
		workspaceId: connection.workspaceId,
		area,
		primaryConnectionId: connection.id,
		fallbackConnectionId: getSourceOfTruthFallbackConnectionId(
			credentials.metadata,
		),
	});
	return mergeSourceOfTruthPolicyMetadata(credentials, policy);
}

export async function syncOAuthProviderConnection(
	provider: SupportedOAuthProvider,
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
	if (!isConnectorOAuthProvider(provider)) {
		return credentials;
	}

	const providerId = CONNECTOR_PROVIDER_BY_OAUTH_PROVIDER[provider];
	const connectionId = getMetadataString(
		credentials.metadata,
		"connectorConnectionId",
	);
	if (connectionId) {
		const connection = await refreshRemoteConnection(connectionId);
		return syncSourceOfTruthPolicy(
			mergeConnectionMetadata(credentials, connection, providerId),
			connection,
		);
	}

	const connection = await registerRemoteConnection({
		providerId,
		displayName: DISPLAY_NAME_BY_OAUTH_PROVIDER[provider],
		authType: "AUTH_TYPE_OAUTH2",
		scopes: getMetadataStringArray(credentials.metadata, "scopes"),
		credentials: getMetadataStringMap(
			credentials.metadata,
			"connectorCredentialRefs",
		),
	});
	return syncSourceOfTruthPolicy(
		mergeConnectionMetadata(credentials, connection, providerId),
		connection,
	);
}

export async function syncStoredOAuthProviderConnection(
	provider: SupportedOAuthProvider,
): Promise<void> {
	if (!isConnectorOAuthProvider(provider)) {
		return;
	}
	const credentials = loadOAuthCredentials(provider);
	if (!credentials) {
		return;
	}
	const synced = await syncOAuthProviderConnection(provider, credentials);
	if (synced !== credentials) {
		saveOAuthCredentials(provider, synced);
	}
}

export async function configureOAuthProviderSourceOfTruthPolicy(
	provider: string,
	input: ConfigureOAuthProviderSourceOfTruthPolicyInput,
): Promise<ConfiguredOAuthProviderSourceOfTruthPolicy> {
	if (!isConnectorOAuthProvider(provider)) {
		throw new Error(
			`Unsupported OAuth connector provider: ${provider}. Supported providers: ${supportedConnectorOAuthProviders()}`,
		);
	}
	const credentials = loadOAuthCredentials(provider);
	if (!credentials) {
		throw new Error(`No OAuth credentials found for ${provider}`);
	}
	const area = normalizeConnectorSourceOfTruthArea(input.area);
	if (!area) {
		throw new Error(
			`Unsupported source-of-truth area: ${input.area}. Valid areas: ${CONNECTOR_SOURCE_OF_TRUTH_AREAS.join(", ")}`,
		);
	}

	const metadata: Record<string, unknown> = { ...credentials.metadata };
	metadata.connectorSourceOfTruthArea = area;
	delete metadata.sourceOfTruthArea;
	delete metadata.sourceOfTruthFallbackConnectionId;
	delete metadata.connectorSourceOfTruthPrimaryConnectionId;
	delete metadata.connectorSourceOfTruthWorkspaceId;

	const fallbackConnectionId = trimString(input.fallbackConnectionId);
	if (fallbackConnectionId) {
		metadata.connectorSourceOfTruthFallbackConnectionId = fallbackConnectionId;
	} else {
		delete metadata.connectorSourceOfTruthFallbackConnectionId;
	}

	saveOAuthCredentials(provider, { ...credentials, metadata });
	await syncStoredOAuthProviderConnection(provider);

	const synced = loadOAuthCredentials(provider) ?? { ...credentials, metadata };
	const syncedMetadata = synced.metadata ?? {};
	const connectorConnectionId = getMetadataString(
		syncedMetadata,
		"connectorConnectionId",
	);
	const primaryConnectionId = getMetadataString(
		syncedMetadata,
		"connectorSourceOfTruthPrimaryConnectionId",
	);
	const workspaceId = getMetadataString(
		syncedMetadata,
		"connectorSourceOfTruthWorkspaceId",
	);
	return {
		provider,
		area,
		...(fallbackConnectionId ? { fallbackConnectionId } : {}),
		...(connectorConnectionId ? { connectorConnectionId } : {}),
		...(primaryConnectionId ? { primaryConnectionId } : {}),
		...(workspaceId ? { workspaceId } : {}),
	};
}

export function clearOAuthProviderSourceOfTruthPolicy(
	provider: string,
): boolean {
	if (!isConnectorOAuthProvider(provider)) {
		throw new Error(
			`Unsupported OAuth connector provider: ${provider}. Supported providers: ${supportedConnectorOAuthProviders()}`,
		);
	}
	const credentials = loadOAuthCredentials(provider);
	if (!credentials) {
		throw new Error(`No OAuth credentials found for ${provider}`);
	}

	const metadata: Record<string, unknown> = { ...credentials.metadata };
	const hadPolicyMetadata = SOURCE_OF_TRUTH_METADATA_KEYS.some(
		(key) => key in metadata,
	);
	if (!hadPolicyMetadata) {
		return false;
	}
	for (const key of SOURCE_OF_TRUTH_METADATA_KEYS) {
		delete metadata[key];
	}
	saveOAuthCredentials(provider, { ...credentials, metadata });
	return hadPolicyMetadata;
}

export async function revokeOAuthProviderConnection(
	provider: SupportedOAuthProvider,
	credentials: OAuthCredentials | null,
): Promise<void> {
	if (!isConnectorOAuthProvider(provider)) {
		return;
	}
	const connectionId = getMetadataString(
		credentials?.metadata,
		"connectorConnectionId",
	);
	if (!connectionId) {
		return;
	}
	await revokeRemoteConnection(connectionId);
}
