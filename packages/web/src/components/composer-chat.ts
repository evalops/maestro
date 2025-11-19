/**
 * Main chat interface component
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ApiClient, type Message } from "../services/api-client.js";

@customElement("composer-chat")
export class ComposerChat extends LitElement {
	static styles = css`
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			background: var(--bg-primary, #0d1117);
			color: var(--text-primary, #e6edf3);
			border-radius: 8px;
			overflow: hidden;
			box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
		}

		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 1.25rem 1.5rem;
			border-bottom: 1px solid var(--border-color, #30363d);
			background: var(--bg-secondary, #161b22);
			backdrop-filter: blur(10px);
		}

		.header h1 {
			font-size: 1.5rem;
			font-weight: 700;
			margin: 0;
			background: linear-gradient(135deg, var(--accent-color, #2f81f7) 0%, var(--accent-hover, #539bf5) 100%);
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
			background-clip: text;
		}

		.model-info {
			font-size: 0.875rem;
			color: var(--text-secondary, #7d8590);
			padding: 0.375rem 0.75rem;
			background: var(--bg-tertiary, #21262d);
			border-radius: 6px;
			font-weight: 500;
		}

		.messages {
			flex: 1;
			overflow-y: auto;
			padding: 1rem;
			display: flex;
			flex-direction: column;
			gap: 1rem;
		}

		.messages::-webkit-scrollbar {
			width: 10px;
		}

		.messages::-webkit-scrollbar-track {
			background: var(--bg-primary, #0d1117);
		}

		.messages::-webkit-scrollbar-thumb {
			background: var(--border-color, #30363d);
			border-radius: 5px;
			transition: background 0.2s;
		}

		.messages::-webkit-scrollbar-thumb:hover {
			background: #484f58;
		}

		.input-container {
			border-top: 1px solid var(--border-color, #30363d);
			padding: 1.25rem 1.5rem;
			background: var(--bg-secondary, #161b22);
			backdrop-filter: blur(10px);
		}

		.error {
			padding: 1rem 1.25rem;
			background: rgba(248, 81, 73, 0.1);
			color: #f85149;
			border-radius: 8px;
			margin: 1rem 1.5rem;
			border-left: 3px solid #f85149;
			font-size: 0.9375rem;
			animation: slideIn 0.3s ease-out;
		}

		@keyframes slideIn {
			from {
				opacity: 0;
				transform: translateX(-10px);
			}
			to {
				opacity: 1;
				transform: translateX(0);
			}
		}

		.loading {
			display: flex;
			align-items: center;
			gap: 0.75rem;
			padding: 1rem 1.25rem;
			color: var(--text-secondary, #7d8590);
			font-size: 0.9375rem;
			animation: pulse 2s ease-in-out infinite;
		}

		.loading::before {
			content: "";
			width: 18px;
			height: 18px;
			border: 2.5px solid var(--border-color, #30363d);
			border-top-color: var(--accent-color, #2f81f7);
			border-radius: 50%;
			animation: spin 0.8s linear infinite;
		}

		@keyframes spin {
			to { transform: rotate(360deg); }
		}

		@keyframes pulse {
			0%, 100% { opacity: 0.7; }
			50% { opacity: 1; }
		}
	`;

	@property() apiEndpoint = "http://localhost:8080";
	@property() model = "claude-sonnet-4-5";

	@state() private messages: Message[] = [];
	@state() private loading = false;
	@state() private error: string | null = null;
	@state() private currentModel = "";

	private apiClient!: ApiClient;

	connectedCallback() {
		super.connectedCallback();
		this.apiClient = new ApiClient(this.apiEndpoint);
		this.loadCurrentModel();
	}

	private async loadCurrentModel() {
		try {
			const model = await this.apiClient.getCurrentModel();
			this.currentModel = model ? `${model.provider}/${model.id}` : this.model;
		} catch (e) {
			console.error("Failed to load current model:", e);
			this.currentModel = this.model;
		}
	}

	private async handleSubmit(event: CustomEvent<{ text: string }>) {
		const text = event.detail.text.trim();
		if (!text || this.loading) return;

		// Add user message
		const userMessage: Message = {
			role: "user",
			content: text,
			timestamp: new Date().toISOString(),
		};
		this.messages = [...this.messages, userMessage];

		// Start loading
		this.loading = true;
		this.error = null;

		// Add assistant message placeholder
		const assistantMessage: Message = {
			role: "assistant",
			content: "",
			timestamp: new Date().toISOString(),
		};
		this.messages = [...this.messages, assistantMessage];

		try {
			// Stream response
			const stream = this.apiClient.chat({
				model: this.currentModel,
				messages: this.messages.slice(0, -1), // Exclude placeholder
			});

			for await (const chunk of stream) {
				assistantMessage.content += chunk;
				this.messages = [...this.messages]; // Trigger update
				this.scrollToBottom();
			}
		} catch (e) {
			this.error = e instanceof Error ? e.message : "Failed to send message";
			this.messages = this.messages.slice(0, -1); // Remove placeholder
		} finally {
			this.loading = false;
		}
	}

	private scrollToBottom() {
		this.updateComplete.then(() => {
			const messagesEl = this.shadowRoot?.querySelector(".messages");
			if (messagesEl) {
				messagesEl.scrollTop = messagesEl.scrollHeight;
			}
		});
	}

	render() {
		return html`
			<div class="header">
				<h1>Composer</h1>
				<div class="model-info">${this.currentModel}</div>
			</div>

			${this.error ? html`<div class="error">${this.error}</div>` : ""}

			<div class="messages">
				${this.messages.map(
					(msg) => html`
						<composer-message
							role=${msg.role}
							content=${msg.content}
							timestamp=${msg.timestamp || ""}
						></composer-message>
					`,
				)}
				${this.loading ? html`<div class="loading">Thinking...</div>` : ""}
			</div>

			<div class="input-container">
				<composer-input
					@submit=${this.handleSubmit}
					?disabled=${this.loading}
				></composer-input>
			</div>
		`;
	}
}
