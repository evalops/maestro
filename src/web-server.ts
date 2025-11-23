/**
 * Web server for Composer - HTTP/WebSocket API for web UI
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, parse } from "node:url";
import type {
	ComposerChatRequest,
	ComposerMessage,
	ComposerSession,
	ComposerSessionSummary,
} from "@evalops/contracts";
import {
	ActionApprovalService,
	type ApprovalMode,
} from "./agent/action-approval.js";
import { Agent, ProviderTransport } from "./agent/index.js";
import type { AgentEvent, Provider, ThinkingLevel } from "./agent/types.js";
import { buildSystemPrompt } from "./cli/system-prompt.js";
import { loadEnv } from "./load-env.js";
import {
	type RegisteredModel,
	getComposerCustomConfig,
	getCustomConfigPath,
	getRegisteredModels,
	reloadModelConfig,
} from "./models/registry.js";
import { getEnvVarsForProvider } from "./providers/api-keys.js";
import {
	type AuthCredential,
	type AuthMode,
	createAuthResolver,
} from "./providers/auth.js";
import { SessionManager, toSessionModelMetadata } from "./session/manager.js";
import { recordSseSkip } from "./telemetry.js";
import { backgroundTaskManager } from "./tools/background-tasks.js";
import { codingTools } from "./tools/index.js";
import { getUsageFilePath, getUsageSummary } from "./tracking/cost-tracker.js";
import {
	determineModelSelection,
	getRegisteredModelOrThrow,
} from "./web/model-selection.js";
import { type Route, createRequestHandler } from "./web/router.js";
import {
	ApiError,
	authenticateRequest,
	createCorsHeaders,
	respondWithApiError,
	sendJson,
} from "./web/server-utils.js";
import {
	convertAppMessagesToComposer,
	convertComposerMessagesToApp,
} from "./web/session-serialization.js";
import { SseSession, sendSSE, sendSessionUpdate } from "./web/sse-session.js";
import { serveStatic } from "./web/static-server.js";

loadEnv();

function normalizeApprovalMode(value?: string | null): ApprovalMode {
	const normalized = value?.trim().toLowerCase();
	if (
		normalized === "auto" ||
		normalized === "prompt" ||
		normalized === "fail"
	) {
		return normalized;
	}
	return "prompt";
}

function normalizeAuthMode(value?: string | null): AuthMode {
	const normalized = value?.trim().toLowerCase();
	if (
		normalized === "auto" ||
		normalized === "api-key" ||
		normalized === "chatgpt" ||
		normalized === "claude"
	) {
		return normalized;
	}
	return "auto";
}

const DEFAULT_APPROVAL_MODE = normalizeApprovalMode(
	process.env.COMPOSER_APPROVAL_MODE,
);
const AUTH_MODE = normalizeAuthMode(process.env.COMPOSER_AUTH_MODE);
const CODEX_TOKEN = process.env.CODEX_API_KEY?.trim();
const WEB_API_KEY = process.env.COMPOSER_WEB_API_KEY?.trim() || null;
const DEFAULT_WEB_ORIGIN =
	process.env.COMPOSER_WEB_ORIGIN?.trim() || "http://localhost:4173";

if (!WEB_API_KEY) {
	console.warn(
		"[composer:web] COMPOSER_WEB_API_KEY is not set; API routes are running without authentication",
	);
}

const authResolver = createAuthResolver({
	mode: AUTH_MODE,
	codexApiKey: CODEX_TOKEN,
	codexSource: CODEX_TOKEN ? "env" : undefined,
});

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-5";

async function ensureCredential(provider: string): Promise<AuthCredential> {
	const credential = await authResolver(provider);
	if (credential) {
		return credential;
	}
	throw new ApiError(401, buildMissingCredentialMessage(provider));
}

function logMissingCredentialHints(provider: string): void {
	const envVars = getEnvVarsForProvider(provider);
	const hints: string[] = [`Missing credentials for provider "${provider}".`];
	if (envVars.length > 0) {
		hints.push(
			`Populate ${envVars.join(" or ")} or configure a custom provider secret before retrying.`,
		);
	}
	if (provider === "anthropic") {
		hints.push(
			"Run `composer anthropic login` to provision OAuth credentials.",
		);
	} else if (provider === "openai") {
		hints.push("Set OPENAI_API_KEY or configure ChatGPT/Codex credentials.");
	}
	console.warn(hints.join(" "));
}

function buildMissingCredentialMessage(provider: string): string {
	logMissingCredentialHints(provider);
	return `Credentials are required for provider "${provider}".`;
}

function readRequestBody(
	req: IncomingMessage,
	limit = MAX_BODY_BYTES,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let total = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			const nextTotal = total + chunk.length;
			if (nextTotal > limit) {
				req.removeAllListeners("data");
				req.removeAllListeners("end");
				req.destroy();
				reject(new ApiError(413, "Payload too large"));
				return;
			}
			total = nextTotal;
			chunks.push(chunk);
		});
		req.on("end", () => {
			resolve(Buffer.concat(chunks).toString());
		});
		req.on("error", (error) => {
			reject(error);
		});
	});
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
	const raw = await readRequestBody(req);
	if (!raw) {
		return {} as T;
	}
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw new ApiError(400, "Invalid JSON payload");
	}
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = join(__dirname, "../packages/web");

let currentModelKey: string | null = null;

function getModelByKey(key: string | null): RegisteredModel | null {
	if (!key) return null;
	const [provider, modelId] = key.split("/");
	if (!provider || !modelId) return null;
	return (
		getRegisteredModels().find(
			(entry) => entry.provider === provider && entry.id === modelId,
		) || null
	);
}

function getActiveModel(): RegisteredModel | null {
	const current = getModelByKey(currentModelKey);
	if (current) return current;
	const models = getRegisteredModels();
	return models[0] ?? null;
}

const routes: Route[] = [
	{
		method: "GET",
		path: "/api/models",
		handler: (_req, res) => handleModels(res),
	},
	{
		method: "GET",
		path: "/api/status",
		handler: (_req, res) => handleStatus(res),
	},
	{
		method: "GET",
		path: "/api/config",
		handler: (req, res) => handleConfig(req, res),
	},
	{
		method: "POST",
		path: "/api/config",
		handler: (req, res) => handleConfig(req, res),
	},
	{
		method: "GET",
		path: "/api/usage",
		handler: (req, res) => handleUsage(req, res),
	},
	{
		method: "GET",
		path: "/api/model",
		handler: (req, res) => handleModel(req, res),
	},
	{
		method: "POST",
		path: "/api/model",
		handler: (req, res) => handleModel(req, res),
	},
	{
		method: "POST",
		path: "/api/chat",
		handler: (req, res) => handleChat(req, res),
	},
	{
		method: "GET",
		path: "/api/sessions",
		handler: (req, res) => handleSessions(req, res),
	},
	{
		method: "POST",
		path: "/api/sessions",
		handler: (req, res) => handleSessions(req, res),
	},
	{
		method: "GET",
		path: "/api/sessions/:id",
		handler: (req, res, params) => handleSessions(req, res, params),
	},
	{
		method: "DELETE",
		path: "/api/sessions/:id",
		handler: (req, res, params) => handleSessions(req, res, params),
	},
];

/**
 * CORS headers for web requests
 */
