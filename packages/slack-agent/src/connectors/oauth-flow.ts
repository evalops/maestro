/**
 * OAuth Flow - Handles OAuth2 authorization code flow for connectors.
 *
 * Starts an HTTP server to receive the OAuth callback, exchanges the code
 * for tokens, and stores the credentials via CredentialManager.
 */

import { randomUUID } from "node:crypto";
import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import * as logger from "../logger.js";
import type { CredentialManager } from "./credentials.js";
import type { ConnectorCredentials } from "./types.js";

export interface OAuthFlowConfig {
	clientId: string;
	clientSecret: string;
	authorizeUrl: string;
	tokenUrl: string;
	scopes: string[];
	/** Callback port (default: 3456) */
	callbackPort?: number;
	/** Callback path (default: /oauth/callback) */
	callbackPath?: string;
}

export interface OAuthFlowResult {
	accessToken: string;
	refreshToken?: string;
	expiresIn?: number;
	tokenType?: string;
}

interface PendingFlow {
	connectorName: string;
	state: string;
	config: OAuthFlowConfig;
	resolve: (result: OAuthFlowResult) => void;
	reject: (error: Error) => void;
}

export class OAuthFlowManager {
	private credentialManager: CredentialManager;
	private pendingFlows = new Map<string, PendingFlow>();
	private server: ReturnType<typeof createServer> | null = null;
	private port: number;
	private path: string;

	constructor(
		credentialManager: CredentialManager,
		port = 3456,
		path = "/oauth/callback",
	) {
		this.credentialManager = credentialManager;
		this.port = port;
		this.path = path;
	}

	/**
	 * Start an OAuth flow. Returns the authorization URL for the user to visit.
	 */
	startFlow(
		connectorName: string,
		config: OAuthFlowConfig,
	): { authUrl: string; promise: Promise<OAuthFlowResult> } {
		const state = randomUUID();
		const callbackUrl = `http://localhost:${config.callbackPort ?? this.port}${config.callbackPath ?? this.path}`;

		const params = new URLSearchParams({
			client_id: config.clientId,
			redirect_uri: callbackUrl,
			response_type: "code",
			scope: config.scopes.join(" "),
			state,
		});

		const authUrl = `${config.authorizeUrl}?${params}`;

		const promise = new Promise<OAuthFlowResult>((resolve, reject) => {
			this.pendingFlows.set(state, {
				connectorName,
				state,
				config,
				resolve,
				reject,
			});

			setTimeout(
				() => {
					if (this.pendingFlows.has(state)) {
						this.pendingFlows.delete(state);
						reject(new Error("OAuth flow timed out after 5 minutes"));
					}
				},
				5 * 60 * 1000,
			);
		});

		this.ensureServer();

		return { authUrl, promise };
	}

