import {
	type IncomingMessage,
	type Server,
	type ServerResponse,
	createServer,
} from "node:http";
import { createLogger } from "../utils/logger.js";
import { type OAuthCredentials, saveOAuthCredentials } from "./storage.js";

const logger = createLogger("oauth:evalops");

const CALLBACK_PORT = 1460;
const CALLBACK_PATH = "/auth/callback/evalops";
const CALLBACK_ORIGIN = `http://127.0.0.1:${CALLBACK_PORT}`;
const CALLBACK_URI = `${CALLBACK_ORIGIN}${CALLBACK_PATH}`;
const DEFAULT_IDENTITY_URL = "http://127.0.0.1:8080";
const DEFAULT_PROVIDER_REF_PROVIDER = "openai";
const DEFAULT_PROVIDER_REF_ENVIRONMENT = "prod";
const REQUIRED_SCOPE = "llm_gateway:invoke";

interface IdentityStartResponse {
	authorization_url?: string;
	error?: string;
}

interface EvalOpsProviderRef {
	provider: string;
	environment: string;
	credential_name?: string;
	team_id?: string;
}

interface EvalOpsCallbackResult {
	accessToken: string;
	expiresAt: number;
	organizationId: string;
	scopes: string[];
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

function getIdentityBaseUrl(): string {
	return (
		getEnvValue(["MAESTRO_IDENTITY_URL", "EVALOPS_IDENTITY_URL"]) ??
		DEFAULT_IDENTITY_URL
	).replace(/\/+$/, "");
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
	if (!value) {
		throw new Error("Missing expires_at in EvalOps callback");
	}
	const expiresAt = Date.parse(value);
	if (Number.isNaN(expiresAt)) {
		throw new Error(`Invalid expires_at in EvalOps callback: ${value}`);
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
				const scopes = parseScopes(requestUrl.searchParams.get("scope"));

				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(
					"<html><body><h1>Authentication Successful</h1><p>You can close this window and return to Maestro.</p></body></html>",
				);
				resultResolve({
					accessToken,
					expiresAt,
					organizationId,
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
	const response = await fetch(`${identityBaseUrl}/v1/auth/google/start`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			redirect_uri: CALLBACK_URI,
			response_mode: "query",
			organization_id: organizationId,
			prompt: "select_account",
			scopes: [REQUIRED_SCOPE],
		}),
	});

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
			refresh: "",
			expires: result.expiresAt,
			metadata: {
				identityBaseUrl,
				organizationId: result.organizationId,
				providerRef,
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

export async function refreshEvalOpsToken(): Promise<OAuthCredentials> {
	throw new Error(
		"EvalOps managed tokens do not support refresh yet. Run /login evalops again.",
	);
}
