/**
 * MCP Client Manager - Model Context Protocol integration.
 *
 * This module manages connections to MCP (Model Context Protocol) servers,
 * which provide extended capabilities to the agent through a standardized
 * interface. MCP servers can expose:
 *
 * - **Tools**: Functions the agent can call (e.g., database queries, APIs)
 * - **Resources**: Data the agent can read (e.g., files, configurations)
 * - **Prompts**: Pre-defined prompt templates
 *
 * ## Architecture
 *
 * The McpClientManager maintains connections to multiple MCP servers
 * simultaneously. Each server can use either:
 * - **Stdio transport**: Spawns a subprocess, communicates via stdin/stdout
 * - **SSE transport**: Connects to HTTP server using Server-Sent Events
 *
 * ## Security
 *
 * - Environment variables are NOT passed to MCP server subprocesses
 * - Only essential variables (PATH, HOME, USER, SHELL, TERM) are included
 * - Server-specific env vars must be explicitly configured
 *
 * ## Events
 *
 * The manager emits events for monitoring:
 * - `connected`: Server successfully connected
 * - `disconnected`: Server disconnected
 * - `error`: Connection or operation error
 * - `tools_changed`: Server's tool list updated
 * - `resources_changed`: Server's resource list updated
 * - `prompts_changed`: Server's prompt list updated
 * - `progress`: Progress update from long-running operations
 * - `log`: Log message from server
 */

import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	LoggingMessageNotificationSchema,
	type Tool as McpTool,
	ProgressNotificationSchema,
	PromptListChangedNotificationSchema,
	ResourceListChangedNotificationSchema,
	ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "../utils/logger.js";
import { getHomeDir } from "../utils/path-expansion.js";
import type {
	McpConfig,
	McpManagerStatus,
	McpServerConfig,
	McpServerStatus,
} from "./types.js";

const logger = createLogger("mcp:manager");

/**
 * Result from calling an MCP tool.
 * Content can be text, binary data, or other MIME types.
 */
export interface McpToolCallResult {
	content: Array<{
		type: string;
		text?: string;
		data?: string;
		mimeType?: string;
	}>;
	isError?: boolean;
}

// Connection timeout for initial server handshake
const DEFAULT_TIMEOUT_MS = 30000;

// Delay between reconnection attempts (doubles each retry)
const DEFAULT_RECONNECT_DELAY_MS = 5000;

// Maximum number of automatic reconnection attempts
const MAX_RECONNECT_ATTEMPTS = 3;

/**
 * Internal state for a connected MCP server.
 * Tracks the client, transport, and cached capabilities.
 */
interface ConnectedServer {
	/** Original configuration */
	config: McpServerConfig;
	/** MCP client instance */
	client: Client;
	/** Transport layer (stdio or SSE) */
	transport: Transport;
	/** Cached list of available tools */
	tools: McpTool[];
	/** Cached list of resource URIs */
	resources: string[];
	/** Cached list of prompt names */
	prompts: string[];
	/** Counter for reconnection attempts */
	reconnectAttempts: number;
}

/**
 * Manager for MCP (Model Context Protocol) server connections.
 *
 * Handles connection lifecycle, tool discovery, and message routing
 * for multiple MCP servers. Supports automatic reconnection on failure.
 */
export class McpClientManager extends EventEmitter {
	/** Map of server name to connected server state */
	private servers = new Map<string, ConnectedServer>();

	/** Map of server name to in-flight connection promise (prevents duplicates) */
	private connecting = new Map<string, Promise<void>>();

	/** Map of server name to pending reconnect timer */
	private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/** Last connection or runtime error reported for each configured server */
	private lastErrors = new Map<string, string>();

	/** Current configuration */
	private config: McpConfig = { servers: [] };

