/**
 * Web server for Composer - HTTP/SSE API used by the web UI
 */

import { randomBytes } from "node:crypto";
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
	isOverloaded,
	logError,
	logRequest,
	logStartup,
	startStatsCollection,
	stopStatsCollection,
} from "./web/logger.js";
import {
	determineModelSelection,
	getRegisteredModelOrThrow,
} from "./web/model-selection.js";
import { RateLimiter } from "./web/rate-limiter.js";
import {
	type RequestContext,
	parseTraceParent,
	requestContextStorage,
} from "./web/request-context.js";
import { requestTracker } from "./web/request-tracker.js";
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

// Global crash handlers
function registerCrashHandlers() {
	process.on("uncaughtException", (error) => {
		logError(error);
		console.error("FATAL: Uncaught Exception. Exiting...");
		process.exit(1);
	});

	process.on("unhandledRejection", (reason) => {
		logError(
			reason instanceof Error
				? reason
				: new Error(`Unhandled Rejection: ${String(reason)}`),
		);
		console.error("FATAL: Unhandled Rejection. Exiting...");
		process.exit(1);
	});
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
const STATIC_MAX_AGE =
	Number.parseInt(
		process.env.COMPOSER_STATIC_MAX_AGE ||
			(process.env.NODE_ENV === "production" ? "86400" : "60"),
		10,
	) || 60;
const MAX_SSE_CONNECTIONS =
	Number.parseInt(process.env.COMPOSER_MAX_SSE_CONNECTIONS || "100", 10) || 100;
const REQUEST_TIMEOUT_MS =
	Number.parseInt(process.env.COMPOSER_REQUEST_TIMEOUT_MS || "60000", 10) ||
	60000;

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
		const [provider, ...modelParts] = this.currentKey.split("/");
		const modelId = modelParts.join("/");
		return provider && modelId ? { provider, modelId } : null;
	},
	reset() {
		this.currentKey = null;
	},
};