const ALLOWED_ORIGIN = DEFAULT_WEB_ORIGIN;
const CORS_HEADERS = createCorsHeaders(ALLOWED_ORIGIN);
const router = createRequestHandler(routes, (req, res, pathname) => {
	if (pathname.startsWith("/api")) {
		sendJson(res, 404, { error: "Not found" }, CORS_HEADERS);
		return;
	}
	serveStatic(pathname, req, res, {
		webRoot: WEB_ROOT,
		corsHeaders: CORS_HEADERS,
	});
});

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_BODY_BYTES = 1_000_000;

/**
 * Create and configure Composer agent
 */
async function createAgent(
	registeredModel: RegisteredModel,
	thinkingLevel: ThinkingLevel = "off",
	approvalMode: ApprovalMode = DEFAULT_APPROVAL_MODE,
): Promise<Agent> {
	const transport = new ProviderTransport({
		getAuthContext: async (provider: string) => authResolver(provider),
		approvalService: new ActionApprovalService(approvalMode),
	});

	const systemPrompt = buildSystemPrompt();

	const agent = new Agent({
		transport,
		initialState: {
			systemPrompt,
			model: registeredModel,
			thinkingLevel,
			tools: codingTools,
		},
	});

	return agent;
}

/**
 * Handle /api/models - List available models
 */
