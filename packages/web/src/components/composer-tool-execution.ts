/**
 * Tool execution component - shows tool calls in real-time with args and results
 */

import hljs from "highlight.js";
import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

interface ToolArgument {
	key: string;
	value: unknown;
}

interface ContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

interface ToolResult {
	content?: ContentBlock[] | string;
	isError?: boolean;
}

type BatchResultEntry = {
	tool?: string;
	summary?: string;
	success?: boolean;
	result?: {
		content?: ContentBlock[] | string;
		details?: unknown;
		isError?: boolean;
	};
};

@customElement("composer-tool-execution")
export class ComposerToolExecution extends LitElement {
	static override styles = css`
		:host {
			display: block;
			font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
			margin: 0.5rem 0;
		}

		:host([reduced-motion]) * {
			animation-duration: 0.001ms !important;
			animation-iteration-count: 1 !important;
			transition: none !important;
		}

		.tool-execution {
			background: #0d1117;
			border: 1px solid #30363d;
			border-left: 4px solid #58a6ff;
			border-radius: 4px;
			overflow: hidden;
			position: relative;
		}

		.tool-execution::before {
			content: '';
			position: absolute;
			left: 0;
			top: 0;
			bottom: 0;
			width: 2px;
			background: linear-gradient(180deg,
				rgba(88, 166, 255, 0.2) 0%,
				rgba(88, 166, 255, 0.05) 100%);
			margin-left: 4px;
		}

		.tool-execution.error {
			border-left-color: #f85149;
		}

		.tool-execution.error::before {
			background: linear-gradient(180deg,
				rgba(248, 81, 73, 0.2) 0%,
				rgba(248, 81, 73, 0.05) 100%);
		}

		.tool-execution.completed {
			border-left-color: #3fb950;
		}

		.tool-execution.completed::before {
			background: linear-gradient(180deg,
				rgba(63, 185, 80, 0.2) 0%,
				rgba(63, 185, 80, 0.05) 100%);
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
			flex: 1;
			min-width: 0;
		}

		.tool-glyph {
			font-size: 0.9rem;
			line-height: 1;
			flex-shrink: 0;
		}

		.file-badge {
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
			background: var(--bg-secondary, #161b22);
			border: 1px solid var(--border-color, #30363d);
			border-radius: 4px;
			padding: 0.15rem 0.4rem;
			font-size: 0.7rem;
			font-weight: 500;
			color: #8b949e;
			text-transform: none;
			letter-spacing: 0;
			max-width: 300px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			margin-left: 0.5rem;
		}

		.file-badge:hover {
			background: #1c2128;
			border-color: #58a6ff;
			color: #58a6ff;
			cursor: help;
		}

		.file-badge::before {
			content: "📁";
			font-size: 0.75rem;
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

	.tool-summary {
		padding: 0.5rem 0.75rem;
		border-top: 1px solid #21262d;
		background: var(--bg-secondary, #161b22);
		font-size: 0.7rem;
		color: #8b949e;
		display: flex;
		gap: 0.75rem;
		align-items: center;
		flex-wrap: wrap;
	}

	.tool-execution.batch .tool-body {
		padding: 0.6rem 0.75rem;
	}

	.tool-summary.batch-summary {
		justify-content: flex-start;
		gap: 0.5rem;
	}

	.batch-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.2rem 0.45rem;
		border-radius: 999px;
		border: 1px solid #30363d;
		background: #10141a;
		color: #9ba7b4;
		font-weight: 600;
		letter-spacing: 0.02em;
	}

	.batch-chip.good { border-color: #2ea043; color: #7ee0a3; }
	.batch-chip.bad { border-color: #f85149; color: #f85149; }
	.batch-chip.muted { border-color: #21262d; color: #8b949e; }

	.batch-preview {
		color: #8b949e;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 100%;
	}

	.batch-list {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
	}

	.batch-row {
		display: grid;
		grid-template-columns: 18px 1fr;
		gap: 0.5rem;
		align-items: center;
		background: #0f1218;
		border: 1px solid #1f242b;
		border-radius: 6px;
		padding: 0.45rem 0.55rem;
	}

	.batch-row .batch-status {
		font-size: 0.8rem;
		line-height: 1;
	}

	.batch-row .batch-summary-text {
		font-size: 0.75rem;
		color: #c9d1d9;
		word-break: break-word;
	}

	.batch-row .batch-title {
		display: inline-flex;
		gap: 0.35rem;
		font-weight: 700;
		text-transform: lowercase;
		color: #8b949e;
	}

	.batch-row.error {
		border-color: #392226;
		background: #1b0f11;
	}

	.batch-empty {
		color: #8b949e;
		font-size: 0.75rem;
		padding: 0.5rem 0.25rem;
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
			border-radius: 4px;
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

		.copy-result {
			margin-top: 0.35rem;
			background: transparent;
			border: 1px solid var(--border-color, #30363d);
			color: #8b949e;
			padding: 0.25rem 0.5rem;
			font-size: 0.65rem;
			border-radius: 4px;
			cursor: pointer;
		}

		.copy-result:hover {
			border-color: #58a6ff;
			color: #58a6ff;
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

	.tool-header .collapse-toggle {
		margin-top: 0;
		padding: 0.2rem 0.4rem;
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

		/* Syntax Highlighting */
		.hljs {
			display: block;
			overflow-x: auto;
			padding: 0.5em;
			color: var(--text-primary);
			background: transparent;
		}

		.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: var(--syntax-keyword, #569cd6); }
		.hljs-string, .hljs-title, .hljs-name, .hljs-type, .hljs-attribute, .hljs-symbol, .hljs-bullet, .hljs-addition, .hljs-variable, .hljs-template-tag, .hljs-template-variable { color: var(--syntax-string, #ce9178); }
		.hljs-comment, .hljs-quote, .hljs-deletion, .hljs-meta { color: var(--syntax-comment, #6a9955); }
		.hljs-number, .hljs-regexp, .hljs-selector-id, .hljs-selector-class, .hljs-builtin-name { color: var(--syntax-number, #b5cea8); }
		.hljs-function, .hljs-title.function_ { color: var(--syntax-function, #dcdcaa); }
		.hljs-params, .hljs-attr { color: var(--syntax-variable, #9cdcfe); }

		.arg-value pre {
			margin: 0;
			white-space: pre-wrap;
			font-family: var(--font-mono, monospace);
		}

		.arg-value.code-block {
			background: #0d1117;
			border: 1px solid #30363d;
			border-radius: 4px;
			padding: 0.5rem;
			margin-top: 0.25rem;
			max-height: 400px;
			overflow-y: auto;
		}
	`;

