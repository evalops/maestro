/**
 * @fileoverview API Client for Composer Backend
 *
 * This module provides a type-safe HTTP client for communicating with
 * the Composer backend API. It handles:
 *
 * - Session management (create, list, delete)
 * - Streaming chat with Server-Sent Events (SSE)
 * - Model selection and configuration
 * - Workspace status and file operations
 * - Background tasks and diagnostics
 *
 * ## Features
 *
 * - **Automatic Fallback**: Tries multiple base URLs if primary fails
 * - **SSE Streaming**: Real-time streaming for chat responses
 * - **Type Safety**: Full TypeScript types for all API responses
 * - **Error Handling**: Graceful degradation with detailed errors
 *
 * ## Quick Start
 *
 * ```typescript
 * import { ApiClient } from "@evalops/composer-web";
 *
 * const client = new ApiClient("http://localhost:8080");
 *
 * // Get workspace status
 * const status = await client.getStatus();
 *
 * // Stream a chat response
 * for await (const event of client.chatWithEvents({ messages: [...] })) {
 *   if (event.type === 'message_update') {
 *     console.log(event.assistantMessageEvent);
 *   }
 * }
 * ```
 *
 * ## API Endpoints
 *
 * | Category | Endpoint | Description |
 * |----------|----------|-------------|
 * | Chat | POST /api/chat | Send message, get streaming response |
 * | Sessions | GET/POST /api/sessions | Manage conversation sessions |
 * | Models | GET/POST /api/model | Get/set current model |
 * | Status | GET /api/status | Get workspace status |
 * | Usage | GET /api/usage | Get token usage and costs |
 *
 * @module services/api-client
 */

import type {
	ComposerAgentEvent,
	ComposerAssistantMessageEvent,
	ComposerChatRequest,
	ComposerMessage,
	ComposerSession,
	ComposerSessionSummary,
	ComposerToolCall,
} from "@evalops/contracts";

export type Message = ComposerMessage;
export type { ComposerToolCall };

export type AssistantMessageEvent = ComposerAssistantMessageEvent;

/** AgentEvent is a discriminated union of all possible server-sent events */
export type AgentEvent = ComposerAgentEvent;

export interface Model {
	id: string;
	provider: string;
	name: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	maxTokens?: number;
	api?: string;
	cost?: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	capabilities?: {
		streaming?: boolean;
		tools?: boolean;
		vision?: boolean;
		reasoning?: boolean;
	};
}

export type Session = ComposerSession;

export type SessionSummary = ComposerSessionSummary;

export type ChatRequest = ComposerChatRequest;

const MAX_SSE_BUFFER = 1024 * 1024; // 1MB safeguard

function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
	const bytes = new Uint8Array(arrayBuffer);
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.slice(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

type ParsedSseEvent = {
	event?: string;
	data: string;
};

function parseSseEvents(buffer: string): {
	events: ParsedSseEvent[];
	remainder: string;
} {
	const normalized = buffer.replace(/\r\n/g, "\n");
	const events: ParsedSseEvent[] = [];
	let remainder = normalized;

	while (true) {
		const separatorIndex = remainder.indexOf("\n\n");
		if (separatorIndex === -1) break;

		const rawEvent = remainder.slice(0, separatorIndex);
		remainder = remainder.slice(separatorIndex + 2);

		if (!rawEvent.trim()) continue;

		let eventType: string | undefined;
		const dataLines: string[] = [];
		for (const line of rawEvent.split("\n")) {
			if (line.startsWith("event:")) {
				eventType = line.slice(6).trim();
				continue;
			}
			if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).trimStart());
			}
		}
		if (dataLines.length > 0) {
			events.push({ event: eventType, data: dataLines.join("\n") });
		}
	}

	return { events, remainder };
}

