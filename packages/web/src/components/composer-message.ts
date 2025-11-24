/**
 * Message display component
 */

import DOMPurify from "dompurify";
import hljs from "highlight.js";
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";

// Configure marked with code highlighting
marked.setOptions({
	highlight: (code: string, lang: string) => {
		if (lang && hljs.getLanguage(lang)) {
			try {
				return hljs.highlight(code, { language: lang }).value;
			} catch (e) {
				console.error("Highlight error:", e);
			}
		}
		return hljs.highlightAuto(code).value;
	},
} as any); // Type assertion needed for marked options compatibility

@customElement("composer-message")
export class ComposerMessage extends LitElement {
	static styles = css`
			:host {
				display: block;
			}

			:host([reduced-motion]) * {
				animation-duration: 0.001ms !important;
				animation-iteration-count: 1 !important;
				transition: none !important;
			}

		.message {
			display: grid;
			grid-template-columns: 60px 1fr;
			gap: 0;
			background: #0d1117;
			border-bottom: 1px solid #21262d;
			padding: 0.625rem 0.875rem;
			font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
			font-size: 0.8rem;
			line-height: 1.6;
		}

		.message.compact {
			padding: 0.4rem 0.65rem;
			font-size: 0.75rem;
			line-height: 1.4;
		}

		.message.user {
			background: #161b22;
		}

		.role-label {
			font-size: 0.65rem;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.1em;
			color: #6e7681;
			padding-top: 0.125rem;
		}

		.message.user .role-label {
			color: #58a6ff;
		}

		.message.assistant .role-label {
			color: #39c5cf;
		}

		.content {
			min-width: 0;
			word-wrap: break-word;
			overflow-wrap: break-word;
		}

		.bubble {
			color: #e6edf3;
		}

		.message.user .bubble {
			color: #e6edf3;
		}

		.timestamp {
			font-size: 0.65rem;
			color: #6e7681;
			margin-top: 0.5rem;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.tools-indicator {
			display: inline-block;
			margin-left: 0.75rem;
			padding: 0.125rem 0.35rem;
			background: var(--bg-secondary, #161b22);
			border: 1px solid var(--border-color, #30363d);
			border-radius: 4px;
			font-size: 0.6rem;
			font-weight: 700;
			color: #8b949e;
			text-transform: uppercase;
			letter-spacing: 0.04em;
		}

		.content > composer-tool-execution {
			display: block;
			margin-top: 1rem;
		}

		.message.compact .content > composer-tool-execution {
			margin-top: 0.8rem;
		}

		/* Markdown styles */
		.bubble :global(pre) {
			background: #0d1117;
			padding: 1rem;
			border-radius: 8px;
			overflow-x: auto;
			margin: 0.75rem 0;
			border: 1px solid rgba(48, 54, 61, 0.5);
			position: relative;
		}

		.bubble :global(pre code) {
			background: none;
			padding: 0;
			border: none;
		}

		.bubble :global(code) {
			font-family: "SF Mono", "Monaco", "Inconsolata", "Roboto Mono", "Courier New", monospace;
			font-size: 0.875rem;
			background: rgba(110, 118, 129, 0.2);
			padding: 0.2em 0.4em;
			border-radius: 4px;
		}

		.message.user .bubble :global(code) {
			background: rgba(255, 255, 255, 0.2);
		}

		.bubble :global(p) {
			margin: 0.75rem 0;
			line-height: 1.7;
		}

		.bubble :global(p:first-child) {
			margin-top: 0;
		}

		.bubble :global(p:last-child) {
			margin-bottom: 0;
		}

		.bubble :global(h1), 
		.bubble :global(h2), 
		.bubble :global(h3), 
		.bubble :global(h4) {
			margin: 1.25rem 0 0.75rem 0;
			font-weight: 600;
			line-height: 1.3;
		}

		.bubble :global(h1) { font-size: 1.75rem; }
		.bubble :global(h2) { font-size: 1.5rem; }
		.bubble :global(h3) { font-size: 1.25rem; }
		.bubble :global(h4) { font-size: 1.1rem; }

		.bubble :global(ul), 
		.bubble :global(ol) {
			margin: 0.75rem 0;
			padding-left: 1.75rem;
		}

		.bubble :global(li) {
			margin: 0.375rem 0;
			line-height: 1.6;
		}

		.bubble :global(blockquote) {
			border-left: 4px solid rgba(88, 166, 255, 0.4);
			padding-left: 1rem;
			margin: 1rem 0;
			color: var(--text-secondary, #7d8590);
			font-style: italic;
		}

		.bubble :global(a) {
			color: #58a6ff;
			text-decoration: none;
			border-bottom: 1px solid transparent;
			transition: all 0.2s;
		}

		.bubble :global(a:hover) {
			border-bottom-color: #58a6ff;
		}

		.message.user .bubble :global(a) {
			color: rgba(255, 255, 255, 0.9);
			border-bottom-color: rgba(255, 255, 255, 0.3);
		}

		.message.user .bubble :global(a:hover) {
			border-bottom-color: white;
		}

		.bubble :global(table) {
			border-collapse: collapse;
			width: 100%;
			margin: 1rem 0;
		}

		.bubble :global(th),
		.bubble :global(td) {
			padding: 0.5rem 0.75rem;
			border: 1px solid rgba(48, 54, 61, 0.5);
			text-align: left;
		}

		.bubble :global(th) {
			background: rgba(33, 38, 45, 0.8);
			font-weight: 600;
		}

		.copy-button {
			position: absolute;
			top: 0.5rem;
			right: 0.5rem;
			padding: 0.375rem 0.75rem;
			background: var(--bg-secondary, #161b22);
			border: 1px solid var(--border-color, #30363d);
			border-radius: 4px;
			color: #cde5ff;
			font-size: 0.75rem;
			font-weight: 600;
			cursor: pointer;
			opacity: 0;
			transition: all 0.2s;
		}

		.bubble :global(pre:hover) .copy-button {
			opacity: 1;
		}

		.copy-button:hover {
			background: rgba(88, 166, 255, 0.3);
			transform: translateY(-1px);
		}

		.copy-button.copied {
			background: rgba(63, 185, 80, 0.3);
			border-color: rgba(63, 185, 80, 0.4);
			color: #3fb950;
		}

		@media (max-width: 768px) {
			.content {
				max-width: 85%;
			}

			.avatar {
				width: 36px;
				height: 36px;
				font-size: 0.9rem;
			}

			.bubble {
				padding: 0.875rem 1rem;
			}
		}
	`;

