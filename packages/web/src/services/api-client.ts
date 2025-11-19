/**
 * API Client for Composer Backend
 */

export interface Message {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp?: string;
	tools?: Array<{ name: string; status: string }>;
}

export interface Model {
	id: string;
	provider: string;
	name: string;
	contextWindow?: number;
	maxOutputTokens?: number;
}

export interface Session {
	id: string;
	title: string;
	messages: Message[];
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

export interface ChatRequest {
	model: string;
	messages: Message[];
	stream?: boolean;
	sessionId?: string;
}

export interface ChatResponse {
	message: Message;
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

export class ApiClient {
	private baseUrl: string;

	constructor(baseUrl = "http://localhost:8080") {
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	/**
	 * Send a chat message and receive streaming response
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
							} else if (event.type === "content_block_delta" && event.text) {
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
	 * Get list of available models
	 */
	async getModels(): Promise<Model[]> {
		const response = await fetch(`${this.baseUrl}/api/models`);
		if (!response.ok) {
			throw new Error(`Failed to fetch models: ${response.statusText}`);
		}
		const data = await response.json();
		return data.models || [];
	}

	/**
	 * Get current model info
	 */
	async getCurrentModel(): Promise<Model | null> {
		try {
			const response = await fetch(`${this.baseUrl}/api/model`);
			if (!response.ok) return null;
			return await response.json();
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
			throw new Error(`Failed to set model: ${response.statusText}`);
		}
	}

	/**
	 * Get list of sessions
	 */
	async getSessions(): Promise<Session[]> {
		try {
			const response = await fetch(`${this.baseUrl}/api/sessions`);
			if (!response.ok) return [];
			const data = await response.json();
			return data.sessions || [];
		} catch (e) {
			console.error("Failed to fetch sessions:", e);
			return [];
		}
	}

	/**
	 * Get a specific session
	 */
	async getSession(sessionId: string): Promise<Session> {
		const response = await fetch(`${this.baseUrl}/api/sessions/${sessionId}`);
		if (!response.ok) {
			throw new Error(`Failed to fetch session: ${response.statusText}`);
		}
		return await response.json();
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
			throw new Error(`Failed to create session: ${response.statusText}`);
		}
		return await response.json();
	}

	/**
	 * Delete a session
	 */
	async deleteSession(sessionId: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/api/sessions/${sessionId}`, {
			method: "DELETE",
		});

		if (!response.ok) {
			throw new Error(`Failed to delete session: ${response.statusText}`);
		}
	}
}
