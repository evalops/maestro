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
} as Parameters<typeof marked.use>[0]); // Type assertion needed for marked options compatibility

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
			gap: 1.25rem;
			padding: 1.5rem 0;
			font-family: var(--font-mono, "JetBrains Mono", monospace);
			font-size: 0.85rem;
			line-height: 1.7;
			color: var(--text-primary, #e8e9eb);
			border-bottom: 1px solid var(--border-subtle, #141517);
		}

		.message:last-child {
			border-bottom: none;
		}

		.message:hover {
			background: transparent;
		}

		.message.compact {
			padding: 1rem 0;
			font-size: 0.8rem;
			gap: 1rem;
		}

		.message.user {
			background: transparent;
		}

		.avatar-column {
			flex: 0 0 28px;
			display: flex;
			flex-direction: column;
			align-items: center;
			padding-top: 0.125rem;
		}

		.avatar {
			width: 24px;
			height: 24px;
			display: flex;
			align-items: center;
			justify-content: center;
			font-size: 0.7rem;
			font-weight: 600;
			font-family: var(--font-mono, monospace);
			color: var(--text-tertiary, #5c5e62);
		}

		.message.user .avatar {
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-secondary, #8b8d91);
		}

		.message.assistant .avatar {
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			border: 1px solid transparent;
			color: var(--accent-amber, #d4a012);
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
			font-size: 0.7rem;
			color: var(--text-secondary, #8b8d91);
			text-transform: uppercase;
			letter-spacing: 0.08em;
		}

		.message.assistant .role-name {
			color: var(--accent-amber, #d4a012);
		}

		.timestamp {
			font-size: 0.65rem;
			color: var(--text-tertiary, #5c5e62);
			font-family: var(--font-mono, monospace);
		}

		.content {
			word-wrap: break-word;
			overflow-wrap: break-word;
		}

		.bubble {
			color: var(--text-primary, #e8e9eb);
		}

		.tools-indicator {
			display: inline-flex;
			align-items: center;
			margin-left: 0.5rem;
			padding: 0.1rem 0.35rem;
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			font-size: 0.6rem;
			font-weight: 600;
			color: var(--accent-amber, #d4a012);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.content > composer-tool-execution {
			display: block;
			margin-top: 1rem;
		}

		/* Markdown styles - Control Room */
		.bubble :global(pre) {
			background: var(--bg-deep, #08090a);
			padding: 1rem;
			overflow-x: auto;
			margin: 1rem 0;
			border: 1px solid var(--border-primary, #1e2023);
			border-left: 2px solid var(--accent-amber, #d4a012);
			position: relative;
			font-family: var(--font-mono, monospace);
			font-size: 0.8rem;
		}

		.bubble :global(code) {
			font-family: var(--font-mono, monospace);
			font-size: 0.85em;
			background: var(--bg-elevated, #161719);
			padding: 0.15em 0.35em;
			color: var(--accent-amber, #d4a012);
		}

		.bubble :global(pre code) {
			background: none;
			padding: 0;
			border: none;
			color: inherit;
			font-size: 100%;
		}

		.message.user .bubble :global(code) {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
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
			margin: 1.5rem 0 0.75rem 0;
			font-weight: 600;
			line-height: 1.3;
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-display, "DM Sans", sans-serif);
		}

		.bubble :global(h1) { font-size: 1.25rem; letter-spacing: -0.01em; }
		.bubble :global(h2) { font-size: 1.1rem; }
		.bubble :global(h3) { font-size: 1rem; }

		.bubble :global(ul),
		.bubble :global(ol) {
			margin: 0.75rem 0;
			padding-left: 1.25rem;
		}

		.bubble :global(li) {
			margin: 0.35rem 0;
		}

		.bubble :global(li::marker) {
			color: var(--text-tertiary, #5c5e62);
		}

		.bubble :global(blockquote) {
			border-left: 2px solid var(--accent-amber, #d4a012);
			padding: 0.75rem 1rem;
			margin: 1rem 0;
			color: var(--text-secondary, #8b8d91);
			font-style: normal;
			background: var(--bg-elevated, #161719);
		}

		.bubble :global(a) {
			color: var(--accent-amber, #d4a012);
			text-decoration: none;
		}

		.bubble :global(a:hover) {
			text-decoration: underline;
		}

		.bubble :global(table) {
			border-collapse: collapse;
			width: 100%;
			margin: 1.25rem 0;
			border: 1px solid var(--border-primary, #1e2023);
			font-size: 0.8rem;
		}

		.bubble :global(th),
		.bubble :global(td) {
			padding: 0.5rem 0.75rem;
			border: 1px solid var(--border-primary, #1e2023);
			text-align: left;
		}

		.bubble :global(th) {
			background: var(--bg-elevated, #161719);
			font-weight: 600;
			font-size: 0.7rem;
			color: var(--text-secondary, #8b8d91);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.bubble :global(tr:nth-child(even)) {
			background: var(--bg-deep, #08090a);
		}

		.copy-button {
			position: absolute;
			top: 0.5rem;
			right: 0.5rem;
			padding: 0.25rem 0.5rem;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-tertiary, #5c5e62);
			font-size: 0.6rem;
			font-weight: 600;
			font-family: var(--font-mono, monospace);
			cursor: pointer;
			opacity: 0;
			transition: all 0.15s ease;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.bubble :global(pre:hover) .copy-button {
			opacity: 1;
		}

		.copy-button:hover {
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			color: var(--accent-amber, #d4a012);
			border-color: var(--accent-amber, #d4a012);
		}

		.copy-button.copied {
			color: var(--accent-green, #22c55e);
			border-color: var(--accent-green, #22c55e);
			background: var(--accent-green-dim, rgba(34, 197, 94, 0.12));
		}

		@media (max-width: 768px) {
			.message { padding: 1rem 0; gap: 0.75rem; }
			.avatar-column { flex: 0 0 24px; }
			.avatar { width: 20px; height: 20px; font-size: 0.6rem; }
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
		args?: Record<string, unknown>;
		result?: unknown;
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
		return this.role === "user" ? "U" : "C";
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
								.content=${this.thinking}
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
