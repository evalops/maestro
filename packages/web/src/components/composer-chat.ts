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
			background: var(--bg-primary, #1e1e1e);
			color: var(--text-primary, #d4d4d4);
		}

		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 1rem;
			border-bottom: 1px solid var(--border-color, #3e3e42);
			background: var(--bg-secondary, #252526);
		}

		.header h1 {
			font-size: 1.25rem;
			font-weight: 600;
			margin: 0;
		}

		.model-info {
			font-size: 0.875rem;
			color: var(--text-secondary, #969696);
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
			width: 8px;
		}

		.messages::-webkit-scrollbar-track {
			background: var(--bg-primary, #1e1e1e);
		}

		.messages::-webkit-scrollbar-thumb {
			background: var(--border-color, #3e3e42);
			border-radius: 4px;
		}

		.input-container {
			border-top: 1px solid var(--border-color, #3e3e42);
			padding: 1rem;
			background: var(--bg-secondary, #252526);
		}

		.error {
			padding: 1rem;
			background: #5a1d1d;
			color: #f48771;
			border-radius: 4px;
			margin: 0 1rem 1rem;
		}

		.loading {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			padding: 1rem;
			color: var(--text-secondary, #969696);
		}

		.loading::before {
			content: "";
			width: 16px;
			height: 16px;
			border: 2px solid var(--border-color, #3e3e42);
			border-top-color: var(--accent-color, #0e639c);
			border-radius: 50%;
			animation: spin 1s linear infinite;
		}

		@keyframes spin {
			to { transform: rotate(360deg); }
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
