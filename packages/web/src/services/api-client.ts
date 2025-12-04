/**
 * API Client for Composer Backend
 */

import type {
	ComposerChatRequest,
	ComposerMessage,
	ComposerSession,
	ComposerSessionSummary,
	ComposerToolCall,
} from "@evalops/contracts";

export type Message = ComposerMessage;
export type { ComposerToolCall };

/** Simplified AssistantMessage type matching backend structure */
interface AssistantMessage {
	role: "assistant";
	content: Array<{
		type: "text" | "thinking" | "toolCall";
		text?: string;
		thinking?: string;
		id?: string;
		name?: string;
		arguments?: Record<string, unknown>;
	}>;
}

/** ToolCall type matching backend structure */
interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** Assistant message event discriminated union matching backend structure (src/agent/types.ts:159) */
export type AssistantMessageEvent =
	| {
			type: "start";
			partial: AssistantMessage;
	  }
	| {
			type: "text_start";
			contentIndex: number;
			partial: AssistantMessage;
	  }
	| {
			type: "text_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "text_end";
			contentIndex: number;
			content: string;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_start";
			contentIndex: number;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: string;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_start";
			contentIndex: number;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_delta";
			contentIndex: number;
			delta: string;
			partial: AssistantMessage;
	  }
	| {
			type: "toolcall_end";
			contentIndex: number;
			toolCall: ToolCall;
			partial: AssistantMessage;
	  }
	| {
			type: "done";
			reason: "stop" | "length" | "toolUse";
			message: AssistantMessage;
	  }
	| {
			type: "error";
			reason: "aborted" | "error";
			error: AssistantMessage;
	  };

/** AgentEvent is a discriminated union of all possible server-sent events */
export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages?: Message[] }
	| { type: "session_update"; sessionId: string }
	| { type: "message_start"; message: Message }
	| {
			type: "message_update";
			message: Message;
			assistantMessageEvent: AssistantMessageEvent;
	  }
	| { type: "message_end"; message: Message }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: string;
			isError: boolean;
	  }
	| { type: "error"; message: string }
	| { type: "status"; status: string; details: Record<string, unknown> };

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

export class ApiClient {
	public readonly baseUrl: string;
	private readonly fallbackBases: string[];

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

	private async fetchJsonWithFallback(path: string) {
		let lastError: unknown;
		for (const base of this.fallbackBases) {
			try {
				const res = await fetch(`${base}${path}`);
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
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
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
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
						if (!data || data === "[DONE]") continue;

						try {
							const event = JSON.parse(data) as AgentEvent;
							yield event;
						} catch (e) {
							console.warn("Failed to parse SSE data:", data);
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
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
}
