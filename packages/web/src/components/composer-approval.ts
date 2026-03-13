/**
 * Approval component - request user approval for dangerous operations
 */

import type { ComposerActionApprovalRequest } from "@evalops/contracts";
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("composer-approval")
export class ComposerApproval extends LitElement {
	static override styles = css`
		:host {
			display: block;
			font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
		}

		.approval-overlay {
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

		.approval-modal {
			background: #0d1117;
			border: 2px solid #d29922;
			border-radius: 4px;
			max-width: 600px;
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

		.approval-header {
			padding: 1rem;
			background: rgba(210, 153, 34, 0.1);
			border-bottom: 1px solid #d29922;
			display: flex;
			align-items: center;
			gap: 0.75rem;
		}

		.warning-icon {
			font-size: 1.5rem;
			animation: pulse 2s ease-in-out infinite;
		}

		@keyframes pulse {
			0%, 100% { opacity: 1; transform: scale(1); }
			50% { opacity: 0.8; transform: scale(1.1); }
		}

		.header-text {
			flex: 1;
		}

		.header-title {
			font-size: 0.85rem;
			font-weight: 700;
			color: #d29922;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			margin-bottom: 0.25rem;
		}

		.header-subtitle {
			font-size: 0.75rem;
			color: #8b949e;
		}

		.approval-body {
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

		.tool-info {
			background: #161b22;
			border: 1px solid #30363d;
			border-radius: 2px;
			padding: 0.75rem;
		}

		.tool-name {
			font-size: 0.8rem;
			font-weight: 700;
			color: #e6edf3;
			margin-bottom: 0.5rem;
		}

		.args-grid {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 0.35rem 0.75rem;
			font-size: 0.75rem;
		}

		.arg-key {
			color: #8b949e;
			font-weight: 600;
		}

		.arg-value {
			color: #e6edf3;
			word-break: break-all;
		}

		.reason-box {
			background: rgba(210, 153, 34, 0.1);
			border: 1px solid #d29922;
			border-radius: 2px;
			padding: 0.75rem;
			font-size: 0.75rem;
			line-height: 1.6;
			color: #e6edf3;
		}

		.approval-actions {
			padding: 1rem;
			border-top: 1px solid #30363d;
			display: flex;
			gap: 0.75rem;
			justify-content: flex-end;
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

		.btn-deny {
			background: transparent;
			color: #8b949e;
		}

		.btn-deny:hover {
			background: #21262d;
			border-color: #f85149;
			color: #f85149;
		}

		.btn-approve {
			background: #d29922;
			color: #0d1117;
			border-color: #d29922;
		}

		.btn-approve:hover {
			background: #e5a626;
			border-color: #e5a626;
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

	@property({ type: Object }) request: ComposerActionApprovalRequest | null =
		null;
	@property({ type: Boolean }) submitting = false;

	private handleKeyDownRef = (event: KeyboardEvent) =>
		this.handleKeyDown(event);

	private formatValue(value: unknown): string {
		if (value === null || value === undefined) return "null";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean")
			return String(value);
		return JSON.stringify(value, null, 2);
	}

	private getArgEntries(): Array<[string, unknown]> {
		const args = this.request?.args;
		if (args && typeof args === "object" && !Array.isArray(args)) {
			return Object.entries(args);
		}
		if (args === undefined) {
			return [];
		}
		return [["value", args]];
	}

	private handleApprove() {
		if (this.submitting) {
			return;
		}
		this.dispatchEvent(
			new CustomEvent("approve", {
				detail: { requestId: this.request?.id },
				bubbles: true,
				composed: true,
			}),
		);
	}

	private handleDeny() {
		if (this.submitting) {
			return;
		}
		this.dispatchEvent(
			new CustomEvent("deny", {
				detail: { requestId: this.request?.id },
				bubbles: true,
				composed: true,
			}),
		);
	}

	private handleKeyDown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			e.preventDefault();
			this.handleApprove();
		} else if (e.key === "Escape") {
			e.preventDefault();
			this.handleDeny();
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

		return html`
			<div class="approval-overlay">
				<div class="approval-modal">
					<div class="approval-header">
						<div class="warning-icon">⚠️</div>
						<div class="header-text">
							<div class="header-title">Approval Required</div>
							<div class="header-subtitle">This operation requires your permission</div>
						</div>
					</div>

					<div class="approval-body">
						<div class="section">
							<div class="section-label">Tool</div>
							<div class="tool-info">
								<div class="tool-name">${this.request.toolName}</div>
								${
									argEntries.length > 0
										? html`
									<div class="args-grid">
										${argEntries.map(
											([key, value]) => html`
											<div class="arg-key">${key}:</div>
											<div class="arg-value">${this.formatValue(value)}</div>
										`,
										)}
									</div>
								`
										: ""
								}
							</div>
						</div>

						${
							this.request.reason
								? html`
							<div class="section">
								<div class="section-label">Warning</div>
								<div class="reason-box">${this.request.reason}</div>
							</div>
						`
								: ""
						}
					</div>

					<div class="approval-actions">
						<button class="btn btn-deny" @click=${this.handleDeny} ?disabled=${this.submitting}>
							Deny
						</button>
						<button class="btn btn-approve" @click=${this.handleApprove} ?disabled=${this.submitting}>
							${this.submitting ? "Submitting..." : "Approve"}
						</button>
					</div>

					<div class="hint">
						<kbd>Enter</kbd> to approve • <kbd>Esc</kbd> to deny
					</div>
				</div>
			</div>
		`;
	}
}