	/**
	 * Apply a new configuration, connecting/disconnecting servers as needed.
	 *
	 * Compares old and new configs to determine which servers to add or remove,
	 * then performs the necessary connect/disconnect operations.
	 *
	 * @param config - New MCP configuration with server list
	 */
	async configure(config: McpConfig): Promise<void> {
		const oldServerNames = new Set(this.config.servers.map((s) => s.name));
		const newServerNames = new Set(config.servers.map((s) => s.name));

		// Find servers to remove (in old but not in new)
		const toRemove = [...oldServerNames].filter((n) => !newServerNames.has(n));

		// Find servers to add (in new but not in old)
		const toAdd = config.servers.filter((s) => !oldServerNames.has(s.name));

		this.config = config;

		// Disconnect removed servers (don't wait for success)
		await Promise.allSettled(
			toRemove.map((name) => this.disconnectServer(name)),
		);

		// Connect new servers (don't wait for success)
		await Promise.allSettled(toAdd.map((server) => this.connectServer(server)));
	}

	/**
	 * Connect to all configured servers.
	 * Non-blocking - returns after connection attempts are started.
	 */
	async connectAll(): Promise<void> {
		const promises = this.config.servers.map((server) =>
			this.connectServer(server),
		);
		await Promise.allSettled(promises);
	}

	/**
	 * Disconnect from all servers and cancel pending reconnects.
	 */
	async disconnectAll(): Promise<void> {
		// Clear all pending reconnect timers first
		for (const [name, timer] of this.reconnectTimers) {
			clearTimeout(timer);
		}
		this.reconnectTimers.clear();

		// Disconnect all servers
		const promises = Array.from(this.servers.keys()).map((name) =>
			this.disconnectServer(name),
		);
		await Promise.allSettled(promises);
	}

	/**
	 * Internal: Connect to a single server.
	 * Handles deduplication of concurrent connection attempts.
	 */
	private async connectServer(config: McpServerConfig): Promise<void> {
		const { name } = config;

		// Avoid duplicate connections
		if (this.servers.has(name)) {
			return;
		}

		// Check for in-flight connection (prevent race conditions)
		const existing = this.connecting.get(name);
		if (existing) {
			return existing;
		}

		// Track this connection attempt
		const task = this.doConnect(config);
		this.connecting.set(name, task);

		try {
			await task;
		} finally {
			this.connecting.delete(name);
		}
	}