export interface ChatResponse {
	message: Message;
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

export interface BackgroundTaskSnapshotEntry {
	id?: string;
	status?: string;
	command?: string;
	summary?: string;
	lastLogLine?: string;
	issues?: string[];
	logTruncated?: boolean;
	durationSeconds?: number;
	restarts?: string;
}

export interface BackgroundTaskSnapshot {
	total: number;
	running: number;
	restarting: number;
	failed: number;
	truncated?: boolean;
	notificationsEnabled?: boolean;
	detailsRedacted?: boolean;
	entries?: BackgroundTaskSnapshotEntry[];
}

export interface WorkspaceStatus {
	cwd: string;
	git: {
		branch: string;
		status: {
			modified: number;
			added: number;
			deleted: number;
			untracked: number;
			total: number;
		};
	} | null;
	context: {
		agentMd: boolean;
		claudeMd: boolean;
	};
	server: {
		uptime: number;
		version: string;
	};
	backgroundTasks?: BackgroundTaskSnapshot | null;
	lastUpdated?: number;
	lastLatencyMs?: number;
}

export interface UsageSummary {
	totalCost: number;
	totalRequests?: number;
	totalTokens: number;
	totalTokensDetailed?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	totalTokensBreakdown?: UsageSummary["totalTokensDetailed"];
	totalCachedTokens?: number;
	byProvider: Record<
		string,
		{
			cost: number;
			calls?: number;
			requests?: number;
			tokens: number;
			tokensDetailed?: UsageSummary["totalTokensDetailed"];
			cachedTokens?: number;
		}
	>;
	byModel: Record<
		string,
		{
			cost: number;
			calls?: number;
			requests?: number;
			tokens: number;
			tokensDetailed?: UsageSummary["totalTokensDetailed"];
			cachedTokens?: number;
		}
	>;
}

export interface CommandPrefs {
	favorites: string[];
	recents: string[];
}

async function safeJson(response: Response) {
	const contentType = response.headers.get("content-type") || "";
	if (!response.ok) {
		throw new Error(`API error: ${response.status} ${response.statusText}`);
	}
	if (!contentType.includes("application/json")) {
		const text = await response.text();
		throw new Error(
			`Expected JSON but received ${contentType || "unknown"}; check API endpoint. Snippet: ${text.slice(0, 120)}`,
		);
	}
	return response.json();
}

export interface UIStatusResponse {
	zenMode: boolean;
	cleanMode: "off" | "soft" | "aggressive";
	footerMode: "ensemble" | "solo";
	compactTools: boolean;
	queueMode: "one" | "all";
}

export interface QueueListResponse {
	mode: "one" | "all";
	pending: Array<{ id: number; text?: string; createdAt?: number }>;
	count: number;
}

export interface QueueStatusResponse {
	mode: "one" | "all";
	pendingCount: number;
	enabled: boolean;
}

export interface BranchListResponse {
	userMessages: Array<{ number: number; index: number; snippet: string }>;
}

/**
 * HTTP API client for the Composer backend.
 *
 * Provides methods for all Composer API endpoints including chat streaming,
 * session management, model selection, and workspace operations.
 *
 * The client automatically handles:
 * - URL fallback across multiple hosts
 * - SSE parsing for streaming responses
 * - Content-type validation
 * - Error propagation
 *
 * @example
 * ```typescript
 * const client = new ApiClient();
 *
 * // Get available models
 * const models = await client.getModels();
 *
 * // Stream chat messages
 * for await (const event of client.chatWithEvents({
 *   sessionId: "abc123",
 *   messages: [{ role: "user", content: "Hello!" }]
 * })) {
 *   console.log(event);
 * }
 * ```
 */
export class ApiClient {
	/** Resolved base URL for API requests */
	public readonly baseUrl: string;

	/** Fallback URLs to try if primary fails */
	private readonly fallbackBases: string[];

