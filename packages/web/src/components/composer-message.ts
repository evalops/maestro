/**
 * Message display component
 */

import type { ComposerContentBlock } from "@evalops/contracts";
import DOMPurify from "dompurify";
import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import "./composer-sandboxed-iframe.js";

type CleanMode = "off" | "soft" | "aggressive";

type HljsApi = {
	getLanguage: (name: string) => unknown;
	highlight: (code: string, options: { language: string }) => { value: string };
	highlightAuto: (code: string) => { value: string };
};

let cachedHljs: HljsApi | undefined;
let hljsLoadPromise: Promise<HljsApi> | undefined;
const hljsLoadListeners = new Set<() => void>();

const NO_PROVIDERS: unknown[] = [];

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node instanceof HTMLAnchorElement && node.target === "_blank") {
		node.setAttribute("rel", "noopener noreferrer");
	}
});

function escapeHtml(input: string): string {
	return input
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function contentToPlainText(content: string | ComposerContentBlock[]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function cleanStreamingText(value: string, mode: CleanMode): string {
	if (mode === "off") return value;
	const windowSize = mode === "aggressive" ? 120 : 40;
	const lines = value.split("\n");
	const history = new Set<string>();
	const historyOrder: string[] = [];
	const out: string[] = [];

	for (const line of lines) {
		const normalized = line.trim();
		if (!normalized) {
			out.push(line);
			continue;
		}
		if (history.has(normalized)) {
			continue;
		}
		out.push(line);
		history.add(normalized);
		historyOrder.push(normalized);
		if (historyOrder.length > windowSize) {
			const removed = historyOrder.shift();
			if (removed) {
				history.delete(removed);
			}
		}
	}

	return out.join("\n");
}

function ensureHljsLoaded(): void {
	if (cachedHljs || hljsLoadPromise) return;

	hljsLoadPromise = (async () => {
		const mod = await import("highlight.js");
		return (mod.default ?? mod) as HljsApi;
	})();

	void hljsLoadPromise
		.then((hljs) => {
			cachedHljs = hljs;
			for (const listener of hljsLoadListeners) listener();
		})
		.catch(() => {
			// Best-effort: if highlighting fails to load, render without it.
		});
}

function randomId(prefix: string): string {
	const cryptoObj = globalThis.crypto;
	if (cryptoObj && "randomUUID" in cryptoObj) {
		try {
			return `${prefix}${(cryptoObj as Crypto).randomUUID()}`;
		} catch {
			// ignore
		}
	}
	return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// Configure marked with code highlighting using custom renderer
// Note: highlight option is deprecated in marked v5+, so we use a custom renderer
marked.use({
	async: false,
	gfm: true,
	renderer: {
		code(token) {
			const lang = token.lang || "";
			const code = token.text;
			const langClass = lang ? ` class="language-${lang}"` : "";

			const hljs = cachedHljs;
			if (!hljs) {
				ensureHljsLoaded();
				return `<pre><code${langClass}>${escapeHtml(code)}</code></pre>`;
			}

			let highlighted: string;
			if (lang) {
				try {
					if (hljs.getLanguage(lang)) {
						highlighted = hljs.highlight(code, { language: lang }).value;
					} else {
						highlighted = hljs.highlightAuto(code).value;
					}
				} catch {
					highlighted = hljs.highlightAuto(code).value;
				}
			} else {
				highlighted = hljs.highlightAuto(code).value;
			}

			return `<pre><code${langClass}>${highlighted}</code></pre>`;
		},
	},
});

@customElement("composer-message")
export class ComposerMessage extends LitElement {
	static override styles = css`
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
			content-visibility: auto;
			contain-intrinsic-size: 1px 220px;
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

		/* Artifact previews */
		.artifacts {
			margin-top: 1rem;
			display: flex;
			flex-direction: column;
			gap: 0.75rem;
		}

		.artifact-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem;
		}

		.artifact-title {
			font-size: 0.65rem;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--text-tertiary, #5c5e62);
			font-weight: 600;
		}

		.artifact-toggle {
			padding: 0.25rem 0.5rem;
			background: transparent;
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-secondary, #8b8d91);
			cursor: pointer;
			font-family: var(--font-mono, monospace);
			font-size: 0.65rem;
			transition: all 0.15s ease;
		}

		.artifact-toggle:hover {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
			border-color: var(--border-hover, #3a3d42);
		}

		.artifact-frame {
			height: 320px;
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

		.attachments {
			margin-top: 0.75rem;
			display: flex;
			flex-wrap: wrap;
			gap: 0.5rem;
		}

		.attachment {
			width: 56px;
			height: 56px;
			border: 1px solid var(--border-primary, #1e2023);
			background: var(--bg-elevated, #161719);
			display: inline-flex;
			align-items: center;
			justify-content: center;
			overflow: hidden;
			cursor: pointer;
			color: var(--text-tertiary, #5c5e62);
			font-family: var(--font-mono, monospace);
			font-size: 0.6rem;
			position: relative;
		}

		.attachment img {
			width: 100%;
			height: 100%;
			object-fit: cover;
			display: block;
		}

		@media (max-width: 768px) {
			.message { padding: 1rem 0; gap: 0.75rem; }
			.avatar-column { flex: 0 0 24px; }
			.avatar { width: 20px; height: 20px; font-size: 0.6rem; }
		}
	`;

	@property() override role: "user" | "assistant" | "system" = "user";
	@property({ attribute: false }) content: string | ComposerContentBlock[] = "";
	@property() timestamp = "";
	@property() thinking = "";
	@property({ type: String }) cleanMode: CleanMode = "off";
	@property({ type: Boolean }) streaming = false;
	@property() tools: Array<{
		id?: string;
		toolCallId?: string;
		name: string;
		status: string;
		args?: Record<string, unknown>;
		argsTruncated?: boolean;
		result?: unknown;
	}> = [];
	@property({ attribute: false })
	attachments: Array<{
		id: string;
		type: "image" | "document";
		fileName: string;
		mimeType: string;
		size: number;
		content?: string;
		preview?: string;
		extractedText?: string;
	}> = [];
	@property({ type: Boolean }) compact = false;
	@property({ type: Boolean, reflect: true, attribute: "reduced-motion" })
	reducedMotion = false;

	@state() private previewOpen: Record<number, boolean> = {};
	private readonly instanceId = randomId("msg_");
	private readonly onHljsLoaded = () => this.requestUpdate();

	override connectedCallback(): void {
		super.connectedCallback();
		hljsLoadListeners.add(this.onHljsLoaded);
	}

	override disconnectedCallback(): void {
		hljsLoadListeners.delete(this.onHljsLoaded);
		super.disconnectedCallback();
	}

	private extractHtmlArtifacts(): Array<{ language: string; code: string }> {
		// Simple fenced-code extraction. This is intentionally conservative:
		// we only treat explicit ```html / ```svg blocks as previewable artifacts.
		const artifacts: Array<{ language: string; code: string }> = [];
		const source = contentToPlainText(this.content);
		const pattern = /```(html|svg)\s*\n([\s\S]*?)```/gi;
		for (;;) {
			const match = pattern.exec(source);
			if (!match) break;
			const language = (match[1] || "").toLowerCase();
			const code = match[2] ?? "";
			if (code.trim().length === 0) continue;
			artifacts.push({ language, code });
		}
		return artifacts;
	}

	private togglePreview(index: number) {
		const current = Boolean(this.previewOpen[index]);
		this.previewOpen = { ...this.previewOpen, [index]: !current };
	}

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

	private openAttachment(att: (typeof this.attachments)[number]) {
		this.dispatchEvent(
			new CustomEvent("open-attachment", {
				bubbles: true,
				composed: true,
				detail: { attachment: att },
			}),
		);
	}

	private renderAttachments() {
		const attachments = Array.isArray(this.attachments) ? this.attachments : [];
		if (this.role !== "user" || attachments.length === 0) return null;

		return html`<div class="attachments">
			${attachments.map((a) => {
				const isImage = a.type === "image";
				const preview = a.preview || a.content || "";
				return html`<div
					class="attachment"
					title=${a.fileName}
					@click=${() => this.openAttachment(a)}
				>
					${
						isImage && preview
							? html`<img alt=${a.fileName} src=${`data:${a.mimeType};base64,${preview}`} />`
							: html`<span>${(a.fileName || "?").slice(0, 2).toUpperCase()}</span>`
					}
				</div>`;
			})}
		</div>`;
	}

	private renderContent() {
		const rawText = contentToPlainText(this.content);
		const textContent =
			this.streaming && this.cleanMode !== "off"
				? cleanStreamingText(rawText, this.cleanMode)
				: rawText;
		if (this.role === "user") {
			// User messages are plain text with basic formatting
			const escaped = textContent
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/\n/g, "<br>");
			return html`<div class="bubble">${unsafeHTML(escaped)}</div>`;
		}

		// Assistant messages support full markdown
		const rendered = marked.parse(textContent, { async: false }) as string;
		const sanitized = DOMPurify.sanitize(rendered, {
			ADD_ATTR: ["target", "rel"],
		});

		// Add copy buttons to code blocks
		const withCopyButtons = sanitized.replace(
			/<pre><code/g,
			'<pre class="has-copy"><button class="copy-button" data-copy-button>Copy</button><code',
		);

		const artifacts =
			this.role === "assistant" ? this.extractHtmlArtifacts() : [];

		return html`
			<div class="bubble" @click=${this.handleCopyClick}>
				${unsafeHTML(withCopyButtons)}
			</div>
			${
				artifacts.length > 0
					? html`<div class="artifacts">
						${artifacts.map((artifact, i) => {
							const open = Boolean(this.previewOpen[i]);
							const title =
								artifact.language === "svg" ? "SVG preview" : "HTML preview";
							const htmlContent = (() => {
								if (artifact.language !== "svg") {
									return artifact.code;
								}
								// If the fenced block already contains an <svg> root, use as-is.
								if (/<svg[\s>]/i.test(artifact.code)) {
									return artifact.code;
								}
								return `<svg xmlns="http://www.w3.org/2000/svg">${artifact.code}</svg>`;
							})();
							return html`
								<div>
									<div class="artifact-header">
										<div class="artifact-title">${title}</div>
										<button class="artifact-toggle" @click=${() => this.togglePreview(i)}>
											${open ? "Hide" : "Preview"}
										</button>
									</div>
									${
										open
											? html`<composer-sandboxed-iframe
													class="artifact-frame"
													.sandboxId=${`msg-${this.instanceId}-${i}`}
													.htmlContent=${htmlContent}
													.providers=${NO_PROVIDERS}
												></composer-sandboxed-iframe>`
											: null
									}
								</div>
							`;
						})}
					</div>`
					: null
			}
		`;
	}

	override render() {
		const thinkingText =
			this.streaming && this.cleanMode !== "off"
				? cleanStreamingText(this.thinking, this.cleanMode)
				: this.thinking;
		const hasThinking = thinkingText && thinkingText.length > 0;
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
						<span class="role-name">${this.role === "user" ? "You" : "Maestro"}</span>
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
								.content=${thinkingText}
								.isStreaming=${this.streaming}
							></composer-thinking>
						`
								: ""
						}

						${this.renderContent()}
						${this.renderAttachments()}

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
									.argsTruncated=${Boolean(tool.argsTruncated)}
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
