/**
 * Web server for Composer - HTTP/SSE API used by the web UI
 */

import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, parse } from "node:url";
import {
	ActionApprovalService,
	type ApprovalMode,
} from "./agent/action-approval.js";
import { Agent, ProviderTransport } from "./agent/index.js";
import type { Provider, ThinkingLevel } from "./agent/types.js";
import { buildSystemPrompt } from "./cli/system-prompt.js";
import { loadEnv } from "./load-env.js";
import type { RegisteredModel } from "./models/registry.js";
import {
	getFactoryDefaultModelSelection,
	getRegisteredModels,
	reloadModelConfig,
} from "./models/registry.js";
import { getEnvVarsForProvider } from "./providers/api-keys.js";
import {
	type AuthCredential,
	type AuthMode,
	createAuthResolver,
} from "./providers/auth.js";
import { codingTools } from "./tools/index.js";
import { handleChat } from "./web/handlers/chat.js";
import { handleConfig } from "./web/handlers/config.js";
import { handleModel, handleModels } from "./web/handlers/models.js";
import { handleSessions } from "./web/handlers/sessions.js";
import { handleStatus } from "./web/handlers/status.js";
import { handleUsage } from "./web/handlers/usage.js";
import {
	determineModelSelection,
	getRegisteredModelOrThrow,
} from "./web/model-selection.js";
import { type Route, createRequestHandler } from "./web/router.js";
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
let currentModelKey: string | null = null;

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
	currentModelKey = `${registeredModel.provider}/${registeredModel.id}`;
	return registeredModel;
}

function getCurrentSelection(): { provider: string; modelId: string } {
	if (currentModelKey) {
		const [provider, modelId] = currentModelKey.split("/");
		if (provider && modelId) return { provider, modelId };
	}
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

const routes: Route[] = [
	{
		method: "GET",
		path: "/api/models",
		handler: (_req, res) => handleModels(res, CORS_HEADERS),
	},
	{
		method: "GET",
		path: "/api/status",
		handler: (_req, res) => handleStatus(res, CORS_HEADERS),
	},
	{
		method: "GET",
		path: "/api/config",
		handler: (req, res) => handleConfig(req, res, CORS_HEADERS),
	},
	{
		method: "POST",
		path: "/api/config",
		handler: (req, res) => handleConfig(req, res, CORS_HEADERS),
	},
	{
		method: "GET",
		path: "/api/usage",
		handler: (req, res) => handleUsage(req, res, CORS_HEADERS),
	},
	{
		method: "GET",
		path: "/api/model",
		handler: async (req, res) =>
			handleModel(
				req,
				res,
				CORS_HEADERS,
				{
					...getCurrentSelection(),
				},
				ensureCredential,
				(model) => {
					currentModelKey = `${model.provider}/${model.id}`;
				},
			),
	},
	{
		method: "POST",
		path: "/api/model",
		handler: async (req, res) =>
			handleModel(
				req,
				res,
				CORS_HEADERS,
				{
					...getCurrentSelection(),
				},
				ensureCredential,
				(model) => {
					currentModelKey = `${model.provider}/${model.id}`;
				},
			),
	},
	{
		method: "POST",
		path: "/api/chat",
		handler: (req, res) =>
			handleChat(req, res, CORS_HEADERS, {
				createAgent: async (model, thinking, approval) =>
					createAgent(
						model,
						thinking as ThinkingLevel,
						approval as ApprovalMode,
					),
				getRegisteredModel,
				defaultApprovalMode: DEFAULT_APPROVAL_MODE,
				defaultProvider: DEFAULT_PROVIDER,
				defaultModelId: DEFAULT_MODEL_ID,
			}),
	},
	{
		method: "GET",
		path: "/api/sessions",
		handler: (req, res) => handleSessions(req, res, {}, CORS_HEADERS),
	},
	{
		method: "POST",
		path: "/api/sessions",
		handler: (req, res) => handleSessions(req, res, {}, CORS_HEADERS),
	},
	{
		method: "GET",
		path: "/api/sessions/:id",
		handler: (req, res, params) =>
			handleSessions(req, res, params, CORS_HEADERS),
	},
	{
		method: "DELETE",
		path: "/api/sessions/:id",
		handler: (req, res, params) =>
			handleSessions(req, res, params, CORS_HEADERS),
	},
];

const router = createRequestHandler(routes, (req, res, pathname) => {
	if (pathname.startsWith("/api")) {
		sendJson(res, 404, { error: "Not found" }, CORS_HEADERS);
		return;
	}
	serveStatic(pathname, req, res, {
		webRoot: WEB_ROOT,
		corsHeaders: CORS_HEADERS,
		maxAgeSeconds: STATIC_MAX_AGE,
	});
});

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
	const parsedUrl = parse(req.url || "/", true);
	const pathname = parsedUrl.pathname || "/";

	console.log(`${req.method} ${pathname}`);

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
}

export async function startWebServer(port = 8080) {
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
