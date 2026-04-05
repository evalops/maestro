/**
 * Tool retry component - request user input for failed tool retries
 */

import type { ComposerToolRetryRequest } from "@evalops/contracts";
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("composer-tool-retry")
export class ComposerToolRetry extends LitElement {
	static override styles = css`
		:host {
			display: block;
			font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
		}

		.retry-overlay {
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: rgba(10, 14, 20, 0.95);
			display: flex;
			align-items: center;
			justify-content: center;
			z-index: 1000;
			animation: fadeIn 0.2s ease-out;
		}

		@keyframes fadeIn {
			from { opacity: 0; }
			to { opacity: 1; }
		}

		.retry-modal {
			background: #0d1117;
			border: 2px solid #58a6ff;
			border-radius: 4px;
			max-width: 680px;
			width: 90%;
			max-height: 80vh;
			overflow-y: auto;
			animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
		}

		@keyframes slideUp {
			from {
				opacity: 0;
				transform: translateY(20px);
			}
			to {
				opacity: 1;
				transform: translateY(0);
			}
		}

		.retry-header {
			padding: 1rem;
			background: rgba(88, 166, 255, 0.1);
			border-bottom: 1px solid #58a6ff;
			display: flex;
			align-items: center;
			gap: 0.75rem;
		}

		.retry-icon {
			width: 1.9rem;
			height: 1.9rem;
			display: flex;
			align-items: center;
			justify-content: center;
			border: 1px solid #58a6ff;
			border-radius: 999px;
			font-size: 0.95rem;
			font-weight: 700;
			color: #58a6ff;
		}

		.header-text {
			flex: 1;
		}

		.header-title {
			font-size: 0.85rem;
			font-weight: 700;
			color: #58a6ff;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			margin-bottom: 0.25rem;
		}

		.header-subtitle {
			font-size: 0.75rem;
			color: #8b949e;
		}

		.retry-body {
			padding: 1rem;
		}

		.section {
			margin-bottom: 1rem;
		}

		.section:last-child {
			margin-bottom: 0;
		}

		.section-label {
			font-size: 0.7rem;
			font-weight: 700;
			color: #6e7681;
			text-transform: uppercase;
			letter-spacing: 0.1em;
			margin-bottom: 0.5rem;
		}

		.queue-box,
		.info-box,
		.error-box {
			border-radius: 3px;
			padding: 0.75rem;
		}

		.queue-box,
		.info-box {
			background: #161b22;
			border: 1px solid #30363d;
		}

		.queue-box {
			border-left: 3px solid #58a6ff;
		}

		.error-box {
			background: rgba(248, 81, 73, 0.12);
			border: 1px solid #f85149;
			color: #e6edf3;
			font-size: 0.75rem;
			line-height: 1.6;
		}

		.queue-title,
		.tool-name {
			font-size: 0.78rem;
			font-weight: 700;
			color: #e6edf3;
		}

		.queue-subtitle,
		.tool-meta {
			margin-top: 0.35rem;
			font-size: 0.72rem;
			color: #8b949e;
			line-height: 1.5;
		}

		.tool-summary {
			display: flex;
			flex-wrap: wrap;
			gap: 0.5rem;
			margin-top: 0.65rem;
		}

		.detail-chip {
			display: inline-flex;
			align-items: center;
			gap: 0.35rem;
			padding: 0.2rem 0.45rem;
			border: 1px solid #30363d;
			border-radius: 999px;
			background: #0d1117;
			font-size: 0.66rem;
			line-height: 1;
		}

		.detail-chip-label {
			color: #8b949e;
			text-transform: uppercase;
			letter-spacing: 0.06em;
		}

		.detail-chip-value {
			color: #e6edf3;
		}

		.args-grid {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 0.35rem 0.75rem;
			margin-top: 0.75rem;
			font-size: 0.75rem;
		}

		.arg-key {
			color: #8b949e;
			font-weight: 600;
		}

		.arg-value {
			color: #e6edf3;
			white-space: pre-wrap;
			word-break: break-word;
		}

		.retry-actions {
			padding: 1rem;
			border-top: 1px solid #30363d;
			display: flex;
			gap: 0.75rem;
			justify-content: flex-end;
			flex-wrap: wrap;
		}

		.btn {
			padding: 0.625rem 1.25rem;
			border: 1px solid #30363d;
			border-radius: 2px;
			font-family: inherit;
			font-size: 0.75rem;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			cursor: pointer;
			transition: all 0.15s;
		}

		.btn-skip {
			background: transparent;
			color: #8b949e;
		}

		.btn-skip:hover {
			background: #21262d;
			border-color: #6e7681;
			color: #c9d1d9;
		}

		.btn-abort {
			background: transparent;
			color: #f85149;
			border-color: #f85149;
		}

		.btn-abort:hover {
			background: rgba(248, 81, 73, 0.12);
		}

		.btn-retry {
			background: #58a6ff;
			color: #0d1117;
			border-color: #58a6ff;
		}

		.btn-retry:hover {
			background: #79c0ff;
			border-color: #79c0ff;
		}

		.hint {
			font-size: 0.65rem;
			color: #6e7681;
			text-align: center;
			margin-top: 0.75rem;
		}

		.hint kbd {
			padding: 0.125rem 0.35rem;
			background: #161b22;
			border: 1px solid #30363d;
			border-radius: 2px;
			font-family: inherit;
			margin: 0 0.25rem;
		}
	`;

