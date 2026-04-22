import {
	type IncomingMessage,
	type Server,
	type ServerResponse,
	createServer,
} from "node:http";
import { PLATFORM_HTTP_ROUTES } from "../platform/core-services.js";
import { createLogger } from "../utils/logger.js";
import {
	type OAuthCredentials,
	loadOAuthCredentials,
	saveOAuthCredentials,
} from "./storage.js";

const logger = createLogger("oauth:evalops");

const CALLBACK_PORT = 1460;
const CALLBACK_PATH = "/auth/callback/evalops";
const CALLBACK_ORIGIN = `http://127.0.0.1:${CALLBACK_PORT}`;
const CALLBACK_URI = `${CALLBACK_ORIGIN}${CALLBACK_PATH}`;
const DEFAULT_IDENTITY_URL = "http://127.0.0.1:8080";
const IDENTITY_BASE_URL_ENV_VARS = [
	"MAESTRO_IDENTITY_URL",
	"EVALOPS_IDENTITY_URL",
] as const;
const SHARED_PLATFORM_BASE_URL_ENV_VARS = [
	"MAESTRO_PLATFORM_BASE_URL",
	"MAESTRO_EVALOPS_BASE_URL",
	"EVALOPS_BASE_URL",
] as const;
const DEFAULT_PROVIDER_REF_PROVIDER = "openai";
const DEFAULT_PROVIDER_REF_ENVIRONMENT = "prod";
const REQUIRED_SCOPE = "llm_gateway:invoke";

interface IdentityStartResponse {
	authorization_url?: string;
	error?: string;
}

interface IdentityRefreshResponse {
	access_token?: string;
	error?: string;
	expires_at?: string;
	organization_id?: string;
	refresh_expires_at?: string;
	refresh_token?: string;
	scopes?: unknown;
}

interface IdentityRevokeResponse {
	error?: string;
	revoked?: boolean;
}

interface IdentityDelegationResponse {
	agent_id?: string;
	error?: string;
	expires_at?: string;
	run_id?: string;
	scopes_denied?: unknown;
	scopes_granted?: unknown;
	scopes_requested?: unknown;
	token?: string;
	token_type?: string;
}

export interface EvalOpsProviderRef {
	provider: string;
	environment: string;
	credential_name?: string;
	team_id?: string;
}

interface EvalOpsCallbackResult {
	accessToken: string;
	expiresAt: number;
	organizationId: string;
	refreshExpiresAt?: number;
	refreshToken?: string;
	scopes: string[];
}

export interface EvalOpsDelegationTokenRequest {
	agentId: string;
	agentType: string;
	capabilities?: string[];
	metadata?: Record<string, unknown>;
	runId: string;
	scopes?: string[];
	surface: string;
	token?: string;
	ttlSeconds?: number;
}

export interface EvalOpsDelegationTokenResult {
	agentId: string;
	expiresAt: number;
	organizationId: string;
	providerRef: EvalOpsProviderRef;
	runId: string;
	scopesDenied: string[];
	scopesGranted: string[];
	scopesRequested: string[];
	token: string;
	tokenType: string;
}

