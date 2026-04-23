import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
	type EnterpriseApiClient,
	type FleetAgentHealth,
	type FleetAgentInstance,
	type FleetDashboardResponse,
	getEnterpriseApi,
} from "../services/enterprise-api.js";

type FleetApi = Pick<EnterpriseApiClient, "getFleetStatus">;

interface FleetAttentionItem {
	instance: FleetAgentInstance;
	pending: number;
	signals: string[];
}

interface FleetProviderFootprint {
	key: string;
	provider: string;
	model: string;
	instances: number;
	activeTasks: number;
	connections: number;
	subscribers: number;
	errorRate: number;
}

@customElement("fleet-dashboard")
export class FleetDashboard extends LitElement {
	static override styles = css`
		:host {
			--fleet-bg-base: var(--admin-bg-base, #0c0d0f);
			--fleet-bg-elevated: var(--admin-bg-elevated, #111214);
			--fleet-bg-surface: var(--admin-bg-surface, #161719);
			--fleet-border: var(--admin-border, #1e2023);
			--fleet-border-subtle: var(--admin-border-subtle, #141517);
			--fleet-text-primary: var(--admin-text-primary, #e8e9eb);
			--fleet-text-secondary: var(--admin-text-secondary, #8b8d91);
			--fleet-text-tertiary: var(--admin-text-tertiary, #5c5e62);
			--fleet-accent-amber: var(--admin-accent-amber, #d4a012);
			--fleet-accent-amber-dim: var(--admin-accent-amber-dim, rgba(212, 160, 18, 0.12));
			--fleet-accent-green: var(--admin-accent-green, #22c55e);
			--fleet-accent-green-dim: var(--admin-accent-green-dim, rgba(34, 197, 94, 0.12));
			--fleet-accent-red: var(--admin-accent-red, #ef4444);
			--fleet-accent-red-dim: var(--admin-accent-red-dim, rgba(239, 68, 68, 0.12));
			--fleet-accent-blue: var(--admin-accent-blue, #3b82f6);
			--fleet-accent-blue-dim: var(--admin-accent-blue-dim, rgba(59, 130, 246, 0.12));
			--fleet-font-display: var(--font-display, "DM Sans", system-ui, sans-serif);
			--fleet-font-mono: var(--font-mono, "JetBrains Mono", "SF Mono", monospace);

			display: block;
			color: var(--fleet-text-primary);
			font-family: var(--fleet-font-display);
		}

		.toolbar {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 1rem;
			margin-bottom: 1.5rem;
		}

		.timestamp {
			color: var(--fleet-text-tertiary);
			font-family: var(--fleet-font-mono);
			font-size: 0.65rem;
			letter-spacing: 0.08em;
			text-transform: uppercase;
		}

		.refresh-btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: 36px;
			height: 36px;
			border: 1px solid var(--fleet-border);
			background: var(--fleet-bg-elevated);
			color: var(--fleet-text-secondary);
			cursor: pointer;
			transition: all 0.15s ease;
		}

		.refresh-btn:hover:not(:disabled) {
			background: var(--fleet-bg-surface);
			color: var(--fleet-text-primary);
		}

		.refresh-btn:disabled {
			opacity: 0.45;
			cursor: progress;
		}

		.stats-grid {
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 1px;
			background: var(--fleet-border);
			border: 1px solid var(--fleet-border);
			margin-bottom: 1.5rem;
		}

		.stat-card {
			background: var(--fleet-bg-base);
			padding: 1.25rem;
			min-width: 0;
		}

		.stat-value {
			font-family: var(--fleet-font-mono);
			font-size: 1.8rem;
			font-weight: 700;
			line-height: 1;
			margin-bottom: 0.5rem;
		}

		.stat-card.success .stat-value {
			color: var(--fleet-accent-green);
		}

		.stat-card.warning .stat-value {
			color: var(--fleet-accent-amber);
		}

		.stat-card.danger .stat-value {
			color: var(--fleet-accent-red);
		}

		.stat-label {
			color: var(--fleet-text-tertiary);
			font-family: var(--fleet-font-mono);
			font-size: 0.6rem;
			letter-spacing: 0.1em;
			text-transform: uppercase;
		}

		.section {
			background: var(--fleet-bg-base);
			border: 1px solid var(--fleet-border);
			margin-bottom: 1.5rem;
			overflow: hidden;
		}

		.section-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 1rem 1.25rem;
			background: var(--fleet-bg-elevated);
			border-bottom: 1px solid var(--fleet-border);
		}

		.section-header h3 {
			color: var(--fleet-text-tertiary);
			font-family: var(--fleet-font-mono);
			font-size: 0.65rem;
			font-weight: 600;
			letter-spacing: 0.12em;
			margin: 0;
			text-transform: uppercase;
		}

		.data-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 0.8rem;
		}

		.data-table th {
			background: var(--fleet-bg-elevated);
			border-bottom: 1px solid var(--fleet-border);
			color: var(--fleet-text-tertiary);
			font-family: var(--fleet-font-mono);
			font-size: 0.6rem;
			font-weight: 600;
			letter-spacing: 0.1em;
			padding: 0.875rem 1rem;
			text-align: left;
			text-transform: uppercase;
		}

		.data-table td {
			border-bottom: 1px solid var(--fleet-border-subtle);
			color: var(--fleet-text-primary);
			padding: 0.875rem 1rem;
			vertical-align: top;
		}

		.data-table tr:last-child td {
			border-bottom: none;
		}

		.identity {
			display: flex;
			flex-direction: column;
			gap: 0.3rem;
			min-width: 0;
		}

		code {
			background: var(--fleet-accent-amber-dim);
			color: var(--fleet-accent-amber);
			font-family: var(--fleet-font-mono);
			font-size: 0.72rem;
			padding: 0.15rem 0.35rem;
			white-space: nowrap;
		}

		.muted {
			color: var(--fleet-text-tertiary);
			font-family: var(--fleet-font-mono);
			font-size: 0.68rem;
		}

		.badge {
			display: inline-flex;
			align-items: center;
			background: var(--fleet-bg-surface);
			color: var(--fleet-text-secondary);
			font-family: var(--fleet-font-mono);
			font-size: 0.6rem;
			font-weight: 600;
			letter-spacing: 0.05em;
			padding: 0.25rem 0.5rem;
			text-transform: uppercase;
		}

		.badge::before {
			content: "";
			width: 6px;
			height: 6px;
			border-radius: 50%;
			background: currentColor;
			margin-right: 0.4rem;
		}

		.badge.healthy {
			background: var(--fleet-accent-green-dim);
			color: var(--fleet-accent-green);
		}

		.badge.idle,
		.badge.degraded {
			background: var(--fleet-accent-amber-dim);
			color: var(--fleet-accent-amber);
		}

		.badge.unhealthy {
			background: var(--fleet-accent-red-dim);
			color: var(--fleet-accent-red);
		}

		.metric-list {
			display: grid;
			gap: 0.25rem;
			color: var(--fleet-text-secondary);
			font-family: var(--fleet-font-mono);
			font-size: 0.68rem;
			line-height: 1.4;
		}

		.health-grid,
		.insight-grid {
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 1px;
			background: var(--fleet-border);
		}

		.insight-grid {
			grid-template-columns: 1.1fr 1.4fr;
		}

		.health-cell,
		.insight-panel {
			background: var(--fleet-bg-base);
			min-width: 0;
			padding: 1.1rem 1.25rem;
		}

		.health-value {
			font-family: var(--fleet-font-mono);
			font-size: 1.45rem;
			font-weight: 700;
			line-height: 1;
			margin-bottom: 0.45rem;
		}

		.health-cell.healthy .health-value {
			color: var(--fleet-accent-green);
		}

		.health-cell.degraded .health-value,
		.health-cell.idle .health-value {
			color: var(--fleet-accent-amber);
		}

		.health-cell.unhealthy .health-value {
			color: var(--fleet-accent-red);
		}

		.health-label,
		.insight-title {
			color: var(--fleet-text-tertiary);
			font-family: var(--fleet-font-mono);
			font-size: 0.6rem;
			font-weight: 600;
			letter-spacing: 0;
			text-transform: uppercase;
		}

		.insight-title {
			margin-bottom: 0.8rem;
		}

		.signal-list {
			display: flex;
			flex-wrap: wrap;
			gap: 0.35rem;
		}

		.signal-pill {
			background: var(--fleet-bg-surface);
			color: var(--fleet-text-secondary);
			font-family: var(--fleet-font-mono);
			font-size: 0.6rem;
			padding: 0.25rem 0.45rem;
		}

		.compact-table {
			width: 100%;
			border-collapse: collapse;
			font-size: 0.76rem;
		}

		.compact-table td,
		.compact-table th {
			border-bottom: 1px solid var(--fleet-border-subtle);
			padding: 0.55rem 0;
			text-align: left;
			vertical-align: top;
		}

		.compact-table th {
			color: var(--fleet-text-tertiary);
			font-family: var(--fleet-font-mono);
			font-size: 0.56rem;
			font-weight: 600;
			letter-spacing: 0;
			text-transform: uppercase;
		}

		.compact-table tr:last-child td {
			border-bottom: none;
		}

		.empty-state,
		.loading,
		.error-message {
			color: var(--fleet-text-tertiary);
			font-family: var(--fleet-font-mono);
			font-size: 0.75rem;
			letter-spacing: 0.08em;
			padding: 3rem 2rem;
			text-align: center;
			text-transform: uppercase;
		}

		.error-message {
			background: var(--fleet-accent-red-dim);
			border-left: 3px solid var(--fleet-accent-red);
			color: var(--fleet-accent-red);
			margin-bottom: 1.5rem;
			padding: 1rem 1.25rem;
			text-align: left;
			text-transform: none;
		}

		@media (max-width: 980px) {
			.stats-grid {
				grid-template-columns: repeat(2, minmax(0, 1fr));
			}

			.data-table {
				display: block;
				overflow-x: auto;
			}

			.health-grid,
			.insight-grid {
				grid-template-columns: repeat(2, minmax(0, 1fr));
			}
		}

		@media (max-width: 720px) {
			.health-grid,
			.insight-grid {
				grid-template-columns: minmax(0, 1fr);
			}
		}
	`;

