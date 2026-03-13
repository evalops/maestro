import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { ApiClient } from "../services/api-client.js";

type NoticeType = "info" | "error" | "success";
type ExportFormat = "json" | "markdown" | "text";

@customElement("composer-export-dialog")
export class ComposerExportDialog extends LitElement {
	static override styles = css`
		:host {
			position: fixed;
			inset: 0;
			background: rgba(0, 0, 0, 0.7);
			z-index: 260;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 1.25rem;
		}

		.modal-dialog {
			width: min(520px, 100%);
			background: var(--bg-deep, #08090a);
			border: 1px solid var(--border-primary, #1e2023);
			box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
			padding: 0.9rem;
			font-family: var(--font-mono, monospace);
		}

		.modal-title {
			font-size: 0.75rem;
			font-weight: 700;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--text-secondary, #8b8d91);
			margin-bottom: 0.75rem;
		}

		.modal-row {
			display: flex;
			gap: 0.5rem;
			align-items: center;
			margin-bottom: 0.6rem;
		}

		.modal-row label {
			font-size: 0.7rem;
			color: var(--text-tertiary, #5c5e62);
			min-width: 130px;
		}

		.modal-row select {
			flex: 1;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			color: var(--text-primary, #e8e9eb);
			padding: 0.35rem 0.5rem;
			font-family: inherit;
			font-size: 0.75rem;
		}

		.modal-help {
			font-size: 0.7rem;
			color: var(--text-tertiary, #5c5e62);
			line-height: 1.35;
			margin: 0.5rem 0 0.75rem 0;
		}

		.modal-actions {
			display: flex;
			justify-content: flex-end;
			gap: 0.5rem;
		}

		.modal-btn {
			border: 1px solid var(--border-primary, #1e2023);
			background: transparent;
			color: var(--text-tertiary, #5c5e62);
			height: 30px;
			padding: 0 0.75rem;
			cursor: pointer;
			font-family: inherit;
			font-size: 0.7rem;
			letter-spacing: 0.06em;
			text-transform: uppercase;
		}

		.modal-btn.primary {
			border-color: var(--accent-amber, #d4a012);
			color: var(--accent-amber, #d4a012);
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
		}

		.modal-btn:hover:not(:disabled) {
			background: var(--bg-elevated, #161719);
			color: var(--text-primary, #e8e9eb);
		}

		.modal-btn:disabled {
			opacity: 0.4;
			cursor: not-allowed;
		}

		.modal-error {
			font-size: 0.75rem;
			color: var(--accent-red, #ef4444);
			margin: 0.5rem 0;
		}
	`;

	@property({ attribute: false }) apiClient: ApiClient | null = null;
	@property() sessionId: string | null = null;

	@state() private loading = false;
	@state() private errorText: string | null = null;
	@state() private format: ExportFormat = "json";

	private close() {
		this.dispatchEvent(
			new CustomEvent("close", { bubbles: true, composed: true }),
		);
	}

	private notify(message: string, type: NoticeType, duration?: number) {
		this.dispatchEvent(
			new CustomEvent("notify", {
				detail: { message, type, duration },
				bubbles: true,
				composed: true,
			}),
		);
	}

	private downloadBlob(blob: Blob, filename: string) {
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		anchor.rel = "noopener";
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	private async exportSession() {
		if (!this.apiClient || !this.sessionId) return;
		this.loading = true;
		this.errorText = null;
		try {
			const response = await this.apiClient.exportSession(this.sessionId, {
				format: this.format,
			});
			if (!response.ok) {
				throw new Error(
					`Export failed (${response.status} ${response.statusText})`,
				);
			}
			const blob = await response.blob();
			const extension =
				this.format === "markdown"
					? "md"
					: this.format === "text"
						? "txt"
						: "json";
			this.downloadBlob(blob, `session-${this.sessionId}.${extension}`);
			this.notify("Export downloaded", "success", 1500);
			this.close();
		} catch (error) {
			this.errorText = error instanceof Error ? error.message : "Export failed";
		} finally {
			this.loading = false;
		}
	}

	override render() {
		return html`
			<div class="modal-dialog" @click=${(event: Event) => event.stopPropagation()}>
				<div class="modal-title">Export session</div>
				<div class="modal-row">
					<label for="export-format">Format</label>
					<select
						id="export-format"
						.value=${this.format}
						@change=${(event: Event) => {
							const value = (event.target as HTMLSelectElement).value;
							this.format =
								value === "markdown" || value === "text" ? value : "json";
						}}
					>
						<option value="json">JSON</option>
						<option value="markdown">Markdown</option>
						<option value="text">Text</option>
					</select>
				</div>

				<div class="modal-help">
					Downloads the full session including attachment content.
				</div>

				${
					this.errorText
						? html`<div class="modal-error">${this.errorText}</div>`
						: ""
				}

				<div class="modal-actions">
					<button class="modal-btn" @click=${this.close}>Close</button>
					<button
						class="modal-btn primary"
						@click=${this.exportSession}
						?disabled=${this.loading}
					>
						${this.loading ? "Exporting..." : "Download"}
					</button>
				</div>
			</div>
		`;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.addEventListener("click", this.close);
	}

	override disconnectedCallback(): void {
		this.removeEventListener("click", this.close);
		super.disconnectedCallback();
	}
}