	@property({ type: Object }) request: ComposerToolRetryRequest | null = null;
	@property({ type: Boolean }) submitting = false;
	@property({ type: Number }) queueLength = 0;

	private handleKeyDownRef = (event: KeyboardEvent) =>
		this.handleKeyDown(event);

	private formatValue(value: unknown): string {
		if (value === null || value === undefined) return "null";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean")
			return String(value);
		return JSON.stringify(value, null, 2);
	}

	private getObjectArgs(): Record<string, unknown> | null {
		const args = this.request?.args;
		if (args && typeof args === "object" && !Array.isArray(args)) {
			return args as Record<string, unknown>;
		}
		return null;
	}

	private getArgEntries(): Array<[string, unknown]> {
		const args = this.getObjectArgs();
		if (args) {
			return Object.entries(args);
		}
		const argsValue = this.request?.args;
		if (argsValue === undefined) {
			return [];
		}
		return [["value", argsValue]];
	}

	private getQueueTitle(): string {
		const total = Math.max(this.queueLength, this.request ? 1 : 0);
		return `Retry request 1 of ${Math.max(total, 1)}`;
	}

	private getQueueSubtitle(): string {
		const total = Math.max(this.queueLength, this.request ? 1 : 0);
		const remaining = Math.max(total - 1, 0);
		if (remaining === 0) {
			return "No other pending retry decisions";
		}
		return `${remaining} more retry decision${remaining === 1 ? "" : "s"} waiting`;
	}

	private getToolTitle(): string {
		return this.request?.summary || this.request?.toolName || "Tool";
	}

	private getToolDetails(): Array<{ label: string; value: string }> {
		if (!this.request) return [];
		const details: Array<{ label: string; value: string }> = [
			{ label: "Attempt", value: String(this.request.attempt) },
		];
		if (typeof this.request.maxAttempts === "number") {
			details.push({
				label: "Max",
				value: String(this.request.maxAttempts),
			});
		}
		return details;
	}

	private dispatchDecision(action: "retry" | "skip" | "abort") {
		if (this.submitting) {
			return;
		}
		this.dispatchEvent(
			new CustomEvent(action, {
				detail: { requestId: this.request?.id },
				bubbles: true,
				composed: true,
			}),
		);
	}

	private handleKeyDown(event: KeyboardEvent) {
		if (event.key === "Enter") {
			event.preventDefault();
			this.dispatchDecision("retry");
		} else if (event.key === "Escape") {
			event.preventDefault();
			this.dispatchDecision("skip");
		}
	}

	override connectedCallback() {
		super.connectedCallback();
		window.addEventListener("keydown", this.handleKeyDownRef);
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		window.removeEventListener("keydown", this.handleKeyDownRef);
	}

	override render() {
		if (!this.request) return html``;

		const argEntries = this.getArgEntries();
		const toolDetails = this.getToolDetails();

		return html`
			<div class="retry-overlay">
				<div class="retry-modal">
					<div class="retry-header">
						<div class="retry-icon">↻</div>
						<div class="header-text">
							<div class="header-title">Retry Decision Required</div>
							<div class="header-subtitle">A tool failed and needs a next action</div>
						</div>
					</div>

					<div class="retry-body">
						<div class="section">
							<div class="section-label">Queue Status</div>
							<div class="queue-box">
								<div class="queue-title">${this.getQueueTitle()}</div>
								<div class="queue-subtitle">${this.getQueueSubtitle()}</div>
							</div>
						</div>

						<div class="section">
							<div class="section-label">Failure</div>
							<div class="error-box">${this.request.errorMessage}</div>
						</div>

						<div class="section">
							<div class="section-label">Tool</div>
							<div class="info-box">
								<div class="tool-name">${this.getToolTitle()}</div>
								<div class="tool-meta">${this.request.toolName}</div>
								${
									toolDetails.length > 0
										? html`<div class="tool-summary">
											${toolDetails.map(
												(detail) => html`
													<span class="detail-chip">
														<span class="detail-chip-label">${detail.label}</span>
														<span class="detail-chip-value">${detail.value}</span>
													</span>
												`,
											)}
										</div>`
										: ""
								}
								${
									argEntries.length > 0
										? html`<div class="args-grid">
											${argEntries.map(
												([key, value]) => html`
													<div class="arg-key">${key}:</div>
													<div class="arg-value">${this.formatValue(value)}</div>
												`,
											)}
										</div>`
										: ""
								}
							</div>
						</div>
					</div>

					<div class="retry-actions">
						<button
							class="btn btn-skip"
							@click=${() => this.dispatchDecision("skip")}
							?disabled=${this.submitting}
						>
							Skip
						</button>
						<button
							class="btn btn-abort"
							@click=${() => this.dispatchDecision("abort")}
							?disabled=${this.submitting}
						>
							Abort
						</button>
						<button
							class="btn btn-retry"
							@click=${() => this.dispatchDecision("retry")}
							?disabled=${this.submitting}
						>
							${this.submitting ? "Submitting..." : "Retry"}
						</button>
					</div>

					<div class="hint">
						<kbd>Enter</kbd> to retry • <kbd>Esc</kbd> to skip
					</div>
				</div>
			</div>
		`;
	}
}