	/**
	 * Internal: Perform the actual connection to an MCP server.
	 *
	 * Creates the appropriate transport (stdio or SSE), establishes connection,
	 * fetches server capabilities (tools, resources, prompts), and sets up
	 * notification handlers.
	 *
	 * @param config - Server configuration
	 * @param isReconnect - Whether this is a reconnection attempt
	 */
	private async doConnect(
		config: McpServerConfig,
		isReconnect = false,
	): Promise<void> {
		const { name, transport: transportType } = config;

		try {
			let transport: Transport;

			// Create transport based on configuration
			if (transportType === "http" || transportType === "sse") {
				// HTTP/SSE transport - connect to remote server
				if (!config.url) {
					logger.warn("No URL specified for HTTP server", { name });
					return;
				}
				transport = new SSEClientTransport(new URL(config.url));
			} else {
				// Stdio transport - spawn subprocess
				if (!config.command) {
					logger.warn("No command specified for server", { name });
					return;
				}

				// SECURITY: Only pass essential env vars plus explicit config
				// Do NOT pass process.env - this would leak API keys and secrets
				const safeBaseEnv: Record<string, string> = {};
				if (process.env.PATH) safeBaseEnv.PATH = process.env.PATH;
				if (process.env.HOME) {
					safeBaseEnv.HOME = process.env.HOME;
				} else {
					const homeDir = getHomeDir();
					if (homeDir) safeBaseEnv.HOME = homeDir;
				}
				if (process.env.USER) {
					safeBaseEnv.USER = process.env.USER;
				} else if (process.env.USERNAME) {
					safeBaseEnv.USER = process.env.USERNAME;
				}
				if (process.env.SHELL) safeBaseEnv.SHELL = process.env.SHELL;
				if (process.env.TERM) safeBaseEnv.TERM = process.env.TERM;

				// Merge explicit config env vars with safe base
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
			this.lastErrors.delete(name);

			// Set up notification handlers after adding to servers map
			// to avoid race condition where notifications arrive before server is tracked
			this.setupNotificationHandlers(client, name);

			this.emit("connected", { name, tools: tools.length, isReconnect });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastErrors.set(name, message);
			logger.error(
				"Failed to connect to server",
				error instanceof Error ? error : new Error(message),
				{ name },
			);
			this.emit("error", { name, error: message });

			// Schedule reconnection for non-reconnect attempts
			if (!isReconnect) {
				this.scheduleReconnect(config, 0);
			}
		}
	}

	private scheduleReconnect(config: McpServerConfig, attempt: number): void {
		if (attempt >= MAX_RECONNECT_ATTEMPTS) {
			logger.warn("Max reconnection attempts reached", { name: config.name });
			return;
		}

		// Clear any existing timer for this server
		const existingTimer = this.reconnectTimers.get(config.name);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		const delay = DEFAULT_RECONNECT_DELAY_MS * 2 ** attempt;
		logger.info("Scheduling reconnect", {
			server: config.name,
			delayMs: delay,
			attempt: attempt + 1,
			maxAttempts: MAX_RECONNECT_ATTEMPTS,
		});

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

	private setupNotificationHandlers(client: Client, serverName: string): void {
		// Tool list changes - refresh tools when server notifies
		client.setNotificationHandler(
			ToolListChangedNotificationSchema,
			async () => {
				try {
					const server = this.servers.get(serverName);
					if (server) {
						server.tools = await this.fetchTools(client);
						this.emit("tools_changed", {
							name: serverName,
							tools: server.tools,
						});
					}
				} catch (error) {
					logger.error(
						"Failed to refresh tools",
						error instanceof Error ? error : new Error(String(error)),
						{ serverName },
					);
				}
			},
		);

		// Resource list changes
		client.setNotificationHandler(
			ResourceListChangedNotificationSchema,
			async () => {
				try {
					const server = this.servers.get(serverName);
					if (server) {
						server.resources = await this.fetchResources(client);
						this.emit("resources_changed", {
							name: serverName,
							resources: server.resources,
						});
					}
				} catch (error) {
					logger.error(
						"Failed to refresh resources",
						error instanceof Error ? error : new Error(String(error)),
						{ serverName },
					);
				}
			},
		);

		// Prompt list changes
		client.setNotificationHandler(
			PromptListChangedNotificationSchema,
			async () => {
				try {
					const server = this.servers.get(serverName);
					if (server) {
						server.prompts = await this.fetchPrompts(client);
						this.emit("prompts_changed", {
							name: serverName,
							prompts: server.prompts,
						});
					}
				} catch (error) {
					logger.error(
						"Failed to refresh prompts",
						error instanceof Error ? error : new Error(String(error)),
						{ serverName },
					);
				}
			},
		);

		// Progress notifications for long-running operations
		client.setNotificationHandler(
			ProgressNotificationSchema,
			(notification) => {
				this.emit("progress", {
					name: serverName,
					progressToken: notification.params.progressToken,
					progress: notification.params.progress,
					total: notification.params.total,
					message: notification.params.message,
				});
			},
		);

		// Logging messages from MCP servers
		client.setNotificationHandler(
			LoggingMessageNotificationSchema,
			(notification) => {
				this.emit("log", {
					name: serverName,
					level: notification.params.level,
					logger: notification.params.logger,
					data: notification.params.data,
				});
			},
		);
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
			logger.warn("Error closing client", {
				name,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		// Also close the transport to clean up underlying resources
		try {
			await server.transport.close();
		} catch (error) {
			logger.warn("Error closing transport", {
				name,
				error: error instanceof Error ? error.message : String(error),
			});
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
				error: this.lastErrors.get(config.name),
				scope: config.scope,
				transport: config.transport,
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

/**
 * Singleton MCP client manager instance.
 *
 * Use this for all MCP operations in the application.
 * Configure with `mcpManager.configure(config)` at startup.
 */
export const mcpManager = new McpClientManager();
