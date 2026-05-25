import {
	assertEvalOpsManagedGatewayEnabled,
	isEvalOpsManagedGatewayEnabled,
} from "../providers/evalops-managed.js";
import { createLogger } from "../utils/logger.js";
import {
	revokeOAuthProviderConnection,
	syncOAuthProviderConnection,
	syncStoredOAuthProviderConnection,
} from "./connectors.js";
import {
	buildEvalOpsDelegationEnvironment,
	issueEvalOpsDelegationToken,
	loginEvalOps,
	refreshEvalOpsToken,
	revokeEvalOpsToken,
} from "./evalops.js";
import {
	loginGitHubCopilot,
	migrateGitHubCopilotCredentials,
	refreshGitHubCopilotToken,
} from "./github-copilot.js";
import {
	loginGoogleAntigravity,
	refreshGoogleAntigravityToken,
} from "./google-antigravity.js";
import {
	loginGoogleGeminiCli,
	refreshGoogleGeminiCliToken,
} from "./google-gemini-cli.js";
import { loginOpenAICodex, refreshOpenAICodexToken } from "./openai-codex.js";
import {
	loginOpenAI,
	migrateOpenAICredentials,
	refreshOpenAIToken,
} from "./openai.js";
import {
	type OAuthCredentials,
	listOAuthProviders as listOAuthProvidersFromStorage,
	loadOAuthCredentials,
	removeOAuthCredentials,
	saveOAuthCredentials,
} from "./storage.js";

const logger = createLogger("oauth");

export type { OAuthCredentials } from "./storage.js";
export { buildEvalOpsDelegationEnvironment, issueEvalOpsDelegationToken };

export type SupportedOAuthProvider =
	| "evalops"
	| "openai"
	| "openai-codex"
	| "github-copilot"
	| "google-gemini-cli"
	| "google-antigravity";

export type LegacyLogoutOnlyOAuthProvider = "anthropic";
export type OAuthLogoutProvider =
	| SupportedOAuthProvider
	| LegacyLogoutOnlyOAuthProvider;

const SUPPORTED_OAUTH_PROVIDERS = new Set<SupportedOAuthProvider>([
	"evalops",
	"openai",
	"openai-codex",
	"github-copilot",
	"google-gemini-cli",
	"google-antigravity",
]);

const LEGACY_LOGOUT_ONLY_OAUTH_PROVIDERS =
	new Set<LegacyLogoutOnlyOAuthProvider>(["anthropic"]);

export interface OAuthProviderInfo<
	TProvider extends string = SupportedOAuthProvider,
> {
	id: TProvider;
	name: string;
	description: string;
	available: boolean;
}

function isSupportedOAuthProvider(
	provider: string,
): provider is SupportedOAuthProvider {
	return SUPPORTED_OAUTH_PROVIDERS.has(provider as SupportedOAuthProvider);
}

function isLegacyLogoutOnlyOAuthProvider(
	provider: string,
): provider is LegacyLogoutOnlyOAuthProvider {
	return LEGACY_LOGOUT_ONLY_OAUTH_PROVIDERS.has(
		provider as LegacyLogoutOnlyOAuthProvider,
	);
}

/**
 * Get list of OAuth providers
 */
export function getOAuthProviders(): OAuthProviderInfo[] {
	return [
		{
			id: "openai-codex",
			name: "OpenAI Codex",
			description: "Codex with ChatGPT Plus/Pro login",
			available: true,
		},
		{
			id: "openai",
			name: "OpenAI",
			description: "OpenAI Platform API via ChatGPT login",
			available: true,
		},
		{
			id: "evalops",
			name: "EvalOps Managed",
			description: "Identity-backed managed gateway access",
			available: isEvalOpsManagedGatewayEnabled(),
		},
		{
			id: "google-gemini-cli",
			name: "Google Gemini CLI",
			description: "Cloud Code Assist OAuth",
			available: true,
		},
		{
			id: "google-antigravity",
			name: "Google Antigravity",
			description: "Antigravity sandbox OAuth",
			available: true,
		},
		{
			id: "github-copilot",
			name: "GitHub Copilot",
			description: "GitHub Copilot subscription",
			available: true,
		},
	];
}

export function listOAuthProviders(): SupportedOAuthProvider[] {
	return listOAuthProvidersFromStorage().filter(
		(provider): provider is SupportedOAuthProvider =>
			isSupportedOAuthProvider(provider),
	);
}

export function listOAuthLogoutProviders(): OAuthLogoutProvider[] {
	return listOAuthProvidersFromStorage().filter(
		(provider): provider is OAuthLogoutProvider =>
			isSupportedOAuthProvider(provider) ||
			isLegacyLogoutOnlyOAuthProvider(provider),
	);
}

export function getOAuthLogoutProviders(): OAuthProviderInfo<OAuthLogoutProvider>[] {
	const loggedInProviders = new Set(listOAuthLogoutProviders());
	const supported = getOAuthProviders().filter((provider) =>
		loggedInProviders.has(provider.id),
	);
	const legacy: OAuthProviderInfo<OAuthLogoutProvider>[] = [];
	if (loggedInProviders.has("anthropic")) {
		legacy.push({
			id: "anthropic",
			name: "Anthropic OAuth",
			description: "Legacy Anthropic OAuth credentials (logout only)",
			available: true,
		});
	}
	return [...supported, ...legacy];
}

/**
 * Check if a provider has OAuth credentials stored
 */
export function hasOAuthCredentials(provider: SupportedOAuthProvider): boolean {
	if (!SUPPORTED_OAUTH_PROVIDERS.has(provider)) {
		return false;
	}
	return loadOAuthCredentials(provider) !== null;
}

