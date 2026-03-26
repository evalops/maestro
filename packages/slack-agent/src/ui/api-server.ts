/**
 * API Server - HTTP endpoints backing the React UI.
 *
 * Provides CRUD for dashboards, connectors, triggers, and Slack OAuth installs.
 * Designed to run on SLACK_AGENT_UI_PORT (default: 3200).
 */

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import { join, resolve, sep } from "node:path";
import {
	Agent,
	type Api,
	type Model,
	ProviderTransport,
	getModel,
} from "@evalops/ai";
import { WebClient } from "@slack/web-api";
import { ConnectorManager } from "../connectors/connector-manager.js";
import { CredentialManager } from "../connectors/credentials.js";
import { registerBuiltInConnectors } from "../connectors/index.js";
import { createConnectorRegistry } from "../connectors/index.js";
import { getRegisteredTypes } from "../connectors/registry.js";
import { WebhookTriggerManager } from "../connectors/webhook-triggers.js";
import type { DashboardSpec } from "../dashboard/types.js";
import * as logger from "../logger.js";
import {
	DEFAULT_BOT_SCOPES,
	type WorkspaceCredentials,
	WorkspaceManager,
} from "../oauth.js";
import { PermissionManager, type SlackRole } from "../permissions.js";
import { FileStorageBackend, type StorageBackend } from "../storage.js";
import {
	type DashboardEntry,
	DashboardRegistry,
	type DashboardVisibility,
} from "./dashboard-registry.js";

export interface ApiServerConfig {
	port: number;
	/** Root working dir for the slack-agent instance (per-workspace state lives under workspaces/<teamId>/...) */
	workingDir: string;
	/** Optional shared WorkspaceManager instance (useful when embedding alongside the Slack runtime). */
	workspaceManager?: WorkspaceManager;
	/** Path to the built React UI assets (optional, serves static files if set) */
	staticDir?: string;
	/** Bind address (default: "127.0.0.1" — localhost only) */
	host?: string;
	/** Bearer token required for all API requests (set via SLACK_AGENT_UI_TOKEN) */
	authToken?: string;
	/** Optional Slack OAuth config for in-UI installation flow */
	slackOAuth?: {
		clientId: string;
		clientSecret: string;
		scopes?: string[];
		redirectUri?: string;
		stateSecret?: string;
	};
}

export interface ApiServerInstance {
	start(): Promise<void>;
	stop(): Promise<void>;
}

interface OAuthState {
	nonce: string;
	timestamp: number;
}

const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const LOGIN_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DASHBOARD_DEFAULT_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

const SESSION_COOKIE_NAME = "slack_agent_ui_session";

function sha256(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex");
}

function parseCookies(header: string | undefined): Record<string, string> {
	if (!header) return {};
	const out: Record<string, string> = {};
	for (const part of header.split(";")) {
		const [rawKey, ...rawVal] = part.trim().split("=");
		if (!rawKey) continue;
		out[rawKey] = decodeURIComponent(rawVal.join("=") ?? "");
	}
	return out;
}

function setCookie(
	res: ServerResponse,
	name: string,
	value: string,
	options: {
		httpOnly?: boolean;
		maxAgeSeconds?: number;
		path?: string;
		sameSite?: "Lax" | "Strict" | "None";
		secure?: boolean;
	} = {},
): void {
	const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
	parts.push(`Path=${options.path ?? "/"}`);
	if (options.maxAgeSeconds != null)
		parts.push(`Max-Age=${options.maxAgeSeconds}`);
	if (options.httpOnly ?? true) parts.push("HttpOnly");
	parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
	if (options.secure) parts.push("Secure");
	res.setHeader("Set-Cookie", parts.join("; "));
}

type UiSession = {
	id: string;
	createdAt: string;
	teams: Record<
		string,
		{
			userId: string;
			role: SlackRole;
			updatedAt: string;
		}
	>;
};

type LoginCodeRecord = {
	codeHash: string;
	createdAt: string;
};

class UiSessionManager {
	constructor(private storage: StorageBackend) {}

	private sessionKey(sessionId: string): string {
		return `ui-session:${sessionId}`;
	}
	private loginCodeKey(teamId: string, userId: string): string {
		return `ui-login-code:${teamId}:${userId}`;
	}

	async getSession(sessionId: string): Promise<UiSession | null> {
		return this.storage.get<UiSession>(this.sessionKey(sessionId));
	}

	async saveSession(session: UiSession): Promise<void> {
		await this.storage.set(
			this.sessionKey(session.id),
			session,
			SESSION_TTL_MS,
		);
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.storage.delete(this.sessionKey(sessionId));
	}

	async setLoginCode(
		teamId: string,
		userId: string,
		code: string,
	): Promise<void> {
		const record: LoginCodeRecord = {
			codeHash: sha256(code),
			createdAt: new Date().toISOString(),
		};
		await this.storage.set(
			this.loginCodeKey(teamId, userId),
			record,
			LOGIN_CODE_TTL_MS,
		);
	}

