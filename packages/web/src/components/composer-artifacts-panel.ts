type HljsModule = typeof import("highlight.js");
import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { Artifact } from "../services/artifacts.js";
import { ArtifactsRuntimeProvider } from "./sandbox/artifacts-runtime-provider.js";
import { AttachmentsRuntimeProvider } from "./sandbox/attachments-runtime-provider.js";
import "./composer-sandboxed-iframe.js";
import type { ComposerAttachment } from "@evalops/contracts";

let cachedHljs: HljsModule | null = null;

async function loadHljs(): Promise<HljsModule> {
	if (!cachedHljs) {
		cachedHljs = await import("highlight.js");
	}
	return cachedHljs;
}

function languageFromFilename(filename: string): string {
	const ext = filename.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "ts":
		case "tsx":
			return "typescript";
		case "js":
		case "jsx":
			return "javascript";
		case "json":
			return "json";
		case "md":
		case "markdown":
			return "markdown";
		case "css":
			return "css";
		case "html":
			return "html";
		case "svg":
			return "xml";
		default:
			return "text";
	}
}

@customElement("composer-artifacts-panel")
export class ComposerArtifactsPanel extends LitElement {
	static styles = css`
		:host {
			position: absolute;
			top: 48px;
			right: 0;
			bottom: 0;
			width: 520px;
			max-width: min(520px, 100vw);
			background: var(--bg-deep, #08090a);
			border-left: 1px solid var(--border-primary, #1e2023);
			display: flex;
			flex-direction: column;
			z-index: 30;
		}

		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem;
			padding: 0.75rem 0.75rem;
			border-bottom: 1px solid var(--border-primary, #1e2023);
		}

		.title {
			font-family: var(--font-mono, monospace);
			font-size: 0.65rem;
			font-weight: 700;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--text-tertiary, #5c5e62);
		}

		.close {
			border: 1px solid var(--border-primary, #1e2023);
			background: transparent;
			color: var(--text-tertiary, #5c5e62);
			width: 28px;
			height: 28px;
			cursor: pointer;
		}

		.close:hover {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
		}

		.tabs {
			display: flex;
			gap: 0.25rem;
			padding: 0.5rem;
			overflow-x: auto;
			border-bottom: 1px solid var(--border-primary, #1e2023);
		}

		.tab {
			border: 1px solid var(--border-primary, #1e2023);
			background: transparent;
			color: var(--text-tertiary, #5c5e62);
			font-family: var(--font-mono, monospace);
			font-size: 0.7rem;
			padding: 0.25rem 0.5rem;
			cursor: pointer;
			white-space: nowrap;
		}

		.tab.active {
			border-color: var(--accent-amber, #d4a012);
			color: var(--accent-amber, #d4a012);
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
		}

		.empty {
			padding: 0.75rem;
			color: var(--text-tertiary, #5c5e62);
			font-family: var(--font-mono, monospace);
			font-size: 0.75rem;
		}

		.body {
			flex: 1;
			min-height: 0;
			overflow: auto;
			padding: 0.75rem;
		}

		pre {
			margin: 0;
			background: #0d1117;
			border: 1px solid #30363d;
			border-radius: 6px;
			padding: 0.75rem;
			overflow: auto;
			font-size: 0.75rem;
			line-height: 1.3;
		}
	`;

	@property({ attribute: false }) artifacts: Artifact[] = [];
	@property() activeFilename: string | null = null;
	@property() sessionId: string | null = null;
	@property() apiBaseUrl = "";
	@property({ attribute: false }) attachments: ComposerAttachment[] = [];

	@state() private highlightedForKey: string | null = null;
	@state() private highlightedHtml: string | null = null;
	@state() private highlightError: string | null = null;

	private buildRuntimeProviders() {
		const providers = [new ArtifactsRuntimeProvider(() => this.artifacts)];
		const attachments = Array.isArray(this.attachments) ? this.attachments : [];
		const withContent = attachments.filter(
			(a) => typeof a.content === "string" && a.content.length > 0,
		);
		if (withContent.length > 0) {
			providers.push(
				new AttachmentsRuntimeProvider(
					withContent.map((a) => ({
						id: a.id,
						fileName: a.fileName,
						mimeType: a.mimeType,
						size: a.size,
						content: a.content as string,
						extractedText: a.extractedText,
					})),
				),
			);
		}
		return providers;
	}

	private closePanel() {
		this.dispatchEvent(
			new CustomEvent("close", { bubbles: true, composed: true }),
		);
	}

	private select(filename: string) {
		this.dispatchEvent(
			new CustomEvent("select-artifact", {
				bubbles: true,
				composed: true,
				detail: { filename },
			}),
		);
	}

	private openInNewTab(filename: string) {
		if (!this.sessionId || !this.apiBaseUrl) return;
		const url = `${this.apiBaseUrl}/api/sessions/${encodeURIComponent(
			this.sessionId,
		)}/artifacts/${encodeURIComponent(filename)}/view`;
		window.open(url, "_blank", "noopener,noreferrer");
	}

