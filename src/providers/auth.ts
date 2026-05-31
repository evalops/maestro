/**
 * Authentication Resolver - Unified Credential Resolution
 *
 * This module provides a unified authentication resolver that handles
 * multiple credential sources and authentication modes for all supported
 * AI providers. It abstracts the complexity of OAuth, API keys, and
 * environment variables into a single interface.
 *
 * ## Authentication Modes
 *
 * | Mode     | Description                                    |
 * |----------|------------------------------------------------|
 * | auto     | Try OAuth first, fallback to API keys (default)|
 * | api-key  | Only use API keys, skip OAuth                  |
 *
 * ## Credential Resolution Order
 *
 * 1. **Explicit API key**: Passed directly via options
 * 2. **OAuth tokens**: Provider-specific OAuth flows (if mode allows)
 * 3. **Environment variables**: Standard env var lookup
 * 4. **Custom providers**: From models registry configuration
 *
 * ## Credential Sources
 *
 * | Source              | Description                              |
 * |---------------------|------------------------------------------|
 * | explicit            | Passed directly to resolver              |
 * | env                 | From environment variable                |
 * | custom_literal      | Hardcoded in custom provider config      |
 * | custom_env          | Env var from custom provider config      |
 * | evalops_oauth_file  | EvalOps managed OAuth from stored credentials |
 * | openai_oauth_file   | OpenAI OAuth from stored credentials     |
 * | openai_codex_oauth_file | OpenAI Codex ChatGPT OAuth from stored credentials |
 * | google_oauth_file   | Google OAuth from stored credentials     |
 *
 * ## Example
 *
 * ```typescript
 * const resolver = createAuthResolver({ mode: 'auto' });
 * const credential = await resolver('anthropic');
 *
 * if (credential) {
 *   console.log(`Using ${credential.type} from ${credential.source}`);
 *   // Use credential.token for API requests
 * }
 * ```
 *
 * @module providers/auth
 */

import {
	EVALOPS_ORGANIZATION_ID_ENV_VARS,
	EVALOPS_WORKSPACE_ID_ENV_VARS,
	readEvalOpsEnv,
} from "../evalops/env-aliases.js";
import { getOAuthToken } from "../oauth/index.js";
import { loadOAuthCredentials } from "../oauth/storage.js";
import { lookupApiKey } from "./api-keys.js";
import {
	getEvalOpsManagedProviderDefinition,
	isEvalOpsManagedGatewayEnabled,
	isEvalOpsManagedProvider,
	isKnownEvalOpsManagedProvider,
} from "./evalops-managed.js";
import { getFreshOpenAIOAuthCredential } from "./openai-auth.js";

export type AuthMode = "auto" | "api-key";

export type AuthCredentialType = "api-key" | "bearer-token";

export type AuthCredentialSource =
	| "explicit"
	| "env"
	| "custom_literal"
	| "custom_env"
	| "evalops_agent_key_file"
	| "evalops_oauth_file"
	| "openai_oauth_file"
	| "openai_codex_oauth_file"
	| "google_oauth_file"
	| "github_copilot_oauth_file";

export interface AuthCredential {
	provider: string;
	token: string;
	type: AuthCredentialType;
	source: AuthCredentialSource;
	envVar?: string;
	headers?: Record<string, string>;
	metadata?: Record<string, unknown>;
	requestBody?: Record<string, unknown>;
}

export interface AuthResolverOptions {
	mode: AuthMode;
	explicitApiKey?: string;
}

type AuthResolver = (provider: string) => Promise<AuthCredential | undefined>;

function isOpenAIProvider(provider: string): boolean {
	const normalized = provider.toLowerCase();
	return (
		normalized !== "openai-codex" &&
		(normalized === "openai" ||
			normalized.startsWith("openai/") ||
			normalized.includes("openai-"))
	);
}

function isOpenAICodexProvider(provider: string): boolean {
	const normalized = provider.toLowerCase();
	return normalized === "openai-codex";
}

function isGoogleGeminiCliProvider(provider: string): boolean {
	const normalized = provider.toLowerCase();
	return (
		normalized === "google-gemini-cli" || normalized === "google-antigravity"
	);
}

function isGitHubCopilotProvider(provider: string): boolean {
	return provider.toLowerCase() === "github-copilot";
}

