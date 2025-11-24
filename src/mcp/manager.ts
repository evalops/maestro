import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type {
	McpConfig,
	McpManagerStatus,
	McpServerConfig,
	McpServerStatus,
} from "./types.js";

export interface McpToolCallResult {
	content: Array<{
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
	}>;
	isError?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 3;

interface ConnectedServer {
	config: McpServerConfig;
	client: Client;
	transport: Transport;
	tools: McpTool[];
	resources: string[];
	prompts: string[];
	reconnectAttempts: number;
}

export class McpClientManager extends EventEmitter {
	private servers = new Map<string, ConnectedServer>();
	private connecting = new Map<string, Promise<void>>();
	private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private config: McpConfig = { servers: [] };

	async configure(config: McpConfig): Promise<void> {
		const oldServerNames = new Set(this.config.servers.map((s) => s.name));
		const newServerNames = new Set(config.servers.map((s) => s.name));

		// Find servers to remove (in old but not in new)
		const toRemove = [...oldServerNames].filter((n) => !newServerNames.has(n));

		// Find servers to add (in new but not in old)
		const toAdd = config.servers.filter((s) => !oldServerNames.has(s.name));

		this.config = config;

		// Disconnect removed servers
		await Promise.allSettled(
			toRemove.map((name) => this.disconnectServer(name)),
		);

		// Connect new servers
		await Promise.allSettled(toAdd.map((server) => this.connectServer(server)));
	}

	async connectAll(): Promise<void> {
		const promises = this.config.servers.map((server) =>
			this.connectServer(server),
		);
		await Promise.allSettled(promises);
	}

	async disconnectAll(): Promise<void> {
		// Clear all pending reconnect timers
		for (const [name, timer] of this.reconnectTimers) {
			clearTimeout(timer);
		}
		this.reconnectTimers.clear();

		const promises = Array.from(this.servers.keys()).map((name) =>
			this.disconnectServer(name),
		);
		await Promise.allSettled(promises);
	}

	private async connectServer(config: McpServerConfig): Promise<void> {
		const { name } = config;

		// Avoid duplicate connections
		if (this.servers.has(name)) {
			return;
		}

		// Check for in-flight connection
		const existing = this.connecting.get(name);
		if (existing) {
			return existing;
		}

		const task = this.doConnect(config);
		this.connecting.set(name, task);

		try {
			await task;
		} finally {
			this.connecting.delete(name);
		}
	}

