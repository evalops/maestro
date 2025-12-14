/**
 * OAuth Installation Flow - Multi-workspace support for Slack Agent
 *
 * Provides OAuth 2.0 installation flow for self-hosted deployments
 * that want to support multiple Slack workspaces.
 *
 * Usage:
 * 1. Run the OAuth server: startOAuthServer(config)
 * 2. Direct users to: /slack/install
 * 3. After installation, tokens are saved to workspaces.json
 * 4. Use WorkspaceManager to load workspace tokens
 */

import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import { join } from "node:path";
import * as logger from "./logger.js";
import { FileStorageBackend, type StorageBackend } from "./storage.js";

// ============================================================================
// Types
// ============================================================================

export interface OAuthConfig {
	clientId: string;
	clientSecret: string;
	signingSecret?: string;
	scopes?: string[];
	redirectUri?: string;
	stateSecret?: string;
	port?: number;
}

export interface WorkspaceCredentials {
	id: string;
	teamId: string;
	teamName: string;
	botToken: string;
	botUserId: string;
	accessToken?: string;
	installedBy: string;
	installedAt: string;
	status: "active" | "suspended" | "uninstalled";
}

interface OAuthState {
	nonce: string;
	timestamp: number;
}

interface SlackOAuthResponse {
	ok: boolean;
	error?: string;
	app_id: string;
	authed_user: {
		id: string;
		access_token?: string;
	};
	access_token: string;
	bot_user_id: string;
	team: {
		id: string;
		name: string;
	};
}

// ============================================================================
// Default Scopes
// ============================================================================

export const DEFAULT_BOT_SCOPES = [
	"chat:write",
	"chat:write.public",
	"im:write",
	"im:history",
	"im:read",
	"channels:history",
	"channels:read",
	"groups:history",
	"groups:read",
	"mpim:history",
	"mpim:read",
	"users:read",
	"files:read",
	"files:write",
	"reactions:read",
	"reactions:write",
	"app_mentions:read",
	"commands",
];

// ============================================================================
// State Management
// ============================================================================

const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/**
 * OAuth State Manager - Handles state tokens for OAuth flow
 * Supports pluggable storage backends for multi-instance deployments
 */
class OAuthStateManager {
	constructor(private storage: StorageBackend) {}

	private getKey(token: string): string {
		return `oauth-state:${token}`;
	}

	async generateStateToken(secret: string): Promise<string> {
		const state: OAuthState = {
			nonce: crypto.randomBytes(16).toString("hex"),
			timestamp: Date.now(),
		};

		const payload = JSON.stringify(state);
		const signature = crypto
			.createHmac("sha256", secret)
			.update(payload)
			.digest("hex");

		const token = Buffer.from(JSON.stringify({ payload, signature })).toString(
			"base64url",
		);

		// Store state with TTL using atomic setNX to prevent race conditions
		const stored = await this.storage.setNX(
			this.getKey(token),
			{ state, createdAt: Date.now() },
			STATE_EXPIRY_MS,
		);

		if (!stored) {
			// Extremely rare collision - regenerate
			return this.generateStateToken(secret);
		}

		return token;
	}

	async verifyStateToken(secret: string, token: string): Promise<boolean> {
		const key = this.getKey(token);
		const pending = await this.storage.get<{
			state: OAuthState;
			createdAt: number;
		}>(key);

		if (!pending) {
			return false; // Not found or expired (TTL handled by storage)
		}

		try {
			const { payload, signature } = JSON.parse(
				Buffer.from(token, "base64url").toString(),
			);
			const expectedSignature = crypto
				.createHmac("sha256", secret)
				.update(payload)
				.digest("hex");

			const valid = crypto.timingSafeEqual(
				Buffer.from(signature, "hex"),
				Buffer.from(expectedSignature, "hex"),
			);

			if (valid) {
				// One-time use - delete after verification
				await this.storage.delete(key);
			}

			return valid;
		} catch {
			return false;
		}
	}
}

// ============================================================================
// WorkspaceManager Class
// ============================================================================