	@property({ type: String }) toolName = "";
	@property({ type: String }) toolCallId = "";
	@property({ type: Object }) args: Record<string, unknown> = {};
	@property({ type: Object }) result: ToolResult | string | null = null;
	@property({ type: Boolean }) isError = false;
	@property({ type: Boolean }) isRunning = true;
	@property({ type: Number }) startTime = Date.now();
	@property({ type: Number }) endTime: number | null = null;
	@property({ type: Boolean }) compact = false;
	@property({ type: Boolean, reflect: true, attribute: "reduced-motion" })
	reducedMotion = false;

	@state() private bodyCollapsed = false;
	@state() private showFullResult = false;
	@state() private showAllBatch = false;

	private getLanguageFromFilename(filename: string): string {
		if (!filename) return "plaintext";
		const ext = filename.split(".").pop()?.toLowerCase();
		switch (ext) {
			case "ts":
			case "tsx":
				return "typescript";
			case "js":
			case "jsx":
				return "javascript";
			case "py":
				return "python";
			case "html":
				return "html";
			case "css":
				return "css";
			case "json":
				return "json";
			case "md":
				return "markdown";
			case "sh":
			case "bash":
				return "bash";
			case "rs":
				return "rust";
			case "go":
				return "go";
			case "java":
				return "java";
			default:
				return "plaintext";
		}
	}

