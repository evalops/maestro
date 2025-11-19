/**
 * Web server for Composer - HTTP/WebSocket API for web UI
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, parse } from "node:url";
import type {
	ComposerChatRequest,
	ComposerMessage,
	ComposerSession,
	ComposerSessionSummary,
} from "@evalops/contracts";
import { ActionApprovalService } from "./agent/action-approval.js";
import { Agent, ProviderTransport } from "./agent/index.js";
import type { AgentEvent, ThinkingLevel } from "./agent/types.js";
import {
	buildSystemPrompt,
	loadProjectContextFiles,
} from "./cli/system-prompt.js";
import { loadEnv } from "./load-env.js";
import {
	type RegisteredModel,
	getComposerCustomConfig,
	getCustomConfigPath,
	getRegisteredModels,
	reloadModelConfig,
	resolveModel,
} from "./models/registry.js";
import { createAuthResolver } from "./providers/auth.js";
import { SessionManager, toSessionModelMetadata } from "./session-manager.js";
import { codingTools } from "./tools/index.js";
import { getUsageFilePath, getUsageSummary } from "./tracking/cost-tracker.js";
import {
	convertAppMessagesToComposer,
	convertComposerMessagesToApp,
} from "./web/session-serialization.js";

loadEnv();

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
const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Access-Control-Max-Age": "86400",
};

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Server-Sent Events (SSE) streaming for chat responses
 */
function sendSSE(res: any, event: AgentEvent) {
	const data = JSON.stringify(event);
	res.write(`data: ${data}\n\n`);
}

function sendSessionUpdate(res: any, sessionId: string) {
	const payload = { type: "session_update", sessionId };
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startHeartbeat(res: any) {
	return setInterval(() => {
		if (res.writableEnded) return;
		res.write('data: {"type":"heartbeat"}\n\n');
	}, HEARTBEAT_INTERVAL_MS);
}

/**
 * Create and configure Composer agent
 */
async function createAgent(
	registeredModel: RegisteredModel,
	sessionManager: SessionManager,
	thinkingLevel: ThinkingLevel = "off",
): Promise<Agent> {
	const authResolver = createAuthResolver({ mode: "auto" });

	// ProviderTransport takes options, not model directly
	const transport = new ProviderTransport({
		getAuthContext: async (provider: string) => authResolver(provider),
	});

	// Load system prompt from context files
	const contextFiles = loadProjectContextFiles();
	let systemPrompt = "";
	for (const file of contextFiles) {
		systemPrompt += `\n\n${file.content}`;
	}
	systemPrompt = systemPrompt.trim();

	// Create approval service (auto-approve for web mode)
	const approvalService = new ActionApprovalService("auto");

	const agent = new Agent({
		transport,
		initialState: {
			systemPrompt,
			model: registeredModel, // Pass the full RegisteredModel which extends Model<Api>
			thinkingLevel,
			tools: codingTools,
		},
	});

	return agent;
}

/**
 * Handle /api/models - List available models
 */
function handleModels(res: any) {
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

	res.writeHead(200, {
		"Content-Type": "application/json",
		...CORS_HEADERS,
	});
	res.end(JSON.stringify({ models: modelList }));
}

/**
 * Handle /api/status - Get server and workspace status
 */
function handleStatus(res: any) {
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

	const hasAgentMd = existsSync(join(cwd, "AGENT.md"));
	const hasClaudeMd = existsSync(join(cwd, "CLAUDE.md"));

	const status = {
		cwd,
		git: gitBranch ? { branch: gitBranch, status: gitStatus } : null,
		context: {
			agentMd: hasAgentMd,
			claudeMd: hasClaudeMd,
		},
		server: {
			uptime: process.uptime(),
			version: process.version,
		},
	};

	res.writeHead(200, {
		"Content-Type": "application/json",
		...CORS_HEADERS,
	});
	res.end(JSON.stringify(status));
}

/**
 * Handle /api/config - Get and update configuration
 */
async function handleConfig(req: any, res: any) {
	if (req.method === "GET") {
		try {
			const config = getComposerCustomConfig();
			const configPath = getCustomConfigPath();

			res.writeHead(200, {
				"Content-Type": "application/json",
				...CORS_HEADERS,
			});
			res.end(JSON.stringify({ config, configPath }));
		} catch (error) {
			res.writeHead(500, {
				"Content-Type": "application/json",
				...CORS_HEADERS,
			});
			res.end(
				JSON.stringify({
					error:
						error instanceof Error ? error.message : "Failed to load config",
				}),
			);
		}
	} else if (req.method === "POST") {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});

		req.on("end", async () => {
			try {
				const { config } = JSON.parse(body);
				const configPath = getCustomConfigPath();

				// Write new config
				writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

				// Reload registry
				await reloadModelConfig();

				res.writeHead(200, {
					"Content-Type": "application/json",
					...CORS_HEADERS,
				});
				res.end(JSON.stringify({ success: true }));
			} catch (error) {
				res.writeHead(500, {
					"Content-Type": "application/json",
					...CORS_HEADERS,
				});
				res.end(
					JSON.stringify({
						error:
							error instanceof Error ? error.message : "Failed to save config",
					}),
				);
			}
		});
	}
}