	private async doConnect(
		config: McpServerConfig,
		isReconnect = false,
	): Promise<void> {
		const { name, transport: transportType } = config;

		try {
			let transport: Transport;

			if (transportType === "http" || transportType === "sse") {
				// HTTP/SSE transport
				if (!config.url) {
					console.warn(`[mcp] No URL specified for HTTP server ${name}`);
					return;
				}
				transport = new SSEClientTransport(new URL(config.url));
			} else {
				// Default to stdio transport
				if (!config.command) {
					console.warn(`[mcp] No command specified for ${name}`);
					return;
				}

				// Only pass explicitly configured env vars plus essential PATH
				// Do NOT pass process.env to avoid leaking secrets (API keys, tokens)
				const safeBaseEnv: Record<string, string> = {};
				if (process.env.PATH) safeBaseEnv.PATH = process.env.PATH;
				if (process.env.HOME) safeBaseEnv.HOME = process.env.HOME;
				if (process.env.USER) safeBaseEnv.USER = process.env.USER;
				if (process.env.SHELL) safeBaseEnv.SHELL = process.env.SHELL;
				if (process.env.TERM) safeBaseEnv.TERM = process.env.TERM;

				const mergedEnv = config.env
					? Object.fromEntries(
							Object.entries({ ...safeBaseEnv, ...config.env }).filter(
								([, v]) => v !== undefined,
							),
						)
					: safeBaseEnv;

				transport = new StdioClientTransport({
					command: config.command,
					args: config.args,
					env: mergedEnv as Record<string, string> | undefined,
					cwd: config.cwd,
				});
			}

			const client = new Client({
				name: "composer",
				version: "1.0.0",
			});

			await client.connect(transport, {
				timeout: config.timeout ?? DEFAULT_TIMEOUT_MS,
			});

			// Fetch capabilities
			const tools = await this.fetchTools(client);
			const resources = await this.fetchResources(client);
			const prompts = await this.fetchPrompts(client);

			this.servers.set(name, {
				config,
				client,
				transport,
				tools,
				resources,
				prompts,
				reconnectAttempts: 0,
			});

			this.emit("connected", { name, tools: tools.length, isReconnect });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[mcp] Failed to connect to ${name}:`, message);
			this.emit("error", { name, error: message });

			// Schedule reconnection for non-reconnect attempts
			if (!isReconnect) {
				this.scheduleReconnect(config, 0);
			}
		}
	}

	private scheduleReconnect(config: McpServerConfig, attempt: number): void {
		if (attempt >= MAX_RECONNECT_ATTEMPTS) {
			console.warn(
				`[mcp] Max reconnection attempts reached for ${config.name}`,
			);
			return;
		}

		// Clear any existing timer for this server
		const existingTimer = this.reconnectTimers.get(config.name);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		const delay = DEFAULT_RECONNECT_DELAY_MS * 2 ** attempt;
		console.log(
			`[mcp] Scheduling reconnect for ${config.name} in ${delay}ms (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS})`,
		);

		const timeoutId = setTimeout(async () => {
			this.reconnectTimers.delete(config.name);

			if (this.servers.has(config.name)) {
				return; // Already reconnected
			}

			try {
				await this.doConnect(config, true);
				// If doConnect succeeded (server is now connected), we're done
				if (!this.servers.has(config.name)) {
					// Connection failed (doConnect caught the error), schedule retry
					this.scheduleReconnect(config, attempt + 1);
				}
			} catch {
				// Unexpected error, schedule retry
				this.scheduleReconnect(config, attempt + 1);
			}
		}, delay);

		this.reconnectTimers.set(config.name, timeoutId);
	}

	/**
	 * Manually trigger reconnection for a server
	 */
	async reconnect(name: string): Promise<boolean> {
		const config = this.config.servers.find((s) => s.name === name);
		if (!config) {
			return false;
		}

		await this.disconnectServer(name);
		await this.doConnect(config, true);
		return this.servers.has(name);
	}

	private async fetchTools(client: Client): Promise<McpTool[]> {
		try {
			const caps = client.getServerCapabilities();
			if (!caps?.tools) {
				return [];
			}
			const result = await client.listTools();
			return result.tools;
		} catch {
			return [];
		}
	}

	private async fetchResources(client: Client): Promise<string[]> {
		try {
			const caps = client.getServerCapabilities();
			if (!caps?.resources) {
				return [];
			}
			const result = await client.listResources();
			return result.resources.map((r) => r.uri);
		} catch {
			return [];
		}
	}

	private async fetchPrompts(client: Client): Promise<string[]> {
		try {
			const caps = client.getServerCapabilities();
			if (!caps?.prompts) {
				return [];
			}
			const result = await client.listPrompts();
			return result.prompts.map((p) => p.name);
		} catch {
			return [];
		}
	}

	private async disconnectServer(name: string): Promise<void> {
		// Clear any pending reconnect timer for this server
		const timer = this.reconnectTimers.get(name);
		if (timer) {
			clearTimeout(timer);
			this.reconnectTimers.delete(name);
		}

		const server = this.servers.get(name);
		if (!server) {
			return;
		}

		try {
			await server.client.close();
		} catch (error) {
			console.warn(`[mcp] Error closing client for ${name}:`, error);
		}

		// Also close the transport to clean up underlying resources
		try {
			await server.transport.close();
		} catch (error) {
			console.warn(`[mcp] Error closing transport for ${name}:`, error);
		}

		this.servers.delete(name);
		this.emit("disconnected", { name });
	}

	async callTool(
		serverName: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<McpToolCallResult> {
		const server = this.servers.get(serverName);
		if (!server) {
			throw new Error(`MCP server '${serverName}' not connected`);
		}

		const result = await server.client.callTool({
			name: toolName,
			arguments: args,
		});

		// Normalize the result to our interface
		const content = Array.isArray(result.content)
			? result.content.map((c: Record<string, unknown>) => ({
					type: String(c.type ?? "unknown"),
					text: typeof c.text === "string" ? c.text : undefined,
					data: typeof c.data === "string" ? c.data : undefined,
					mimeType: typeof c.mimeType === "string" ? c.mimeType : undefined,
				}))
			: [];

		return {
			content,
			isError: typeof result.isError === "boolean" ? result.isError : undefined,
		};
	}

	getAllTools(): Array<{ server: string; tool: McpTool }> {
		const tools: Array<{ server: string; tool: McpTool }> = [];
		for (const [serverName, server] of this.servers) {
			for (const tool of server.tools) {
				tools.push({ server: serverName, tool });
			}
		}
		return tools;
	}

	getStatus(): McpManagerStatus {
		const servers: McpServerStatus[] = [];

		// Include configured but not connected servers
		for (const config of this.config.servers) {
			const connected = this.servers.get(config.name);
			servers.push({
				name: config.name,
				connected: !!connected,
				tools: connected?.tools ?? [],
				resources: connected?.resources ?? [],
				prompts: connected?.prompts ?? [],
			});
		}

		return { servers };
	}

	getServer(name: string): ConnectedServer | undefined {
		return this.servers.get(name);
	}

	isConnected(name: string): boolean {
		return this.servers.has(name);
	}

	/**
	 * Read a resource from an MCP server
	 */
	async readResource(
		serverName: string,
		uri: string,
	): Promise<{
		contents: Array<{
			uri: string;
			text?: string;
			blob?: string;
			mimeType?: string;
		}>;
	}> {
		const server = this.servers.get(serverName);
		if (!server) {
			throw new Error(`MCP server '${serverName}' not connected`);
		}

		const result = await server.client.readResource({ uri });
		return {
			contents: result.contents.map((c) => ({
				uri: c.uri,
				text: "text" in c ? c.text : undefined,
				blob: "blob" in c ? c.blob : undefined,
				mimeType: c.mimeType,
			})),
		};
	}

	/**
	 * Get a prompt from an MCP server
	 */
	async getPrompt(
		serverName: string,
		promptName: string,
		args?: Record<string, string>,
	): Promise<{
		description?: string;
		messages: Array<{ role: string; content: string }>;
	}> {
		const server = this.servers.get(serverName);
		if (!server) {
			throw new Error(`MCP server '${serverName}' not connected`);
		}

		const result = await server.client.getPrompt({
			name: promptName,
			arguments: args,
		});
		return {
			description: result.description,
			messages: result.messages.map((m) => ({
				role: m.role,
				content:
					typeof m.content === "string"
						? m.content
						: m.content.type === "text"
							? m.content.text
							: "[non-text content]",
			})),
		};
	}
}

// Singleton instance
export const mcpManager = new McpClientManager();