	private highlightCode(code: string, lang: string) {
		if (!code) return "";
		if (lang && hljs.getLanguage(lang)) {
			try {
				return unsafeHTML(hljs.highlight(code, { language: lang }).value);
			} catch (e) {
				console.error("Highlight error:", e);
			}
		}
		return unsafeHTML(hljs.highlightAuto(code).value);
	}

	private getToolGlyph(toolName: string): string {
		const glyphs: Record<string, string> = {
			read: "📄",
			write: "✏️",
			edit: "📝",
			bash: "⚡",
			search: "🔍",
			diff: "🔀",
			list: "📋",
			gh_pr: "🔀",
			gh_issue: "🐛",
			gh_repo: "📦",
			artifacts: "🗂️",
		};
		return glyphs[toolName] || "🔧";
	}

	private getFilePathFromArgs(): string | null {
		const path = this.args?.path;
		if (typeof path === "string") return path;
		const filePath = this.args?.file_path;
		if (typeof filePath === "string") return filePath;
		const filePathCamel = this.args?.filePath;
		if (typeof filePathCamel === "string") return filePathCamel;
		const filename = this.args?.filename;
		if (typeof filename === "string") return filename;
		return null;
	}

	private dispatchOpenArtifact(filename: string) {
		this.dispatchEvent(
			new CustomEvent("open-artifact", {
				bubbles: true,
				composed: true,
				detail: { filename },
			}),
		);
	}

