/**
 * Web server for Composer - HTTP/WebSocket API for web UI
 */

import { execSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import { dirname, join, normalize } from "node:path";
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
	getFactoryDefaultModelSelection,
	getRegisteredModels,
	reloadModelConfig,
	resolveAlias,
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
	convertAppMessagesToComposer,
	convertComposerMessagesToApp,
} from "./web/session-serialization.js";

loadEnv();

class ApiError extends Error {
	constructor(
		public statusCode: number,
		message: string,
	) {
		super(message);
	}
}

interface ModelSelection {
	provider: string;
	modelId: string;
}

interface ParsedModelInput {
	provider?: string;
	modelId?: string;
}

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

function getRequestToken(req: IncomingMessage): string | null {
	const authHeader = req.headers.authorization;
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.slice(7).trim() || null;
	}
	const apiKeyHeader = req.headers["x-composer-api-key"];
	if (Array.isArray(apiKeyHeader)) {
		return apiKeyHeader[0]?.trim() || null;
	}
	if (typeof apiKeyHeader === "string") {
		return apiKeyHeader.trim() || null;
	}
	return null;
}

function secureCompare(value: string, secret: string): boolean {
	const hashProvided = createHash("sha256").update(value).digest();
	const hashSecret = createHash("sha256").update(secret).digest();
	return timingSafeEqual(hashProvided, hashSecret);
}

