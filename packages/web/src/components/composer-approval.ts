/**
 * Approval component - request user approval for dangerous operations
 */

import type { ComposerActionApprovalRequest } from "@evalops/contracts";
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { formatPendingRequestStatus } from "./pending-request-metadata.js";

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

		.approval-header {
			padding: 1rem;
			background: rgba(210, 153, 34, 0.1);
			border-bottom: 1px solid #d29922;
			display: flex;
			align-items: center;
			gap: 0.75rem;
		}

		.warning-icon {
			width: 1.9rem;
			height: 1.9rem;
			display: flex;
			align-items: center;
			justify-content: center;
			border: 1px solid #d29922;
			border-radius: 999px;
			font-size: 0.85rem;
			font-weight: 700;
			color: #d29922;
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

		.queue-box {
			background: #161b22;
			border: 1px solid #30363d;
			border-left: 3px solid #d29922;
			border-radius: 3px;
			padding: 0.75rem;
		}

		.queue-title {
			font-size: 0.78rem;
			font-weight: 700;
			color: #e6edf3;
		}

		.queue-subtitle {
			margin-top: 0.35rem;
			font-size: 0.72rem;
			color: #8b949e;
			line-height: 1.5;
		}

		.tool-info {
			background: #161b22;
			border: 1px solid #30363d;
			border-radius: 2px;
			padding: 0.75rem;
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

		.detail-chip.warning .detail-chip-value {
			color: #f2cc60;
		}

		.detail-chip.success .detail-chip-value {
			color: #3fb950;
		}

		.tool-name {
			font-size: 0.8rem;
			font-weight: 700;
			color: #e6edf3;
			margin-bottom: 0.5rem;
		}

		.tool-meta {
			margin-top: -0.15rem;
			margin-bottom: 0.55rem;
			font-size: 0.7rem;
			color: #8b949e;
		}

		.action-description {
			margin-top: 0.65rem;
			font-size: 0.73rem;
			line-height: 1.5;
			color: #c9d1d9;
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

		.command-box {
			background: #0b1016;
			border: 1px solid #30363d;
			border-radius: 3px;
			padding: 0.75rem;
			max-height: 18rem;
			overflow: auto;
		}

		.command-preview {
			margin: 0;
			font-family: inherit;
			font-size: 0.72rem;
			line-height: 1.6;
			color: #e6edf3;
			white-space: pre-wrap;
			word-break: break-word;
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

	private extractCommandLines(): string[] | null {
		const args = this.getObjectArgs();
		const command = args?.command;
		if (typeof command !== "string" || command.trim().length === 0) {
			return null;
		}
		const scrubbed = command.replace(/[^\x20-\x7e\r\n]/g, "");
		return scrubbed.trim().split(/\r?\n/);
	}

	private getToolDetails(): Array<{
		label: string;
		value: string;
		tone?: "success" | "warning";
	}> {
		const args = this.getObjectArgs();
		if (!args) return [];

		const details: Array<{
			label: string;
			value: string;
			tone?: "success" | "warning";
		}> = [];

		if (typeof args.action === "string" && args.action.trim().length > 0) {
			details.push({ label: "Action", value: args.action });
		}

		if (typeof args.shell === "boolean") {
			details.push({
				label: "Shell mode",
				value: args.shell ? "enabled" : "disabled",
				tone: args.shell ? "warning" : "success",
			});
		}

		return details;
	}

	private getToolTitle(): string {
		return (
			this.request?.summaryLabel ||
			this.request?.displayName ||
			this.request?.toolName ||
			"Tool"
		);
	}

	private getToolMeta(): string | null {
		if (!this.request) return null;
		const rawToolName = this.request.toolName?.trim();
		const title = this.getToolTitle().trim();
		if (rawToolName && title && rawToolName !== title) {
			return rawToolName;
		}
		return null;
	}

	private getArgEntries(): Array<[string, unknown]> {
		const args = this.getObjectArgs();
		if (args) {
			return Object.entries(args).filter(
				([key]) => key !== "action" && key !== "command" && key !== "shell",
			);
		}
		const argsValue = this.request?.args;
		if (argsValue === undefined) {
			return [];
		}
		return [["value", argsValue]];
	}

	private getQueueTitle(): string {
		const total = Math.max(this.queueLength, this.request ? 1 : 0);
		return `Approval 1 of ${Math.max(total, 1)}`;
	}

	private getQueueSubtitle(): string {
		const total = Math.max(this.queueLength, this.request ? 1 : 0);
		const remaining = Math.max(total - 1, 0);
		const queueStatus =
			remaining === 0
				? "No other pending approvals"
				: `${remaining} more approval${remaining === 1 ? "" : "s"} waiting`;
		const requestStatus = formatPendingRequestStatus(this.request);
		return [queueStatus, requestStatus].filter(Boolean).join(" • ");
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
		const commandLines = this.extractCommandLines();
		const toolDetails = this.getToolDetails();

		return html`
			<div class="approval-overlay">
				<div class="approval-modal">
					<div class="approval-header">
						<div class="warning-icon">!</div>
						<div class="header-text">
							<div class="header-title">Approval Required</div>
							<div class="header-subtitle">This operation requires your permission</div>
						</div>
					</div>

					<div class="approval-body">
						<div class="section">
							<div class="section-label">Queue Status</div>
							<div class="queue-box">
								<div class="queue-title">${this.getQueueTitle()}</div>
								<div class="queue-subtitle">${this.getQueueSubtitle()}</div>
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

						<div class="section">
							<div class="section-label">Tool</div>
							<div class="tool-info">
								<div class="tool-name">${this.getToolTitle()}</div>
								${
									this.getToolMeta()
										? html`<div class="tool-meta">${this.getToolMeta()}</div>`
										: ""
								}
								${
									toolDetails.length > 0
										? html`<div class="tool-summary">
											${toolDetails.map(
												(detail) => html`
													<span class="detail-chip ${detail.tone ?? ""}">
														<span class="detail-chip-label">${detail.label}</span>
														<span class="detail-chip-value">${detail.value}</span>
													</span>
												`,
											)}
										</div>`
										: ""
								}
								${
									this.request.actionDescription
										? html`<div class="action-description">
											${this.request.actionDescription}
										</div>`
										: ""
								}
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
							commandLines
								? html`
							<div class="section">
								<div class="section-label">Command Preview</div>
								<div class="command-box">
									<pre class="command-preview">${commandLines.join("\n")}</pre>
								</div>
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