function resolveEvalOpsCredentialType(provider: string): AuthCredentialType {
	return getEvalOpsManagedProviderDefinition(provider)?.usesAnthropicOAuth
		? "bearer-token"
		: "api-key";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
	for (const value of values) {
		const candidate = getNonEmptyString(value);
		if (candidate) {
			return candidate;
		}
	}
	return undefined;
}

function readFirstEnv(names: readonly string[]): string | undefined {
	return firstNonEmptyString(...names.map((name) => process.env[name]));
}

function getStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value
				.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
				.filter((entry) => entry.length > 0)
		: [];
}

function isFutureTimestamp(value: unknown): boolean {
	const timestamp = getNonEmptyString(value);
	return !timestamp || Date.parse(timestamp) > Date.now();
}

function resolveEvalOpsAgentMcpAPIKey(
	metadata?: Record<string, unknown>,
): string | undefined {
	const agentMcp = isRecord(metadata?.agentMcp) ? metadata.agentMcp : undefined;
	const apiKey = getNonEmptyString(agentMcp?.apiKey);
	if (!apiKey || !isFutureTimestamp(agentMcp?.expiresAt)) {
		return undefined;
	}
	const scopes = getStringArray(agentMcp?.scopes);
	if (scopes.length > 0 && !scopes.includes("llm_gateway:invoke")) {
		return undefined;
	}
	return apiKey;
}

function resolveEvalOpsOrganizationId(
	metadata?: Record<string, unknown>,
): string | undefined {
	const candidate = getNonEmptyString(metadata?.organizationId);
	if (candidate && candidate.trim().length > 0) {
		return candidate.trim();
	}
	return readEvalOpsEnv(process.env, EVALOPS_ORGANIZATION_ID_ENV_VARS);
}

function resolveEvalOpsProviderRef(
	provider: string,
	metadata?: Record<string, unknown>,
): Record<string, string> {
	const providerRef = isRecord(metadata?.providerRef)
		? metadata.providerRef
		: null;
	const definition = getEvalOpsManagedProviderDefinition(provider);
	const metadataProvider = getNonEmptyString(providerRef?.provider);
	const configuredProvider =
		process.env.MAESTRO_EVALOPS_PROVIDER?.trim() ??
		process.env.MAESTRO_LLM_GATEWAY_PROVIDER?.trim();
	const resolvedProvider =
		(definition && definition.id !== "evalops"
			? definition.providerRefProvider
			: undefined) ??
		metadataProvider ??
		configuredProvider ??
		definition?.providerRefProvider ??
		"openai";
	const environment =
		getNonEmptyString(providerRef?.environment) ??
		process.env.MAESTRO_EVALOPS_ENVIRONMENT?.trim() ??
		process.env.MAESTRO_LLM_GATEWAY_ENVIRONMENT?.trim() ??
		"prod";
	const credentialName =
		getNonEmptyString(providerRef?.credential_name) ??
		process.env.MAESTRO_EVALOPS_CREDENTIAL_NAME?.trim() ??
		process.env.MAESTRO_LLM_GATEWAY_CREDENTIAL_NAME?.trim();
	const teamId =
		getNonEmptyString(providerRef?.team_id) ??
		process.env.MAESTRO_EVALOPS_TEAM_ID?.trim() ??
		process.env.MAESTRO_LLM_GATEWAY_TEAM_ID?.trim();
	return {
		provider: resolvedProvider,
		environment,
		...(credentialName ? { credential_name: credentialName } : {}),
		...(teamId ? { team_id: teamId } : {}),
	};
}

