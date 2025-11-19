/**
 * Tool execution component - shows tool calls in real-time with args and results
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

interface ToolArgument {
	key: string;
	value: any;
}

@customElement("composer-tool-execution")
export class ComposerToolExecution extends LitElement {
	static styles = css`
		:host {
			display: block;
			font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
			margin: 0.5rem 0;
		}

		.tool-execution {
			background: #0d1117;
			border: 1px solid #30363d;
			border-left: 3px solid #58a6ff;
			border-radius: 2px;
			overflow: hidden;
		}

		.tool-execution.error {
			border-left-color: #f85149;
		}

		.tool-execution.completed {
			border-left-color: #3fb950;
		}

		.tool-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.5rem 0.75rem;
			background: #161b22;
			border-bottom: 1px solid #21262d;
		}

		.tool-name {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			font-size: 0.75rem;
			font-weight: 700;
			color: #e6edf3;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.tool-icon {
			width: 16px;
			height: 16px;
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.spinner {
			width: 12px;
			height: 12px;
			border: 2px solid #30363d;
			border-top-color: #58a6ff;
			border-radius: 50%;
			animation: spin 0.6s linear infinite;
		}

		@keyframes spin {
			to { transform: rotate(360deg); }
		}

		.tool-status {
			font-size: 0.65rem;
			color: #6e7681;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.tool-status.running {
			color: #58a6ff;
		}

		.tool-status.completed {
			color: #3fb950;
		}

		.tool-status.error {
			color: #f85149;
		}

		.tool-body {
			padding: 0.75rem;
		}

		.tool-section {
			margin-bottom: 0.75rem;
		}

		.tool-section:last-child {
			margin-bottom: 0;
		}

		.section-label {
			font-size: 0.65rem;
			color: #6e7681;
			text-transform: uppercase;
			letter-spacing: 0.1em;
			margin-bottom: 0.35rem;
			font-weight: 700;
		}

		.args-grid {
			display: grid;
			grid-template-columns: auto 1fr;
			gap: 0.35rem 0.75rem;
			font-size: 0.75rem;
			line-height: 1.6;
		}

		.arg-key {
			color: #8b949e;
			font-weight: 600;
		}

		.arg-value {
			color: #e6edf3;
			word-break: break-all;
		}

		.arg-value.json {
			color: #39c5cf;
		}

		.result-content {
			background: #0a0e14;
			border: 1px solid #21262d;
			border-radius: 2px;
			padding: 0.625rem;
			font-size: 0.75rem;
			line-height: 1.6;
			color: #e6edf3;
			max-height: 300px;
			overflow-y: auto;
			white-space: pre-wrap;
			word-break: break-word;
		}

		.result-content.error {
			color: #f85149;
			border-color: #f85149;
		}

		.result-content code {
			background: #161b22;
			padding: 0.125rem 0.35rem;
			border-radius: 2px;
			font-size: 0.7rem;
		}

		.collapse-toggle {
			background: transparent;
			border: none;
			color: #58a6ff;
			cursor: pointer;
			padding: 0.25rem 0.5rem;
			font-family: inherit;
			font-size: 0.7rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			transition: all 0.15s;
			margin-top: 0.5rem;
		}

		.collapse-toggle:hover {
			color: #539bf5;
			text-decoration: underline;
		}

		.metadata {
			display: flex;
			gap: 1rem;
			font-size: 0.65rem;
			color: #6e7681;
			margin-top: 0.5rem;
			padding-top: 0.5rem;
			border-top: 1px solid #21262d;
		}

		.metadata-item {
			display: flex;
			gap: 0.35rem;
		}

		.metadata-label {
			color: #6e7681;
		}

		.metadata-value {
			color: #8b949e;
		}
	`;

	@property({ type: String }) toolName = "";
	@property({ type: String }) toolCallId = "";
	@property({ type: Object }) args: any = {};
	@property({ type: Object }) result: any = null;
	@property({ type: Boolean }) isError = false;
	@property({ type: Boolean }) isRunning = true;
	@property({ type: Number }) startTime = Date.now();
	@property({ type: Number }) endTime: number | null = null;

	@state() private collapsed = false;

	private formatValue(value: any): string {
		if (value === null || value === undefined) return "null";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		return JSON.stringify(value, null, 2);
	}

	private formatArgs(): ToolArgument[] {
		if (!this.args || typeof this.args !== "object") return [];
		return Object.entries(this.args).map(([key, value]) => ({ key, value }));
	}

	private formatDuration(): string {
		const end = this.endTime || Date.now();
		const duration = end - this.startTime;
		if (duration < 1000) return `${duration}ms`;
		return `${(duration / 1000).toFixed(2)}s`;
	}

	private toggleCollapse() {
		this.collapsed = !this.collapsed;
	}

	private renderResult() {
		if (!this.result) return html``;

		let content = "";
		let isErrorResult = false;

		// Handle different result formats
		if (typeof this.result === "string") {
			content = this.result;
			isErrorResult = this.isError;
		} else if (this.result.content) {
			// Array of content blocks
			if (Array.isArray(this.result.content)) {
				content = this.result.content
					.map((block: any) => {
						if (block.type === "text") return block.text;
						if (block.type === "image") return "[Image]";
						return JSON.stringify(block);
					})
					.join("\n");
			} else {
				content = String(this.result.content);
			}
			isErrorResult = this.result.isError || this.isError;
		} else {
			content = JSON.stringify(this.result, null, 2);
			isErrorResult = this.isError;
		}

		// Limit content length for display
		const maxLength = 2000;
		const truncated = content.length > maxLength;
		const displayContent = truncated ? content.slice(0, maxLength) + "\n... (truncated)" : content;

		return html`
			<div class="tool-section">
				<div class="section-label">Result</div>
				<div class="result-content ${isErrorResult ? "error" : ""}">
					${displayContent}
				</div>
				${truncated ? html`
					<button class="collapse-toggle" @click=${this.toggleCollapse}>
						${this.collapsed ? "Show Less" : "Show Full Output"}
					</button>
				` : ""}
			</div>
		`;
	}

	render() {
		const statusClass = this.isRunning ? "running" : this.isError ? "error" : "completed";
		const statusText = this.isRunning ? "Running..." : this.isError ? "Error" : "Completed";
		const formattedArgs = this.formatArgs();

		return html`
			<div class="tool-execution ${statusClass}">
				<div class="tool-header">
					<div class="tool-name">
						<div class="tool-icon">
							${this.isRunning 
								? html`<div class="spinner"></div>` 
								: this.isError 
									? html`<span style="color: #f85149;">✕</span>`
									: html`<span style="color: #3fb950;">✓</span>`
							}
						</div>
						<span>${this.toolName}</span>
					</div>
					<div class="tool-status ${statusClass}">${statusText}</div>
				</div>

				<div class="tool-body">
					${formattedArgs.length > 0 ? html`
						<div class="tool-section">
							<div class="section-label">Arguments</div>
							<div class="args-grid">
								${formattedArgs.map(arg => html`
									<div class="arg-key">${arg.key}:</div>
									<div class="arg-value ${typeof arg.value === 'object' ? 'json' : ''}">
										${this.formatValue(arg.value)}
									</div>
								`)}
							</div>
						</div>
					` : ""}

					${this.result ? this.renderResult() : ""}

					${!this.isRunning ? html`
						<div class="metadata">
							<div class="metadata-item">
								<span class="metadata-label">ID:</span>
								<span class="metadata-value">${this.toolCallId.slice(0, 8)}</span>
							</div>
							<div class="metadata-item">
								<span class="metadata-label">Duration:</span>
								<span class="metadata-value">${this.formatDuration()}</span>
							</div>
						</div>
					` : ""}
				</div>
			</div>
		`;
	}
}
