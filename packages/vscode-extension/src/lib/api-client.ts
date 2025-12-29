/**
 * API Client for Composer Backend (VS Code Extension Version)
 */
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

export interface CommandDefinition {
	name: string;
	description?: string;
	prompt: string;
	args?: Array<{ name: string; required?: boolean }>;
}

export class ApiClient {
	public readonly baseUrl: string;

	constructor(baseUrl = "http://localhost:8080") {
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	// ... existing methods ...

	async getCommands(): Promise<CommandDefinition[]> {
		const response = await fetch(`${this.baseUrl}/api/commands`);
		const data = (await safeJson(response)) as {
			commands: CommandDefinition[];
		};
		return data.commands || [];
	}

	/**
	 * Send a chat message and stream ALL agent events (text deltas, tool calls, thinking, etc.)
	 */
	async *chatWithEvents(
		request: ChatRequest,
		signal?: AbortSignal,
	): AsyncGenerator<AgentEvent, void, unknown> {
		const response = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ...request, stream: true }),
			signal,
		});

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
			const res = await fetch(`${this.baseUrl}/api/models`);
			const data = (await safeJson(res)) as { models: Model[] };
			return data.models || [];
		} catch (e) {
			console.error("Failed to fetch models:", e);
			return [];
		}
	}

	async createSession(title?: string): Promise<Session> {
		const response = await fetch(`${this.baseUrl}/api/sessions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ title }),
		});
		return (await safeJson(response)) as Session;
	}

	async listSessions(): Promise<SessionSummary[]> {
		const response = await fetch(`${this.baseUrl}/api/sessions`);
		const data = (await safeJson(response)) as { sessions: SessionSummary[] };
		return data.sessions || [];
	}

	async getSession(id: string): Promise<Session> {
		const response = await fetch(`${this.baseUrl}/api/sessions/${id}`);
		return (await safeJson(response)) as Session;
	}

	async submitApproval(requestId: string, decision: "approved" | "denied") {
		const response = await fetch(`${this.baseUrl}/api/chat/approval`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ requestId, decision }),
		});
		if (!response.ok) {
			const error = await safeJson(response);
			throw new Error(
				(error as { error?: string })?.error ||
					`Request failed with status ${response.status}`,
			);
		}
		return safeJson(response);
	}

	async submitClientToolResult(
		toolCallId: string,
		content: Array<{ type: string; text?: string; [key: string]: unknown }>,
		isError: boolean,
	) {
		const response = await fetch(
			`${this.baseUrl}/api/chat/client-tool-result`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ toolCallId, content, isError }),
			},
		);
		if (!response.ok) {
			const error = await safeJson(response);
			throw new Error(
				(error as { error?: string })?.error ||
					`Request failed with status ${response.status}`,
			);
		}
		return safeJson(response);
	}
}
