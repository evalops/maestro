type HljsModule = typeof import("highlight.js");
import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { ApiClient } from "../services/api-client.js";
import type { Artifact } from "../services/artifacts.js";
import { ArtifactsRuntimeProvider } from "./sandbox/artifacts-runtime-provider.js";
import { AttachmentsRuntimeProvider } from "./sandbox/attachments-runtime-provider.js";
import type { SandboxRuntimeProvider } from "./sandbox/sandbox-runtime-provider.js";
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
	static override styles = css`
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
	@property({ attribute: false }) apiClient: ApiClient | null = null;
	@property({ attribute: false }) attachments: ComposerAttachment[] = [];

	@state() private highlightedForKey: string | null = null;
	@state() private highlightedHtml: string | null = null;
	@state() private highlightError: string | null = null;
	@state() private resolvedViewUrl: string | null = null;
	@state() private resolvedDownloadUrl: string | null = null;
	@state() private resolvedZipUrl: string | null = null;

	private artifactUrlRequestKey: string | null = null;
	private zipUrlRequestKey: string | null = null;

	private revokeObjectUrl(url: string | null) {
		if (!url?.startsWith("blob:")) return;
		if (typeof URL.revokeObjectURL !== "function") return;
		URL.revokeObjectURL(url);
	}

	private replaceResolvedViewUrl(url: string | null) {
		if (this.resolvedViewUrl && this.resolvedViewUrl !== url) {
			this.revokeObjectUrl(this.resolvedViewUrl);
		}
		this.resolvedViewUrl = url;
	}

	private replaceResolvedDownloadUrl(url: string | null) {
		if (this.resolvedDownloadUrl && this.resolvedDownloadUrl !== url) {
			this.revokeObjectUrl(this.resolvedDownloadUrl);
		}
		this.resolvedDownloadUrl = url;
	}

	private replaceResolvedZipUrl(url: string | null) {
		if (this.resolvedZipUrl && this.resolvedZipUrl !== url) {
			this.revokeObjectUrl(this.resolvedZipUrl);
		}
		this.resolvedZipUrl = url;
	}

	private buildRuntimeProviders(): SandboxRuntimeProvider[] {
		const providers: SandboxRuntimeProvider[] = [
			new ArtifactsRuntimeProvider(() => this.artifacts),
		];
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

	private getResolvedApiBaseUrl(): string {
		return this.apiBaseUrl || this.apiClient?.baseUrl || "";
	}

	private canResolveArtifactLinks(): boolean {
		return Boolean(this.sessionId && this.getResolvedApiBaseUrl());
	}

	private buildDirectArtifactViewUrl(filename: string): string | null {
		const apiBaseUrl = this.getResolvedApiBaseUrl();
		if (!this.sessionId || !apiBaseUrl) return null;
		return `${apiBaseUrl}/api/sessions/${encodeURIComponent(
			this.sessionId,
		)}/artifacts/${encodeURIComponent(filename)}/view`;
	}

	private buildDirectArtifactDownloadUrl(
		filename: string,
		options?: { standalone?: boolean },
	): string | null {
		const apiBaseUrl = this.getResolvedApiBaseUrl();
		if (!this.sessionId || !apiBaseUrl) return null;
		const params = new URLSearchParams();
		params.set("download", "1");
		if (options?.standalone) params.set("standalone", "1");
		else params.set("raw", "1");
		return `${apiBaseUrl}/api/sessions/${encodeURIComponent(
			this.sessionId,
		)}/artifacts/${encodeURIComponent(filename)}?${params.toString()}`;
	}

	private buildDirectArtifactsZipUrl(): string | null {
		const apiBaseUrl = this.getResolvedApiBaseUrl();
		if (!this.sessionId || !apiBaseUrl) return null;
		return `${apiBaseUrl}/api/sessions/${encodeURIComponent(
			this.sessionId,
		)}/artifacts.zip`;
	}

	private async resolveArtifactViewUrl(
		filename: string,
	): Promise<string | null> {
		if (!this.sessionId) return null;
		if (this.apiClient) {
			return await this.apiClient.resolveSessionArtifactViewUrl(
				this.sessionId,
				filename,
			);
		}
		return this.buildDirectArtifactViewUrl(filename);
	}

	private async resolveArtifactDownloadUrl(
		filename: string,
		options?: { standalone?: boolean },
	): Promise<string | null> {
		if (!this.sessionId) return null;
		if (this.apiClient) {
			return await this.apiClient.resolveSessionArtifactDownloadUrl(
				this.sessionId,
				filename,
				options,
			);
		}
		return this.buildDirectArtifactDownloadUrl(filename, options);
	}

	private async resolveArtifactsZipUrl(): Promise<string | null> {
		if (!this.sessionId) return null;
		if (this.apiClient) {
			return await this.apiClient.resolveSessionArtifactsZipUrl(this.sessionId);
		}
		return this.buildDirectArtifactsZipUrl();
	}

	private async preloadArtifactLinks(active: Artifact | null) {
		if (!active || !this.canResolveArtifactLinks()) {
			this.artifactUrlRequestKey = null;
			this.replaceResolvedViewUrl(null);
			this.replaceResolvedDownloadUrl(null);
			return;
		}

		const requestKey = `${this.sessionId}:${active.filename}:${this.apiBaseUrl}:${active.filename
			.toLowerCase()
			.endsWith(".html")}`;
		this.artifactUrlRequestKey = requestKey;
		this.replaceResolvedViewUrl(null);
		this.replaceResolvedDownloadUrl(null);

		try {
			const [viewUrl, downloadUrl] = await Promise.all([
				this.resolveArtifactViewUrl(active.filename),
				this.resolveArtifactDownloadUrl(active.filename, {
					standalone: active.filename.toLowerCase().endsWith(".html"),
				}),
			]);
			if (this.artifactUrlRequestKey !== requestKey) return;
			this.replaceResolvedViewUrl(viewUrl);
			this.replaceResolvedDownloadUrl(downloadUrl);
		} catch {
			if (this.artifactUrlRequestKey !== requestKey) return;
			this.replaceResolvedViewUrl(
				this.buildDirectArtifactViewUrl(active.filename),
			);
			this.replaceResolvedDownloadUrl(
				this.buildDirectArtifactDownloadUrl(active.filename, {
					standalone: active.filename.toLowerCase().endsWith(".html"),
				}),
			);
		}
	}

	private async preloadZipLink() {
		if (!this.canResolveArtifactLinks()) {
			this.zipUrlRequestKey = null;
			this.replaceResolvedZipUrl(null);
			return;
		}

		const requestKey = `${this.sessionId}:${this.apiBaseUrl}`;
		this.zipUrlRequestKey = requestKey;
		this.replaceResolvedZipUrl(null);

		try {
			const zipUrl = await this.resolveArtifactsZipUrl();
			if (this.zipUrlRequestKey !== requestKey) return;
			this.replaceResolvedZipUrl(zipUrl);
		} catch {
			if (this.zipUrlRequestKey !== requestKey) return;
			this.replaceResolvedZipUrl(this.buildDirectArtifactsZipUrl());
		}
	}

	private async openInNewTab(filename: string) {
		const url =
			this.resolvedViewUrl ?? (await this.resolveArtifactViewUrl(filename));
		if (!url) return;
		window.open(url, "_blank", "noopener,noreferrer");
	}

	private downloadToNewTab(url: string | null, filename?: string) {
		if (!url) return;
		const a = document.createElement("a");
		a.href = url;
		a.rel = "noopener";
		if (url.startsWith("blob:")) {
			if (filename) {
				a.download = filename;
			}
		} else {
			a.target = "_blank";
		}
		a.click();
	}

	private async downloadZip() {
		const url = this.resolvedZipUrl ?? (await this.resolveArtifactsZipUrl());
		this.downloadToNewTab(url, "composer-artifacts.zip");
	}

	private async downloadArtifact(
		filename: string,
		opts?: { standalone?: boolean },
	) {
		const url =
			this.resolvedDownloadUrl ??
			(await this.resolveArtifactDownloadUrl(filename, opts));
		this.downloadToNewTab(url, filename);
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

	override render() {
		const artifacts = Array.isArray(this.artifacts) ? this.artifacts : [];
		const active =
			(this.activeFilename &&
				artifacts.find((a) => a.filename === this.activeFilename)) ||
			(artifacts.length > 0 ? (artifacts[0] ?? null) : null);

		return html`
			<div class="header">
				<div class="title">Artifacts</div>
				<div style="display:flex; align-items:center; gap:0.5rem;">
					${
						active && this.canResolveArtifactLinks()
							? html`<button
									class="close"
								@click=${() => void this.openInNewTab(active.filename)}
									title="Open in new tab"
								>↗</button>`
							: ""
					}
					${
						active && this.canResolveArtifactLinks()
							? active.filename.toLowerCase().endsWith(".html")
								? html`<button
										class="close"
										@click=${() =>
											void this.downloadArtifact(active.filename, {
												standalone: true,
											})}
										title="Download standalone HTML"
									>DL</button>`
								: html`<button
										class="close"
									@click=${() => void this.downloadArtifact(active.filename)}
										title="Download file"
									>DL</button>`
							: ""
					}
					${
						this.canResolveArtifactLinks()
							? html`<button
									class="close"
								@click=${() => void this.downloadZip()}
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
		if (
			!changed.has("artifacts") &&
			!changed.has("activeFilename") &&
			!changed.has("sessionId") &&
			!changed.has("apiBaseUrl") &&
			!changed.has("apiClient")
		) {
			return;
		}

		const artifacts = Array.isArray(this.artifacts) ? this.artifacts : [];
		const active =
			(this.activeFilename &&
				artifacts.find((a) => a.filename === this.activeFilename)) ||
			(artifacts.length > 0 ? (artifacts[0] ?? null) : null);

		void this.preloadZipLink();
		void this.preloadArtifactLinks(active);
		if (!active) return;

		void this.highlightIfNeeded(active);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.revokeObjectUrl(this.resolvedViewUrl);
		this.revokeObjectUrl(this.resolvedDownloadUrl);
		this.revokeObjectUrl(this.resolvedZipUrl);
	}
}