function handleModels(res: ServerResponse) {
	const models = getRegisteredModels();
	const modelList = models.map((m) => ({
		id: m.id,
		provider: m.provider,
		name: m.name || m.id,
		api: m.api,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		cost: m.cost,
		capabilities: {
			streaming: true,
			tools: true,
			vision: m.input?.includes("image") || false,
			reasoning: m.reasoning || false,
		},
	}));

	sendJson(res, 200, { models: modelList }, CORS_HEADERS);
}

/**
 * Handle /api/status - Get server and workspace status
 */
function handleStatus(res: ServerResponse) {
	try {
		const startedAt = Date.now();
		const cwd = process.cwd();

		let gitBranch = null;
		let gitStatus = null;
		try {
			gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "ignore"],
			}).trim();

			const status = execSync("git status --porcelain", {
				cwd,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "ignore"],
			});
			const lines = status.trim().split("\n").filter(Boolean);
			gitStatus = {
				modified: lines.filter((l: string) => l.startsWith(" M")).length,
				added: lines.filter((l: string) => l.startsWith("A ")).length,
				deleted: lines.filter((l: string) => l.startsWith(" D")).length,
				untracked: lines.filter((l: string) => l.startsWith("??")).length,
				total: lines.length,
			};
		} catch (e) {
			// Not a git repository or git not available
		}

		const status = {
			cwd,
			git: gitBranch ? { branch: gitBranch, status: gitStatus } : null,
			context: {
				agentMd: existsSync(join(cwd, "AGENT.md")),
				claudeMd: existsSync(join(cwd, "CLAUDE.md")),
			},
			server: {
				uptime: process.uptime(),
				version: process.version,
			},
			backgroundTasks: backgroundTaskManager.getHealthSnapshot({
				maxEntries: 5,
				logLines: 2,
			}),
			lastUpdated: Date.now(),
			lastLatencyMs: Date.now() - startedAt,
		};

		sendJson(res, 200, status, CORS_HEADERS);
	} catch (error) {
		respondWithApiError(res, error, 500, CORS_HEADERS);
	}
}

/**
 * Handle /api/config - Get and update configuration
 */
async function handleConfig(req: IncomingMessage, res: ServerResponse) {
	if (req.method === "GET") {
		try {
			const config = getComposerCustomConfig();
			const configPath = getCustomConfigPath();
			sendJson(res, 200, { config, configPath }, CORS_HEADERS);
		} catch (error) {
			respondWithApiError(res, error, 500, CORS_HEADERS);
		}
	} else if (req.method === "POST") {
		try {
			const { config } = await readJsonBody<{ config: unknown }>(req);
			const configPath = getCustomConfigPath();
			writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
			await reloadModelConfig();
			sendJson(res, 200, { success: true }, CORS_HEADERS);
		} catch (error) {
			respondWithApiError(res, error, 500, CORS_HEADERS);
		}
	}
}

/**
 * Handle /api/usage - Get cost tracking and usage statistics
 */
