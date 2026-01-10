/**
 * Settings panel component - comprehensive configuration interface
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
	ApiClient,
	Model,
	UsageSummary,
	WorkspaceStatus,
} from "../services/api-client.js";

@customElement("composer-settings")
export class ComposerSettings extends LitElement {
	static override styles = css`
		:host {
			display: flex;
			flex-direction: column;
			height: 100%;
			background: var(--bg-primary);
			color: var(--text-primary);
			font-family: var(--font-sans);
		}

		.settings-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 1.25rem 1.5rem;
			border-bottom: 1px solid var(--border-primary);
			background: var(--bg-primary);
		}

		.settings-header h2 {
			font-size: 0.9rem;
			font-weight: 600;
			margin: 0;
			color: var(--text-primary);
			letter-spacing: -0.01em;
		}

		.close-btn {
			width: 28px;
			height: 28px;
			padding: 0;
			background: transparent;
			border: 1px solid var(--border-primary);
			border-radius: 6px;
			color: var(--text-secondary);
			cursor: pointer;
			transition: all 0.2s;
			font-size: 0.9rem;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.close-btn:hover {
			background: var(--bg-panel);
			color: var(--text-primary);
			border-color: var(--border-secondary);
		}

		.settings-content {
			flex: 1;
			overflow-y: auto;
			padding: 1.5rem;
		}

		.section {
			margin-bottom: 2rem;
			background: var(--bg-secondary);
			border: 1px solid var(--border-primary);
			border-radius: 8px;
			overflow: hidden;
		}

		.section-header {
			padding: 0.75rem 1rem;
			background: var(--bg-panel);
			border-bottom: 1px solid var(--border-primary);
		}

		.section-header h3 {
			font-family: var(--font-mono);
			font-size: 0.7rem;
			font-weight: 600;
			margin: 0;
			color: var(--text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.section-content {
			padding: 1rem;
		}

		.info-grid {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 0.75rem 1.5rem;
			font-size: 0.8rem;
			line-height: 1.6;
		}

		.info-label {
			font-family: var(--font-mono);
			color: var(--text-tertiary);
			font-size: 0.7rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			padding-top: 0.15em;
		}

		.info-value {
			color: var(--text-primary);
			word-break: break-all;
			font-family: var(--font-mono);
		}

		.info-value.highlight {
			color: var(--accent-blue);
		}

		.info-value.success {
			color: var(--accent-green);
		}

		.info-value.warning {
			color: var(--accent-yellow);
		}

		.info-value.error {
			color: var(--accent-red);
		}

		.badge {
			display: inline-block;
			padding: 0.15rem 0.4rem;
			background: var(--bg-panel);
			border: 1px solid var(--border-primary);
			border-radius: 4px;
			font-size: 0.65rem;
			font-weight: 600;
			color: var(--text-secondary);
			text-transform: uppercase;
			margin-right: 0.35rem;
			font-family: var(--font-mono);
		}

		.badge.active {
			background: var(--accent-blue-dim);
			color: var(--accent-blue);
			border-color: transparent;
		}

		.badge.success {
			background: rgba(16, 185, 129, 0.1);
			color: var(--accent-green);
			border-color: transparent;
		}

		.badge.error {
			background: rgba(239, 68, 68, 0.1);
			color: var(--accent-red);
			border-color: transparent;
		}

		.model-grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
			gap: 1rem;
		}

		.model-card {
			background: var(--bg-primary);
			border: 1px solid var(--border-primary);
			border-radius: 6px;
			padding: 1rem;
			transition: all 0.2s;
			cursor: pointer;
		}

		.model-card:hover {
			border-color: var(--accent-blue);
			transform: translateY(-1px);
			box-shadow: var(--shadow-sm);
		}

		.model-card.selected {
			border-color: var(--accent-blue);
			background: var(--accent-blue-dim);
		}

		.model-name {
			font-size: 0.9rem;
			font-weight: 600;
			color: var(--text-primary);
			margin-bottom: 0.25rem;
			font-family: var(--font-sans);
		}

		.model-provider {
			font-size: 0.7rem;
			color: var(--text-tertiary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
			margin-bottom: 0.75rem;
			font-family: var(--font-mono);
		}

		.model-stats {
			display: flex;
			flex-wrap: wrap;
			gap: 0.35rem;
			margin-top: 0.75rem;
		}

		.usage-stats {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
			gap: 1rem;
			margin-bottom: 1.5rem;
		}

		.stat-card {
			background: var(--bg-secondary);
			border: 1px solid var(--border-primary);
			border-radius: 8px;
			padding: 1rem;
			text-align: center;
		}

		.stat-value {
			font-size: 1.5rem;
			font-weight: 700;
			color: var(--text-primary);
			margin-bottom: 0.35rem;
			font-family: var(--font-mono);
			letter-spacing: -0.03em;
		}

		.stat-label {
			font-size: 0.7rem;
			color: var(--text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
			font-family: var(--font-mono);
		}

		.empty-state {
			text-align: center;
			padding: 3rem 1rem;
			color: var(--text-tertiary);
			font-size: 0.8rem;
			font-family: var(--font-mono);
		}

		.loading {
			text-align: center;
			padding: 3rem 1rem;
			color: var(--text-tertiary);
			font-size: 0.8rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			font-family: var(--font-mono);
		}

		.error-message {
			background: rgba(239, 68, 68, 0.1);
			border-left: 3px solid var(--accent-red);
			padding: 0.75rem 1rem;
			margin-bottom: 1rem;
			font-size: 0.8rem;
			color: var(--accent-red);
			line-height: 1.5;
			font-family: var(--font-mono);
		}

		@media (max-width: 768px) {
			.model-grid {
				grid-template-columns: 1fr;
			}

			.usage-stats {
				grid-template-columns: 1fr;
			}
		}
	`;

	@property({ attribute: false }) apiClient!: ApiClient;
	@property({ type: String }) currentModel = "";
	@property({ attribute: false }) statusPrefetch: WorkspaceStatus | null = null;
	@property({ attribute: false }) modelsPrefetch: Model[] | null = null;
	@property({ attribute: false }) usagePrefetch: UsageSummary | null = null;

	@state() private loading = true;
	@state() private error: string | null = null;
	@state() private status: WorkspaceStatus | null = null;
	@state() private models: Model[] = [];
	@state() private usage: UsageSummary | null = null;
	@state() private selectedTab: "workspace" | "models" | "usage" = "workspace";

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadData();
	}

	private async loadData() {
		this.loading = true;
		this.error = null;

		try {
			let statusData = this.statusPrefetch;
			let modelsData = this.modelsPrefetch;
			let usageData = this.usagePrefetch;

			if (!statusData) statusData = await this.apiClient.getStatus();
			if (!modelsData || modelsData.length === 0)
				modelsData = await this.apiClient.getModels();
			if (!usageData) usageData = await this.apiClient.getUsage();

			this.status = statusData;
			this.models = modelsData || [];
			this.usage = usageData || null;

			if (!statusData || !modelsData || modelsData.length === 0) {
				throw new Error("Failed to load settings data");
			}
		} catch (e) {
			this.error = e instanceof Error ? e.message : "Failed to load settings";
		} finally {
			this.loading = false;
		}
	}

	private close() {
		this.dispatchEvent(
			new CustomEvent("close", { bubbles: true, composed: true }),
		);
	}

	private selectModel(model: Model) {
		this.dispatchEvent(
			new CustomEvent("model-select", {
				detail: { model: `${model.provider}/${model.id}` },
				bubbles: true,
				composed: true,
			}),
		);
		this.close();
	}

	private formatUptime(seconds: number): string {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		if (hours > 0) return `${hours}h ${minutes}m`;
		return `${minutes}m`;
	}

	private formatCost(cost: number): string {
		if (cost === 0) return "$0.00";
		if (cost < 0.01) return `$${cost.toFixed(4)}`;
		return `$${cost.toFixed(2)}`;
	}

	private formatTokens(count: number): string {
		if (count < 1000) return count.toString();
		if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
		return `${(count / 1_000_000).toFixed(1)}M`;
	}

	private renderWorkspaceTab() {
		if (!this.status)
			return html`<div class="loading">Loading workspace status...</div>`;

		return html`
			<div class="section">
				<div class="section-header">
					<h3>Workspace</h3>
				</div>
				<div class="section-content">
					<div class="info-grid">
						<div class="info-label">CWD:</div>
						<div class="info-value">${this.status.cwd}</div>

						${
							this.status.git
								? html`
							<div class="info-label">Git Branch:</div>
							<div class="info-value highlight">${this.status.git.branch}</div>

							${
								this.status.git.status
									? html`
								<div class="info-label">Git Status:</div>
								<div class="info-value">
									${
										this.status.git.status.total === 0
											? html`<span class="success">Clean</span>`
											: html`
											${this.status.git.status.modified > 0 ? html`<span class="badge">${this.status.git.status.modified} Modified</span>` : ""}
											${this.status.git.status.added > 0 ? html`<span class="badge success">${this.status.git.status.added} Added</span>` : ""}
											${this.status.git.status.deleted > 0 ? html`<span class="badge error">${this.status.git.status.deleted} Deleted</span>` : ""}
											${this.status.git.status.untracked > 0 ? html`<span class="badge">${this.status.git.status.untracked} Untracked</span>` : ""}
										`
									}
								</div>
							`
									: ""
							}
						`
								: html`
							<div class="info-label">Git:</div>
							<div class="info-value">Not a git repository</div>
						`
						}
					</div>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Context Files</h3>
				</div>
				<div class="section-content">
					<div class="info-grid">
						<div class="info-label">AGENT.md:</div>
						<div class="info-value ${this.status.context.agentMd ? "success" : ""}">
							${this.status.context.agentMd ? "Found" : "Not found"}
						</div>

						<div class="info-label">CLAUDE.md:</div>
						<div class="info-value ${this.status.context.claudeMd ? "success" : ""}">
							${this.status.context.claudeMd ? "Found" : "Not found"}
						</div>
					</div>
				</div>
			</div>

			<div class="section">
				<div class="section-header">
					<h3>Server</h3>
				</div>
				<div class="section-content">
					<div class="info-grid">
						<div class="info-label">Uptime:</div>
						<div class="info-value">${this.formatUptime(this.status.server.uptime)}</div>

						<div class="info-label">Node:</div>
						<div class="info-value">${this.status.server.version}</div>
					</div>
				</div>
			</div>
		`;
	}

	private renderModelsTab() {
		if (this.models.length === 0) {
			return html`<div class="empty-state">No models available</div>`;
		}

		// Group by provider
		const byProvider = new Map<string, Model[]>();
		for (const model of this.models) {
			if (!byProvider.has(model.provider)) {
				byProvider.set(model.provider, []);
			}
			byProvider.get(model.provider)?.push(model);
		}

		return html`
			${[...byProvider.entries()].map(
				([provider, models]) => html`
				<div class="section">
					<div class="section-header">
						<h3>${provider.toUpperCase()} (${models.length})</h3>
					</div>
					<div class="section-content">
						<div class="model-grid">
							${models.map((model) => {
								const isSelected =
									this.currentModel === `${model.provider}/${model.id}`;
								return html`
									<div
										class="model-card ${isSelected ? "selected" : ""}"
										@click=${() => this.selectModel(model)}
									>
										<div class="model-name">${model.name}</div>
										<div class="model-provider">${model.provider}</div>
									<div class="info-grid">
										<div class="info-label">Context:</div>
										<div class="info-value">${this.formatTokens(model.contextWindow ?? 0)}</div>

										<div class="info-label">Max Out:</div>
										<div class="info-value">${this.formatTokens(model.maxTokens ?? model.maxOutputTokens ?? 0)}</div>

										<div class="info-label">Cost/1M:</div>
										<div class="info-value">
											In: ${this.formatCost(model.cost?.input ?? 0)} / Out: ${this.formatCost(model.cost?.output ?? 0)}
										</div>

										${
											model.cost?.cacheRead !== undefined ||
											model.cost?.cacheWrite !== undefined
												? html`
											<div class="info-label">Cache:</div>
											<div class="info-value">${this.formatCost(model.cost?.cacheRead ?? 0)} read / ${this.formatCost(model.cost?.cacheWrite ?? 0)} write</div>
										`
												: ""
										}

										${
											model.api
												? html`
											<div class="info-label">API:</div>
											<div class="info-value">${model.api}</div>
										`
												: ""
										}
									</div>
										<div class="model-stats">
											${model.capabilities?.vision ? html`<span class="badge active">Vision</span>` : ""}
											${model.capabilities?.reasoning ? html`<span class="badge active">Reasoning</span>` : ""}
											${model.capabilities?.tools ? html`<span class="badge active">Tools</span>` : ""}
										</div>
									</div>
								`;
							})}
						</div>
					</div>
				</div>
			`,
			)}
		`;
	}

	private renderUsageTab() {
		if (!this.usage) {
			return html`<div class="empty-state">No usage data available</div>`;
		}

		const totals = this.usage.totalTokensDetailed ||
			this.usage.totalTokensBreakdown || {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: this.usage.totalTokens || 0,
			};
		const cachedTotal = totals.cacheRead + totals.cacheWrite;
		const totalRequests = this.usage.totalRequests ?? 0;

		return html`
			<div class="usage-stats">
				<div class="stat-card">
					<div class="stat-value">${this.formatCost(this.usage.totalCost)}</div>
					<div class="stat-label">Total Cost</div>
				</div>
				<div class="stat-card">
					<div class="stat-value">${this.formatTokens(totals.input + totals.output)}</div>
					<div class="stat-label">Tokens (In + Out)</div>
				</div>
				<div class="stat-card">
					<div class="stat-value">${this.formatTokens(cachedTotal)}</div>
					<div class="stat-label">Cached Tokens</div>
				</div>
				<div class="stat-card">
					<div class="stat-value">${totalRequests}</div>
					<div class="stat-label">Requests</div>
				</div>
			</div>

			${
				Object.keys(this.usage.byProvider).length > 0
					? html`
				<div class="section">
					<div class="section-header">
						<h3>By Provider</h3>
					</div>
					<div class="section-content">
						<div class="info-grid">
							${Object.entries(this.usage.byProvider).map(
								([provider, stats]) => html`
								<div class="info-label">${provider}:</div>
								<div class="info-value">
									${this.formatCost(stats.cost)} (${stats.calls ?? stats.requests ?? 0} calls, ${this.formatTokens((stats.tokensDetailed?.total ?? stats.tokens) || 0)} tok)
								</div>
							`,
							)}
						</div>
					</div>
				</div>
			`
					: ""
			}

				${
					Object.keys(this.usage.byModel).length > 0
						? html`
					<div class="section">
						<div class="section-header">
							<h3>By Model</h3>
					</div>
						<div class="section-content">
							<div class="info-grid">
								${Object.entries(this.usage.byModel).map(
									([model, stats]) => html`
									<div class="info-label">${model}:</div>
									<div class="info-value">
										${this.formatCost(stats.cost)} (${stats.calls ?? stats.requests ?? 0} calls, ${this.formatTokens((stats.tokensDetailed?.total ?? stats.tokens) || 0)} tok)
									</div>
								`,
								)}
						</div>
					</div>
				</div>
			`
						: ""
				}
		`;
	}

	override render() {
		return html`
			<div class="settings-header">
				<h2>⚙ Settings</h2>
				<button class="close-btn" @click=${this.close}>✕</button>
			</div>

			${this.error ? html`<div class="error-message">${this.error}</div>` : ""}

			<div class="settings-content">
				${
					this.loading
						? html`<div class="loading">Loading settings...</div>`
						: html`
						${this.renderWorkspaceTab()}
						${this.renderModelsTab()}
						${this.renderUsageTab()}
					`
				}
			</div>
		`;
	}
}