function authenticateRequest(
	req: IncomingMessage,
	res: ServerResponse,
): boolean {
	if (!WEB_API_KEY) {
		return true;
	}
	const provided = getRequestToken(req);
	if (!provided || !secureCompare(provided, WEB_API_KEY)) {
		if (!res.writableEnded) {
			res.writeHead(401, {
				"Content-Type": "application/json",
				...CORS_HEADERS,
			});
			res.end(JSON.stringify({ error: "Unauthorized" }));
		}
		return false;
	}
	return true;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	if (res.writableEnded) return;
	res.writeHead(status, {
		"Content-Type": "application/json",
		...CORS_HEADERS,
	});
	res.end(JSON.stringify(payload));
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

function parseModelInput(modelInput?: string | null): ParsedModelInput {
	const normalized = modelInput?.trim();
	if (!normalized) {
		return {};
	}

	const delimiter = normalized.includes(":")
		? ":"
		: normalized.includes("/")
			? "/"
			: null;

	if (!delimiter) {
		return { modelId: normalized };
	}

	const parts = normalized.split(delimiter);
	if (parts.length !== 2) {
		throw new ApiError(400, `Invalid model format: "${normalized}"`);
	}

	const [providerPart, modelPart] = parts;
	const provider = providerPart?.trim() || undefined;
	const modelId = modelPart?.trim() || undefined;
	return { provider, modelId };
}

function resolveModelAlias(parts: ParsedModelInput): ParsedModelInput {
	if (!parts.modelId) {
		return parts;
	}
	const alias = resolveAlias(parts.modelId);
	if (!alias) {
		return parts;
	}
	if (parts.provider && parts.provider !== alias.provider) {
		throw new ApiError(
			400,
			`Alias "${parts.modelId}" maps to ${alias.provider}/${alias.modelId}, but provider "${parts.provider}" was requested`,
		);
	}
	return { provider: alias.provider, modelId: alias.modelId };
}

function determineModelSelection(modelInput?: string | null): ModelSelection {
	let parts = parseModelInput(modelInput);
	parts = resolveModelAlias(parts);

	if (parts.provider && !parts.modelId) {
		throw new ApiError(400, "Model id is required when specifying a provider");
	}

	if (!parts.provider && parts.modelId) {
		parts.provider = DEFAULT_PROVIDER;
	}

	if (!parts.provider && !parts.modelId) {
		const factoryDefault = getFactoryDefaultModelSelection();
		if (factoryDefault) {
			return {
				provider: factoryDefault.provider,
				modelId: factoryDefault.modelId,
			};
		}
		return {
			provider: DEFAULT_PROVIDER,
			modelId: DEFAULT_MODEL_ID,
		};
	}

	const finalProvider = parts.provider;
	const finalModelId = parts.modelId;
	if (!finalProvider || !finalModelId) {
		throw new ApiError(400, "Model selection is incomplete");
	}

	return {
		provider: finalProvider,
		modelId: finalModelId,
	};
}

function getRegisteredModelOrThrow(selection: ModelSelection): RegisteredModel {
	const registeredModel = getRegisteredModels().find(
		(entry) =>
			entry.provider === selection.provider && entry.id === selection.modelId,
	);
	if (!registeredModel) {
		throw new ApiError(
			404,
			`Model ${selection.provider}/${selection.modelId} not found in registry`,
		);
	}
	return registeredModel;
}

function respondWithApiError(
	res: ServerResponse,
	error: unknown,
	fallbackStatus = 500,
): boolean {
	if (error instanceof ApiError) {
		sendJson(res, error.statusCode, { error: error.message });
		return true;
	}
	if (fallbackStatus) {
		sendJson(res, fallbackStatus, {
			error: error instanceof Error ? error.message : "Internal server error",
		});
		return true;
	}
	return false;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

/**
 * CORS headers for web requests
 */
const ALLOWED_ORIGIN = DEFAULT_WEB_ORIGIN;
const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": ALLOWED_ORIGIN,
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers":
		"Content-Type, Authorization, X-Composer-Api-Key, X-Composer-Approval-Mode",
	"Access-Control-Max-Age": "86400",
};

if (ALLOWED_ORIGIN !== "*") {
	CORS_HEADERS["Access-Control-Allow-Credentials"] = "true";
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_BODY_BYTES = 1_000_000;

interface SseContext {
	sessionId?: string;
	modelKey?: string;
	requestId?: string;
}

type SseSkipListener = (metrics: {
	sent: number;
	skipped: number;
	lastError?: unknown;
	context?: SseContext;
}) => void;

type SseResponse = Pick<
	ServerResponse<IncomingMessage>,
	"write" | "end" | "writable" | "writableEnded" | "destroyed"
> & {
	flushHeaders?: () => void;
};

class SseSession {
	private closed = false;
	private heartbeat?: NodeJS.Timeout;
	private skippedWrites = 0;
	private sentWrites = 0;
	private lastError?: unknown;
	private context: SseContext = {};
	constructor(
		private readonly res: SseResponse,
		private readonly onSkip?: SseSkipListener,
		context?: SseContext,
	) {
		if (context) {
			this.context = context;
		}
		if (typeof res.flushHeaders === "function") {
			try {
				res.flushHeaders();
			} catch {
				// Ignore flush errors; writes are still guarded
			}
		}
	}

	private canWrite(): boolean {
		return (
			!!this.res &&
			this.res.writable !== false &&
			!this.res.writableEnded &&
			!this.res.destroyed
		);
	}

	private write(payload: string): boolean {
		if (!this.canWrite()) {
			this.skippedWrites++;
			this.notifySkip();
			return false;
		}
		try {
			this.res.write(payload);
			this.sentWrites++;
			return true;
		} catch (error) {
			this.skippedWrites++;
			this.lastError = error;
			console.debug(
				"SSE write skipped after disconnect",
				error instanceof Error ? error.message : error,
			);
			this.notifySkip();
			return false;
		}
	}

	sendEvent(event: AgentEvent): void {
		const data = JSON.stringify(event);
		this.write(`data: ${data}\n\n`);
	}

	sendSessionUpdate(sessionId: string): void {
		const payload = { type: "session_update", sessionId };
		this.write(`data: ${JSON.stringify(payload)}\n\n`);
	}

	sendHeartbeat(): void {
		this.write('data: {"type":"heartbeat"}\n\n');
	}

	sendAborted(): void {
		this.write('data: {"type":"aborted"}\n\n');
	}

	sendDone(): void {
		this.write("data: [DONE]\n\n");
	}

	startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeat = setInterval(
			() => this.sendHeartbeat(),
			HEARTBEAT_INTERVAL_MS,
		);
	}

	stopHeartbeat(): void {
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
		}
	}

	end(): void {
		if (this.closed) return;
		this.closed = true;
		this.stopHeartbeat();
		if (!this.canWrite()) {
			return;
		}
		try {
			this.res.end();
		} catch (error) {
			this.skippedWrites++;
			this.lastError = error;
			console.debug(
				"SSE end skipped after disconnect",
				error instanceof Error ? error.message : error,
			);
			this.notifySkip();
		}
	}

	getMetrics(): { sent: number; skipped: number; lastError?: unknown } {
		return {
			sent: this.sentWrites,
			skipped: this.skippedWrites,
			lastError: this.lastError,
		};
	}

	setContext(context: SseContext): void {
		this.context = { ...this.context, ...context };
	}

	private notifySkip(): void {
		if (this.skippedWrites <= 1) return;
		if (this.onSkip) {
			this.onSkip({
				sent: this.sentWrites,
				skipped: this.skippedWrites,
				lastError: this.lastError,
				context: this.context,
			});
		}
	}
}