function handleUsage(req: IncomingMessage, res: ServerResponse) {
	try {
		const parsedUrl = parse(req.url ?? "/", true);
		const { since, until } = parsedUrl.query;

		const options: {
			since?: number;
			until?: number;
		} = {};
		if (since) options.since = Number.parseInt(String(since), 10);
		if (until) options.until = Number.parseInt(String(until), 10);

		const summary = getUsageSummary(options);
		const usageFile = getUsageFilePath();
		const hasData = existsSync(usageFile);
		const totals = summary.tokensDetailed || {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: summary.totalTokens,
		};

		const mapBreakdowns = <T extends Record<string, any>>(record: T) => {
			const mapped: Record<string, any> = {};
			for (const [key, value] of Object.entries(record)) {
				const detail = value as {
					cost: number;
					tokens: number;
					requests: number;
					tokensDetailed?: {
						input: number;
						output: number;
						cacheRead: number;
						cacheWrite: number;
						total: number;
					};
				};
				const tokenDetails = detail.tokensDetailed || {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: detail.tokens,
				};
				mapped[key] = {
					...detail,
					calls: detail.requests,
					tokensDetailed: tokenDetails,
					cachedTokens: tokenDetails.cacheRead + tokenDetails.cacheWrite,
				};
			}
			return mapped;
		};

		sendJson(
			res,
			200,
			{
				summary: {
					...summary,
					totalTokensDetailed: totals,
					totalTokensBreakdown: totals,
					totalCachedTokens: totals.cacheRead + totals.cacheWrite,
					byProvider: mapBreakdowns(summary.byProvider),
					byModel: mapBreakdowns(summary.byModel),
				},
				hasData,
			},
			CORS_HEADERS,
		);
	} catch (error) {
		respondWithApiError(res, error, 500, CORS_HEADERS);
	}
}

function respondWithModel(res: ServerResponse, model: RegisteredModel) {
	sendJson(
		res,
		200,
		{
			id: model.id,
			provider: model.provider,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
		},
		CORS_HEADERS,
	);
}

async function handleModel(req: IncomingMessage, res: ServerResponse) {
	if (req.method === "GET") {
		const model = getActiveModel();
		if (!model) {
			res.writeHead(404, {
				"Content-Type": "application/json",
				...CORS_HEADERS,
			});
			res.end(JSON.stringify({ error: "No models registered" }));
			return;
		}
		respondWithModel(res, model);
		return;
	}

	if (req.method === "POST") {
		try {
			const payload = await readJsonBody<{ model?: string }>(req);
			const modelInput = (payload.model || "").trim();
			if (!modelInput) {
				sendJson(res, 400, { error: "Model is required" }, CORS_HEADERS);
				return;
			}

			const selection = determineModelSelection(
				modelInput,
				DEFAULT_PROVIDER,
				DEFAULT_MODEL_ID,
			);
			const registeredModel = getRegisteredModelOrThrow(selection);
			await ensureCredential(registeredModel.provider);
			currentModelKey = `${registeredModel.provider}/${registeredModel.id}`;
			respondWithModel(res, registeredModel);
		} catch (error) {
			respondWithApiError(res, error, 400, CORS_HEADERS);
		}
		return;
	}

	res.writeHead(405, {
		"Content-Type": "application/json",
		...CORS_HEADERS,
	});
	res.end(JSON.stringify({ error: "Method not allowed" }));
}

/**
 * Handle /api/chat - Stream chat responses
 */
