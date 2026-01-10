import type { ComposerAttachment } from "@evalops/contracts";
import DOMPurify from "dompurify";
import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { isValidBase64, normalizeBase64 } from "./base64-utils.js";

type PdfjsModule = typeof import("pdfjs-dist");
type XlsxModule = typeof import("xlsx");
type DocxPreviewModule = typeof import("docx-preview");

let cachedPdfjs: PdfjsModule | null = null;
let cachedXlsx: XlsxModule | null = null;
let cachedDocxPreview: DocxPreviewModule | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
	if (!cachedPdfjs) {
		cachedPdfjs = await import("pdfjs-dist");
		cachedPdfjs.GlobalWorkerOptions.workerSrc = new URL(
			"pdfjs-dist/build/pdf.worker.min.mjs",
			import.meta.url,
		).toString();
	}
	return cachedPdfjs;
}

async function loadXlsx(): Promise<XlsxModule> {
	if (!cachedXlsx) {
		cachedXlsx = await import("xlsx");
	}
	return cachedXlsx;
}

async function loadDocxPreview(): Promise<DocxPreviewModule> {
	if (!cachedDocxPreview) {
		cachedDocxPreview = await import("docx-preview");
	}
	return cachedDocxPreview;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
	const normalized = normalizeBase64(base64);
	if (!isValidBase64(normalized)) {
		throw new Error("Invalid base64 content");
	}
	const bin = atob(normalized);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function encodeBytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.slice(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function safeDecodeBase64ToText(base64: string): string | null {
	try {
		const bytes = decodeBase64ToBytes(base64);
		return new TextDecoder().decode(bytes);
	} catch {
		return null;
	}
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function parsePptxSlides(extractedText: string): Array<{
	title: string;
	body: string;
}> {
	const text = (extractedText || "").trim();
	if (!text) return [];

	const chunks = text.split(/\n{2,}(?=# Slide\s+)/g);
	const slides: Array<{ title: string; body: string }> = [];
	for (const chunk of chunks) {
		const normalized = chunk.trim();
		if (!normalized) continue;
		const lines = normalized.split("\n");
		const first = lines[0] || "";
		const title = first.startsWith("# ") ? first.slice(2).trim() : first.trim();
		const body = lines.slice(1).join("\n").trim();
		slides.push({ title: title || "Slide", body });
	}
	return slides;
}

type AttachmentKind =
	| "image"
	| "pdf"
	| "docx"
	| "xlsx"
	| "pptx"
	| "text"
	| "binary";

@customElement("composer-attachment-viewer")
export class ComposerAttachmentViewer extends LitElement {
	static override styles = css`
		:host {
			position: fixed;
			inset: 0;
			display: none;
			z-index: 200;
		}

		:host([open]) {
			display: block;
		}

		.backdrop {
			position: absolute;
			inset: 0;
			background: rgba(0, 0, 0, 0.7);
		}

		.modal {
			position: absolute;
			top: 6vh;
			left: 50%;
			transform: translateX(-50%);
			width: min(920px, calc(100vw - 2rem));
			max-height: 88vh;
			display: flex;
			flex-direction: column;
			background: var(--bg-deep, #08090a);
			border: 1px solid var(--border-primary, #1e2023);
			box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
		}

		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.75rem;
			padding: 0.75rem 0.75rem;
			border-bottom: 1px solid var(--border-primary, #1e2023);
			min-height: 48px;
		}

		.title {
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 0.15rem;
		}

		.filename {
			font-family: var(--font-mono, monospace);
			font-size: 0.75rem;
			font-weight: 600;
			color: var(--text-primary, #e8e9eb);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.meta {
			font-family: var(--font-mono, monospace);
			font-size: 0.65rem;
			color: var(--text-tertiary, #5c5e62);
		}

		.actions {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		.btn {
			border: 1px solid var(--border-primary, #1e2023);
			background: transparent;
			color: var(--text-tertiary, #5c5e62);
			height: 28px;
			padding: 0 0.6rem;
			cursor: pointer;
			font-family: var(--font-mono, monospace);
			font-size: 0.65rem;
			letter-spacing: 0.06em;
			text-transform: uppercase;
		}

		.btn:hover:not(:disabled) {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
		}

		.btn:disabled {
			opacity: 0.4;
			cursor: not-allowed;
		}

		.body {
			padding: 0.75rem;
			overflow: auto;
			min-height: 0;
		}

		.preview {
			border: 1px solid var(--border-primary, #1e2023);
			background: #0b0c0e;
		}

		.image {
			display: block;
			width: 100%;
			height: auto;
			border: 1px solid var(--border-primary, #1e2023);
			background: #000;
		}

		.pdf canvas {
			display: block;
			width: 100%;
			height: auto;
			background: #fff;
		}

		.pdf .page {
			border-bottom: 1px solid #e5e7eb;
		}

		.pdf .page:last-child {
			border-bottom: none;
		}

		.xlsx-tabs {
			display: flex;
			gap: 0.25rem;
			flex-wrap: wrap;
			margin-bottom: 0.5rem;
		}

		.xlsx-tab {
			border: 1px solid var(--border-primary, #1e2023);
			background: transparent;
			color: var(--text-tertiary, #5c5e62);
			height: 26px;
			padding: 0 0.5rem;
			cursor: pointer;
			font-family: var(--font-mono, monospace);
			font-size: 0.65rem;
			letter-spacing: 0.06em;
			text-transform: uppercase;
		}

		.xlsx-tab.active {
			border-color: var(--accent-amber, #d4a012);
			color: var(--accent-amber, #d4a012);
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
		}

		.xlsx-content {
			border: 1px solid var(--border-primary, #1e2023);
			background: #0b0c0e;
			overflow: auto;
		}

		.xlsx-content table {
			border-collapse: collapse;
			width: 100%;
			background: #0b0c0e;
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-mono, monospace);
			font-size: 0.75rem;
		}

		.xlsx-content td,
		.xlsx-content th {
			border: 1px solid var(--border-primary, #1e2023);
			padding: 0.35rem 0.5rem;
			vertical-align: top;
			white-space: pre-wrap;
			word-break: break-word;
		}

		.pre {
			margin: 0;
			padding: 0.75rem;
			border: 1px solid var(--border-primary, #1e2023);
			background: #0d1117;
			color: var(--text-primary, #e8e9eb);
			white-space: pre-wrap;
			word-break: break-word;
			font-size: 0.75rem;
			line-height: 1.35;
			font-family: var(--font-mono, monospace);
		}

		.notice {
			font-family: var(--font-mono, monospace);
			font-size: 0.75rem;
			color: var(--text-tertiary, #5c5e62);
		}
	`;

	@property({ type: Boolean, reflect: true }) open = false;
	@property({ attribute: false }) attachment: ComposerAttachment | null = null;
	@property() apiEndpoint = "";
	@property() sessionId: string | null = null;
	@property() shareToken: string | null = null;
	@state() private copyStatus: "idle" | "ok" | "err" = "idle";
	@state() private viewMode: "preview" | "text" = "preview";
	@state() private loading = false;
	@state() private loadError: string | null = null;
	@state() private blobUrl: string | null = null;
	@state() private loadedText: string | null = null;
	@state() private xlsxSheetNames: string[] = [];
	@state() private xlsxActiveSheet = 0;
	@state() private xlsxHtml: string | null = null;
	@state() private pptxActiveSlide = 0;
	@state() private extracting = false;

	private loadedBytes: Uint8Array | null = null;
	private pdfDoc: unknown | null = null;
	private renderToken = 0;
	private renderedAttachmentId: string | null = null;

	private close() {
		this.cleanupLoaded();
		this.open = false;
		this.attachment = null;
		this.copyStatus = "idle";
		this.viewMode = "preview";
		this.dispatchEvent(
			new CustomEvent("close", { bubbles: true, composed: true }),
		);
	}

	private handleKeydown = (e: KeyboardEvent) => {
		if (!this.open) return;
		if (e.key === "Escape") {
			e.preventDefault();
			this.close();
		}
	};

	override connectedCallback(): void {
		super.connectedCallback();
		window.addEventListener("keydown", this.handleKeydown);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener("keydown", this.handleKeydown);
	}

	private cleanupLoaded() {
		this.renderToken++;
		this.renderedAttachmentId = null;

		if (this.pdfDoc && typeof this.pdfDoc === "object") {
			try {
				(this.pdfDoc as { destroy?: () => void }).destroy?.();
			} catch {
				// ignore
			}
		}
		this.pdfDoc = null;

		if (this.blobUrl) {
			try {
				URL.revokeObjectURL(this.blobUrl);
			} catch {
				// ignore
			}
		}
		this.blobUrl = null;
		this.loadedBytes = null;
		this.loadedText = null;
		this.loadError = null;
		this.loading = false;
		this.xlsxSheetNames = [];
		this.xlsxActiveSheet = 0;
		this.xlsxHtml = null;
		this.pptxActiveSlide = 0;
	}

	private getKind(att: ComposerAttachment): AttachmentKind {
		const type = (att.mimeType || "").toLowerCase();
		const name = (att.fileName || "").toLowerCase();

		if (att.type === "image" || type.startsWith("image/")) return "image";
		if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
		if (type.includes("wordprocessingml") || name.endsWith(".docx"))
			return "docx";
		if (
			type.includes("spreadsheetml") ||
			type.includes("ms-excel") ||
			name.endsWith(".xlsx") ||
			name.endsWith(".xls")
		)
			return "xlsx";
		if (type.includes("presentationml") || name.endsWith(".pptx"))
			return "pptx";
		if (this.isTextLike(att)) return "text";
		return "binary";
	}

	private isTextLike(att: ComposerAttachment): boolean {
		const type = (att.mimeType || "").toLowerCase();
		if (type.startsWith("text/")) return true;
		if (type.includes("json") || type.includes("xml") || type.includes("yaml"))
			return true;
		const name = (att.fileName || "").toLowerCase();
		return (
			name.endsWith(".txt") ||
			name.endsWith(".md") ||
			name.endsWith(".markdown") ||
			name.endsWith(".json") ||
			name.endsWith(".yaml") ||
			name.endsWith(".yml") ||
			name.endsWith(".csv") ||
			name.endsWith(".ts") ||
			name.endsWith(".tsx") ||
			name.endsWith(".js") ||
			name.endsWith(".jsx") ||
			name.endsWith(".html") ||
			name.endsWith(".css") ||
			name.endsWith(".xml")
		);
	}

	private async fetchAttachmentBytes(): Promise<ArrayBuffer> {
		const att = this.attachment;
		const sessionId = this.sessionId;
		const shareToken = this.shareToken;
		const apiEndpoint = (this.apiEndpoint || "").replace(/\/$/, "");
		if (!att?.id || !apiEndpoint) {
			throw new Error("Missing apiEndpoint for attachment fetch");
		}
		const url =
			shareToken && shareToken.length > 0
				? `${apiEndpoint}/api/sessions/shared/${encodeURIComponent(shareToken)}/attachments/${encodeURIComponent(att.id)}`
				: sessionId && sessionId.length > 0
					? `${apiEndpoint}/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(att.id)}`
					: null;

		if (!url) {
			throw new Error("Missing sessionId/shareToken for attachment fetch");
		}

		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(
				`Failed to load attachment (${res.status} ${res.statusText})`,
			);
		}
		return await res.arrayBuffer();
	}

	private async ensureBytesLoaded(opts?: {
		force?: boolean;
		decodeText?: boolean;
	}) {
		const att = this.attachment;
		if (!att) return;
		if (this.loadedBytes && !opts?.force) return;

		const needsFetch = Boolean(att.contentOmitted) && !att.content;

		if (
			!needsFetch &&
			typeof att.content === "string" &&
			att.content.length > 0
		) {
			try {
				const bytes = decodeBase64ToBytes(att.content);
				const blob = new Blob([bytes as BlobPart], {
					type: att.mimeType || "application/octet-stream",
				});
				this.cleanupLoaded();
				this.loadedBytes = bytes;
				this.blobUrl = URL.createObjectURL(blob);
				if (opts?.decodeText && this.isTextLike(att)) {
					try {
						this.loadedText = new TextDecoder().decode(bytes);
					} catch {
						this.loadedText = null;
					}
				}
				return;
			} catch {
				this.loadError = "Attachment content is not valid base64";
				return;
			}
		}

		if (!needsFetch) return;

		this.loading = true;
		this.loadError = null;
		try {
			const bytes = await this.fetchAttachmentBytes();
			const blob = new Blob([bytes], {
				type: att.mimeType || "application/octet-stream",
			});
			this.cleanupLoaded();
			this.loadedBytes = new Uint8Array(bytes);
			this.blobUrl = URL.createObjectURL(blob);
			if (opts?.decodeText && this.isTextLike(att)) {
				try {
					this.loadedText = new TextDecoder().decode(this.loadedBytes);
				} catch {
					this.loadedText = null;
				}
			}
		} catch (e) {
			this.loadError =
				e instanceof Error ? e.message : "Failed to load attachment";
		} finally {
			this.loading = false;
		}
	}

	private async download() {
		const att = this.attachment;
		if (!att) return;

		if (!att.content && att.contentOmitted) {
			await this.ensureBytesLoaded({ decodeText: false });
		}

		if (this.blobUrl) {
			const a = document.createElement("a");
			a.href = this.blobUrl;
			a.download = att.fileName || "attachment";
			a.rel = "noopener";
			a.click();
			return;
		}

		if (!att.content) return;
		try {
			const bytes = decodeBase64ToBytes(att.content);
			const blob = new Blob([bytes as BlobPart], {
				type: att.mimeType || "application/octet-stream",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = att.fileName || "attachment";
			a.rel = "noopener";
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "Invalid base64 content"
			) {
				this.loadError = "Attachment content is not valid base64";
			} else {
				this.loadError = "Failed to download attachment";
			}
		}
	}

	private async copyText() {
		const att = this.attachment;
		if (!att) return;

		if (!att.extractedText && !att.content && att.contentOmitted) {
			await this.ensureBytesLoaded({ decodeText: true });
		}

		const text =
			att.extractedText ||
			this.loadedText ||
			(att.content ? safeDecodeBase64ToText(att.content) : null);
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			this.copyStatus = "ok";
			setTimeout(() => {
				this.copyStatus = "idle";
			}, 1200);
		} catch {
			this.copyStatus = "err";
			setTimeout(() => {
				this.copyStatus = "idle";
			}, 1200);
		}
	}

	private async extractText() {
		const att = this.attachment;
		const apiEndpoint = (this.apiEndpoint || "").replace(/\/$/, "");
		if (!att?.id || !apiEndpoint) return;

		const kind = this.getKind(att);
		if (!["pdf", "docx", "xlsx", "pptx"].includes(kind)) return;

		this.extracting = true;
		this.loadError = null;
		try {
			const canPersistToSession =
				!this.shareToken &&
				Boolean(this.sessionId && this.sessionId.length > 0);

			let extractedText: string | null = null;

			if (canPersistToSession) {
				const url = `${apiEndpoint}/api/sessions/${encodeURIComponent(
					this.sessionId as string,
				)}/attachments/${encodeURIComponent(att.id)}/extract`;
				const res = await fetch(url, { method: "POST" });
				if (!res.ok) {
					throw new Error(
						`Failed to extract (${res.status} ${res.statusText})`,
					);
				}
				const json = (await res.json()) as { extractedText?: unknown };
				extractedText =
					typeof json.extractedText === "string" ? json.extractedText : null;
			} else {
				const base64 =
					typeof att.content === "string" && att.content.length > 0
						? att.content
						: await (async () => {
								await this.ensureBytesLoaded({ decodeText: false });
								return this.loadedBytes
									? encodeBytesToBase64(this.loadedBytes)
									: "";
							})();

				if (!base64) {
					throw new Error("Missing attachment content for extraction");
				}

				const res = await fetch(`${apiEndpoint}/api/attachments/extract`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify({
						fileName: att.fileName,
						mimeType: att.mimeType,
						contentBase64: base64,
					}),
				});
				if (!res.ok) {
					throw new Error(
						`Failed to extract (${res.status} ${res.statusText})`,
					);
				}
				const json = (await res.json()) as { extractedText?: unknown };
				extractedText =
					typeof json.extractedText === "string" ? json.extractedText : null;
			}

			if (!extractedText) {
				throw new Error("Extractor returned no text");
			}

			this.attachment = { ...att, extractedText };
			this.renderedAttachmentId = null;
			this.dispatchEvent(
				new CustomEvent("attachment-updated", {
					bubbles: true,
					composed: true,
					detail: { attachmentId: att.id, extractedText },
				}),
			);
		} catch (e) {
			this.loadError =
				e instanceof Error ? e.message : "Failed to extract text";
		} finally {
			this.extracting = false;
		}
	}

	private async renderPdf(bytes: Uint8Array, token: number): Promise<void> {
		const pdfjsLib = await loadPdfjs();
		const root = this.renderRoot as ShadowRoot;
		const container = root.querySelector("#pdf-container");
		if (!(container instanceof HTMLElement)) return;
		container.innerHTML = "";

		const loadingTask = pdfjsLib.getDocument({ data: bytes });
		const doc = await loadingTask.promise;
		if (token !== this.renderToken) {
			try {
				doc.destroy();
			} catch {
				// ignore
			}
			return;
		}

		this.pdfDoc = doc;
		const maxPages = Math.min(doc.numPages || 0, 25);
		for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
			if (token !== this.renderToken) return;
			const page = await doc.getPage(pageNum);
			const viewport = page.getViewport({ scale: 1.35 });
			const canvas = document.createElement("canvas");
			const ctx = canvas.getContext("2d");
			if (!ctx) continue;
			canvas.width = Math.max(1, Math.floor(viewport.width));
			canvas.height = Math.max(1, Math.floor(viewport.height));

			const wrapper = document.createElement("div");
			wrapper.className = "page";
			wrapper.appendChild(canvas);
			container.appendChild(wrapper);

			await page.render({ canvas, canvasContext: ctx, viewport }).promise;
		}
	}

	private async renderDocxFile(
		bytes: Uint8Array,
		token: number,
	): Promise<void> {
		const docx = await loadDocxPreview();
		const root = this.renderRoot as ShadowRoot;
		const container = root.querySelector("#docx-container");
		if (!(container instanceof HTMLElement)) return;
		container.innerHTML = "";
		await docx.renderAsync(bytes.buffer, container, undefined, {
			className: "docx-preview",
		});
		if (token !== this.renderToken) {
			container.innerHTML = "";
		}
	}

	private async renderXlsxFile(
		bytes: Uint8Array,
		token: number,
	): Promise<void> {
		const XLSX = await loadXlsx();
		const workbook = XLSX.read(bytes, { type: "array" });
		if (token !== this.renderToken) return;

		const sheetNames = Array.isArray(workbook.SheetNames)
			? workbook.SheetNames.filter((s) => typeof s === "string")
			: [];
		this.xlsxSheetNames = sheetNames;
		if (this.xlsxActiveSheet >= sheetNames.length) {
			this.xlsxActiveSheet = 0;
		}

		const activeName = sheetNames[this.xlsxActiveSheet];
		const sheet = activeName ? workbook.Sheets[activeName] : undefined;
		const htmlString = sheet ? XLSX.utils.sheet_to_html(sheet) : "";
		const sanitized = DOMPurify.sanitize(htmlString, {
			USE_PROFILES: { html: true },
		});
		this.xlsxHtml = sanitized;
	}

	private async renderPreviewIfNeeded(): Promise<void> {
		const att = this.attachment;
		if (!this.open || !att) return;
		if (this.viewMode === "text") return;

		const kind = this.getKind(att);
		if (kind === "image") {
			await this.ensureBytesLoaded({ decodeText: false });
			return;
		}
		if (kind === "text") {
			await this.ensureBytesLoaded({ decodeText: true });
			return;
		}

		if (this.renderedAttachmentId === att.id) return;

		const token = ++this.renderToken;
		this.renderedAttachmentId = att.id;

		await this.ensureBytesLoaded({ decodeText: false });
		if (!this.loadedBytes) return;
		if (token !== this.renderToken) return;

		try {
			if (kind === "pdf") {
				await this.renderPdf(this.loadedBytes, token);
			} else if (kind === "docx") {
				await this.renderDocxFile(this.loadedBytes, token);
			} else if (kind === "xlsx") {
				await this.renderXlsxFile(this.loadedBytes, token);
			}
		} catch (e) {
			if (token !== this.renderToken) return;
			this.loadError =
				e instanceof Error ? e.message : "Failed to render preview";
		}
	}

	override render() {
		if (!this.open) return null;
		const att = this.attachment;
		if (!att) return null;

		const kind = this.getKind(att);
		const canToggleText =
			this.viewMode === "preview" ? Boolean(att.extractedText) : true;
		const canExtractText =
			["pdf", "docx", "xlsx", "pptx"].includes(kind) && !att.extractedText;
		const previewBase64 = att.preview || att.content || "";
		const canDownload =
			Boolean(att.content) ||
			Boolean(this.blobUrl) ||
			(Boolean(att.contentOmitted) &&
				(Boolean(this.sessionId) || Boolean(this.shareToken)) &&
				Boolean(this.apiEndpoint));
		const text =
			att.extractedText ||
			this.loadedText ||
			(att.content ? safeDecodeBase64ToText(att.content) : null);

		const copyLabel =
			this.copyStatus === "ok"
				? "Copied"
				: this.copyStatus === "err"
					? "Copy failed"
					: "Copy";

		const showText = this.viewMode === "text";
		const pptxSlides = kind === "pptx" && text ? parsePptxSlides(text) : [];
		const pptxActive =
			pptxSlides.length > 0
				? pptxSlides[Math.min(this.pptxActiveSlide, pptxSlides.length - 1)]
				: null;

		return html`
			<div class="backdrop" @click=${this.close}></div>
			<div class="modal" @click=${(e: Event) => e.stopPropagation()}>
				<div class="header">
					<div class="title">
						<div class="filename">${att.fileName}</div>
						<div class="meta">${att.mimeType} • ${formatBytes(att.size)}</div>
					</div>
					<div class="actions">
						${
							kind !== "image" &&
							kind !== "binary" &&
							kind !== "text" &&
							canToggleText
								? html`
										<button
											class="btn"
											@click=${() => {
												this.viewMode =
													this.viewMode === "preview" ? "text" : "preview";
												this.renderedAttachmentId = null;
											}}
										>
											${showText ? "Preview" : "Text"}
										</button>
									`
								: ""
						}
						<button class="btn" @click=${this.copyText} ?disabled=${!text}>
							${copyLabel}
						</button>
						${
							canExtractText
								? html`
										<button
											class="btn"
											@click=${this.extractText}
											?disabled=${this.extracting}
										>
											${this.extracting ? "Extracting..." : "Extract"}
										</button>
									`
								: ""
						}
						<button class="btn" @click=${this.download} ?disabled=${!canDownload}>
							Download
						</button>
						<button class="btn" @click=${this.close}>Close</button>
					</div>
				</div>
				<div class="body">
					${
						this.loadError
							? html`<div class="notice">${this.loadError}</div>`
							: this.loading
								? html`<div class="notice">Loading...</div>`
								: kind === "image" && (this.blobUrl || previewBase64)
									? html`<img
											class="image"
											alt=${att.fileName}
											src=${this.blobUrl || `data:${att.mimeType};base64,${previewBase64}`}
										/>`
									: showText && text
										? html`<pre class="pre">${text}</pre>`
										: kind === "pdf"
											? html`<div id="pdf-container" class="preview pdf"></div>`
											: kind === "docx"
												? html`<div id="docx-container" class="preview"></div>`
												: kind === "xlsx"
													? html`
															<div class="xlsx-tabs">
																${this.xlsxSheetNames.map(
																	(name, i) => html`
																		<button
																			class="xlsx-tab ${i === this.xlsxActiveSheet ? "active" : ""}"
																			@click=${() => {
																				this.xlsxActiveSheet = i;
																				this.renderedAttachmentId = null;
																			}}
																		>
																			${name}
																		</button>
																	`,
																)}
															</div>
															<div class="xlsx-content">
																${this.xlsxHtml ? unsafeHTML(this.xlsxHtml) : ""}
															</div>
														`
													: kind === "pptx" && !showText && pptxActive
														? html`
																<div class="xlsx-tabs">
																	${pptxSlides.map(
																		(slide, i) => html`
																			<button
																				class="xlsx-tab ${i === this.pptxActiveSlide ? "active" : ""}"
																				@click=${() => {
																					this.pptxActiveSlide = i;
																				}}
																			>
																				${slide.title.replace(/^Slide\s+/i, "") || String(i + 1)}
																			</button>
																		`,
																	)}
																</div>
																<pre class="pre">${pptxActive.body || "(No text on this slide)"}</pre>
															`
														: text
															? html`<pre class="pre">${text}</pre>`
															: html`<div class="notice">
																No preview available. Use Download to open locally.
															</div>`
					}
				</div>
			</div>
		`;
	}

	override updated(changed: Map<string, unknown>): void {
		super.updated(changed);
		if (changed.has("attachment")) {
			this.cleanupLoaded();
		}
		if (
			changed.has("open") ||
			changed.has("attachment") ||
			changed.has("viewMode") ||
			changed.has("xlsxActiveSheet")
		) {
			void this.renderPreviewIfNeeded();
		}
		if (!this.open) {
			this.cleanupLoaded();
		}
	}
}
