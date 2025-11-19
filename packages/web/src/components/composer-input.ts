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
		}

		textarea {
			flex: 1;
			min-height: 52px;
			max-height: 200px;
			padding: 0.875rem 1rem;
			border: 1.5px solid var(--border-color, #30363d);
			border-radius: 8px;
			background: var(--bg-primary, #0d1117);
			color: var(--text-primary, #e6edf3);
			font-family: inherit;
			font-size: 0.9375rem;
			resize: vertical;
			outline: none;
			transition: all 0.2s ease;
			line-height: 1.5;
		}

		textarea:focus {
			border-color: var(--accent-color, #2f81f7);
			box-shadow: 0 0 0 3px rgba(47, 129, 247, 0.1);
			background: var(--bg-secondary, #161b22);
		}

		textarea:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		textarea::placeholder {
			color: var(--text-secondary, #969696);
		}

		button {
			padding: 0.875rem 1.75rem;
			background: linear-gradient(135deg, var(--accent-color, #2f81f7) 0%, var(--accent-hover, #539bf5) 100%);
			color: white;
			border: none;
			border-radius: 8px;
			font-size: 0.9375rem;
			font-weight: 600;
			cursor: pointer;
			transition: all 0.2s ease;
			white-space: nowrap;
			box-shadow: 0 2px 8px rgba(47, 129, 247, 0.3);
		}

		button:hover:not(:disabled) {
			transform: translateY(-1px);
			box-shadow: 0 4px 12px rgba(47, 129, 247, 0.4);
		}

		button:active:not(:disabled) {
			transform: translateY(0);
		}

		button:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.hint {
			font-size: 0.75rem;
			color: var(--text-secondary, #969696);
			margin-top: 0.5rem;
		}
	`;

	@property({ type: Boolean }) disabled = false;
	@state() private value = "";

	private handleInput(e: Event) {
		const target = e.target as HTMLTextAreaElement;
		this.value = target.value;

		// Auto-grow textarea
		target.style.height = "auto";
		target.style.height = `${target.scrollHeight}px`;
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

	render() {
		return html`
			<div class="input-wrapper">
				<textarea
					.value=${this.value}
					@input=${this.handleInput}
					@keydown=${this.handleKeyDown}
					?disabled=${this.disabled}
					placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
					rows="1"
				></textarea>
				<button @click=${this.submit} ?disabled=${this.disabled || !this.value.trim()}>
					Send
				</button>
			</div>
			<div class="hint">
				Press <strong>Enter</strong> to send, <strong>Shift+Enter</strong> for new line
			</div>
		`;
	}
}