	/**
	 * Creates a new API client.
	 *
	 * The base URL is resolved in order of priority:
	 * 1. Explicit baseUrl parameter
	 * 2. window.__COMPOSER_API__ global
	 * 3. ?api= URL parameter
	 * 4. Same origin as current page
	 * 5. VITE_API_ENDPOINT env variable
	 * 6. http://localhost:8080 (fallback)
	 *
	 * @param baseUrl - Optional explicit base URL
	 */
	constructor(baseUrl?: string) {
		let resolved = baseUrl;
		// Window override via global (allows runtime swap without rebuild)
		if (!resolved && typeof window !== "undefined") {
			const winWithApi = window as Window & { __COMPOSER_API__?: string };
			if (typeof winWithApi.__COMPOSER_API__ === "string") {
				resolved = winWithApi.__COMPOSER_API__;
			}
			// ?api= URL param override
			if (!resolved && window.location?.search) {
				const params = new URLSearchParams(window.location.search);
				const api = params.get("api");
				if (api) resolved = api;
			}
			// Same-origin first to avoid CORS when proxied
			if (!resolved && window.location?.origin) {
				resolved = window.location.origin;
			}
		}
		// Vite env override
		if (!resolved && typeof import.meta !== "undefined") {
			// @ts-ignore Vite injects env at build time
			resolved = import.meta.env?.VITE_API_ENDPOINT || undefined;
		}
		// Final fallback
		if (!resolved) {
			resolved = "http://localhost:8080";
		}
		this.baseUrl = resolved.replace(/\/$/, "");
		this.fallbackBases = this.buildFallbacks(this.baseUrl);
	}

	private buildFallbacks(primary: string): string[] {
		const bases: string[] = [];
		// always try origin first if available
		if (typeof window !== "undefined" && window.location) {
			const origin = window.location.origin;
			if (!bases.includes(origin)) bases.push(origin);
		}
		// then the configured primary
		if (!bases.includes(primary)) bases.push(primary);
		// finally localhost:8080 as a dev fallback
		if (!bases.includes("http://localhost:8080"))
			bases.push("http://localhost:8080");
		return bases;
	}

