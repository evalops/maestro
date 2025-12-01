/**
 * Message input component
 */

import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ApiClient } from "../services/api-client.js";

type SlashCommandHint = {
	name: string;
	description: string;
	usage: string;
	tags?: string[];
};

const SLASH_COMMANDS: SlashCommandHint[] = [
	{
		name: "help",
		description: "List commands",
		usage: "/help",
		tags: ["support"],
	},
	{
		name: "run",
		description: "Run npm script",
		usage: "/run <script>",
		tags: ["automation"],
	},
	{
		name: "diff",
		description: "Show git diff",
		usage: "/diff <path>",
		tags: ["git"],
	},
	{
		name: "review",
		description: "Summarize git status/diff",
		usage: "/review",
		tags: ["git"],
	},
	{
		name: "plan",
		description: "Show saved plans",
		usage: "/plan",
		tags: ["planning"],
	},
	{
		name: "model",
		description: "Select model",
		usage: "/model",
		tags: ["session"],
	},
	{
		name: "theme",
		description: "Select theme",
		usage: "/theme",
		tags: ["ui"],
	},
	{
		name: "config",
		description: "Inspect config",
		usage: "/config",
		tags: ["config"],
	},
	{
		name: "cost",
		description: "Show usage/cost",
		usage: "/cost",
		tags: ["usage"],
	},
	{
		name: "telemetry",
		description: "Toggle telemetry",
		usage: "/telemetry [on|off]",
		tags: ["diagnostics"],
	},
	{
		name: "approvals",
		description: "Set approval mode",
		usage: "/approvals [auto|prompt|fail]",
		tags: ["safety"],
	},
	{
		name: "queue",
		description: "Manage prompt queue",
		usage: "/queue [list|mode]",
		tags: ["planning"],
	},
	{
		name: "new",
		description: "New session",
		usage: "/new",
		tags: ["session"],
	},
];

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

		.slash-hint {
			position: absolute;
			bottom: 100%;
			left: 0;
			right: 0;
			margin-bottom: 0.35rem;
			padding: 0.5rem 0.75rem;
			border: 1px solid var(--border-primary, #1e2023);
			background: var(--bg-secondary, #161b22);
			box-shadow: 0 6px 16px rgba(0, 0, 0, 0.35);
			border-radius: 4px;
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 0.75rem;
			font-family: var(--font-mono, monospace);
			color: var(--text-primary, #e8e9eb);
			z-index: 90;
		}

		.slash-hint .meta {
			display: flex;
			flex-direction: column;
			gap: 0.2rem;
			min-width: 0;
		}

		.slash-hint .name {
			font-weight: 700;
			font-size: 0.85rem;
		}

		.slash-hint .desc {
			color: var(--text-secondary, #9ca3af);
			font-size: 0.75rem;
		}

		.slash-hint .usage {
			color: var(--text-tertiary, #6b7280);
			font-size: 0.72rem;
		}

		.slash-hint .tags {
			display: flex;
			gap: 0.35rem;
			flex-wrap: wrap;
			font-size: 0.62rem;
			color: var(--accent-amber, #d4a012);
		}

		.slash-hint .controls {
			display: inline-flex;
			align-items: center;
			gap: 0.35rem;
			font-size: 0.65rem;
			color: var(--text-tertiary, #6b7280);
			white-space: nowrap;
		}

		.slash-hint kbd {
			padding: 0.15rem 0.4rem;
			background: var(--bg-elevated, #161719);
			border: 1px solid var(--border-primary, #1e2023);
			font-family: inherit;
			font-size: 0.62rem;
			font-weight: 600;
			color: var(--text-secondary, #8b8d91);
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
	@state() private slashHint: SlashCommandHint | null = null;
	@state() private slashMatches: SlashCommandHint[] = [];
	@state() private slashIndex = 0;

	private maxLength = 10000;
	private allFiles: string[] = [];
	private apiClient = new ApiClient();
	private mentionMatch: { start: number; end: number; query: string } | null =
		null;
	private checkMentionCounter = 0;
	private slashDebounce?: number;

	private async handleInput(e: Event) {
		const target = e.target as HTMLTextAreaElement;
		this.value = target.value;

		// Auto-grow textarea
		target.style.height = "auto";
		target.style.height = `${Math.min(target.scrollHeight, 240)}px`;

		// Check for mention (awaited to prevent race conditions)
		await this.checkMention(target);
		this.updateSlashHint(target.value);
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

	private updateSlashHint(text: string) {
		// Debounce to avoid flicker
		if (this.slashDebounce) {
			clearTimeout(this.slashDebounce);
		}
		this.slashDebounce = window.setTimeout(() => {
			const trimmed = text.trim();
			if (!trimmed.startsWith("/")) {
				this.slashHint = null;
				this.slashMatches = [];
				this.slashIndex = 0;
				return;
			}
			const [token] = trimmed.split(/\s+/);
			const query = (token ?? "/").slice(1).toLowerCase();
			const scored = SLASH_COMMANDS.map((cmd) => ({
				cmd,
				score: this.scoreCommand(cmd, query),
			}))
				.filter((s) => s.score > 0 || !query)
				.sort(
					(a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name),
				);
			this.slashMatches = scored.map((s) => s.cmd);
			this.slashIndex = 0;
			this.slashHint = this.slashMatches[0] ?? null;
		}, 20);
	}

	private cycleSlash(reverse: boolean) {
		if (this.slashMatches.length === 0) {
			this.updateSlashHint(this.value);
			return;
		}
		if (reverse) {
			this.slashIndex =
				(this.slashIndex - 1 + this.slashMatches.length) %
				this.slashMatches.length;
		} else {
			this.slashIndex = (this.slashIndex + 1) % this.slashMatches.length;
		}
		this.slashHint = this.slashMatches[this.slashIndex] ?? null;

		// Replace current token with selected command
		const parts = this.value.split(/\s+/);
		if (parts.length > 0) {
			parts[0] = `/${this.slashHint?.name ?? parts[0].slice(1)}`;
			this.value = parts.join(" ");
			this.requestUpdate();
		}
	}

	private scoreCommand(cmd: SlashCommandHint, query: string): number {
		let score = 0;
		const q = query.trim();
		const name = cmd.name.toLowerCase();
		if (!q) return 1;
		if (name === q) score += 100;
		if (name.startsWith(q)) score += 70;
		if (name.includes(q)) score += 20;
		if (cmd.tags?.some((t) => t.includes(q))) score += 10;
		return score;
	}

	private handleKeyDown(e: KeyboardEvent) {
		// Slash cycling (Tab / Shift+Tab) if not showing file suggestions
		if (!this.showSuggestions && this.value.trim().startsWith("/")) {
			if (e.key === "Tab") {
				e.preventDefault();
				this.cycleSlash(e.shiftKey);
				return;
			}
		}

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
		const list = this.shadowRoot?.querySelector(
			".suggestions",
		) as HTMLElement | null;
		const item =
			(list?.children?.[this.suggestionIndex] as HTMLElement) ?? null;
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
					this.slashHint
						? html`
							<div class="slash-hint">
								<div class="meta">
									<div class="name">/${this.slashHint.name}</div>
									<div class="desc">${this.slashHint.description}</div>
									<div class="usage">${this.slashHint.usage}</div>
									${
										this.slashHint.tags?.length
											? html`<div class="tags">
												${this.slashHint.tags.map(
													(tag) => html`<span>#${tag}</span>`,
												)}
										  </div>`
											: null
									}
								</div>
								<div class="controls">
									<kbd>Tab</kbd><span>cycle</span>
								</div>
							</div>
					  `
						: null
				}
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