async function handleChat(req: IncomingMessage, res: ServerResponse) {
	try {
		const chatReq = await readJsonBody<ComposerChatRequest>(req);

		const sessionManager = new SessionManager(false);
		if (chatReq.sessionId) {
			const sessionFile = sessionManager.getSessionFileById(chatReq.sessionId);
			if (sessionFile) {
				sessionManager.setSessionFile(sessionFile);
			}
		}

		const selection = determineModelSelection(
			chatReq.model,
			DEFAULT_PROVIDER,
			DEFAULT_MODEL_ID,
		);
		const registeredModel = getRegisteredModelOrThrow(selection);
		await ensureCredential(registeredModel.provider);
		const headerApproval = (() => {
			const header = req.headers["x-composer-approval-mode"];
			const raw = Array.isArray(header) ? header[0] : header;
			const normalized = raw?.trim().toLowerCase();
			if (
				normalized === "auto" ||
				normalized === "prompt" ||
				normalized === "fail"
			) {
				return normalized as ApprovalMode;
			}
			return undefined;
		})();
		const effectiveApproval = (() => {
			if (!headerApproval) {
				return DEFAULT_APPROVAL_MODE;
			}
			if (headerApproval === "auto" && DEFAULT_APPROVAL_MODE !== "auto") {
				return DEFAULT_APPROVAL_MODE;
			}
			return headerApproval;
		})();
		const agent = await createAgent(
			registeredModel,
			chatReq.thinkingLevel || "off",
			effectiveApproval,
		);

		const incomingMessages = Array.isArray(chatReq.messages)
			? (chatReq.messages as ComposerMessage[])
			: [];
		if (incomingMessages.length === 0) {
			sendJson(res, 400, { error: "No messages supplied" }, CORS_HEADERS);
			return;
		}

		const latestMessage = incomingMessages[incomingMessages.length - 1];
		if (!latestMessage || latestMessage.role !== "user") {
			sendJson(
				res,
				400,
				{ error: "Last message must be a user message" },
				CORS_HEADERS,
			);
			return;
		}

		const userInput = (latestMessage.content ?? "").trim();
		if (!userInput) {
			sendJson(
				res,
				400,
				{ error: "User message cannot be empty" },
				CORS_HEADERS,
			);
			return;
		}

		const historyMessages = incomingMessages.slice(0, -1);
		const hydratedHistory = convertComposerMessagesToApp(
			historyMessages,
			registeredModel,
		);
		if (hydratedHistory.length > 0) {
			agent.replaceMessages(hydratedHistory);
		} else {
			agent.clearMessages();
		}

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			...CORS_HEADERS,
		});

		const requestId = Math.random().toString(36).slice(2);
		const modelKey = `${registeredModel.provider}/${registeredModel.id}`;
		const sseSession = new SseSession(
			res,
			(metrics) => {
				recordSseSkip(metrics.sent, metrics.skipped, {
					requestId: metrics.context?.requestId,
					modelKey: metrics.context?.modelKey,
					sessionId: metrics.context?.sessionId,
					lastError:
						metrics.lastError instanceof Error
							? metrics.lastError.message
							: metrics.lastError,
				});
			},
			{ requestId, modelKey },
		);
		sseSession.startHeartbeat();
		let cleanedUp = false;

		const unsubscribe = agent.subscribe((event: AgentEvent) => {
			sendSSE(sseSession, event);

			if (event.type === "message_end") {
				sessionManager.saveMessage(event.message);
				if (sessionManager.shouldInitializeSession(agent.state.messages)) {
					sessionManager.startSession(agent.state);
					const sessionId = sessionManager.getSessionId();
					sendSessionUpdate(sseSession, sessionId);
					sseSession.setContext({ sessionId });
				}
			}

			sessionManager.updateSnapshot(
				agent.state,
				toSessionModelMetadata(registeredModel),
			);
		});

		const handleConnectionClose = () => {
			agent.abort();
			void cleanup(true);
		};

		req.on("close", handleConnectionClose);
		res.on("close", handleConnectionClose);

		const cleanup = async (aborted = false) => {
			if (cleanedUp) {
				return;
			}
			cleanedUp = true;
			sseSession.stopHeartbeat();
			req.off("close", handleConnectionClose);
			res.off("close", handleConnectionClose);
			unsubscribe();
			await sessionManager.flush();
			if (!res.writableEnded) {
				if (aborted) {
					sseSession.sendAborted();
				}
				sseSession.end();
			}
			const metrics = sseSession.getMetrics();
			if (metrics.skipped > 0) {
				console.debug("SSE writes skipped after disconnect", metrics);
			}
		};

		try {
			await agent.prompt(userInput);
			if (!res.writableEnded) {
				sseSession.sendDone();
			}
		} catch (error) {
			console.error("Agent prompt error:", error);
			sendSSE(sseSession, {
				type: "error",
				message: error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			await cleanup(false);
		}
	} catch (error) {
		console.error("Chat error:", error);
		respondWithApiError(res, error, 500, CORS_HEADERS);
	}
}