	async verifyLoginCode(
		teamId: string,
		userId: string,
		code: string,
	): Promise<boolean> {
		const key = this.loginCodeKey(teamId, userId);
		const record = await this.storage.get<LoginCodeRecord>(key);
		if (!record) return false;
		const ok = sha256(code) === record.codeHash;
		if (ok) await this.storage.delete(key);
		return ok;
	}
}

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

		const stored = await this.storage.setNX(
			this.getKey(token),
			{ state, createdAt: Date.now() },
			STATE_EXPIRY_MS,
		);
		if (!stored) {
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
		if (!pending) return false;

		try {
			const parsed = JSON.parse(Buffer.from(token, "base64url").toString()) as {
				payload: string;
				signature: string;
			};
			const expectedSignature = crypto
				.createHmac("sha256", secret)
				.update(parsed.payload)
				.digest("hex");

			const valid = crypto.timingSafeEqual(
				Buffer.from(parsed.signature, "hex"),
				Buffer.from(expectedSignature, "hex"),
			);

			if (valid) {
				await this.storage.delete(key);
			}

			return valid;
		} catch {
			return false;
		}
	}
}

interface SlackOAuthResponse {
	ok: boolean;
	error?: string;
	authed_user: { id: string; access_token?: string };
	access_token: string;
	bot_user_id: string;
	team: { id: string; name: string };
}

function sanitizeWorkspaces(
	workspaces: WorkspaceCredentials[],
): Array<Omit<WorkspaceCredentials, "botToken" | "accessToken">> {
	return workspaces.map((ws) => {
		// Never return tokens to the browser UI.
		const { botToken: _botToken, accessToken: _accessToken, ...rest } = ws;
		void _botToken;
		void _accessToken;
		return rest;
	});
}

function isSafePathSegment(value: string): boolean {
	// No slashes, no traversal, and only typical Slack ID charset.
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
	if (value.includes("..")) return false;
	return true;
}