	private downloadZip() {
		if (!this.sessionId || !this.apiBaseUrl) return;
		const url = `${this.apiBaseUrl}/api/sessions/${encodeURIComponent(
			this.sessionId,
		)}/artifacts.zip`;
		const a = document.createElement("a");
		a.href = url;
		a.rel = "noopener";
		a.target = "_blank";
		a.click();
	}

	private downloadArtifact(filename: string, opts?: { standalone?: boolean }) {
		if (!this.sessionId || !this.apiBaseUrl) return;
		const params = new URLSearchParams();
		params.set("download", "1");
		if (opts?.standalone) params.set("standalone", "1");
		else params.set("raw", "1");
		const url = `${this.apiBaseUrl}/api/sessions/${encodeURIComponent(
			this.sessionId,
		)}/artifacts/${encodeURIComponent(filename)}?${params.toString()}`;
		const a = document.createElement("a");
		a.href = url;
		a.rel = "noopener";
		a.target = "_blank";
		a.click();
	}

	private async highlightIfNeeded(active: Artifact) {
		if (active.filename.toLowerCase().endsWith(".html")) return;
		const key = `${active.filename}:${active.content.length}`;
		if (this.highlightedForKey === key && this.highlightedHtml) return;

		this.highlightedForKey = key;
		this.highlightedHtml = null;
		this.highlightError = null;

		try {
			const mod = await loadHljs();
			const moduleWithDefault = mod as { default?: unknown };
			const hljs = moduleWithDefault.default ?? mod;
			const lang = languageFromFilename(active.filename);
			const highlighted = (
				hljs as {
					highlight: (
						code: string,
						opts: { language: string },
					) => { value: string };
				}
			).highlight(active.content, { language: lang }).value;

			if (this.highlightedForKey !== key) return;
			this.highlightedHtml = highlighted;
		} catch (e) {
			this.highlightError =
				e instanceof Error ? e.message : "Failed to highlight";
		}
	}

	render() {
		const artifacts = Array.isArray(this.artifacts) ? this.artifacts : [];
		const active =
			(this.activeFilename &&
				artifacts.find((a) => a.filename === this.activeFilename)) ||
			(artifacts.length > 0 ? artifacts[0] : null);

		return html`
			<div class="header">
				<div class="title">Artifacts</div>
				<div style="display:flex; align-items:center; gap:0.5rem;">
					${
						active && this.sessionId && this.apiBaseUrl
							? html`<button
									class="close"
									@click=${() => this.openInNewTab(active.filename)}
									title="Open in new tab"
								>↗</button>`
							: ""
					}
					${
						active && this.sessionId && this.apiBaseUrl
							? active.filename.toLowerCase().endsWith(".html")
								? html`<button
										class="close"
										@click=${() =>
											this.downloadArtifact(active.filename, {
												standalone: true,
											})}
										title="Download standalone HTML"
									>DL</button>`
								: html`<button
										class="close"
										@click=${() => this.downloadArtifact(active.filename)}
										title="Download file"
									>DL</button>`
							: ""
					}
					${
						this.sessionId && this.apiBaseUrl
							? html`<button
									class="close"
									@click=${this.downloadZip}
									title="Download artifacts zip"
								>ZIP</button>`
							: ""
					}
					<button class="close" @click=${this.closePanel} title="Close">✕</button>
				</div>
			</div>

			${
				artifacts.length === 0
					? html`<div class="empty">No artifacts yet.</div>`
					: html`
						<div class="tabs">
							${artifacts.map(
								(a) => html`
									<button
										class="tab ${active?.filename === a.filename ? "active" : ""}"
										@click=${() => this.select(a.filename)}
										title=${a.filename}
									>
										${a.filename}
									</button>
								`,
							)}
						</div>
					`
			}

			<div class="body">
				${
					active
						? active.filename.toLowerCase().endsWith(".html")
							? html`<composer-sandboxed-iframe
								.sandboxId=${`artifact:${active.filename}`}
								.htmlContent=${active.content}
								.providers=${this.buildRuntimeProviders()}
						  ></composer-sandboxed-iframe>`
							: this.highlightedHtml
								? html`<pre><code class="hljs language-${languageFromFilename(active.filename)}">${unsafeHTML(
										this.highlightedHtml,
									)}</code></pre>`
								: html`<pre><code class="hljs language-${languageFromFilename(active.filename)}">${active.content}</code></pre>`
						: ""
				}
				${this.highlightError ? html`<div class="empty">${this.highlightError}</div>` : ""}
			</div>
		`;
	}

	override updated(changed: Map<string, unknown>): void {
		super.updated(changed);
		if (!changed.has("artifacts") && !changed.has("activeFilename")) return;

		const artifacts = Array.isArray(this.artifacts) ? this.artifacts : [];
		const active =
			(this.activeFilename &&
				artifacts.find((a) => a.filename === this.activeFilename)) ||
			(artifacts.length > 0 ? artifacts[0] : null);
		if (!active) return;

		void this.highlightIfNeeded(active);
	}
}
