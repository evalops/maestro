/**
 * Google Gemini CLI OAuth integration (Cloud Code Assist).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	type IncomingMessage,
	type Server,
	type ServerResponse,
	createServer,
} from "node:http";
import { createLogger } from "../utils/logger.js";
import { type OAuthCredentials, saveOAuthCredentials } from "./storage.js";

const logger = createLogger("oauth:google-gemini-cli");

const decodeBase64 = (value: string): string =>
	Buffer.from(value, "base64").toString("utf8");

const CLIENT_ID = decodeBase64(
	"NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t",
);
const CLIENT_SECRET = decodeBase64(
	"R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=",
);
const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

function base64UrlEncode(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function generatePkce(): { verifier: string; challenge: string } {
	const verifier = base64UrlEncode(randomBytes(32));
	const challenge = base64UrlEncode(
		createHash("sha256").update(verifier).digest(),
	);
	return { verifier, challenge };
}

async function startCallbackServer(): Promise<{
	server: Server;
	getCode: () => Promise<{ code: string; state: string }>;
}> {
	return new Promise((resolve, reject) => {
		let codeResolve: (value: { code: string; state: string }) => void;
		let codeReject: (error: Error) => void;

		const codePromise = new Promise<{ code: string; state: string }>(
			(res, rej) => {
				codeResolve = res;
				codeReject = rej;
			},
		);

		const server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url ?? "", REDIRECT_URI);
			if (url.pathname !== "/oauth2callback") {
				res.writeHead(404);
				res.end();
				return;
			}

			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			const error = url.searchParams.get("error");

			if (error) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(
					`<html><body><h1>Authentication Failed</h1><p>Error: ${error}</p><p>You can close this window.</p></body></html>`,
				);
				codeReject(new Error(`OAuth error: ${error}`));
				return;
			}

			if (code && state) {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(
					"<html><body><h1>Authentication Successful</h1><p>You can close this window and return to the terminal.</p></body></html>",
				);
				codeResolve({ code, state });
				return;
			}

			res.writeHead(400, { "Content-Type": "text/html" });
			res.end(
				"<html><body><h1>Authentication Failed</h1><p>Missing code or state parameter.</p></body></html>",
			);
			codeReject(new Error("Missing code or state in callback"));
		});

		server.on("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE") {
				reject(
					new Error(
						"Port 8085 is already in use. Please close the other process and try again.",
					),
				);
				return;
			}
			reject(err);
		});
		server.listen(8085, "127.0.0.1", () => {
			resolve({ server, getCode: () => codePromise });
		});
	});
}

interface LoadCodeAssistPayload {
	cloudaicompanionProject?: string;
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface OnboardUserPayload {
	done?: boolean;
	response?: {
		cloudaicompanionProject?: { id?: string };
	};
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDefaultTierId(
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>,
): string | undefined {
	if (!allowedTiers || allowedTiers.length === 0) return undefined;
	const defaultTier = allowedTiers.find((t) => t.isDefault);
	return defaultTier?.id ?? allowedTiers[0]?.id;
}

async function discoverProject(
	accessToken: string,
	onStatus?: (message: string) => void,
): Promise<string> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "gl-node/22.17.0",
	};

	onStatus?.("Checking for existing Cloud Code Assist project...");
	const loadResponse = await fetch(
		`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				metadata: {
					ideType: "IDE_UNSPECIFIED",
					platform: "PLATFORM_UNSPECIFIED",
					pluginType: "GEMINI",
				},
			}),
		},
	);

	if (loadResponse.ok) {
		const data = (await loadResponse.json()) as LoadCodeAssistPayload;
		if (data.cloudaicompanionProject) {
			return data.cloudaicompanionProject;
		}

		const tierId = getDefaultTierId(data.allowedTiers) ?? "FREE";
		onStatus?.(
			"Provisioning Cloud Code Assist project (this may take a moment)...",
		);

		for (let attempt = 0; attempt < 10; attempt++) {
			const onboardResponse = await fetch(
				`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						tierId,
						metadata: {
							ideType: "IDE_UNSPECIFIED",
							platform: "PLATFORM_UNSPECIFIED",
							pluginType: "GEMINI",
						},
					}),
				},
			);

			if (onboardResponse.ok) {
				const onboardData =
					(await onboardResponse.json()) as OnboardUserPayload;
				const projectId = onboardData.response?.cloudaicompanionProject?.id;
				if (onboardData.done && projectId) {
					return projectId;
				}
			}

			if (attempt < 9) {
				onStatus?.(
					`Waiting for project provisioning (attempt ${attempt + 2}/10)...`,
				);
				await wait(3000);
			}
		}
	}

	throw new Error(
		"Could not discover or provision a Google Cloud project. " +
			"Please ensure you have access to Google Cloud Code Assist (Gemini CLI).",
	);
}

async function getUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetch(
			"https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
			{
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			},
		);

		if (response.ok) {
			const data = (await response.json()) as { email?: string };
			return data.email;
		}
	} catch {
		// Ignore errors, email is optional
	}
	return undefined;
}

export async function refreshGoogleGeminiCliToken(
	refreshToken: string,
	metadata?: Record<string, unknown>,
): Promise<OAuthCredentials> {
	const projectId =
		typeof metadata?.projectId === "string" ? metadata.projectId : undefined;
	if (!projectId) {
		throw new Error("Missing projectId for Google OAuth refresh");
	}

	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Google Cloud token refresh failed: ${error}`);
	}

	const data = (await response.json()) as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	};

	return {
		type: "oauth",
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		metadata: {
			...(metadata ?? {}),
			projectId,
		},
	};
}

export async function loginGoogleGeminiCli(
	onAuthUrl: (url: string) => void,
	onStatus?: (status: string) => void,
): Promise<void> {
	const { verifier, challenge } = generatePkce();

	onStatus?.("Starting local server for OAuth callback...");
	const { server, getCode } = await startCallbackServer();

	try {
		const authParams = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES.join(" "),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});

		const authUrl = `${AUTH_URL}?${authParams.toString()}`;
		onAuthUrl(authUrl);

		onStatus?.("Waiting for OAuth callback...");
		const { code, state } = await getCode();
		if (!timingSafeEqual(Buffer.from(state), Buffer.from(verifier))) {
			throw new Error("OAuth state mismatch - possible CSRF attack");
		}

		onStatus?.("Exchanging authorization code for tokens...");
		const tokenResponse = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				code,
				grant_type: "authorization_code",
				redirect_uri: REDIRECT_URI,
				code_verifier: verifier,
			}),
		});

		if (!tokenResponse.ok) {
			const error = await tokenResponse.text();
			throw new Error(`Token exchange failed: ${error}`);
		}

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		if (!tokenData.refresh_token) {
			throw new Error("No refresh token received. Please try again.");
		}

		onStatus?.("Getting user info...");
		const email = await getUserEmail(tokenData.access_token);
		const projectId = await discoverProject(tokenData.access_token, onStatus);

		const credentials: OAuthCredentials = {
			type: "oauth",
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			metadata: {
				projectId,
				email,
			},
		};

		saveOAuthCredentials("google-gemini-cli", credentials);
		logger.info("Google Gemini CLI OAuth login successful");
	} finally {
		server.close();
	}
}