/**
 * Login with OAuth provider
 */
export async function login(
	provider: SupportedOAuthProvider,
	options: {
		mode?: string;
		onAuthUrl: (url: string) => void;
		onPromptCode?: () => Promise<string>;
		onStatus?: (status: string) => void;
		onDeviceCode?: (code: string, verificationUri: string) => void;
	},
): Promise<void> {
	let shouldSyncConnectorConnection = false;
	switch (provider) {
		case "openai":
			await loginOpenAI(options.onAuthUrl, options.onStatus);
			shouldSyncConnectorConnection = true;
			break;
		case "openai-codex":
			await loginOpenAICodex(
				options.onAuthUrl,
				options.onPromptCode,
				options.onStatus,
			);
			shouldSyncConnectorConnection = true;
			break;
		case "evalops":
			assertEvalOpsManagedGatewayEnabled();
			await loginEvalOps(options.onAuthUrl, options.onStatus);
			break;
		case "google-gemini-cli":
			await loginGoogleGeminiCli(options.onAuthUrl, options.onStatus);
			shouldSyncConnectorConnection = true;
			break;
		case "google-antigravity":
			await loginGoogleAntigravity(options.onAuthUrl, options.onStatus);
			shouldSyncConnectorConnection = true;
			break;
		case "github-copilot":
			if (!options.onDeviceCode) {
				throw new Error(
					"GitHub Copilot requires onDeviceCode callback for device flow",
				);
			}
			await loginGitHubCopilot(options.onDeviceCode, options.onStatus);
			shouldSyncConnectorConnection = true;
			break;
		default:
			throw new Error(`Unknown OAuth provider: ${provider}`);
	}
	if (shouldSyncConnectorConnection) {
		await syncStoredOAuthProviderConnection(provider);
	}
}

/**
 * Logout from OAuth provider
 */
export async function logout(provider: OAuthLogoutProvider): Promise<void> {
	const credentials = loadOAuthCredentials(provider);
	if (isLegacyLogoutOnlyOAuthProvider(provider)) {
		removeOAuthCredentials(provider);
		return;
	}
	if (provider === "evalops" && credentials?.refresh) {
		try {
			await revokeEvalOpsToken(credentials.refresh, credentials.metadata);
		} catch (error) {
			logger.warn("Failed to revoke EvalOps refresh token during logout", {
				error: error instanceof Error ? error.message : String(error),
				provider,
			});
		}
	}
	if (provider !== "evalops") {
		await revokeOAuthProviderConnection(provider, credentials);
	}
	removeOAuthCredentials(provider);
}

/**
 * Refresh OAuth token for provider
 */
export async function refreshToken(
	provider: SupportedOAuthProvider,
): Promise<string> {
	const credentials = loadOAuthCredentials(provider);
	if (!credentials) {
		throw new Error(`No OAuth credentials found for ${provider}`);
	}

	let newCredentials: OAuthCredentials;

	switch (provider) {
		case "openai":
			newCredentials = await refreshOpenAIToken(
				credentials.refresh,
				credentials.metadata,
			);
			break;
		case "openai-codex":
			newCredentials = await refreshOpenAICodexToken(
				credentials.refresh,
				credentials.metadata,
			);
			break;
		case "evalops":
			newCredentials = await refreshEvalOpsToken(
				credentials.refresh,
				credentials.metadata,
			);
			break;
		case "google-gemini-cli":
			newCredentials = await refreshGoogleGeminiCliToken(
				credentials.refresh,
				credentials.metadata,
			);
			break;
		case "google-antigravity":
			newCredentials = await refreshGoogleAntigravityToken(
				credentials.refresh,
				credentials.metadata,
			);
			break;
		case "github-copilot":
			newCredentials = await refreshGitHubCopilotToken(
				credentials.refresh,
				credentials.metadata,
			);
			break;
		default:
			throw new Error(`Unknown OAuth provider: ${provider}`);
	}

	if (provider !== "evalops") {
		newCredentials = await syncOAuthProviderConnection(
			provider,
			newCredentials,
		);
	}

	// Save new credentials
	saveOAuthCredentials(provider, newCredentials);

	return newCredentials.access;
}

/**
 * Get OAuth token for provider (auto-refreshes if expired)
 */
export async function getOAuthToken(
	provider: SupportedOAuthProvider,
): Promise<string | null> {
	if (!SUPPORTED_OAUTH_PROVIDERS.has(provider)) {
		return null;
	}
	const credentials = loadOAuthCredentials(provider);
	if (!credentials) {
		return null;
	}

	// Check if token is expired (with 1 min buffer)
	if (Date.now() >= credentials.expires - 60_000) {
		// Token expired or expiring soon - refresh it
		try {
			return await refreshToken(provider);
		} catch (error) {
			logger.error(
				"Failed to refresh OAuth token",
				error instanceof Error ? error : new Error(String(error)),
				{ provider },
			);
			// Remove invalid credentials
			removeOAuthCredentials(provider);
			return null;
		}
	}

	return credentials.access;
}

/**
 * Migrate old provider-specific OAuth credentials to new generic format
 */
export async function migrateOAuthCredentials(): Promise<void> {
	// Migrate OpenAI credentials
	const openaiMigrated = await migrateOpenAICredentials();
	if (openaiMigrated) {
		logger.info("Migrated OpenAI OAuth credentials to new format");
	}

	// Migrate GitHub Copilot credentials from environment
	const copilotMigrated = await migrateGitHubCopilotCredentials();
	if (copilotMigrated) {
		logger.info("Migrated GitHub Copilot credentials from environment");
	}
}