function resolveEvalOpsRequestMetadata(
	metadata?: Record<string, unknown>,
): Record<string, string> {
	const agentMcp = isRecord(metadata?.agentMcp) ? metadata.agentMcp : undefined;
	const agentID = firstNonEmptyString(
		metadata?.agentId,
		metadata?.agent_id,
		agentMcp?.agentId,
		agentMcp?.agent_id,
		readFirstEnv(["MAESTRO_EVALOPS_AGENT_ID", "MAESTRO_AGENT_ID"]),
	);
	const platformRunID = firstNonEmptyString(
		metadata?.runId,
		metadata?.run_id,
		agentMcp?.runId,
		agentMcp?.run_id,
		readFirstEnv(["MAESTRO_EVALOPS_RUN_ID"]),
	);
	const agentRunID = firstNonEmptyString(
		metadata?.agentRunId,
		metadata?.agent_run_id,
		agentMcp?.agentRunId,
		agentMcp?.agent_run_id,
		readFirstEnv(["MAESTRO_AGENT_RUN_ID", "MAESTRO_EVALOPS_AGENT_RUN_ID"]),
		platformRunID,
	);
	const runID = platformRunID ?? agentRunID;
	const platformSessionID = firstNonEmptyString(
		metadata?.sessionId,
		metadata?.session_id,
		agentMcp?.sessionId,
		agentMcp?.session_id,
		readFirstEnv(["MAESTRO_EVALOPS_SESSION_ID"]),
	);
	const maestroSessionID = firstNonEmptyString(
		metadata?.maestroSessionId,
		metadata?.maestro_session_id,
		readFirstEnv(["MAESTRO_SESSION_ID"]),
		platformSessionID,
	);
	const sessionID = platformSessionID ?? maestroSessionID;
	const workspaceID = firstNonEmptyString(
		metadata?.workspaceId,
		metadata?.workspace_id,
		agentMcp?.workspaceId,
		agentMcp?.workspace_id,
		readEvalOpsEnv(process.env, EVALOPS_WORKSPACE_ID_ENV_VARS),
	);
	const objectiveID = firstNonEmptyString(
		metadata?.objectiveId,
		metadata?.objective_id,
		agentMcp?.objectiveId,
		agentMcp?.objective_id,
		readFirstEnv(["MAESTRO_OBJECTIVE_ID", "MAESTRO_EVALOPS_OBJECTIVE_ID"]),
	);
	const stepID = firstNonEmptyString(
		metadata?.agentRunStepId,
		metadata?.agent_run_step_id,
		metadata?.stepId,
		metadata?.step_id,
		agentMcp?.agentRunStepId,
		agentMcp?.agent_run_step_id,
		readFirstEnv([
			"MAESTRO_AGENT_RUN_STEP_ID",
			"MAESTRO_EVALOPS_AGENT_RUN_STEP_ID",
		]),
	);
	const traceID = firstNonEmptyString(
		metadata?.traceId,
		metadata?.trace_id,
		agentMcp?.traceId,
		agentMcp?.trace_id,
		readFirstEnv(["MAESTRO_TRACE_ID", "TRACE_ID"]),
	);
	const threadID = firstNonEmptyString(
		metadata?.threadId,
		metadata?.thread_id,
		agentMcp?.threadId,
		agentMcp?.thread_id,
		readFirstEnv(["MAESTRO_THREAD_ID", "MAESTRO_EVALOPS_THREAD_ID"]),
	);
	const turnID = firstNonEmptyString(
		metadata?.turnId,
		metadata?.turn_id,
		agentMcp?.turnId,
		agentMcp?.turn_id,
		readFirstEnv(["MAESTRO_TURN_ID", "MAESTRO_EVALOPS_TURN_ID"]),
	);
	const toolCallID = firstNonEmptyString(
		metadata?.toolCallId,
		metadata?.tool_call_id,
		agentMcp?.toolCallId,
		agentMcp?.tool_call_id,
		readFirstEnv(["MAESTRO_TOOL_CALL_ID", "MAESTRO_EVALOPS_TOOL_CALL_ID"]),
	);
	const workload = firstNonEmptyString(
		metadata?.workload,
		agentMcp?.workload,
		readFirstEnv(["MAESTRO_EVALOPS_WORKLOAD", "MAESTRO_WORKLOAD"]),
	);
	const surface =
		firstNonEmptyString(
			metadata?.surface,
			agentMcp?.surface,
			readFirstEnv(["MAESTRO_EVALOPS_SURFACE", "MAESTRO_SURFACE"]),
		) ?? "maestro";

	return Object.fromEntries(
		Object.entries({
			agent_id: agentID,
			workspace_id: workspaceID,
			objective_id: objectiveID,
			run_id: runID,
			agent_run_id: agentRunID,
			agent_run_step_id: stepID,
			session_id: sessionID,
			maestro_session_id: maestroSessionID,
			surface,
			trace_id: traceID,
			thread_id: threadID,
			turn_id: turnID,
			tool_call_id: toolCallID,
			workload,
		}).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === "string" && entry[1].trim().length > 0,
		),
	);
}

function buildEvalOpsCredential(
	provider: string,
	token: string,
	source: AuthCredentialSource,
	metadata?: Record<string, unknown>,
	envVar?: string,
): AuthCredential | undefined {
	const organizationId = resolveEvalOpsOrganizationId(metadata);
	if (!organizationId) {
		return undefined;
	}
	return {
		provider,
		token,
		type: resolveEvalOpsCredentialType(provider),
		source,
		envVar,
		headers: {
			"X-Organization-ID": organizationId,
		},
		metadata,
		requestBody: {
			metadata: resolveEvalOpsRequestMetadata(metadata),
			provider_ref: resolveEvalOpsProviderRef(provider, metadata),
		},
	};
}

