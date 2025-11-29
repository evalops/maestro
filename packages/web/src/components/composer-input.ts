/**
 * Message input component
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("composer-input")
export class ComposerInput extends LitElement {
	static styles = css`
		:host {
			display: block;
		}

		.input-wrapper {
			display: flex;
			gap: 0.75rem;
			align-items: flex-end;
			position: relative;
			background: var(--bg-primary, #0c0d0f);
			border: 1px solid var(--border-primary, #1e2023);
			padding: 0.75rem;
		}

		.input-wrapper:focus-within {
			border-color: var(--accent-amber, #d4a012);
			box-shadow: 0 0 0 1px var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
		}

		textarea {
			flex: 1;
			min-height: 24px;
			max-height: 200px;
			padding: 0;
			border: none;
			background: transparent;
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-mono, "JetBrains Mono", monospace);
			font-size: 0.85rem;
			resize: none;
			outline: none;
			line-height: 1.6;
		}

		textarea:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		textarea::placeholder {
			color: var(--text-tertiary, #5c5e62);
		}

		.char-count {
			position: absolute;
			bottom: 0.75rem;
			right: 6rem;
			font-family: var(--font-mono, monospace);
			font-size: 0.6rem;
			color: var(--text-tertiary, #5c5e62);
			pointer-events: none;
			opacity: 0;
			transition: opacity 0.15s ease;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		.input-wrapper:focus-within .char-count {
			opacity: 1;
		}

		.char-count.warning {
			color: var(--accent-yellow, #eab308);
		}

		.char-count.error {
			color: var(--accent-red, #ef4444);
		}

		button {
			padding: 0.5rem 1rem;
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			color: var(--accent-amber, #d4a012);
			border: none;
			font-family: var(--font-mono, monospace);
			font-size: 0.65rem;
			font-weight: 600;
			cursor: pointer;
			transition: all 0.15s ease;
			white-space: nowrap;
			text-transform: uppercase;
			letter-spacing: 0.08em;
		}

		button:hover:not(:disabled) {
			background: var(--accent-amber, #d4a012);
			color: var(--bg-deep, #08090a);
		}

		button:disabled {
			opacity: 0.3;
			cursor: not-allowed;
		}

		.hint {
			font-family: var(--font-mono, monospace);
			font-size: 0.6rem;
			color: var(--text-tertiary, #5c5e62);
			margin-top: 0.75rem;
			display: flex;
			align-items: center;
			gap: 0.75rem;
		}

		.hint kbd {
			padding: 0.15rem 0.4rem;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			font-family: inherit;
			font-size: 0.6rem;
			font-weight: 600;
			color: var(--text-secondary, #8b8d91);
		}

		.actions {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		@media (max-width: 768px) {
			textarea {
				font-size: 16px;
			}

			button {
				padding: 0.5rem 0.875rem;
			}

			.hint {
				font-size: 0.55rem;
			}
		}
	`;

	@property({ type: Boolean }) disabled = false;
	@state() private value = "";
	private maxLength = 10000;

	private handleInput(e: Event) {
		const target = e.target as HTMLTextAreaElement;
		this.value = target.value;

		// Auto-grow textarea
		target.style.height = "auto";
		target.style.height = `${Math.min(target.scrollHeight, 240)}px`;
	}

	private handleKeyDown(e: KeyboardEvent) {
		// Submit on Enter (without Shift)
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			this.submit();
		}
	}

	private submit() {
		const text = this.value.trim();
		if (!text || this.disabled) return;

		this.dispatchEvent(
			new CustomEvent("submit", {
				detail: { text },
				bubbles: true,
				composed: true,
			}),
		);

		// Clear input
		this.value = "";
		const textarea = this.shadowRoot?.querySelector("textarea");
		if (textarea) {
			textarea.value = "";
			textarea.style.height = "auto";
		}
	}

	private getCharCountClass(): string {
		const len = this.value.length;
		if (len > this.maxLength * 0.9) return "error";
		if (len > this.maxLength * 0.75) return "warning";
		return "";
	}

	render() {
		const charCount = this.value.length;
		const showCount = charCount > this.maxLength * 0.5;

		return html`
			<div class="input-wrapper">
				<textarea
					.value=${this.value}
					@input=${this.handleInput}
					@keydown=${this.handleKeyDown}
					?disabled=${this.disabled}
					placeholder="> Type a message or use slash commands: /run /config /help"
					maxlength=${this.maxLength}
					rows="1"
				></textarea>
				${
					showCount
						? html`<div class="char-count ${this.getCharCountClass()}">
							${charCount}/${this.maxLength}
					  </div>`
						: ""
				}
				<div class="actions">
					<button @click=${this.submit} ?disabled=${this.disabled || !this.value.trim()}>
						SEND
					</button>
				</div>
			</div>
			<div class="hint">
				<kbd>↵</kbd> send • <kbd>⇧</kbd> + <kbd>↵</kbd> newline
			</div>
		`;
	}
}
