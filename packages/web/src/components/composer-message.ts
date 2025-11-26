/**
 * Message display component
 */

import hljs from "highlight.js";
import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";

// Configure marked
marked.setOptions({
	highlight: (code, lang) => {
		if (lang && hljs.getLanguage(lang)) {
			try {
				return hljs.highlight(code, { language: lang }).value;
			} catch (e) {
				console.error("Highlight error:", e);
			}
		}
		return hljs.highlightAuto(code).value;
	},
});

@customElement("composer-message")
export class ComposerMessage extends LitElement {
	static styles = css`
		:host {
			display: block;
		}

		.message {
			display: flex;
			gap: 0.75rem;
		}

		.message.user {
			justify-content: flex-end;
		}

		.avatar {
			width: 32px;
			height: 32px;
			border-radius: 50%;
			display: flex;
			align-items: center;
			justify-content: center;
			font-weight: 600;
			flex-shrink: 0;
			font-size: 0.875rem;
		}

		.message.user .avatar {
			background: var(--accent-color, #0e639c);
			color: white;
			order: 2;
		}

		.message.assistant .avatar {
			background: var(--bg-secondary, #252526);
			color: var(--text-primary, #d4d4d4);
			border: 1px solid var(--border-color, #3e3e42);
		}

		.content {
			flex: 1;
			max-width: 70%;
		}

		.message.user .content {
			order: 1;
		}

		.bubble {
			padding: 0.75rem 1rem;
			border-radius: 8px;
			word-wrap: break-word;
			overflow-wrap: break-word;
		}

		.message.user .bubble {
			background: var(--accent-color, #0e639c);
			color: white;
		}

		.message.assistant .bubble {
			background: var(--bg-secondary, #252526);
			border: 1px solid var(--border-color, #3e3e42);
		}

		.timestamp {
			font-size: 0.75rem;
			color: var(--text-secondary, #969696);
			margin-top: 0.25rem;
		}

		.message.user .timestamp {
			text-align: right;
		}

		/* Markdown styles */
		.bubble :global(pre) {
			background: var(--bg-primary, #1e1e1e);
			padding: 1rem;
			border-radius: 4px;
			overflow-x: auto;
			margin: 0.5rem 0;
		}

		.bubble :global(code) {
			font-family: "Consolas", "Monaco", "Courier New", monospace;
			font-size: 0.875rem;
		}

		.bubble :global(p) {
			margin: 0.5rem 0;
		}

		.bubble :global(p:first-child) {
			margin-top: 0;
		}

		.bubble :global(p:last-child) {
			margin-bottom: 0;
		}

		.bubble :global(ul), .bubble :global(ol) {
			margin: 0.5rem 0;
			padding-left: 1.5rem;
		}

		.bubble :global(li) {
			margin: 0.25rem 0;
		}

		.bubble :global(blockquote) {
			border-left: 3px solid var(--border-color, #3e3e42);
			padding-left: 1rem;
			margin: 0.5rem 0;
			color: var(--text-secondary, #969696);
		}

		.bubble :global(a) {
			color: var(--accent-color, #0e639c);
			text-decoration: none;
		}

		.bubble :global(a:hover) {
			text-decoration: underline;
		}
	`;

	@property() role: "user" | "assistant" | "system" = "user";
	@property() content = "";
	@property() timestamp = "";

	private formatTimestamp(ts: string): string {
		if (!ts) return "";
		const date = new Date(ts);
		return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}

	private getAvatar(): string {
		return this.role === "user" ? "U" : "A";
	}

	private renderContent() {
		if (this.role === "user") {
			// User messages are plain text
			return html`<div class="bubble">${this.content}</div>`;
		}
		// Assistant messages support markdown
		const rendered = marked.parse(this.content, { async: false }) as string;
		return html`<div class="bubble">${unsafeHTML(rendered)}</div>`;
	}

	render() {
		return html`
			<div class="message ${this.role}">
				<div class="avatar">${this.getAvatar()}</div>
				<div class="content">
					${this.renderContent()}
					${
						this.timestamp
							? html`<div class="timestamp">${this.formatTimestamp(this.timestamp)}</div>`
							: ""
					}
				</div>
			</div>
		`;
	}
}