export function createAuthResolver(options: AuthResolverOptions): AuthResolver {
	const explicitKey = options.explicitApiKey?.trim();
	return async (provider: string): Promise<AuthCredential | undefined> => {
		if (
			isKnownEvalOpsManagedProvider(provider) &&
			!isEvalOpsManagedGatewayEnabled()
		) {
			return undefined;
		}

		const normalizedProvider = provider.toLowerCase();

		if (explicitKey) {
			if (isEvalOpsManagedProvider(provider)) {
				return buildEvalOpsCredential(provider, explicitKey, "explicit");
			}
			return {
				provider,
				token: explicitKey,
				type: "api-key",
				source: "explicit",
			};
		}

		if (isEvalOpsManagedProvider(provider) && options.mode !== "api-key") {
			const credentials = loadOAuthCredentials("evalops");
			const agentAPIKey = resolveEvalOpsAgentMcpAPIKey(credentials?.metadata);
			if (agentAPIKey) {
				return buildEvalOpsCredential(
					provider,
					agentAPIKey,
					"evalops_agent_key_file",
					credentials?.metadata,
				);
			}
			const oauthToken = await getOAuthToken("evalops");
			if (oauthToken) {
				const refreshedCredentials = loadOAuthCredentials("evalops");
				return buildEvalOpsCredential(
					provider,
					oauthToken,
					"evalops_oauth_file",
					refreshedCredentials?.metadata ?? credentials?.metadata,
				);
			}
		}

		if (isOpenAICodexProvider(provider) && options.mode !== "api-key") {
			const oauthToken = await getOAuthToken("openai-codex");
			if (oauthToken) {
				const credentials = loadOAuthCredentials("openai-codex");
				const accountId =
					typeof credentials?.metadata?.accountId === "string"
						? credentials.metadata.accountId
						: undefined;
				return {
					provider,
					token: oauthToken,
					type: "api-key",
					source: "openai_codex_oauth_file",
					headers: accountId ? { "chatgpt-account-id": accountId } : undefined,
					metadata: credentials?.metadata,
				};
			}
		}

		// Handle OpenAI Auth
		if (isOpenAIProvider(provider) && options.mode !== "api-key") {
			// OpenAI OAuth
			const oauthCred = await getFreshOpenAIOAuthCredential();
			if (oauthCred?.apiKey) {
				return {
					provider,
					token: oauthCred.apiKey,
					type: "api-key",
					source: "openai_oauth_file",
					metadata: { mode: oauthCred.mode },
				};
			}
		}

		if (isGitHubCopilotProvider(provider) && options.mode !== "api-key") {
			const oauthToken = await getOAuthToken("github-copilot");
			if (oauthToken) {
				const credentials = loadOAuthCredentials("github-copilot");
				return {
					provider,
					token: oauthToken,
					type: "api-key",
					source: "github_copilot_oauth_file",
					metadata: credentials?.metadata,
				};
			}
		}

		if (isGoogleGeminiCliProvider(provider) && options.mode !== "api-key") {
			const oauthProvider =
				normalizedProvider === "google-antigravity"
					? "google-antigravity"
					: "google-gemini-cli";
			const oauthToken = await getOAuthToken(oauthProvider);
			if (oauthToken) {
				const credentials = loadOAuthCredentials(oauthProvider);
				const projectId =
					typeof credentials?.metadata?.projectId === "string"
						? credentials.metadata.projectId
						: undefined;
				if (projectId) {
					return {
						provider,
						token: JSON.stringify({ token: oauthToken, projectId }),
						type: "api-key",
						source: "google_oauth_file",
						metadata: credentials?.metadata,
					};
				}
			}
		}

		const lookup = lookupApiKey(provider, explicitKey);
		if (lookup.key) {
			if (lookup.source === "missing") {
				return undefined;
			}
			if (isEvalOpsManagedProvider(provider)) {
				return buildEvalOpsCredential(
					provider,
					lookup.key,
					lookup.source,
					undefined,
					lookup.envVar,
				);
			}
			return {
				provider,
				token: lookup.key,
				type: "api-key",
				source: lookup.source,
				envVar: lookup.envVar,
			};
		}
		return undefined;
	};
}
