/**
 * API Client for Composer Backend (VS Code Extension Version)
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

export interface AgentEvent {
	type: string;
	[key: string]: any;
}

export interface Model {
	id: string;
	provider: string;
	name: string;
	contextWindow?: number;
	maxOutputTokens?: number;
	maxTokens?: number;
	api?: string;
}

export type Session = ComposerSession;
export type SessionSummary = ComposerSessionSummary;
export type ChatRequest = ComposerChatRequest;

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

	constructor(baseUrl = "http://localhost:8080") {
		this.baseUrl = baseUrl.replace(/\/$/, "");
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
}