export class WorkspaceManager {
	private workspacesPath: string;
	private workspaces: Map<string, WorkspaceCredentials> = new Map();

	constructor(workingDir: string) {
		this.workspacesPath = join(workingDir, "workspaces.json");
		this.load();
	}

	private load(): void {
		if (!existsSync(this.workspacesPath)) {
			return;
		}

		try {
			const content = readFileSync(this.workspacesPath, "utf-8");
			const data = JSON.parse(content) as WorkspaceCredentials[];
			for (const ws of data) {
				this.workspaces.set(ws.teamId, ws);
			}
		} catch (error) {
			logger.logWarning("Failed to load workspaces", String(error));
		}
	}

	private save(): void {
		const data = Array.from(this.workspaces.values());
		writeFileSync(this.workspacesPath, JSON.stringify(data, null, 2));
	}

	/**
	 * Add or update a workspace
	 */
	upsert(credentials: WorkspaceCredentials): void {
		this.workspaces.set(credentials.teamId, credentials);
		this.save();
		logger.logInfo(
			`Workspace saved: ${credentials.teamName} (${credentials.teamId})`,
		);
	}

	/**
	 * Get workspace by team ID
	 */
	get(teamId: string): WorkspaceCredentials | undefined {
		return this.workspaces.get(teamId);
	}

	/**
	 * Get all active workspaces
	 */
	getAll(): WorkspaceCredentials[] {
		return Array.from(this.workspaces.values()).filter(
			(ws) => ws.status === "active",
		);
	}

	/**
	 * Mark workspace as uninstalled
	 */
	markUninstalled(teamId: string): void {
		const ws = this.workspaces.get(teamId);
		if (ws) {
			ws.status = "uninstalled";
			this.save();
			logger.logInfo(`Workspace marked uninstalled: ${teamId}`);
		}
	}

	/**
	 * Remove a workspace
	 */
	remove(teamId: string): boolean {
		const deleted = this.workspaces.delete(teamId);
		if (deleted) {
			this.save();
		}
		return deleted;
	}
}

// ============================================================================
// OAuth Server
// ============================================================================

export interface OAuthServerConfig extends OAuthConfig {
	workingDir: string;
	onInstall?: (workspace: WorkspaceCredentials) => void;
	/** Custom storage backend for OAuth state (enables multi-instance deployments) */
	storage?: StorageBackend;
}

/**
 * Start a simple OAuth installation server
 */