	@property({ attribute: false }) api: FleetApi | null = null;
	@property({ type: Number }) refreshMs = 15_000;

	@state() private snapshot: FleetDashboardResponse | null = null;
	@state() private loading = false;
	@state() private error: string | null = null;

	private readonly fallbackApi = getEnterpriseApi();
	private refreshTimer: ReturnType<typeof setInterval> | null = null;

	override connectedCallback() {
		super.connectedCallback();
		void this.load();
		this.startRefresh();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		this.stopRefresh();
	}

	private get client(): FleetApi {
		return this.api ?? this.fallbackApi;
	}

	private startRefresh(): void {
		this.stopRefresh();
		if (this.refreshMs > 0) {
			this.refreshTimer = setInterval(() => {
				void this.load({ quiet: true });
			}, this.refreshMs);
		}
	}

	private stopRefresh(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	private async load(options: { quiet?: boolean } = {}): Promise<void> {
		if (!options.quiet) {
			this.loading = true;
		}
		this.error = null;
		try {
			this.snapshot = await this.client.getFleetStatus();
		} catch (error) {
			this.error =
				error instanceof Error ? error.message : "Failed to load fleet status";
		} finally {
			this.loading = false;
		}
	}

	private formatPercent(value: number): string {
		return `${(value * 100).toFixed(1)}%`;
	}

	private formatDate(value: string): string {
		return new Date(value).toLocaleString();
	}

	private healthClass(health: FleetAgentHealth): string {
		return health;
	}

	private pendingCount(instance: FleetAgentInstance): number {
		return (
			instance.activeTasks.pendingApprovals +
			instance.activeTasks.pendingClientTools +
			instance.activeTasks.pendingMcpElicitations +
			instance.activeTasks.pendingUserInputs +
			instance.activeTasks.pendingToolRetries
		);
	}

	private attentionSignals(instance: FleetAgentInstance): string[] {
		const signals: string[] = [];
		if (instance.health === "unhealthy" || instance.health === "degraded") {
			signals.push(instance.health);
		}
		if (instance.activeTasks.pendingApprovals > 0) {
			signals.push(`${instance.activeTasks.pendingApprovals} approval`);
		}
		if (instance.activeTasks.pendingClientTools > 0) {
			signals.push(`${instance.activeTasks.pendingClientTools} client tool`);
		}
		if (instance.activeTasks.pendingMcpElicitations > 0) {
			signals.push(`${instance.activeTasks.pendingMcpElicitations} MCP`);
		}
		if (instance.activeTasks.pendingUserInputs > 0) {
			signals.push(`${instance.activeTasks.pendingUserInputs} user input`);
		}
		if (instance.activeTasks.pendingToolRetries > 0) {
			signals.push(`${instance.activeTasks.pendingToolRetries} retry`);
		}
		if (instance.errorStats.errorRate > 0) {
			signals.push(
				`${this.formatPercent(instance.errorStats.errorRate)} errors`,
			);
		}
		if (instance.lastError) {
			signals.push("last error");
		}
		return signals;
	}

	private attentionItems(
		snapshot: FleetDashboardResponse,
	): FleetAttentionItem[] {
		return snapshot.instances
			.map((instance) => ({
				instance,
				pending: this.pendingCount(instance),
				signals: this.attentionSignals(instance),
			}))
			.filter((item) => item.signals.length > 0)
			.sort(
				(a, b) =>
					Number(b.instance.health === "unhealthy") -
						Number(a.instance.health === "unhealthy") ||
					b.pending - a.pending ||
					b.instance.errorStats.errorRate - a.instance.errorStats.errorRate,
			);
	}

	private providerFootprint(
		snapshot: FleetDashboardResponse,
	): FleetProviderFootprint[] {
		const groups = new Map<
			string,
			FleetProviderFootprint & { errors: number; executions: number }
		>();
		for (const instance of snapshot.instances) {
			const provider = instance.provider ?? "unknown";
			const model = instance.model ?? "unknown";
			const key = `${provider}/${model}`;
			const current =
				groups.get(key) ??
				({
					key,
					provider,
					model,
					instances: 0,
					activeTasks: 0,
					connections: 0,
					subscribers: 0,
					errorRate: 0,
					errors: 0,
					executions: 0,
				} satisfies FleetProviderFootprint & {
					errors: number;
					executions: number;
				});
			current.instances += 1;
			current.activeTasks += instance.activeTasks.total;
			current.connections += instance.resourceUtilization.connections;
			current.subscribers += instance.resourceUtilization.subscribers;
			current.errors +=
				instance.errorStats.errors + instance.errorStats.toolErrors;
			current.executions +=
				instance.errorStats.runs + instance.errorStats.toolExecutions;
			current.errorRate =
				current.executions > 0 ? current.errors / current.executions : 0;
			groups.set(key, current);
		}
		return Array.from(groups.values())
			.map(({ errors: _errors, executions: _executions, ...entry }) => entry)
			.sort(
				(a, b) =>
					b.activeTasks - a.activeTasks ||
					b.instances - a.instances ||
					a.key.localeCompare(b.key),
			);
	}

	private renderHealthDistribution(snapshot: FleetDashboardResponse) {
		return html`
			<div class="section">
				<div class="section-header">
					<h3>Health Distribution</h3>
				</div>
				<div class="health-grid">
					<div class="health-cell healthy">
						<div class="health-value">${snapshot.summary.healthyInstances}</div>
						<div class="health-label">Healthy</div>
					</div>
					<div class="health-cell degraded">
						<div class="health-value">${snapshot.summary.degradedInstances}</div>
						<div class="health-label">Degraded</div>
					</div>
					<div class="health-cell unhealthy">
						<div class="health-value">${snapshot.summary.unhealthyInstances}</div>
						<div class="health-label">Unhealthy</div>
					</div>
					<div class="health-cell idle">
						<div class="health-value">${snapshot.summary.idleInstances}</div>
						<div class="health-label">Idle</div>
					</div>
				</div>
			</div>
		`;
	}

	private renderMissionControl(snapshot: FleetDashboardResponse) {
		const attention = this.attentionItems(snapshot);
		const footprint = this.providerFootprint(snapshot);
		return html`
			<div class="section">
				<div class="section-header">
					<h3>Mission Control</h3>
				</div>
				<div class="insight-grid">
					<div class="insight-panel">
						<div class="insight-title">Human Attention</div>
						${
							attention.length === 0
								? html`<div class="muted">No degraded agents or pending operator work.</div>`
								: html`
									<table class="compact-table">
										<thead>
											<tr>
												<th>Agent</th>
												<th>Signals</th>
											</tr>
										</thead>
										<tbody>
											${attention.slice(0, 5).map(
												(item) => html`
													<tr>
														<td>
															<code>${item.instance.sessionId}</code>
															<div class="muted">${item.pending} pending</div>
														</td>
														<td>
															<div class="signal-list">
																${item.signals.map(
																	(signal) =>
																		html`<span class="signal-pill">${signal}</span>`,
																)}
															</div>
															${
																item.instance.lastError
																	? html`<div class="muted" style="margin-top: 0.4rem;">${item.instance.lastError}</div>`
																	: ""
															}
														</td>
													</tr>
												`,
											)}
										</tbody>
									</table>
								`
						}
					</div>
					<div class="insight-panel">
						<div class="insight-title">Provider Footprint</div>
						${
							footprint.length === 0
								? html`<div class="muted">No provider or model usage reported.</div>`
								: html`
									<table class="compact-table">
										<thead>
											<tr>
												<th>Provider / Model</th>
												<th>Instances</th>
												<th>Tasks</th>
												<th>Conn / Subs</th>
												<th>Error Rate</th>
											</tr>
										</thead>
										<tbody>
											${footprint.map(
												(entry) => html`
													<tr>
														<td><code>${entry.provider}/${entry.model}</code></td>
														<td>${entry.instances}</td>
														<td>${entry.activeTasks}</td>
														<td>${entry.connections} / ${entry.subscribers}</td>
														<td>${this.formatPercent(entry.errorRate)}</td>
													</tr>
												`,
											)}
										</tbody>
									</table>
								`
						}
					</div>
				</div>
			</div>
		`;
	}

	private renderProcessMetrics(snapshot: FleetDashboardResponse) {
		return html`
			<div class="section">
				<div class="section-header">
					<h3>Runtime Resources</h3>
				</div>
				<div class="stats-grid" style="margin-bottom: 0; border: none;">
					<div class="stat-card">
						<div class="stat-value">${(snapshot.process.memoryRssBytes / 1024 / 1024).toFixed(0)}</div>
						<div class="stat-label">RSS MB</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">${(snapshot.process.heapUsedBytes / 1024 / 1024).toFixed(0)}</div>
						<div class="stat-label">Heap MB</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">${Math.round(snapshot.process.cpuUserMicros / 1000)}</div>
						<div class="stat-label">CPU User MS</div>
					</div>
					<div class="stat-card">
						<div class="stat-value">${snapshot.process.uptimeSeconds}</div>
						<div class="stat-label">Uptime Sec</div>
					</div>
				</div>
			</div>
		`;
	}

	private renderInstance(instance: FleetAgentInstance) {
		return html`
			<tr>
				<td>
					<div class="identity">
						<code>${instance.sessionId}</code>
						<span class="muted">${instance.provider ?? "provider unknown"} / ${instance.model ?? "model unknown"}</span>
						<span class="muted">${instance.gitBranch ?? "no branch"} ${instance.cwd ? `- ${instance.cwd}` : ""}</span>
					</div>
				</td>
				<td>
					<span class="badge ${this.healthClass(instance.health)}">${instance.health}</span>
					<div class="muted" style="margin-top: 0.5rem;">${instance.status}</div>
				</td>
				<td>
					<div class="metric-list">
						<span>${instance.resourceUtilization.connections} connections</span>
						<span>${instance.resourceUtilization.subscribers} subscribers</span>
						<span>${instance.resourceUtilization.activeTasks} active tasks</span>
					</div>
				</td>
				<td>
					<div class="metric-list">
						<span>${instance.activeTasks.total} total</span>
						<span>${instance.activeTasks.activeTools} tools / ${instance.activeTasks.utilityCommands} commands</span>
						<span>${this.pendingCount(instance)} pending</span>
					</div>
				</td>
				<td>
					<div class="metric-list">
						<span>${this.formatPercent(instance.errorStats.errorRate)}</span>
						<span>${instance.errorStats.errors + instance.errorStats.toolErrors} errors</span>
						<span>${instance.errorStats.runs} runs / ${instance.errorStats.toolExecutions} tools</span>
					</div>
				</td>
				<td>
					<div class="metric-list">
						<span>${this.formatDate(instance.updatedAt)}</span>
						${instance.lastResponseDurationMs !== undefined ? html`<span>${instance.lastResponseDurationMs} ms response</span>` : ""}
						${instance.lastTtftMs !== undefined ? html`<span>${instance.lastTtftMs} ms TTFT</span>` : ""}
					</div>
				</td>
			</tr>
		`;
	}

	override render() {
		if (this.loading && !this.snapshot) {
			return html`<div class="loading">Loading fleet status...</div>`;
		}

		const snapshot = this.snapshot;
		if (!snapshot) {
			return html`
				${this.error ? html`<div class="error-message">${this.error}</div>` : ""}
				<div class="empty-state">Fleet status unavailable.</div>
			`;
		}

		return html`
			${this.error ? html`<div class="error-message">${this.error}</div>` : ""}
			<div class="toolbar">
				<div class="timestamp">Updated ${this.formatDate(snapshot.generatedAt)}</div>
				<button
					class="refresh-btn"
					?disabled=${this.loading}
					@click=${() => this.load()}
					title="Refresh fleet status"
					aria-label="Refresh fleet status"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/>
						<path d="M3 21v-5h5"/>
						<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/>
						<path d="M21 3v5h-5"/>
					</svg>
				</button>
			</div>

			<div class="stats-grid">
				<div class="stat-card">
					<div class="stat-value">${snapshot.summary.totalInstances}</div>
					<div class="stat-label">Instances</div>
				</div>
				<div class="stat-card success">
					<div class="stat-value">${snapshot.summary.healthyInstances}</div>
					<div class="stat-label">Healthy</div>
				</div>
				<div class="stat-card warning">
					<div class="stat-value">${snapshot.summary.activeTasks}</div>
					<div class="stat-label">Active Tasks</div>
				</div>
				<div class="stat-card ${snapshot.summary.errorRate > 0 ? "danger" : ""}">
					<div class="stat-value">${this.formatPercent(snapshot.summary.errorRate)}</div>
					<div class="stat-label">Error Rate</div>
				</div>
			</div>

			${this.renderProcessMetrics(snapshot)}
			${this.renderHealthDistribution(snapshot)}
			${this.renderMissionControl(snapshot)}

			<div class="section">
				<div class="section-header">
					<h3>Agent Instances</h3>
				</div>
				${
					snapshot.instances.length === 0
						? html`<div class="empty-state">No running agent instances.</div>`
						: html`
							<table class="data-table">
								<thead>
									<tr>
										<th>Instance</th>
										<th>Health</th>
										<th>Resources</th>
										<th>Active Tasks</th>
										<th>Error Rate</th>
										<th>Last Update</th>
									</tr>
								</thead>
								<tbody>
									${snapshot.instances.map((instance) => this.renderInstance(instance))}
								</tbody>
							</table>
						`
				}
			</div>
		`;
	}
}
