import type { ComposerRunTimelineItem } from "@evalops/contracts";
import { LitElement, type PropertyValues, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ApiClient, RunTimelineResponse } from "../services/api-client.js";

function formatEventType(type: string): string {
	return type
		.split(".")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function formatTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return timestamp;
	return date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function eventTone(item: ComposerRunTimelineItem): string {
	if (item.status === "failed" || item.type === "tool.failed") return "failed";
	if (item.status === "pending" || item.type === "wait.pending") {
		return "pending";
	}
	if (item.source === "platform") return "platform";
	return "normal";
}

@customElement("composer-session-timeline-panel")
export class ComposerSessionTimelinePanel extends LitElement {
	static override styles = css`
		:host {
			position: absolute;
			top: 48px;
			right: 0;
			bottom: 0;
			width: 440px;
			max-width: min(440px, 100vw);
			background: var(--bg-deep, #08090a);
			border-left: 1px solid var(--border-primary, #1e2023);
			display: flex;
			flex-direction: column;
			z-index: 35;
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-mono, monospace);
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
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--text-tertiary, #5c5e62);
		}

		.actions {
			display: flex;
			gap: 0.4rem;
		}

		button {
			border: 1px solid var(--border-primary, #1e2023);
			background: transparent;
			color: var(--text-tertiary, #5c5e62);
			height: 28px;
			min-width: 28px;
			cursor: pointer;
			font-family: var(--font-mono, monospace);
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
			grid-template-columns: repeat(3, 1fr);
			gap: 0.5rem;
			padding: 0.75rem;
			border-bottom: 1px solid var(--border-primary, #1e2023);
		}

		.metric {
			border: 1px solid var(--border-primary, #1e2023);
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
			letter-spacing: 0.08em;
			text-transform: uppercase;
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

		.timeline {
			display: grid;
			gap: 0.55rem;
		}

		.item {
			display: grid;
			grid-template-columns: 5.5rem 1fr;
			gap: 0.65rem;
			border-left: 2px solid var(--border-primary, #1e2023);
			padding: 0.55rem 0.6rem;
			background: var(--bg-primary, #0c0d0f);
		}

		.item.pending {
			border-left-color: var(--accent-amber, #d4a012);
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.08));
		}

		.item.failed {
			border-left-color: var(--accent-red, #ef4444);
		}

		.item.platform {
			border-left-color: var(--accent, #14b8a6);
		}

		.time {
			color: var(--text-tertiary, #5c5e62);
			font-size: 0.62rem;
			padding-top: 0.1rem;
			white-space: nowrap;
		}

		.content {
			min-width: 0;
		}

		.item-title {
			font-size: 0.76rem;
			color: var(--text-primary, #e8e9eb);
			line-height: 1.35;
			overflow-wrap: anywhere;
		}

		.item-summary {
			margin-top: 0.3rem;
			color: var(--text-secondary, #a4a8ae);
			font-size: 0.68rem;
			line-height: 1.45;
			overflow-wrap: anywhere;
		}

		.meta {
			margin-top: 0.45rem;
			display: flex;
			gap: 0.3rem;
			flex-wrap: wrap;
		}

		.chip {
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-tertiary, #5c5e62);
			font-size: 0.54rem;
			text-transform: uppercase;
			letter-spacing: 0.06em;
			padding: 0.1rem 0.3rem;
			max-width: 100%;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.chip.pending {
			color: var(--accent-amber, #d4a012);
			border-color: rgba(212, 160, 18, 0.35);
		}

		.chip.platform {
			color: var(--accent, #14b8a6);
			border-color: rgba(20, 184, 166, 0.35);
		}

		@media (max-width: 640px) {
			:host {
				top: 48px;
				width: 100vw;
			}

			.item {
				grid-template-columns: 1fr;
				gap: 0.3rem;
			}
		}
	`;

	@property({ attribute: false }) apiClient: ApiClient | null = null;
	@property() sessionId: string | null = null;

	@state() private timeline: RunTimelineResponse | null = null;
	@state() private loading = false;
	@state() private error: string | null = null;

	private requestId = 0;

	protected override updated(changed: PropertyValues<this>) {
		if (changed.has("apiClient") || changed.has("sessionId")) {
			void this.loadTimeline();
		}
	}

	private closePanel() {
		this.dispatchEvent(
			new CustomEvent("close", { bubbles: true, composed: true }),
		);
	}

	private async loadTimeline() {
		const requestId = ++this.requestId;
		if (!this.apiClient || !this.sessionId) {
			this.timeline = null;
			this.error = null;
			this.loading = false;
			return;
		}

		this.loading = true;
		this.error = null;
		try {
			const timeline = await this.apiClient.getSessionTimeline(this.sessionId);
			if (requestId !== this.requestId) return;
			this.timeline = timeline;
		} catch (error) {
			if (requestId !== this.requestId) return;
			this.timeline = null;
			this.error =
				error instanceof Error ? error.message : "Failed to load timeline";
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

	private get visibleItems(): ComposerRunTimelineItem[] {
		return this.timeline?.items ?? [];
	}

	private renderSummary() {
		const items = this.visibleItems;
		const pending = items.filter((item) => item.status === "pending").length;
		const platform = items.filter((item) => item.source === "platform").length;
		const guarded = items.filter(
			(item) => item.visibility === "admin" || item.visibility === "audit",
		).length;
		return html`
			<div class="summary">
				<div class="metric">
					<div class="metric-value">${items.length}</div>
					<div class="metric-label">Events</div>
				</div>
				<div class="metric">
					<div class="metric-value">${pending}</div>
					<div class="metric-label">Waiting</div>
				</div>
				<div class="metric">
					<div class="metric-value">${platform || guarded}</div>
					<div class="metric-label">${platform ? "Platform" : "Guarded"}</div>
				</div>
			</div>
		`;
	}

	private renderItem(item: ComposerRunTimelineItem) {
		const tone = eventTone(item);
		return html`
			<div class="item ${tone}">
				<div class="time">${formatTimestamp(item.timestamp)}</div>
				<div class="content">
					<div class="item-title">${item.title}</div>
					${
						item.summary
							? html`<div class="item-summary">${item.summary}</div>`
							: ""
					}
					<div class="meta">
						<span class="chip">${formatEventType(item.type)}</span>
						${
							item.status
								? html`<span class="chip ${item.status}">${item.status}</span>`
								: ""
						}
						<span class="chip ${item.source}">${item.source}</span>
						<span class="chip">${item.visibility}</span>
						${item.toolName ? html`<span class="chip">${item.toolName}</span>` : ""}
						${
							item.toolExecutionId
								? html`<span class="chip platform">${item.toolExecutionId}</span>`
								: ""
						}
					</div>
				</div>
			</div>
		`;
	}

	override render() {
		const items = this.visibleItems;
		return html`
			<div class="header">
				<div class="title">Run timeline</div>
				<div class="actions">
					<button
						title="Refresh timeline"
						@click=${() => this.loadTimeline()}
						?disabled=${this.loading || !this.sessionId}
					>
						${this.renderIcon("refresh")}
					</button>
					<button title="Close timeline" @click=${this.closePanel}>
						${this.renderIcon("close")}
					</button>
				</div>
			</div>
			${this.renderSummary()}
			<div class="body">
				${
					this.loading
						? html`<div class="loading">Loading timeline...</div>`
						: this.error
							? html`<div class="error">${this.error}</div>`
							: items.length === 0
								? html`<div class="empty">No timeline events yet.</div>`
								: html`<div class="timeline">
										${items.map((item) => this.renderItem(item))}
									</div>`
				}
			</div>
		`;
	}
}