	@property() role: "user" | "assistant" | "system" = "user";
	@property() content = "";
	@property() timestamp = "";
	@property() thinking = "";
	@property() tools: Array<{
		id?: string;
		toolCallId?: string;
		name: string;
		status: string;
		args?: any;
		result?: any;
	}> = [];
	@property({ type: Boolean }) compact = false;
	@property({ type: Boolean, reflect: true, attribute: "reduced-motion" })
	reducedMotion = false;

	private formatTimestamp(ts: string): string {
		if (!ts) return "";
		const date = new Date(ts);
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const hours = Math.floor(diff / (1000 * 60 * 60));

		if (hours < 1) {
			const minutes = Math.floor(diff / (1000 * 60));
			return minutes < 1 ? "Just now" : `${minutes}m ago`;
		}
		if (hours < 24) {
			return `${hours}h ago`;
		}
		return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	private getAvatar(): string {
		return this.role === "user" ? "👤" : "🤖";
	}

	private async copyCodeFromButton(button: HTMLElement) {
		const pre = button.closest("pre");
		if (!pre) return;
		const codeEl = pre.querySelector("code");
		const text = codeEl?.textContent || pre.textContent || "";
		try {
			await navigator.clipboard.writeText(text.trim());
			button.textContent = "Copied!";
			button.classList.add("copied");
			setTimeout(() => {
				button.textContent = "Copy";
				button.classList.remove("copied");
			}, 2000);
		} catch (e) {
			console.error("Failed to copy:", e);
		}
	}

	private handleCopyClick(e: Event) {
		const target = e.target as HTMLElement;
		if (target?.classList.contains("copy-button")) {
			this.copyCodeFromButton(target);
		}
	}

	private renderContent() {
		if (this.role === "user") {
			// User messages are plain text with basic formatting
			const escaped = this.content
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/\n/g, "<br>");
			return html`<div class="bubble">${unsafeHTML(escaped)}</div>`;
		}

		// Assistant messages support full markdown
		const rendered = marked.parse(this.content, { async: false }) as string;
		const sanitized = DOMPurify.sanitize(rendered, {
			ADD_ATTR: ["target", "rel"],
		});

		// Add copy buttons to code blocks
		const withCopyButtons = sanitized.replace(
			/<pre><code/g,
			'<pre class="has-copy"><button class="copy-button" data-copy-button>Copy</button><code',
		);

		return html`<div class="bubble" @click=${this.handleCopyClick}>
			${unsafeHTML(withCopyButtons)}
		</div>`;
	}

	render() {
		// Check if message has thinking or tools
		const hasThinking = this.thinking && this.thinking.length > 0;
		const hasTools = this.tools && this.tools.length > 0;

		return html`
			<div class="message ${this.role} ${this.compact ? "compact" : ""}">
				<div class="role-label">${this.role.toUpperCase()}</div>
				<div class="content">
					${
						hasThinking
							? html`
						<composer-thinking
							.content=${(this as any).thinking}
							.isStreaming=${false}
						></composer-thinking>
					`
							: ""
					}

					${this.renderContent()}

				${
					hasTools
						? html`
					${this.tools.map(
						(tool, index) => html`
						<composer-tool-execution
							.toolName=${tool.name}
							.toolCallId=${
								tool.id || tool.toolCallId || `${tool.name}-${index}`
							}
							.args=${tool.args || {}}
							.result=${tool.result || null}
							.isError=${tool.status === "error"}
							.isRunning=${tool.status === "running" || tool.status === "pending"}
							.compact=${this.compact}
							.reducedMotion=${this.reducedMotion}
						></composer-tool-execution>
					`,
					)}
					`
						: ""
				}

					<div class="timestamp">
						${this.formatTimestamp(this.timestamp)}
						${
							hasTools
								? html`
									<span class="tools-indicator">
										${this.tools.length} TOOL${this.tools.length > 1 ? "S" : ""}
									</span>
							  `
								: ""
						}
					</div>
				</div>
			</div>
		`;
	}
}
