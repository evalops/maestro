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
			gap: 0.5rem;
			align-items: flex-end;
			position: relative;
		}

		textarea {
			flex: 1;
			min-height: 42px;
			max-height: 200px;
			padding: 0.625rem 0.875rem;
			border: 1px solid #30363d;
			border-radius: 2px;
			background: #0a0e14;
			color: #e6edf3;
			font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
			font-size: 0.8rem;
			resize: none;
			outline: none;
			transition: all 0.15s;
			line-height: 1.6;
		}

		textarea:focus {
			border-color: #58a6ff;
			background: #0d1117;
		}

		textarea:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		textarea::placeholder {
			color: #6e7681;
		}

		.char-count {
			position: absolute;
			bottom: 0.5rem;
			right: 5rem;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.65rem;
			color: #6e7681;
			pointer-events: none;
			opacity: 0;
			transition: opacity 0.15s;
			text-transform: uppercase;
		}

		textarea:focus + .char-count {
			opacity: 1;
		}

		.char-count.warning {
			color: #d29922;
		}

		.char-count.error {
			color: #f85149;
		}

		button {
			padding: 0.625rem 1.25rem;
			background: #21262d;
			color: #e6edf3;
			border: 1px solid #30363d;
			border-radius: 2px;
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.7rem;
			font-weight: 700;
			cursor: pointer;
			transition: all 0.15s;
			white-space: nowrap;
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		button:hover:not(:disabled) {
			background: #30363d;
			border-color: #58a6ff;
			color: #58a6ff;
		}

		button:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.hint {
			font-family: 'SF Mono', 'Menlo', 'Monaco', monospace;
			font-size: 0.65rem;
			color: #6e7681;
			margin-top: 0.5rem;
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		.hint kbd {
			padding: 0.125rem 0.35rem;
			background: #161b22;
			border: 1px solid #30363d;
			border-radius: 2px;
			font-family: inherit;
			font-size: 0.65rem;
			font-weight: 600;
		}

		.actions {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		@media (max-width: 768px) {
			textarea {
				font-size: 16px; /* Prevent zoom on iOS */
			}

			button {
				padding: 0.625rem 1rem;
			}

			.hint {
				font-size: 0.6rem;
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