/**
 * Handle /api/sessions - List and manage sessions
 */
async function handleSessions(
	req: IncomingMessage,
	res: ServerResponse,
	params: { id?: string } = {},
) {
	const sessionManager = new SessionManager(true);
	const sessionIdPattern = /^[a-zA-Z0-9._-]+$/;
	const sessionId = params.id;

	try {
		// GET /api/sessions - List all sessions
		if (req.method === "GET" && !sessionId) {
			const sessions = await sessionManager.listSessions();
			const sessionList: ComposerSessionSummary[] = sessions.map((s) => ({
				id: s.id,
				title: s.title || `Session ${s.id.slice(0, 8)}`,
				createdAt: s.createdAt || new Date().toISOString(),
				updatedAt: s.updatedAt || new Date().toISOString(),
				messageCount: s.messageCount || 0,
			}));

			sendJson(res, 200, { sessions: sessionList }, CORS_HEADERS);
		}
		// GET /api/sessions/:id - Get specific session
		else if (req.method === "GET" && sessionId) {
			if (!sessionIdPattern.test(sessionId)) {
				sendJson(res, 400, { error: "Invalid session id" }, CORS_HEADERS);
				return;
			}
			const session = await sessionManager.loadSession(sessionId);

			if (!session) {
				sendJson(res, 404, { error: "Session not found" }, CORS_HEADERS);
				return;
			}

			const responseBody: ComposerSession = {
				id: session.id,
				title: session.title,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				messageCount: session.messageCount,
				messages: convertAppMessagesToComposer(session.messages || []),
			};

			sendJson(res, 200, responseBody, CORS_HEADERS);
		}
		// POST /api/sessions - Create new session
		else if (req.method === "POST" && !sessionId) {
			const { title } = await readJsonBody<{ title?: string }>(req);
			const session = await sessionManager.createSession({ title });
			const responseBody: ComposerSession = {
				id: session.id,
				title: session.title,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				messageCount: session.messageCount,
				messages: convertAppMessagesToComposer(session.messages || []),
			};

			sendJson(res, 201, responseBody, CORS_HEADERS);
		}
		// DELETE /api/sessions/:id - Delete session
		else if (req.method === "DELETE" && sessionId) {
			if (!sessionIdPattern.test(sessionId)) {
				sendJson(res, 400, { error: "Invalid session id" }, CORS_HEADERS);
				return;
			}
			await sessionManager.deleteSession(sessionId);

			res.writeHead(204, CORS_HEADERS);
			res.end();
		} else {
			res.writeHead(404, {
				"Content-Type": "application/json",
				...CORS_HEADERS,
			});
			res.end(JSON.stringify({ error: "Not found" }));
		}
	} catch (error) {
		console.error("Session error:", error);
		respondWithApiError(res, error, 500, CORS_HEADERS);
	}
}

/**
 * Main request handler
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse) {
	const parsedUrl = parse(req.url || "/", true);
	const pathname = parsedUrl.pathname || "/";

	console.log(`${req.method} ${pathname}`);

	// Handle CORS preflight
	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
	}

	if (pathname.startsWith("/api")) {
		if (!authenticateRequest(req, res, CORS_HEADERS, WEB_API_KEY)) {
			return;
		}
	}

	await router(req, res, pathname);
}

/**
 * Start the web server
 */
export async function startWebServer(port = 8080) {
	// Reload model config
	await reloadModelConfig();

	const server = createServer(handleRequest);

	server.listen(port, () => {
		console.log(`
🌐 Composer Web Server started!

   Local:   http://localhost:${port}
   API:     http://localhost:${port}/api
   
Ready to accept requests...
		`);
	});

	// Graceful shutdown
	process.on("SIGINT", () => {
		console.log("\nShutting down server...");
		server.close(() => {
			console.log("Server closed");
			process.exit(0);
		});
	});

	return server;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
	const port = Number.parseInt(process.env.PORT || "8080", 10);
	startWebServer(port);
}

export { SseSession };
