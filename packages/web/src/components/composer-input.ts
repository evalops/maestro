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
			min-height: 48px;
			max-height: 200px;
			padding: 0.75rem;
			border: 1px solid var(--border-color, #3e3e42);
			border-radius: 6px;
			background: var(--bg-primary, #1e1e1e);
			color: var(--text-primary, #d4d4d4);
			font-family: inherit;
			font-size: 0.9375rem;
			resize: vertical;
			outline: none;
			transition: border-color 0.2s;
		}

		textarea:focus {
			border-color: var(--accent-color, #0e639c);
		}

		textarea:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		textarea::placeholder {
			color: var(--text-secondary, #969696);
		}

		button {
			padding: 0.75rem 1.5rem;
			background: var(--accent-color, #0e639c);
			color: white;
			border: none;
			border-radius: 6px;
			font-size: 0.9375rem;
			font-weight: 500;
			cursor: pointer;
			transition: opacity 0.2s;
			white-space: nowrap;
		}

		button:hover:not(:disabled) {
			opacity: 0.9;
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
