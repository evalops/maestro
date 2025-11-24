/**
 * Message input component
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ApiClient } from "../services/api-client.js";

@customElement("composer-input")
export class ComposerInput extends LitElement {
	static styles = css`
		:host {
			display: block;
		}

		.input-container {
			position: relative;
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

		.suggestions {
			position: absolute;
			bottom: 100%;
			left: 0;
			right: 0;
			background: var(--bg-secondary, #161b22);
			border: 1px solid var(--border-primary, #1e2023);
			border-bottom: none;
			max-height: 200px;
			overflow-y: auto;
			z-index: 100;
			margin-bottom: 0.5rem;
			border-radius: 4px;
			box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
			display: flex;
			flex-direction: column;
		}

		.suggestion-item {
			padding: 0.5rem 0.75rem;
			cursor: pointer;
			color: var(--text-primary, #e8e9eb);
			font-family: var(--font-mono, monospace);
			font-size: 0.8rem;
			border-bottom: 1px solid var(--border-dim, rgba(30, 32, 35, 0.5));
		}

		.suggestion-item:last-child {
			border-bottom: none;
		}

		.suggestion-item:hover, .suggestion-item.selected {
			background: var(--accent-amber-dim, rgba(212, 160, 18, 0.12));
			color: var(--accent-amber, #d4a012);
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
	@state() private showSuggestions = false;
	@state() private suggestionIndex = 0;
	@state() private filteredFiles: string[] = [];

	private maxLength = 10000;
	private allFiles: string[] = [];
	private apiClient = new ApiClient();
	private mentionMatch: { start: number; end: number; query: string } | null =
		null;
	private checkMentionCounter = 0;

	private async handleInput(e: Event) {
		const target = e.target as HTMLTextAreaElement;
		this.value = target.value;

		// Auto-grow textarea
		target.style.height = "auto";
		target.style.height = `${Math.min(target.scrollHeight, 240)}px`;

		// Check for mention (awaited to prevent race conditions)
		await this.checkMention(target);
	}

	private async checkMention(textarea: HTMLTextAreaElement) {
		const cursor = textarea.selectionStart;
		const textBeforeCursor = this.value.slice(0, cursor);

		// Regex to find @mention at end of string
		const match = /@([a-zA-Z0-9_\-\.\/]*)$/.exec(textBeforeCursor);

		if (match) {
			const query = match[1].toLowerCase();
			const requestId = ++this.checkMentionCounter;

			if (this.allFiles.length === 0) {
				this.allFiles = await this.apiClient.getFiles();
				// Ignore stale results
				if (requestId !== this.checkMentionCounter) return;
			}

			// Handle empty query - return first files without ranking
			if (!query) {
				this.filteredFiles = this.allFiles.slice(0, 10);
			} else {
				// Rank matches: basename > prefix > substring
				const scored = this.allFiles
					.map((f) => {
						const lower = f.toLowerCase();
						const basename = lower.split("/").pop() ?? lower;
						let score = 0;
						if (basename.startsWith(query))
							score = 3; // basename prefix
						else if (lower.startsWith(query))
							score = 2; // full path prefix
						else if (lower.includes(query)) score = 1; // substring
						return { file: f, score };
					})
					.filter(({ score }) => score > 0)
					.sort((a, b) => b.score - a.score);

				this.filteredFiles = scored.map(({ file }) => file).slice(0, 10);
			}

			if (this.filteredFiles.length > 0) {
				this.showSuggestions = true;
				this.suggestionIndex = 0;
				this.mentionMatch = {
					start: match.index,
					end: cursor,
					query: match[1],
				};
				return;
			}
		}

		this.showSuggestions = false;
		this.mentionMatch = null;
	}

	private handleKeyDown(e: KeyboardEvent) {
		if (this.showSuggestions) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.suggestionIndex =
					(this.suggestionIndex + 1) % this.filteredFiles.length;
				this.scrollSelectedIntoView();
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				this.suggestionIndex =
					(this.suggestionIndex - 1 + this.filteredFiles.length) %
					this.filteredFiles.length;
				this.scrollSelectedIntoView();
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				this.selectSuggestion(this.filteredFiles[this.suggestionIndex]);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				this.showSuggestions = false;
				return;
			}
		}

		// Submit on Enter (without Shift)
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			this.submit();
		}
	}

	private scrollSelectedIntoView() {
		const list = this.shadowRoot?.querySelector(".suggestions");
		const item = list?.children[this.suggestionIndex] as HTMLElement;
		if (item && list) {
			if (item.offsetTop < list.scrollTop) {
				list.scrollTop = item.offsetTop;
			} else if (
				item.offsetTop + item.offsetHeight >
				list.scrollTop + list.offsetHeight
			) {
				list.scrollTop = item.offsetTop + item.offsetHeight - list.offsetHeight;
			}
		}
	}

	private selectSuggestion(file: string) {
		if (!this.mentionMatch) return;

		const before = this.value.slice(0, this.mentionMatch.start);
		const after = this.value.slice(this.mentionMatch.end);

		// Insert full path, avoid double space if after already starts with space
		const spacer = after.startsWith(" ") ? "" : " ";
		const newValue = `${before}@${file}${spacer}${after}`;
		this.value = newValue;

		this.showSuggestions = false;
		this.mentionMatch = null;

		// Focus, sync DOM value, recalculate height, and set cursor
		const cursorOffset = spacer ? 2 : 1; // @ + optional space
		requestAnimationFrame(() => {
			const textarea = this.shadowRoot?.querySelector("textarea");
			if (textarea) {
				textarea.value = newValue;
				textarea.style.height = "auto";
				textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
				textarea.focus();
				const newCursorPos = before.length + file.length + cursorOffset;
				textarea.setSelectionRange(newCursorPos, newCursorPos);
			}
		});
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
		this.showSuggestions = false;
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
			<div class="input-container">
				${
					this.showSuggestions
						? html`
					<div class="suggestions">
						${this.filteredFiles.map(
							(file, i) => html`
							<div
								class="suggestion-item ${i === this.suggestionIndex ? "selected" : ""}"
								@click=${() => this.selectSuggestion(file)}
							>
								${file}
							</div>
						`,
						)}
					</div>
				`
						: ""
				}
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
			</div>
			<div class="hint">
				<kbd>↵</kbd> send • <kbd>⇧</kbd> + <kbd>↵</kbd> newline • <kbd>@</kbd> mention file
			</div>
		`;
	}
}
