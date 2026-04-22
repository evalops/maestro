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

function getMetadataString(
	metadata: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
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
	const saved =
		loadOAuthCredentials(provider) ??
		({ ...credentials, metadata } satisfies OAuthCredentials);
	const savedMetadata = saved.metadata ?? {};
	const connectorConnectionId = getMetadataString(
		savedMetadata,
		"connectorConnectionId",
	);
	const primaryConnectionId = getMetadataString(
		savedMetadata,
		"connectorSourceOfTruthPrimaryConnectionId",
	);
	const workspaceId = getMetadataString(
		savedMetadata,
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
	return true;
}