/**
 * Server-Sent Events (SSE) streaming for chat responses
 */
function sendSSE(session: SseSession, event: AgentEvent) {
	session.sendEvent(event);
}

function sendSessionUpdate(session: SseSession, sessionId: string) {
	session.sendSessionUpdate(sessionId);
}

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

	sendJson(res, 200, { models: modelList });
}

/**
 * Handle /api/status - Get server and workspace status
 */
function handleStatus(res: ServerResponse) {
	try {
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
		};

		sendJson(res, 200, status);
	} catch (error) {
		respondWithApiError(res, error, 500);
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
			sendJson(res, 200, { config, configPath });
		} catch (error) {
			respondWithApiError(res, error, 500);
		}
	} else if (req.method === "POST") {
		try {
			const { config } = await readJsonBody<{ config: unknown }>(req);
			const configPath = getCustomConfigPath();
			writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
			await reloadModelConfig();
			sendJson(res, 200, { success: true });
		} catch (error) {
			respondWithApiError(res, error, 500);
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

		sendJson(res, 200, { summary, hasData });
	} catch (error) {
		respondWithApiError(res, error, 500);
	}
}

function respondWithModel(res: ServerResponse, model: RegisteredModel) {
	sendJson(res, 200, {
		id: model.id,
		provider: model.provider,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
	});
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
				sendJson(res, 400, { error: "Model is required" });
				return;
			}

			const selection = determineModelSelection(modelInput);
			const registeredModel = getRegisteredModelOrThrow(selection);
			await ensureCredential(registeredModel.provider);
			currentModelKey = `${registeredModel.provider}/${registeredModel.id}`;
			respondWithModel(res, registeredModel);
		} catch (error) {
			respondWithApiError(res, error, 400);
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

		const selection = determineModelSelection(chatReq.model);
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
			sendJson(res, 400, { error: "No messages supplied" });
			return;
		}

		const latestMessage = incomingMessages[incomingMessages.length - 1];
		if (!latestMessage || latestMessage.role !== "user") {
			sendJson(res, 400, { error: "Last message must be a user message" });
			return;
		}

		const userInput = (latestMessage.content ?? "").trim();
		if (!userInput) {
			sendJson(res, 400, { error: "User message cannot be empty" });
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
		respondWithApiError(res, error, 500);
	}
}

/**
 * Handle /api/sessions - List and manage sessions
 */
