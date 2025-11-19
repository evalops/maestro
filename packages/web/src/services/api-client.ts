/**
 * API Client for Composer Backend
 */

export interface Message {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp?: string;
}

export interface Model {
	id: string;
	provider: string;
	name: string;
	contextWindow?: number;
	maxOutputTokens?: number;
}

export interface ChatRequest {
	model: string;
	messages: Message[];
	stream?: boolean;
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
						if (!data) continue;

						try {
							const event = JSON.parse(data);

							// Handle different event types from Agent
							if (event.type === "done") {
								return;
							} else if (event.type === "content_block_delta" && event.text) {
								yield event.text;
							} else if (event.type === "text_delta" && event.text) {
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
}
