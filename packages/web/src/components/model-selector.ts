/**
 * Model selection dialog component
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ApiClient, type Model } from "../services/api-client.js";

const SEARCH_DEBOUNCE = 150;

@customElement("model-selector")
export class ModelSelector extends LitElement {
	static override styles = css`
		:host {
			display: block;
		}

		.overlay {
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: rgba(0, 0, 0, 0.5);
			backdrop-filter: blur(4px);
			display: flex;
			align-items: center;
			justify-content: center;
			z-index: 1000;
		}

		.dialog {
			background: var(--bg-secondary);
			border: 1px solid var(--border-primary);
			border-radius: 12px;
			width: 90%;
			max-width: 600px;
			max-height: 80vh;
			display: flex;
			flex-direction: column;
			box-shadow: var(--shadow-lg);
			overflow: hidden;
		}

		.header {
			padding: 1rem 1.25rem;
			border-bottom: 1px solid var(--border-primary);
			display: flex;
			align-items: center;
			justify-content: space-between;
			background: var(--bg-panel);
		}

		.header h2 {
			margin: 0;
			font-size: 1rem;
			font-weight: 600;
			color: var(--text-primary);
			font-family: var(--font-sans);
		}

		.close {
			background: none;
			border: 1px solid var(--border-primary);
			color: var(--text-secondary);
			font-size: 1.25rem;
			cursor: pointer;
			padding: 0;
			width: 28px;
			height: 28px;
			display: flex;
			align-items: center;
			justify-content: center;
			border-radius: 6px;
			transition: all 0.2s;
		}

		.close:hover {
			background: var(--bg-primary);
			color: var(--text-primary);
			border-color: var(--border-secondary);
		}

		.search {
			padding: 1rem 1.25rem;
			border-bottom: 1px solid var(--border-primary);
			background: var(--bg-primary);
		}

		input {
			width: 100%;
			padding: 0.75rem 1rem;
			background: var(--bg-secondary);
			border: 1px solid var(--border-primary);
			border-radius: 8px;
			color: var(--text-primary);
			font-size: 0.9rem;
			outline: none;
			transition: border-color 0.2s;
			font-family: var(--font-sans);
		}

		input:focus {
			border-color: var(--accent-blue);
			background: var(--bg-primary);
		}

		.models {
			flex: 1;
			overflow-y: auto;
			padding: 0.75rem;
			background: var(--bg-primary);
		}

		.models::-webkit-scrollbar {
			width: 8px;
		}

		.models::-webkit-scrollbar-track {
			background: transparent;
		}

		.models::-webkit-scrollbar-thumb {
			background: var(--border-secondary);
			border-radius: 4px;
		}

		.model-item {
			padding: 0.875rem 1rem;
			border-radius: 8px;
			cursor: pointer;
			transition: all 0.2s;
			margin-bottom: 2px;
			border: 1px solid transparent;
		}

		.model-item:hover {
			background: var(--bg-secondary);
			border-color: var(--border-primary);
		}

		.model-item.selected {
			background: var(--accent-blue-dim);
			border-color: rgba(59, 130, 246, 0.3);
		}

		.model-name {
			font-weight: 600;
			font-size: 0.9rem;
			color: var(--text-primary);
			font-family: var(--font-sans);
		}

		.model-item.selected .model-name {
			color: var(--accent-blue);
		}

		.model-info {
			font-size: 0.75rem;
			color: var(--text-tertiary);
			margin-top: 0.35rem;
			font-family: var(--font-mono);
		}

		.model-item.selected .model-info {
			color: var(--text-secondary);
		}

		.provider-badge {
			display: inline-block;
			padding: 0.15rem 0.5rem;
			background: var(--bg-panel);
			border-radius: 4px;
			font-size: 0.7rem;
			margin-top: 0.25rem;
			color: var(--text-secondary);
			font-weight: 500;
			text-transform: uppercase;
			letter-spacing: 0.02em;
		}

		.model-item.selected .provider-badge {
			background: var(--bg-primary);
			color: var(--accent-blue);
		}

		.loading, .error, .empty {
			padding: 3rem;
			text-align: center;
			color: var(--text-tertiary);
			font-family: var(--font-mono);
			font-size: 0.8rem;
		}

		.error {
			color: var(--accent-red);
		}
	`;

	@property({ type: Boolean }) open = false;
	@property() apiEndpoint = "http://localhost:8080";
	@property() currentModel = "";
	@property({ attribute: false }) modelsPrefetch: Model[] | null = null;
	@property({ attribute: false }) apiClient: ApiClient | null = null;

	@state() private models: Model[] = [];
	@state() private filteredModels: Model[] = [];
	@state() private loading = false;
	@state() private error: string | null = null;
	@state() private searchQuery = "";
	private searchTimer: number | null = null;
	private localApiClient: ApiClient | null = null;

	override async updated(changed: Map<string, unknown>) {
		if (changed.has("open") && this.open) {
			await this.loadModels();
		}
	}

	private async loadModels() {
		this.loading = true;
		this.error = null;

		try {
			if (this.modelsPrefetch && this.modelsPrefetch.length > 0) {
				this.models = this.modelsPrefetch;
			} else {
				this.models = await this.getApiClient().getModels();
			}
			this.filteredModels = this.models;
		} catch (e) {
			this.error = e instanceof Error ? e.message : "Failed to load models";
		} finally {
			this.loading = false;
		}
	}

	private getApiClient(): ApiClient {
		if (this.apiClient) return this.apiClient;
		this.localApiClient ??= new ApiClient(this.apiEndpoint);
		return this.localApiClient;
	}

	private handleSearch(e: Event) {
		const target = e.target as HTMLInputElement;
		const value = target.value.toLowerCase();
		if (this.searchTimer) window.clearTimeout(this.searchTimer);
		this.searchTimer = window.setTimeout(() => {
			this.searchQuery = value;
			this.filteredModels = this.models.filter(
				(model) =>
					model.id.toLowerCase().includes(this.searchQuery) ||
					model.name.toLowerCase().includes(this.searchQuery) ||
					model.provider.toLowerCase().includes(this.searchQuery),
			);
		}, SEARCH_DEBOUNCE);
	}

	private async selectModel(model: Model) {
		try {
			const modelKey = `${model.provider}/${model.id}`;
			this.dispatchEvent(
				new CustomEvent("model-selected", {
					detail: { model: modelKey },
					bubbles: true,
					composed: true,
				}),
			);
			this.close();
		} catch (e) {
			this.error = e instanceof Error ? e.message : "Failed to set model";
		}
	}

	private close() {
		this.open = false;
		this.dispatchEvent(new Event("close", { bubbles: true, composed: true }));
	}

	private handleOverlayClick(e: Event) {
		if (e.target === e.currentTarget) {
			this.close();
		}
	}

	override render() {
		if (!this.open) return html``;

		return html`
			<div class="overlay" @click=${this.handleOverlayClick}>
				<div class="dialog">
					<div class="header">
						<h2>Select Model</h2>
						<button class="close" @click=${this.close}>&times;</button>
					</div>

					<div class="search">
						<input
							type="text"
							placeholder="Search models..."
							@input=${this.handleSearch}
							.value=${this.searchQuery}
						/>
					</div>

					<div class="models">
						${
							this.loading
								? html`<div class="loading">Loading models...</div>`
								: this.error
									? html`<div class="error">${this.error}</div>`
									: this.filteredModels.length === 0
										? html`<div class="empty">No models found</div>`
										: this.filteredModels.map(
												(model) => html`
								<div
								class="model-item ${
									this.currentModel === `${model.provider}/${model.id}`
										? "selected"
										: ""
								}"
									@click=${() => this.selectModel(model)}
								>
									<div class="model-name">${model.name}</div>
									<div class="provider-badge">${model.provider}</div>
									<div class="model-info">
										${model.contextWindow ? `${(model.contextWindow / 1000).toFixed(0)}k ctx` : "ctx n/a"}
										${model.maxOutputTokens ? ` • ${(model.maxOutputTokens / 1000).toFixed(0)}k out` : ""}
										${
											model.cost?.input !== undefined
												? html` • $${(model.cost.input * 1_000_000).toFixed(2)} /1M in`
												: ""
										}
									</div>
													<div class="model-info">
														${model.capabilities?.tools ? "tools " : ""}
														${model.capabilities?.vision ? "vision " : ""}
														${model.capabilities?.reasoning ? "reasoning " : ""}
													</div>
								</div>
							`,
											)
						}
					</div>
				</div>
			</div>
		`;
	}
}