	private async fetchJsonWithFallback(path: string, init?: RequestInit) {
		let lastError: unknown;
		for (const base of this.fallbackBases) {
			try {
				const res = await fetch(`${base}${path}`, init);
				return await safeJson(res);
			} catch (e) {
				lastError = e;
				// eslint-disable-next-line no-console
				console.warn("API fallback failed", {
					base,
					path,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
		throw lastError instanceof Error
			? lastError
			: new Error("Failed to fetch API after fallbacks");
	}

	private async tryFallbackFetch(
		path: string,
		init: RequestInit,
		skipPrimary = false,
	) {
		let lastError: unknown;
		const bases = skipPrimary
			? this.fallbackBases.filter((b) => b !== this.baseUrl)
			: this.fallbackBases;
		for (const base of bases) {
			try {
				const res = await fetch(`${base}${path}`, init);
				if (!res.ok) {
					throw new Error(`API error: ${res.status} ${res.statusText}`);
				}
				return res;
			} catch (e) {
				lastError = e;
				// eslint-disable-next-line no-console
				console.warn("API fallback failed", {
					base,
					path,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}
		throw lastError instanceof Error
			? lastError
			: new Error("Failed to fetch API after fallbacks");
	}

	/**
	 * Send a chat message and receive streaming response (text only - for backward compatibility)
	 */
	async *chat(request: ChatRequest): AsyncGenerator<string, void, unknown> {
		const response = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ...request, stream: true }),
		});

		if (!response.ok) {
			throw new Error(`API error: ${response.statusText}`);
		}

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("No response body");
		}

		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				if (buffer.length > MAX_SSE_BUFFER) {
					throw new Error("SSE buffer exceeded maximum size (1MB)");
				}

				const parsed = parseSseEvents(buffer);
				buffer = parsed.remainder;

				for (const sseEvent of parsed.events) {
					const data = sseEvent.data.trim();
					if (!data || data === "[DONE]") continue;

					try {
						const event = JSON.parse(data);

						// Handle different event types from Agent
						if (event.type === "done") {
							return;
						}
						if (event.type === "content_block_delta" && event.text) {
							yield event.text;
						} else if (event.type === "text_delta" && event.text) {
							yield event.text;
						} else if (event.type === "text" && event.text) {
							yield event.text;
						}
					} catch (e) {
						console.warn("Failed to parse SSE data:", data);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Send a chat message and stream ALL agent events (text deltas, tool calls, thinking, etc.)
	 */
	async *chatWithEvents(
		request: ChatRequest,
	): AsyncGenerator<AgentEvent, void, unknown> {
		const response = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-composer-client-tools": "1",
			},
			body: JSON.stringify({ ...request, stream: true }),
		});

		if (!response.ok) {
			throw new Error(`API error: ${response.statusText}`);
		}

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error("No response body");
		}

		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				if (buffer.length > MAX_SSE_BUFFER) {
					throw new Error("SSE buffer exceeded maximum size (1MB)");
				}

				const parsed = parseSseEvents(buffer);
				buffer = parsed.remainder;

				for (const sseEvent of parsed.events) {
					const data = sseEvent.data.trim();
					if (!data || data === "[DONE]") continue;

					try {
						const event = JSON.parse(data) as AgentEvent;
						yield event;
					} catch (e) {
						console.warn("Failed to parse SSE data:", data);
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Submit the result of a client-side tool execution back to the server.
	 *
	 * The server will resolve the pending tool call and continue the agent loop.
	 */
	async sendClientToolResult(input: {
		toolCallId: string;
		content: Array<
			| { type: "text"; text: string }
			| { type: "image"; data: string; mimeType: string }
		>;
		isError: boolean;
	}): Promise<void> {
		const response = await fetch(
			`${this.baseUrl}/api/chat/client-tool-result`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(input),
			},
		);

		if (!response.ok) {
			throw new Error(
				`Failed to submit client tool result: ${response.statusText}`,
			);
		}
	}

	/**
	 * Get list of available models
	 */
	async getModels(): Promise<Model[]> {
		const data = await this.fetchJsonWithFallback("/api/models");
		return data.models || [];
	}

	/**
	 * Get current model info
	 */
	async getCurrentModel(): Promise<Model | null> {
		try {
			const data = await this.fetchJsonWithFallback("/api/model");
			return (data as Model) ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Set current model
	 */
	async setModel(modelId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/api/model`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ model: modelId }),
		});

		if (!response.ok) {
			// attempt fallback hosts (skip the primary that already failed)
			await this.tryFallbackFetch(
				"/api/model",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model: modelId }),
				},
				/* skipPrimary */ true,
			);
		}
	}

	/**
	 * Get workspace files for mention
	 */
	async getFiles(): Promise<string[]> {
		try {
			const data = await this.fetchJsonWithFallback("/api/files");
			return data.files || [];
		} catch (e) {
			console.error("Failed to fetch files:", e);
			return [];
		}
	}

	/**
	 * Get list of sessions
	 */
	async getSessions(): Promise<SessionSummary[]> {
		try {
			const data = await this.fetchJsonWithFallback("/api/sessions");
			return data.sessions || [];
		} catch (e) {
			console.error("Failed to fetch sessions:", e);
			return [];
		}
	}

	/**
	 * Get workspace status (cwd, git, context files, server info)
	 */
	async getStatus(): Promise<WorkspaceStatus | null> {
		try {
			const data = await this.fetchJsonWithFallback("/api/status");
			return data as WorkspaceStatus;
		} catch (e) {
			console.error("Failed to fetch status:", e);
			return null;
		}
	}

	/**
	 * Get usage summary (costs and token counts)
	 */
	async getUsage(): Promise<UsageSummary | null> {
		try {
			const data = await this.fetchJsonWithFallback("/api/usage");
			return data.summary || null;
		} catch (e) {
			console.error("Failed to fetch usage:", e);
			return null;
		}
	}

	/**
	 * Get a specific session
	 */
	async getSession(sessionId: string): Promise<Session> {
		const data = await this.fetchJsonWithFallback(`/api/sessions/${sessionId}`);
		return data as Session;
	}

	/**
	 * Create a share link for a session.
	 */
	async shareSession(
		sessionId: string,
		options?: { expiresInHours?: number; maxAccesses?: number | null },
	): Promise<{
		shareToken: string;
		shareUrl: string;
		webShareUrl?: string;
		expiresAt: string;
		maxAccesses: number | null;
	}> {
		const response = await this.tryFallbackFetch(
			`/api/sessions/${encodeURIComponent(sessionId)}/share`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(options || {}),
			},
		);

		return (await safeJson(response)) as {
			shareToken: string;
			shareUrl: string;
			webShareUrl?: string;
			expiresAt: string;
			maxAccesses: number | null;
		};
	}

	async exportSession(
		sessionId: string,
		options?: { format?: "json" | "markdown" | "text" },
	): Promise<Response> {
		return await this.tryFallbackFetch(
			`/api/sessions/${encodeURIComponent(sessionId)}/export`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ format: options?.format || "json" }),
			},
		);
	}

	/**
	 * Get a shared session by share token (read-only).
	 */
	async getSharedSession(shareToken: string): Promise<Session> {
		const data = await this.fetchJsonWithFallback(
			`/api/sessions/shared/${encodeURIComponent(shareToken)}`,
		);
		return data as Session;
	}

	/**
	 * Fetch raw bytes for a session attachment (for lazy-loaded session history).
	 */
	async getSessionAttachmentBytes(
		sessionId: string,
		attachmentId: string,
	): Promise<ArrayBuffer> {
		const path = `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`;
		const response = await this.tryFallbackFetch(path, { method: "GET" });
		return await response.arrayBuffer();
	}

	/**
	 * Fetch base64 content for a session attachment (for chat request hydration).
	 */
	async getSessionAttachmentContentBase64(
		sessionId: string,
		attachmentId: string,
	): Promise<string> {
		const bytes = await this.getSessionAttachmentBytes(sessionId, attachmentId);
		return arrayBufferToBase64(bytes);
	}

	/**
	 * Server-side document extraction (PDF/DOCX/XLSX/PPTX/text).
	 */
	async extractAttachmentText(input: {
		fileName: string;
		mimeType?: string;
		contentBase64: string;
		maxChars?: number;
	}): Promise<{
		fileName: string;
		format: string;
		size: number;
		truncated: boolean;
		extractedText: string;
	}> {
		const response = await this.tryFallbackFetch("/api/attachments/extract", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(input),
		});
		return (await safeJson(response)) as {
			fileName: string;
			format: string;
			size: number;
			truncated: boolean;
			extractedText: string;
		};
	}

	/**
	 * Create a new session
	 */
	async createSession(title?: string): Promise<Session> {
		const response = await fetch(`${this.baseUrl}/api/sessions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ title }),
		});

		if (!response.ok) {
			const fallback = await this.tryFallbackFetch("/api/sessions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title }),
			});
			return (await safeJson(fallback)) as Session;
		}
		return (await safeJson(response)) as Session;
	}

