import { LitElement, type PropertyValues, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
	A2ACockpitNextAction,
	A2ACockpitPeerSummary,
	A2ACockpitResponse,
	A2ACockpitTaskSummary,
	ApiClient,
} from "../services/api-client.js";

function formatTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return timestamp;
	return date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function statusTone(status: string): string {
	if (status === "waiting" || status === "unreachable") return "warning";
	if (status === "failed") return "failed";
	if (status === "completed" || status === "online") return "success";
	if (status === "running") return "running";
	return "normal";
}

@customElement("composer-a2a-cockpit-panel")
export class ComposerA2ACockpitPanel extends LitElement {
	static override styles = css`
		:host {
			position: absolute;
			top: 48px;
			right: 0;
			bottom: 0;
			width: 460px;
			max-width: min(460px, 100vw);
			background: var(--bg-deep, #08090a);
			border-left: 1px solid var(--border-primary, #1e2023);
			display: flex;
			flex-direction: column;
			z-index: 35;
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-sans, "Inter", sans-serif);
		}

		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem;
			padding: 0.75rem;
			border-bottom: 1px solid var(--border-primary, #1e2023);
		}

		.title {
			font-size: 0.65rem;
			font-weight: 700;
			letter-spacing: 0;
			color: var(--text-tertiary, #5c5e62);
		}

		.actions {
			display: flex;
			gap: 0.4rem;
		}

		button {
			border: 1px solid var(--border-subtle, #1e2023);
			background: transparent;
			color: var(--text-tertiary, #5c5e62);
			height: 28px;
			min-width: 28px;
			cursor: pointer;
			font-family: var(--font-sans, "Inter", sans-serif);
			font-size: 0.68rem;
		}

		button:hover {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
			border-color: var(--border-hover, #3a3d42);
		}

		button:disabled {
			opacity: 0.45;
			cursor: not-allowed;
		}

		svg {
			width: 14px;
			height: 14px;
			stroke: currentColor;
			fill: none;
			stroke-width: 1.5;
			stroke-linecap: round;
			stroke-linejoin: round;
			pointer-events: none;
		}

		.summary {
			display: grid;
			grid-template-columns: repeat(4, minmax(0, 1fr));
			gap: 0.5rem;
			padding: 0.75rem;
			border-bottom: 1px solid var(--border-primary, #1e2023);
		}

		.metric {
			border: 1px solid var(--border-subtle, #1e2023);
			background: var(--bg-primary, #0c0d0f);
			padding: 0.5rem;
			min-width: 0;
		}

		.metric-value {
			font-size: 1rem;
			color: var(--text-primary, #e8e9eb);
			line-height: 1;
		}

		.metric-label {
			margin-top: 0.25rem;
			font-size: 0.55rem;
			letter-spacing: 0;
			color: var(--text-tertiary, #5c5e62);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.body {
			flex: 1;
			min-height: 0;
			overflow: auto;
			padding: 0.75rem;
		}

		.section {
			display: grid;
			gap: 0.5rem;
			margin-bottom: 0.9rem;
		}

		.section-title {
			color: var(--text-tertiary, #5c5e62);
			font-size: 0.62rem;
			font-weight: 700;
			letter-spacing: 0;
		}

		.row {
			border-left: 2px solid var(--border-primary, #1e2023);
			background: var(--bg-primary, #0c0d0f);
			padding: 0.55rem 0.6rem;
			min-width: 0;
		}

		.row.warning {
			border-left-color: var(--accent-amber, #d4a012);
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.08));
		}

		.row.failed {
			border-left-color: var(--accent-red, #ef4444);
		}

		.row.success {
			border-left-color: var(--accent-green, #22c55e);
		}

		.row.running {
			border-left-color: var(--accent, #14b8a6);
		}

		.row-head {
			display: flex;
			justify-content: space-between;
			gap: 0.5rem;
			min-width: 0;
		}

		.row-title {
			font-size: 0.75rem;
			color: var(--text-primary, #e8e9eb);
			line-height: 1.35;
			overflow-wrap: anywhere;
		}

		.row-meta {
			color: var(--text-tertiary, #5c5e62);
			font-size: 0.62rem;
			white-space: nowrap;
		}

		.row-body {
			margin-top: 0.35rem;
			color: var(--text-secondary, #a4a8ae);
			font-size: 0.68rem;
			line-height: 1.45;
			overflow-wrap: anywhere;
		}

		code {
			display: block;
			margin-top: 0.4rem;
			padding: 0.4rem;
			background: var(--bg-elevated, #161719);
			color: var(--text-secondary, #a4a8ae);
			font-size: 0.64rem;
			line-height: 1.35;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
		}

		.empty,
		.error,
		.loading {
			color: var(--text-tertiary, #5c5e62);
			font-size: 0.75rem;
			line-height: 1.5;
		}

		.error {
			color: var(--accent-red, #ef4444);
		}

		@media (max-width: 640px) {
			:host {
				top: 48px;
				width: 100vw;
			}

			.summary {
				grid-template-columns: repeat(2, minmax(0, 1fr));
			}
		}
	`;

	@property({ attribute: false }) apiClient: ApiClient | null = null;

	@state() private cockpit: A2ACockpitResponse | null = null;
	@state() private loading = false;
	@state() private error: string | null = null;

	private requestId = 0;

	protected override updated(changed: PropertyValues<this>) {
		if (changed.has("apiClient")) {
			void this.loadCockpit();
		}
	}

	private closePanel() {
		this.dispatchEvent(
			new CustomEvent("close", { bubbles: true, composed: true }),
		);
	}

