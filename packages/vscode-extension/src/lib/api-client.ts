/**
 * API Client for Composer Backend (VS Code Extension Version)
 */
// @ts-ignore - type-only import from ESM module is safe in CJS context
import type * as Contracts from "@evalops/contracts";

export type Message = Contracts.ComposerMessage;
export type ComposerToolCall = Contracts.ComposerToolCall;

/** Error event for stream parsing failures */
interface StreamErrorEvent {
	type: "stream_error";
	message: string;
	raw?: string;
}
interface LegacyTextDeltaEvent {
	type: "text_delta";
	text?: string;
	delta?: string;
}
interface LegacyThinkingStartEvent {
	type: "thinking_start";
}
interface LegacyThinkingEndEvent {
	type: "thinking_end";
}
/** Union of all agent event types */
export type AgentEvent =
	| Contracts.ComposerAgentEvent
	| StreamErrorEvent
	| LegacyTextDeltaEvent
	| LegacyThinkingStartEvent
	| LegacyThinkingEndEvent;

export interface Model {
	id: string;
	provider: string;
	name: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	maxTokens?: number;
	api?: string;
}

export type Session = Contracts.ComposerSession;
export type SessionSummary = Contracts.ComposerSessionSummary;
export type ChatRequest = Contracts.ComposerChatRequest;

const MAX_SSE_BUFFER = 1024 * 1024; // 1MB safeguard
const CLIENT_NAME = "vscode";

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

async function safeJson(response: Response) {
	const contentType = response.headers.get("content-type") || "";
	if (!response.ok) {
		const messagePrefix = `API error: ${response.status} ${response.statusText}`;
		if (contentType.includes("application/json")) {
			const payload = (await response.json().catch(() => null)) as {
				error?: string;
			} | null;
			throw new Error(payload?.error || messagePrefix);
		}
		const text = await response.text().catch(() => "");
		throw new Error(
			text ? `${messagePrefix} - ${text.slice(0, 120)}` : messagePrefix,
		);
	}
	if (!contentType.includes("application/json")) {
		const text = await response.text();
		throw new Error(
			`Expected JSON but received ${contentType || "unknown"}; check API endpoint. Snippet: ${text.slice(0, 120)}`,
		);
	}
	return response.json();
}

export interface CommandDefinition {
	name: string;
	description?: string;
	prompt: string;
	args?: Array<{ name: string; required?: boolean }>;
}

type HeaderOptions = {
	includeClientTools?: boolean;
	includeSlimEvents?: boolean;
};

function createRequestHeaders(
	options: HeaderOptions = {},
): Record<string, string> {
	const headers: Record<string, string> = {
		"x-composer-client": CLIENT_NAME,
		"x-maestro-client": CLIENT_NAME,
	};
	if (options.includeClientTools) {
		headers["x-composer-client-tools"] = "1";
		headers["x-maestro-client-tools"] = "1";
	}
	if (options.includeSlimEvents) {
		headers["x-composer-slim-events"] = "1";
		headers["x-maestro-slim-events"] = "1";
	}
	return headers;
}

export class ApiClient {
	public readonly baseUrl: string;

	constructor(baseUrl = "http://localhost:8080") {
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	private buildRequestInit(
		init?: RequestInit,
		headerOptions?: HeaderOptions,
	): RequestInit {
		const headers = new Headers(init?.headers);
		for (const [key, value] of Object.entries(
			createRequestHeaders(headerOptions),
		)) {
			headers.set(key, value);
		}
		return {
			...init,
			headers,
		};
	}

	private buildJsonRequestInit(
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		body?: unknown,
		headerOptions?: HeaderOptions,
	): RequestInit {
		return this.buildRequestInit(
			{
				method,
				headers:
					body !== undefined ? { "Content-Type": "application/json" } : {},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			},
			headerOptions,
		);
	}

	private async fetchJson<T>(
		path: string,
		init?: RequestInit,
		headerOptions?: HeaderOptions,
	): Promise<T> {
		const response = await fetch(
			`${this.baseUrl}${path}`,
			this.buildRequestInit(init, headerOptions),
		);
		return (await safeJson(response)) as T;
	}

	private async fetchJsonRequest<T>(
		path: string,
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		body?: unknown,
		headerOptions?: HeaderOptions,
	): Promise<T> {
		return await this.fetchJson<T>(
			path,
			this.buildJsonRequestInit(method, body, headerOptions),
		);
	}

	async getCommands(): Promise<CommandDefinition[]> {
		const data = await this.fetchJson<{
			commands: CommandDefinition[];
		}>("/api/commands");
		return data.commands || [];
	}

	/**
	 * Send a chat message and stream ALL agent events (text deltas, tool calls, thinking, etc.)
	 */
	async *chatWithEvents(
		request: ChatRequest,
		signal?: AbortSignal,
	): AsyncGenerator<AgentEvent, void, unknown> {
		const response = await fetch(
			`${this.baseUrl}/api/chat`,
			this.buildRequestInit(
				{
					...this.buildJsonRequestInit("POST", { ...request, stream: true }),
					signal,
				},
				{
					includeClientTools: true,
					includeSlimEvents: true,
				},
			),
		);

		if (!response.ok) {
			throw new Error(`API error: ${response.statusText}`);
		}

		if (!response.body) {
			throw new Error("No response body");
		}

		// Node.js fetch returns a NodeJS.ReadableStream for body, but types might imply web ReadableStream
		// We can cast to any to get the reader if we are in a web-like polyfill environment,
		// or iterate the body if it's a Node stream.
		// However, in VS Code extension host (Electron/Node), fetch might be the native Node 18+ fetch.
		// Let's assume standard web streams API for Node 18+.

		const reader = response.body.getReader();
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
						yield {
							type: "stream_error",
							message:
								e instanceof Error ? e.message : "Failed to parse SSE event",
							raw: data,
						};
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	async getModels(): Promise<Model[]> {
		try {
			const data = await this.fetchJson<{ models: Model[] }>("/api/models");
			return data.models || [];
		} catch (e) {
			console.error("Failed to fetch models:", e);
			return [];
		}
	}

	async createSession(title?: string): Promise<Session> {
		return await this.fetchJsonRequest<Session>("/api/sessions", "POST", {
			title,
		});
	}

	async listSessions(): Promise<SessionSummary[]> {
		const data = await this.fetchJson<{ sessions: SessionSummary[] }>(
			"/api/sessions",
		);
		return data.sessions || [];
	}

	async getSession(id: string): Promise<Session> {
		return await this.fetchJson<Session>(`/api/sessions/${id}`);
	}

	async submitApproval(requestId: string, decision: "approved" | "denied") {
		return await this.fetchJsonRequest<{ ok?: boolean }>(
			"/api/chat/approval",
			"POST",
			{ requestId, decision },
		);
	}

	async submitClientToolResult(
		toolCallId: string,
		content: Array<{ type: string; text?: string; [key: string]: unknown }>,
		isError: boolean,
	) {
		return await this.fetchJsonRequest<{ ok?: boolean }>(
			"/api/chat/client-tool-result",
			"POST",
			{ toolCallId, content, isError },
		);
	}
}