export function startOAuthServer(config: OAuthServerConfig): {
	server: ReturnType<typeof createServer>;
	stop: () => void;
} {
	const {
		clientId,
		clientSecret,
		scopes = DEFAULT_BOT_SCOPES,
		port = 3000,
		workingDir,
		onInstall,
	} = config;

	const stateSecret =
		config.stateSecret ?? crypto.randomBytes(32).toString("hex");
	const redirectUri =
		config.redirectUri ?? `http://localhost:${port}/slack/callback`;

	// Ensure working directory exists
	if (!existsSync(workingDir)) {
		mkdirSync(workingDir, { recursive: true });
	}

	// Use provided storage or default to file-based for OAuth state
	const stateStorage =
		config.storage ?? new FileStorageBackend(join(workingDir, "oauth-state"));
	const stateManager = new OAuthStateManager(stateStorage);

	const workspaceManager = new WorkspaceManager(workingDir);

	const server = createServer(
		async (req: IncomingMessage, res: ServerResponse) => {
			const url = new URL(req.url ?? "/", `http://localhost:${port}`);

			// Install redirect
			if (url.pathname === "/slack/install") {
				const state = await stateManager.generateStateToken(stateSecret);
				const installUrl = new URL("https://slack.com/oauth/v2/authorize");
				installUrl.searchParams.set("client_id", clientId);
				installUrl.searchParams.set("scope", scopes.join(","));
				installUrl.searchParams.set("redirect_uri", redirectUri);
				installUrl.searchParams.set("state", state);

				res.writeHead(302, { Location: installUrl.toString() });
				res.end();
				return;
			}

			// OAuth callback
			if (url.pathname === "/slack/callback") {
				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					// Escape HTML to prevent XSS
					const safeError = error
						.replace(/&/g, "&amp;")
						.replace(/</g, "&lt;")
						.replace(/>/g, "&gt;")
						.replace(/"/g, "&quot;");
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(`<h1>Installation cancelled</h1><p>${safeError}</p>`);
					return;
				}

				const validState =
					state && (await stateManager.verifyStateToken(stateSecret, state));
				if (!code || !validState) {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(
						"<h1>Invalid request</h1><p>State token invalid or expired.</p>",
					);
					return;
				}

				try {
					// Exchange code for tokens
					const tokenResponse = await fetch(
						"https://slack.com/api/oauth.v2.access",
						{
							method: "POST",
							headers: { "Content-Type": "application/x-www-form-urlencoded" },
							body: new URLSearchParams({
								client_id: clientId,
								client_secret: clientSecret,
								code,
								redirect_uri: redirectUri,
							}).toString(),
						},
					);

					const data = (await tokenResponse.json()) as SlackOAuthResponse;

					if (!data.ok) {
						throw new Error(data.error ?? "Token exchange failed");
					}

					// Save workspace
					const credentials: WorkspaceCredentials = {
						id: crypto.randomUUID(),
						teamId: data.team.id,
						teamName: data.team.name,
						botToken: data.access_token,
						botUserId: data.bot_user_id,
						accessToken: data.authed_user.access_token,
						installedBy: data.authed_user.id,
						installedAt: new Date().toISOString(),
						status: "active",
					};

					workspaceManager.upsert(credentials);

					if (onInstall) {
						onInstall(credentials);
					}

					// Escape team name to prevent XSS
					const safeTeamName = data.team.name
						.replace(/&/g, "&amp;")
						.replace(/</g, "&lt;")
						.replace(/>/g, "&gt;")
						.replace(/"/g, "&quot;");
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(`
					<h1>Installation successful!</h1>
					<p>Workspace: <strong>${safeTeamName}</strong></p>
					<p>The bot has been added to your workspace.</p>
					<p>You can close this window.</p>
				`);
				} catch (err) {
					logger.logWarning("OAuth callback failed", String(err));
					// Escape error to prevent XSS
					const safeErr = String(err)
						.replace(/&/g, "&amp;")
						.replace(/</g, "&lt;")
						.replace(/>/g, "&gt;")
						.replace(/"/g, "&quot;");
					res.writeHead(500, { "Content-Type": "text/html" });
					res.end(`<h1>Installation failed</h1><p>${safeErr}</p>`);
				}
				return;
			}

			// Health check
			if (url.pathname === "/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "ok" }));
				return;
			}

			// 404
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found");
		},
	);

	server.listen(port, () => {
		logger.logInfo(
			`OAuth server started: http://localhost:${port}/slack/install`,
		);
	});

	return {
		server,
		stop: () => {
			server.close();
			logger.logInfo("OAuth server stopped");
		},
	};
}

// ============================================================================
// Signature Verification (for HTTP mode)
// ============================================================================

/**
 * Verify Slack request signature (for HTTP webhook mode)
 */
export function verifySlackSignature(
	signingSecret: string,
	signature: string,
	timestamp: string,
	body: string,
): boolean {
	// Check timestamp (prevent replay attacks)
	const requestTime = Number.parseInt(timestamp, 10);
	const now = Math.floor(Date.now() / 1000);
	if (Math.abs(now - requestTime) > 300) {
		return false;
	}

	// Compute expected signature
	const sigBasestring = `v0:${timestamp}:${body}`;
	const expectedSignature = `v0=${crypto
		.createHmac("sha256", signingSecret)
		.update(sigBasestring)
		.digest("hex")}`;

	try {
		return crypto.timingSafeEqual(
			Buffer.from(signature),
			Buffer.from(expectedSignature),
		);
	} catch {
		return false;
	}
}
