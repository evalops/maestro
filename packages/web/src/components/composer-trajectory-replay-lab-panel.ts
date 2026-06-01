import { LitElement, type PropertyValues, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
	ApiClient,
	TrajectoryReplayLabDelta,
	TrajectoryReplayLabEvent,
	TrajectoryReplayLabFinding,
	TrajectoryReplayLabResponse,
	TrajectoryReplayLabTimelineItem,
} from "../services/api-client.js";

type ReplayLabView = "trajectory" | "replay" | "score";

function formatTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return timestamp;
	return date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function toneForStatus(status: string | undefined): string {
	if (status === "failed" || status === "fail" || status === "error") {
		return "failed";
	}
	if (status === "pending" || status === "warn" || status === "warning") {
		return "warning";
	}
	if (status === "running") return "running";
	if (status === "completed" || status === "pass") return "success";
	return "normal";
}

@customElement("composer-trajectory-replay-lab-panel")
export class ComposerTrajectoryReplayLabPanel extends LitElement {
	static override styles = css`
		:host {
			position: absolute;
			top: 48px;
			right: 0;
			bottom: 0;
			width: 500px;
			max-width: min(500px, 100vw);
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

		.actions,
		.tabs {
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

		button:hover,
		button.active {
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

		.tabs {
			padding: 0.75rem 0.75rem 0;
		}

		.tabs button {
			padding: 0 0.6rem;
			min-width: 76px;
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
	@property() sessionId: string | null = null;

	@state() private lab: TrajectoryReplayLabResponse | null = null;
	@state() private loading = false;
	@state() private error: string | null = null;
	@state() private view: ReplayLabView = "trajectory";

	private requestId = 0;

	protected override updated(changed: PropertyValues<this>) {
		if (changed.has("apiClient") || changed.has("sessionId")) {
			void this.loadReplayLab();
		}
	}

	private closePanel() {
		this.dispatchEvent(
			new CustomEvent("close", { bubbles: true, composed: true }),
		);
	}

	private async loadReplayLab() {
		const requestId = ++this.requestId;
		if (!this.apiClient || !this.sessionId) {
			this.lab = null;
			this.error = null;
			this.loading = false;
			return;
		}
		this.loading = true;
		this.error = null;
		try {
			const lab = await this.apiClient.getSessionReplayLab(this.sessionId);
			if (requestId !== this.requestId) return;
			this.lab = lab;
		} catch (error) {
			if (requestId !== this.requestId) return;
			this.lab = null;
			this.error =
				error instanceof Error ? error.message : "Failed to load replay lab";
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

	private renderSummary(lab: TrajectoryReplayLabResponse) {
		return html`
			<div class="summary">
				<div class="metric">
					<div class="metric-value">${lab.summary.trajectoryEvents}</div>
					<div class="metric-label">Events</div>
				</div>
				<div class="metric">
					<div class="metric-value">${lab.summary.replayDeltas}</div>
					<div class="metric-label">Deltas</div>
				</div>
				<div class="metric">
					<div class="metric-value">${lab.summary.scoreFailures}</div>
					<div class="metric-label">Score fails</div>
				</div>
				<div class="metric">
					<div class="metric-value">${lab.summary.jumpTargets}</div>
					<div class="metric-label">Jumps</div>
				</div>
			</div>
		`;
	}

	private renderTabs() {
		const tabs: ReplayLabView[] = ["trajectory", "replay", "score"];
		return html`<div class="tabs">
			${tabs.map(
				(tab) => html`<button
					class=${this.view === tab ? "active" : ""}
					@click=${() => {
						this.view = tab;
					}}
				>
					${tab}
				</button>`,
			)}
		</div>`;
	}

	private renderTimelineItem(item: TrajectoryReplayLabTimelineItem) {
		return html`
			<div class="row ${toneForStatus(item.status)}">
				<div class="row-head">
					<div class="row-title">${item.title}</div>
					<div class="row-meta">${formatTimestamp(item.timestamp)}</div>
				</div>
				<div class="row-body">
					${item.type} · ${item.source} · ${item.visibility}
					${item.summary ? html`<br />${item.summary}` : ""}
					${item.toolExecutionId ? html`<br />${item.toolExecutionId}` : ""}
					${item.approvalRequestId ? html`<br />${item.approvalRequestId}` : ""}
				</div>
			</div>
		`;
	}

	private renderEvent(event: TrajectoryReplayLabEvent) {
		return html`
			<div class="row ${toneForStatus(event.status)}">
				<div class="row-head">
					<div class="row-title">${event.sequence}. ${event.title}</div>
					<div class="row-meta">${event.phase}</div>
				</div>
				<div class="row-body">
					${event.type} · ${event.kind} · ${event.actor}
					${event.summary ? html`<br />${event.summary}` : ""}
					${event.relatedIds?.length ? html`<br />${event.relatedIds.join(", ")}` : ""}
				</div>
			</div>
		`;
	}

	private renderDelta(delta: TrajectoryReplayLabDelta) {
		return html`
			<div class="row ${toneForStatus(delta.severity)}">
				<div class="row-head">
					<div class="row-title">${delta.ruleId}</div>
					<div class="row-meta">${delta.severity}</div>
				</div>
				<div class="row-body">
					${delta.message}
					${delta.eventId ? html`<br />${delta.eventId}` : ""}
					${
						delta.expected || delta.observed
							? html`<br />expected ${delta.expected ?? "n/a"} · observed ${delta.observed ?? "n/a"}`
							: ""
					}
				</div>
			</div>
		`;
	}

	private renderFinding(finding: TrajectoryReplayLabFinding) {
		return html`
			<div class="row ${toneForStatus(finding.status)}">
				<div class="row-head">
					<div class="row-title">${finding.ruleId}</div>
					<div class="row-meta">${finding.status}</div>
				</div>
				<div class="row-body">
					${finding.message}
					<br />${finding.remediation}
					${finding.eventIds.length ? html`<br />${finding.eventIds.join(", ")}` : ""}
				</div>
			</div>
		`;
	}

	private renderTrajectory(lab: TrajectoryReplayLabResponse) {
		return html`
			<div class="section">
				<div class="section-title">Final answer</div>
				${
					lab.inspection.finalAnswer
						? html`<div class="row success">
								<div class="row-title">${lab.inspection.finalAnswer.title}</div>
								${
									lab.inspection.finalAnswer.summary
										? html`<div class="row-body">${lab.inspection.finalAnswer.summary}</div>`
										: ""
								}
							</div>`
						: html`<div class="empty">No final answer event found.</div>`
				}
			</div>
			<div class="section">
				<div class="section-title">Trajectory events</div>
				${lab.trajectory.events.slice(0, 30).map((event) => this.renderEvent(event))}
			</div>
		`;
	}

	private renderReplay(lab: TrajectoryReplayLabResponse) {
		return html`
			<div class="section">
				<div class="section-title">Replay deltas</div>
				${
					lab.replay.deltas.length === 0
						? html`<div class="empty">No replay deltas.</div>`
						: lab.replay.deltas.map((delta) => this.renderDelta(delta))
				}
			</div>
			<div class="section">
				<div class="section-title">Timeline anchors</div>
				${lab.timeline.items.slice(0, 20).map((item) => this.renderTimelineItem(item))}
			</div>
		`;
	}

	private renderScore(lab: TrajectoryReplayLabResponse) {
		return html`
			<div class="section">
				<div class="section-title">Score findings</div>
				${
					lab.score.findings.length === 0
						? html`<div class="empty">No score findings.</div>`
						: lab.score.findings.map((finding) => this.renderFinding(finding))
				}
			</div>
			<div class="section">
				<div class="section-title">Phases</div>
				${lab.replay.phases.map(
					(phase) => html`<div class="row">
						<div class="row-head">
							<div class="row-title">${phase.phase}</div>
							<div class="row-meta">${phase.events} events</div>
						</div>
						<div class="row-body">
							sequence ${phase.firstSequence}-${phase.lastSequence}
						</div>
					</div>`,
				)}
			</div>
		`;
	}

	private renderLab(lab: TrajectoryReplayLabResponse) {
		return html`
			${this.renderSummary(lab)}
			${this.renderTabs()}
			<div class="body">
				${
					this.view === "trajectory"
						? this.renderTrajectory(lab)
						: this.view === "replay"
							? this.renderReplay(lab)
							: this.renderScore(lab)
				}
			</div>
		`;
	}

	override render() {
		return html`
			<div class="header">
				<div class="title">Trajectory replay lab</div>
				<div class="actions">
					<button
						title="Refresh replay lab"
						@click=${() => this.loadReplayLab()}
						?disabled=${this.loading || !this.sessionId}
					>
						${this.renderIcon("refresh")}
					</button>
					<button title="Close replay lab" @click=${this.closePanel}>
						${this.renderIcon("close")}
					</button>
				</div>
			</div>
			${
				this.loading
					? html`<div class="body"><div class="loading">Loading replay lab...</div></div>`
					: this.error
						? html`<div class="body"><div class="error">${this.error}</div></div>`
						: this.lab
							? this.renderLab(this.lab)
							: html`<div class="body"><div class="empty">No replay lab data.</div></div>`
			}
		`;
	}
}
