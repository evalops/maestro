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
			display: flex;
			gap: 1.5rem;
			padding: 2rem 0;
			font-family: var(--font-sans);
			font-size: 0.95rem;
			line-height: 1.6;
			color: var(--text-primary);
			border-bottom: 1px solid var(--border-primary);
		}

		.message:last-child {
			border-bottom: none;
		}

		.message:hover {
			background: transparent;
		}

		.message.compact {
			padding: 1rem 0;
			font-size: 0.9rem;
			gap: 1rem;
		}

		.message.user {
			background: transparent;
		}

		.avatar-column {
			flex: 0 0 32px;
			display: flex;
			flex-direction: column;
			align-items: center;
			padding-top: 0.25rem;
		}

		.avatar {
			width: 28px;
			height: 28px;
			border-radius: 6px;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 1rem;
			background: transparent;
			color: var(--text-secondary);
		}

		.message.user .avatar {
			background: var(--bg-panel);
			color: var(--text-primary);
			border: 1px solid var(--border-primary);
		}

		.message.assistant .avatar {
			background: var(--accent-blue);
			color: white;
		}

		.content-column {
			flex: 1;
			min-width: 0;
		}

		.header {
			display: flex;
			align-items: center;
			gap: 0.75rem;
			margin-bottom: 0.5rem;
		}

		.role-name {
			font-weight: 600;
			font-size: 0.9rem;
			color: var(--text-primary);
		}

		.timestamp {
			font-size: 0.75rem;
			color: var(--text-tertiary);
		}

		.content {
			word-wrap: break-word;
			overflow-wrap: break-word;
		}

		.bubble {
			color: var(--text-primary);
		}

		.tools-indicator {
			display: inline-flex;
			align-items: center;
			margin-left: 0.75rem;
			padding: 0.15rem 0.4rem;
			background: var(--bg-panel);
			border: 1px solid var(--border-primary);
			border-radius: 4px;
			font-size: 0.7rem;
			font-weight: 600;
			color: var(--text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.content > composer-tool-execution {
			display: block;
			margin-top: 1.25rem;
		}

		/* Markdown styles - refined */
		.bubble :global(pre) {
			background: var(--bg-panel);
			padding: 1.25rem;
			border-radius: 8px;
			overflow-x: auto;
			margin: 1rem 0;
			border: 1px solid var(--border-primary);
			position: relative;
			font-family: var(--font-mono);
			font-size: 0.85rem;
		}

		.bubble :global(code) {
			font-family: var(--font-mono);
			font-size: 0.85em;
			background: rgba(113, 113, 122, 0.15); /* Zinc 500 alpha */
			padding: 0.2em 0.4em;
			border-radius: 4px;
			color: var(--accent-red); /* Highlight inline code slightly */
		}

		.bubble :global(pre code) {
			background: none;
			padding: 0;
			border: none;
			color: inherit;
			font-size: 100%;
		}

		.message.user .bubble :global(code) {
			background: rgba(255, 255, 255, 0.1);
			color: inherit;
		}

		.bubble :global(p) {
			margin: 0.75rem 0;
			line-height: 1.7;
		}

		.bubble :global(p:first-child) { margin-top: 0; }
		.bubble :global(p:last-child) { margin-bottom: 0; }

		.bubble :global(h1),
		.bubble :global(h2),
		.bubble :global(h3) {
			margin: 1.5rem 0 1rem 0;
			font-weight: 700;
			line-height: 1.3;
			color: var(--text-primary);
		}

		.bubble :global(h1) { font-size: 1.5rem; letter-spacing: -0.02em; }
		.bubble :global(h2) { font-size: 1.25rem; letter-spacing: -0.01em; }
		.bubble :global(h3) { font-size: 1.1rem; }

		.bubble :global(ul),
		.bubble :global(ol) {
			margin: 0.75rem 0;
			padding-left: 1.5rem;
		}

		.bubble :global(li) {
			margin: 0.25rem 0;
		}

		.bubble :global(blockquote) {
			border-left: 3px solid var(--accent-blue);
			padding-left: 1rem;
			margin: 1rem 0;
			color: var(--text-secondary);
			font-style: italic;
			background: linear-gradient(to right, var(--bg-panel), transparent);
			padding: 0.75rem 1rem;
			border-radius: 0 6px 6px 0;
		}

		.bubble :global(a) {
			color: var(--accent-blue);
			text-decoration: none;
			font-weight: 500;
		}

		.bubble :global(a:hover) {
			text-decoration: underline;
		}

		.bubble :global(table) {
			border-collapse: separate;
			border-spacing: 0;
			width: 100%;
			margin: 1.5rem 0;
			border-radius: 8px;
			border: 1px solid var(--border-primary);
			overflow: hidden;
		}

		.bubble :global(th),
		.bubble :global(td) {
			padding: 0.75rem 1rem;
			border-bottom: 1px solid var(--border-primary);
			text-align: left;
		}

		.bubble :global(th) {
			background: var(--bg-panel);
			font-weight: 600;
			font-size: 0.85rem;
			color: var(--text-secondary);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.bubble :global(tr:last-child td) {
			border-bottom: none;
		}

		.copy-button {
			position: absolute;
			top: 0.75rem;
			right: 0.75rem;
			padding: 0.4rem 0.8rem;
			background: var(--bg-secondary);
			border: 1px solid var(--border-primary);
			border-radius: 6px;
			color: var(--text-secondary);
			font-size: 0.75rem;
			font-weight: 500;
			cursor: pointer;
			opacity: 0;
			transition: all 0.2s;
			font-family: var(--font-sans);
		}

		.bubble :global(pre:hover) .copy-button {
			opacity: 1;
		}

		.copy-button:hover {
			background: var(--bg-panel);
			color: var(--accent-blue);
			border-color: var(--accent-blue);
		}

		.copy-button.copied {
			color: var(--accent-green);
			border-color: var(--accent-green);
		}

		@media (max-width: 768px) {
			.message { padding: 1rem; gap: 0.75rem; }
			.avatar-column { flex: 0 0 28px; }
			.avatar { width: 28px; height: 28px; font-size: 0.8rem; }
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
				<div class="avatar-column">
					<div class="avatar">
						${this.getAvatar()}
					</div>
				</div>

				<div class="content-column">
					<div class="header">
						<span class="role-name">${this.role === "user" ? "You" : "Composer"}</span>
						<span class="timestamp">
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
						</span>
					</div>

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
					</div>
				</div>
			</div>
		`;
	}
}
