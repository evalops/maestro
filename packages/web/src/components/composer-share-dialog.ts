import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { type ApiClient, ApiClientError } from "../services/api-client.js";

type NoticeType = "info" | "error" | "success";

interface ShareResult {
	webShareUrl: string;
	expiresAt: string;
	maxAccesses: number | null;
}

@customElement("composer-share-dialog")
export class ComposerShareDialog extends LitElement {
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

		.modal-row input {
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
	@state() private expiresHours = 24;
	@state() private maxAccesses: number | null = 100;
	@state() private result: ShareResult | null = null;
	@state() private allowSensitiveContent = false;

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

	private async createLink() {
		if (!this.apiClient || !this.sessionId) return;
		this.loading = true;
		this.errorText = null;
		try {
			const response = await this.apiClient.shareSession(this.sessionId, {
				expiresInHours: Math.min(168, Math.max(1, this.expiresHours)),
				maxAccesses: this.maxAccesses,
				allowSensitiveContent: this.allowSensitiveContent,
			});
			const origin =
				typeof window !== "undefined"
					? window.location.origin
					: "http://localhost";
			const webShareUrl = response.webShareUrl
				? new URL(response.webShareUrl, origin).toString()
				: new URL(`/share/${response.shareToken}`, origin).toString();
			this.result = {
				webShareUrl,
				expiresAt: response.expiresAt,
				maxAccesses: response.maxAccesses,
			};
		} catch (error) {
			if (
				error instanceof ApiClientError &&
				error.payload?.code === "sensitive_content_detected"
			) {
				this.allowSensitiveContent = true;
				this.errorText = `${error.message} Run share again to confirm.`;
			} else {
				this.errorText =
					error instanceof Error
						? error.message
						: "Failed to create share link";
			}
		} finally {
			this.loading = false;
		}
	}

	private async copyLink() {
		if (!this.result) return;
		try {
			await navigator.clipboard.writeText(this.result.webShareUrl);
			this.notify("Share link copied", "success", 1500);
		} catch {
			this.notify("Copy failed", "error", 1500);
		}
	}

	override render() {
		return html`
			<div class="modal-dialog" @click=${(event: Event) => event.stopPropagation()}>
				<div class="modal-title">Share session</div>
				<div class="modal-row">
					<label for="share-exp">Expires (hours)</label>
					<input
						id="share-exp"
						type="number"
						min="1"
						max="168"
						.value=${String(this.expiresHours)}
						@input=${(event: Event) => {
							const raw = (event.target as HTMLInputElement).value;
							const next = Number.parseInt(raw, 10);
							this.expiresHours = Number.isFinite(next) ? next : 24;
						}}
					/>
				</div>
				<div class="modal-row">
					<label for="share-max">Max opens</label>
					<input
						id="share-max"
						type="number"
						min="1"
						.value=${this.maxAccesses === null ? "" : String(this.maxAccesses)}
						placeholder="Unlimited"
						@input=${(event: Event) => {
							const raw = (event.target as HTMLInputElement).value.trim();
							if (!raw) {
								this.maxAccesses = null;
								return;
							}
							const next = Number.parseInt(raw, 10);
							this.maxAccesses = Number.isFinite(next) ? next : 100;
						}}
					/>
				</div>

				${
					this.result
						? html`
						<div class="modal-row">
							<label>Link</label>
							<input type="text" readonly .value=${this.result.webShareUrl} />
						</div>
						<div class="modal-help">
							Expires at ${new Date(this.result.expiresAt).toLocaleString()}${
								this.result.maxAccesses === null
									? " • unlimited opens"
									: ` • max ${this.result.maxAccesses} opens`
							}
						</div>
					`
						: html`<div class="modal-help">
							Generates a read-only link for viewing this session in the web UI.
							${
								this.allowSensitiveContent
									? " Sensitive content was detected, so the next share click confirms that you still want to publish it."
									: ""
							}
						</div>`
				}

				${
					this.errorText
						? html`<div class="modal-error">${this.errorText}</div>`
						: ""
				}

				<div class="modal-actions">
					<button class="modal-btn" @click=${this.close}>Close</button>
					${
						this.result
							? html`
							<button
								class="modal-btn primary"
								@click=${this.copyLink}
								?disabled=${this.loading}
							>
								Copy
							</button>
						`
							: html`
							<button
								class="modal-btn primary"
								@click=${this.createLink}
								?disabled=${this.loading}
							>
								${
									this.loading
										? "Creating..."
										: this.allowSensitiveContent
											? "Share Anyway"
											: "Create link"
								}
							</button>
						`
					}
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