function getEnvValue(names: string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

function normalizeIdentityBaseUrl(
	baseUrl: string,
	suffixes: readonly string[] = [],
): string {
	let normalized = baseUrl.trim().replace(/\/+$/u, "");
	for (const suffix of suffixes) {
		if (normalized.endsWith(suffix)) {
			normalized = normalized.slice(0, -suffix.length).replace(/\/+$/u, "");
		}
	}
	return normalized;
}

function getIdentityBaseUrl(): string {
	return normalizeIdentityBaseUrl(
		getEnvValue([
			...IDENTITY_BASE_URL_ENV_VARS,
			...SHARED_PLATFORM_BASE_URL_ENV_VARS,
		]) ?? DEFAULT_IDENTITY_URL,
		Object.values(PLATFORM_HTTP_ROUTES.identity),
	);
}

function getOrganizationId(): string {
	const organizationId = getEnvValue([
		"MAESTRO_EVALOPS_ORG_ID",
		"EVALOPS_ORGANIZATION_ID",
		"MAESTRO_ENTERPRISE_ORG_ID",
	]);
	if (!organizationId) {
		throw new Error(
			"EvalOps login requires MAESTRO_EVALOPS_ORG_ID or EVALOPS_ORGANIZATION_ID.",
		);
	}
	return organizationId;
}

function getProviderRef(): EvalOpsProviderRef {
	const credentialName = getEnvValue([
		"MAESTRO_EVALOPS_CREDENTIAL_NAME",
		"MAESTRO_LLM_GATEWAY_CREDENTIAL_NAME",
	]);
	const teamID = getEnvValue([
		"MAESTRO_EVALOPS_TEAM_ID",
		"MAESTRO_LLM_GATEWAY_TEAM_ID",
	]);
	return {
		provider:
			getEnvValue([
				"MAESTRO_EVALOPS_PROVIDER",
				"MAESTRO_LLM_GATEWAY_PROVIDER",
			]) ?? DEFAULT_PROVIDER_REF_PROVIDER,
		environment:
			getEnvValue([
				"MAESTRO_EVALOPS_ENVIRONMENT",
				"MAESTRO_LLM_GATEWAY_ENVIRONMENT",
			]) ?? DEFAULT_PROVIDER_REF_ENVIRONMENT,
		...(credentialName ? { credential_name: credentialName } : {}),
		...(teamID ? { team_id: teamID } : {}),
	};
}

function parseExpiresAt(value: string | null): number {
	return parseTimestamp(value, "expires_at");
}

function parseTimestamp(
	value: string | null | undefined,
	fieldName: string,
): number {
	if (!value) {
		throw new Error(`Missing ${fieldName} in EvalOps response`);
	}
	const expiresAt = Date.parse(value);
	if (Number.isNaN(expiresAt)) {
		throw new Error(`Invalid ${fieldName} in EvalOps response: ${value}`);
	}
	return expiresAt;
}

function parseScopes(value: string | null): string[] {
	if (!value) {
		return [REQUIRED_SCOPE];
	}
	return value
		.split(" ")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function parseScopesPayload(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
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
		? value
		: undefined;
}

function getMetadataNumber(
	metadata: Record<string, unknown> | undefined,
	key: string,
): number | undefined {
	const value = metadata?.[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function getMetadataScopes(
	metadata: Record<string, unknown> | undefined,
): string[] {
	return parseScopesPayload(metadata?.scopes);
}

function resolveProviderRef(
	metadata: Record<string, unknown> | undefined,
): EvalOpsProviderRef {
	const fallback = getProviderRef();
	const providerRef = isRecord(metadata?.providerRef)
		? metadata.providerRef
		: undefined;
	return {
		provider: getMetadataString(providerRef, "provider") ?? fallback.provider,
		environment:
			getMetadataString(providerRef, "environment") ?? fallback.environment,
		...(getMetadataString(providerRef, "credential_name")
			? {
					credential_name: getMetadataString(providerRef, "credential_name"),
				}
			: fallback.credential_name
				? { credential_name: fallback.credential_name }
				: {}),
		...(getMetadataString(providerRef, "team_id")
			? { team_id: getMetadataString(providerRef, "team_id") }
			: fallback.team_id
				? { team_id: fallback.team_id }
				: {}),
	};
}

function resolveStoredEvalOpsMetadata(
	metadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (metadata) {
		return metadata;
	}
	const stored = loadOAuthCredentials("evalops");
	return stored?.metadata;
}

function resolveDelegationOrganizationId(
	metadata: Record<string, unknown> | undefined,
): string {
	return getMetadataString(metadata, "organizationId") ?? getOrganizationId();
}

async function getFreshEvalOpsAccessToken(
	metadata?: Record<string, unknown>,
): Promise<string | null> {
	const credentials = loadOAuthCredentials("evalops");
	if (!credentials) {
		return null;
	}
	if (Date.now() < credentials.expires - 60_000) {
		return credentials.access;
	}
	const refreshed = await refreshEvalOpsToken(
		credentials.refresh,
		metadata ?? credentials.metadata,
	);
	saveOAuthCredentials("evalops", refreshed);
	return refreshed.access;
}

export function buildEvalOpsDelegationEnvironment(
	result: Pick<
		EvalOpsDelegationTokenResult,
		"organizationId" | "providerRef" | "token"
	> &
		Partial<Pick<EvalOpsDelegationTokenResult, "agentId" | "runId">>,
): Record<string, string> {
	return {
		MAESTRO_EVALOPS_ACCESS_TOKEN: result.token,
		MAESTRO_EVALOPS_ORG_ID: result.organizationId,
		MAESTRO_EVALOPS_PROVIDER: result.providerRef.provider,
		MAESTRO_EVALOPS_ENVIRONMENT: result.providerRef.environment,
		...(result.agentId
			? {
					MAESTRO_AGENT_ID: result.agentId,
					MAESTRO_EVALOPS_AGENT_ID: result.agentId,
				}
			: {}),
		...(result.runId ? { MAESTRO_EVALOPS_RUN_ID: result.runId } : {}),
		...(result.providerRef.credential_name
			? {
					MAESTRO_EVALOPS_CREDENTIAL_NAME: result.providerRef.credential_name,
				}
			: {}),
		...(result.providerRef.team_id
			? { MAESTRO_EVALOPS_TEAM_ID: result.providerRef.team_id }
			: {}),
	};
}

export async function issueEvalOpsDelegationToken(
	request: EvalOpsDelegationTokenRequest,
): Promise<EvalOpsDelegationTokenResult> {
	const metadata = resolveStoredEvalOpsMetadata(request.metadata);
	const identityBaseUrl =
		getMetadataString(metadata, "identityBaseUrl") ?? getIdentityBaseUrl();
	const token = request.token ?? (await getFreshEvalOpsAccessToken(metadata));
	if (!token) {
		throw new Error(
			"EvalOps delegation requires a valid access token. Run /login evalops first.",
		);
	}
	const response = await fetch(
		`${identityBaseUrl}${PLATFORM_HTTP_ROUTES.identity.delegationTokens}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				agent_id: request.agentId,
				agent_type: request.agentType,
				...(request.capabilities?.length
					? { capabilities: request.capabilities }
					: {}),
				run_id: request.runId,
				...(request.scopes?.length ? { scopes: request.scopes } : {}),
				surface: request.surface,
				...(request.ttlSeconds ? { ttl_seconds: request.ttlSeconds } : {}),
			}),
		},
	);

	let payload: IdentityDelegationResponse | undefined;
	try {
		payload = (await response.json()) as IdentityDelegationResponse;
	} catch {
		// Ignore JSON parse failure and fall back to a generic error below.
	}

	if (!response.ok || !payload?.token || !payload.expires_at) {
		throw new Error(
			payload?.error ?? "EvalOps delegation token request failed",
		);
	}

	return {
		agentId: payload.agent_id ?? request.agentId,
		expiresAt: parseTimestamp(payload.expires_at, "expires_at"),
		organizationId: resolveDelegationOrganizationId(metadata),
		providerRef: resolveProviderRef(metadata),
		runId: payload.run_id ?? request.runId,
		scopesDenied: parseScopesPayload(payload.scopes_denied),
		scopesGranted: parseScopesPayload(payload.scopes_granted),
		scopesRequested: parseScopesPayload(payload.scopes_requested),
		token: payload.token,
		tokenType: payload.token_type ?? "Bearer",
	};
}

async function startCallbackServer(): Promise<{
	server: Server;
	getResult: () => Promise<EvalOpsCallbackResult>;
}> {
	return new Promise((resolve, reject) => {
		let resultResolve: (value: EvalOpsCallbackResult) => void;
		let resultReject: (error: Error) => void;

		const resultPromise = new Promise<EvalOpsCallbackResult>((res, rej) => {
			resultResolve = res;
			resultReject = rej;
		});

		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const requestUrl = new URL(req.url ?? "", CALLBACK_ORIGIN);
			if (requestUrl.pathname !== CALLBACK_PATH) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}

			const error = requestUrl.searchParams.get("error");
			if (error) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(
					`<html><body><h1>EvalOps Login Failed</h1><p>Error: ${error}</p><p>You can close this window.</p></body></html>`,
				);
				resultReject(new Error(`EvalOps identity login failed: ${error}`));
				return;
			}

			const accessToken = requestUrl.searchParams.get("access_token");
			const organizationId = requestUrl.searchParams.get("organization_id");
			if (!accessToken || !organizationId) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(
					"<html><body><h1>Invalid Callback</h1><p>Missing access_token or organization_id.</p><p>You can close this window.</p></body></html>",
				);
				resultReject(
					new Error(
						"EvalOps callback was missing access_token or organization_id.",
					),
				);
				return;
			}

			try {
				const expiresAt = parseExpiresAt(
					requestUrl.searchParams.get("expires_at"),
				);
				const refreshToken =
					requestUrl.searchParams.get("refresh_token")?.trim() || undefined;
				const refreshExpiresAtValue =
					requestUrl.searchParams.get("refresh_expires_at");
				const refreshExpiresAt = refreshExpiresAtValue
					? parseTimestamp(refreshExpiresAtValue, "refresh_expires_at")
					: undefined;
				const scopes = parseScopes(requestUrl.searchParams.get("scope"));

				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(
					"<html><body><h1>Authentication Successful</h1><p>You can close this window and return to Maestro.</p></body></html>",
				);
				resultResolve({
					accessToken,
					expiresAt,
					organizationId,
					refreshExpiresAt,
					refreshToken,
					scopes,
				});
			} catch (error) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(
					`<html><body><h1>Invalid Callback</h1><p>${error instanceof Error ? error.message : String(error)}</p><p>You can close this window.</p></body></html>`,
				);
				resultReject(error instanceof Error ? error : new Error(String(error)));
			}
		});

		server.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EADDRINUSE") {
				reject(
					new Error(
						`Port ${CALLBACK_PORT} is already in use. Close the other process and retry /login evalops.`,
					),
				);
				return;
			}
			reject(error);
		});

		server.listen(CALLBACK_PORT, "127.0.0.1", () => {
			resolve({
				server,
				getResult: () => resultPromise,
			});
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}

async function startIdentityLogin(
	identityBaseUrl: string,
	organizationId: string,
	onStatus?: (status: string) => void,
): Promise<string> {
	onStatus?.("Requesting EvalOps managed login URL...");
	const response = await fetch(
		`${identityBaseUrl}${PLATFORM_HTTP_ROUTES.identity.authGoogleStart}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				redirect_uri: CALLBACK_URI,
				response_mode: "query",
				organization_id: organizationId,
				prompt: "select_account",
				scopes: [REQUIRED_SCOPE],
			}),
		},
	);

	let payload: IdentityStartResponse | undefined;
	try {
		payload = (await response.json()) as IdentityStartResponse;
	} catch {
		// Ignore JSON parse failure and fall back to a generic message below.
	}

	if (!response.ok || !payload?.authorization_url) {
		if (payload?.error === "redirect_uri_not_allowed") {
			throw new Error(
				`Identity rejected ${CALLBACK_URI}. Add it to IDENTITY_GOOGLE_ALLOWED_REDIRECT_URIS and retry.`,
			);
		}
		throw new Error(payload?.error ?? "EvalOps identity start failed");
	}

	return payload.authorization_url;
}

export async function loginEvalOps(
	onAuthUrl: (url: string) => void,
	onStatus?: (status: string) => void,
): Promise<void> {
	const identityBaseUrl = getIdentityBaseUrl();
	const organizationId = getOrganizationId();
	const providerRef = getProviderRef();
	const { server, getResult } = await startCallbackServer();

	try {
		const authorizationUrl = await startIdentityLogin(
			identityBaseUrl,
			organizationId,
			onStatus,
		);
		onStatus?.("Waiting for EvalOps identity callback...");
		onAuthUrl(authorizationUrl);

		const result = await Promise.race([
			getResult(),
			new Promise<EvalOpsCallbackResult>((_, reject) => {
				setTimeout(
					() => reject(new Error("EvalOps login timed out after 5 minutes")),
					5 * 60 * 1000,
				);
			}),
		]);

		const credentials: OAuthCredentials = {
			type: "oauth",
			access: result.accessToken,
			refresh: result.refreshToken ?? "",
			expires: result.expiresAt,
			metadata: {
				identityBaseUrl,
				organizationId: result.organizationId,
				providerRef,
				...(result.refreshExpiresAt
					? { refreshExpiresAt: result.refreshExpiresAt }
					: {}),
				scopes: result.scopes,
			},
		};
		saveOAuthCredentials("evalops", credentials);
		logger.info("EvalOps managed login successful", {
			organizationId: result.organizationId,
			provider: providerRef.provider,
			environment: providerRef.environment,
		});
	} finally {
		await closeServer(server);
	}
}

export async function refreshEvalOpsToken(
	refreshToken: string,
	metadata?: Record<string, unknown>,
): Promise<OAuthCredentials> {
	if (!refreshToken) {
		throw new Error("EvalOps refresh token missing. Run /login evalops again.");
	}

	const identityBaseUrl =
		getMetadataString(metadata, "identityBaseUrl") ?? getIdentityBaseUrl();
	const response = await fetch(
		`${identityBaseUrl}${PLATFORM_HTTP_ROUTES.identity.tokenRefresh}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refresh_token: refreshToken }),
		},
	);

	let payload: IdentityRefreshResponse | undefined;
	try {
		payload = (await response.json()) as IdentityRefreshResponse;
	} catch {
		// Ignore JSON parse failure and surface a generic error below.
	}

	if (!response.ok || !payload?.access_token || !payload.expires_at) {
		throw new Error(payload?.error ?? "EvalOps token refresh failed");
	}

	const expires = parseTimestamp(payload.expires_at, "expires_at");
	const nextRefreshToken =
		typeof payload.refresh_token === "string" &&
		payload.refresh_token.trim().length > 0
			? payload.refresh_token
			: refreshToken;
	const scopes = parseScopesPayload(payload.scopes);
	const refreshExpiresAt =
		payload.refresh_expires_at != null
			? parseTimestamp(payload.refresh_expires_at, "refresh_expires_at")
			: getMetadataNumber(metadata, "refreshExpiresAt");

	return {
		type: "oauth",
		access: payload.access_token,
		refresh: nextRefreshToken,
		expires,
		metadata: {
			...metadata,
			identityBaseUrl,
			organizationId:
				typeof payload.organization_id === "string" &&
				payload.organization_id.length > 0
					? payload.organization_id
					: getMetadataString(metadata, "organizationId"),
			...(refreshExpiresAt ? { refreshExpiresAt } : {}),
			scopes: scopes.length > 0 ? scopes : getMetadataScopes(metadata),
		},
	};
}

export async function revokeEvalOpsToken(
	refreshToken: string,
	metadata?: Record<string, unknown>,
): Promise<void> {
	if (!refreshToken) {
		return;
	}

	const identityBaseUrl =
		getMetadataString(metadata, "identityBaseUrl") ?? getIdentityBaseUrl();
	const response = await fetch(
		`${identityBaseUrl}${PLATFORM_HTTP_ROUTES.identity.tokenRevoke}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refresh_token: refreshToken }),
		},
	);

	let payload: IdentityRevokeResponse | undefined;
	try {
		payload = (await response.json()) as IdentityRevokeResponse;
	} catch {
		// Ignore JSON parse failure and surface a generic error below.
	}

	if (!response.ok) {
		throw new Error(payload?.error ?? "EvalOps token revoke failed");
	}
}