	/**
	 * Ensure the callback server is running.
	 */
	private ensureServer(): void {
		if (this.server) return;

		this.server = createServer(
			async (req: IncomingMessage, res: ServerResponse) => {
				try {
					if (!req.url?.startsWith(this.path)) {
						res.writeHead(404);
						res.end("Not found");
						return;
					}

					const url = new URL(req.url, `http://localhost:${this.port}`);
					const code = url.searchParams.get("code");
					const state = url.searchParams.get("state");
					const error = url.searchParams.get("error");

					if (error) {
						const pending = state ? this.pendingFlows.get(state) : null;
						if (pending) {
							pending.reject(new Error(`OAuth error: ${error}`));
							this.pendingFlows.delete(state!);
						}
						res.writeHead(200, { "Content-Type": "text/html" });
						res.end(
							"<html><body><h2>Authorization failed</h2><p>You can close this window.</p></body></html>",
						);
						return;
					}

					if (!code || !state) {
						res.writeHead(400);
						res.end("Missing code or state parameter");
						return;
					}

					const pending = this.pendingFlows.get(state);
					if (!pending) {
						res.writeHead(400);
						res.end("Invalid or expired state");
						return;
					}

					this.pendingFlows.delete(state);

					const callbackUrl = `http://localhost:${pending.config.callbackPort ?? this.port}${pending.config.callbackPath ?? this.path}`;

					const tokenResponse = await fetch(pending.config.tokenUrl, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							grant_type: "authorization_code",
							code,
							redirect_uri: callbackUrl,
							client_id: pending.config.clientId,
							client_secret: pending.config.clientSecret,
						}),
						signal: AbortSignal.timeout(30_000),
					});

					if (!tokenResponse.ok) {
						const text = await tokenResponse.text();
						pending.reject(
							new Error(
								`Token exchange failed: ${tokenResponse.status} ${text}`,
							),
						);
						res.writeHead(200, { "Content-Type": "text/html" });
						res.end(
							"<html><body><h2>Token exchange failed</h2><p>Check the agent logs.</p></body></html>",
						);
						return;
					}

					const tokens = (await tokenResponse.json()) as {
						access_token: string;
						refresh_token?: string;
						expires_in?: number;
						token_type?: string;
					};

					const creds: ConnectorCredentials = {
						type: "oauth",
						secret: tokens.access_token,
						metadata: {
							...(tokens.refresh_token
								? { refreshToken: tokens.refresh_token }
								: {}),
							...(tokens.expires_in
								? { expiresIn: String(tokens.expires_in) }
								: {}),
							tokenType: tokens.token_type ?? "Bearer",
						},
					};
					await this.credentialManager.set(pending.connectorName, creds);

					const result: OAuthFlowResult = {
						accessToken: tokens.access_token,
						refreshToken: tokens.refresh_token,
						expiresIn: tokens.expires_in,
						tokenType: tokens.token_type,
					};
					pending.resolve(result);

					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						"<html><body><h2>Authorization successful!</h2><p>You can close this window and return to Slack.</p></body></html>",
					);
				} catch (error) {
					logger.logWarning(
						"OAuth callback error",
						error instanceof Error ? error.message : String(error),
					);
					res.writeHead(500);
					res.end("Internal error");
				}
			},
		);

		this.server.listen(this.port, () => {
			logger.logInfo(`OAuth callback server listening on port ${this.port}`);
		});
	}

	async stop(): Promise<void> {
		if (this.server) {
			return new Promise((resolve, reject) => {
				this.server!.close((err) => {
					this.server = null;
					if (err) reject(err);
					else resolve();
				});
			});
		}
	}

	/**
	 * Refresh an OAuth token using the stored refresh_token.
	 */
	async refreshToken(
		connectorName: string,
		config: Pick<OAuthFlowConfig, "clientId" | "clientSecret" | "tokenUrl">,
	): Promise<ConnectorCredentials | null> {
		const existing = await this.credentialManager.get(connectorName);
		if (!existing?.metadata?.refreshToken) return null;

		try {
			const response = await fetch(config.tokenUrl, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: existing.metadata.refreshToken,
					client_id: config.clientId,
					client_secret: config.clientSecret,
				}),
				signal: AbortSignal.timeout(30_000),
			});

			if (!response.ok) return null;

			const tokens = (await response.json()) as {
				access_token: string;
				refresh_token?: string;
				expires_in?: number;
			};

			const creds: ConnectorCredentials = {
				type: "oauth",
				secret: tokens.access_token,
				metadata: {
					refreshToken: tokens.refresh_token ?? existing.metadata.refreshToken,
					...(tokens.expires_in
						? { expiresIn: String(tokens.expires_in) }
						: {}),
					tokenType: existing.metadata.tokenType ?? "Bearer",
				},
			};

			await this.credentialManager.set(connectorName, creds);
			return creds;
		} catch (error) {
			logger.logWarning(
				`Token refresh failed for ${connectorName}`,
				error instanceof Error ? error.message : String(error),
			);
			return null;
		}
	}
}
