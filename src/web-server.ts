/**
 * Web server for Composer - HTTP/SSE API used by the web UI
 */

import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, parse } from "node:url";
import {
	ActionApprovalService,
	type ApprovalMode,
} from "./agent/action-approval.js";
import { Agent, ProviderTransport } from "./agent/index.js";
import type { ThinkingLevel } from "./agent/types.js";
import { buildSystemPrompt } from "./cli/system-prompt.js";
import { loadEnv } from "./load-env.js";
import type { RegisteredModel } from "./models/registry.js";
import {
	getFactoryDefaultModelSelection,
	reloadModelConfig,
} from "./models/registry.js";
import { getEnvVarsForProvider } from "./providers/api-keys.js";
import {
	type AuthCredential,
	type AuthMode,
	createAuthResolver,
} from "./providers/auth.js";
import { recordApiRequest } from "./telemetry.js";
import { codingTools } from "./tools/index.js";
import type { WebServerContext } from "./web/app-context.js";
import {
	logRequest,
	logStartup,
	startStatsCollection,
	stopStatsCollection,
} from "./web/logger.js";
import {
	determineModelSelection,
	getRegisteredModelOrThrow,
} from "./web/model-selection.js";
import {
	type RequestContext,
	requestContextStorage,
} from "./web/request-context.js";
import { createRequestHandler } from "./web/router.js";
import { createRoutes } from "./web/routes.js";
import {
	ApiError,
	authenticateRequest,
	createCorsHeaders,
	sendJson,
} from "./web/server-utils.js";
import { serveStatic } from "./web/static-server.js";

// Re-export for existing test imports
export { SseSession } from "./web/sse-session.js";

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
const STATIC_MAX_AGE =
	Number.parseInt(
		process.env.COMPOSER_STATIC_MAX_AGE ||
			(process.env.NODE_ENV === "production" ? "86400" : "60"),
		10,
	) || 60;
const MAX_SSE_CONNECTIONS =
	Number.parseInt(process.env.COMPOSER_MAX_SSE_CONNECTIONS || "100", 10) || 100;
const sseLimiter = {
	active: 0,
	max: MAX_SSE_CONNECTIONS,
	tryAcquire(): symbol | null {
		if (this.active >= this.max) return null;
		this.active += 1;
		return Symbol("sse-lease");
	},
	release(token: symbol | null) {
		if (!token) return;
		if (this.active > 0) this.active -= 1;
	},
};

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

/**
 * Process-local selection store (keeps last chosen model for convenience only).
 * This avoids cross-request mutations elsewhere and can be replaced with
 * per-session selection later without blocking concurrent requests.
 */
const modelSelectionStore = {
	currentKey: null as string | null,
	set(model: RegisteredModel) {
		this.currentKey = `${model.provider}/${model.id}`;
	},
	get(): { provider: string; modelId: string } | null {
		if (!this.currentKey) return null;
		const [provider, modelId] = this.currentKey.split("/");
		return provider && modelId ? { provider, modelId } : null;
	},
	reset() {
		this.currentKey = null;
	},
};

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

async function ensureCredential(provider: string): Promise<AuthCredential> {
	const credential = await authResolver(provider);
	if (credential) {
		return credential;
	}
	throw new ApiError(401, buildMissingCredentialMessage(provider));
}

async function getRegisteredModel(input: string | null | undefined) {
	const selection = determineModelSelection(
		input,
		DEFAULT_PROVIDER,
		DEFAULT_MODEL_ID,
	);
	const registeredModel = getRegisteredModelOrThrow(selection);
	await ensureCredential(registeredModel.provider);
	modelSelectionStore.set(registeredModel);
	return registeredModel;
}

function getCurrentSelection(): { provider: string; modelId: string } {
	const stored = modelSelectionStore.get();
	if (stored) return stored;
	const factoryDefault = getFactoryDefaultModelSelection();
	if (factoryDefault) return factoryDefault;
	return { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL_ID };
}

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_ROOT = join(__dirname, "../packages/web");
const ALLOWED_ORIGIN = DEFAULT_WEB_ORIGIN;
const CORS_HEADERS = createCorsHeaders(ALLOWED_ORIGIN);

const context: WebServerContext = {
	corsHeaders: CORS_HEADERS,
	staticMaxAge: STATIC_MAX_AGE,
	defaultApprovalMode: DEFAULT_APPROVAL_MODE,
	defaultProvider: DEFAULT_PROVIDER,
	defaultModelId: DEFAULT_MODEL_ID,
	createAgent,
	getRegisteredModel,
	getCurrentSelection,
	ensureCredential,
	setModelSelection: (model) => modelSelectionStore.set(model),
	acquireSse: () => sseLimiter.tryAcquire(),
	releaseSse: (token) => sseLimiter.release(token),
};

const routes = createRoutes(context);

const router = createRequestHandler(
	routes,
	(req, res, pathname) => {
		if (pathname.startsWith("/api")) {
			sendJson(res, 404, { error: "Not found" }, CORS_HEADERS);
			return;
		}
		serveStatic(pathname, req, res, {
			webRoot: WEB_ROOT,
			corsHeaders: CORS_HEADERS,
			maxAgeSeconds: STATIC_MAX_AGE,
		});
	},
	CORS_HEADERS,
);

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
	const start = performance.now();
	const parsedUrl = parse(req.url || "/", true);
	const pathname = parsedUrl.pathname || "/";
	const requestId = Math.random().toString(36).substring(2, 15);

	const context: RequestContext = {
		requestId,
		startTime: start,
		method: req.method || "GET",
		url: pathname,
	};

	requestContextStorage.run(context, async () => {
		res.on("finish", () => {
			const duration = performance.now() - start;
			logRequest(req, res.statusCode, start);
			recordApiRequest(
				req.method || "UNKNOWN",
				pathname,
				res.statusCode,
				duration,
				{ requestId },
			);
		});

		// CORS preflight
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
	});
}

export async function startWebServer(port = 8080) {
	await reloadModelConfig();

	const server = createServer(handleRequest);
	const sockets = new Set<Socket>();

	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => {
			sockets.delete(socket);
		});
	});

	server.listen(port, () => {
		logStartup(port);
		startStatsCollection();
	});

	process.on("SIGINT", () => {
		console.log("\nShutting down server...");
		stopStatsCollection();

		// Close all open sockets
		for (const socket of sockets) {
			socket.destroy();
		}

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