	private formatValue(value: unknown): string {
		if (value === null || value === undefined) return "null";
		if (typeof value === "string") return value;
		if (typeof value === "number" || typeof value === "boolean")
			return String(value);
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

	private async copyResult() {
		if (!this.result) return;
		try {
			const text =
				typeof this.result === "string"
					? this.result
					: JSON.stringify(this.result, null, 2);
			await navigator.clipboard.writeText(text);
		} catch (e) {
			console.error("Failed to copy result:", e);
		}
	}

	private toggleBodyCollapse() {
		this.bodyCollapsed = !this.bodyCollapsed;
	}

	private toggleFullResult() {
		this.showFullResult = !this.showFullResult;
	}

	protected override updated(changed: Map<string, unknown>) {
		if (changed.has("compact") && this.compact && !this.bodyCollapsed) {
			this.bodyCollapsed = true;
		}
	}

	protected override firstUpdated(): void {
		if (this.isBatchTool() && !this.bodyCollapsed) {
			this.bodyCollapsed = true;
		}
	}

	private isBatchTool(): boolean {
		return this.toolName?.toLowerCase() === "batch";
	}

	private toggleBatchShowAll = () => {
		this.showAllBatch = !this.showAllBatch;
	};

	private truncate(text?: string, max = 120): string {
		if (!text) return "";
		const normalized = text.replace(/\s+/g, " ").trim();
		if (normalized.length <= max) return normalized;
		return `${normalized.slice(0, max - 1)}…`;
	}

	private getBatchResults(): BatchResultEntry[] {
		if (!this.result || typeof this.result !== "object") return [];
		const details = (this.result as { details?: unknown }).details;
		if (!details || typeof details !== "object") return [];
		const results = (details as { results?: unknown }).results;
		if (!Array.isArray(results)) return [];
		return results.filter(Boolean) as BatchResultEntry[];
	}

	private getBatchStats(results: BatchResultEntry[]) {
		const total = results.length;
		const failures = results.filter(
			(r) => r.success === false || r.result?.isError,
		).length;
		return { total, failures, successes: Math.max(0, total - failures) };
	}

	private extractPreviewText(): string | null {
		if (!this.result) return null;
		if (typeof this.result === "string") return this.truncate(this.result, 140);
		if (Array.isArray(this.result.content)) {
			const textBlock = this.result.content.find(
				(block) => block.type === "text",
			);
			if (textBlock?.text) return this.truncate(textBlock.text, 140);
		} else if (typeof this.result.content === "string") {
			return this.truncate(this.result.content, 140);
		}
		return null;
	}

	private renderBatchSummary(results: BatchResultEntry[], statusText: string) {
		const stats = this.getBatchStats(results);
		const preview = this.extractPreviewText();
		return html`
			<div class="tool-summary batch-summary">
				<span class="batch-chip muted">Batch</span>
				<span class="batch-chip good">${stats.successes} ok</span>
				<span class="batch-chip ${stats.failures ? "bad" : "muted"}">
					${stats.failures} err
				</span>
				<span class="batch-chip muted">${statusText}</span>
				${
					preview
						? html`<span class="batch-preview" title="${preview}">${preview}</span>`
						: ""
				}
			</div>
		`;
	}

	private renderBatchRows(results: BatchResultEntry[]) {
		if (!results.length) {
			const preview = this.extractPreviewText();
			return html`<div class="batch-empty">
				${preview || "No batch results yet."}
			</div>`;
		}
		const collapsedLimit = 6;
		const limit = this.showAllBatch ? results.length : collapsedLimit;
		const rows = results.slice(0, limit);
		const hasMore = results.length > collapsedLimit;
		return html`
			<div class="batch-list">
				${rows.map((entry, index) => {
					const isError = entry.success === false || entry.result?.isError;
					const status = isError ? "✕" : "✓";
					const summary =
						this.truncate(entry.summary, 110) ||
						this.truncate(
							typeof entry.result?.content === "string"
								? entry.result.content
								: Array.isArray(entry.result?.content)
									? entry.result?.content
											.filter((c) => c.type === "text")
											.map((c) => c.text || "")
											.join(" ")
									: "",
							110,
						) ||
						"Completed";
					return html`
						<div class="batch-row ${isError ? "error" : ""}">
							<span class="batch-status" aria-label=${isError ? "error" : "ok"}>${status}</span>
							<div class="batch-summary-text">
								<span class="batch-title">
									${entry.tool || `call ${index + 1}`}
								</span>
								${summary}
							</div>
						</div>
					`;
				})}
				${
					hasMore || this.showAllBatch
						? html`
							<button class="collapse-toggle" @click=${this.toggleBatchShowAll}>
								${
									this.showAllBatch
										? "Show Less"
										: `Show All (${results.length - collapsedLimit} more)`
								}
							</button>
					  `
						: ""
				}
			</div>
		`;
	}

	private renderMetadata() {
		if (this.isRunning) return null;
		return html`
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
		`;
	}

	private renderBatchExecution(statusClass: string, statusText: string) {
		const results = this.getBatchResults();
		return html`
			<div class="tool-execution ${statusClass} batch">
				<div class="tool-header">
					<div class="tool-name">
						<div class="tool-icon">
							${
								this.isRunning
									? html`<div class="spinner"></div>`
									: this.isError
										? html`<span style="color: #f85149;">✕</span>`
										: html`<span style="color: #3fb950;">✓</span>`
							}
						</div>
						<span class="tool-glyph">${this.getToolGlyph(this.toolName)}</span>
						<span>${this.toolName}</span>
					</div>
					<div style="display:flex; align-items:center; gap:0.35rem;">
						<button class="collapse-toggle" @click=${this.toggleBodyCollapse}>
							${this.bodyCollapsed ? "Expand" : "Collapse"}
						</button>
						<div class="tool-status ${statusClass}">${statusText}</div>
					</div>
				</div>

				${
					this.bodyCollapsed
						? this.renderBatchSummary(results, statusText)
						: html`
							<div class="tool-body">
								${this.renderBatchRows(results)} ${this.renderMetadata()}
							</div>
					  `
				}
			</div>
		`;
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
					.map((block: ContentBlock) => {
						if (block.type === "text") return block.text ?? "";
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
		const displayContent =
			truncated && !this.showFullResult
				? `${content.slice(0, maxLength)}\n... (truncated)`
				: content;

		return html`
				<div class="tool-section">
					<div class="section-label">Result</div>
					<div class="result-content ${isErrorResult ? "error" : ""}">
						${displayContent}
					</div>
					${
						truncated
							? html`
						<button class="collapse-toggle" @click=${this.toggleFullResult}>
							${this.showFullResult ? "Show Less" : "Show Full Output"}
						</button>
					`
							: ""
					}
					<button class="copy-result" @click=${this.copyResult}>Copy Result</button>
				</div>
			`;
	}

	override render() {
		const statusClass = this.isRunning
			? "running"
			: this.isError
				? "error"
				: "completed";
		const statusText = this.isRunning
			? "Running..."
			: this.isError
				? "Error"
				: "Completed";
		const formattedArgs = this.formatArgs();

		if (this.isBatchTool()) {
			return this.renderBatchExecution(statusClass, statusText);
		}

		return html`
			<div class="tool-execution ${statusClass}">
				<div class="tool-header">
					<div class="tool-name">
						<div class="tool-icon">
							${
								this.isRunning
									? html`<div class="spinner"></div>`
									: this.isError
										? html`<span style="color: #f85149;">✕</span>`
										: html`<span style="color: #3fb950;">✓</span>`
							}
						</div>
						<span class="tool-glyph">${this.getToolGlyph(this.toolName)}</span>
						<span>${this.toolName}</span>
						${
							this.getFilePathFromArgs()
								? html`<span
										class="file-badge"
										title="${this.getFilePathFromArgs()}"
										@click=${() => {
											const filename = this.getFilePathFromArgs();
											if (this.toolName === "artifacts" && filename) {
												this.dispatchOpenArtifact(filename);
											}
										}}
									>${this.getFilePathFromArgs()?.split("/").pop()}</span>`
								: ""
						}
					</div>
					<div style="display:flex; align-items:center; gap:0.35rem;">
						${
							this.toolName === "artifacts" && this.getFilePathFromArgs()
								? html`<button
										class="collapse-toggle"
										@click=${() => {
											const filename = this.getFilePathFromArgs();
											if (filename) this.dispatchOpenArtifact(filename);
										}}
									>
										Open
									</button>`
								: ""
						}
						<button class="collapse-toggle" @click=${this.toggleBodyCollapse}>
							${this.bodyCollapsed ? "Expand" : "Collapse"}
						</button>
						<div class="tool-status ${statusClass}">${statusText}</div>
					</div>
				</div>

				${
					this.bodyCollapsed
						? html`
						<div class="tool-summary">
							<span>${statusText}</span>
							${
								formattedArgs.length > 0
									? html`<span class="metadata-value">${formattedArgs[0].key}: ${this.formatValue(formattedArgs[0].value)}</span>`
									: ""
							}
							${
								!this.isRunning
									? html`<span class="metadata-value">${this.formatDuration()}</span>`
									: ""
							}
						</div>
					`
						: html`
						<div class="tool-body">
							${
								formattedArgs.length > 0
									? html`
								<div class="tool-section">
									<div class="section-label">Arguments</div>
									<div class="args-grid">
										${formattedArgs.map((arg) => {
											const isCodeArg =
												(arg.key === "contents" ||
													arg.key === "content" ||
													arg.key === "new_string" ||
													arg.key === "old_string") &&
												(this.toolName === "write" ||
													this.toolName === "edit" ||
													this.toolName === "search_replace");

											if (isCodeArg && typeof arg.value === "string") {
												const filePath = this.getFilePathFromArgs();
												const lang = filePath
													? this.getLanguageFromFilename(filePath)
													: "plaintext";
												return html`
													<div class="arg-key">${arg.key}:</div>
													<div class="arg-value code-block">
														<pre><code>${this.highlightCode(arg.value, lang)}</code></pre>
													</div>
												`;
											}
											return html`
											<div class="arg-key">${arg.key}:</div>
											<div class="arg-value ${typeof arg.value === "object" ? "json" : ""}">
												${this.formatValue(arg.value)}
											</div>
										`;
										})}
									</div>
								</div>
							`
									: ""
							}

							${this.result ? this.renderResult() : ""}

							${
								!this.isRunning
									? html`
								${this.renderMetadata()}
						  `
									: ""
							}
						</div>
					`
				}
			</div>
		`;
	}
}