	/**
	 * Delete a session
	 */
	async deleteSession(sessionId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/api/sessions/${sessionId}`, {
			method: "DELETE",
		});

		if (!response.ok) {
			await this.tryFallbackFetch(`/api/sessions/${sessionId}`, {
				method: "DELETE",
			});
		}
	}

	async getCommandPrefs(): Promise<CommandPrefs> {
		try {
			const data = await this.fetchJsonWithFallback("/api/command-prefs");
			return {
				favorites: Array.isArray(data.favorites)
					? (data.favorites as string[]).filter((x) => typeof x === "string")
					: [],
				recents: Array.isArray(data.recents)
					? (data.recents as string[]).filter((x) => typeof x === "string")
					: [],
			};
		} catch {
			return { favorites: [], recents: [] };
		}
	}

	async saveCommandPrefs(prefs: CommandPrefs): Promise<void> {
		await this.tryFallbackFetch("/api/command-prefs", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(prefs),
		});
	}

	// Guardian
	async getGuardianStatus(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/guardian/status");
	}

	async runGuardian(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/guardian/run", {
			method: "POST",
		});
	}

	async setGuardianEnabled(enabled: boolean): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/guardian/config", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled }),
		});
	}

	// Plan Mode
	async getPlan(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/plan");
	}

	async enterPlanMode(
		name?: string,
		sessionId?: string,
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/plan", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "enter", name, sessionId }),
		});
	}

	async exitPlanMode(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/plan", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "exit" }),
		});
	}

	async updatePlan(content: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/plan", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "update", content }),
		});
	}

	// MCP
	async getMcpStatus(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/mcp");
	}

	// Background Tasks
	async getBackgroundStatus(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/background?action=status");
	}

	async getBackgroundHistory(limit = 10): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/background?action=history&limit=${limit}`,
		);
	}