// Exposed for testing/internal use only
export const __modelSelectionStore = {
	set: (model: RegisteredModel) => modelSelectionStore.set(model),
	reset: () => modelSelectionStore.reset(),
	get: () => modelSelectionStore.get(),
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
			sendJson(res, 404, { error: "Not found" }, CORS_HEADERS, req);
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

// Active request tracking for graceful shutdown and debugging
const rateLimiter = new RateLimiter({ windowMs: 60000, max: 1000 }); // 1000 requests per minute per IP

function getClientIp(req: IncomingMessage): string {
	const forwarded = req.headers["x-forwarded-for"];
	if (typeof forwarded === "string") {
		return forwarded.split(",")[0].trim();
	}
	return req.socket.remoteAddress || "unknown";
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
	const start = performance.now();
	const parsedUrl = parse(req.url || "/", true);
	const pathname = parsedUrl.pathname || "/";
	const requestId = Math.random().toString(36).substring(2, 15);

	// Parse W3C Trace Context
	// traceparent: 00-traceid-spanid-flags
	const traceParent = req.headers.traceparent as string | undefined;
	const { traceId, parentSpanId } = parseTraceParent(traceParent);
	const spanId = randomBytes(8).toString("hex"); // New span for this service

	// Attach request to response for easy access in helpers
	(res as any).req = req;

	const context: RequestContext = {
		requestId,
		traceId,
		spanId,
		startTime: start,
		method: req.method || "GET",
		url: pathname,
	};

	// Set a hard timeout for processing
	// Skip for SSE endpoints which are meant to be long-lived
	if (!pathname.startsWith("/api/chat")) {
		// biome-ignore lint/style/useConst: needed for closure reference before assignment
		let timeout: NodeJS.Timeout;

		timeout = setTimeout(() => {
			if (!res.headersSent && !res.writableEnded) {
				requestContextStorage.run(context, () => {
					logError(`Request timeout for ${pathname} [${requestId}]`);
					const duration = performance.now() - start;
					recordApiRequest(req.method || "UNKNOWN", pathname, 504, duration, {
						requestId,
						traceId,
						spanId,
					});
				});
				res.writeHead(504, {
					"Content-Type": "application/json",
					...CORS_HEADERS,
				});
				res.end(JSON.stringify({ error: "Gateway Timeout" }));
				res.destroy();
			}
		}, REQUEST_TIMEOUT_MS);

		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
		};

		res.on("finish", cleanup);
		res.on("close", cleanup);
	}

	// Track request for introspection (Channelz) and graceful shutdown
	requestTracker.track(req, {
		id: requestId,
		method: req.method || "GET",
		url: pathname,
		startTime: start,
		userAgent: req.headers["user-agent"],
	});

	res.on("close", () => {
		requestTracker.untrack(req);
	});

	requestContextStorage.run(context, async () => {
		// 1. Criticality-Aware Load Shedding (Global health)
		// We prioritize /healthz, /api/metrics, and existing SSE connections
		// We drop new /api/chat requests if overloaded
		if (
			isOverloaded() &&
			pathname !== "/healthz" &&
			pathname !== "/api/metrics"
		) {
			// Drop non-critical traffic
			res.writeHead(503, {
				"Content-Type": "application/json",
				"Retry-After": "5",
				...CORS_HEADERS,
			});
			res.end(
				JSON.stringify({ error: "Service Unavailable: Server is overloaded" }),
			);
			return;
		}

		// 2. Rate limiting check (Per-client fairness)
		// Skip for static assets/health checks to avoid blocking legitimate browser behavior
		if (pathname.startsWith("/api")) {
			const ip = getClientIp(req);
			const { allowed, remaining, reset } = rateLimiter.check(ip);

			if (!allowed) {
				res.writeHead(429, {
					"Content-Type": "application/json",
					"X-RateLimit-Limit": "1000",
					"X-RateLimit-Remaining": "0",
					"X-RateLimit-Reset": Math.ceil(reset / 1000).toString(),
					"Retry-After": Math.ceil((reset - Date.now()) / 1000).toString(),
					...CORS_HEADERS,
				});
				res.end(
					JSON.stringify({ error: "Too Many Requests: Rate limit exceeded" }),
				);
				// Log the rejection immediately as it won't go through the router
				logRequest(req, 429, start);
				return;
			}
			// Add rate limit headers to successful responses too
			// Pass them to CORS headers so they are included in all responses (including errors)
			// Note: We modify the global CORS_HEADERS object for this request's response cycle
			// But since we can't easily inject them into router/helpers without changing signatures everywhere,
			// we use setHeader. Note that helpers using sendJson/writeHead must respect existing headers.
			// sendJson uses writeHead which merges headers.
			res.setHeader("X-RateLimit-Limit", "1000");
			res.setHeader("X-RateLimit-Remaining", remaining.toString());
			res.setHeader("X-RateLimit-Reset", Math.ceil(reset / 1000).toString());
		}

		res.on("finish", () => {
			const duration = performance.now() - start;
			logRequest(req, res.statusCode, start);
			recordApiRequest(
				req.method || "UNKNOWN",
				pathname,
				res.statusCode,
				duration,
				{ requestId, traceId, spanId },
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
	registerCrashHandlers();
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

	process.on("SIGINT", async () => {
		console.log("\nSIGINT received. Starting graceful shutdown...");
		stopStatsCollection();

		// Stop accepting new connections
		server.close();

		// Drain existing requests
		const activeCount = requestTracker.getCount();
		if (activeCount > 0) {
			console.log(`Waiting for ${activeCount} active requests to complete...`);
			const drainTimeout = setTimeout(() => {
				console.log("Drain timeout reached. Forcing shutdown...");
				for (const socket of sockets) {
					socket.destroy();
				}
				process.exit(0);
			}, 10000); // 10s drain timeout

			// Poll for drain
			const checkDrain = setInterval(() => {
				if (requestTracker.getCount() === 0) {
					clearInterval(checkDrain);
					clearTimeout(drainTimeout);
					console.log("All requests completed. Exiting.");
					process.exit(0);
				}
			}, 100);
		} else {
			console.log("No active requests. Exiting.");
			process.exit(0);
		}
	});

	return server;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
	const port = Number.parseInt(process.env.PORT || "8080", 10);
	startWebServer(port);
}
