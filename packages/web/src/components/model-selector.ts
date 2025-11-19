/**
 * Model selection dialog component
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ApiClient, type Model } from "../services/api-client.js";

@customElement("model-selector")
export class ModelSelector extends LitElement {
	static styles = css`
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
			display: flex;
			align-items: center;
			justify-content: center;
			z-index: 1000;
		}

		.dialog {
			background: var(--bg-secondary, #252526);
			border: 1px solid var(--border-color, #3e3e42);
			border-radius: 8px;
			width: 90%;
			max-width: 600px;
			max-height: 80vh;
			display: flex;
			flex-direction: column;
		}

		.header {
			padding: 1rem;
			border-bottom: 1px solid var(--border-color, #3e3e42);
			display: flex;
			align-items: center;
			justify-content: space-between;
		}

		.header h2 {
			margin: 0;
			font-size: 1.125rem;
			font-weight: 600;
		}

		.close {
			background: none;
			border: none;
			color: var(--text-secondary, #969696);
			font-size: 1.5rem;
			cursor: pointer;
			padding: 0;
			width: 32px;
			height: 32px;
			display: flex;
			align-items: center;
			justify-content: center;
			border-radius: 4px;
		}

		.close:hover {
			background: var(--bg-primary, #1e1e1e);
		}

		.search {
			padding: 1rem;
			border-bottom: 1px solid var(--border-color, #3e3e42);
		}

		input {
			width: 100%;
			padding: 0.5rem;
			background: var(--bg-primary, #1e1e1e);
			border: 1px solid var(--border-color, #3e3e42);
			border-radius: 4px;
			color: var(--text-primary, #d4d4d4);
			font-size: 0.875rem;
			outline: none;
		}

		input:focus {
			border-color: var(--accent-color, #0e639c);
		}

		.models {
			flex: 1;
			overflow-y: auto;
			padding: 0.5rem;
		}

		.models::-webkit-scrollbar {
			width: 8px;
		}

		.models::-webkit-scrollbar-track {
			background: var(--bg-secondary, #252526);
		}

		.models::-webkit-scrollbar-thumb {
			background: var(--border-color, #3e3e42);
			border-radius: 4px;
		}

		.model-item {
			padding: 0.75rem;
			border-radius: 4px;
			cursor: pointer;
			transition: background 0.2s;
		}

		.model-item:hover {
			background: var(--bg-primary, #1e1e1e);
		}

		.model-item.selected {
			background: var(--accent-color, #0e639c);
			color: white;
		}

		.model-name {
			font-weight: 500;
		}

		.model-info {
			font-size: 0.75rem;
			color: var(--text-secondary, #969696);
			margin-top: 0.25rem;
		}

		.model-item.selected .model-info {
			color: rgba(255, 255, 255, 0.7);
		}

		.provider-badge {
			display: inline-block;
			padding: 0.125rem 0.5rem;
			background: var(--bg-primary, #1e1e1e);
			border-radius: 12px;
			font-size: 0.75rem;
			margin-top: 0.25rem;
		}

		.model-item.selected .provider-badge {
			background: rgba(255, 255, 255, 0.2);
		}

		.loading, .error, .empty {
			padding: 2rem;
			text-align: center;
			color: var(--text-secondary, #969696);
		}

		.error {
			color: #f48771;
		}
	`;

	@property({ type: Boolean }) open = false;
	@property() apiEndpoint = "http://localhost:8080";
	@property() currentModel = "";

	@state() private models: Model[] = [];
	@state() private filteredModels: Model[] = [];
	@state() private loading = false;
	@state() private error: string | null = null;
	@state() private searchQuery = "";

	private apiClient!: ApiClient;

	connectedCallback() {
		super.connectedCallback();
		this.apiClient = new ApiClient(this.apiEndpoint);
	}

	async updated(changed: Map<string, any>) {
		if (changed.has("open") && this.open) {
			await this.loadModels();
		}
	}

	private async loadModels() {
		this.loading = true;
		this.error = null;

		try {
			this.models = await this.apiClient.getModels();
			this.filteredModels = this.models;
		} catch (e) {
			this.error = e instanceof Error ? e.message : "Failed to load models";
		} finally {
			this.loading = false;
		}
	}

	private handleSearch(e: Event) {
		const target = e.target as HTMLInputElement;
		this.searchQuery = target.value.toLowerCase();

		this.filteredModels = this.models.filter(
			(model) =>
				model.id.toLowerCase().includes(this.searchQuery) ||
				model.name.toLowerCase().includes(this.searchQuery) ||
				model.provider.toLowerCase().includes(this.searchQuery),
		);
	}

	private async selectModel(model: Model) {
		try {
			await this.apiClient.setModel(model.id);
			this.dispatchEvent(
				new CustomEvent("model-selected", {
					detail: { model },
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

	render() {
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
													class="model-item ${this.currentModel === model.id ? "selected" : ""}"
													@click=${() => this.selectModel(model)}
												>
													<div class="model-name">${model.name}</div>
													<div class="provider-badge">${model.provider}</div>
													${
														model.contextWindow || model.maxOutputTokens
															? html`
																<div class="model-info">
																	${
																		model.contextWindow
																			? `${(model.contextWindow / 1000).toFixed(0)}K context`
																			: ""
																	}
																	${model.contextWindow && model.maxOutputTokens ? " • " : ""}
																	${
																		model.maxOutputTokens
																			? `${(model.maxOutputTokens / 1000).toFixed(0)}K output`
																			: ""
																	}
																</div>
															`
															: ""
													}
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