	async setBackgroundNotifications(
		enabled: boolean,
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/background?action=notify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled }),
		});
	}

	// Undo/Checkpoint
	async getUndoStatus(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/undo?action=status");
	}

	async undoChanges(count = 1): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/undo", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "undo", count }),
		});
	}

	async getChanges(
		filter?: "all" | "files" | "tools",
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/changes${filter ? `?filter=${filter}` : ""}`,
		);
	}

	// Approvals
	async getApprovalMode(
		sessionId = "default",
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/approvals?sessionId=${sessionId}`,
		);
	}

	async setApprovalMode(
		mode: "auto" | "prompt" | "fail",
		sessionId = "default",
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/approvals?sessionId=${sessionId}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode }),
			},
		);
	}

	// Framework
	async getFrameworkPreference(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/framework?action=status");
	}

	async listFrameworks(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/framework?action=list");
	}

	async setFramework(
		framework: string | null,
		scope: "user" | "workspace" = "user",
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/framework", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ framework, scope }),
		});
	}

	// Tools
	async getTools(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/tools?action=list");
	}

	// Review
	async getReview(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/review");
	}

	// Context
	async getContext(sessionId?: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/context${sessionId ? `?sessionId=${sessionId}` : ""}`,
		);
	}

	// Stats
	async getStats(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/stats");
	}

	// Telemetry
	async getTelemetryStatus(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/telemetry");
	}

	async setTelemetry(
		action: "on" | "off" | "reset",
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/telemetry", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action }),
		});
	}

	// Training
	async getTrainingStatus(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/training");
	}

	async setTraining(
		action: "on" | "off" | "reset",
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/training", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action }),
		});
	}

	// Diagnostics
	async getDiagnostics(
		subcommand = "status",
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/diagnostics?subcommand=${subcommand}`,
		);
	}

	// LSP
	async getLspStatus(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/lsp?action=status");
	}

	async detectLspServers(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/lsp?action=detect");
	}

	async startLspServers(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/lsp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "start" }),
		});
	}

	async stopLspServers(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/lsp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "stop" }),
		});
	}

	async restartLspServers(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/lsp", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "restart" }),
		});
	}

	// Workflow
	async listWorkflows(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/workflow?action=list");
	}

	async getWorkflow(name: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/workflow?action=show&name=${name}`,
		);
	}

	async validateWorkflow(name: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/workflow?action=validate&name=${name}`,
		);
	}

	async runWorkflow(name: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/workflow", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "run", name }),
		});
	}

	// Run (npm scripts)
	async getRunScripts(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/run?action=scripts");
	}

	async runScript(
		script: string,
		args?: string,
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ script, args }),
		});
	}

	// Ollama
	async listOllamaModels(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/ollama?action=list");
	}

	async getOllamaPs(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/ollama?action=ps");
	}

	async pullOllamaModel(model: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/ollama", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "pull", model }),
		});
	}

	async showOllamaModel(model: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/ollama", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "show", model }),
		});
	}

	// Preview
	async getPreview(file: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/preview?file=${encodeURIComponent(file)}`,
		);
	}

	// Composer
	async listComposers(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/composer");
	}

	async getComposer(name: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(`/api/composer?name=${name}`);
	}

	async activateComposer(name: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/composer", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "activate", name }),
		});
	}

	async deactivateComposer(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/composer", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "deactivate" }),
		});
	}

	// Cost
	async getCostSummary(period?: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/cost?action=summary${period ? `&period=${period}` : ""}`,
		);
	}

	async getCostBreakdown(period?: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/cost?action=breakdown${period ? `&period=${period}` : ""}`,
		);
	}

	async clearCostData(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/cost", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "clear" }),
		});
	}

	// Quota
	async getQuotaStatus(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/quota?action=status");
	}

	async getQuotaDetailed(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/quota?action=detailed");
	}

	async getQuotaModels(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/quota?action=models");
	}

	async setQuotaLimit(limit: number): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/quota", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "limit", limit }),
		});
	}

	// Memory
	async listMemoryTopics(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/memory?action=list");
	}

	async listMemoryTopic(topic: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/memory?action=list&topic=${topic}`,
		);
	}

	async searchMemory(
		query: string,
		limit = 10,
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/memory?action=search&query=${encodeURIComponent(query)}&limit=${limit}`,
		);
	}

	async getRecentMemories(limit = 10): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/memory?action=recent&limit=${limit}`,
		);
	}

	async getMemoryStats(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/memory?action=stats");
	}

	async saveMemory(
		topic: string,
		content: string,
		tags?: string[],
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/memory", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "save", topic, content, tags }),
		});
	}

	async deleteMemory(
		id?: string,
		topic?: string,
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/memory", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "delete", id, topic }),
		});
	}

	async exportMemory(path?: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/memory", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "export", path }),
		});
	}

	async importMemory(path: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/memory", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "import", path }),
		});
	}

	async clearMemory(force = false): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/memory", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "clear", force }),
		});
	}

	// Mode
	async getCurrentMode(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/mode?action=current");
	}

	async listModes(): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/mode?action=list");
	}

	async suggestMode(task?: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(
			`/api/mode?action=suggest${task ? `&task=${encodeURIComponent(task)}` : ""}`,
		);
	}

	async setMode(mode: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback("/api/mode", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode }),
		});
	}

	// Zen
	async getZenMode(sessionId: string): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(`/api/zen?sessionId=${sessionId}`);
	}

	async setZenMode(
		sessionId: string,
		enabled: boolean,
	): Promise<Record<string, unknown>> {
		return await this.fetchJsonWithFallback(`/api/zen?sessionId=${sessionId}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled }),
		});
	}

	// UI Settings
	async getUIStatus(): Promise<UIStatusResponse> {
		return await this.fetchJsonWithFallback("/api/ui?action=status");
	}

	async setCleanMode(
		mode: "off" | "soft" | "aggressive",
	): Promise<{ success: boolean; cleanMode: UIStatusResponse["cleanMode"] }> {
		return await this.fetchJsonWithFallback("/api/ui", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "clean", cleanMode: mode }),
		});
	}

	async setFooterMode(
		mode: "ensemble" | "solo",
	): Promise<{ success: boolean; footerMode: UIStatusResponse["footerMode"] }> {
		return await this.fetchJsonWithFallback("/api/ui", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "footer", footerMode: mode }),
		});
	}

	async setCompactTools(enabled: boolean): Promise<{
		success: boolean;
		compactTools: boolean;
	}> {
		return await this.fetchJsonWithFallback("/api/ui", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "compact", compactTools: enabled }),
		});
	}

	// Queue
	async getQueueStatus(sessionId: string): Promise<QueueStatusResponse> {
		return await this.fetchJsonWithFallback(
			`/api/queue?action=status&sessionId=${sessionId}`,
		);
	}

	async listQueue(sessionId: string): Promise<QueueListResponse> {
		return await this.fetchJsonWithFallback(
			`/api/queue?action=list&sessionId=${sessionId}`,
		);
	}

	async setQueueMode(
		mode: "one" | "all",
		sessionId: string,
	): Promise<{ success: boolean; mode: QueueStatusResponse["mode"] }> {
		return await this.fetchJsonWithFallback("/api/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "mode", mode, sessionId }),
		});
	}

	async cancelQueuedPrompt(
		id: number,
		sessionId: string,
	): Promise<{ success: boolean; removed?: unknown }> {
		return await this.fetchJsonWithFallback("/api/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "cancel", id, sessionId }),
		});
	}

	// Branch
	async listBranchOptions(sessionId?: string): Promise<BranchListResponse> {
		return await this.fetchJsonWithFallback(
			`/api/branch?action=list${sessionId ? `&sessionId=${sessionId}` : ""}`,
		);
	}

	async createBranch(
		sessionId: string,
		messageIndex: number,
	): Promise<{
		success: boolean;
		newSessionId: string;
		newSessionFile: string;
	}> {
		return await this.fetchJsonWithFallback("/api/branch", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId, messageIndex }),
		});
	}
}