async function handleSessions(
	req: IncomingMessage,
	res: ServerResponse,
	pathname: string,
) {
	const sessionManager = new SessionManager(true);
	const sessionIdPattern = /^[a-zA-Z0-9._-]+$/;

	try {
		// GET /api/sessions - List all sessions
		if (req.method === "GET" && pathname === "/api/sessions") {
			const sessions = await sessionManager.listSessions();
			const sessionList: ComposerSessionSummary[] = sessions.map((s) => ({
				id: s.id,
				title: s.title || `Session ${s.id.slice(0, 8)}`,
				createdAt: s.createdAt || new Date().toISOString(),
				updatedAt: s.updatedAt || new Date().toISOString(),
				messageCount: s.messageCount || 0,
			}));

			sendJson(res, 200, { sessions: sessionList });
		}
		// GET /api/sessions/:id - Get specific session
		else if (req.method === "GET" && pathname.startsWith("/api/sessions/")) {
			const sessionId = pathname.replace("/api/sessions/", "");
			if (!sessionIdPattern.test(sessionId)) {
				sendJson(res, 400, { error: "Invalid session id" });
				return;
			}
			const session = await sessionManager.loadSession(sessionId);

			if (!session) {
				sendJson(res, 404, { error: "Session not found" });
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

			sendJson(res, 200, responseBody);
		}
		// POST /api/sessions - Create new session
		else if (req.method === "POST" && pathname === "/api/sessions") {
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

			sendJson(res, 201, responseBody);
		}
		// DELETE /api/sessions/:id - Delete session
		else if (req.method === "DELETE" && pathname.startsWith("/api/sessions/")) {
			const sessionId = pathname.replace("/api/sessions/", "");
			if (!sessionIdPattern.test(sessionId)) {
				sendJson(res, 400, { error: "Invalid session id" });
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
		respondWithApiError(res, error, 500);
	}
}

/**
 * Serve static files from web package
 */
function serveStatic(pathname: string, res: ServerResponse) {
	// Map paths to files
	const webRoot = join(__dirname, "../packages/web");
	let filePath: string;

	if (pathname === "/" || pathname === "") {
		filePath = join(webRoot, "index.html");
	} else if (pathname.startsWith("/src/")) {
		// Serve source files for dev mode
		filePath = join(webRoot, pathname);
	} else {
		filePath = join(webRoot, pathname);
	}

	const normalizedPath = normalize(filePath);
	if (!normalizedPath.startsWith(webRoot)) {
		res.writeHead(403, { "Content-Type": "text/plain" });
		res.end("Forbidden");
		return;
	}

	if (!existsSync(filePath)) {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not Found");
		return;
	}

	// Determine content type
	const ext = filePath.split(".").pop();
	const contentTypes: Record<string, string> = {
		html: "text/html",
		js: "application/javascript",
		ts: "application/typescript",
		css: "text/css",
		json: "application/json",
	};

	const contentType = contentTypes[ext || ""] || "text/plain";

	try {
		const content = readFileSync(filePath);
		res.writeHead(200, {
			"Content-Type": contentType,
			...CORS_HEADERS,
		});
		res.end(content);
	} catch (error) {
		console.error("Error serving file:", error);
		res.writeHead(500, { "Content-Type": "text/plain" });
		res.end("Internal Server Error");
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
		if (!authenticateRequest(req, res)) {
			return;
		}
	}

	// API routes
	if (pathname === "/api/models" && req.method === "GET") {
		handleModels(res);
	} else if (pathname === "/api/model") {
		await handleModel(req, res);
	} else if (pathname === "/api/status" && req.method === "GET") {
		handleStatus(res);
	} else if (
		pathname === "/api/config" &&
		(req.method === "GET" || req.method === "POST")
	) {
		await handleConfig(req, res);
	} else if (pathname === "/api/usage" && req.method === "GET") {
		handleUsage(req, res);
	} else if (pathname === "/api/chat" && req.method === "POST") {
		await handleChat(req, res);
	} else if (pathname.startsWith("/api/sessions")) {
		await handleSessions(req, res, pathname);
	}
	// Static files
	else {
		serveStatic(pathname, res);
	}
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