	private async loadCockpit() {
		const requestId = ++this.requestId;
		if (!this.apiClient) {
			this.cockpit = null;
			this.error = null;
			this.loading = false;
			return;
		}

		this.loading = true;
		this.error = null;
		try {
			const cockpit = await this.apiClient.getA2ACockpit({ timeoutMs: 2500 });
			if (requestId !== this.requestId) return;
			this.cockpit = cockpit;
		} catch (error) {
			if (requestId !== this.requestId) return;
			this.cockpit = null;
			this.error =
				error instanceof Error ? error.message : "Failed to load A2A cockpit";
		} finally {
			if (requestId === this.requestId) {
				this.loading = false;
			}
		}
	}

	private renderIcon(name: "close" | "refresh") {
		const paths = {
			close: "M18 6 6 18M6 6l12 12",
			refresh:
				"M4.93 4.93A10 10 0 0 1 19.07 5M20 9v-4h-4M19.07 19.07A10 10 0 0 1 4.93 19M4 15v4h4",
		};
		return html`<svg viewBox="0 0 24 24" aria-hidden="true">
			<path d=${paths[name]}></path>
		</svg>`;
	}

	private renderSummary(cockpit: A2ACockpitResponse) {
		return html`
			<div class="summary">
				<div class="metric">
					<div class="metric-value">${cockpit.counts.onlinePeers}/${cockpit.counts.peers}</div>
					<div class="metric-label">Peers online</div>
				</div>
				<div class="metric">
					<div class="metric-value">${cockpit.counts.runningTasks}</div>
					<div class="metric-label">Running</div>
				</div>
				<div class="metric">
					<div class="metric-value">${cockpit.counts.actionRequiredTasks}</div>
					<div class="metric-label">Waiting</div>
				</div>
				<div class="metric">
					<div class="metric-value">${cockpit.counts.failedTasks}</div>
					<div class="metric-label">Failed</div>
				</div>
			</div>
		`;
	}

	private renderPeer(peer: A2ACockpitPeerSummary) {
		const active =
			peer.taskCounts.runningTasks + peer.taskCounts.actionRequiredTasks;
		return html`
			<div class="row ${statusTone(peer.status)}">
				<div class="row-head">
					<div class="row-title">${peer.displayName ?? peer.name}</div>
					<div class="row-meta">${peer.status}</div>
				</div>
				<div class="row-body">
					${peer.name} · ${peer.url}
					${active ? html`<br />${active} active task${active === 1 ? "" : "s"}` : ""}
					${peer.lastTask ? html`<br />Last ${peer.lastTask.id}: ${peer.lastTask.state}` : ""}
					${peer.error ? html`<br />${peer.error}` : ""}
				</div>
			</div>
		`;
	}

	private renderTask(task: A2ACockpitTaskSummary) {
		const peerLabel = task.orphanedPeer
			? `${task.peer} (orphaned peer)`
			: task.peer;
		return html`
			<div class="row ${statusTone(task.status)}">
				<div class="row-head">
					<div class="row-title">${peerLabel} · ${task.taskId}</div>
					<div class="row-meta">${task.status}</div>
				</div>
				<div class="row-body">
					${task.text}
					<br />${task.state} · ${formatTimestamp(task.updatedAt)}
					${task.responseText ? html`<br />${task.responseText}` : ""}
					${task.nextCommand ? html`<code>${task.nextCommand}</code>` : ""}
				</div>
			</div>
		`;
	}

	private renderAction(action: A2ACockpitNextAction) {
		return html`
			<div class="row ${statusTone(action.severity === "critical" ? "failed" : action.severity)}">
				<div class="row-head">
					<div class="row-title">${action.label}</div>
					<div class="row-meta">${action.severity}</div>
				</div>
				<div class="row-body">
					${action.reason}
					<code>${action.command}</code>
				</div>
			</div>
		`;
	}

	private renderCockpit(cockpit: A2ACockpitResponse) {
		return html`
			${this.renderSummary(cockpit)}
			<div class="body">
				<div class="section">
					<div class="section-title">Next actions</div>
					${
						cockpit.nextActions.length === 0
							? html`<div class="empty">No A2A action needed right now.</div>`
							: cockpit.nextActions.map((action) => this.renderAction(action))
					}
				</div>
				<div class="section">
					<div class="section-title">Peers</div>
					${
						cockpit.peers.length === 0
							? html`<div class="empty">No peers registered.</div>`
							: cockpit.peers.map((peer) => this.renderPeer(peer))
					}
				</div>
				<div class="section">
					<div class="section-title">Tasks</div>
					${
						cockpit.tasks.length === 0
							? html`<div class="empty">No delegated tasks recorded yet.</div>`
							: cockpit.tasks.map((task) => this.renderTask(task))
					}
				</div>
			</div>
		`;
	}

	override render() {
		return html`
			<div class="header">
				<div class="title">A2A cockpit</div>
				<div class="actions">
					<button
						title="Refresh A2A cockpit"
						@click=${() => this.loadCockpit()}
						?disabled=${this.loading}
					>
						${this.renderIcon("refresh")}
					</button>
					<button title="Close A2A cockpit" @click=${this.closePanel}>
						${this.renderIcon("close")}
					</button>
				</div>
			</div>
			${
				this.loading
					? html`<div class="body"><div class="loading">Loading A2A cockpit...</div></div>`
					: this.error
						? html`<div class="body"><div class="error">${this.error}</div></div>`
						: this.cockpit
							? this.renderCockpit(this.cockpit)
							: html`<div class="body"><div class="empty">No A2A cockpit data.</div></div>`
			}
		`;
	}
}
