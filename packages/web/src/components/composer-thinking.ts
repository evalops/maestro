/**
 * Thinking block component - displays model reasoning/thinking
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("composer-thinking")
export class ComposerThinking extends LitElement {
	static override styles = css`
		:host {
			display: block;
			font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
			margin: 0.5rem 0;
		}

		.thinking-block {
			background: #0d1117;
			border: 1px solid #30363d;
			border-left: 3px solid #bc8cff;
			border-radius: 2px;
			overflow: hidden;
		}

		.thinking-block.collapsed {
			cursor: pointer;
		}

		.thinking-block.collapsed:hover {
			background: #161b22;
		}

		.thinking-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.5rem 0.75rem;
			background: #161b22;
			border-bottom: 1px solid #21262d;
			cursor: pointer;
			user-select: none;
		}

		.thinking-label {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			font-size: 0.7rem;
			font-weight: 700;
			color: #bc8cff;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.thinking-icon {
			display: flex;
			align-items: center;
			justify-content: center;
			animation: pulse 2s ease-in-out infinite;
		}

		@keyframes pulse {
			0%, 100% { opacity: 1; }
			50% { opacity: 0.5; }
		}

		.collapse-indicator {
			font-size: 0.65rem;
			color: #6e7681;
			transition: transform 0.15s;
		}

		.thinking-block.collapsed .collapse-indicator {
			transform: rotate(-90deg);
		}

		.thinking-content {
			padding: 0.75rem;
			font-size: 0.75rem;
			line-height: 1.8;
			color: #8b949e;
			font-style: italic;
			white-space: pre-wrap;
			word-break: break-word;
			max-height: 400px;
			overflow-y: auto;
		}

		.thinking-content.collapsed {
			display: none;
		}

		.thinking-summary {
			padding: 0.5rem 0.75rem;
			font-size: 0.7rem;
			color: #6e7681;
			font-style: italic;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.metadata {
			display: flex;
			gap: 1rem;
			font-size: 0.65rem;
			color: #6e7681;
			padding: 0.5rem 0.75rem;
			border-top: 1px solid #21262d;
			background: #0a0e14;
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

		/* Scrollbar styling */
		.thinking-content::-webkit-scrollbar {
			width: 6px;
		}

		.thinking-content::-webkit-scrollbar-track {
			background: transparent;
		}

		.thinking-content::-webkit-scrollbar-thumb {
			background: #30363d;
			border-radius: 3px;
		}

		.thinking-content::-webkit-scrollbar-thumb:hover {
			background: #6e7681;
		}
	`;

	@property({ type: String }) content = "";
	@property({ type: Boolean }) isStreaming = false;
	@state() private collapsed = true;

	private toggleCollapse(e: Event) {
		e.stopPropagation();
		this.collapsed = !this.collapsed;
	}

	private formatTokenCount(): string {
		// Rough estimate: ~4 characters per token
		const estimatedTokens = Math.ceil(this.content.length / 4);
		if (estimatedTokens < 1000) return `~${estimatedTokens} tokens`;
		return `~${(estimatedTokens / 1000).toFixed(1)}k tokens`;
	}

	private getSummary(): string {
		if (!this.content) return "Thinking...";
		const firstLine = this.content.split("\n")[0];
		return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
	}

	override render() {
		const hasContent = this.content.length > 0;

		return html`
			<div class="thinking-block ${this.collapsed ? "collapsed" : ""}">
				<div class="thinking-header" @click=${this.toggleCollapse}>
					<div class="thinking-label">
						<div class="thinking-icon">
							${this.isStreaming ? "💭" : "🧠"}
						</div>
						<span>${this.isStreaming ? "Thinking..." : "Reasoning"}</span>
					</div>
					<div class="collapse-indicator">▼</div>
				</div>

				${
					this.collapsed && hasContent
						? html`
					<div class="thinking-summary">${this.getSummary()}</div>
				`
						: ""
				}

				<div class="thinking-content ${this.collapsed ? "collapsed" : ""}">
					${this.content || "Generating reasoning..."}
				</div>

				${
					hasContent && !this.isStreaming
						? html`
					<div class="metadata">
						<div class="metadata-item">
							<span class="metadata-label">Length:</span>
							<span class="metadata-value">${this.content.length} chars</span>
						</div>
						<div class="metadata-item">
							<span class="metadata-label">Estimated:</span>
							<span class="metadata-value">${this.formatTokenCount()}</span>
						</div>
					</div>
				`
						: ""
				}
			</div>
		`;
	}
}
