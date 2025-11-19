/**
 * Web server for Composer - HTTP/WebSocket API for web UI
 */

import { createServer } from "node:http";
import { parse } from "node:url";
import { ActionApprovalService } from "./agent/action-approval.js";
import { Agent, ProviderTransport } from "./agent/index.js";
import type { AgentEvent, ThinkingLevel } from "./agent/types.js";
import { buildSystemPrompt, loadProjectContextFiles } from "./cli/system-prompt.js";
import { loadEnv } from "./load-env.js";
import {
	getRegisteredModels,
	resolveModel,
	reloadModelConfig,
	type RegisteredModel,
} from "./models/registry.js";
import { createAuthResolver } from "./providers/auth.js";
import { SessionManager } from "./session-manager.js";
import { codingTools } from "./tools/index.js";

loadEnv();

interface ChatRequest {
	model?: string;
	messages: Array<{ role: string; content: string }>;
	thinkingLevel?: ThinkingLevel;
	sessionId?: string;
}

interface ChatResponse {
	type: string;
	data: any;
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

/**
 * Server-Sent Events (SSE) streaming for chat responses
 */
function sendSSE(res: any, event: AgentEvent) {
	const data = JSON.stringify(event);
	res.write(`data: ${data}\n\n`);
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
		capabilities: {
			streaming: true,
			tools: true,
			vision: false,
		},
	}));

	res.writeHead(200, {
		"Content-Type": "application/json",
		...CORS_HEADERS,
	});
	res.end(JSON.stringify({ models: modelList }));
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
			const chatReq: ChatRequest = JSON.parse(body);

			// Resolve model
			const modelInput = chatReq.model || "claude-sonnet-4-5";
			
			// Parse provider:model format
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

			// Create session manager (disabled for web mode)
			const sessionManager = new SessionManager(false);

			// Find the full RegisteredModel
			const registeredModels = getRegisteredModels();
			const registeredModel = registeredModels.find(
				(m) => m.provider === model.provider && m.id === model.id
			);
			
			if (!registeredModel) {
				res.writeHead(500, {
					"Content-Type": "application/json",
					...CORS_HEADERS,
				});
				res.end(JSON.stringify({ error: "Model not properly registered" }));
				return;
			}

			// Create agent
			const agent = await createAgent(
				registeredModel,
				sessionManager,
				chatReq.thinkingLevel || "off",
			);

			// Set up SSE streaming
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				...CORS_HEADERS,
			});

			// Subscribe to agent events and stream them
			agent.subscribe((event: AgentEvent) => {
				sendSSE(res, event);
			});

			// Send user message
			const userMessage = chatReq.messages[chatReq.messages.length - 1]?.content;
			if (userMessage) {
				await agent.prompt(userMessage);
			}

			// Send completion marker
			res.write("data: [DONE]\n\n");
			res.end();
		} catch (error) {
			console.error("Chat error:", error);
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
	});
}

/**
 * Handle /api/sessions - List and manage sessions
 */
function handleSessions(req: any, res: any) {
	// TODO: Implement session listing
	res.writeHead(200, {
		"Content-Type": "application/json",
		...CORS_HEADERS,
	});
	res.end(JSON.stringify({ sessions: [] }));
}

/**
 * Serve static files from web package
 */
function serveStatic(pathname: string, res: any) {
	const { readFileSync, existsSync } = require("node:fs");
	const { join } = require("node:path");

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
	} else if (pathname === "/api/chat" && req.method === "POST") {
		await handleChat(req, res);
	} else if (pathname === "/api/sessions" && req.method === "GET") {
		handleSessions(req, res);
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
