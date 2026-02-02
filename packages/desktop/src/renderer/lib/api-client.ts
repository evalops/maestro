/**
 * API Client for Composer Backend
 *
 * Handles communication with the embedded Composer server.
 */

import type {
	AgentEvent,
	Message,
	Model,
	Session,
	SessionSummary,
	WorkspaceStatus,
} from "./types";

const DEFAULT_BASE_URL = "http://localhost:8080";
const MAX_SSE_BUFFER = 1024 * 1024; // 1MB

export class ApiClient {
	private baseUrl: string;

	constructor(baseUrl: string = DEFAULT_BASE_URL) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	private async fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			...options,
			headers: {
				"Content-Type": "application/json",
				...options?.headers,
			},
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(
				`API error: ${response.status} ${response.statusText} - ${text}`,
			);
		}

		return response.json();
	}

	// Models
	async getModels(): Promise<Model[]> {
		try {
			const data = await this.fetchJson<{ models: Model[] }>("/api/models");
			return data.models || [];
		} catch (error) {
			console.error("Failed to fetch models:", error);
			return [];
		}
	}

	async getCurrentModel(): Promise<Model | null> {
		try {
			return await this.fetchJson<Model>("/api/model");
		} catch {
			return null;
		}
	}

	async setModel(modelId: string): Promise<void> {
		await this.fetchJson("/api/model", {
			method: "POST",
			body: JSON.stringify({ model: modelId }),
		});
	}

	// Sessions
	async getSessions(): Promise<SessionSummary[]> {
		try {
			const data = await this.fetchJson<{ sessions: SessionSummary[] }>(
				"/api/sessions",
			);
			return data.sessions || [];
		} catch (error) {
			console.error("Failed to fetch sessions:", error);
			return [];
		}
	}

	async getSession(sessionId: string): Promise<Session | null> {
		try {
			return await this.fetchJson<Session>(`/api/sessions/${sessionId}`);
		} catch {
			return null;
		}
	}

	async createSession(title?: string): Promise<Session> {
		return this.fetchJson<Session>("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ title }),
		});
	}

	async deleteSession(sessionId: string): Promise<void> {
		await fetch(`${this.baseUrl}/api/sessions/${sessionId}`, {
			method: "DELETE",
		});
	}

	// Chat (streaming)
	async *chat(request: {
		sessionId?: string;
		messages: Message[];
		model?: string;
	}): AsyncGenerator<AgentEvent, void, unknown> {
		const response = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-composer-slim-events": "1",
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
					throw new Error("SSE buffer exceeded maximum size");
				}

				// Parse SSE events
				const lines = buffer.split("\n\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.trim()) continue;

					const dataLines = line
						.split("\n")
						.filter((l) => l.startsWith("data:"));
					for (const dataLine of dataLines) {
						const data = dataLine.slice(5).trim();
						if (!data || data === "[DONE]") continue;

						try {
							const event = JSON.parse(data) as AgentEvent;
							yield event;
						} catch {
							console.warn("Failed to parse SSE data:", data);
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	// Status
	async getStatus(): Promise<WorkspaceStatus | null> {
		try {
			return await this.fetchJson<WorkspaceStatus>("/api/status");
		} catch {
			return null;
		}
	}
}

// Default client instance
export const apiClient = new ApiClient();