export function createApiServer(config: ApiServerConfig): ApiServerInstance {
	const {
		port,
		workingDir,
		staticDir,
		host = "127.0.0.1",
		authToken,
		slackOAuth,
		workspaceManager: injectedWorkspaceManager,
	} = config;

	// Ensure connector types are available for /connectors/types in standalone UI mode.
	registerBuiltInConnectors();

	const workspaceManager =
		injectedWorkspaceManager ?? new WorkspaceManager(workingDir);
	const oauthStateStorage = new FileStorageBackend(
		join(workingDir, "oauth-state"),
	);
	const oauthStateManager = new OAuthStateManager(oauthStateStorage);
	const sessionStorage = new FileStorageBackend(
		join(workingDir, "ui-sessions"),
	);
	const sessionManager = new UiSessionManager(sessionStorage);
	const oauthStateSecret =
		slackOAuth?.stateSecret ?? crypto.randomBytes(32).toString("hex");
	const oauthScopes = slackOAuth?.scopes?.length
		? slackOAuth.scopes
		: DEFAULT_BOT_SCOPES;
	const oauthRedirectUri =
		slackOAuth?.redirectUri ?? `http://localhost:${port}/slack/callback`;

	type WorkspaceServices = {
		workspaceDir: string;
		credentialManager: CredentialManager;
		connectorManager: ConnectorManager;
		triggerManager: WebhookTriggerManager;
		dashboardRegistry: DashboardRegistry;
		permissionManager: PermissionManager;
	};

	const workspaceServices = new Map<string, WorkspaceServices>();
	const inflightDashboardRenders = new Map<
		string,
		Promise<{ spec: DashboardSpec; renderedAt: string; fromCache: boolean }>
	>();

	function getWorkspaceServices(teamId: string): WorkspaceServices | null {
		if (!isSafePathSegment(teamId)) return null;
		const installed = workspaceManager.get(teamId);
		if (!installed) return null;

		const cached = workspaceServices.get(teamId);
		if (cached) return cached;

		const workspaceDir = join(workingDir, "workspaces", teamId);
		const credentialStorage = new FileStorageBackend(
			join(workspaceDir, ".credentials"),
		);
		const credentialManager = new CredentialManager(credentialStorage);
		const connectorManager = new ConnectorManager({
			workingDir: workspaceDir,
			credentialManager,
		});
		const triggerManager = new WebhookTriggerManager(workspaceDir);
		const dashboardRegistry = new DashboardRegistry(workspaceDir);
		const permissionManager = new PermissionManager(workspaceDir);

		const services: WorkspaceServices = {
			workspaceDir,
			credentialManager,
			connectorManager,
			triggerManager,
			dashboardRegistry,
			permissionManager,
		};
		workspaceServices.set(teamId, services);
		return services;
	}

	function getBearerTokenOk(req: IncomingMessage): boolean {
		if (!authToken) return false;
		const authHeader = req.headers.authorization ?? "";
		return authHeader === `Bearer ${authToken}`;
	}

	async function getSession(req: IncomingMessage): Promise<UiSession | null> {
		const cookies = parseCookies(req.headers.cookie);
		const sessionId = cookies[SESSION_COOKIE_NAME];
		if (!sessionId) return null;
		return sessionManager.getSession(sessionId);
	}

	function getWorkspaceSession(
		session: UiSession | null,
		teamId: string,
	): { userId: string; role: SlackRole } | null {
		if (!session) return null;
		const entry = session.teams[teamId];
		if (!entry) return null;
		return { userId: entry.userId, role: entry.role };
	}

	function roleAtLeast(role: SlackRole, min: SlackRole): boolean {
		const rank: Record<SlackRole, number> = {
			viewer: 0,
			user: 1,
			power_user: 2,
			admin: 3,
		};
		return rank[role] >= rank[min];
	}

	function getDashboardOwnerId(entry: DashboardEntry): string | null {
		return entry.createdBy ?? entry.definition?.createdBy ?? null;
	}

	function getDashboardVisibility(entry: DashboardEntry): DashboardVisibility {
		// Backward compat: dashboards created before visibility existed are treated as shared.
		return entry.visibility ?? "shared";
	}

	function canViewDashboard(
		entry: DashboardEntry,
		authz: { userId: string | null; role: SlackRole | null; bearer: boolean },
	): boolean {
		if (authz.bearer) return true;
		if (!authz.userId || !authz.role) return true;
		if (authz.role === "admin" || authz.role === "power_user") return true;
		if (getDashboardVisibility(entry) === "shared") return true;
		const owner = getDashboardOwnerId(entry);
		return !!owner && owner === authz.userId;
	}

	function canDeleteDashboard(
		entry: DashboardEntry,
		authz: { userId: string | null; role: SlackRole | null; bearer: boolean },
	): boolean {
		if (authz.bearer) return true;
		if (!authz.userId || !authz.role) return true;
		if (authz.role === "admin" || authz.role === "power_user") return true;
		const owner = getDashboardOwnerId(entry);
		return !!owner && owner === authz.userId;
	}

	async function requireWorkspaceAuth(opts: {
		req: IncomingMessage;
		res: ServerResponse;
		teamId: string;
		minRole: SlackRole;
	}): Promise<
		| {
				ok: true;
				userId: string | null;
				role: SlackRole | null;
				bearer: boolean;
		  }
		| { ok: false }
	> {
		// Local/dev mode: if no bearer token is configured, treat the UI API as open.
		if (!authToken) {
			return { ok: true, userId: null, role: null, bearer: true };
		}

		const bearerOk = getBearerTokenOk(opts.req);
		if (bearerOk) {
			return { ok: true, userId: null, role: null, bearer: true };
		}

		const session = await getSession(opts.req);
		const ws = getWorkspaceSession(session, opts.teamId);
		if (!ws) {
			jsonError(opts.res, 401, "Unauthorized");
			return { ok: false };
		}

		const services = getWorkspaceServices(opts.teamId);
		if (!services) {
			jsonError(opts.res, 404, "Workspace not found");
			return { ok: false };
		}

		const perms = services.permissionManager.getUser(ws.userId);
		if (perms.isBlocked) {
			jsonError(opts.res, 403, perms.blockedReason ?? "User is blocked");
			return { ok: false };
		}
		if (!roleAtLeast(perms.role, opts.minRole)) {
			jsonError(opts.res, 403, "Forbidden");
			return { ok: false };
		}

		return { ok: true, userId: ws.userId, role: perms.role, bearer: false };
	}

	async function sendSlackLoginCode(opts: {
		teamId: string;
		userId: string;
		code: string;
	}): Promise<{ ok: true } | { ok: false; error: string }> {
		const ws = workspaceManager.get(opts.teamId);
		if (!ws) return { ok: false, error: "Workspace not found" };
		if (ws.status !== "active") {
			return { ok: false, error: `Workspace is ${ws.status}` };
		}

		const client = new WebClient(ws.botToken);
		try {
			const open = await client.conversations.open({ users: opts.userId });
			const channel = (open as { channel?: { id?: string } }).channel?.id;
			if (!channel) return { ok: false, error: "Failed to open DM channel" };
			await client.chat.postMessage({
				channel,
				text: `Composer control plane login code: ${opts.code}\n\nThis code expires in 10 minutes.`,
			});
			return { ok: true };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, error: msg };
		}
	}

	function extractJsonObject(text: string): string {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start === -1 || end === -1 || end <= start) {
			throw new Error("Dashboard render did not return JSON");
		}
		return text.slice(start, end + 1);
	}

	async function generateLiveDashboardSpec(opts: {
		services: WorkspaceServices;
		definitionPrompt: string;
		titleHint?: string;
	}): Promise<DashboardSpec> {
		const model = getModel(
			"anthropic",
			"claude-sonnet-4-20250514",
		) as Model<Api> | null;
		if (!model) {
			throw new Error(
				"Model not available: anthropic/claude-sonnet-4-20250514",
			);
		}

		const transport = new ProviderTransport({
			getApiKey: async (provider: string) => {
				if (provider !== "anthropic") {
					throw new Error(`Unsupported provider: ${provider}`);
				}
				const key =
					process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
				if (!key) {
					throw new Error(
						"ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY must be set",
					);
				}
				return key;
			},
		});

		const connectorRegistry = await createConnectorRegistry({
			workingDir: opts.services.workspaceDir,
			getCredentials: (name: string) =>
				opts.services.credentialManager.get(name),
			allowedCategories: ["read"],
		});

		const systemPrompt = [
			"You are a BI dashboard generator for a Slack workspace.",
			"Rules:",
			"- Output ONLY valid JSON. No markdown. No commentary.",
			"- The JSON must be a DashboardSpec with fields:",
			'  { "title": string, "subtitle"?: string, "theme"?: "dark"|"light", "generatedAt"?: string, "components": any[] }',
			"- Do not fabricate numbers. Use connector tools to fetch real data.",
			"- If data is missing, add an activity-feed item explaining what connector/permission is missing.",
			"",
			"Supported component types include: stat-group, bar-chart, line-chart, area-chart, pie-chart, doughnut-chart, table, activity-feed, progress-bar, number-card, section-header, key-value-list.",
			"",
			connectorRegistry.describeForPrompt(),
		].join("\n");

		const agent = new Agent({
			transport,
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: "off",
				tools: connectorRegistry.tools as unknown as Array<
					import("@evalops/ai").AgentTool
				>,
			},
		});

		const userPrompt = [
			"Generate a dashboard spec for this request.",
			opts.titleHint ? `Title hint: ${opts.titleHint}` : "",
			"Request:",
			opts.definitionPrompt,
			"",
			"Return JSON only.",
		]
			.filter(Boolean)
			.join("\n");

		await agent.prompt(userPrompt);
		const messages = agent.state.messages as Array<{
			role: string;
			content: Array<{ type: string; text?: string }>;
		}>;
		const last = [...messages].reverse().find((m) => m.role === "assistant");
		const text =
			last?.content
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n") ?? "";
		const jsonText = extractJsonObject(text.trim());
		const parsed = JSON.parse(jsonText) as DashboardSpec;

		if (!parsed || typeof parsed !== "object") {
			throw new Error("Invalid dashboard JSON");
		}
		if (typeof (parsed as { title?: unknown }).title !== "string") {
			throw new Error("Dashboard JSON missing title");
		}
		if (!Array.isArray((parsed as { components?: unknown }).components)) {
			throw new Error("Dashboard JSON missing components[]");
		}

		return parsed;
	}

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`);
		const path = url.pathname;
		const method = req.method ?? "GET";

		// CORS — restrict to same-origin by default; allow localhost for local dev
		const origin = req.headers.origin ?? "";
		const allowedOrigin =
			origin.startsWith("http://localhost:") ||
			origin.startsWith("http://127.0.0.1:")
				? origin
				: "";
		res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
		res.setHeader(
			"Access-Control-Allow-Methods",
			"GET,POST,PUT,DELETE,OPTIONS",
		);
		res.setHeader(
			"Access-Control-Allow-Headers",
			"Content-Type, Authorization",
		);
		res.setHeader("Access-Control-Allow-Credentials", "true");
		if (method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		// Slack OAuth install flow (intentionally not under /api so Slack can call back)
		if (path === "/slack/install" && method === "GET") {
			if (!slackOAuth?.clientId || !slackOAuth.clientSecret) {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end(
					"Slack OAuth is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.",
				);
				return;
			}

			try {
				const state =
					await oauthStateManager.generateStateToken(oauthStateSecret);
				const installUrl = new URL("https://slack.com/oauth/v2/authorize");
				installUrl.searchParams.set("client_id", slackOAuth.clientId);
				installUrl.searchParams.set("scope", oauthScopes.join(","));
				installUrl.searchParams.set("redirect_uri", oauthRedirectUri);
				installUrl.searchParams.set("state", state);
				res.writeHead(302, { Location: installUrl.toString() });
				res.end();
				return;
			} catch (err) {
				logger.logWarning(
					"Failed to start Slack install flow",
					err instanceof Error ? err.message : String(err),
				);
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Failed to start Slack install flow");
				return;
			}
		}

		if (path === "/slack/callback" && method === "GET") {
			if (!slackOAuth?.clientId || !slackOAuth.clientSecret) {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Slack OAuth is not configured.");
				return;
			}

			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			const error = url.searchParams.get("error");

			if (error) {
				res.writeHead(302, {
					Location: `/slack?error=${encodeURIComponent(error)}`,
				});
				res.end();
				return;
			}

			const validState =
				state &&
				(await oauthStateManager.verifyStateToken(oauthStateSecret, state));
			if (!code || !validState) {
				res.writeHead(302, {
					Location: "/slack?error=invalid_state",
				});
				res.end();
				return;
			}

			try {
				const tokenResponse = await fetch(
					"https://slack.com/api/oauth.v2.access",
					{
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							client_id: slackOAuth.clientId,
							client_secret: slackOAuth.clientSecret,
							code,
							redirect_uri: oauthRedirectUri,
						}).toString(),
					},
				);
				const data = (await tokenResponse.json()) as SlackOAuthResponse;
				if (!data.ok) {
					throw new Error(data.error ?? "Token exchange failed");
				}

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

				res.writeHead(302, {
					Location: `/slack?installed=1&teamId=${encodeURIComponent(credentials.teamId)}`,
				});
				res.end();
				return;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.logWarning("Slack OAuth callback failed", msg);
				res.writeHead(302, {
					Location: `/slack?error=${encodeURIComponent(msg)}`,
				});
				res.end();
				return;
			}
		}

		try {
			if (path === "/api/health" && method === "GET") {
				json(res, { ok: true });
				return;
			}

			// UI auth (per-user, via Slack DM login code)
			if (path === "/api/auth/me" && method === "GET") {
				const session = await getSession(req);
				json(res, session ? { ok: true, session } : { ok: false });
				return;
			}
			if (path === "/api/auth/request-code" && method === "POST") {
				const body = await readBody(req);
				const teamId = String(body.teamId ?? "");
				const userId = String(body.userId ?? "");
				if (!teamId || !userId) {
					jsonError(res, 400, "teamId and userId are required");
					return;
				}
				if (!isSafePathSegment(teamId) || !isSafePathSegment(userId)) {
					jsonError(res, 400, "Invalid teamId or userId");
					return;
				}
				if (!workspaceManager.get(teamId)) {
					jsonError(res, 404, "Workspace not found");
					return;
				}
				const code = String(Math.floor(100000 + Math.random() * 900000));
				await sessionManager.setLoginCode(teamId, userId, code);
				const sent = await sendSlackLoginCode({ teamId, userId, code });
				if (!sent.ok) {
					jsonError(res, 500, sent.error);
					return;
				}
				json(res, { ok: true });
				return;
			}
			if (path === "/api/auth/verify-code" && method === "POST") {
				const body = await readBody(req);
				const teamId = String(body.teamId ?? "");
				const userId = String(body.userId ?? "");
				const code = String(body.code ?? "");
				if (!teamId || !userId || !code) {
					jsonError(res, 400, "teamId, userId, and code are required");
					return;
				}
				if (!isSafePathSegment(teamId) || !isSafePathSegment(userId)) {
					jsonError(res, 400, "Invalid teamId or userId");
					return;
				}
				const ok = await sessionManager.verifyLoginCode(teamId, userId, code);
				if (!ok) {
					jsonError(res, 401, "Invalid code");
					return;
				}

				const cookies = parseCookies(req.headers.cookie);
				const existing = cookies[SESSION_COOKIE_NAME];
				let session = existing
					? await sessionManager.getSession(existing)
					: null;
				if (!session) {
					session = {
						id: crypto.randomUUID(),
						createdAt: new Date().toISOString(),
						teams: {},
					};
				}

				const services = getWorkspaceServices(teamId);
				if (!services) {
					jsonError(res, 404, "Workspace not found");
					return;
				}
				const perms = services.permissionManager.getUser(userId);
				if (perms.isBlocked) {
					jsonError(res, 403, perms.blockedReason ?? "User is blocked");
					return;
				}

				session.teams[teamId] = {
					userId,
					role: perms.role,
					updatedAt: new Date().toISOString(),
				};
				await sessionManager.saveSession(session);
				setCookie(res, SESSION_COOKIE_NAME, session.id, {
					httpOnly: true,
					sameSite: "Lax",
					maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
				});
				json(res, {
					ok: true,
					session: { id: session.id, teams: session.teams },
				});
				return;
			}
			if (path === "/api/auth/logout" && method === "POST") {
				const cookies = parseCookies(req.headers.cookie);
				const sessionId = cookies[SESSION_COOKIE_NAME];
				if (sessionId) {
					await sessionManager.deleteSession(sessionId);
				}
				setCookie(res, SESSION_COOKIE_NAME, "", {
					httpOnly: true,
					sameSite: "Lax",
					maxAgeSeconds: 0,
				});
				json(res, { ok: true });
				return;
			}

			// Slack workspaces + OAuth config
			if (path === "/api/slack/config" && method === "GET") {
				// Keep global workspace management behind the bearer token when configured.
				if (authToken && !getBearerTokenOk(req)) {
					jsonError(res, 401, "Unauthorized");
					return;
				}
				json(res, {
					oauthEnabled: !!(slackOAuth?.clientId && slackOAuth.clientSecret),
					installPath: "/slack/install",
					callbackPath: "/slack/callback",
					redirectUri: oauthRedirectUri,
					scopes: oauthScopes,
				});
				return;
			}
			if (path === "/api/slack/workspaces" && method === "GET") {
				if (authToken && !getBearerTokenOk(req)) {
					jsonError(res, 401, "Unauthorized");
					return;
				}
				json(res, sanitizeWorkspaces(workspaceManager.list()));
				return;
			}
			const wsMatch = path.match(/^\/api\/slack\/workspaces\/([^/]+)$/);
			if (wsMatch && method === "DELETE") {
				if (authToken && !getBearerTokenOk(req)) {
					jsonError(res, 401, "Unauthorized");
					return;
				}
				const teamId = decodeURIComponent(wsMatch[1]!);
				const ok = workspaceManager.remove(teamId);
				json(res, { ok });
				return;
			}
			const wsSuspendMatch = path.match(
				/^\/api\/slack\/workspaces\/([^/]+)\/suspend$/,
			);
			if (wsSuspendMatch && method === "POST") {
				if (authToken && !getBearerTokenOk(req)) {
					jsonError(res, 401, "Unauthorized");
					return;
				}
				const teamId = decodeURIComponent(wsSuspendMatch[1]!);
				const ok = workspaceManager.setStatus(teamId, "suspended");
				json(res, { ok });
				return;
			}
			const wsReactivateMatch = path.match(
				/^\/api\/slack\/workspaces\/([^/]+)\/reactivate$/,
			);
			if (wsReactivateMatch && method === "POST") {
				if (authToken && !getBearerTokenOk(req)) {
					jsonError(res, 401, "Unauthorized");
					return;
				}
				const teamId = decodeURIComponent(wsReactivateMatch[1]!);
				const ok = workspaceManager.setStatus(teamId, "active");
				json(res, { ok });
				return;
			}
			const wsUninstallMatch = path.match(
				/^\/api\/slack\/workspaces\/([^/]+)\/uninstall$/,
			);
			if (wsUninstallMatch && method === "POST") {
				if (authToken && !getBearerTokenOk(req)) {
					jsonError(res, 401, "Unauthorized");
					return;
				}
				const teamId = decodeURIComponent(wsUninstallMatch[1]!);
				const ok = workspaceManager.setStatus(teamId, "uninstalled");
				json(res, { ok });
				return;
			}

			// Workspace-scoped control plane:
			// /api/workspaces/:teamId/(dashboards|connectors|triggers)
			const workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)(\/.*)?$/);
			if (workspaceMatch) {
				const teamId = decodeURIComponent(workspaceMatch[1]!);
				const rest = workspaceMatch[2] ?? "/";
				const services = getWorkspaceServices(teamId);
				if (!services) {
					jsonError(res, 404, "Workspace not found");
					return;
				}

				// Dashboards
				if (rest === "/dashboards" && method === "GET") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "viewer",
					});
					if (!authz.ok) return;
					json(
						res,
						services.dashboardRegistry
							.list()
							.filter((d) => canViewDashboard(d, authz)),
					);
					return;
				}
				if (rest === "/dashboards" && method === "POST") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "user",
					});
					if (!authz.ok) return;
					const body = await readBody(req);
					const label = String(body.label ?? "Dashboard");
					const prompt = String(body.prompt ?? "");
					const title = body.title ? String(body.title) : label;
					const subtitle = body.subtitle ? String(body.subtitle) : undefined;
					const theme =
						body.theme === "light" ? ("light" as const) : ("dark" as const);
					const refreshIntervalMs = Number(
						body.refreshIntervalMs ?? DASHBOARD_DEFAULT_REFRESH_MS,
					);
					if (!prompt.trim()) {
						jsonError(res, 400, "prompt is required");
						return;
					}

					const created = services.dashboardRegistry.createDefinition({
						label,
						prompt: prompt.trim(),
						title,
						subtitle,
						theme,
						visibility: authz.bearer ? "shared" : "private",
						refreshIntervalMs:
							Number.isFinite(refreshIntervalMs) && refreshIntervalMs > 0
								? refreshIntervalMs
								: DASHBOARD_DEFAULT_REFRESH_MS,
						createdBy: authz.userId ?? undefined,
					});
					json(res, created, 201);
					return;
				}
				const dashIdMatch = rest.match(/^\/dashboards\/([^/]+)$/);
				if (dashIdMatch && method === "GET") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "viewer",
					});
					if (!authz.ok) return;
					const id = decodeURIComponent(dashIdMatch[1]!);
					const entry = services.dashboardRegistry.get(id);
					if (!entry) {
						jsonError(res, 404, "Dashboard not found");
						return;
					}
					if (!canViewDashboard(entry, authz)) {
						jsonError(res, 403, "Forbidden");
						return;
					}
					json(res, entry);
					return;
				}
				if (dashIdMatch && method === "DELETE") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "user",
					});
					if (!authz.ok) return;
					const id = decodeURIComponent(dashIdMatch[1]!);
					const entry = services.dashboardRegistry.get(id);
					if (!entry) {
						jsonError(res, 404, "Dashboard not found");
						return;
					}
					if (!canDeleteDashboard(entry, authz)) {
						jsonError(res, 403, "Forbidden");
						return;
					}
					const ok = services.dashboardRegistry.remove(id);
					json(res, { ok });
					return;
				}
				const dashShareMatch = rest.match(/^\/dashboards\/([^/]+)\/share$/);
				if (dashShareMatch && method === "POST") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "power_user",
					});
					if (!authz.ok) return;
					const id = decodeURIComponent(dashShareMatch[1]!);
					const entry = services.dashboardRegistry.get(id);
					if (!entry) {
						jsonError(res, 404, "Dashboard not found");
						return;
					}
					services.dashboardRegistry.update(id, {
						visibility: "shared",
						sharedAt: new Date().toISOString(),
						sharedBy: authz.userId ?? "ui",
					});
					json(res, { ok: true });
					return;
				}
				const dashUnshareMatch = rest.match(/^\/dashboards\/([^/]+)\/unshare$/);
				if (dashUnshareMatch && method === "POST") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "power_user",
					});
					if (!authz.ok) return;
					const id = decodeURIComponent(dashUnshareMatch[1]!);
					const entry = services.dashboardRegistry.get(id);
					if (!entry) {
						jsonError(res, 404, "Dashboard not found");
						return;
					}
					services.dashboardRegistry.update(id, {
						visibility: "private",
						sharedAt: undefined,
						sharedBy: undefined,
					});
					json(res, { ok: true });
					return;
				}
				const dashRenderMatch = rest.match(/^\/dashboards\/([^/]+)\/render$/);
				if (dashRenderMatch && method === "GET") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "viewer",
					});
					if (!authz.ok) return;
					const id = decodeURIComponent(dashRenderMatch[1]!);
					const force = url.searchParams.get("force") === "1";
					const entry = services.dashboardRegistry.get(id);
					if (!entry) {
						jsonError(res, 404, "Dashboard not found");
						return;
					}
					if (!canViewDashboard(entry, authz)) {
						jsonError(res, 403, "Forbidden");
						return;
					}
					if (!entry.definition) {
						if (entry.spec) {
							json(res, {
								ok: true,
								spec: entry.spec,
								renderedAt:
									entry.lastRenderedAt ?? entry.updatedAt ?? entry.createdAt,
								fromCache: true,
							});
							return;
						}
						jsonError(res, 400, "Dashboard has no live definition");
						return;
					}

					const cacheKey = `${teamId}:${id}`;
					const last = entry.lastRenderedAt
						? Date.parse(entry.lastRenderedAt)
						: entry.spec?.generatedAt
							? Date.parse(entry.spec.generatedAt)
							: 0;
					const refreshMs =
						entry.definition.refreshIntervalMs ?? DASHBOARD_DEFAULT_REFRESH_MS;
					const fresh =
						!force && entry.spec && last > 0 && Date.now() - last < refreshMs;
					if (fresh) {
						json(res, {
							ok: true,
							spec: entry.spec,
							renderedAt: entry.lastRenderedAt ?? entry.spec?.generatedAt,
							fromCache: true,
						});
						return;
					}

					const inflight = inflightDashboardRenders.get(cacheKey);
					if (inflight) {
						const r = await inflight;
						json(res, { ok: true, ...r });
						return;
					}

					const p = (async () => {
						const renderedAt = new Date().toISOString();
						const spec = await generateLiveDashboardSpec({
							services,
							definitionPrompt: entry.definition?.prompt ?? "",
							titleHint: entry.definition?.title,
						});
						spec.generatedAt = renderedAt;
						services.dashboardRegistry.update(id, {
							spec,
							lastRenderedAt: renderedAt,
							lastError: undefined,
						});
						return { spec, renderedAt, fromCache: false };
					})()
						.catch((err) => {
							const msg = err instanceof Error ? err.message : String(err);
							services.dashboardRegistry.update(id, { lastError: msg });
							throw err;
						})
						.finally(() => {
							inflightDashboardRenders.delete(cacheKey);
						});
					inflightDashboardRenders.set(cacheKey, p);

					try {
						const r = await p;
						json(res, { ok: true, ...r });
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						jsonError(res, 500, msg);
					}
					return;
				}

				// Connectors
				if (rest === "/connectors" && method === "GET") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "viewer",
					});
					if (!authz.ok) return;
					const list = await services.connectorManager.listConnectors();
					json(res, list);
					return;
				}
				if (rest === "/connectors" && method === "POST") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "power_user",
					});
					if (!authz.ok) return;
					const body = await readBody(req);
					const type = String(body.type ?? "");
					const name = String(body.name ?? "");
					if (!type || !name) {
						jsonError(res, 400, "type and name are required");
						return;
					}
					const result = await services.connectorManager.addConnector(
						type,
						name,
						authz.userId ?? "ui",
					);
					if (!result.ok) {
						jsonError(res, 400, result.error ?? "Failed");
						return;
					}
					json(res, { ok: true, message: "Connector added" }, 201);
					return;
				}
				const connectorRemoveMatch = rest.match(/^\/connectors\/([^/]+)$/);
				if (connectorRemoveMatch && method === "DELETE") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "power_user",
					});
					if (!authz.ok) return;
					const name = decodeURIComponent(connectorRemoveMatch[1]!);
					const result = await services.connectorManager.removeConnector(
						name,
						authz.userId ?? "ui",
					);
					if (!result.ok) {
						jsonError(res, 404, result.error ?? "Not found");
						return;
					}
					json(res, { ok: true });
					return;
				}
				const connectorCredsMatch = rest.match(
					/^\/connectors\/([^/]+)\/credentials$/,
				);
				if (connectorCredsMatch && method === "PUT") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "power_user",
					});
					if (!authz.ok) return;
					const name = decodeURIComponent(connectorCredsMatch[1]!);
					const body = await readBody(req);
					const secret = String(body.secret ?? "");
					const metadata = body.metadata as Record<string, string> | undefined;
					if (!secret) {
						jsonError(res, 400, "secret is required");
						return;
					}
					const result = await services.connectorManager.setCredentials(
						name,
						{
							type: services.connectorManager.getAuthTypeForInstance(name),
							secret,
							metadata:
								metadata && Object.keys(metadata).length ? metadata : undefined,
						},
						authz.userId ?? "ui",
					);
					if (!result.ok) {
						jsonError(res, 404, result.error ?? "Not found");
						return;
					}
					json(res, { ok: true });
					return;
				}
				if (rest === "/connectors/types" && method === "GET") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "viewer",
					});
					if (!authz.ok) return;
					json(res, getRegisteredTypes());
					return;
				}

				// Triggers
				if (rest === "/triggers" && method === "GET") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "viewer",
					});
					if (!authz.ok) return;
					json(res, services.triggerManager.listTriggers());
					return;
				}
				if (rest === "/triggers" && method === "POST") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "power_user",
					});
					if (!authz.ok) return;
					const body = await readBody(req);
					const source = String(body.source ?? "");
					const channel = String(body.channel ?? "");
					const prompt = String(body.prompt ?? "");
					const enabled = body.enabled !== false;
					const filter = (body.filter ?? undefined) as
						| Record<string, unknown>
						| undefined;
					if (!source || !channel || !prompt) {
						jsonError(res, 400, "source, channel, and prompt are required");
						return;
					}
					const trigger = services.triggerManager.addTrigger({
						source,
						channel,
						prompt,
						enabled,
						filter,
						createdBy: authz.userId ?? "ui",
					});
					json(res, trigger, 201);
					return;
				}
				const triggerRemoveMatch = rest.match(/^\/triggers\/([^/]+)$/);
				if (triggerRemoveMatch && method === "DELETE") {
					const authz = await requireWorkspaceAuth({
						req,
						res,
						teamId,
						minRole: "power_user",
					});
					if (!authz.ok) return;
					const id = decodeURIComponent(triggerRemoveMatch[1]!);
					const ok = services.triggerManager.removeTrigger(id);
					json(res, { ok });
					return;
				}

				// No match in this workspace scope.
				jsonError(res, 404, "Not found");
				return;
			}

			// Serve static files for the React UI (if configured)
			if (staticDir && method === "GET" && !path.startsWith("/api/")) {
				const filePath = resolveStaticPath(staticDir, path);
				if (filePath && existsSync(filePath)) {
					const content = readFileSync(filePath);
					const ext = filePath.split(".").pop() ?? "";
					res.setHeader("Content-Type", mimeType(ext));
					res.writeHead(200);
					res.end(content);
					return;
				}
				// SPA fallback
				const indexPath = join(staticDir, "index.html");
				if (existsSync(indexPath)) {
					res.setHeader("Content-Type", "text/html");
					res.writeHead(200);
					res.end(readFileSync(indexPath));
					return;
				}
			}

			jsonError(res, 404, "Not found");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.logWarning("API server error", msg);
			jsonError(res, 500, msg);
		}
	});

	return {
		start: () =>
			new Promise<void>((resolve, reject) => {
				server.listen(port, host, () => {
					logger.logInfo(
						`UI API server listening on ${host}:${port}${authToken ? " (auth required)" : ""}`,
					);
					resolve();
				});
				server.on("error", reject);
			}),
		stop: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

function resolveStaticPath(
	staticDir: string,
	requestPath: string,
): string | null {
	const base = resolve(staticDir);
	const rel =
		requestPath === "/"
			? "index.html"
			: requestPath.replace(/^\/+/, "").replace(/\\/g, "/");
	const full = resolve(base, rel);
	if (full === base) return null;
	if (!full.startsWith(`${base}${sep}`)) return null;
	return full;
}

function json(res: ServerResponse, data: unknown, status = 200): void {
	res.setHeader("Content-Type", "application/json");
	res.writeHead(status);
	res.end(JSON.stringify(data));
}

function jsonError(res: ServerResponse, status: number, message: string): void {
	json(res, { error: message }, status);
}

async function readBody(
	req: IncomingMessage,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString()));
			} catch {
				resolve({});
			}
		});
		req.on("error", reject);
	});
}

function mimeType(ext: string): string {
	const types: Record<string, string> = {
		html: "text/html",
		js: "application/javascript",
		css: "text/css",
		json: "application/json",
		png: "image/png",
		svg: "image/svg+xml",
		ico: "image/x-icon",
		woff2: "font/woff2",
		woff: "font/woff",
	};
	return types[ext] ?? "application/octet-stream";
}