/**
 * Handle /api/usage - Get cost tracking and usage statistics
 */
function handleUsage(req: any, res: any) {
	try {
		const parsedUrl = parse(req.url, true);
		const { since, until } = parsedUrl.query;

		const options: any = {};
		if (since) options.since = Number.parseInt(since as string, 10);
		if (until) options.until = Number.parseInt(until as string, 10);

		const summary = getUsageSummary(options);
		const usageFile = getUsageFilePath();
		const hasData = existsSync(usageFile);

		res.writeHead(200, {
			"Content-Type": "application/json",
			...CORS_HEADERS,
		});
		res.end(JSON.stringify({ summary, hasData }));
	} catch (error) {
		res.writeHead(500, {
			"Content-Type": "application/json",
			...CORS_HEADERS,
		});
		res.end(
			JSON.stringify({
				error:
					error instanceof Error ? error.message : "Failed to get usage data",
			}),
		);
	}
}

function respondWithModel(res: any, model: RegisteredModel) {
	res.writeHead(200, {
		"Content-Type": "application/json",
		...CORS_HEADERS,
	});
	res.end(
		JSON.stringify({
			id: model.id,
			provider: model.provider,
			name: model.name,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			reasoning: model.reasoning,
		}),
	);
}

async function handleModel(req: any, res: any) {
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
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});

		req.on("end", () => {
			try {
				const payload = JSON.parse(body || "{}");
				const modelInput = (payload.model || "").trim();
				if (!modelInput) {
					res.writeHead(400, {
						"Content-Type": "application/json",
						...CORS_HEADERS,
					});
					res.end(JSON.stringify({ error: "Model is required" }));
					return;
				}

				const [providerPart, modelPart] = modelInput.includes(":")
					? modelInput.split(":", 2)
					: modelInput.includes("/")
						? modelInput.split("/", 2)
						: ["anthropic", modelInput];
				const provider = providerPart || "anthropic";
				const modelId = modelPart || modelInput;

				const resolved = resolveModel(provider, modelId);
				if (!resolved) {
					res.writeHead(404, {
						"Content-Type": "application/json",
						...CORS_HEADERS,
					});
					res.end(
						JSON.stringify({
							error: `Model ${provider}/${modelId} not found`,
						}),
					);
					return;
				}

				const registeredModel = getRegisteredModels().find(
					(entry) =>
						entry.provider === resolved.provider && entry.id === resolved.id,
				);
				if (!registeredModel) {
					res.writeHead(500, {
						"Content-Type": "application/json",
						...CORS_HEADERS,
					});
					res.end(JSON.stringify({ error: "Model not properly registered" }));
					return;
				}

				currentModelKey = `${registeredModel.provider}/${registeredModel.id}`;
				respondWithModel(res, registeredModel);
			} catch (error) {
				res.writeHead(400, {
					"Content-Type": "application/json",
					...CORS_HEADERS,
				});
				res.end(
					JSON.stringify({
						error: error instanceof Error ? error.message : "Invalid payload",
					}),
				);
			}
		});
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
async function handleChat(req: any, res: any) {
	let body = "";
	req.on("data", (chunk: Buffer) => {
		body += chunk.toString();
	});

	req.on("end", async () => {
		try {
			const chatReq: ComposerChatRequest = JSON.parse(body);

			const modelInput = chatReq.model || "claude-sonnet-4-5";
			const [provider, modelId] = modelInput.includes(":")
				? modelInput.split(":", 2)
				: ["anthropic", modelInput];
			const model = resolveModel(provider, modelId);
			if (!model) {
				res.writeHead(404, {
					"Content-Type": "application/json",
					...CORS_HEADERS,
				});
				res.end(JSON.stringify({ error: `Model ${modelInput} not found` }));
				return;
			}

			const sessionManager = new SessionManager(false);
			if (chatReq.sessionId) {
				const sessionFile = sessionManager.getSessionFileById(
					chatReq.sessionId,
				);
				if (sessionFile) {
					sessionManager.setSessionFile(sessionFile);
				}
			}

			const registeredModel = getRegisteredModels().find(
				(m) => m.provider === model.provider && m.id === model.id,
			);
			if (!registeredModel) {
				res.writeHead(500, {
					"Content-Type": "application/json",
					...CORS_HEADERS,
				});
				res.end(JSON.stringify({ error: "Model not properly registered" }));
				return;
			}

			const agent = await createAgent(
				registeredModel,
				sessionManager,
				chatReq.thinkingLevel || "off",
			);

			const incomingMessages = Array.isArray(chatReq.messages)
				? (chatReq.messages as ComposerMessage[])
				: [];
			if (incomingMessages.length === 0) {
				res.writeHead(400, {
					"Content-Type": "application/json",
					...CORS_HEADERS,
				});
				res.end(JSON.stringify({ error: "No messages supplied" }));
				return;
			}

			const latestMessage = incomingMessages[incomingMessages.length - 1];
			if (!latestMessage || latestMessage.role !== "user") {
				res.writeHead(400, {
					"Content-Type": "application/json",
					...CORS_HEADERS,
				});
				res.end(
					JSON.stringify({ error: "Last message must be a user message" }),
				);
				return;
			}

			const userInput = (latestMessage.content ?? "").trim();
			if (!userInput) {
				res.writeHead(400, {
					"Content-Type": "application/json",
					...CORS_HEADERS,
				});
				res.end(JSON.stringify({ error: "User message cannot be empty" }));
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

			const heartbeatInterval = startHeartbeat(res);
			let cleanedUp = false;

			const unsubscribe = agent.subscribe((event: AgentEvent) => {
				sendSSE(res, event);

				if (event.type === "message_end") {
					sessionManager.saveMessage(event.message);
					if (sessionManager.shouldInitializeSession(agent.state.messages)) {
						sessionManager.startSession(agent.state);
						sendSessionUpdate(res, sessionManager.getSessionId());
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
				clearInterval(heartbeatInterval);
				req.off("close", handleConnectionClose);
				res.off("close", handleConnectionClose);
				unsubscribe();
				await sessionManager.flush();
				if (!res.writableEnded) {
					if (aborted) {
						res.write('data: {"type":"aborted"}\n\n');
					}
					res.end();
				}
			};

			try {
				await agent.prompt(userInput);
				if (!res.writableEnded) {
					res.write("data: [DONE]\n\n");
				}
			} catch (error) {
				console.error("Agent prompt error:", error);
				sendSSE(res, {
					type: "error",
					message: error instanceof Error ? error.message : "Unknown error",
				} as any);
			} finally {
				await cleanup(false);
			}
		} catch (error) {
			console.error("Chat error:", error);
			res.writeHead(500, {
				"Content-Type": "application/json",
				...CORS_HEADERS,
			});
			res.end(
				JSON.stringify({
					error:
						error instanceof Error ? error.message : "Internal server error",
				}),
			);
		}
	});
}

/**
 * Handle /api/sessions - List and manage sessions
 */
async function handleSessions(req: any, res: any, pathname: string) {
	const sessionManager = new SessionManager(true);

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

			res.writeHead(200, {
				"Content-Type": "application/json",
				...CORS_HEADERS,
			});
			res.end(JSON.stringify({ sessions: sessionList }));
		}
		// GET /api/sessions/:id - Get specific session
		else if (req.method === "GET" && pathname.startsWith("/api/sessions/")) {
			const sessionId = pathname.replace("/api/sessions/", "");
			const session = await sessionManager.loadSession(sessionId);

			if (!session) {
				res.writeHead(404, {
					"Content-Type": "application/json",
					...CORS_HEADERS,
				});
				res.end(JSON.stringify({ error: "Session not found" }));
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

			res.writeHead(200, {
				"Content-Type": "application/json",
				...CORS_HEADERS,
			});
			res.end(JSON.stringify(responseBody));
		}
		// POST /api/sessions - Create new session
		else if (req.method === "POST" && pathname === "/api/sessions") {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});

			req.on("end", async () => {
				const { title } = JSON.parse(body || "{}");
				const session = await sessionManager.createSession({ title });
				const responseBody: ComposerSession = {
					id: session.id,
					title: session.title,
					createdAt: session.createdAt,
					updatedAt: session.updatedAt,
					messageCount: session.messageCount,
					messages: convertAppMessagesToComposer(session.messages || []),
				};

				res.writeHead(201, {
					"Content-Type": "application/json",
					...CORS_HEADERS,
				});
				res.end(JSON.stringify(responseBody));
			});
		}
		// DELETE /api/sessions/:id - Delete session
		else if (req.method === "DELETE" && pathname.startsWith("/api/sessions/")) {
			const sessionId = pathname.replace("/api/sessions/", "");
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
		res.writeHead(500, {
			"Content-Type": "application/json",
			...CORS_HEADERS,
		});
		res.end(
			JSON.stringify({
				error: error instanceof Error ? error.message : "Internal server error",
			}),
		);
	}
}

/**
 * Serve static files from web package
 */
function serveStatic(pathname: string, res: any) {
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
async function handleRequest(req: any, res: any) {
	const parsedUrl = parse(req.url || "/", true);
	const pathname = parsedUrl.pathname || "/";

	console.log(`${req.method} ${pathname}`);

	// Handle CORS preflight
	if (req.method === "OPTIONS") {
		res.writeHead(204, CORS_HEADERS);
		res.end();
		return;
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
